import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { retryPendingDeletes } from "../../worker/api/files/handlers.js";

type PendingRow = { id: string; r2_key: string };

interface StatementLog {
  sql: string;
  args: unknown[];
}

/**
 * 最小 D1 桩：SELECT 返回预置的 pending_delete 行，其它语句只记录。
 * 真实实现只在 R2 删除成功后才会发 DELETE，这里靠调用日志验证顺序。
 */
function fakeDb(rows: PendingRow[], log: StatementLog[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          log.push({ sql, args });
          const isSelect = sql.startsWith("SELECT id, r2_key");
          return {
            all: async () => ({ results: isSelect ? rows : [] }),
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => null,
          };
        },
        all: async () => ({ results: rows }),
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

function fakeEnv(rows: PendingRow[], options: { failDelete?: boolean } = {}) {
  const log: StatementLog[] = [];
  const deleted: string[][] = [];
  return {
    log,
    deleted,
    env: {
      DB: fakeDb(rows, log),
      FILES: {
        delete: async (keys: string[]) => {
          deleted.push(keys);
          if (options.failDelete) throw new Error("R2 不可用");
          return { deleted: {} };
        },
      },
    } as never,
  };
}

const ROWS: PendingRow[] = [
  { id: "f1", r2_key: "users/u1/files/f1" },
  { id: "f2", r2_key: "users/u1/files/f2" },
];

describe("retryPendingDeletes", () => {
  it("R2 删除成功后重试的行被清掉", async () => {
    const { env, log, deleted } = fakeEnv(ROWS);
    const removed = await retryPendingDeletes(env, "u1");

    expect(removed).toBe(2);
    expect(deleted).toEqual([["users/u1/files/f1", "users/u1/files/f2"]]);
    const deletes = log.filter((entry) => entry.sql.startsWith("DELETE FROM files"));
    expect(deletes).toHaveLength(1);
    // DELETE 必须带着 user_id 且限定 pending_delete，避免误删同 id 的正常文件
    expect(deletes[0].sql).toContain("user_id = ?");
    expect(deletes[0].sql).toContain("status = 'pending_delete'");
    expect(deletes[0].args).toEqual(["u1", "f1", "f2"]);
  });

  it("R2 失败时保留行，等下次再试", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { env, log, deleted } = fakeEnv(ROWS, { failDelete: true });
    const removed = await retryPendingDeletes(env, "u1");

    expect(removed).toBe(0);
    expect(deleted).toHaveLength(1);
    expect(log.some((entry) => entry.sql.startsWith("DELETE FROM files"))).toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("没有待清理行时不碰 R2", async () => {
    const { env, deleted } = fakeEnv([]);
    const removed = await retryPendingDeletes(env, "u1");

    expect(removed).toBe(0);
    expect(deleted).toHaveLength(0);
  });

  it("列表入口接上了重试（否则状态照样永久泄漏）", () => {
    const source = readFileSync("worker/api/files/handlers.js", "utf8");
    const listStart = source.indexOf("async function listHandler");
    const listEnd = source.indexOf("async function ", listStart + 1);
    const body = source.slice(listStart, listEnd);
    expect(listStart).toBeGreaterThan(0);
    expect(body).toContain("await retryPendingDeletes(env, userId)");
  });
});