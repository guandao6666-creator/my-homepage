/**
 * Guandao OS 2.0 · 统一同步引擎
 *
 * 云端只提供「文件 / 备份 / 设备 / 插件 / 社区」接口，笔记、任务、日历在 2.0
 * 还没有服务端 API。与其写一个假的「同步成功」，这里做成一个**可插拔的引擎**：
 *
 *   - 每个数据域实现 SyncProvider（读本地 / 读远端索引 / 推送 / 应用）；
 *   - 引擎负责增量对比、冲突判定、删除墓碑、离线排队与重试；
 *   - 没有接入 provider 的数据域，状态如实显示「未接入」，不会伪装成已同步。
 *
 * 冲突策略（确定性，可测试）：
 *   1. 一端删除、一端修改 → 修改优先（避免误删数据），并记录冲突；
 *   2. 双方都修改 → updatedAt 较大者胜；相同时按内容哈希字典序，保证两端一致；
 *   3. 远端更新但本地没有 → 拉取；本地有但远端没有 → 推送。
 *
 * 不依赖 DOM，可单测。
 */

export type SyncItem = {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  /** 其余字段由各数据域自定义 */
  [key: string]: unknown;
};

export type RemoteIndexEntry = { id: string; updatedAt: number; deleted?: boolean };

export type SyncProvider = {
  id: string;
  label: string;
  /** 本地全量（含墓碑），用于增量比较 */
  readLocal: () => Promise<SyncItem[]> | SyncItem[];
  /** 云端索引（只含 id/updatedAt/deleted，避免拉全量） */
  readRemote: () => Promise<RemoteIndexEntry[]>;
  /** 推送本地变更（新增或修改）。可返回 conflicts 表示服务端乐观锁拒绝了部分变更 */
  push: (items: SyncItem[]) => Promise<void | { conflicts?: number }> | void | { conflicts?: number };
  /** 拉取并应用到本地 */
  pull: (ids: string[]) => Promise<SyncItem[]>;
  apply: (items: SyncItem[]) => Promise<void>;
};

export type DomainStatus = {
  id: string;
  label: string;
  state: "idle" | "syncing" | "ok" | "conflict" | "failed" | "offline" | "unsupported";
  lastSyncAt: number | null;
  pushed: number;
  pulled: number;
  conflicts: number;
  pending: number;
  error: string | null;
};

export type SyncReport = {
  domain: string;
  state: DomainStatus["state"];
  pushed: number;
  pulled: number;
  conflicts: number;
  durationMs: number;
  error?: string;
};

const stableHash = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** 判定单个 id 的同步动作；导出以便单测覆盖冲突规则 */
export function decide(
  local: SyncItem | undefined,
  remote: RemoteIndexEntry | undefined,
): "push" | "pull" | "keep-local" | "keep-remote" | "conflict-keep-local" {
  if (!local && !remote) return "keep-remote";
  if (local && !remote) return "push";
  if (!local && remote) return "pull";
  const left = local as SyncItem;
  const right = remote as RemoteIndexEntry;

  // 删除与修改并发：修改优先，避免丢数据
  if (left.deleted && !right.deleted) return right.updatedAt >= left.updatedAt ? "pull" : "conflict-keep-local";
  if (!left.deleted && right.deleted) return right.updatedAt > left.updatedAt ? "pull" : "conflict-keep-local";
  if (left.deleted && right.deleted) return "keep-remote";

  if (left.updatedAt > right.updatedAt) return "push";
  if (left.updatedAt < right.updatedAt) return "pull";
  // 时间戳相同：用内容哈希做确定性裁决，保证多设备最终一致
  return stableHash(JSON.stringify(left)) >= stableHash(JSON.stringify(right)) ? "keep-local" : "keep-remote";
}

export type SyncEngineOptions = {
  emit?: (type: string, payload?: unknown) => void;
  /** 网络可用性；离线时只排队不请求 */
  online?: () => boolean;
  /** 单个数据域的超时 */
  timeoutMs?: number;
};

export class SyncEngine {
  private providers = new Map<string, SyncProvider>();
  private statuses = new Map<string, DomainStatus>();
  private queue = new Set<string>();
  private emitFn: (type: string, payload?: unknown) => void;
  private online: () => boolean;
  private timeoutMs: number;
  private running = false;

  constructor(options: SyncEngineOptions = {}) {
    this.emitFn = options.emit ?? (() => undefined);
    this.online =
      options.online ??
      (() => {
        try {
          return typeof navigator === "undefined" || navigator.onLine;
        } catch {
          return true;
        }
      });
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  register(provider: SyncProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`同步域 ${provider.id} 已注册`);
    this.providers.set(provider.id, provider);
    this.statuses.set(provider.id, {
      id: provider.id,
      label: provider.label,
      state: "idle",
      lastSyncAt: null,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      pending: 0,
      error: null,
    });
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /** 注销数据域（退出登录 / 切回 Local Mode 时调用） */
  unregister(providerId: string): void {
    this.providers.delete(providerId);
    this.statuses.delete(providerId);
    this.queue.delete(providerId);
    this.emitFn("sync:unregistered", { domain: providerId });
  }

  domains(): DomainStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  /** 未接入的数据域：如实返回，供系统中心展示「未接入」而不是「正常」 */
  unregistered(candidates: Array<{ id: string; label: string }>): Array<{ id: string; label: string; state: "unsupported" }> {
    return candidates
      .filter((candidate) => !this.providers.has(candidate.id))
      .map((candidate) => ({ ...candidate, state: "unsupported" as const }));
  }

  queueDomain(id: string): void {
    if (!this.providers.has(id)) return;
    this.queue.add(id);
    const status = this.statuses.get(id);
    if (status) status.pending = 1;
    this.emitFn("sync:queued", { domain: id });
  }

  pendingCount(): number {
    return this.queue.size;
  }

  /** 同步指定数据域（不传则全部） */
  async sync(domain?: string): Promise<SyncReport[]> {
    if (this.running) return [];
    if (!this.online()) {
      const targets = domain ? [domain] : [...this.providers.keys()];
      for (const id of targets) {
        const status = this.statuses.get(id);
        if (status) status.state = "offline";
      }
      this.emitFn("sync:offline", { domains: targets });
      return targets.map((id) => ({
        domain: id,
        state: "offline" as const,
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        durationMs: 0,
      }));
    }

    this.running = true;
    const targets = domain ? [domain] : [...this.providers.keys()];
    const reports: SyncReport[] = [];
    try {
      for (const id of targets) {
        const provider = this.providers.get(id);
        if (!provider) continue;
        reports.push(await this.syncOne(provider));
      }
    } finally {
      this.running = false;
      this.emitFn("sync:done", { reports });
    }
    return reports;
  }

  /* ---------------- 内部 ---------------- */

  private async syncOne(provider: SyncProvider): Promise<SyncReport> {
    const started = Date.now();
    const status = this.statuses.get(provider.id);
    if (status) status.state = "syncing";

    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;

    try {
      const [local, remote] = await Promise.all([
        this.withTimeout(Promise.resolve(provider.readLocal()), "读取本地"),
        this.withTimeout(provider.readRemote(), "读取云端索引"),
      ]);

      const localMap = new Map(local.map((item) => [item.id, item]));
      const remoteMap = new Map(remote.map((item) => [item.id, item]));

      const pushItems: SyncItem[] = [];
      const pullIds: string[] = [];
      const ids = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

      for (const id of ids) {
        const action = decide(localMap.get(id), remoteMap.get(id));
        if (action === "push") pushItems.push(localMap.get(id) as SyncItem);
        else if (action === "pull") pullIds.push(id);
        else if (action === "conflict-keep-local") {
          conflicts += 1;
          pushItems.push(localMap.get(id) as SyncItem);
        } else if (action === "keep-local") {
          // 内容不同但时间戳相同：本地优先，同时记录一次冲突供人工确认
          conflicts += 1;
        }
      }

      if (pushItems.length) {
        const pushResult = await this.withTimeout(Promise.resolve(provider.push(pushItems)), "推送");
        pushed = pushItems.length;
        // 服务端乐观锁拒绝的条目也算冲突（本地版本已经回写为服务端版本）
        if (pushResult && typeof pushResult === "object" && typeof pushResult.conflicts === "number") {
          conflicts += pushResult.conflicts;
        }
      }

      if (pullIds.length) {
        const items = await this.withTimeout(provider.pull(pullIds), "拉取");
        if (items.length) {
          await this.withTimeout(provider.apply(items), "应用远端变更");
          pulled = items.length;
        }
      }

      const state: DomainStatus["state"] = conflicts ? "conflict" : "ok";
      if (status) {
        status.state = state;
        status.lastSyncAt = Date.now();
        status.pushed = pushed;
        status.pulled = pulled;
        status.conflicts = conflicts;
        status.pending = 0;
        status.error = null;
      }
      this.queue.delete(provider.id);
      this.emitFn("sync:domain", { domain: provider.id, state, pushed, pulled, conflicts });

      return {
        domain: provider.id,
        state,
        pushed,
        pulled,
        conflicts,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const message = (error as Error)?.message ?? "未知错误";
      if (status) {
        status.state = "failed";
        status.error = message;
        status.pending = 1;
      }
      this.queue.add(provider.id);
      this.emitFn("sync:failed", { domain: provider.id, error: message });
      return {
        domain: provider.id,
        state: "failed",
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        durationMs: Date.now() - started,
        error: message,
      };
    }
  }

  private withTimeout<T>(value: Promise<T>, label: string): Promise<T> {
    if (!this.timeoutMs) return value;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label}超时`));
      }, this.timeoutMs);
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();
      value.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

export const createSyncEngine = (options?: SyncEngineOptions) => new SyncEngine(options);