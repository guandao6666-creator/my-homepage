/**
 * Phase 5 · Tutorials E2E（真实 Worker + 本地 D1/R2）
 *
 * 覆盖的是教程（`community_posts.post_type = 'tutorial'` +
 * `community_packages.package_type = 'tutorial'`）从草稿到公开的完整状态机：
 *
 *   创作者（installer）创建 tutorial 草稿 → 非作者仅 404 →
 *   创作者 publish → pending_review（本地 require_review=1）→ 访客 feed/search 不可见 →
 *   管理员审核队列可见 → admin approve → 公开 feed/search/详情可见 →
 *   详情返回内容包摘要、package 返回 configuration.content 且客户端渲染器转义 →
 *   explore 按 tutorial type + guide 分类过滤 → 重复 approve 按真实契约 400 →
 *   admin hide 后公开 404 → 创作者删除清理。
 *
 * 另外单独一组用例验证服务端权威校验：未知类型 / 未知分类 / 未知配置字段 /
 * 超 20000 字 / 内容包类型不一致 / script 标签全部 400，且不会留下作品行。
 *
 * 不做的事：不碰生产 API、不加表、不重写社区 UI、不写真实用户数据。
 * 夹具账号全部是 `scripts/e2e-server.mjs` 造的 `qa-p3-*` 本地行。
 */
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

import { renderMarkdown } from "../../src/lib/os14/core";
import { API_BASE, waitForFixtures } from "./support/worker-api";

/** 每轮唯一标识：避免与上一次运行 / 其他 E2E 的标题、packageId 冲突。 */
const RUN_ID = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TITLE = `QA 教程 ${RUN_ID}`;
const PACKAGE_ID = `qa-tutorial-${RUN_ID}`;

/**
 * 教程正文：既有正常 Markdown，也带两个「能通过服务端校验、只能靠渲染器转义」的样本。
 * 服务端只拒绝 script/iframe/object/embed/style/link/meta 标签，
 * `<img onerror>` 与 `javascript:` Markdown 链接要求 renderMarkdown 不许把它们当 HTML 放行。
 */
const TUTORIAL_CONTENT = [
  `# 教程 ${RUN_ID}`,
  "",
  "本教程只用于本地 E2E，不会安装任何内容。",
  "",
  "## 步骤",
  "",
  "1. 打开设置",
  "2. 应用主题",
  "",
  "**提示**：先备份，再操作。",
  "",
  "参考 [官网文档](https://example.com/docs)。",
  "",
  "<img src=x onerror=alert(1)>",
  "[危险链接](javascript:alert(1))",
  "",
  "完成。",
].join("\n");

type ApiResult = { status: number; body: any };

type TutorialManifest = Record<string, any>;

function tutorialManifest(overrides: Record<string, any> = {}): TutorialManifest {
  return {
    schemaVersion: 1,
    packageId: PACKAGE_ID,
    type: "tutorial",
    name: TITLE,
    version: "1.0.0",
    author: "qa-installer",
    description: "Tutorials E2E 内容包",
    compatibility: { minimum: "1.3.0" },
    license: "CC-BY-4.0",
    configuration: { content: TUTORIAL_CONTENT },
    ...overrides,
  };
}

/** 独立 browser context + 夹具 session cookie（服务端只认 gauth_sid）。 */
async function sessionContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "gauth_sid", value: token, url: API_BASE }]);
  return context;
}

/**
 * 走 context.request：共享该 context 的 Cookie 存储，同时显式补 Origin
 * （Playwright 的 request 不会自动带 Origin，而后台写接口会校验同源）。
 */
async function call(
  context: BrowserContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<ApiResult> {
  const response = await context.request.fetch(`${API_BASE}${path}`, {
    method,
    headers: { Origin: API_BASE, Accept: "application/json" },
    data: data === undefined ? undefined : data,
    timeout: 20_000,
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status(), body };
}

function expectOk(result: ApiResult, expected = 200): any {
  if (result.status !== expected) {
    throw new Error(`期望 HTTP ${expected}，实际 ${result.status}：${JSON.stringify(result.body).slice(0, 800)}`);
  }
  expect(result.body?.success).toBe(true);
  return result.body.data;
}

function expectFail(result: ApiResult, expected: number): any {
  if (result.status !== expected) {
    throw new Error(`期望 HTTP ${expected}，实际 ${result.status}：${JSON.stringify(result.body).slice(0, 800)}`);
  }
  expect(result.body?.success).toBe(false);
  expect(typeof result.body?.error?.code).toBe("string");
  return result.body.error;
}

function containsPost(items: any[], postId: string): boolean {
  return items.some((item) => item?.id === postId);
}

/** 待审核队列可能因历史运行积累多页，按 page 翻到找到为止。 */
async function findInReviewQueue(admin: BrowserContext, postId: string): Promise<any | null> {
  for (const page of [1, 2, 3, 4]) {
    const result = await call(admin, "GET", `/api/community/admin/queue?status=pending_review&limit=40&page=${page}`);
    const data = expectOk(result, 200);
    const found = (data.items as any[]).find((item) => item.id === postId);
    if (found) return found;
    if ((data.items as any[]).length < 40) return null;
  }
  return null;
}

/** 公开 feed / search 命中检查。 */
async function publicVisibility(visitor: BrowserContext, postId: string) {
  const feed = expectOk(
    await call(visitor, "GET", "/api/community/feed?tab=latest&type=tutorial&limit=48"),
    200,
  );
  const search = expectOk(
    await call(visitor, "GET", `/api/community/search?q=${encodeURIComponent(RUN_ID)}&limit=48`),
    200,
  );
  const detail = await call(visitor, "GET", `/api/community/posts/${postId}`);
  return {
    inFeed: containsPost(feed.items, postId),
    inSearch: containsPost(search.items, postId),
    detailStatus: detail.status,
    detailBody: detail.body,
  };
}

test.describe("Guandao Community · Tutorials", () => {
  test.setTimeout(120_000);

  test("tutorial 草稿 → 审核 → 公开 → 隐藏全链路（真实 Worker）", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    const outsider = await sessionContext(browser, fixtures.tokens.outsider);
    const visitor = await browser.newContext();
    let postId = "";

    try {
      /* ---------- 1. 创作者创建 tutorial 草稿 ---------- */
      const created = expectOk(
        await call(creator, "POST", "/api/community/posts", {
          type: "tutorial",
          title: TITLE,
          description: `教程 E2E 介绍 ${RUN_ID}`,
          category: "guide",
          license: "CC-BY-4.0",
          rightsConfirmed: true,
          publish: false,
          manifest: tutorialManifest(),
        }),
        201,
      );
      postId = created.post.id;
      expect(typeof postId).toBe("string");
      expect(created.status).toBe("draft");
      expect(created.packageWritten).toBe(false);
      expect(created.post.type).toBe("tutorial");
      expect(created.post.status).toBe("draft");
      expect(created.post.category).toBe("guide");

      const ownerDraft = expectOk(await call(creator, "GET", `/api/community/posts/${postId}`), 200);
      expect(ownerDraft.package).toBeNull();
      expect(ownerDraft.post.draftManifest?.configuration?.content).toBe(TUTORIAL_CONTENT);
      expect(ownerDraft.viewer.isOwner).toBe(true);

      /* ---------- 2. 非作者不可见 / 不可改 ---------- */
      expectFail(await call(outsider, "GET", `/api/community/posts/${postId}`), 404);
      expectFail(await call(outsider, "PATCH", `/api/community/posts/${postId}`, { title: "被篡改的标题" }), 404);
      expectFail(await call(outsider, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true }), 404);
      // 未登录访客同样看不到草稿
      expectFail(await call(visitor, "GET", `/api/community/posts/${postId}`), 404);

      let visibility = await publicVisibility(visitor, postId);
      expect(visibility.inFeed).toBe(false);
      expect(visibility.inSearch).toBe(false);
      expect(visibility.detailStatus).toBe(404);

      /* ---------- 3. 创作者 publish → pending_review ---------- */
      const published = expectOk(
        await call(creator, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true }),
        200,
      );
      expect(published.post.status).toBe("pending_review");
      expect(published.version).toBe("1.0.0");
      expect(published.wroteNewVersion).toBe(true);

      // 发布后草稿内容包必须清空（不能把 draft_manifest 泄漏给非作者，也不该继续挂在自己详情里）
      const ownerAfterPublish = expectOk(await call(creator, "GET", `/api/community/posts/${postId}`), 200);
      expect(ownerAfterPublish.post.status).toBe("pending_review");
      expect(ownerAfterPublish.post.draftManifest).toBeUndefined();
      expect(ownerAfterPublish.package).toMatchObject({ version: "1.0.0", type: "tutorial" });

      // 待审核状态对公众不可见
      visibility = await publicVisibility(visitor, postId);
      expect(visibility.inFeed).toBe(false);
      expect(visibility.inSearch).toBe(false);
      expect(visibility.detailStatus).toBe(404);

      /* ---------- 4. 管理员审核队列可见 → approve ---------- */
      const queued = await findInReviewQueue(admin, postId);
      expect(queued, "待审核队列应包含刚提交的教程").toBeTruthy();
      expect(queued.type).toBe("tutorial");
      expect(queued.category).toBe("guide");

      const approved = expectOk(
        await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }),
        200,
      );
      expect(approved.post.status).toBe("published");

      /* ---------- 5. 公开 feed / search / 详情 / package ---------- */
      visibility = await publicVisibility(visitor, postId);
      expect(visibility.inFeed).toBe(true);
      expect(visibility.inSearch).toBe(true);
      expect(visibility.detailStatus).toBe(200);

      const publicDetail = visibility.detailBody.data;
      expect(publicDetail.post.id).toBe(postId);
      expect(publicDetail.post.type).toBe("tutorial");
      expect(publicDetail.post.status).toBe("published");
      expect(publicDetail.post.title).toBe(TITLE);
      expect(publicDetail.post.draftManifest).toBeUndefined();
      expect(publicDetail.viewer.isOwner).toBe(false);
      expect(publicDetail.package).toMatchObject({ version: "1.0.0", type: "tutorial" });
      expect(publicDetail.package.checksum).toMatch(/^[0-9a-f]{64}$/);

      // feed 返回的教程条目类型正确
      const feed = expectOk(
        await call(visitor, "GET", "/api/community/feed?tab=latest&type=tutorial&limit=48"),
        200,
      );
      const feedItem = feed.items.find((item: any) => item.id === postId);
      expect(feedItem?.type).toBe("tutorial");
      expect(feedItem?.category).toBe("guide");

      // 详情对应的内容包：configuration.content 原样返回，客户端 renderMarkdown 负责转义
      const pkgResult = expectOk(await call(visitor, "GET", `/api/community/posts/${postId}/package`), 200);
      expect(pkgResult.type).toBe("tutorial");
      expect(pkgResult.version).toBe("1.0.0");
      const pkgManifest = JSON.parse(pkgResult.packageJson);
      expect(pkgManifest.type).toBe("tutorial");
      expect(pkgManifest.configuration.content).toBe(TUTORIAL_CONTENT);
      // 服务端不做 HTML 编码（JSON 原样），不允许把内容当 HTML 直出的是渲染层
      expect(pkgManifest.configuration.content).toContain("<img src=x onerror=alert(1)>");

      const rendered = renderMarkdown(pkgManifest.configuration.content);
      expect(rendered).toContain(`教程 ${RUN_ID}`);
      expect(rendered).toContain("<h3>");
      expect(rendered).toContain("<h4>");
      expect(rendered).toContain("<strong>提示</strong>");
      expect(rendered).toContain('href="https://example.com/docs"');
      // `<img onerror>` 只能作为转义文本出现
      expect(rendered).not.toContain("<img");
      expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
      // javascript: 伪协议不会生成链接
      expect(rendered).not.toContain('href="javascript:');
      expect(rendered).not.toContain("javascript:alert(1)</a>");

      // 普通读取 package 不应增加下载数（count 只在显式下载路径传 1）
      expect(publicDetail.post.downloadCount).toBe(0);
      const counted = expectOk(
        await call(visitor, "GET", `/api/community/posts/${postId}/package?count=1`),
        200,
      );
      expect(counted.version).toBe("1.0.0");
      const detailAfterDownload = expectOk(await call(visitor, "GET", `/api/community/posts/${postId}`), 200);
      expect(detailAfterDownload.post.downloadCount).toBe(1);

      // 分类筛选：explore 的 type=tutorial + category=guide 只返回教程
      const explore = expectOk(
        await call(visitor, "GET", "/api/community/explore?type=tutorial&category=guide&limit=48"),
        200,
      );
      expect(explore.items.length).toBeGreaterThan(0);
      for (const item of explore.items) {
        expect(item.type).toBe("tutorial");
        expect(item.category).toBe("guide");
      }
      expect(containsPost(explore.items, postId)).toBe(true);

      const wrongCategory = expectOk(
        await call(visitor, "GET", "/api/community/explore?type=tutorial&category=tip&limit=48"),
        200,
      );
      expect(containsPost(wrongCategory.items, postId)).toBe(false);

      /* ---------- 6. 重复 approve 按真实契约 400，且不破坏已公开状态 ---------- */
      const again = expectFail(
        await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }),
        400,
      );
      expect(again.message).toContain("当前状态不能通过审核");
      const stillPublic = expectOk(await call(visitor, "GET", `/api/community/posts/${postId}`), 200);
      expect(stillPublic.post.status).toBe("published");
      expect(stillPublic.post.title).toBe(TITLE);

      /* ---------- 7. admin hide → 公开侧 404 / feed / search 消失；作者仍可见 ---------- */
      const hidden = expectOk(
        await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "hide" }),
        200,
      );
      expect(hidden.post.status).toBe("hidden");

      const afterHide = await publicVisibility(visitor, postId);
      expect(afterHide.detailStatus).toBe(404);
      expect(afterHide.inFeed).toBe(false);
      expect(afterHide.inSearch).toBe(false);

      const ownerHidden = expectOk(await call(creator, "GET", `/api/community/posts/${postId}`), 200);
      expect(ownerHidden.post.status).toBe("hidden");
      expect(ownerHidden.viewer.isOwner).toBe(true);
    } finally {
      /* ---------- 8. 清理：作者删除（qa-p3-* 行，不涉及真实数据） ---------- */
      if (postId) {
        const deleted = await call(creator, "DELETE", `/api/community/posts/${postId}`);
        if (deleted.status === 200) {
          const afterDelete = await call(visitor, "GET", `/api/community/posts/${postId}`);
          expect(afterDelete.status).toBe(404);
        }
      }
      await Promise.all([creator.close(), admin.close(), outsider.close(), visitor.close()]);
    }
  });

  test("tutorial 服务端权威校验：类型/分类/配置字段/长度/HTML 标签", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);

    const base = {
      type: "tutorial",
      title: `QA 校验 ${RUN_ID}`,
      description: "教程校验用例",
      category: "guide",
      license: "CC-BY-4.0",
      rightsConfirmed: false,
      publish: false,
    };

    try {
      const cases: Array<{ name: string; body: Record<string, any>; message: string }> = [
        {
          name: "未知作品类型",
          body: { ...base, type: "podcast", manifest: tutorialManifest() },
          message: "请选择合法的发布类型",
        },
        {
          name: "未知分类",
          body: { ...base, category: "not-a-category", manifest: tutorialManifest() },
          message: "分类不在允许范围内",
        },
        {
          name: "内容包类型与作品类型不一致",
          body: { ...base, manifest: tutorialManifest({ type: "theme" }) },
          message: "内容包类型 theme 与作品类型 tutorial 不一致",
        },
        {
          name: "未知配置字段",
          body: {
            ...base,
            manifest: tutorialManifest({ configuration: { content: "合法正文", extra: true } }),
          },
          message: "不支持的字段「extra」",
        },
        {
          name: "超过 20000 字的正文",
          body: {
            ...base,
            manifest: tutorialManifest({ configuration: { content: "字".repeat(20_001) } }),
          },
          message: "20000",
        },
        {
          name: "正文夹带 script 标签",
          body: {
            ...base,
            manifest: tutorialManifest({ configuration: { content: "正文 <script>alert(1)</script>" } }),
          },
          message: "HTML 标签",
        },
      ];

      for (const item of cases) {
        const result = await call(creator, "POST", "/api/community/posts", item.body);
        const error = expectFail(result, 400);
        expect(error.message, item.name).toContain(item.message);
      }

      // 这些请求全部失败，不应污染创作列表
      const mine = expectOk(await call(creator, "GET", "/api/community/me/creations?limit=48"), 200);
      expect((mine.items as any[]).some((post) => post.title === base.title)).toBe(false);
    } finally {
      await creator.close();
    }
  });
});
