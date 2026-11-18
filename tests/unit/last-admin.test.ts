import { describe, expect, it } from "vitest";
import { isLastActiveAdmin } from "../../worker/api/privacy/last-admin.js";

type Row = { id: string; role: string; status: string };

/**
 * 最小 D1 替身：只认 last-admin.js 里用到的两条 SQL。
 * 任何多余的查询都会抛错，避免测试悄悄放过新增的 SQL 分支。
 */
function fakeDb(rows: Row[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              const id = String(args[0] ?? "");
              if (sql.includes("SELECT role, status")) {
                return rows.find((row) => row.id === id) ?? null;
              }
              if (sql.includes("COUNT(*)")) {
                return {
                  total: rows.filter(
                    (row) => row.role === "admin" && row.status === "active" && row.id !== id,
                  ).length,
                };
              }
              throw new Error(`unexpected sql: ${sql}`);
            },
          };
        },
      };
    },
  };
}

const run = (rows: Row[], userId: string) =>
  isLastActiveAdmin(fakeDb(rows) as never, userId);

describe("最后一名管理员判定", () => {
  it("唯一活跃管理员 → 拒绝注销", async () => {
    await expect(run([{ id: "u1", role: "admin", status: "active" }], "u1")).resolves.toBe(true);
  });

  it("还有第二名活跃管理员 → 允许注销", async () => {
    await expect(
      run(
        [
          { id: "u1", role: "admin", status: "active" },
          { id: "u2", role: "admin", status: "active" },
        ],
        "u1",
      ),
    ).resolves.toBe(false);
  });

  it("普通成员 → 不受该护栏限制", async () => {
    await expect(
      run(
        [
          { id: "u1", role: "member", status: "active" },
          { id: "u2", role: "admin", status: "active" },
        ],
        "u1",
      ),
    ).resolves.toBe(false);
  });

  it("管理员自己已被禁用 → 不算活跃管理员", async () => {
    await expect(run([{ id: "u1", role: "admin", status: "disabled" }], "u1")).resolves.toBe(false);
  });

  it("另一名管理员已禁用 → 仍视为最后一名可登录管理员", async () => {
    await expect(
      run(
        [
          { id: "u1", role: "admin", status: "active" },
          { id: "u2", role: "admin", status: "disabled" },
        ],
        "u1",
      ),
    ).resolves.toBe(true);
  });

  it("账号不存在 → 不拦截（交给上游会话校验）", async () => {
    await expect(run([], "ghost")).resolves.toBe(false);
  });
});
