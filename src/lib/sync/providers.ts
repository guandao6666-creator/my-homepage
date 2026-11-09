/**
 * Guandao OS 2.0 · 同步数据域适配器
 *
 * 把 Notes / Tasks / Calendar 三个本地存储接到 SyncEngine 上：
 *
 *   本地快照（含墓碑） ──► /api/sync/index 对比 ──► push / pull
 *        ▲                                           │
 *        └────────── applySync（写回同一个 KEY）◄────┘
 *
 * 关键约束：
 *   - 只读写各自 1.4 的存储键，不复制数据模型；
 *   - 删除靠墓碑传播（见 tombstones.ts），否则另一端会把旧数据复活；
 *   - revision 由服务端单调递增，客户端在本地记住「上次看到的 revision」，
 *     推送时带上做乐观锁；冲突时服务端版本优先落回本地，避免来回覆盖；
 *   - 三个应用模块用**动态 import**：不能因为接同步而把它们打进首屏，
 *     否则 1.9 的按需加载（首屏 JS −48%）会被这层适配器抵消。
 */

import type { Kernel } from "../core/kernel";
import type { SyncItem, SyncProvider } from "../core/sync";
import { clearTombstones, readTombstones, tombstoneStats } from "./tombstones";

export type SyncDomainId = "notes" | "tasks" | "calendar";

const DOMAIN_LABEL: Record<SyncDomainId, string> = {
  notes: "Notes",
  tasks: "Tasks",
  calendar: "Calendar",
};

type Adapter = {
  domain: SyncDomainId;
  readLocal: () => Array<{ id: string; updatedAt: number; payload: unknown }>;
  applyRemote: (
    items: Array<{ id: string; updatedAt: number; deleted: boolean; payload?: unknown }>,
  ) => { applied: number; removed: number };
};

type SyncCapableStore = {
  syncItems: () => Array<{ id: string; updatedAt: number; payload: unknown }>;
  applySync: (
    items: Array<{ id: string; updatedAt: number; deleted: boolean; payload?: unknown }>,
  ) => { applied: number; removed: number };
};

let adaptersPromise: Promise<Adapter[]> | null = null;

/** 懒加载三个数据模块；只在真正同步时下载，不影响首屏 */
async function loadAdapters(): Promise<Adapter[]> {
  if (!adaptersPromise) {
    adaptersPromise = Promise.all([
      import("../os14/apps/notes"),
      import("../os14/tasks-store"),
      import("../os14/apps/calendar"),
    ]).then(([notes, tasks, calendar]) => [
      {
        domain: "notes",
        readLocal: () => notes.notesStore.syncItems(),
        applyRemote: (items) => (notes.notesStore as unknown as SyncCapableStore).applySync(items),
      },
      {
        domain: "tasks",
        readLocal: () => tasks.taskStore.syncItems(),
        applyRemote: (items) => (tasks.taskStore as unknown as SyncCapableStore).applySync(items),
      },
      {
        domain: "calendar",
        readLocal: () => calendar.calendarStore.syncItems(),
        applyRemote: (items) =>
          (calendar.calendarStore as unknown as SyncCapableStore).applySync(items),
      },
    ]);
    adaptersPromise = adaptersPromise.catch((error) => {
      adaptersPromise = null;
      throw error;
    });
  }
  return adaptersPromise;
}

async function adapterFor(domain: SyncDomainId): Promise<Adapter> {
  const adapters = await loadAdapters();
  const adapter = adapters.find((item) => item.domain === domain);
  if (!adapter) throw new Error(`同步数据域不可用：${domain}`);
  return adapter;
}

type FetchLike = typeof fetch;

export type SyncRegistration = {
  domains: SyncDomainId[];
  dispose: () => void;
  /** 立即同步（系统设置 / 网络恢复时调用） */
  syncNow: (domain?: SyncDomainId) => Promise<void>;
};

class SyncApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
  }
}

async function callApi<T>(doFetch: FetchLike, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  const response = await doFetch(path, { ...init, headers, credentials: "same-origin" });
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok) {
    throw new SyncApiError(
      payload?.error?.message || `同步请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return (payload?.data ?? ({} as T)) as T;
}

const revisionKey = (domain: SyncDomainId) => `sync.revisions.${domain}`;

/**
 * 创建单个数据域的 Provider。
 * 客户端只需要实现「读本地 / 读索引 / 推送 / 拉取 / 应用」。
 */
export function createProvider(
  domain: SyncDomainId,
  kernel: Kernel,
  doFetch: FetchLike = (...args) => fetch(...args),
): SyncProvider {
  const readRevisions = (): Record<string, number> =>
    kernel.storage.read<Record<string, number>>(revisionKey(domain), {});
  const writeRevisions = (next: Record<string, number>) => {
    kernel.storage.write(revisionKey(domain), next);
  };

  return {
    id: domain,
    label: DOMAIN_LABEL[domain],

    readLocal: async (): Promise<SyncItem[]> => {
      const adapter = await adapterFor(domain);
      const live: SyncItem[] = adapter.readLocal().map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt,
        payload: item.payload,
      }));
      const tombstones = readTombstones(domain);
      const deleted: SyncItem[] = Object.entries(tombstones).map(([id, at]) => ({
        id,
        updatedAt: at,
        deleted: true,
      }));
      return [...live, ...deleted];
    },

    readRemote: async () => {
      const data = await callApi<{
        entities: Array<{ id: string; revision: number; deleted: boolean; updatedAt: number }>;
        truncated?: boolean;
      }>(doFetch, `/api/sync/index?domain=${domain}`);

      if (data.truncated) {
        throw new Error("云端记录过多（超过 10000 条），请先在系统设置里清理或分批迁移");
      }

      // 索引里的 revision 作为下一次推送的基线
      const revisions = readRevisions();
      for (const entity of data.entities ?? []) revisions[entity.id] = entity.revision;
      writeRevisions(revisions);

      return (data.entities ?? []).map((entity) => ({
        id: entity.id,
        updatedAt: entity.updatedAt,
        deleted: entity.deleted,
      }));
    },

    push: async (items) => {
      const adapter = await adapterFor(domain);
      const revisions = readRevisions();
      const changes = items.map((item) => ({
        id: item.id,
        baseRevision: revisions[item.id] ?? 0,
        deleted: Boolean(item.deleted),
        updatedAt: item.updatedAt,
        payload: item.deleted ? null : (item.payload ?? null),
      }));

      const result = await callApi<{
        applied: Array<{ id: string; revision: number; updatedAt: number }>;
        conflicts: Array<{
          id: string;
          revision: number;
          updatedAt: number;
          deleted: boolean;
          payload?: unknown;
        }>;
      }>(doFetch, "/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ domain, changes }),
      });

      for (const entity of result.applied ?? []) revisions[entity.id] = entity.revision;
      writeRevisions(revisions);

      // 推送成功的墓碑可以清掉；没成功（冲突）的保留，等合并后重试
      const conflictIds = new Set((result.conflicts ?? []).map((entity) => entity.id));
      const pushedTombstones = changes
        .filter((change) => change.deleted && !conflictIds.has(change.id))
        .map((change) => change.id);
      if (pushedTombstones.length) clearTombstones(domain, pushedTombstones);

      // 冲突时服务端版本优先落回本地，避免两端来回覆盖
      if (result.conflicts?.length) {
        adapter.applyRemote(
          result.conflicts.map((entity) => ({
            id: entity.id,
            updatedAt: entity.updatedAt,
            deleted: entity.deleted,
            payload: entity.payload,
          })),
        );
        for (const entity of result.conflicts) revisions[entity.id] = entity.revision;
        writeRevisions(revisions);
      }

      return { conflicts: result.conflicts?.length ?? 0 };
    },

    pull: async (ids) => {
      if (!ids.length) return [];
      const query = ids.slice(0, 200).map((id) => encodeURIComponent(id)).join(",");
      const data = await callApi<{
        changes: Array<{
          id: string;
          revision: number;
          deleted: boolean;
          updatedAt: number;
          payload?: unknown;
        }>;
      }>(doFetch, `/api/sync/pull?domain=${domain}&ids=${query}`);

      const revisions = readRevisions();
      for (const entity of data.changes ?? []) revisions[entity.id] = entity.revision;
      writeRevisions(revisions);

      return (data.changes ?? []).map((entity) => ({
        id: entity.id,
        updatedAt: entity.updatedAt,
        deleted: entity.deleted,
        ...(entity.deleted ? {} : { payload: entity.payload }),
      }));
    },

    apply: async (items) => {
      const adapter = await adapterFor(domain);
      adapter.applyRemote(
        items.map((item) => ({
          id: item.id,
          updatedAt: item.updatedAt,
          deleted: Boolean(item.deleted),
          payload: item.payload,
        })),
      );
      // 远端删除落本地后，本地对应的墓碑也没有意义了
      const deletedIds = items.filter((item) => item.deleted).map((item) => item.id);
      if (deletedIds.length) clearTombstones(domain, deletedIds);
    },
  };
}

/**
 * 注册三个数据域。重复调用会先销毁上一次的注册，避免重复同步。
 * 只在 Cloud Mode 且已登录时调用。
 */
export function registerSyncProviders(
  kernel: Kernel,
  options: { fetch?: FetchLike } = {},
): SyncRegistration {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const registered: SyncDomainId[] = [];

  for (const domain of ["notes", "tasks", "calendar"] as SyncDomainId[]) {
    try {
      kernel.sync.register(createProvider(domain, kernel, doFetch));
      registered.push(domain);
    } catch {
      /* 已经注册过（重复调用）时跳过，下面统一重置 */
    }
  }

  const syncNow = async (domain?: SyncDomainId) => {
    const domains = domain ? [domain] : registered;
    for (const id of domains) {
      try {
        await kernel.sync.sync(id);
      } catch {
        /* 单个域失败已在引擎里记录，不阻断其他域 */
      }
    }
    kernel.cloud.reportPending(kernel.sync.pendingCount());
  };

  return {
    domains: registered,
    syncNow,
    dispose: () => {
      for (const id of registered) kernel.sync.unregister(id);
      kernel.cloud.reportPending(0);
    },
  };
}

/** 系统设置用：本地墓碑数量（诊断「删除是否还在排队」） */
export const localTombstones = tombstoneStats;

export { DOMAIN_LABEL, SyncApiError };