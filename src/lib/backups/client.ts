/**
 * Guandao Backup 客户端。
 *
 * 服务端无法读取浏览器本地数据，所以 Notes / Tasks / Calendar / 桌面配置
 * 必须由当前设备在备份时上传；恢复时再把快照写回本地。
 * 文件（Cloud Drive）由服务端直接复制 R2 对象，与实时文件完全分离。
 */

export type BackupStatus =
  | "queued"
  | "collecting"
  | "uploading"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type BackupDomain = "notes" | "tasks" | "calendar" | "desktop" | "workspace" | "drive";
export type RestoreMode = "copy" | "merge" | "replace";

export interface BackupRecord {
  id: string;
  name: string;
  type: "manual" | "auto" | "protective";
  scope: "full" | "partial" | "drive";
  status: BackupStatus;
  schemaVersion: number;
  createdAt: number;
  snapshotAt: number | null;
  completedAt: number | null;
  verifiedAt: number | null;
  sizeBytes: number;
  itemCount: number;
  fileCount: number;
  checksum: string | null;
  domains: BackupDomain[];
  stats: Record<string, unknown> | null;
  errorMessage: string | null;
  parentBackupId: string | null;
}

export interface BackupJob {
  id: string;
  backupId: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number;
  processed: number;
  total: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  startedAt: number;
  updatedAt: number;
}

export interface StorageStats {
  backups: {
    total: number;
    bytes: number;
    auto: number;
    manual: number;
    failed: number;
    lastAt: number | null;
    verified: number;
  };
  liveFiles: { bytes: number; count: number };
  trashFiles: { bytes: number; count: number };
  limitBytes: number;
  backupLimit: number;
}

export interface BackupSettings {
  autoEnabled: boolean;
  frequency: "off" | "daily" | "weekly";
  scope: BackupDomain[];
  retentionDaily: number;
  retentionWeekly: number;
  lastAutoAt: number | null;
  lastAutoStatus: string | null;
  lastAutoBackup: string | null;
  updatedAt: number | null;
}

export interface CronInfo {
  configured: boolean;
  schedule: string;
  timezone: string;
  description: string;
  note: string;
}

export class BackupError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "UNKNOWN", status = 0) {
    super(message);
    this.name = "BackupError";
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
    throw new BackupError("网络不可用，请检查连接", "NETWORK_ERROR");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new BackupError(
      payload?.error?.message || `请求失败（${response.status}）`,
      payload?.error?.code || "UNKNOWN",
      response.status,
    );
  }
  return payload?.data as T;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export const listBackups = (params: Record<string, string | number> = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== undefined) query.set(key, String(value));
  }
  return request<{
    backups: BackupRecord[];
    total: number;
    limit: number;
    offset: number;
    settings: BackupSettings;
    storage: StorageStats;
    cron: CronInfo;
  }>(`/api/backups?${query}`);
};

export const getBackup = (id: string) =>
  request<{ backup: BackupRecord; job: BackupJob | null; files: Array<{ id: string; sizeBytes: number; checksum: string }> }>(
    `/api/backups/${encodeURIComponent(id)}`,
  );

export const getProgress = (id: string) =>
  request<{ backup: BackupRecord; job: BackupJob | null }>(`/api/backups/${encodeURIComponent(id)}/progress`);

export const getStorage = () => request<{ storage: StorageStats }>("/api/backups/storage");

export const getSettings = () => request<{ settings: BackupSettings; cron: CronInfo }>("/api/backups/settings");

export const saveSettings = (settings: Partial<BackupSettings>) =>
  request<{ settings: BackupSettings; cron: CronInfo; note: string }>("/api/backups/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });

/* ------------------------------------------------------------------ */
/* 创建 / 执行                                                         */
/* ------------------------------------------------------------------ */

export const createBackup = (payload: {
  name: string;
  domains: BackupDomain[];
  snapshot?: Record<string, unknown>;
  type?: "manual" | "protective";
}) =>
  request<{ backup: BackupRecord; job: BackupJob; totals: { files: number; fileBytes: number; dataBytes: number } }>(
    "/api/backups",
    { method: "POST", body: JSON.stringify(payload) },
  );

export async function runBackupUntilDone(
  id: string,
  onProgress?: (job: BackupJob | null, backup: BackupRecord) => void,
  maxCalls = 60,
): Promise<{ backup: BackupRecord; job: BackupJob | null }> {
  let last: { backup: BackupRecord; job: BackupJob | null } | null = null;

  for (let i = 0; i < maxCalls; i += 1) {
    const result = await request<{ done: boolean; backup: BackupRecord; job: BackupJob | null }>(
      `/api/backups/${encodeURIComponent(id)}/run`,
      { method: "POST", body: "{}" },
    );
    last = { backup: result.backup, job: result.job };
    onProgress?.(result.job, result.backup);
    if (result.done) return last;
    if (result.backup.status === "failed") {
      throw new BackupError(result.backup.errorMessage || "备份失败", "BACKUP_FAILED");
    }
  }

  if (last) return last;
  throw new BackupError("备份任务未完成，请稍后重试", "BACKUP_TIMEOUT");
}

export async function verifyBackupUntilDone(id: string, onProgress?: (progress: number) => void) {
  for (let i = 0; i < 40; i += 1) {
    const result = await request<{ complete: boolean; verifiedFiles: number; totalFiles: number }>(
      `/api/backups/${encodeURIComponent(id)}/verify`,
      { method: "POST", body: "{}" },
    );
    onProgress?.(result.totalFiles ? Math.round((result.verifiedFiles / result.totalFiles) * 100) : 100);
    if (result.complete) return result;
  }
  throw new BackupError("校验未在预期次数内完成", "VERIFY_TIMEOUT");
}

export const renameBackup = (id: string, name: string) =>
  request<{ backup: BackupRecord }>(`/api/backups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteBackup = (id: string) =>
  request<{ deleted: boolean; note: string }>(`/api/backups/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: "DELETE" }),
  });

export const exportDomain = (id: string, domain: BackupDomain) =>
  request<{ schemaVersion: number; backupId: string; domain: BackupDomain; data: unknown }>(
    `/api/backups/${encodeURIComponent(id)}/export?domain=${domain}`,
  );

export const downloadUrl = (id: string, format: "json" | "zip") =>
  `/api/backups/${encodeURIComponent(id)}/download?format=${format}`;

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

export interface RestorePreview {
  backup: BackupRecord;
  mode: RestoreMode;
  domains: Array<{
    domain: BackupDomain;
    available: boolean;
    backupCount: number;
    currentCount: number | null;
    modeLimited: boolean;
  }>;
  totals: { backupBytes: number; fileCount: number; localPayloadBytes: number };
  requirements: { protectiveBackup: boolean; confirm: boolean; note: string };
  warnings: string[];
}

export const previewRestore = (id: string, domains: BackupDomain[], mode: RestoreMode) =>
  request<RestorePreview>(`/api/backups/${encodeURIComponent(id)}/restore/preview`, {
    method: "POST",
    body: JSON.stringify({ domains, mode }),
  });

export interface RestoreRecord {
  id: string;
  backupId: string;
  mode: RestoreMode;
  domains: BackupDomain[];
  status: "queued" | "running" | "awaiting_client" | "completed" | "failed" | "cancelled";
  stats: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface RestoreRunResult {
  restore: RestoreRecord;
  job: BackupJob | null;
  localSnapshot: Record<string, unknown> | null;
  partial?: boolean;
}

export const executeRestore = (payload: {
  backupId: string;
  domains: BackupDomain[];
  mode: RestoreMode;
  protectiveBackupId: string;
  idempotencyKey: string;
}) =>
  request<RestoreRunResult>(`/api/backups/${encodeURIComponent(payload.backupId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ ...payload, confirm: true }),
  });

export async function runRestoreUntilDone(restoreId: string, onProgress?: (progress: number) => void) {
  for (let i = 0; i < 60; i += 1) {
    const result = await request<RestoreRunResult>(
      `/api/backups/restores/${encodeURIComponent(restoreId)}/run`,
      { method: "POST", body: "{}" },
    );
    onProgress?.(result.job?.progress ?? 0);
    if (result.restore.status === "completed" || result.restore.status === "awaiting_client") return result;
    if (result.restore.status === "failed") {
      throw new BackupError(result.restore.errorMessage || "恢复失败", "RESTORE_FAILED");
    }
  }
  throw new BackupError("恢复任务未完成", "RESTORE_TIMEOUT");
}

export const ackRestore = (restoreId: string, applied: Record<string, number>) =>
  request<RestoreRunResult>(`/api/backups/restores/${encodeURIComponent(restoreId)}/ack`, {
    method: "POST",
    body: JSON.stringify({ applied }),
  });

/* ------------------------------------------------------------------ */
/* 本地快照                                                            */
/* ------------------------------------------------------------------ */

const NOTES_KEY = "guandao.os14.notes.v1";
const TASKS_KEY = "guandao.os14.tasks.v1";
const CALENDAR_KEY = "guandao.os14.calendar.v1";

/** 桌面 / 个性化范围：只包含配置，不包含二进制与认证凭证。 */
export const DESKTOP_KEYS = [
  "guandao.os.dock",
  "guandao.os.state.v1",
  "guandao.os.theme",
  "guandao.os13.v1",
  "guandao.os.widgets.v1",
  "guandao.os14.widgcfg.v1",
  "guandao.os14.themes.v1",
  "guandao.os14.prefs.v1",
  "guandao.os14.deco.v1",
  "guandao.os14.pet.v1",
  "guandao.os14.photo.v1",
  "guandao.os14.countdown.v1",
  "guandao.os14.focus.v1",
  "guandao.os14.world.v1",
  "guandao.os.lp.order.v1",
  "guandao.os.lp.hidden.v1",
  "guandao.os.recent",
  "guandao.os14.apps.v1",
];

export const WORKSPACE_KEYS = ["guandao.os14.ws.v1"];

function readRaw<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: unknown, rawString = false): void {
  try {
    localStorage.setItem(key, rawString && typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* 配额溢出时由调用方提示 */
  }
}

export function countLocal(domain: BackupDomain): number | null {
  if (domain === "notes") {
    const state = readRaw<{ notes?: unknown[] }>(NOTES_KEY);
    return Array.isArray(state?.notes) ? state.notes.length : 0;
  }
  if (domain === "tasks") {
    const state = readRaw<{ tasks?: unknown[] }>(TASKS_KEY);
    return Array.isArray(state?.tasks) ? state.tasks.length : 0;
  }
  if (domain === "calendar") {
    const state = readRaw<{ events?: unknown[] }>(CALENDAR_KEY);
    return Array.isArray(state?.events) ? state.events.length : 0;
  }
  if (domain === "desktop") return DESKTOP_KEYS.filter((key) => localStorage.getItem(key) != null).length;
  if (domain === "workspace") return WORKSPACE_KEYS.filter((key) => localStorage.getItem(key) != null).length;
  return null;
}

export function collectSnapshot(domains: BackupDomain[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  if (domains.includes("notes")) {
    snapshot.notes = readRaw(NOTES_KEY) ?? { v: 1, folders: [], notes: [], ui: {} };
  }
  if (domains.includes("tasks")) {
    snapshot.tasks = readRaw(TASKS_KEY) ?? { v: 1, tasks: [] };
  }
  if (domains.includes("calendar")) {
    snapshot.calendar = readRaw(CALENDAR_KEY) ?? { v: 1, events: [], ui: {} };
  }
  if (domains.includes("desktop")) {
    const keys: Record<string, unknown> = {};
    for (const key of DESKTOP_KEYS) {
      const value = readRaw(key);
      if (value !== null) keys[key] = value;
    }
    snapshot.desktop = keys;
  }
  if (domains.includes("workspace")) {
    const keys: Record<string, unknown> = {};
    for (const key of WORKSPACE_KEYS) {
      const value = readRaw(key);
      if (value !== null) keys[key] = value;
    }
    snapshot.workspace = keys;
  }
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* 本地恢复                                                            */
/* ------------------------------------------------------------------ */

interface MergeResult {
  state: unknown;
  added: number;
  conflicts: number;
  skipped: number;
}

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random()}`;

function applyNoteState(mode: RestoreMode, incoming: any, currentRaw: any): MergeResult {
  const current = currentRaw && Array.isArray(currentRaw.notes) ? currentRaw : { v: 1, folders: [], notes: [], ui: {} };
  const source = incoming && Array.isArray(incoming.notes) ? incoming : null;
  if (!source) return { state: current, added: 0, conflicts: 0, skipped: 0 };

  if (mode === "replace") {
    return { state: source, added: source.notes.length, conflicts: 0, skipped: 0 };
  }

  const folders = [...(current.folders || [])];
  for (const folder of source.folders || []) {
    if (!folders.some((item: any) => item.id === folder.id)) folders.push(folder);
  }

  const notes = [...current.notes];
  let added = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const note of source.notes) {
    const existing = notes.find((item: any) => item.id === note.id);
    if (!existing) {
      notes.push(mode === "copy" ? { ...note, id: newId() } : note);
      added += 1;
      continue;
    }
    const same = existing.title === note.title && existing.body === note.body && existing.updatedAt === note.updatedAt;
    if (same) skipped += 1;
    else conflicts += 1;
  }

  return { state: { ...current, folders, notes }, added, conflicts, skipped };
}

function applyTaskState(mode: RestoreMode, incoming: any, currentRaw: any): MergeResult {
  const current = currentRaw && Array.isArray(currentRaw.tasks) ? currentRaw : { v: 1, tasks: [] };
  const source = incoming && Array.isArray(incoming.tasks) ? incoming : null;
  if (!source) return { state: current, added: 0, conflicts: 0, skipped: 0 };
  if (mode === "replace") return { state: source, added: source.tasks.length, conflicts: 0, skipped: 0 };

  const tasks = [...current.tasks];
  let added = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const task of source.tasks) {
    const existing = tasks.find((item: any) => item.id === task.id);
    if (!existing) {
      tasks.push(mode === "copy" ? { ...task, id: newId() } : task);
      added += 1;
      continue;
    }
    const same = existing.title === task.title && existing.done === task.done && existing.due === task.due;
    if (same) skipped += 1;
    else conflicts += 1;
  }

  return { state: { ...current, tasks }, added, conflicts, skipped };
}

function applyCalendarState(mode: RestoreMode, incoming: any, currentRaw: any): MergeResult {
  const current = currentRaw && Array.isArray(currentRaw.events) ? currentRaw : { v: 1, events: [], ui: {} };
  const source = incoming && Array.isArray(incoming.events) ? incoming : null;
  if (!source) return { state: current, added: 0, conflicts: 0, skipped: 0 };
  // 日期与时间都是字符串，原样写回，不做 UTC 换算，避免时区偏移。
  if (mode === "replace") return { state: source, added: source.events.length, conflicts: 0, skipped: 0 };

  const events = [...current.events];
  let added = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const event of source.events) {
    const existing = events.find((item: any) => item.id === event.id);
    if (!existing) {
      events.push(mode === "copy" ? { ...event, id: newId() } : event);
      added += 1;
      continue;
    }
    const same = existing.title === event.title && existing.date === event.date && existing.time === event.time;
    if (same) skipped += 1;
    else conflicts += 1;
  }

  return { state: { ...current, events }, added, conflicts, skipped };
}

export interface ApplyResult {
  applied: Record<string, number>;
  conflicts: number;
  skipped: number;
}

/**
 * 把服务端返回的本地快照写回 localStorage。
 * 必须由用户确认后调用；replace 模式下服务端已要求先做保护性备份。
 */
export function applyLocalSnapshot(
  snapshot: Record<string, unknown>,
  domains: BackupDomain[],
  mode: RestoreMode,
): ApplyResult {
  const result: ApplyResult = { applied: {}, conflicts: 0, skipped: 0 };

  for (const domain of domains) {
    const incoming = snapshot?.[domain];
    if (!incoming) continue;

    if (domain === "notes") {
      const merge = applyNoteState(mode, incoming, readRaw(NOTES_KEY));
      writeRaw(NOTES_KEY, merge.state);
      result.applied.notes = merge.added;
      result.conflicts += merge.conflicts;
      result.skipped += merge.skipped;
      window.dispatchEvent(new Event("guandao:notes-change"));
    }

    if (domain === "tasks") {
      const merge = applyTaskState(mode, incoming, readRaw(TASKS_KEY));
      writeRaw(TASKS_KEY, merge.state);
      result.applied.tasks = merge.added;
      result.conflicts += merge.conflicts;
      result.skipped += merge.skipped;
      window.dispatchEvent(new Event("guandao:tasks-change"));
    }

    if (domain === "calendar") {
      const merge = applyCalendarState(mode, incoming, readRaw(CALENDAR_KEY));
      writeRaw(CALENDAR_KEY, merge.state);
      result.applied.calendar = merge.added;
      result.conflicts += merge.conflicts;
      result.skipped += merge.skipped;
      window.dispatchEvent(new Event("guandao:calendar-change"));
    }

    if (domain === "desktop" || domain === "workspace") {
      if (mode !== "replace") continue;
      const keys = (incoming || {}) as Record<string, unknown>;
      const allowed = domain === "desktop" ? DESKTOP_KEYS : WORKSPACE_KEYS;
      for (const key of allowed) {
        if (!(key in keys)) localStorage.removeItem(key);
      }
      for (const [key, value] of Object.entries(keys)) {
        if (!allowed.includes(key)) continue;
        writeRaw(key, value);
      }
      result.applied[domain] = Object.keys(keys).length;
      window.dispatchEvent(new Event("guandao:appearance-change"));
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* 导入（仅结构化 JSON 包）                                             */
/* ------------------------------------------------------------------ */

export interface ImportPackage {
  manifest: {
    schemaVersion: number;
    backupId: string;
    userId: string;
    backupName?: string;
    dataChecksum: string;
    domains: BackupDomain[];
  };
  data: {
    schemaVersion: number;
    domains: Record<string, unknown>;
  };
}

export async function verifyImportPackage(pkg: ImportPackage): Promise<{ ok: boolean; reason?: string }> {
  if (!pkg?.manifest || !pkg?.data) return { ok: false, reason: "文件格式不正确" };
  if (Number(pkg.manifest.schemaVersion) > 1 || Number(pkg.data.schemaVersion) > 1) {
    return { ok: false, reason: "备份版本高于当前应用支持的版本（schemaVersion 1）" };
  }

  const bytes = new TextEncoder().encode(JSON.stringify(pkg.data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== pkg.manifest.dataChecksum) {
    return { ok: false, reason: "数据校验失败：文件可能被修改过" };
  }
  return { ok: true };
}
