/**
 * Guandao Devices 客户端。
 *
 * 只做三件事：同源请求、设备存在性心跳、把 401 的语义翻译成前端事件。
 * Session Token 在 HttpOnly Cookie 里，这个模块永远接触不到。
 */

export type DeviceType = "desktop" | "laptop" | "tablet" | "mobile";
export type Presence = "active" | "recent" | "idle" | "unknown" | "revoked";
export type SyncDomain = "notes" | "tasks" | "calendar" | "drive";

export interface SyncState {
  mode: "cloud" | "local";
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  lastResult: "success" | "failed" | null;
  pendingUp: number;
  pendingDown: number;
  conflicts: number;
  updatedAt: number | null;
  requestedAt: number | null;
}

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  browser: string;
  os: string;
  createdAt: number;
  lastSeenAt: number | null;
  lastActiveAt: number | null;
  lastSyncAt: number | null;
  revokedAt: number | null;
  status: "active" | "revoked";
  presence: Presence;
  trusted: boolean;
  isCurrent: boolean;
  sessionCount: number;
  activeSessionCount: number;
  sync: Record<SyncDomain, SyncState>;
}

export interface DeviceAlert {
  deviceId: string;
  name: string;
  type: DeviceType;
  browser: string;
  os: string;
  createdAt: number;
}

export interface DeviceOverview {
  currentDeviceId: string | null;
  account: {
    displayName: string;
    githubUsername: string | null;
    avatarUrl: string | null;
    role: "admin" | "member";
  };
  overview: {
    deviceCount: number;
    revokedCount: number;
    activeDeviceCount: number;
    signedInDeviceCount: number;
    activeSessionCount: number;
    lastActivityAt: number | null;
    onlineWindowMinutes: number;
    staleSyncMs: number;
  };
  drive: {
    fileCount: number;
    usedBytes: number;
    lastActivityAt: number | null;
    cloudSynced: boolean;
  };
  devices: Device[];
  alerts: DeviceAlert[];
}

export interface DeviceSession {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  status: "active" | "expired" | "revoked";
  current: boolean;
}

export type ActivityEventType =
  | "registered"
  | "signed_in"
  | "signed_out"
  | "renamed"
  | "device_revoked"
  | "session_revoked"
  | "trusted"
  | "sync_success"
  | "sync_failed"
  | "sync_requested";

export interface ActivityEvent {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  eventType: ActivityEventType;
  createdAt: number;
  metadata: Record<string, string | number> | null;
}

export class DeviceApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "UNKNOWN", status = 0) {
    super(message);
    this.name = "DeviceApiError";
    this.code = code;
    this.status = status;
  }
}

const AUTH_ERRORS = new Set([
  "UNAUTHENTICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "DEVICE_REVOKED",
]);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new DeviceApiError("网络不可用，请检查连接", "NETWORK_ERROR", 0);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const code = payload?.error?.code || "UNKNOWN";
    const message = payload?.error?.message || `请求失败（${response.status}）`;
    if (AUTH_ERRORS.has(code)) {
      notifySessionLost(code);
    }
    throw new DeviceApiError(message, code, response.status);
  }

  return payload?.data as T;
}

/* ------------------------------------------------------------------ */
/* 会话失效通知                                                        */
/* ------------------------------------------------------------------ */

export const SESSION_LOST_EVENT = "guandao:device-session-lost";

let lastLostCode = "";

function notifySessionLost(code: string): void {
  if (lastLostCode === code) return;
  lastLostCode = code;
  stopDevicePresence();
  window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT, { detail: { code } }));
}

/* ------------------------------------------------------------------ */
/* 设备注册与心跳                                                      */
/* ------------------------------------------------------------------ */

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const ACTIVITY_SYNC_EVENT = "guandao:devices-changed";

let heartbeatTimer = 0;
let heartbeatRunning = false;
let heartbeatStarted = false;

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export async function registerDevice(): Promise<void> {
  try {
    await request("/api/devices/register", {
      method: "POST",
      body: JSON.stringify({ visible: isVisible() }),
    });
    window.dispatchEvent(new Event(ACTIVITY_SYNC_EVENT));
  } catch (error) {
    // 未登录、设备被撤销都不该影响桌面启动；事件已由 request 派发。
    if (!(error instanceof DeviceApiError) || error.code !== "UNAUTHENTICATED") {
      console.warn("[devices] register failed", error);
    }
  }
}

async function beat(): Promise<void> {
  if (heartbeatRunning || !isVisible()) return;
  heartbeatRunning = true;
  try {
    const result = await request<{ pendingSync: SyncDomain[] }>("/api/devices/heartbeat", {
      method: "POST",
      body: JSON.stringify({ visible: true }),
    });
    if (result?.pendingSync?.length) {
      window.dispatchEvent(
        new CustomEvent("guandao:device-sync-requested", { detail: { domains: result.pendingSync } }),
      );
      // 其他设备请求「下次上线检查更新」：这里真的去读一次云端索引，再如实上报。
      void runQueuedSync(result.pendingSync);
    }
  } catch (error) {
    // 心跳失败只降级为「状态未知」，绝不影响桌面使用。
    if (error instanceof DeviceApiError && error.code === "NETWORK_ERROR") return;
    console.warn("[devices] heartbeat failed", error);
  } finally {
    heartbeatRunning = false;
  }
}

/**
 * 只在页面前台运行。切到后台停止定时器，回到前台/网络恢复时立即补一次。
 * 浏览器关闭后不会有任何定时器残留——这是设计前提，不是缺陷。
 */
export function startDevicePresence(): void {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  lastLostCode = "";

  void registerDevice();
  void beat();

  heartbeatTimer = window.setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);
}

export function stopDevicePresence(): void {
  if (!heartbeatStarted) return;
  heartbeatStarted = false;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("focus", onFocus);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void beat();
}

function onOnline(): void {
  void beat();
}

function onFocus(): void {
  void beat();
}

export const DEVICES_CHANGED_EVENT = ACTIVITY_SYNC_EVENT;

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export const listDevices = (): Promise<DeviceOverview> => request("/api/devices");

export const getCurrentDevice = (): Promise<{ device: Device; sessions: DeviceSession[] }> =>
  request("/api/devices/current");

export const getDeviceDetail = (
  deviceId: string,
): Promise<{ device: Device; sessions: DeviceSession[]; activity: ActivityEvent[] }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}`);

export const listDeviceSessions = (deviceId: string): Promise<{ sessions: DeviceSession[] }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}/sessions`);

export const listAllSessions = (): Promise<{ sessions: DeviceSession[]; currentDeviceId: string | null }> =>
  request("/api/devices/sessions");

export const listDeviceActivity = (deviceId: string, limit = 30): Promise<{ activity: ActivityEvent[] }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}/activity?limit=${limit}`);

export const listAccountActivity = (limit = 50): Promise<{ activity: ActivityEvent[] }> =>
  request(`/api/devices/activity?limit=${limit}`);

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

export const renameDevice = (deviceId: string, patch: { name?: string; type?: DeviceType }): Promise<{ device: Device }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const revokeDevice = (deviceId: string): Promise<{ revoked: boolean; revokedSessions: number }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });

export const revokeSession = (sessionId: string): Promise<{ revoked: boolean }> =>
  request(`/api/devices/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });

export const revokeOtherSessions = (): Promise<{ revoked: number }> =>
  request("/api/devices/revoke-others", { method: "POST" });

export const revokeAllSessions = (keepCurrent: boolean): Promise<{ revoked: number }> =>
  request("/api/devices/revoke-all", {
    method: "POST",
    body: JSON.stringify({ confirm: "REVOKE ALL", keepCurrent }),
  });

export const trustDevice = (deviceId: string): Promise<{ trusted: boolean }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}/trust`, { method: "POST" });

export const requestDeviceSync = (deviceId: string, domain: SyncDomain = "drive"): Promise<{ queued: boolean; note?: string }> =>
  request(`/api/devices/${encodeURIComponent(deviceId)}/sync-request`, {
    method: "POST",
    body: JSON.stringify({ domain }),
  });

/* ------------------------------------------------------------------ */
/* 同步上报                                                            */
/* ------------------------------------------------------------------ */

let lastReportAt = 0;
let lastReportedSignature = "";

/**
 * 当前设备真实完成一次云端操作后调用。只接受 Cloud Drive：
 * Notes / Tasks / Calendar 仍是本地存储，服务端会拒绝伪造的「已同步」。
 */
export async function reportDriveSync(payload: {
  result: "success" | "failed";
  pendingUp?: number;
  pendingDown?: number;
  conflicts?: number;
  message?: string;
  force?: boolean;
}): Promise<void> {
  const signature = `${payload.result}:${payload.conflicts ?? 0}`;
  const now = Date.now();
  if (!payload.force) {
    if (signature === lastReportedSignature && now - lastReportAt < 30 * 60 * 1000) return;
    if (now - lastReportAt < 60 * 1000) return;
  }

  lastReportAt = now;
  lastReportedSignature = signature;

  try {
    await request("/api/devices/sync-report", {
      method: "POST",
      body: JSON.stringify({
        domain: "drive",
        result: payload.result,
        pendingUp: payload.pendingUp ?? 0,
        pendingDown: payload.pendingDown ?? 0,
        conflicts: payload.conflicts ?? 0,
        message: payload.message?.slice(0, 120),
      }),
    });
    window.dispatchEvent(new Event(ACTIVITY_SYNC_EVENT));
  } catch {
    // 同步状态上报失败不影响文件操作本身。
  }
}

/** 处理其他设备排队的同步请求：只做真实可做的云端索引检查。 */
async function runQueuedSync(domains: SyncDomain[]): Promise<void> {
  if (!domains.includes("drive")) return;
  try {
    const response = await fetch("/api/files/quota", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    await reportDriveSync({
      result: response.ok ? "success" : "failed",
      message: response.ok ? undefined : "云端检查失败",
      force: true,
    });
    window.dispatchEvent(new Event(ACTIVITY_SYNC_EVENT));
  } catch {
    await reportDriveSync({ result: "failed", message: "网络不可用", force: true });
  }
}
