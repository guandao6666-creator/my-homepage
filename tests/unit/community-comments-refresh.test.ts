import { beforeEach, describe, expect, it, vi } from "vitest";

const getComments = vi.fn();

vi.mock("../../src/lib/community/api", () => ({
  getComments: (...args: unknown[]) => getComments(...args),
  renderComments: undefined,
}));

import { refreshCommentsImpl } from "../../src/lib/os14/community/detail";
import type { CommunityContext } from "../../src/lib/os14/community/context";

// renderComment 会读 status/author/createdAt/content/replies，假数据必须给全，
// 否则测的是夹具缺字段而不是评论刷新本身。
const comment = (id: string, content = "hi") => ({
  id,
  status: "published",
  author: { displayName: "测试", role: "member" },
  createdAt: Date.UTC(2026, 10, 22),
  content,
  canDelete: false,
  replies: [],
});
const page1 = (items: unknown[]) => ({ total: items.length, items, limit: 12, page: 1, hasMore: false });

type Cache = {
  data: { post: { id: string } };
  comments: unknown;
  commentsPage: number;
};

function makeCtx(cache: Cache | null, panel: { innerHTML: string }) {
  return {
    getDetailCache: () => cache,
    win: { querySelector: () => panel },
  } as unknown as CommunityContext;
}

describe("评论面板刷新", () => {
  beforeEach(() => {
    getComments.mockReset();
  });

  it("同作品返回时写入缓存与面板", async () => {
    const cache: Cache = { data: { post: { id: "post-a" } }, comments: null, commentsPage: 0 };
    const panel = { innerHTML: "" };
    getComments.mockResolvedValue(page1([comment("c1")]));

    await refreshCommentsImpl(makeCtx(cache, panel), 2);

    expect(cache.commentsPage).toBe(2);
    expect(panel.innerHTML.length).toBeGreaterThan(0);
  });

  it("await 期间切到别的作品：A 的评论不写进 B", async () => {
    const cacheA: Cache = { data: { post: { id: "post-a" } }, comments: null, commentsPage: 0 };
    const cacheB: Cache = { data: { post: { id: "post-b" } }, comments: null, commentsPage: 0 };
    const panel = { innerHTML: "" };

    let release!: (value: unknown) => void;
    getComments.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const ctx = {
      // 第一次读取是 A，请求返回后第二次读取已经是 B
      getDetailCache: vi.fn().mockReturnValueOnce(cacheA).mockReturnValueOnce(cacheB),
      win: { querySelector: () => panel },
    } as unknown as CommunityContext;

    const pending = refreshCommentsImpl(ctx, 2);
    release(page1([comment("c-a", "A 的评论")]));
    await pending;

    expect(cacheA.comments).toBeNull();
    expect(cacheB.comments).toBeNull();
    expect(panel.innerHTML).toBe("");
  });
});