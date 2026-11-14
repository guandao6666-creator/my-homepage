/**
 * Guandao OS 2.0 · 同步冲突记录
 *
 * 「服务端优先」不再是唯一策略：冲突会被记下来，用户可以在系统中心逐条
 * 选择「保留本地」或「保留云端」。本模块只负责**记录**，真正的重新推送
 * / 拉取由 providers.ts 的 resolveSyncConflict() 完成。
 *
 * 约束：
 *   - 只存 localStorage 一个键（guandao.core.sync.conflicts.v1），最多 50 条、
 *     7 天过期，按 `${domain}:${entityId}` 去重，避免长期占满用户存储；
 *   - 快照受控：每边 ≤ 4KB，长文本只留截断预览，绝不把完整笔记正文写进日志或存储；
 *   - 读取容错：损坏 JSON / 旧信封都退化为空列表，不抛异常；
 *   - storage 可注入，方便 Node 单测（参考 tombstones.ts 的内存实现）。
 */

export const CONFLICTS_KEY = "guandao.core.sync.conflicts.v1";

/** 最多保留的冲突条数（超出按时间淘汰最旧的） */
export const MAX_CONFLICTS = 50;

/** 冲突记录 TTL：7 天 */
export const CONFLICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 单边快照的序列化上限：4KB */
export const MAX_SNAPSHOT_BYTES = 4096;

const MAX_PREVIEW_CHARS = 800;
const MAX_FIELD_CHARS = 160;
const MAX_LABEL_CHARS = 120;
const MAX_FIELDS = 12;
const MAX_SNAPSHOT_ATTEMPTS = 4;

/** 只依赖 KV 三件套，浏览器 localStorage 与测试内存实现都能直接注入 */
export type ConflictKeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type MemoryStore = ConflictKeyValueStore & { clear: () => void };

const createMemoryStore = (): MemoryStore => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
};

const memoryFallback = createMemoryStore();

/**
 * 选存储：显式注入 > 浏览器 localStorage > 进程内兜底。
 * 兜底用于「隐私模式 / Node 环境」，保证不因为存储不可用而抛错。
 */
const resolveStore = (storage?: ConflictKeyValueStore | null): ConflictKeyValueStore => {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage as unknown as ConflictKeyValueStore;
  } catch {
    /* 访问 localStorage 本身抛错（Safari 隐私模式）时走兜底 */
  }
  return memoryFallback;
};

/** UTF-8 字节数（与 Worker 端 TextEncoder 口径一致） */
const byteLength = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 3;
  }
};

/* ============================================================
   类型
   ============================================================ */

/** 受控快照：只保留可读摘要，不保存原始长文本 */
export type ConflictSnapshot = {
  /** 人类可读标题：工作空间名 / 笔记标题 / 偏好设置 */
  label: string;
  /** 截断后的预览文本（≤ 800 字符） */
  preview: string;
  updatedAt: number;
  /** 少量标量字段摘要，便于界面提示「哪里不同」 */
  fields?: Record<string, string | number | boolean>;
};

export type SyncConflict = {
  id: string;
  domain: string;
  entityId: string;
  localRevision: number;
  serverRevision: number;
  localUpdatedAt: number;
  serverUpdatedAt: number;
  detectedAt: number;
  state: "open" | "resolved";
  resolvedAt?: number;
  resolvedBy?: "local" | "remote";
  localSnapshot?: ConflictSnapshot;
  serverSnapshot?: ConflictSnapshot;
};

type PersistedShape = { v: 1; at: number; items: SyncConflict[] };

type ConflictOptions = { storage?: ConflictKeyValueStore | null; now?: number };

/* ============================================================
   受控快照
   ============================================================ */

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const SENSITIVE_KEY = /(token|secret|password|passwd|session|cookie|auth|private)/i;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/**
 * 把任意本地/远端实体压成可控快照：
 *   - 只取标量字段，递归对象不展开；
 *   - 长字符串截断（笔记全文只留开头）；
 *   - token / session 等字段值直接隐藏；
 *   - 序列化后仍超过 4KB 时逐步缩短预览，绝不写入完整正文。
 */
export function sanitizeConflictSnapshot(
  raw: unknown,
  fallback: { label?: string; updatedAt?: number } = {},
): ConflictSnapshot | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === "string") {
    const preview = clip(collapse(raw), MAX_PREVIEW_CHARS);
    return {
      label: clip(collapse(fallback.label ?? "文本"), MAX_LABEL_CHARS),
      preview,
      updatedAt: fallback.updatedAt ?? 0,
    };
  }

  if (typeof raw !== "object") {
    return {
      label: clip(collapse(fallback.label ?? "值"), MAX_LABEL_CHARS),
      preview: clip(String(raw), MAX_PREVIEW_CHARS),
      updatedAt: fallback.updatedAt ?? 0,
    };
  }

  const source = raw as Record<string, unknown>;
  const fields: Record<string, string | number | boolean> = {};
  const previewParts: string[] = [];
  // 对象自身的可读标题优先；fallback 只是「实体 id」兜底，不能盖过快照里的名字
  let label = "";
  let updatedAt = Number(fallback.updatedAt) || 0;

  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    if (value === null || value === undefined) continue;

    if (typeof value === "string") {
      if (!label && /^(name|title|label)$/i.test(key)) label = collapse(value);
      if (SENSITIVE_KEY.test(key)) {
        fields[key] = "[已隐藏]";
        continue;
      }
      const text = collapse(value);
      if (previewParts.length < 3) previewParts.push(`${key}: ${clip(text, MAX_FIELD_CHARS)}`);
      fields[key] = clip(text, MAX_FIELD_CHARS);
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
      if (!updatedAt && /updatedAt|at$/i.test(key) && Number.isFinite(Number(value))) {
        updatedAt = Number(value) || updatedAt;
      }
      continue;
    }

    // 数组只记录长度；对象只记录键数（不展开，避免把整份笔记塞进冲突记录）
    if (Array.isArray(value)) {
      fields[`${key}.length`] = value.length;
      continue;
    }
    if (typeof value === "object") {
      fields[`${key}.keys`] = Object.keys(value as Record<string, unknown>).length;
    }
  }

  const snapshot: ConflictSnapshot = {
    label:
      clip(
        collapse(label || String(source.name ?? source.title ?? fallback.label ?? source.id ?? "实体")),
        MAX_LABEL_CHARS,
      ) || "实体",
    preview: clip(previewParts.join(" · ") || "（无文本预览）", MAX_PREVIEW_CHARS),
    updatedAt,
    ...(Object.keys(fields).length ? { fields } : {}),
  };

  // 预算兜底：4KB 以内（理论上很小，防御异常超长字段）
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    if (byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES) return snapshot;
    snapshot.preview = clip(snapshot.preview.slice(0, Math.floor(snapshot.preview.length / 2)), MAX_PREVIEW_CHARS);
    if (!snapshot.preview) {
      delete snapshot.fields;
      snapshot.preview = "（预览已省略）";
      return snapshot;
    }
  }
  return snapshot;
}

/* ============================================================
   持久化
   ============================================================ */

const parseItems = (text: string | null): SyncConflict[] => {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    const direct = Array.isArray(record.items) ? record.items : null;
    // 兼容 StorageManager 写入的 { v, at, data: { items } } 信封
    const viaEnvelope =
      !direct && record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>).items
        : null;
    const items = direct ?? (Array.isArray(viaEnvelope) ? viaEnvelope : []);
    return items.filter((item): item is SyncConflict => {
      if (!item || typeof item !== "object") return false;
      const conflict = item as Partial<SyncConflict>;
      return (
        typeof conflict.id === "string" &&
        typeof conflict.domain === "string" &&
        typeof conflict.entityId === "string" &&
        (conflict.state === "open" || conflict.state === "resolved")
      );
    });
  } catch {
    return [];
  }
};

const isExpired = (conflict: SyncConflict, now: number): boolean =>
  !Number.isFinite(conflict.detectedAt) || now - conflict.detectedAt > CONFLICT_TTL_MS;

const sortNewestFirst = (list: SyncConflict[]): SyncConflict[] =>
  list
    .slice()
    .sort((left, right) => (right.detectedAt || 0) - (left.detectedAt || 0) || left.id.localeCompare(right.id));

/** 读取全部记录（含已解决）；TTL 过期项在读取时过滤，写回时淘汰 */
const readAll = (options: ConflictOptions = {}): SyncConflict[] => {
  const store = resolveStore(options.storage);
  const now = options.now ?? Date.now();
  return sortNewestFirst(parseItems(store.getItem(CONFLICTS_KEY)).filter((item) => !isExpired(item, now)));
};

const writeAll = (items: SyncConflict[], options: ConflictOptions = {}): void => {
  const store = resolveStore(options.storage);
  const now = options.now ?? Date.now();
  // TTL + 上限在这里统一收敛，保证任何写入路径都不会让记录无限增长
  const live = sortNewestFirst(items.filter((item) => !isExpired(item, now))).slice(0, MAX_CONFLICTS);
  const payload: PersistedShape = { v: 1, at: now, items: live };
  try {
    store.setItem(CONFLICTS_KEY, JSON.stringify(payload));
  } catch {
    /* 配额满 / 隐私模式：冲突记录不是关键路径，静默失败 */
  }
};

/* ============================================================
   对外 API
   ============================================================ */

export type ConflictQuery = ConflictOptions & {
  domain?: string;
  /** 默认只返回未解决（open）的记录 */
  includeResolved?: boolean;
};

/** 列出冲突：默认只返回待处理项，按发现时间倒序 */
export function listConflicts(query: ConflictQuery = {}): SyncConflict[] {
  return readAll(query)
    .filter((item) => (query.domain ? item.domain === query.domain : true))
    .filter((item) => (query.includeResolved ? true : item.state === "open"))
    .map((item) => ({ ...item }));
}

export function getConflict(id: string, options: ConflictOptions = {}): SyncConflict | null {
  const found = readAll(options).find((item) => item.id === id);
  return found ? { ...found } : null;
}

export type RecordConflictInput = {
  domain: string;
  entityId: string;
  localRevision: number;
  serverRevision: number;
  localUpdatedAt: number;
  serverUpdatedAt: number;
  detectedAt?: number;
  /** 原始快照：内部会做受控裁剪，调用方不需要自己截断 */
  localSnapshot?: unknown;
  serverSnapshot?: unknown;
};

/**
 * 记录一次冲突。同一实体只保留一条记录（按 `${domain}:${entityId}` 去重）：
 * 再次冲突时更新版本号与快照，并重新置为 open（上一次的解决结果作废）。
 */
export function recordConflict(input: RecordConflictInput, options: ConflictOptions = {}): SyncConflict {
  const now = options.now ?? Date.now();
  const domain = String(input.domain ?? "").trim().slice(0, 64) || "unknown";
  const entityId = String(input.entityId ?? "").trim().slice(0, 128) || "unknown";
  const id = `${domain}:${entityId}`;
  const items = readAll(options);
  const existing = items.find((item) => item.id === id);

  const localSnapshot =
    sanitizeConflictSnapshot(input.localSnapshot, { label: entityId, updatedAt: input.localUpdatedAt }) ??
    existing?.localSnapshot;
  const serverSnapshot =
    sanitizeConflictSnapshot(input.serverSnapshot, { label: entityId, updatedAt: input.serverUpdatedAt }) ??
    existing?.serverSnapshot;

  const conflict: SyncConflict = {
    id,
    domain,
    entityId,
    localRevision: Math.max(0, Math.trunc(Number(input.localRevision) || 0)),
    serverRevision: Math.max(0, Math.trunc(Number(input.serverRevision) || 0)),
    localUpdatedAt: Math.max(0, Math.trunc(Number(input.localUpdatedAt) || 0)),
    serverUpdatedAt: Math.max(0, Math.trunc(Number(input.serverUpdatedAt) || 0)),
    detectedAt: Math.max(0, Math.trunc(Number(input.detectedAt ?? now) || now)),
    state: "open",
    ...(localSnapshot ? { localSnapshot } : {}),
    ...(serverSnapshot ? { serverSnapshot } : {}),
  };

  writeAll([...items.filter((item) => item.id !== id), conflict], options);
  return { ...conflict };
}

/**
 * 标记冲突已解决。重复调用是幂等的（已解决时原样返回，不刷新 resolvedAt）。
 */
export function markConflictResolved(
  id: string,
  resolvedBy: "local" | "remote",
  options: ConflictOptions = {},
): SyncConflict | null {
  const now = options.now ?? Date.now();
  const items = readAll(options);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const current = items[index];
  if (current.state === "resolved") return { ...current };

  const resolved: SyncConflict = {
    ...current,
    state: "resolved",
    resolvedAt: now,
    resolvedBy: resolvedBy === "local" ? "local" : "remote",
  };
  items[index] = resolved;
  writeAll(items, options);
  return { ...resolved };
}

export type ClearConflictOptions = ConflictOptions & { id?: string; domain?: string };

/** 清理冲突记录：不传 id/domain 时清空全部；返回删除条数 */
export function clearConflicts(options: ClearConflictOptions = {}): number {
  const items = readAll(options);
  const kept = items.filter((item) => {
    if (options.id) return item.id !== options.id;
    if (options.domain) return item.domain !== options.domain;
    return false;
  });
  const removed = items.length - kept.length;
  if (removed > 0) writeAll(kept, options);
  return removed;
}

export type ConflictStats = {
  total: number;
  open: number;
  resolved: number;
  byDomain: Record<string, number>;
};

export function conflictStats(options: ConflictOptions = {}): ConflictStats {
  const items = readAll(options);
  const byDomain: Record<string, number> = {};
  let open = 0;
  let resolved = 0;
  for (const item of items) {
    byDomain[item.domain] = (byDomain[item.domain] ?? 0) + 1;
    if (item.state === "open") open += 1;
    else resolved += 1;
  }
  return { total: items.length, open, resolved, byDomain };
}
