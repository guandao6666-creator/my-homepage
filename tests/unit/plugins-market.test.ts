/**
 * 2.0.6 · 插件市场 trending 的功能性证据
 *
 * 为什么需要这条测试：2.0.5 只把 trending 的 id 查询改成按 40 分块，并用「源码断言」
 * 保证 `chunkIds` 还在。源码断言能防止有人改回去，但证明不了「120 个候选时真的
 * 分了 3 块、每块绑定参数 ≤100、排序仍按近 30 天下载数」。这里用一个会拒绝
 * 超 100 参数的假 D1（模拟真实 D1 的行为）把整条 marketList 跑一遍。
 */
import { describe, expect, it } from "vitest";
import { marketList } from "../../worker/api/plugins/store.js";
import { D1_PARAM_LIMIT } from "../../worker/api/sql.js";

interface FakeStatement {
  bind: (...args: unknown[]) => FakeStatement;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
  first: () => Promise<Record<string, unknown> | null>;
}

interface TrendingRow {
  id: string;
  name: string;
  download_count: number;
}

interface FakeDb {
  prepare: (sql: string) => FakeStatement;
  maxBinds: () => number;
  trendQueries: () => number;
  trendChunkSizes: () => number[];
}

function makeFakeDb(rows: TrendingRow[], trendByPlugin: Map<string, number>): FakeDb {
  let maxBinds = 0;
  let trendQueries = 0;
  const trendChunkSizes: number[] = [];

  const prepare = (sql: string): FakeStatement => {
    const statement: FakeStatement = {
      bind: (...args) => {
        if (args.length > D1_PARAM_LIMIT) {
          // 真实 D1 对超限直接报错；这里让测试以同样的方式失败，而不是静默放过。
          throw new Error(`D1 绑定参数超限：${args.length} > ${D1_PARAM_LIMIT}`);
        }
        maxBinds = Math.max(maxBinds, args.length);
        (statement as FakeStatement & { args?: unknown[] }).args = args;
        return statement;
      },
      all: async () => {
        const args = ((statement as FakeStatement & { args?: unknown[] }).args ?? []) as unknown[];
        if (sql.includes("FROM plugin_download_events")) {
          trendQueries += 1;
          const ids = args.slice(1).map(String);
          trendChunkSizes.push(ids.length);
          return {
            results: ids
              .filter((id) => trendByPlugin.has(id))
              .map((id) => ({ plugin_id: id, n: trendByPlugin.get(id) })),
          };
        }
        if (sql.includes("FROM plugin_installations")) return { results: [] };
        if (sql.includes("FROM plugin_versions")) return { results: [] };
        if (sql.includes("FROM plugins p")) {
          const limit = Number(args[args.length - 2] ?? rows.length);
          const offset = Number(args[args.length - 1] ?? 0);
          return {
            results: rows.slice(offset, offset + limit).map((row, index) => ({
              id: row.id,
              name: row.name,
              description: "",
              type: "app",
              category: "tools",
              license: "MIT",
              status: "published",
              download_count: row.download_count,
              install_count: 0,
              rating_sum: 0,
              rating_count: 0,
              published_at: 1_700_000_000_000 - index,
              updated_at: 1_700_000_000_000 - index,
              latest_version: "1.0.0",
              featured_at: null,
              permissions_json: null,
              compatibility_json: null,
              latest_manifest_json: null,
            })),
          };
        }
        throw new Error(`测试未预期的 SQL：${sql.slice(0, 60)}`);
      },
      first: async () => {
        if (sql.includes("COUNT(*) AS n FROM plugins")) return { n: rows.length };
        return null;
      },
    };
    return statement;
  };

  return {
    prepare,
    maxBinds: () => maxBinds,
    trendQueries: () => trendQueries,
    trendChunkSizes: () => trendChunkSizes,
  };
}

describe("插件市场 trending（候选超过 99 行）", () => {
  it("120 个候选按 40 分块查询，任何一条语句都不超过 D1 参数上限", async () => {
    const rows: TrendingRow[] = Array.from({ length: 120 }, (_, index) => ({
      id: `p-${index}`,
      name: `插件 ${index}`,
      // 下载总量与近 30 天热度故意不同：排序必须看后者。
      download_count: 120 - index,
    }));
    const trendByPlugin = new Map([
      ["p-4", 50],
      ["p-9", 7],
    ]);
    const db = makeFakeDb(rows, trendByPlugin);
    const env = { DB: db } as unknown as Parameters<typeof marketList>[0];

    const result = await marketList(env, { sort: "trending", page: 1, limit: 12 });

    expect(result.total).toBe(120);
    expect(result.items).toHaveLength(12);
    expect(db.maxBinds()).toBeLessThanOrEqual(D1_PARAM_LIMIT);
    // 120 个 id / 每块 40 → 3 次聚合查询，每次绑定 since + 最多 40 个 id。
    expect(db.trendQueries()).toBe(3);
    expect(db.trendChunkSizes()).toEqual([40, 40, 40]);
    // 热度优先于累计下载：p-4(50) 与 p-9(7) 必须排在 p-0(120 次累计下载) 前面。
    expect(result.items[0]?.id).toBe("p-4");
    expect(result.items[0]?.recentDownloads).toBe(50);
    expect(result.items[1]?.id).toBe("p-9");
    expect(result.items[1]?.recentDownloads).toBe(7);
    const recent = result.items.map((item: { recentDownloads: number }) => item.recentDownloads);
    expect([...recent].sort((a, b) => b - a)).toEqual(recent);
  });

  it("候选不足一个块时只查一次，不分页截断之前的行", async () => {
    const rows: TrendingRow[] = Array.from({ length: 7 }, (_, index) => ({
      id: `s-${index}`,
      name: `小市场插件 ${index}`,
      download_count: 7 - index,
    }));
    const db = makeFakeDb(rows, new Map([["s-2", 3]]));
    const env = { DB: db } as unknown as Parameters<typeof marketList>[0];

    const result = await marketList(env, { sort: "trending", page: 1, limit: 12 });

    expect(result.total).toBe(7);
    expect(result.items).toHaveLength(7);
    expect(db.trendQueries()).toBe(1);
    expect(db.trendChunkSizes()).toEqual([7]);
    expect(result.items[0]?.id).toBe("s-2");
  });
});