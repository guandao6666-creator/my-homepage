import { beforeEach, describe, expect, it } from "vitest";

import { SettingsManager } from "../../src/lib/core/settings";
import { MemoryStore, createStorage } from "../../src/lib/core/storage";

/**
 * 冲突记录单测：注入内存 localStorage，覆盖去重、上限、TTL、受控快照、
 * 解决幂等与损坏数据容错（不依赖浏览器 / Kernel）。
 */

class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  get length(): number {
    return this.map.size;
  }
}

const globalStore = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = globalStore;

const {
  CONFLICTS_KEY,
  MAX_CONFLICTS,
  CONFLICT_TTL_MS,
  MAX_SNAPSHOT_BYTES,
  listConflicts,
  getConflict,
  recordConflict,
  markConflictResolved,
  clearConflicts,
  conflictStats,
} = await import("../../src/lib/sync/conflicts");

const { resolveSyncConflict } = await import("../../src/lib/sync/providers");

// 用当前时间作基准：resolveSyncConflict 内部按真实 Date.now() 做 7 天 TTL 过滤
const BASE = Date.now();

type ConflictInput = Parameters<typeof recordConflict>[0];

const makeInput = (entityId: string, overrides: Partial<ConflictInput> = {}): ConflictInput => ({
  domain: "notes",
  entityId,
  localRevision: 2,
  serverRevision: 3,
  localUpdatedAt: BASE,
  serverUpdatedAt: BASE + 100,
  detectedAt: BASE,
  ...overrides,
});

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe("同步冲突记录", () => {
  beforeEach(() => {
    globalStore.clear();
  });

  it("同一实体去重：再次冲突复用记录并更新版本号", () => {
    const first = recordConflict(makeInput("n1"), { now: BASE });
    expect(first.id).toBe("notes:n1");
    expect(first.state).toBe("open");

    const second = recordConflict(makeInput("n1", { serverRevision: 9, detectedAt: BASE + 1000 }), {
      now: BASE + 1000,
    });

    expect(second.id).toBe(first.id);
    expect(second.serverRevision).toBe(9);
    expect(second.state).toBe("open");

    const all = listConflicts({ includeResolved: true, now: BASE + 1000 });
    expect(all).toHaveLength(1);
    expect(all[0].serverRevision).toBe(9);
  });

  it("最多保留 50 条，超出时淘汰最旧记录", () => {
    for (let index = 0; index < 60; index += 1) {
      recordConflict(makeInput(`e${index}`, { detectedAt: BASE + index }), { now: BASE + index });
    }

    const all = listConflicts({ includeResolved: true, now: BASE + 59 });
    expect(all).toHaveLength(MAX_CONFLICTS);
    // 最新一条保留，最旧的 10 条被淘汰
    expect(all.some((item) => item.id === "notes:e59")).toBe(true);
    expect(all.some((item) => item.id === "notes:e9")).toBe(false);
  });

  it("超过 7 天的记录在读取时过期", () => {
    recordConflict(makeInput("old", { detectedAt: BASE }), { now: BASE });
    expect(listConflicts({ now: BASE + 1000 })).toHaveLength(1);
    expect(listConflicts({ now: BASE + CONFLICT_TTL_MS + 1 })).toHaveLength(0);
  });

  it("标记解决是幂等的，且已解决记录不再出现在默认列表", () => {
    recordConflict(makeInput("n1"), { now: BASE });
    const resolved = markConflictResolved("notes:n1", "local", { now: BASE + 500 });
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolvedBy).toBe("local");
    expect(resolved?.resolvedAt).toBe(BASE + 500);

    expect(listConflicts({ now: BASE + 500 })).toHaveLength(0);
    expect(listConflicts({ includeResolved: true, now: BASE + 500 })).toHaveLength(1);

    // 再次调用不刷新 resolvedAt（幂等）
    const again = markConflictResolved("notes:n1", "remote", { now: BASE + 900 });
    expect(again?.resolvedBy).toBe("local");
    expect(again?.resolvedAt).toBe(BASE + 500);

    expect(markConflictResolved("notes:missing", "local", { now: BASE })).toBeNull();
  });

  it("按 id / domain 清理并统计", () => {
    recordConflict(makeInput("n1"), { now: BASE });
    recordConflict(makeInput("n2"), { now: BASE });
    recordConflict(makeInput("t1", { domain: "tasks" }), { now: BASE });
    markConflictResolved("notes:n2", "remote", { now: BASE + 10 });

    expect(conflictStats({ now: BASE + 10 })).toEqual({
      total: 3,
      open: 2,
      resolved: 1,
      byDomain: { notes: 2, tasks: 1 },
    });

    expect(clearConflicts({ domain: "notes", now: BASE + 10 })).toBe(2);
    expect(clearConflicts({ id: "tasks:t1", now: BASE + 10 })).toBe(1);
    expect(listConflicts({ includeResolved: true, now: BASE + 10 })).toHaveLength(0);
  });

  it("快照受控：长正文截断、敏感字段隐藏、单边不超过 4KB", () => {
    const body = "正文内容".repeat(1000);
    recordConflict(
      makeInput("n1", {
        localSnapshot: { name: "会议纪要", body, token: "secret-token-value", tags: ["a", "b"], meta: { a: 1 } },
        serverSnapshot: { name: "会议纪要（云端）", body },
      }),
      { now: BASE },
    );

    const conflict = getConflict("notes:n1", { now: BASE });
    expect(conflict).not.toBeNull();
    const snapshot = conflict?.localSnapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot?.label).toBe("会议纪要");
    expect(snapshot?.preview.length).toBeLessThanOrEqual(801);
    expect(snapshot?.fields?.token).toBe("[已隐藏]");
    // 完整正文不落盘：单字段最多 160 字符 + 省略号
    expect(String(snapshot?.fields?.body).length).toBeLessThanOrEqual(161);
    expect((snapshot?.preview.match(/正文内容/g) ?? []).length).toBeLessThan(body.length / 4);
    expect(byteLength(snapshot)).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(byteLength(conflict?.serverSnapshot)).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it("损坏 JSON 与 StorageManager 信封都能容错读取", () => {
    globalStore.setItem(CONFLICTS_KEY, "{不是合法 JSON");
    expect(listConflicts({ now: BASE })).toHaveLength(0);

    const envelope = {
      v: 2,
      at: BASE,
      data: {
        v: 1,
        at: BASE,
        items: [
          {
            id: "notes:x",
            domain: "notes",
            entityId: "x",
            localRevision: 1,
            serverRevision: 2,
            localUpdatedAt: BASE,
            serverUpdatedAt: BASE + 1,
            detectedAt: BASE,
            state: "open",
          },
        ],
      },
    };
    globalStore.setItem(CONFLICTS_KEY, JSON.stringify(envelope));
    const list = listConflicts({ now: BASE });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("notes:x");
  });

  it("支持注入独立存储，不污染默认 localStorage", () => {
    const map = new Map<string, string>();
    const injected = {
      getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };

    recordConflict(makeInput("iso"), { storage: injected, now: BASE });
    expect(listConflicts({ now: BASE })).toHaveLength(0);
    expect(listConflicts({ storage: injected, now: BASE })).toHaveLength(1);
  });
});

/* ============================================================
   冲突解决：保留本地 / 保留云端（假 Kernel + 桩 fetch，不联网）
   ============================================================ */

type ResolveKernel = Parameters<typeof resolveSyncConflict>[0];

const makeResolveKernel = (authenticated = true) => {
  const storage = createStorage({ store: new MemoryStore() });
  const settings = new SettingsManager({ storage });
  const kernel = {
    storage,
    settings,
    cloud: { state: () => ({ authenticated }) },
  } as unknown as ResolveKernel;
  return { kernel, settings, storage };
};

const responseOf = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeFetchStub = (routes: { push?: unknown; pull?: unknown }) => {
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/sync/push")) return responseOf(routes.push);
    if (url.includes("/api/sync/pull")) return responseOf(routes.pull);
    return responseOf({});
  }) as unknown as typeof fetch;
  return { stub, calls };
};

const resolvePreferenceConflict = (serverRevision: number, detectedAt = BASE): void => {
  recordConflict(
    {
      domain: "preferences",
      entityId: "preferences",
      localRevision: 2,
      serverRevision,
      localUpdatedAt: BASE,
      serverUpdatedAt: BASE + 10,
      detectedAt,
      localSnapshot: { name: "偏好设置", appearance: "light" },
      serverSnapshot: { name: "偏好设置", appearance: "dark" },
    },
    { now: detectedAt },
  );
};

describe("冲突解决", () => {
  beforeEach(() => {
    globalStore.clear();
  });

  it("保留本地：按 serverRevision 重推，成功后标记已解决且幂等", async () => {
    resolvePreferenceConflict(3);
    const { kernel } = makeResolveKernel();
    const { stub, calls } = makeFetchStub({
      push: {
        applied: [{ id: "preferences", revision: 4, deleted: false, updatedAt: BASE + 100, payload: null }],
        conflicts: [],
      },
    });

    const result = await resolveSyncConflict(kernel, "preferences:preferences", "local", { fetch: stub });
    expect(result).toEqual({ ok: true, resolved: "local" });
    expect(calls[0]).toContain("/api/sync/push");

    const conflict = getConflict("preferences:preferences", { now: BASE });
    expect(conflict?.state).toBe("resolved");
    expect(conflict?.resolvedBy).toBe("local");

    // 再次调用是幂等的 noop，不再发请求
    const again = await resolveSyncConflict(kernel, "preferences:preferences", "local", { fetch: stub });
    expect(again).toEqual({ ok: true, noop: true });
    expect(calls).toHaveLength(1);
  });

  it("保留本地但云端又变了：返回 changed、更新记录并保留冲突", async () => {
    resolvePreferenceConflict(3);
    const { kernel, settings } = makeResolveKernel();
    settings.update({ "appearance.mode": "light" });
    const { stub } = makeFetchStub({
      push: {
        applied: [],
        conflicts: [
          {
            id: "preferences",
            revision: 6,
            deleted: false,
            updatedAt: BASE + 40,
            payload: { v: 1, values: { "appearance.mode": "dark" } },
          },
        ],
      },
    });

    const result = await resolveSyncConflict(kernel, "preferences:preferences", "local", { fetch: stub });
    expect(result).toEqual({ ok: false, reason: "changed" });

    const conflict = getConflict("preferences:preferences", { now: BASE });
    expect(conflict?.state).toBe("open");
    expect(conflict?.serverRevision).toBe(6);
    // 冲突时服务端版本落回本地（与既有三域行为一致）
    expect(settings.get("appearance.mode")).toBe("dark");
  });

  it("保留云端：拉取该实体写回本地并清冲突", async () => {
    resolvePreferenceConflict(3);
    const { kernel, settings } = makeResolveKernel();
    settings.update({ "appearance.mode": "light" });
    const { stub, calls } = makeFetchStub({
      pull: {
        changes: [
          {
            id: "preferences",
            revision: 7,
            deleted: false,
            updatedAt: BASE + 50,
            payload: { v: 1, values: { "appearance.mode": "dark" } },
          },
        ],
      },
    });

    const result = await resolveSyncConflict(kernel, "preferences:preferences", "remote", { fetch: stub });
    expect(result).toEqual({ ok: true, resolved: "remote" });
    expect(calls[0]).toContain("/api/sync/pull");
    expect(settings.get("appearance.mode")).toBe("dark");

    const conflict = getConflict("preferences:preferences", { now: BASE });
    expect(conflict?.state).toBe("resolved");
    expect(conflict?.resolvedBy).toBe("remote");
  });

  it("未登录 / 不受支持的域 / 不存在的冲突都有明确结果", async () => {
    resolvePreferenceConflict(3);
    const offline = makeResolveKernel(false);
    const { stub } = makeFetchStub({});
    expect(await resolveSyncConflict(offline.kernel, "preferences:preferences", "local", { fetch: stub })).toEqual({
      ok: false,
      reason: "offline",
    });

    const { kernel } = makeResolveKernel();
    recordConflict(
      {
        domain: "device",
        entityId: "device-1",
        localRevision: 1,
        serverRevision: 1,
        localUpdatedAt: BASE,
        serverUpdatedAt: BASE,
        detectedAt: BASE,
      },
      { now: BASE },
    );
    expect(await resolveSyncConflict(kernel, "device:device-1", "local", { fetch: stub })).toEqual({
      ok: false,
      reason: "unsupported",
    });

    expect(await resolveSyncConflict(kernel, "notes:missing", "local", { fetch: stub })).toEqual({
      ok: true,
      noop: true,
    });
  });
});

