import { describe, expect, it } from "vitest";
import { adminReviewReport } from "../../worker/api/community/admin.js";

const REPORT_ID = "6f0b3a1e-1111-4a2b-9c3d-1234567890ab";
const COMMENT_ID = "6f0b3a1e-2222-4a2b-9c3d-1234567890ab";
const POST_ID = "6f0b3a1e-3333-4a2b-9c3d-1234567890ab";

interface Run {
  sql: string;
  args: unknown[];
}
interface Statement {
  __sql: string;
  __args: unknown[];
  first(): Promise<unknown>;
  run(): Promise<{ meta: { changes: number } }>;
  all(): Promise<{ results: unknown[] }>;
}

function fakeDb() {
  const runs: Run[] = [];
  const batches: Statement[][] = [];
  const db = {
    runs,
    batches,
    first(sql: string): unknown {
      if (sql.includes("FROM community_reports")) {
        return { id: REPORT_ID, target_type: "comment", target_id: COMMENT_ID, status: "open" };
      }
      if (sql.includes("FROM community_comments")) {
        return { id: COMMENT_ID, user_id: "user-1", post_id: POST_ID, status: "visible" };
      }
      return null;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]): Statement {
          return {
            __sql: sql,
            __args: args,
            async first() {
              return db.first(sql);
            },
            async run() {
              runs.push({ sql, args });
              return { meta: { changes: 1 } };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements: Statement[]) {
      batches.push(statements);
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return db;
}

function reviewRequest(action: string, resolution: string): Request {
  return new Request("https://guandao.xin/api/community/admin/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, resolution }),
  });
}

/** 2.0.9 回归：隐藏评论时要把同一评论上所有 open 举报一起结算。 */
describe("举报处理 · 隐藏评论", () => {
  it("按评论目标批量结算，而不是只改当前这一条举报", async () => {
    const env = { DB: fakeDb() };
    const viewer = { id: "admin-1", role: "admin" };
    const response = await adminReviewReport({
      env,
      request: reviewRequest("hide_comment", "包含人身攻击"),
      viewer,
      id: REPORT_ID,
    });
    const body = (await response.json()) as { success: boolean; data: { message: string } };
    expect(body.success).toBe(true);
    expect(body.data.message).toBe("评论已隐藏");

    const db = env.DB as unknown as ReturnType<typeof fakeDb>;
    const flat = db.batches.flat();
    const reportSettlement = flat.find((statement) => statement.__sql.includes("UPDATE community_reports"));
    expect(reportSettlement).toBeTruthy();
    expect(reportSettlement?.__sql).toContain("target_type = 'comment'");
    expect(reportSettlement?.__sql).toContain("status IN ('open', 'reviewing')");
    expect(reportSettlement?.__sql).not.toMatch(/WHERE id = \?$/);
    expect(reportSettlement?.__args[3]).toBe(COMMENT_ID);

    const commentHide = flat.find((statement) => statement.__sql.includes("UPDATE community_comments"));
    expect(commentHide?.__args[1]).toBe(COMMENT_ID);
  });
});