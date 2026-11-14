/**
 * Privacy & Security 客户端。
 * 服务端只返回布尔/计数/状态，不返回任何凭证。
 */

import { collectSnapshot, countLocal, type BackupDomain } from "../backups/client";

export type SecurityStatus = "protected" | "attention" | "not_configured" | "failed" | "unknown";

export interface SecurityCheck {
  id: string;
  label: string;
  weight: number;
  status: SecurityStatus;
  detail: string;
  evidence?: string[];
}

export interface PrivacyOverview {
  checkedAt: number;
  account: {
    id: string;
    githubUsername: string | null;
    displayName: string;
    avatarUrl: string | null;
    role: "admin" | "member";
    createdAt: number;
    lastLoginAt: number | null;
    authProvider: string;
    deletionState: "none" | "pending" | "completed";
  };
  score: {
    value: number | null;
    evaluatedWeight: number;
    totalWeight: number;
    rules: string;
  };
  checks: SecurityCheck[];
  counts: {
    activeSessions: number;
    totalSessions: number;
    activeDevices: number;
    untrustedDevices: number;
  };
  backup: { id: string; status: string; sizeBytes: number; createdAt: number; verifiedAt: number | null } | null;
  inventory: DataInventory;
  settings: PrivacySettings;
  rateLimits: RateLimits;
  recentEvents: SecurityEvent[];
}

export interface DataInventory {
  account: Record<string, unknown>;
  sessions: { total: number; active: number };
  devices: { total: number; active: number };
  files: { total: number; ready: number; trash: number; bytes: number };
  folders: { total: number };
  backups: { total: number; verified: number; bytes: number };
  events: { total: number };
  legacyCloudNotes: { total: number };
  fileEvents: { total: number };
}

export interface PrivacySettings {
  cloudSync: boolean;
  notes: boolean;
  tasks: boolean;
  calendar: boolean;
  desktop: boolean;
  workspace: boolean;
  updatedAt: number | null;
}

export interface RateLimitRule {
  id: string;
  label: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimits {
  global: RateLimitRule;
  rules: RateLimitRule[];
  blocked24h: number | null;
  windows: number | null;
  hits24h: number | null;
}

export interface SecurityEvent {
  id: string;
  eventType: string;
  deviceId: string | null;
  result: "success" | "failure" | "blocked";
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface DataExport {
  id: string;
  type: "full" | "metadata" | "content";
  status: string;
  scopes: string[];
  sizeBytes: number;
  fileCount: number;
  checksum: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
  expiresAt: number | null;
}

export interface ExportJob {
  id: string;
  status: string;
  stage: string;
  progress: number;
  processed: number;
  total: number;
  errorMessage: string | null;
}

export interface DeletionJob {
  id: string;
  type: "files" | "backups" | "content" | "account";
  status: string;
  stage: string;
  progress: number;
  processed: number;
  total: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

export class PrivacyError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "UNKNOWN", status = 0) {
    super(message);
    this.name = "PrivacyError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new PrivacyError("网络不可用，请检查连接", "NETWORK_ERROR");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PrivacyError(
      payload?.error?.message || `请求失败（${response.status}）`,
      payload?.error?.code || "UNKNOWN",
      response.status,
    );
  }
  return payload?.data as T;
}

export const getOverview = () => request<PrivacyOverview>("/api/privacy/overview");
export const getInventory = () => request<{ inventory: DataInventory }>("/api/privacy/data-inventory");
export const getSettings = () => request<{ settings: PrivacySettings }>("/api/privacy/settings");
export const saveSettings = (patch: Partial<PrivacySettings>) =>
  request<{ settings: PrivacySettings; note: string }>("/api/privacy/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });

export const listEvents = (params: Record<string, string | number> = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== undefined) query.set(key, String(value));
  }
  return request<{ events: SecurityEvent[]; total: number; limit: number; offset: number }>(
    `/api/security/activity?${query}`,
  );
};

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export interface ExportCreateResult {
  export: DataExport;
  job: ExportJob;
  totals: { files: number; bytes: number };
}

export function buildLocalSnapshot(): Record<string, unknown> {
  const domains: BackupDomain[] = ["notes", "tasks", "calendar", "desktop", "workspace"];
  return collectSnapshot(domains);
}

export const createExport = (includeFiles: boolean, localSnapshot: Record<string, unknown>) =>
  request<ExportCreateResult>("/api/privacy/export", {
    method: "POST",
    body: JSON.stringify({ includeFiles, localSnapshot }),
  });

export async function runExportUntilDone(
  id: string,
  onProgress?: (job: ExportJob | null, data: DataExport) => void,
): Promise<{ export: DataExport; job: ExportJob | null }> {
  let last: { export: DataExport; job: ExportJob | null } | null = null;
  for (let i = 0; i < 80; i += 1) {
    const result = await request<{ done: boolean; export: DataExport; job: ExportJob | null }>(
      `/api/privacy/export/${encodeURIComponent(id)}/run`,
      { method: "POST", body: "{}" },
    );
    last = { export: result.export, job: result.job };
    onProgress?.(result.job, result.export);
    if (result.done) return last;
    if (result.export.status === "failed") {
      throw new PrivacyError(result.export.errorMessage || "导出失败", "EXPORT_FAILED");
    }
  }
  if (last) return last;
  throw new PrivacyError("导出任务未完成", "EXPORT_TIMEOUT");
}

export const listExports = () => request<{ exports: DataExport[] }>("/api/privacy/exports");
export const exportDownloadUrl = (id: string, format: "json" | "zip") =>
  `/api/privacy/export/${encodeURIComponent(id)}/download?format=${format}`;

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export const deleteCloudData = (targets: Array<"files" | "backups" | "exports">) =>
  request<{ done: boolean; job: DeletionJob }>("/api/privacy/delete-data", {
    method: "POST",
    body: JSON.stringify({ targets, confirm: "DELETE" }),
  });

export async function runDeletionUntilDone(
  jobId: string,
  onProgress?: (job: DeletionJob) => void,
): Promise<DeletionJob> {
  let job: DeletionJob | null = null;
  for (let i = 0; i < 80; i += 1) {
    const result = await request<{ done?: boolean; job: DeletionJob }>(
      `/api/privacy/deletion/${encodeURIComponent(jobId)}/run`,
      { method: "POST", body: "{}" },
    );
    job = result.job;
    onProgress?.(job);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new PrivacyError(job.errorMessage || "删除失败", "DELETE_FAILED");
  }
  if (job) return job;
  throw new PrivacyError("删除任务未完成", "DELETE_TIMEOUT");
}

export const startReauth = () => {
  location.assign("/api/auth/github?reauth=delete");
};

export const deleteAccount = () =>
  request<{ accountDeleted?: boolean; done?: boolean; job?: DeletionJob; note?: string }>(
    "/api/privacy/delete-account",
    {
      method: "POST",
      body: JSON.stringify({ confirm: "DELETE MY ACCOUNT", acknowledgeBackups: true }),
    },
  );

export async function continueAccountDeletion(
  jobId: string,
  onProgress?: (job: DeletionJob) => void,
): Promise<{ deleted: boolean; job?: DeletionJob }> {
  for (let i = 0; i < 80; i += 1) {
    const result = await request<{ accountDeleted?: boolean; done?: boolean; job?: DeletionJob }>(
      `/api/privacy/deletion/${encodeURIComponent(jobId)}/run`,
      { method: "POST", body: "{}" },
    );
    if (result.accountDeleted) return { deleted: true };
    if (result.job) onProgress?.(result.job);
    if (result.job?.status === "failed") {
      throw new PrivacyError(result.job.errorMessage || "注销失败", "DELETE_FAILED");
    }
  }
  return { deleted: false };
}

/* ------------------------------------------------------------------ */
/* 本地数据                                                            */
/* ------------------------------------------------------------------ */

export const LOCAL_KEYS = [
  "guandao.os14.notes.v1",
  "guandao.os14.tasks.v1",
  "guandao.os14.calendar.v1",
  "guandao.os14.ws.v1",
  "guandao.os14.prefs.v1",
  "guandao.os14.themes.v1",
  "guandao.os14.apps.v1",
  "guandao.os14.widgcfg.v1",
  "guandao.os14.deco.v1",
  "guandao.os14.pet.v1",
  "guandao.os14.photo.v1",
  "guandao.os14.countdown.v1",
  "guandao.os14.focus.v1",
  "guandao.os14.world.v1",
  "guandao.os.widgets.v1",
  "guandao.os.dock",
  "guandao.os.state.v1",
  "guandao.os.theme",
  "guandao.os13.v1",
  "guandao.os.lp.order.v1",
  "guandao.os.lp.hidden.v1",
  "guandao.os.recent",
];

export function localDataSummary() {
  return {
    notes: countLocal("notes") ?? 0,
    tasks: countLocal("tasks") ?? 0,
    calendar: countLocal("calendar") ?? 0,
    desktopKeys: countLocal("desktop") ?? 0,
    workspaceKeys: countLocal("workspace") ?? 0,
  };
}

/** 只清 Guandao OS 的本地键；不触碰导出的文件、Cookie 或其他站点数据。 */
export async function clearLocalData(): Promise<{ clearedKeys: number; indexedDb: boolean }> {
  let clearedKeys = 0;
  for (const key of LOCAL_KEYS) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        clearedKeys += 1;
      }
    } catch {
      /* ignore */
    }
  }

  let indexedDb = false;
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("guandao-os14");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    indexedDb = true;
  } catch {
    indexedDb = false;
  }

  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }

  try {
    await request("/api/privacy/local-clear", { method: "POST", body: "{}" });
  } catch {
    /* 日志失败不影响本地清除 */
  }

  return { clearedKeys, indexedDb };
}
