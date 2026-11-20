/**
 * 2.0.1 · P1-8 回归：社区搜索结果里点作品卡片必须打开详情（真实 Worker + 真实 UI）
 *
 * 缺陷回顾（2.0.0）：
 *   社区根节点上的 click 代理把「分页」放在最前面，用裸选择器
 *   `target.closest("[data-page]")` 找分页按钮；而 OS 外壳会把
 *   `data-page="desktop"` 写到 `<html>` 上（src/lib/shell/adaptive.ts:141），
 *   于是**任何没有被前面分支接住的点击**（卡片封面、标题、空白）都会命中
 *   `<html>` 被判成翻页：`Number("desktop") || 1` → 重新加载列表第 1 页，
 *   `openPostFromEvent` 根本轮不到执行，看起来就是「点卡片没反应，还跳走了」。
 *
 * 本用例锁两件事：
 *   1. 搜索 → 点卡片 → 详情（`.cx-detail-hero h1` 是作品标题，列表页没有这个节点）；
 *   2. 搜索 → 点结果区里的**非交互文字**（空白/说明文字）→ 仍停在搜索结果，
 *      不会被 <html data-page="desktop"> 带去发现页。
 *
 * 数据全部来自本地夹具账号（`qa-p3-*`）与本地 D1/R2，不碰生产。
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { API_BASE, waitForFixtures } from "./support/worker-api";

const RUN_ID = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TITLE = `QA 点击回归 ${RUN_ID}`;
const DESCRIPTION = `P1-8 点击回归样本 ${RUN_ID}`;

const TUTORIAL_CONTENT = [
  `# 点击回归 ${RUN_ID}`,
  "",
  "这条教程只用于本地 E2E。",
  "1. 搜索",
  "2. 点卡片",
  "3. 看到详情",
].join("\n");

type ApiResult = { status: number; body: any };

function tutorialManifest(packageId: string): Record<string, any> {
  return {
    schemaVersion: 1,
    packageId,
    type: "tutorial",
    name: TITLE,
    version: "1.0.0",
    author: "qa-installer",
    description: DESCRIPTION,
    compatibility: { minimum: "1.3.0" },
    license: "CC-BY-4.0",
    configuration: { content: TUTORIAL_CONTENT },
  };
}

/**
 * 同一文件里的两个用例必须用**不同的 packageId**：
 * 发布过的 packageId 在 D1 里会被永久占用（删除只把作品/内容包标成 deleted，
 * `assertPackageIdAvailable` 不看状态），共用一个会得到 409 PACKAGE_ID_TAKEN。
 */
const packageIds = {
  openDetail: `qa-click-${RUN_ID}-open`,
  blankClick: `qa-click-${RUN_ID}-blank`,
} as const;

/** 独立 context + 夹具 session cookie（服务端只认 gauth_sid）。 */
async function sessionContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "gauth_sid", value: token, url: API_BASE }]);
  return context;
}

/** 走 context.request：共享 Cookie，同时补上浏览器本来就会发的 Origin。 */
async function call(
  context: BrowserContext,
  method: "GET" | "POST" | "DELETE",
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

/** 起桌面、跳过首次启动引导（引导本身由 os20.spec.ts 覆盖）。 */
async function bootDesktop(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#os")).toBeVisible();
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 15_000 });
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.click();
    await page.waitForFunction(() => !document.querySelector(".os20-onb"), null, { timeout: 10_000 });
  }
}

/** 打开社区应用并等到可交互。 */
async function openCommunity(page: Page) {
  await page.evaluate(() => (window as any).GOS14.ctx.openApp("community"));
  const win = page.locator('.window[data-app="community"]');
  await expect(win).toBeVisible({ timeout: 15_000 });
  await expect(win.locator("[data-cx-body]")).toBeVisible({ timeout: 15_000 });
  // 首屏加载完成（骨架屏消失）后才操作搜索，避免与初始 loadHome 抢 body。
  await expect(win.locator("[data-cx-body] .cx-loading")).toHaveCount(0, { timeout: 20_000 });
  return win;
}

/** 搜索 RUN_ID，返回结果卡片。 */
async function searchPost(win: ReturnType<Page["locator"]>, postId: string) {
  await win.locator("[data-cx-search]").fill(RUN_ID);
  await win.locator('[data-action="search"]').click();
  const card = win.locator(`[data-post="${postId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(win.locator(".cx-page-head h1")).toContainText(RUN_ID);
  return card;
}

test.describe("P1-8 · 社区搜索点击回归", () => {
  test.setTimeout(120_000);

  test("搜索 → 点作品卡片 → 打开详情", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      /* ---------- 1. 造一条已公开的作品（草稿 → 发布 → 审核通过） ---------- */
      const created = expectOk(
        await call(creator, "POST", "/api/community/posts", {
          type: "tutorial",
          title: TITLE,
          description: DESCRIPTION,
          category: "guide",
          license: "CC-BY-4.0",
          rightsConfirmed: true,
          publish: false,
          manifest: tutorialManifest(packageIds.openDetail),
        }),
        201,
      );
      postId = created.post.id;

      expectOk(await call(creator, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true }), 200);
      expectOk(await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }), 200);

      /* ---------- 2. 真实 UI：搜索 → 点卡片 ---------- */
      const page = await creator.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await bootDesktop(page);
      const win = await openCommunity(page);
      const card = await searchPost(win, postId);

      // 点卡片本体（不是封面里的按钮）：2.0.0 上这一步会被 <html data-page> 抢走
      await card.click();

      /* ---------- 3. 必须进入详情，而不是被重画回列表/发现页 ---------- */
      await expect(win.locator(".cx-detail-hero")).toBeVisible({ timeout: 20_000 });
      await expect(win.locator(".cx-detail-hero h1")).toHaveText(TITLE);
      // 详情页独有的返回按钮也在
      await expect(win.locator('[data-action="back"]')).toBeVisible();
      // 结果卡片随之消失（详情视图没有列表）
      await expect(win.locator(`[data-post="${postId}"].cx-card`)).toHaveCount(0);
      expect(pageErrors, `页面异常：${pageErrors.join("\n")}`).toEqual([]);

      /* ---------- 4. 返回列表：详情消失、回到列表视图 ---------- */
      // 已知既有行为：搜索页打开详情后「返回」回到 lastTab，而不是搜索结果页；
      // 这里只要求「不再是详情」，避免把既有导航语义写成新契约。
      await win.locator('[data-action="back"]').click();
      await expect(win.locator(".cx-detail-hero")).toHaveCount(0, { timeout: 20_000 });
      // 首页 hero 与各列表页 head 是两套容器：前者 .cx-hero，后者 .cx-page-head。
      // 这里只认「回到了一个真正的列表/首页视图」，不把返回落到哪个 tab 写成契约。
      await expect(win.locator(".cx-hero, .cx-page-head").first()).toBeVisible();
    } finally {
      if (postId) {
        await call(creator, "DELETE", `/api/community/posts/${postId}`);
      }
      await Promise.all([creator.close(), admin.close()]);
    }
  });

  test("搜索结果里点非交互文字（空白）不会跳到发现页", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      const created = expectOk(
        await call(creator, "POST", "/api/community/posts", {
          type: "tutorial",
          title: TITLE,
          description: DESCRIPTION,
          category: "guide",
          license: "CC-BY-4.0",
          rightsConfirmed: true,
          publish: false,
          manifest: tutorialManifest(packageIds.blankClick),
        }),
        201,
      );
      postId = created.post.id;
      expectOk(await call(creator, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true }), 200);
      expectOk(await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }), 200);

      const page = await creator.newPage();
      await bootDesktop(page);
      const win = await openCommunity(page);
      await searchPost(win, postId);

      // 结果区标题下的统计文字是纯文本节点：旧逻辑会把它当成「翻页」目标。
      await win.locator(".cx-page-head p").last().click();

      await expect(win.locator(".cx-page-head h1")).toContainText(RUN_ID);
      // 没有被带去发现页
      await expect(win.locator(".cx-page-head h1")).not.toContainText("发现");
      await expect(win.locator(`[data-post="${postId}"]`)).toBeVisible();
    } finally {
      if (postId) {
        await call(creator, "DELETE", `/api/community/posts/${postId}`);
      }
      await Promise.all([creator.close(), admin.close()]);
    }
  });
});
