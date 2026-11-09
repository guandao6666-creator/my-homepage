/**
 * Guandao OS 2.0 · 同步墓碑
 *
 * 本地数据被删除后，如果只从数组里移除，同步引擎就再也看不到它，
 * 另一端会把旧数据「复活」。所以删除必须留墓碑：
 *
 *   { notes: { "<id>": <删除时间> }, tasks: {...}, calendar: {...} }
 *
 * 墓碑在推送成功后被清掉；推送失败则保留，下次继续尝试。
 * 存储键在 `guandao.core.*` 命名空间里，不碰 1.x 的任何数据。
 */

export type SyncDomain = "notes" | "tasks" | "calendar";

type Tombstones = Partial<Record<SyncDomain, Record<string, number>>>;

const KEY = "guandao.core.sync.tombstones.v1";

const readAll = (): Tombstones => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // 兼容两种写入形态：裸对象，或 StorageManager 的版本信封
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      const data = (parsed as { data?: Tombstones }).data;
      return data && typeof data === "object" ? data : {};
    }
    return parsed && typeof parsed === "object" ? (parsed as Tombstones) : {};
  } catch {
    return {};
  }
};

const writeAll = (all: Tombstones): void => {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式 / 配额满：墓碑丢失会导致删除不传播，但不会破坏本地数据 */
  }
};

/** 记录一次删除（同一 id 以最后一次删除时间为准） */
export function recordTombstone(domain: SyncDomain, id: string, at = Date.now()): void {
  if (!id) return;
  const all = readAll();
  all[domain] = { ...(all[domain] ?? {}), [id]: at };
  writeAll(all);
}

/** 读取某个域的墓碑（id → 删除时间） */
export function readTombstones(domain: SyncDomain): Record<string, number> {
  return { ...(readAll()[domain] ?? {}) };
}

/** 推送成功后清理墓碑；只清理确实已同步的 id */
export function clearTombstones(domain: SyncDomain, ids: string[]): void {
  if (!ids.length) return;
  const all = readAll();
  const current = all[domain];
  if (!current) return;
  for (const id of ids) delete current[id];
  if (!Object.keys(current).length) delete all[domain];
  writeAll(all);
}

/** 诊断 / 系统设置用 */
export function tombstoneStats(): Record<SyncDomain, number> {
  const all = readAll();
  return {
    notes: Object.keys(all.notes ?? {}).length,
    tasks: Object.keys(all.tasks ?? {}).length,
    calendar: Object.keys(all.calendar ?? {}).length,
  };
}