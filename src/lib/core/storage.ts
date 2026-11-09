/**
 * Guandao OS 2.0 · 存储管理器
 *
 * 1.x 的 localStorage 读写散落在十几个模块里，键名格式、版本号、配额判断各不相同。
 * 2.0 起，Core 拥有一个带命名空间与版本信封的存储层：
 *
 *   guandao.core.<scope>.<key>  →  { v: 2, at: <时间戳>, data: <内容> }
 *
 * 约束（很重要）：
 *   - **不迁移、不重写 1.x 的旧键**。旧键继续由各自的模块读写，2.0 只读取需要的部分；
 *   - 写入失败（隐私模式 / 配额满）返回 false，由调用方决定如何提示，不抛异常；
 *   - 提供 `legacy` 只读视图，便于迁移脚本读取旧键而不修改它们；
 *   - IndexedDB 仍复用 `os14/core.ts` 的 idb，这里只做键值存储；
 *   - 不依赖 DOM，可在 Node 里用内存实现单测。
 */

export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};

export type StoredEnvelope<T> = {
  v: number;
  at: number;
  data: T;
};

/** 内存实现：单测与「存储不可用」降级都走这里 */
export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.map.set(key, value);
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  get length(): number {
    return this.map.size;
  }

  /** 测试辅助：导出全部内容 */
  dump(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/**
 * 浏览器 localStorage 的包装。
 * Safari 隐私模式 / 存储被禁用时 localStorage 访问会直接抛错，
 * 所以这里探测一次，失败就退化为 null（调用方用内存兜底）。
 */
export const browserStore = (): KeyValueStore | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__guandao_core_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
      key: (index) => localStorage.key(index),
      get length() {
        return localStorage.length;
      },
    };
  } catch {
    return null;
  }
};

const utf16Bytes = (text: string) => text.length * 2;

export type StorageManagerOptions = {
  /** 默认 guandao.core */
  namespace?: string;
  store?: KeyValueStore | null;
  /** 版本号，写进信封；读取时版本不一致会触发 migrate 回调 */
  version?: number;
  /** 软配额（字节）；超过后拒绝新增写入并给出原因 */
  quotaBytes?: number;
  /** 写失败 / 解析失败等非致命问题 */
  onWarn?: (info: { key: string; message: string }) => void;
};

export type WriteResult = { ok: boolean; reason?: "quota" | "unavailable" | "error" };

export class StorageManager {
  readonly namespace: string;
  private store: KeyValueStore | null;
  private version: number;
  private quotaBytes: number;
  private onWarn: (info: { key: string; message: string }) => void;
  private memoryFallback = new MemoryStore();

  constructor(options: StorageManagerOptions = {}) {
    this.namespace = options.namespace ?? "guandao.core";
    this.store = options.store === undefined ? browserStore() : options.store;
    this.version = options.version ?? 2;
    this.quotaBytes = options.quotaBytes ?? 4.5 * 1024 * 1024;
    this.onWarn = options.onWarn ?? (() => undefined);
  }

  /** 存储是否真的可用（隐私模式下为 false） */
  get available(): boolean {
    return this.store !== null;
  }

  get activeStore(): KeyValueStore {
    return this.store ?? this.memoryFallback;
  }

  fullKey(key: string): string {
    return `${this.namespace}.${key}`;
  }

  read<T>(key: string, fallback: T): T {
    const full = this.fullKey(key);
    try {
      const raw = this.activeStore.getItem(full);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw) as unknown;
      // 兼容两种写入形态：带信封的新格式，以及早期直接存裸 JSON 的格式
      if (parsed && typeof parsed === "object" && "data" in parsed && "v" in parsed) {
        const envelope = parsed as StoredEnvelope<T>;
        if (Number(envelope.v) !== this.version) {
          this.onWarn({
            key: full,
            message: `版本 ${envelope.v} 与当前 ${this.version} 不一致，已按新格式读取`,
          });
        }
        return envelope.data;
      }
      return parsed as T;
    } catch (error) {
      this.onWarn({ key: full, message: `读取失败：${(error as Error)?.message ?? "未知错误"}` });
      return fallback;
    }
  }

  write<T>(key: string, data: T, opts: { allowOverwrite?: boolean } = {}): WriteResult {
    if (this.store === null && typeof localStorage !== "undefined") {
      // 有 DOM 但 localStorage 不可用：退化为会话内内存存储，并明确告知调用方
      this.memoryFallback.setItem(this.fullKey(key), this.serialize(data));
      return { ok: false, reason: "unavailable" };
    }
    const full = this.fullKey(key);
    const serialized = this.serialize(data);
    if (!opts.allowOverwrite) {
      const used = this.bytes();
      const existing = this.activeStore.getItem(full)?.length ?? 0;
      if (used - existing * 2 + utf16Bytes(serialized) > this.quotaBytes) {
        this.onWarn({ key: full, message: "超过本地存储软配额，已拒绝写入" });
        return { ok: false, reason: "quota" };
      }
    }
    try {
      this.activeStore.setItem(full, serialized);
      return { ok: true };
    } catch (error) {
      this.onWarn({ key: full, message: `写入失败：${(error as Error)?.message ?? "未知错误"}` });
      return { ok: false, reason: "error" };
    }
  }

  remove(key: string): void {
    try {
      this.activeStore.removeItem(this.fullKey(key));
    } catch {
      /* 忽略 */
    }
  }

  /** 某个命名空间下自己的键（不含前缀） */
  keys(): string[] {
    const store = this.activeStore;
    const prefix = `${this.namespace}.`;
    const out: string[] = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.startsWith(prefix)) out.push(key.slice(prefix.length));
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  /** 粗略占用（UTF-16 近似值，界面需要标注为估算） */
  bytes(prefix = this.namespace): number {
    const store = this.activeStore;
    let total = 0;
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        total += (key.length + (store.getItem(key)?.length ?? 0)) * 2;
      }
    } catch {
      /* 忽略 */
    }
    return total;
  }

  /** 清空本命名空间（迁移失败时的回滚由迁移引擎自己负责） */
  clear(): number {
    const keys = this.keys();
    for (const key of keys) this.remove(key);
    return keys.length;
  }

  /**
   * 1.x 旧键的只读访问：迁移脚本用它读取旧数据，绝不改写。
   * 注意前缀默认是 `guandao.`，与 2.0 的 `guandao.core.` 区分开。
   */
  legacyStr(key: string): string | null {
    try {
      return this.activeStore.getItem(key);
    } catch {
      return null;
    }
  }

  legacyKeys(prefix = "guandao."): string[] {
    const store = this.activeStore;
    const out: string[] = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.startsWith(prefix) && !key.startsWith(`${this.namespace}.`)) out.push(key);
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  private serialize<T>(data: T): string {
    const envelope: StoredEnvelope<T> = { v: this.version, at: Date.now(), data };
    return JSON.stringify(envelope);
  }
}

export const createStorage = (options?: StorageManagerOptions) => new StorageManager(options);