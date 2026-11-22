/**
 * 2.0.6 · 社区错误面板「重试」的分派回归
 *
 * 旧实现：`view.kind === "tab" ? loadHome() : loadDetail(view.id || "")` ——
 * 创作者页把创作者 id 当作品 id（404），搜索结果页传空串（404），
 * 用户看到「作品不存在」，点多少次都没用。
 *
 * 这段分派在 initCommunity 的闭包里，无法在单测里直接调用，所以用源码断言
 * 固定四个分支（detail / creator / search / tab），防止再退回两分支写法。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/lib/os14/community.ts", import.meta.url), "utf8");

describe("社区重试分派", () => {
  it("创作者页按 creator id 重载，不再当作品", () => {
    expect(source).toContain('view.kind === "creator") void loadCreator(view.id)');
    expect(source).not.toContain('loadDetail((view as { id?: string }).id || "")');
  });

  it("搜索结果页带原关键词重载", () => {
    expect(source).toContain('view.kind === "search") void loadSearch(view.q)');
  });

  it("tab 视图按当前 tab 恢复（探索/创作者/我的作品/首页）", () => {
    expect(source).toContain('loadExplore("")');
    expect(source).toContain("loadCreators()");
    expect(source).toContain('loadCreations("works")');
    expect(source).toContain("loadHome()");
  });
});