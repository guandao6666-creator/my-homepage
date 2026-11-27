import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertAuthorPublishAllowed } from "../../worker/api/community/write.js";

/** 2.0.9 回归：被版主下架的作品不能被作者自己重新发布。 */
describe("作者重新发布的状态闸门", () => {
  it("hidden 状态直接拒绝，并给作者可读的说明", () => {
    let error: unknown = null;
    try {
      assertAuthorPublishAllowed("hidden");
    } catch (err) {
      error = err;
    }
    const apiError = error as { code?: string; status?: number; message?: string } | null;
    expect(apiError?.code).toBe("POST_HIDDEN");
    expect(apiError?.status).toBe(409);
    expect(apiError?.message).toContain("不能自行重新发布");
  });

  it("草稿、待审核、未通过、已发布仍然可走原发布流程", () => {
    for (const status of ["draft", "pending_review", "rejected", "published"]) {
      expect(() => assertAuthorPublishAllowed(status)).not.toThrow();
    }
  });

  it("publishPost 在读取清单前先调用闸门（避免作者触发后续写库）", () => {
    const source = readFileSync("worker/api/community/write.js", "utf8");
    const start = source.indexOf("export async function publishPost");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\nexport async function", start + 10));
    const gate = body.indexOf("assertAuthorPublishAllowed(row.status);");
    const manifest = body.indexOf("validateManifest");
    expect(gate).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(0);
    expect(gate).toBeLessThan(manifest);
  });
});