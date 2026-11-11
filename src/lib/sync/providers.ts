/**
 * Guandao OS 2.0 · 同步数据域适配器
 *
 * 把 Notes / Tasks / Calendar / Workspace / Preferences 五个本地存储接到 SyncEngine：
 *
 *   本地快照（含墓碑） ──► /api/sync/index 对比 ──► push / pull
 *        ▲                                           │
 *        └────────── applySync（写回同一个 KEY）◄────┘
 *
 * 关键约束：
 *   - 只读写各自本地存储键，不复制数据模型；
 *   - 删除靠墓碑传播（notes/tasks/calendar 见 tombstones.ts；workspace 用已知 id 追踪）；
 *   - revision 由服务端单调递增，客户端在本地记住「上次看到的 revision」，
 *     推送时带上做乐观锁；冲突时服务端版本优先落回本地，同时写入冲突记录
 *     （conflicts.ts），供系统中心让用户选择保留本地还是云端；
 *   - 三个应用模块用**动态 import**：不能因为接同步而把它们打进首屏。
 */

import type { Kernel } from "../core/kernel";
import type { SyncItem, SyncProvider } from "../core/sync";
import { clearTombstones, readTombstones, tombstoneStats } from "./tombstones";
import { getConflict, listConflicts, markConflictResolved, recordConflict, type SyncConflict } from "./conflicts";
import {
  applyWorkspaceSyncItem,
  collectWorkspaceSyncItems,
  readWorkspaceSyncItem,
  validateWorkspacePayload,
} from "./workspace";
import {
  applyPreferencesPayload,
  markPreferencesSynced,
  readLocalPreferences,
  validatePreferencesPayload,
} from "./preferences";

export type SyncDomainId = "notes" | "tasks" | "calendar" | "workspace" | "preferences";

/** 复用 1.4 存储 + 墓碑的三域（动态加载模块） */
type StoreDomainId = "notes" | "tasks" | "calendar";

const STORE_DOMAINS: StoreDomainId[] = ["notes", "tasks", "calendar"];
const ALL_DOMAINS: SyncDomainId[] = [...STORE_DOMAINS, "workspace", "preferences"];

const DOMAIN_LABEL: Record<SyncDomainId, string> = {
  notes: "Notes",
  tasks: "Tasks",
  calendar: "Calendar",
  workspace: "Workspace",
  preferences: "Preferences",
};

type Adapter = {
  domain: StoreDomainId;
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

async function adapterFor(domain: StoreDomainId): Promise<Adapter> {
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

const defaultFetch: FetchLike = (...args) => fetch(...args);

const revisionKey = (domain: SyncDomainId) => `sync.revisions.${domain}`;

const readRevisions = (kernel: Kernel, domain: SyncDomainId): Record<string, number> =>
  kernel.storage.read<Record<string, number>>(revisionKey(domain), {});

const writeRevisions = (kernel: Kernel, domain: SyncDomainId, next: Record<string, number>): void => {
  kernel.storage.write(revisionKey(domain), next);
};

type IndexEntity = { id: string; revision: number; deleted: boolean; updatedAt: number };
type PushConflictEntity = IndexEntity & { payload?: unknown };
type PullChange = { id: string; revision: number; deleted: boolean; updatedAt: number; payload?: unknown };

type PushResponse = { applied?: IndexEntity[]; conflicts?: PushConflictEntity[] };

/** 读云端索引，并把 revision 记成本地下次推送的基线 */
async function fetchIndex(
  domain: SyncDomainId,
  kernel: Kernel,
  doFetch: FetchLike,
): Promise<IndexEntity[]> {
  const data = await callApi<{ entities: IndexEntity[]; truncated?: boolean }>(
    doFetch,
    `/api/sync/index?domain=${domain}`,
  );
  if (data.truncated) {
    throw new Error("云端记录过多（超过 10000 条），请先在系统设置里清理或分批迁移");
  }
  const revisions = readRevisions(kernel, domain);
  for (const entity of data.entities ?? []) revisions[entity.id] = entity.revision;
  writeRevisions(kernel, domain, revisions);
  return data.entities ?? [];
}

async function pullChanges(
  domain: SyncDomainId,
  kernel: Kernel,
  doFetch: FetchLike,
  ids: string[],
): Promise<SyncItem[]> {
  if (!ids.length) return [];
  const query = ids.slice(0, 200).map((id) => encodeURIComponent(id)).join(",");
  const data = await callApi<{ changes: PullChange[] }>(
    doFetch,
    `/api/sync/pull?domain=${domain}&ids=${query}`,
  );
  const revisions = readRevisions(kernel, domain);
  for (const entity of data.changes ?? []) revisions[entity.id] = entity.revision;
  writeRevisions(kernel, domain, revisions);
  return (data.changes ?? []).map((entity) => ({
    id: entity.id,
    updatedAt: entity.updatedAt,
    deleted: entity.deleted,
    ...(entity.deleted ? {} : { payload: entity.payload }),
  }));
}

/** 冲突记录统一入口：本地/服务端各留一份受控快照（conflicts.ts 内部裁到 ≤4KB） */
function recordEntityConflict(
  domain: SyncDomainId,
  item: SyncItem,
  server: PushConflictEntity,
  localRevision: number,
): SyncConflict {
  return recordConflict({
    domain,
    entityId: item.id,
    localRevision,
    serverRevision: server.revision,
    localUpdatedAt: item.updatedAt,
    serverUpdatedAt: server.updatedAt,
    localSnapshot: item.deleted ? { deleted: true, updatedAt: item.updatedAt } : (item.payload ?? item),
    serverSnapshot: server.deleted
      ? { deleted: true, updatedAt: server.updatedAt, revision: server.revision }
      : (server.payload ?? { updatedAt: server.updatedAt }),
  });
}

/** 把服务端实体写回本地（冲突回退 / 保留云端时共用） */
async function applyServerEntity(
  domain: SyncDomainId,
  kernel: Kernel,
  entity: { id: string; updatedAt: number; deleted: boolean; payload?: unknown },
): Promise<void> {
  if (domain === "workspace") {
    applyWorkspaceSyncItem(kernel, entity);
    return;
  }
  if (domain === "preferences") {
    if (entity.deleted) return;
    applyPreferencesPayload(kernel.settings, kernel, entity.payload);
    markPreferencesSynced(kernel, entity.updatedAt);
    return;
  }
  const adapter = await adapterFor(domain);
  adapter.applyRemote([
    { id: entity.id, updatedAt: entity.updatedAt, deleted: Boolean(entity.deleted), payload: entity.payload },
  ]);
}

/* ============================================================
   Notes / Tasks / Calendar（复用 1.4 存储 + 墓碑）
   ============================================================ */

function createStoreProvider(
  domain: StoreDomainId,
  kernel: Kernel,
  doFetch: FetchLike,
): SyncProvider {
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

    readRemote: () => fetchIndex(domain, kernel, doFetch),

    push: async (items) => {
      const adapter = await adapterFor(domain);
      const revisions = readRevisions(kernel, domain);
      const baseRevisions = new Map(items.map((item) => [item.id, revisions[item.id] ?? 0]));
      const changes = items.map((item) => ({
        id: item.id,
        baseRevision: revisions[item.id] ?? 0,
        deleted: Boolean(item.deleted),
        updatedAt: item.updatedAt,
        payload: item.deleted ? null : (item.payload ?? null),
      }));

      const result = await callApi<PushResponse>(doFetch, "/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ domain, changes }),
      });

      for (const entity of result.applied ?? []) revisions[entity.id] = entity.revision;
      writeRevisions(kernel, domain, revisions);

      // 推送成功的墓碑可以清掉；没成功（冲突）的保留，等合并后重试
      const conflictIds = new Set((result.conflicts ?? []).map((entity) => entity.id));
      const pushedTombstones = changes
        .filter((change) => change.deleted && !conflictIds.has(change.id))
        .map((change) => change.id);
      if (pushedTombstones.length) clearTombstones(domain, pushedTombstones);

      // 冲突时服务端版本优先落回本地，避免两端来回覆盖；同时记下冲突供人工选择
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
        writeRevisions(kernel, domain, revisions);

        const localMap = new Map(items.map((item) => [item.id, item]));
        for (const entity of result.conflicts) {
          const local = localMap.get(entity.id);
          if (local) recordEntityConflict(domain, local, entity, baseRevisions.get(entity.id) ?? 0);
        }
      }

      return { conflicts: result.conflicts?.length ?? 0 };
    },

    pull: (ids) => pullChanges(domain, kernel, doFetch, ids),

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

/* ============================================================
   Workspace（Phase 4.1：只同步自定义工作空间）
   ============================================================ */

function createWorkspaceProvider(kernel: Kernel, doFetch: FetchLike): SyncProvider {
  return {
    id: "workspace",
    label: DOMAIN_LABEL.workspace,

    readLocal: (): SyncItem[] =>
      collectWorkspaceSyncItems(kernel).map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt,
        deleted: Boolean(item.deleted),
        ...(item.payload ? { payload: item.payload } : {}),
      })),

    readRemote: () => fetchIndex("workspace", kernel, doFetch),

    push: async (items) => {
      const revisions = readRevisions(kernel, "workspace");
      const baseRevisions = new Map(items.map((item) => [item.id, revisions[item.id] ?? 0]));
      const changes: Array<{
        id: string;
        baseRevision: number;
        deleted: boolean;
        updatedAt: number;
        payload: unknown;
      }> = [];
      for (const item of items) {
        if (!item.deleted) {
          const validation = validateWorkspacePayload(item.payload);
          if (!validation.ok) {
            kernel.bus.emit("sync:invalid", { domain: "workspace", id: item.id, error: validation.error });
            continue;
          }
          changes.push({
            id: item.id,
            baseRevision: revisions[item.id] ?? 0,
            deleted: false,
            updatedAt: item.updatedAt,
            payload: validation.payload,
          });
          continue;
        }
        changes.push({
          id: item.id,
          baseRevision: revisions[item.id] ?? 0,
          deleted: true,
          updatedAt: item.updatedAt,
          payload: null,
        });
      }
      if (!changes.length) return { conflicts: 0 };

      const result = await callApi<PushResponse>(doFetch, "/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ domain: "workspace", changes }),
      });

      for (const entity of result.applied ?? []) revisions[entity.id] = entity.revision;
      if (result.conflicts?.length) {
        const localMap = new Map(items.map((item) => [item.id, item]));
        for (const entity of result.conflicts) {
          revisions[entity.id] = entity.revision;
          applyWorkspaceSyncItem(kernel, entity);
          const local = localMap.get(entity.id);
          if (local) recordEntityConflict("workspace", local, entity, baseRevisions.get(entity.id) ?? 0);
        }
      }
      writeRevisions(kernel, "workspace", revisions);
      return { conflicts: result.conflicts?.length ?? 0 };
    },

    pull: (ids) => pullChanges("workspace", kernel, doFetch, ids),

    apply: async (items) => {
      for (const item of items) applyWorkspaceSyncItem(kernel, item);
    },
  };
}

/* ============================================================
   Preferences（Phase 4.2：只同步白名单偏好）
   ============================================================ */

function createPreferencesProvider(kernel: Kernel, doFetch: FetchLike): SyncProvider {
  return {
    id: "preferences",
    label: DOMAIN_LABEL.preferences,

    readLocal: (): SyncItem[] => [readLocalPreferences(kernel)],

    readRemote: () => fetchIndex("preferences", kernel, doFetch),

    push: async (items) => {
      const revisions = readRevisions(kernel, "preferences");
      const baseRevisions = new Map(items.map((item) => [item.id, revisions[item.id] ?? 0]));
      const changes: Array<{
        id: string;
        baseRevision: number;
        deleted: boolean;
        updatedAt: number;
        payload: unknown;
      }> = [];
      for (const item of items) {
        if (!item.deleted) {
          const validation = validatePreferencesPayload(item.payload);
          if (!validation.ok) {
            kernel.bus.emit("sync:invalid", { domain: "preferences", id: item.id, error: validation.error });
            continue;
          }
          changes.push({
            id: item.id,
            baseRevision: revisions[item.id] ?? 0,
            deleted: false,
            updatedAt: item.updatedAt,
            payload: validation.payload,
          });
          continue;
        }
        changes.push({
          id: item.id,
          baseRevision: revisions[item.id] ?? 0,
          deleted: true,
          updatedAt: item.updatedAt,
          payload: null,
        });
      }
      if (!changes.length) return { conflicts: 0 };

      const result = await callApi<PushResponse>(doFetch, "/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ domain: "preferences", changes }),
      });

      for (const entity of result.applied ?? []) {
        revisions[entity.id] = entity.revision;
        // 与服务器时间戳对齐，避免下次同步把「内容未变」误判成本地更新
        markPreferencesSynced(kernel, entity.updatedAt);
      }
      if (result.conflicts?.length) {
        const localMap = new Map(items.map((item) => [item.id, item]));
        for (const entity of result.conflicts) {
          revisions[entity.id] = entity.revision;
          await applyServerEntity("preferences", kernel, entity);
          const local = localMap.get(entity.id);
          if (local) recordEntityConflict("preferences", local, entity, baseRevisions.get(entity.id) ?? 0);
        }
      }
      writeRevisions(kernel, "preferences", revisions);
      return { conflicts: result.conflicts?.length ?? 0 };
    },

    pull: (ids) => pullChanges("preferences", kernel, doFetch, ids),

    apply: async (items) => {
      for (const item of items) {
        if (item.deleted) continue;
        applyPreferencesPayload(kernel.settings, kernel, item.payload);
        markPreferencesSynced(kernel, item.updatedAt);
      }
    },
  };
}

/**
 * 创建单个数据域的 Provider。
 * 客户端只需要实现「读本地 / 读索引 / 推送 / 拉取 / 应用」。
 */
export function createProvider(
  domain: SyncDomainId,
  kernel: Kernel,
  doFetch: FetchLike = defaultFetch,
): SyncProvider {
  if (domain === "workspace") return createWorkspaceProvider(kernel, doFetch);
  if (domain === "preferences") return createPreferencesProvider(kernel, doFetch);
  return createStoreProvider(domain, kernel, doFetch);
}

/* ============================================================
   冲突解决
   ============================================================ */

export type SyncConflictChoice = "local" | "remote";

export type ResolveSyncConflictResult =
  | { ok: true; noop?: boolean; resolved?: SyncConflictChoice }
  | { ok: false; reason: "changed" | "offline" | "unsupported" | "error"; error?: string };

const isStoreDomain = (domain: SyncDomainId): domain is StoreDomainId =>
  (STORE_DOMAINS as string[]).includes(domain);

/** 读取本地当前实体（保留本地时用它重新推送；缺失按删除处理） */
async function readLocalEntity(
  domain: SyncDomainId,
  kernel: Kernel,
  entityId: string,
): Promise<{ id: string; updatedAt: number; deleted?: boolean; payload?: unknown }> {
  if (domain === "workspace") return readWorkspaceSyncItem(kernel, entityId);
  if (domain === "preferences") return readLocalPreferences(kernel);
  const adapter = await adapterFor(domain);
  const live = adapter.readLocal().find((item) => item.id === entityId);
  if (live) return { id: live.id, updatedAt: live.updatedAt, payload: live.payload };
  const tombstoneAt = readTombstones(domain)[entityId];
  return { id: entityId, updatedAt: tombstoneAt ?? Date.now(), deleted: true };
}

/**
 * 解决一条同步冲突（在系统中心由用户选择）：
 *   - 保留本地：用本地当前实体、以冲突记录的 serverRevision 为 baseRevision 重新推送，
 *     updatedAt 用当前时间；再次被乐观锁拒绝则更新冲突记录并返回 changed；
 *   - 保留云端：拉取该实体并写回本地、更新 revision、清除冲突记录；
 *   - 已解决 / 不存在：幂等返回 noop，不重复动作。
 */
export async function resolveSyncConflict(
  kernel: Kernel,
  conflictId: string,
  choice: SyncConflictChoice,
  options: { fetch?: FetchLike } = {},
): Promise<ResolveSyncConflictResult> {
  const conflict = getConflict(conflictId);
  if (!conflict || conflict.state === "resolved") return { ok: true, noop: true };

  const domain = conflict.domain as SyncDomainId;
  if (!ALL_DOMAINS.includes(domain)) return { ok: false, reason: "unsupported" };
  if (choice !== "local" && choice !== "remote") return { ok: false, reason: "unsupported" };

  // 未登录 / Local Mode 时无法与云端交互（UI 通常只在云同步时展示）
  const cloud = (kernel as unknown as { cloud?: { state?: () => { authenticated?: boolean } } }).cloud;
  try {
    if (cloud?.state && cloud.state()?.authenticated === false) return { ok: false, reason: "offline" };
  } catch {
    /* 云服务尚未初始化：继续按请求处理，失败会以 error 返回 */
  }

  const doFetch = options.fetch ?? defaultFetch;
  try {
    if (choice === "local") {
      const local = await readLocalEntity(domain, kernel, conflict.entityId);
      const revisions = readRevisions(kernel, domain);
      // 以服务端当前 revision 作为基线重试，不关闭乐观锁
      const result = await callApi<PushResponse>(doFetch, "/api/sync/push", {
        method: "POST",
        body: JSON.stringify({
          domain,
          changes: [
            {
              id: conflict.entityId,
              baseRevision: conflict.serverRevision,
              deleted: Boolean(local.deleted),
              updatedAt: Date.now(),
              payload: local.deleted ? null : (local.payload ?? null),
            },
          ],
        }),
      });

      if (result.conflicts?.length) {
        const server = result.conflicts[0];
        revisions[server.id] = server.revision;
        writeRevisions(kernel, domain, revisions);
        await applyServerEntity(domain, kernel, server);
        recordEntityConflict(domain, { id: conflict.entityId, updatedAt: local.updatedAt, deleted: local.deleted, payload: local.payload }, server, conflict.serverRevision);
        return { ok: false, reason: "changed" };
      }

      const applied = result.applied?.[0];
      if (applied) {
        revisions[applied.id] = applied.revision;
        writeRevisions(kernel, domain, revisions);
        if (local.deleted && isStoreDomain(domain)) clearTombstones(domain, [applied.id]);
        if (domain === "preferences") markPreferencesSynced(kernel, applied.updatedAt);
      }
      markConflictResolved(conflict.id, "local");
      return { ok: true, resolved: "local" };
    }

    // 保留云端：拉取该实体并写回本地
    const changes = await pullChanges(domain, kernel, doFetch, [conflict.entityId]);
    const change = changes[0];
    if (change && !(domain === "preferences" && change.deleted)) {
      await applyServerEntity(domain, kernel, { ...change, deleted: Boolean(change.deleted) });
    }
    markConflictResolved(conflict.id, "remote");
    return { ok: true, resolved: "remote" };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 注册五个数据域。
 * 只在 Cloud Mode 且已登录时调用。
 */
export function registerSyncProviders(
  kernel: Kernel,
  options: { fetch?: FetchLike } = {},
): SyncRegistration {
  const doFetch = options.fetch ?? defaultFetch;
  const registered: SyncDomainId[] = [];

  for (const domain of ALL_DOMAINS) {
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

/** 系统中心用：当前未解决的冲突列表 */
export const syncConflicts = (): SyncConflict[] => listConflicts();

export { DOMAIN_LABEL, SyncApiError };
