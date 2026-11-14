/**
 * Guandao OS 2.0 · 偏好同步域（Phase 4.2）
 *
 * 只同步「跨设备有意义」的偏好：主题、外观、Dock、时钟、通知与更新通道。
 * 设备级设置（system.mode、诊断日志保留、设备名/分辨率、Session/Token）永远
 * 留在本机，白名单之外的一律拒绝——这是硬约束，不是默认值。
 *
 * updatedAt 用「上次同步快照」比较：内容没变时保持上次同步的服务器时间戳，
 * 避免每次同步都误判成本地更新；用户改动后才 bump。
 */

import {
  SETTINGS_BY_ID,
  type SettingField,
  type SettingValue,
  type SettingsManager,
  type SettingsValues,
} from "../core/settings";
import type { StorageManager } from "../core/storage";

export const PREFERENCES_ENTITY_ID = "preferences";
export const PREFERENCES_LAST_KEY = "guandao.core.sync.preferences.last";
export const MAX_PREFERENCES_PAYLOAD_BYTES = 32 * 1024;

/** 唯一允许跨设备同步的设置项（白名单，顺序即界面展示顺序） */
export const SYNC_PREFERENCE_KEYS = [
  "appearance.mode",
  "appearance.material",
  "appearance.radius",
  "appearance.accent",
  "appearance.animations",
  "desktop.iconLabels",
  "desktop.clockSeconds",
  "desktop.dock.autohide",
  "desktop.dock.position",
  "desktop.widgets.opacity",
  "notifications.dnd",
  "notifications.volume",
  "system.updateChannel",
] as const;

export type SyncPreferenceId = (typeof SYNC_PREFERENCE_KEYS)[number];

const SYNC_PREFERENCE_SET = new Set<string>(SYNC_PREFERENCE_KEYS);

/** 明确禁止同步的设备级设置（含未来可能加入 schema 的项） */
export const DEVICE_ONLY_SETTINGS = [
  "system.mode",
  "system.diagnosticsRetention",
  "device.name",
  "device.resolution",
  "device.session",
  "device.token",
] as const;

const DEVICE_ONLY_SET = new Set<string>(DEVICE_ONLY_SETTINGS);

export type PreferencesPayload = {
  v: 1;
  values: Partial<Record<SyncPreferenceId, SettingValue>>;
};

export type PreferencesValidation =
  | { ok: true; payload: PreferencesPayload; bytes: number }
  | { ok: false; error: string };

export type PreferencesApplyResult = {
  ok: boolean;
  applied: string[];
  rejected: string[];
  error?: string;
};

export type PreferencesSyncKernel = {
  settings: SettingsManager;
  storage?:
    | (Pick<StorageManager, "legacyStr" | "activeStore"> & {
        read?: <T>(key: string, fallback: T) => T;
      })
    | null;
};

type LastSynced = { v: 1; at: number; hash: string };

const byteLength = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 3;
  }
};

const byteLengthOf = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* ============================================================
   存储（last-synced 快照）
   ============================================================ */

const readRaw = (kernel: PreferencesSyncKernel, key: string): string | null => {
  try {
    if (kernel.storage?.legacyStr) {
      const value = kernel.storage.legacyStr(key);
      if (value !== null) return value;
    }
    if (kernel.storage?.activeStore) {
      const value = kernel.storage.activeStore.getItem(key);
      if (value !== null) return value;
    }
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    return null;
  } catch {
    return null;
  }
};

const writeRaw = (kernel: PreferencesSyncKernel, key: string, text: string): void => {
  try {
    if (kernel.storage?.activeStore) {
      kernel.storage.activeStore.setItem(key, text);
      return;
    }
    if (typeof localStorage !== "undefined") localStorage.setItem(key, text);
  } catch {
    /* 存储不可用 / 配额满：last-synced 只是优化，不阻塞同步 */
  }
};

const readLastSynced = (kernel: PreferencesSyncKernel): LastSynced | null => {
  const text = readRaw(kernel, PREFERENCES_LAST_KEY);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (parsed.v !== 1 || typeof parsed.hash !== "string") return null;
    const at = Number(parsed.at);
    if (!Number.isFinite(at) || at < 0) return null;
    return { v: 1, at: Math.trunc(at), hash: parsed.hash };
  } catch {
    return null;
  }
};

/* ============================================================
   白名单取值 / 校验
   ============================================================ */

const pick = (values: SettingsValues): Partial<Record<SyncPreferenceId, SettingValue>> => {
  const picked: Partial<Record<SyncPreferenceId, SettingValue>> = {};
  for (const id of SYNC_PREFERENCE_KEYS) {
    const value = values[id];
    if (value !== undefined) picked[id] = value;
  }
  return picked;
};

/** 白名单快照的稳定指纹（键排序），用于判断「相对上次同步是否改过」 */
export function preferencesHash(values: SettingsValues): string {
  const picked = pick(values);
  const parts: string[] = [];
  for (const id of [...SYNC_PREFERENCE_KEYS].sort()) {
    if (picked[id] !== undefined) parts.push(`${id}=${JSON.stringify(picked[id])}`);
  }
  return parts.join("&");
}

export function buildPreferencesPayload(settings: SettingsManager, _kernel?: PreferencesSyncKernel): PreferencesPayload {
  return { v: 1, values: pick(settings.read()) };
}

const valueIsValid = (field: SettingField, value: unknown): boolean => {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (field.min !== undefined && value < field.min) return false;
    if (field.max !== undefined && value > field.max) return false;
    return true;
  }
  if (typeof value !== "string") return false;
  // 与 SettingsManager.coerce 保持一致：accent 允许自定义 #RRGGBB
  if (field.id === "appearance.accent" && /^#[0-9a-f]{6}$/i.test(value)) return true;
  return (field.options ?? []).some((option) => option.value === value);
};

/**
 * 严格校验远端偏好 payload：未知键 / 设备级键 / 类型或范围非法 / 体积超限都会
 * 明确报错（不静默丢弃，避免把「部分同步」当成成功）。
 */
export function validatePreferencesPayload(raw: unknown): PreferencesValidation {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (error) {
      return { ok: false, error: `偏好数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!isPlainObject(payload)) return { ok: false, error: "偏好数据必须是对象" };
  const bytes = byteLengthOf(payload);
  if (bytes > MAX_PREFERENCES_PAYLOAD_BYTES) {
    return { ok: false, error: `偏好数据 ${bytes} 字节，超过 ${MAX_PREFERENCES_PAYLOAD_BYTES} 字节上限` };
  }
  if (payload.v !== 1) return { ok: false, error: "偏好数据版本不是 v:1" };
  const values = payload.values;
  if (!isPlainObject(values)) return { ok: false, error: "缺少 values 对象" };

  const normalized: Partial<Record<SyncPreferenceId, SettingValue>> = {};
  for (const [id, value] of Object.entries(values)) {
    if (DEVICE_ONLY_SET.has(id)) return { ok: false, error: `设备级设置 ${id} 不允许同步` };
    if (!SYNC_PREFERENCE_SET.has(id)) return { ok: false, error: `未知设置项 ${id}（不在同步白名单内）` };
    const field = SETTINGS_BY_ID[id];
    if (!field) return { ok: false, error: `未知设置项 ${id}（设置 schema 中不存在）` };
    if (!valueIsValid(field, value)) return { ok: false, error: `设置项 ${id} 的值非法` };
    normalized[id as SyncPreferenceId] = value as SettingValue;
  }
  return { ok: true, payload: { v: 1, values: normalized }, bytes };
}

/* ============================================================
   updatedAt / last-synced
   ============================================================ */

/**
 * 记录「本地已经跟上服务端」的快照。
 * `at` 应优先使用服务端返回的 updatedAt，保证下次比较时两边时间戳对齐。
 */
export function markPreferencesSynced(kernel: PreferencesSyncKernel, at = Date.now(), values?: SettingsValues): void {
  const current = values ?? settingsValues(kernel.settings);
  const last: LastSynced = {
    v: 1,
    at: Math.max(0, Math.trunc(Number(at) || 0)),
    hash: preferencesHash(current),
  };
  writeRaw(kernel, PREFERENCES_LAST_KEY, JSON.stringify(last));
}

const settingsValues = (settings: SettingsManager): SettingsValues => settings.read();

/**
 * 本地偏好的 updatedAt：
 *   - 从未同步过 → 0（让远端版本优先，换设备登录不会用默认值覆盖云端）；
 *   - 与上次同步快照一致 → 上次同步时间（保持稳定，避免误判为更新）；
 *   - 用户改过 → 当前时间（bump，触发推送）。
 */
export function preferencesUpdatedAt(kernel: PreferencesSyncKernel, values?: SettingsValues): number {
  const current = values ?? settingsValues(kernel.settings);
  const last = readLastSynced(kernel);
  if (!last) return 0;
  if (last.hash === preferencesHash(current)) return last.at;
  return Date.now();
}

export type PreferencesSyncItem = {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  payload?: PreferencesPayload;
};

/** 本地单条同步项（偏好是单例实体） */
export function readLocalPreferences(kernel: PreferencesSyncKernel): PreferencesSyncItem {
  const values = settingsValues(kernel.settings);
  return {
    id: PREFERENCES_ENTITY_ID,
    updatedAt: preferencesUpdatedAt(kernel, values),
    payload: { v: 1, values: pick(values) },
  };
}

/* ============================================================
   应用远端偏好
   ============================================================ */

/**
 * 应用远端偏好：逐项写白名单，非法值只进 rejected、不抛异常；
 * 写入成功后会触发 SettingsManager 的订阅者（桥接层据此即时重渲染）。
 * 返回 applied（真正变化的 id）与 rejected（未知/非法/被拒绝的 id）。
 */
export function applyPreferencesPayload(
  settings: SettingsManager,
  kernel: PreferencesSyncKernel,
  payload: unknown,
): PreferencesApplyResult {
  let data: unknown = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload) as unknown;
    } catch (error) {
      return { ok: false, applied: [], rejected: [], error: `偏好数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!isPlainObject(data)) return { ok: false, applied: [], rejected: [], error: "偏好数据必须是对象" };
  if (byteLengthOf(data) > MAX_PREFERENCES_PAYLOAD_BYTES) {
    return { ok: false, applied: [], rejected: [], error: "偏好数据超过 32KB 上限" };
  }
  if (data.v !== 1) return { ok: false, applied: [], rejected: [], error: "偏好数据版本不是 v:1" };
  const values = data.values;
  if (!isPlainObject(values)) return { ok: false, applied: [], rejected: [], error: "缺少 values 对象" };

  const patch: SettingsValues = {};
  const rejected: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    if (DEVICE_ONLY_SET.has(id) || !SYNC_PREFERENCE_SET.has(id)) {
      rejected.push(id);
      continue;
    }
    const field = SETTINGS_BY_ID[id];
    if (!field || !valueIsValid(field, value)) {
      rejected.push(id);
      continue;
    }
    patch[id] = value as SettingValue;
  }

  if (!Object.keys(patch).length) {
    return { ok: true, applied: [], rejected, error: rejected.length ? "没有可应用的合法偏好项" : undefined };
  }
  try {
    const result = settings.update(patch);
    return {
      ok: true,
      applied: result.changed.map((change) => change.id),
      rejected: [...rejected, ...result.rejected],
    };
  } catch (error) {
    return {
      ok: false,
      applied: [],
      rejected,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
