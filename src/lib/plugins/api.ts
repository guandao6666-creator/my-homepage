/**
 * Guandao OS 1.7 · 插件接口客户端
 *
 * 只做同源 fetch 与类型封装；权限判断、状态迁移全部在服务端与运行时。
 * Session 在 HttpOnly Cookie 里，这个模块接触不到，也不应该接触。
 */

import type { Manifest, PermissionDef, PluginType } from "../../../shared/plugin-spec.js";

export type Viewer = {
  id: string | null;
  role: "visitor" | "member" | "moderator" | "admin";
  staff: boolean;
  admin: boolean;
  developer: boolean;
};

export type PluginCard = {
  id: string;
  name: string;
  description: string;
  type: PluginType;
  category: string;
  license: string;
  author: { id: string; name: string; avatarUrl: string | null; role: string };
  iconUrl: string;
  version: string;
  compatibility: { minimumOSVersion: string; sdkVersion: number };
  permissions: string[];
  networkDomains: string[];
  downloads: number;
  installs: number;
  recentDownloads: number;
  rating: { average: number; count: number };
  featured: boolean;
  status: string;
  security: {
    reviewStatus: string | null;
    reviewedAt: number | null;
    audited: boolean;
    signature: SignatureTrust;
  };
  installed: boolean;
  installedVersion: string | null;
  enabled: boolean;
  updateAvailable: boolean;
  publishedAt: number | null;
  updatedAt: number;
};

export type PluginVersion = {
  id: string;
  version: string;
  changelog: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  sizeBytes: number;
  checksum: string;
  manifest: Manifest | null;
  reviewNote: string;
  reviewedAt: number | null;
  createdAt: number;
  publishedAt: number | null;
  signature: SignatureTrust;
};

export type Installation = {
  pluginId: string;
  version: string;
  enabled: boolean;
  status: "installed" | "disabled" | "blocked" | "failed";
  source: "market" | "official" | "dev";
  packageSha256: string;
  installedAt: number;
  updatedAt: number;
  lastLaunchedAt: number | null;
};

export type PluginReview = {
  userId: string;
  author: { name: string; avatarUrl: string | null };
  rating: number;
  body: string;
  createdAt: number;
  updatedAt: number;
};

export type PluginDetail = {
  plugin: PluginCard & {
    manifest: Manifest;
    screenshots: Array<{ path: string; url: string }>;
    changelog: string;
    homepage: string;
    repository: string;
    manifestVersion: number;
    dependencies: Array<{ id: string; version: string; optional: boolean }>;
    contributes: Manifest["contributes"];
    isOwner: boolean;
  };
  versions: PluginVersion[];
  reviews: PluginReview[];
  reviewCount: number;
  distribution: Record<string, number>;
  installation: Installation | null;
  granted: string[];
  permissionGroups: Array<{ module: string; label: string; items: PermissionDef[] }>;
  risk: "low" | "medium" | "high";
  developer: {
    id: string;
    name: string;
    bio: string;
    website: string;
    avatarUrl: string | null;
    joinedAt: number;
  };
  viewer: Viewer;
};

export type PluginMeta = {
  osVersion: string;
  sdkVersion: number;
  categories: string[];
  categoryLabels: Record<string, string>;
  types: Record<string, { label: string; icon: string; desc: string; executable: boolean }>;
  permissions: PermissionDef[];
  permissionModules: Record<string, string>;
  limits: Record<string, number>;
  stats: { published: number; pending: number; installations: number; downloads: number };
  viewer: Viewer;
};

export type DeveloperPlugin = PluginCard & {
  latestVersion: PluginVersion | null;
  moderationNote: string;
};

export type DeveloperProfile = {
  profile: { id: string; displayName: string; bio: string; website: string; createdAt: number; updatedAt: number };
  stats: { total: number; published: number; pending: number; downloads: number; installs: number; ratings: number };
  osVersion: string;
  sdkVersion: number;
  limits: {
    maxPlugins: number;
    types: Record<string, { label: string; icon: string; desc: string; executable: boolean }>;
    categories: string[];
    licenses: string[];
  };
};

export class PluginApiError extends Error {
  code: string;
  status: number;
  issues?: Array<{ path: string; message: string; code: string }>;

  constructor(message: string, code = "UNKNOWN", status = 0, issues?: Array<{ path: string; message: string; code: string }>) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new PluginApiError("网络请求失败，请检查连接后重试", "NETWORK_ERROR");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new PluginApiError(
      payload?.error?.message || `请求失败（${response.status}）`,
      payload?.error?.code || "UNKNOWN",
      response.status,
      payload?.error?.issues,
    );
  }
  return payload.data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/* ============================================================
   市场
   ============================================================ */

export const getMeta = () => get<PluginMeta>("/api/plugins/meta");

export const listPlugins = (params: {
  tab?: string;
  category?: string;
  q?: string;
  sort?: string;
  page?: number;
  limit?: number;
} = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null && value !== "") query.set(key, String(value));
  return get<{ items: PluginCard[]; total: number; page: number; limit: number; hasMore: boolean; tab: string }>(
    `/api/plugins?${query.toString()}`,
  );
};

export const getPlugin = (id: string) => get<PluginDetail>(`/api/plugins/${encodeURIComponent(id)}`);

export const getVersions = (id: string) =>
  get<{ versions: PluginVersion[] }>(`/api/plugins/${encodeURIComponent(id)}/versions`);

/** 服务端为发布者公示的公钥。撤销状态由服务端维护，客户端只做判断。 */
export type PublisherKey = {
  keyId: string;
  publicKey: string;
  algorithm: string;
  status: "active" | "revoked";
  createdAt?: number | null;
  revokedAt?: number | null;
};

/** 发布者信任状态。verified=验签通过，unsigned=阶段 A 旧包，invalid=拒绝。 */
export type SignatureTrust = {
  status: "verified" | "unsigned" | "invalid";
  keyId: string | null;
  signedAt: number | null;
  payload?: unknown | null;
};

export type PackagePayload = {
  pluginId: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  manifest: Manifest;
  packageJson: string;
  signature?: SignatureTrust;
  /** 发布者公钥列表（含已撤销的），客户端据此独立验签。 */
  publisherKeys?: PublisherKey[];
};

export const getPackage = (id: string, version?: string, preview = false) => {
  const query = new URLSearchParams();
  if (version) query.set("version", version);
  if (preview) query.set("preview", "1");
  return get<PackagePayload>(`/api/plugins/${encodeURIComponent(id)}/package?${query.toString()}`);
};

export const listInstalled = () =>
  get<{
    items: Array<PluginCard & { installation: Installation | null; granted: string[] }>;
    viewer: Viewer;
  }>("/api/plugins/installed");

export const installPlugin = (body: { pluginId: string; version: string; packageHash: string; permissions: string[] }) =>
  post<{ installation: Installation; permissions: string[]; manifest: Manifest }>("/api/plugins/install", body);

export const setEnabled = (id: string, enabled: boolean) =>
  post<{ installation: Installation }>(`/api/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`);

export const updatePlugin = (id: string, body: { version: string; packageHash: string; permissions?: string[] }) =>
  post<{ needsConsent?: boolean; added?: string[]; installation?: Installation; permissions?: string[]; manifest?: Manifest }>(
    `/api/plugins/${encodeURIComponent(id)}/update`,
    body,
  );

export const rollback = (id: string, body: { version: string; packageHash: string }) =>
  post<{ installation: Installation; permissions: string[] }>(`/api/plugins/${encodeURIComponent(id)}/rollback`, body);

export const uninstallRemote = (id: string) =>
  del<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/install`);

export const markLaunched = (id: string) => post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/launch`);

export const readPermissions = (id: string) =>
  get<{ declared: string[]; granted: string[]; groups: Array<{ module: string; label: string; items: PermissionDef[] }>; networkDomains: string[] }>(
    `/api/plugins/${encodeURIComponent(id)}/permissions`,
  );

export const grantPermissions = (id: string, permissions: string[]) =>
  post<{ granted: string[] }>(`/api/plugins/${encodeURIComponent(id)}/permissions`, { permissions });

export const revokePermission = (id: string, permission: string) =>
  del<{ granted: string[] }>(
    `/api/plugins/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permission)}`,
  );

/* ============================================================
   评价 / 举报
   ============================================================ */

export const listReviews = (id: string, page = 1) =>
  get<{
    items: PluginReview[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    distribution: Record<string, number>;
    mine: { rating: number; body: string; updatedAt: number } | null;
  }>(`/api/plugins/${encodeURIComponent(id)}/reviews?page=${page}`);

export const writeReview = (id: string, rating: number, body: string) =>
  post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/reviews`, { rating, body });

export const deleteReview = (id: string) =>
  del<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/reviews/mine`);

export const reportPlugin = (id: string, reason: string, detail: string) =>
  post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/report`, { reason, detail });

/* ============================================================
   开发者
   ============================================================ */

export const getDeveloperProfile = () => get<DeveloperProfile>("/api/developer/profile");

export const updateDeveloperProfile = (body: { displayName: string; bio: string; website: string }) =>
  patch<{ ok: boolean }>("/api/developer/profile", body);

export const listDeveloperPlugins = () =>
  get<{ items: DeveloperPlugin[]; limits: Record<string, number>; viewer: Viewer }>("/api/developer/plugins");

export const createPlugin = (body: {
  id: string;
  name: string;
  type: string;
  category: string;
  description: string;
  license: string;
}) => post<{ plugin: { id: string } }>("/api/developer/plugins", body);

export const updateDeveloperPlugin = (id: string, body: Record<string, unknown>) =>
  patch<{ ok: boolean }>(`/api/developer/plugins/${encodeURIComponent(id)}`, body);

export const deleteDeveloperPlugin = (id: string) =>
  del<{ ok: boolean }>(`/api/developer/plugins/${encodeURIComponent(id)}`);

export const uploadVersion = (id: string, bundle: string, changelog: string) =>
  post<{ version: { version: string; checksum: string; sizeBytes: number; warnings: Array<{ path: string; message: string }> } }>(
    `/api/developer/plugins/${encodeURIComponent(id)}/versions`,
    { bundle, changelog },
  );

export const submitPlugin = (id: string) =>
  post<{ ok: boolean; status: string }>(`/api/developer/plugins/${encodeURIComponent(id)}/submit`);

export const withdrawPlugin = (id: string) =>
  post<{ ok: boolean; status: string }>(`/api/developer/plugins/${encodeURIComponent(id)}/withdraw`);

/* ============================================================
   管理
   ============================================================ */

export const getQueue = (status = "pending") =>
  get<{
    items: Array<{
      plugin: PluginCard;
      version: PluginVersion;
      developer: { id: string; name: string; avatarUrl: string | null };
      moderationNote: string;
    }>;
    status: string;
  }>(`/api/plugins/admin/queue/${encodeURIComponent(status)}`);

export const reviewPlugin = (id: string, version: string, decision: "approve" | "reject", note: string) =>
  post<{ ok: boolean; status: string }>(`/api/plugins/admin/${encodeURIComponent(id)}/review`, {
    decision,
    version,
    note,
  });

export const takedownPlugin = (id: string, reason: string) =>
  post<{ ok: boolean }>(`/api/plugins/admin/${encodeURIComponent(id)}/takedown`, { reason });

export const featurePlugin = (id: string, featured: boolean) =>
  post<{ ok: boolean }>(`/api/plugins/admin/${encodeURIComponent(id)}/feature`, { featured });

export const getReports = () => get<{ items: Array<Record<string, unknown>> }>("/api/plugins/admin/reports");

export const getAudit = () => get<{ items: Array<Record<string, unknown>> }>("/api/plugins/admin/audit");

export const restrictDeveloper = (userId: string, restriction: "none" | "limited" | "blocked", reason: string) =>
  post<{ ok: boolean; restriction: string }>(
    `/api/plugins/admin/users/${encodeURIComponent(userId)}/restriction`,
    { restriction, reason },
  );

export const resolveReport = (reportId: string, status: "resolved" | "dismissed", note: string) =>
  post<{ ok: boolean }>(`/api/plugins/admin/reports/${encodeURIComponent(reportId)}`, { status, note });
