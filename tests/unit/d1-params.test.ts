/**
 * Guandao OS 2.0.5 · D1 绑定参数上限回归
 *
 * D1 单条语句最多 100 个绑定参数。2.0.4 的深目录删除（整棵树塞进 IN）与
 * 2.0.5 找到的两处（通知标记已读、插件市场 trending）都是同一个形态：
 * 「一批 id 直接展开成 IN (?, ?, …)」。这里的假 D1 会在 bind 时强校验上限，
 * 只要实现退回单条语句，测试立刻抛错 —— 不依赖真实 D1 才能稳定判别。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { D1_PARAM_LIMIT, chunkIds, placeholdersFor } from "../../worker/api/sql.js";
import { markNotifications } from "../../worker/api/community/write.js";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const UUID_POOL = Array.from({ length: 200 }, (_, index) => {
  const tail = String(index + 1).padStart(12, "0");
  return `11111111-2222-4333-8444-${tail}`;
});

class LimitStatement {
  private binds: unknown[] = [];

  constructor(
    private readonly db: LimitDb,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    // 真实 D1 是「语句级」上限：超出直接 500，不会帮你分块。
    if (values.length > D1_PARAM_LIMIT) {
      throw new Error(`D1 绑定参数超限：${values.length} > ${D1_PARAM_LIMIT}`);
    }
    this.binds = values;
    return this;
  }

  async run() {
    this.db.statements.push({ sql: this.sql, binds: this.binds });
    if (this.sql.startsWith("UPDATE community_notifications")) {
      for (const id of this.binds.slice(2)) this.db.marked.add(String(id));
    }
    return { success: true, meta: { changes: 1 } };
  }

  async first() {
    this.db.statements.push({ sql: this.sql, binds: this.binds });
    if (this.sql.includes("COUNT(*)") && this.sql.includes("community_notifications")) {
      return { total: this.db.marked.size };
    }
    return null;
  }

  async all() {
    this.db.statements.push({ sql: this.sql, binds: this.binds });
    return { results: [] };
  }
}

class LimitDb {
  statements: { sql: string; binds: unknown[] }[] = [];
  marked = new Set<string>();

  prepare(sql: string) {
    return new LimitStatement(this, sql);
  }
}

function notificationsRequest(ids: string[]) {
  return new Request("http://127.0.0.1:8788/api/community/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

describe("chunkIds / placeholdersFor", () => {
  it("空列表不产出任何块", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("120 个 id 按 40 切成三块，顺序不变", () => {
    const ids = UUID_POOL.slice(0, 120);
    const chunks = chunkIds(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 40]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("自定义块大小保留尾块，非法大小回退到默认值", () => {
    expect(chunkIds(UUID_POOL.slice(0, 20), 7).map((chunk) => chunk.length)).toEqual([7, 7, 6]);
    expect(chunkIds(UUID_POOL.slice(0, 50), 0).map((chunk) => chunk.length)).toEqual([40, 10]);
    expect(chunkIds(UUID_POOL.slice(0, 50), Number.NaN).map((chunk) => chunk.length)).toEqual([40, 10]);
  });

  it("占位符数量与块大小一致", () => {
    expect(placeholdersFor([])).toBe("");
    expect(placeholdersFor(["a"])).toBe("?");
    expect(placeholdersFor(["a", "b", "c"])).toBe("?, ?, ?");
  });
});

describe("通知标记已读不在 D1 参数上限上崩", () => {
  it("120 个 id 分三条 UPDATE，每条 42 个参数，全部标记", async () => {
    const db = new LimitDb();
    const ids = UUID_POOL.slice(0, 120);
    const response = await markNotifications({
      env: { DB: db },
      request: notificationsRequest(ids),
      viewer: { id: USER_ID },
    });

    expect(response.status).toBe(200);
    const updates = db.statements.filter((statement) => statement.sql.startsWith("UPDATE community_notifications"));
    expect(updates).toHaveLength(3);
    // now + user_id + 40 个 id；旧实现是 now + user_id + 120 个 id = 122，直接超限。
    expect(updates.map((statement) => statement.binds.length)).toEqual([42, 42, 42]);
    expect(db.marked.size).toBe(120);
    expect([...db.marked]).toEqual(ids);
  });

  it("负向对照：旧形态（99 个 id + now/user_id）会被上限挡下", () => {
    const statement = new LimitStatement(new LimitDb(), "UPDATE community_notifications SET read_at = ? WHERE user_id = ? AND id IN (…)");
    expect(() => statement.bind(Date.now(), USER_ID, ...UUID_POOL.slice(0, 99))).toThrow(
      `D1 绑定参数超限：${D1_PARAM_LIMIT + 1} > ${D1_PARAM_LIMIT}`,
    );
  });
});

describe("插件市场 trending 的聚合查询按块执行", () => {
  it("源码里 trending 使用 chunkIds，且不再拼一整条 IN", () => {
    const source = readFileSync(join(process.cwd(), "worker/api/plugins/store.js"), "utf8");
    expect(source).toContain("for (const chunk of chunkIds(ids))");
    expect(source).not.toContain('ids.map(() => "?")');
    // 注释与实现都要说明为什么分块（防止后来的人"优化"回去）。
    expect(source).toContain("超过 D1 的 100 参数上限");
  });
});