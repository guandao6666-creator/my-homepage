/**
 * Guandao OS 1.7 · 插件本地状态
 *
 * 这里只持久化「已经真实发生」的结果：
 *   - 安装记录（版本、来源、校验值、授权、日志）
 *   - 插件包（IndexedDB，避免撑爆 localStorage）
 *   - 插件自己的命名空间存储（有配额、按插件隔离）
 *
 * 没有「UI 状态」：按钮是否可点由记录推导，刷新后仍然一致。
 */

import { idb, ls } from "../os14/core";
import type { Manifest, PluginType } from "../../../shared/plugin-spec.js";
import { PLUGIN_LIMITS, canonicalJson, byteLength } from "../../../shared/plugin-spec.js";

export const STATE_KEY = "guandao.plugins.v1";
const STORAGE_PREFIX = "guandao.plugin.storage.";
const BUNDLE_PREFIX = "plugin:";

export type PluginLog = { at: number; level: "info" | "warn" | "error"; message: string };

export type InstallRecord = {
  id: string;
  name: string;
  version: string;
  previousVersion: string | null;
  type: PluginType;
  category: string;
  author: string;
  description: string;
  manifest: Manifest;
  permissions: string[];
  granted: string[];
  enabled: boolean;
  source: "market" | "official" | "dev";
  installedAt: number;
  updatedAt: number;
  packageHash: string;
  filesDigest: string;
  bundleKey: string;
  iconUrl: string;
  blocked: boolean;
  failure: string;
  logs: PluginLog[];
  /**
   * 2.0：从另一台设备恢复、且涉及高敏感权限时置为 true。
   * 此时插件保持禁用，必须在本机重新确认授权后才能启用。
   */
  needsConsent?: boolean;
  /**
   * 2.2：发布者签名信任状态。老记录没有这个字段时按 unsigned 处理——
   * 「没验证过」和「验证通过」必须能区分，否则界面会撒谎。
   */
  signature?: { status: "verified" | "unsigned" | "invalid"; keyId: string | null; signedAt: number | null };
};

type State = { v: 1; installs: Record<string, InstallRecord> };

const emptyState = (): State => ({ v: 1, installs: {} });

export function readState(): State {
  const raw = ls.get<State | null>(STATE_KEY, null);
  if (!raw || raw.v !== 1 || typeof raw.installs !== "object" || !raw.installs) return emptyState();
  return raw;
}

export function writeState(next: State) {
  ls.set(STATE_KEY, next);
  window.dispatchEvent(new CustomEvent("guandao:plugins-change", { detail: { count: Object.keys(next.installs).length } }));
}

export function listInstalls(): InstallRecord[] {
  return Object.values(readState().installs).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getInstall(id: string): InstallRecord | null {
  return readState().installs[id] ?? null;
}

export function saveInstall(record: InstallRecord) {
  const state = readState();
  state.installs[record.id] = record;
  writeState(state);
}

export function patchInstall(id: string, patch: Partial<InstallRecord>) {
  const state = readState();
  const current = state.installs[id];
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  state.installs[id] = next;
  writeState(state);
  return next;
}

export function removeInstallRecord(id: string) {
  const state = readState();
  delete state.installs[id];
  writeState(state);
}

export function appendLog(id: string, level: PluginLog["level"], message: string) {
  const state = readState();
  const record = state.installs[id];
  if (!record) return;
  const logs = [...(record.logs ?? []), { at: Date.now(), level, message: String(message).slice(0, 300) }].slice(-40);
  record.logs = logs;
  writeState(state);
}

/* ============================================================
   插件包（IndexedDB）
   ============================================================ */

export function bundleKey(id: string, version: string) {
  return `${BUNDLE_PREFIX}${id}@${version}`;
}

export async function putBundle(id: string, version: string, text: string): Promise<string> {
  const key = bundleKey(id, version);
  const ok = await idb.put("blobs", key, text);
  if (!ok) throw new Error("插件包写入本地存储失败（浏览器可能处于隐私模式）");
  return key;
}

export async function getBundle(key: string): Promise<string | null> {
  const value = await idb.get<string>("blobs", key);
  return typeof value === "string" ? value : null;
}

export async function dropBundles(id: string): Promise<void> {
  const keys = await idb.keys("blobs");
  const prefix = `${BUNDLE_PREFIX}${id}@`;
  for (const key of keys) {
    if (key.startsWith(prefix)) await idb.del("blobs", key);
  }
}

/* ============================================================
   插件命名空间存储
   ============================================================ */

type PluginStore = Record<string, unknown>;

const readStore = (id: string): PluginStore => {
  const raw = ls.get<PluginStore | null>(`${STORAGE_PREFIX}${id}`, null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
};

const storeBytes = (store: PluginStore) => byteLength(canonicalJson(store));

/**
 * 2.0：所有插件共享一个浏览器 localStorage 预算。
 *
 * 单插件上限是 256KB × 128 键，但以前没有「所有插件加起来」的上限：
 * 装十几个插件就能把宿主 5MB 配额吃光，导致桌面自己的数据写不进去。
 */
const GLOBAL_STORAGE_BYTES = 2 * 1024 * 1024;

function totalPluginStorageBytes(): number {
  try {
    if (typeof localStorage === "undefined") return 0;
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      total += (localStorage.getItem(key) ?? "").length;
    }
    return total;
  } catch {
    return 0;
  }
}

export type StorageResult = { ok: true; value?: unknown } | { ok: false; code: string; message: string };

export function storageGet(id: string, key: string): unknown {
  const store = readStore(id);
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
}

export function storageSet(id: string, key: string, value: unknown): StorageResult {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
    return { ok: false, code: "INVALID_KEY", message: "存储键只能包含字母、数字、点、下划线与短横线" };
  }
  const store = readStore(id);
  const next = { ...store, [key]: value };
  const keys = Object.keys(next);
  if (keys.length > PLUGIN_LIMITS.storageKeys) {
    return { ok: false, code: "STORAGE_KEYS_LIMIT", message: `最多保存 ${PLUGIN_LIMITS.storageKeys} 个键` };
  }
  const size = storeBytes(next);
  if (size > PLUGIN_LIMITS.storageBytes) {
    return {
      ok: false,
      code: "STORAGE_QUOTA",
      message: `本插件存储已超过 ${Math.round(PLUGIN_LIMITS.storageBytes / 1024)} KB 上限`,
    };
  }

  // 全局预算：按增量计算，避免把正在写入的插件本身重复计入
  const delta = size - storeBytes(store);
  const globalAfter = totalPluginStorageBytes() + delta;
  if (globalAfter > GLOBAL_STORAGE_BYTES) {
    return {
      ok: false,
      code: "STORAGE_QUOTA_GLOBAL",
      message: `所有插件的存储总计已超过 ${Math.round(GLOBAL_STORAGE_BYTES / 1024)} KB 上限，请先清理部分插件数据`,
    };
  }
  return ls.set(`${STORAGE_PREFIX}${id}`, next)
    ? { ok: true, value }
    : { ok: false, code: "STORAGE_WRITE_FAILED", message: "浏览器拒绝写入，可能已满或处于隐私模式" };
}

export function storageDelete(id: string, key: string): boolean {
  const store = readStore(id);
  if (!Object.prototype.hasOwnProperty.call(store, key)) return false;
  delete store[key];
  ls.set(`${STORAGE_PREFIX}${id}`, store);
  return true;
}

export function storageKeys(id: string): string[] {
  return Object.keys(readStore(id));
}

export function storageClear(id: string): void {
  ls.del(`${STORAGE_PREFIX}${id}`);
}

export function storageUsage(id: string): { keys: number; bytes: number } {
  const store = readStore(id);
  return { keys: Object.keys(store).length, bytes: storeBytes(store) };
}

/** 卸载时清理插件数据；keepData 为 true 时保留命名空间存储。 */
export function purgePluginData(id: string, keepData: boolean) {
  if (!keepData) storageClear(id);
  void dropBundles(id);
}
