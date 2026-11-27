/**
 * 2.0.7 · 删除作品时的举报结算与“删除后又复活”的守卫
 *
 * 2.0.6 审计发现两处相连的漏洞：
 *   1. 作者删除作品时只改 post/package/asset，不结算 open 举报；
 *   2. 之后处理这些举报时，hide_post 会把 status 改回 hidden —— deleted 的作品“半复活”。
 *
 * 这里用假 D1 走一遍 deletePost，断言 batch 里确实带上了举报结算语句；
 * admin.js 的 deleted 守卫与 privacy 的票据顺序用源码断言（跨模块、无纯函数可抽）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deletePost } from "../../worker/api/community/write.js";

const POST_ID = "a1f0c3d2-1111-4c22-9b33-444455556666";
const AUTHOR_ID = "3f6f2a1c-8d4b-4f2e-9a77-6c1d5b8e0a01";

interface Statement {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): Statement;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
  all(): Promise<{ results: unknown[]; success: boolean }>;
}

describe("删除作品结算举报", () => {
  it("batch 里带上 community_reports 的 resolved 语句", async () => {
    const batches: Statement[] = [];
    const db = {
      prepare(sql: string) {
        const statement: Statement = {
          sql,
          args: [],
          bind(...args: unknown[]) {
            statement.args = args;
            return statement;
          },
          async first() {
            if (/WHERE p\.id = \?/.test(sql)) {
              return {
                id: POST_ID,
                author_id: AUTHOR_ID,
                post_type: "plugin",
                title: "测试作品",
                description: "d",
                category: "tools",
                tags_json: "[]",
                license: "MIT",
                visibility: "public",
                status: "published",
                version: "1.0.0",
                created_at: 1,
                updated_at: 1,
                like_count: 0,
                favorite_count: 0,
                comment_count: 0,
                download_count: 0,
                view_count: 0,
                report_count: 2,
              };
            }
            return null;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
          async all() {
            return { results: [], success: true };
          },
        };
        return statement;
      },
      async batch(statements: Statement[]) {
        batches.push(...statements);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    };

    const viewer = { id: AUTHOR_ID, role: "member", staff: false };
    const response = await deletePost({ env: { DB: db }, viewer, id: POST_ID });
    expect(response.status).toBe(200);

    const settlement = batches.find((statement) => /UPDATE community_reports/.test(statement.sql));
    expect(settlement, "删除时应当结算关联举报").toBeTruthy();
    expect(settlement!.sql).toContain("status = 'resolved'");
    expect(settlement!.sql).toContain("status IN ('open', 'reviewing')");
    expect(settlement!.args).toContain("作品已被删除");
    expect(settlement!.args).toContain(POST_ID);
    expect(settlement!.args).toContain(AUTHOR_ID);
  });

  it("处理举报时拒绝把 deleted 作品改回 hidden", () => {
    const source = readFileSync("worker/api/community/admin.js", "utf8");
    expect(source).toMatch(/if \(post\.status === "deleted"\) throw new ApiError\("NOT_FOUND", "作品已删除", 404\)/);
  });
});

describe("重新验证票据的消费顺序", () => {
  it("先做三条 409 前置检查，最后才消费票据", () => {
    const source = readFileSync("worker/api/privacy/handlers.js", "utf8");
    const activeBackup = source.indexOf('if (activeBackup) throw new ApiError("BACKUP_RUNNING"');
    const consume = source.indexOf("await consumeReauthTicket(env, ticket.id);");
    const markPending = source.indexOf("await markUserPendingDeletion(env, userId);");
    expect(activeBackup).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(activeBackup);
    expect(markPending).toBeGreaterThan(consume);
    // 只保留一处消费
    expect(source.split("await consumeReauthTicket(env, ticket.id);").length - 1).toBe(1);
  });
});