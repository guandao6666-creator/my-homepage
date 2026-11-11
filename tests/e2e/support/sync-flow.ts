/**
 * Phase 4 云同步 E2E 的协议辅助层。
 *
 * 不复制 device-flow.ts 的浏览器 / HTTP 底座（真实 Browser Context、Cookie 注入、
 * 同源 Origin、cf-connecting-ip 限流分桶都在那里验证过），只在它之上补 sync 域语义：
 *   - push / index / pull / status 的类型化调用；
 *   - workspace / preferences 的合法 payload 构造（与 src/lib/sync/*.ts 的客户端形状一致）；
 *   - 本地 e2e-server 的同步夹具清理（POST /__e2e/reset-sync）。
 *
 * 服务端契约（worker/api/sync/*、migrations/0018_sync_cloud_expansion.sql）：
 *   - push 用 revision 乐观锁，冲突不覆盖，返回服务端当前行；
 *   - 删除写墓碑（sync_entities.deleted=1 + deleted_at），台账拦住旧终端「复活」；
 *   - preferences 单条 payload 32KB、其余域 128KB；单账号 5000 活实体 / 2000 墓碑。
 */
import type { Browser } from "@playwright/test";

import { api, newSeededActor, type ApiActor, type ApiResult } from "./device-flow";
import { type Fixtures } from "./worker-api";

/** 与 worker/api/sync/limits.js 的 SYNC_DOMAINS 保持一致（/api/sync/status 按此顺序返回）。 */
export const SYNC_DOMAINS = ["notes", "tasks", "calendar", "workspace", "preferences"] as const;
export type SyncDomain = (typeof SYNC_DOMAINS)[number];

/** 与 worker/api/sync/limits.js 的常量保持一致。 */
export const SYNC_LIMITS = {
  maxEntities: 5000,
  maxTombstones: 2000,
  defaultPayloadBytes: 128 * 1024,
  preferencesPayloadBytes: 32 * 1024,
  maxBatch: 100,
  maxPullIds: 200,
} as const;

export type SyncChange = {
  id: string;
  baseRevision: number;
  updatedAt: number;
  deleted?: boolean;
  payload?: unknown;
};

export type SyncEntity = {
  id: string;
  revision: number;
  deleted: boolean;
  updatedAt: number;
  /** 仅墓碑有：删除时间（毫秒）。 */
  deletedAt?: number | null;
  /** 仅活实体有；墓碑不返回 payload。 */
  payload?: unknown;
};

export type SyncStatus = {
  domains: Array<{ domain: SyncDomain; count: number; tombstones: number; lastUpdated: number | null }>;
  quotas: {
    entityCount: number;
    tombstoneCount: number;
    limits: { maxEntities: number; maxTombstones: number };
  };
  serverTime: number;
};

export type SyncIndex = {
  domain: SyncDomain;
  serverTime: number;
  entities: Array<{ id: string; revision: number; deleted: boolean; updatedAt: number }>;
  truncated: boolean;
};

export type SyncPull = {
  domain: SyncDomain;
  serverTime: number;
  changes: SyncEntity[];
  hasMore: boolean;
};

export type SyncPush = {
  domain: SyncDomain;
  serverTime: number;
  applied: SyncEntity[];
  conflicts: SyncEntity[];
};

/**
 * 已 seed 会话 + 全新的空 Browser Context。
 *
 * installer 与 installer2 是同一账号（qa-p3-installer）的两台不同设备：
 * 前者是 `qa-p3-installer-device`，后者是 e2e-server 额外播种的
 * `qa-p3-installer-device-2`，会话 token 也各自独立（见 scripts/e2e-server.mjs）。
 */
export function newSyncDevice(
  browser: Browser,
  fixtures: Fixtures,
  role: "installer" | "installer2" | "outsider",
): Promise<ApiActor> {
  return newSeededActor(browser, fixtures, role);
}

export function syncStatus(actor: ApiActor): Promise<ApiResult> {
  return api(actor, "GET", "/api/sync/status");
}

export function syncIndex(actor: ApiActor, domain: SyncDomain | string): Promise<ApiResult> {
  return api(actor, "GET", `/api/sync/index?domain=${encodeURIComponent(domain)}`);
}

export function syncPull(
  actor: ApiActor,
  domain: SyncDomain | string,
  options: { ids?: string[]; since?: number; limit?: number } = {},
): Promise<ApiResult> {
  const params = new URLSearchParams({ domain });
  if (options.ids) params.set("ids", options.ids.join(","));
  else if (options.since !== undefined) params.set("since", String(options.since));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return api(actor, "GET", `/api/sync/pull?${params.toString()}`);
}

export function syncPush(actor: ApiActor, domain: SyncDomain | string, changes: SyncChange[]): Promise<ApiResult> {
  return api(actor, "POST", "/api/sync/push", { body: { domain, changes } });
}

/** 在索引里按 id 取实体；不存在返回 undefined（便于断言「没有」）。 */
export function entityOf(index: SyncIndex, id: string): SyncIndex["entities"][number] | undefined {
  return index.entities.find((entity) => entity.id === id);
}

/**
 * 构造客户端真实会推送的 workspace payload。
 *
 * 形状对齐 src/lib/sync/workspace.ts 的 validateWorkspacePayload：
 * {v:1, workspace:{id,name,preset:false,...}, viewport, capturedAt}。
 * preset:true 的内置工作空间不参与同步，所以 E2E 一律用 preset:false 的自定义空间。
 */
export function workspacePayload(
  id: string,
  name: string,
  overrides: { theme?: string; wall?: string; openApps?: string[] } = {},
): Record<string, unknown> {
  const now = Date.now();
  return {
    v: 1,
    workspace: {
      id,
      name,
      preset: false,
      theme: overrides.theme ?? "dark",
      wall: overrides.wall ?? "wall-default",
      widgets: ["clock"],
      dock: ["notes"],
      shortcuts: [],
      windows: [],
      openApps: overrides.openApps ?? ["notes"],
      dnd: false,
      createdAt: now,
      updatedAt: now,
    },
    viewport: { width: 1440, height: 900 },
    capturedAt: now,
  };
}

/**
 * 构造 preferences payload。
 *
 * 键全部来自 src/lib/sync/preferences.ts 的 SYNC_PREFERENCE_KEYS，值取 settings schema
 * 的合法枚举；设备级键（system.mode / device.name 等）永远不进 payload —— 这条
 * 过滤发生在客户端，由 tests/unit/sync-preferences.test.ts 覆盖。
 */
export function preferencesPayload(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    values: {
      "appearance.mode": "dark",
      "desktop.iconLabels": false,
      "notifications.dnd": true,
      ...values,
    },
  };
}

/**
 * 生成 JSON 序列化后约 `bytes` 字节的对象，用于验证「按域 payload 上限」。
 *
 * preferences 上限 32KB、其余域 128KB：同一个 40KB payload 在 preferences 上必须 400，
 * 在 workspace 上必须成功 —— 这样测的是「按域生效」，而不是全局常量。
 */
export function paddedPayload(bytes: number, marker: string): Record<string, unknown> {
  // JSON.stringify 的固定开销（{"v":1,"marker":"...","padding":"..."}）约 60 字节；
  // 多留一点余量，保证序列化后的字节数确实超过目标阈值。
  const overhead = 96;
  return { v: 1, marker, padding: "x".repeat(Math.max(1, bytes - overhead)) };
}

/**
 * 调用仅监听 127.0.0.1 的 e2e-server 清理云同步夹具。
 *
 * 与 device-flow.reseedExpiredPairings 同一安全边界：不是 Worker 代码、不进入生产，
 * 只在本地测试脚本里存在。返回 {ok, deleted, rows} 便于断言「确实删到了东西」。
 */
export async function resetSyncFixtures(
  actor: ApiActor,
  adminUrl: string | undefined,
): Promise<{ ok: boolean; deleted: number; rows: Record<string, number> }> {
  if (!adminUrl) {
    throw new Error("夹具里缺少 adminUrl：请用 scripts/e2e-server.mjs 启动真实 Worker 再跑同步 E2E");
  }
  const response = await actor.context.request.post(new URL("/__e2e/reset-sync", adminUrl).toString(), {
    failOnStatusCode: false,
    timeout: 30_000,
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (response.status() !== 200 || body?.ok !== true) {
    throw new Error(`重置云同步夹具失败（HTTP ${response.status()}）：${text.slice(0, 300)}`);
  }
  return body as { ok: true; deleted: number; rows: Record<string, number> };
}
