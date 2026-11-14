/**
 * Guandao OS 1.8 · 跨设备客户端
 *
 * 只负责与 /api/pairing、/api/continuity、/api/clipboard、/api/push 通信。
 * 所有身份都由 Cookie 决定，这里不发送 user_id，也不缓存任何凭证到 localStorage。
 */

export type PairingStatus = "pending" | "claimed" | "confirmed" | "completed" | "cancelled" | "expired";

export type PairingCreated = {
  pairingId: string;
  code: string;
  token: string;
  expiresAt: number;
  ttl: number;
  qrUrl: string;
};

export type PairingItem = {
  id: string;
  status: PairingStatus;
  sourceDeviceId: string;
  sourceName: string;
  sourceType: string;
  targetDeviceId: string | null;
  target: { name: string; type: string; browser: string; os: string } | null;
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
  createdAt: number;
  expired: boolean;
};

export type ClaimResult = {
  pairingId: string;
  claimSecret: string;
  status: string;
  device: { name: string; type: string; browser: string; os: string };
  source: { name: string; type: string };
  expiresAt: number;
};

export type ClaimStatus = {
  status: PairingStatus;
  paired: boolean;
  alreadyDelivered?: boolean;
  expiresAt?: number;
  source?: { name: string; type: string };
  deviceId?: string;
  user?: { displayName: string; githubUsername: string | null; avatarUrl: string | null };
};

export type ContinuityType = "note" | "task" | "event" | "file" | "link" | "workspace" | "reading" | "app";

export type ContinuityItem = {
  id: string;
  itemType: ContinuityType;
  title: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "opened" | "completed" | "cancelled" | "expired";
  sourceDeviceId: string;
  sourceName: string;
  sourceType: string;
  targetDeviceId: string | null;
  targetName: string;
  targetType: string | null;
  outgoing: boolean;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  openedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
};

export type ContextItem = {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  appId: string;
  resourceId: string | null;
  resourceTitle: string;
  workspaceId: string | null;
  scroll: number;
  updatedAt: number;
  lastSeenAt: number | null;
  current: boolean;
};

export type ClipboardItem = {
  id: string;
  content: string;
  sourceDeviceId: string;
  sourceName: string;
  targetDeviceId: string | null;
  outgoing: boolean;
  createdAt: number;
  expiresAt: number;
};

export class ContinuityError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "ERROR", status = 0) {
    super(message);
    this.name = "ContinuityError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ContinuityError("网络不可用，请稍后再试", "NETWORK", 0);
  }

  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: { code: string; message: string } }
    | null;

  if (!response.ok || !payload || payload.success === false) {
    const error = payload && payload.success === false ? payload.error : null;
    throw new ContinuityError(error?.message || "请求失败", error?.code || "HTTP_ERROR", response.status);
  }
  return payload.data;
}

export const pairingApi = {
  create: () => request<PairingCreated>("/api/pairing/create", { method: "POST", body: "{}" }),
  list: () => request<{ items: PairingItem[]; currentDeviceId: string | null }>("/api/pairing"),
  claim: (body: { token?: string; code?: string; device?: { name?: string; type?: string } }) =>
    request<ClaimResult>("/api/pairing/claim", { method: "POST", body: JSON.stringify(body) }),
  claimStatus: (id: string, secret: string) =>
    request<ClaimStatus>(`/api/pairing/claim/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`),
  confirm: (id: string) =>
    request<{ status: string; device: { id: string; name: string; type: string } }>(
      `/api/pairing/${encodeURIComponent(id)}/confirm`,
      { method: "POST", body: "{}" },
    ),
  cancel: (id: string) =>
    request<{ cancelled: boolean }>(`/api/pairing/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
};

export const continuityApi = {
  send: (body: {
    itemType: ContinuityType;
    title: string;
    resourceId?: string | null;
    payload: Record<string, unknown>;
    targetDeviceId?: string | null;
    ttlMs?: number;
  }) => request<{ id: string; title: string; targetName: string | null }>("/api/continuity/send", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  inbox: () => request<{ items: ContinuityItem[]; currentDeviceId: string; serverTime: number }>("/api/continuity/inbox"),
  history: () => request<{ items: ContinuityItem[]; currentDeviceId: string }>("/api/continuity/history"),
  open: (id: string) => request<{ item: ContinuityItem }>(`/api/continuity/${encodeURIComponent(id)}/open`, {
    method: "POST",
    body: "{}",
  }),
  complete: (id: string) =>
    request<{ completed: boolean }>(`/api/continuity/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: "{}",
    }),
  cancel: (id: string) =>
    request<{ cancelled: boolean }>(`/api/continuity/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  contexts: () => request<{ items: ContextItem[]; currentDeviceId: string }>("/api/continuity/context"),
  saveContext: (body: {
    appId: string;
    resourceId?: string | null;
    resourceTitle?: string;
    workspaceId?: string | null;
    scroll?: number;
  }) => request<{ saved: boolean }>("/api/continuity/context", { method: "PUT", body: JSON.stringify(body) }),
};

export const clipboardApi = {
  send: (content: string, targetDeviceId?: string | null) =>
    request<{ id: string; ttl: number }>("/api/clipboard/send", {
      method: "POST",
      body: JSON.stringify({ content, targetDeviceId: targetDeviceId || null }),
    }),
  list: () => request<{ items: ClipboardItem[]; ttl: number; enabled: boolean }>("/api/clipboard"),
  remove: (id: string) =>
    request<{ deleted: boolean }>(`/api/clipboard/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const pushApi = {
  status: () =>
    request<{ enabled: boolean; configured: boolean; delivery: string; reason: string }>("/api/push/status"),
};
