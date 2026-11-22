/**
 * 2.0.7 · 审核动作 × 作品状态
 *
 * 2.0.6 的审计发现：审核员可以把作者主动撤回的 draft 重新“通过”公开。
 * 这里用纯函数穷举每个动作在每个状态下的结果，防止服务端又退回“只要不是
 * published 就允许”的宽口径。UI 的按钮渲染也做源码断言：draft 不再出现“通过”。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { checkReviewTransition } from "../../worker/api/community/review-policy.js";
import { adminReviewPost } from "../../worker/api/community/admin.js";

const APPROVE_OK = ["pending_review", "rejected"];
const RESTORE_OK = ["hidden"];
const ALL = ["draft", "pending_review", "published", "hidden", "rejected", "deleted"];

describe("审核动作的合法状态组合", () => {
  it("approve 只放行待审核与未通过", () => {
    for (const status of ALL) {
      const result = checkReviewTransition("approve", status);
      expect(result.ok, `approve × ${status}`).toBe(APPROVE_OK.includes(status));
    }
  });

  it("restore 只放行已隐藏", () => {
    for (const status of ALL) {
      const result = checkReviewTransition("restore", status);
      expect(result.ok, `restore × ${status}`).toBe(RESTORE_OK.includes(status));
    }
  });

  it("draft 给出“作者已撤回”的明确文案，而不是笼统的“不能通过审核”", () => {
    for (const action of ["approve", "restore"]) {
      const result = checkReviewTransition(action, "draft");
      expect(result.ok).toBe(false);
      const message = result.ok ? "" : result.message;
      expect(message).toContain("作者已撤回");
      expect(message).toContain("重新提交审核");
    }
  });

  it("deleted 一律拒绝，文案为“作品已删除”", () => {
    for (const action of ["approve", "restore"]) {
      const result = checkReviewTransition(action, "deleted");
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toBe("作品已删除");
    }
  });

  it("unknown action 不拦截（其它动作走各自分支）", () => {
    expect(checkReviewTransition("reject", "pending_review")).toEqual({ ok: true });
  });
});

describe("审核中心的按钮渲染", () => {
  const source = readFileSync("src/lib/os14/community/moderation.ts", "utf8");

  it("draft 不渲染“通过”，hidden 渲染“恢复”", () => {
    expect(source).toContain('["pending_review", "rejected"].includes(post.status)');
    expect(source).toContain('data-action="review-restore"');
    expect(source).toContain('data-action="review-approve"');
    // 旧实现的宽口径：非 published 就给“通过”
    expect(source).not.toContain('post.status !== "published" ? `<button class="cx-btn is-small is-primary" type="button" data-action="review-approve"');
  });

  it("前端把“恢复”映射到 restore 动作", () => {
    const page = readFileSync("src/lib/os14/community.ts", "utf8");
    expect(page).toContain('case "review-restore"');
    expect(page).toMatch(/reviewModeration\(actionEl\.dataset\.id, "restore"\)/);
  });
});

describe("adminReviewPost 真的拦截 draft", () => {
  it("审核员对 draft 执行 approve → 400 且提示作者已撤回", async () => {
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/FROM community_posts WHERE id = \?/.test(sql)) {
              return { id: "b7d0c3d2-2222-4c33-8a44-555566667777", author_id: "author-1", status: "draft", title: "撤回的作品" };
            }
            return null;
          },
          async run() {
            return { success: true, meta: { changes: 0 } };
          },
        };
        return statement;
      },
    };
    const request = new Request("http://127.0.0.1:8788/api/community/admin/posts/b7d0c3d2-2222-4c33-8a44-555566667777/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", note: "" }),
    });
    const viewer = { id: "moderator-1", role: "moderator", staff: true };

    await expect(adminReviewPost({ env: { DB: db }, request, viewer, id: "b7d0c3d2-2222-4c33-8a44-555566667777" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("作者已撤回"),
    });
  });
});