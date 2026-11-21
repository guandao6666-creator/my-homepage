/**
 * 2.0.2 · 社区审核链的真实浏览器证据（真实 Worker + 真实 UI）
 *
 * 2.0.1 的 STATUS 风险 2 写的是「管理员审核链异常分支（拒绝/撤回/超时）仍只有本地证据」，
 * 本轮把它补成可复现的界面链路：
 *   1. 管理员在审核中心点「拒绝」→ 作者「我的作品」里出现审核备注与「未通过」；
 *   2. 作者点「提交审核」→ 状态回到「待审核」；管理员点「通过」→ 公开搜索出现该作品；
 *   3. 举报 → 管理员在「举报处理」点「隐藏作品」→ 公开搜索消失；
 *      「已隐藏」队列点「通过（恢复）」→ 重新出现；
 *   4. 作者点「撤回」→ 作品变草稿、公开搜索消失。
 *
 * 为什么「隐藏已发布作品」走举报入口而不是审核队列：`adminQueueHandler` 只接受
 * pending_review / hidden / rejected / draft 四种状态（worker/api/community/admin.js:52），
 * 审核中心的筛选芯片也只有这四个（src/lib/os14/community/moderation.ts:46）。
 * 已发布作品在 UI 上的下架入口是「举报处理 → 隐藏作品」（community.ts:782），
 * 所以这里先由另一个账号举报，再让管理员从举报队列执行，和真实运营路径一致。
 *
 * 所有写操作都打到本地真实 Worker（`wrangler dev --local` + 本地 D1/R2），页面与接口读的是
 * 同一份数据；没有 mock、没有预置 HTML，断言的也是真实浏览器渲染出来的 DOM。
 *
 * 关于「超时」分支：服务端没有审核 TTL/自动过期逻辑（`worker/api/community/admin.js` 与
 * `write.js` 里没有定时降级/超时状态），所以不存在可测的「超时」状态。这里按「无此分支」
 * 如实记录，而不是造一个假的超时用例。
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { API_BASE, waitForFixtures } from "./support/worker-api";

const RUN_ID = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TITLE = `QA 审核链回归 ${RUN_ID}`;
const DESCRIPTION = `2.0.2 审核链样本 ${RUN_ID}`;
const REJECT_NOTE = `审核备注 ${RUN_ID}：标题需要更具体`;
const HIDE_NOTE = `隐藏备注 ${RUN_ID}：内容复查中`;

const TUTORIAL_CONTENT = [`# 审核链 ${RUN_ID}`, "", "这条教程只用于本地 E2E。"].join("\n");

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
 * 每个用例用独立 packageId：删除只把作品/内容包标成 deleted，
 * `assertPackageIdAvailable` 不看状态，package_id 会被永久占用（409 PACKAGE_ID_TAKEN）。
 */
const packageIds = {
  rejectFlow: `qa-review-${RUN_ID}-reject`,
  reportHideFlow: `qa-review-${RUN_ID}-report`,
  withdrawFlow: `qa-review-${RUN_ID}-withdraw`,
  permission: `qa-review-${RUN_ID}-perm`,
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

/** 公开搜索命中数（服务端 `total`），用来证明「公开/不公开」而不是页面缓存。 */
async function searchTotal(context: BrowserContext): Promise<number> {
  const data = expectOk(
    await call(context, "GET", `/api/community/search?q=${encodeURIComponent(RUN_ID)}`),
  );
  return Number(data.total || 0);
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

/** 打开社区应用并等到可交互（首屏骨架消失）。 */
async function openCommunity(page: Page) {
  await page.evaluate(() => (window as any).GOS14.ctx.openApp("community"));
  const win = page.locator('.window[data-app="community"]');
  await expect(win).toBeVisible({ timeout: 15_000 });
  await expect(win.locator("[data-cx-body]")).toBeVisible({ timeout: 15_000 });
  await expect(win.locator("[data-cx-body] .cx-loading")).toHaveCount(0, { timeout: 20_000 });
  return win;
}

/** 点侧栏分区，并等到该分区的页面标题出现（正文已换完）。 */
async function navTo(win: ReturnType<Page["locator"]>, tab: string, heading: string) {
  await win.locator(`.g14-nav[data-tab="${tab}"]`).click();
  await expect(win.locator(".cx-page-head h1")).toHaveText(heading, { timeout: 20_000 });
}

/** 在顶部搜索框搜索 RUN_ID，等到结果卡片出现。 */
async function searchCard(win: ReturnType<Page["locator"]>, postId: string) {
  await win.locator("[data-cx-search]").fill(RUN_ID);
  await win.locator('[data-action="search"]').click();
  const card = win.locator(`[data-post="${postId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(win.locator(".cx-page-head h1")).toContainText(RUN_ID);
  return card;
}

/** 搜索 RUN_ID，等到「没有找到相关作品」的空态（而不是残留旧结果）。 */
async function searchExpectEmpty(win: ReturnType<Page["locator"]>, postId: string) {
  await win.locator("[data-cx-search]").fill(RUN_ID);
  await win.locator('[data-action="search"]').click();
  await expect(win.locator(".cx-page-head h1")).toContainText(RUN_ID, { timeout: 20_000 });
  await expect(win.locator(".g14-empty-title")).toHaveText("没有找到相关作品", { timeout: 20_000 });
  await expect(win.locator(`[data-post="${postId}"]`)).toHaveCount(0);
}

/** 造一条草稿 → 提交审核，返回 postId（审核动作留给各用例自己的 UI/API）。 */
async function createPendingPost(
  creator: BrowserContext,
  packageId: string,
): Promise<string> {
  const created = expectOk(
    await call(creator, "POST", "/api/community/posts", {
      type: "tutorial",
      title: TITLE,
      description: DESCRIPTION,
      category: "guide",
      license: "CC-BY-4.0",
      rightsConfirmed: true,
      publish: false,
      manifest: tutorialManifest(packageId),
    }),
    201,
  );
  const postId = String(created.post.id);
  expectOk(await call(creator, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true }), 200);
  return postId;
}

/** 用另一个账号举报作品：真实运营里「隐藏已发布作品」是从举报队列进入的。 */
async function reportPost(context: BrowserContext, postId: string): Promise<void> {
  expectOk(
    await call(context, "POST", "/api/community/reports", {
      targetType: "post",
      targetId: postId,
      reason: "copyright",
      description: `2.0.2 审核链举报样本 ${RUN_ID}`,
    }),
    201,
  );
}

test.describe("社区审核链 · 真实 Worker + 真实 UI", () => {
  // 真实 Worker 下每个用例要起 1–2 次桌面（每次 10–20 s）再走 3–5 跳界面；
  // 60 s 的全局默认不够，180 s 在 CI 上也曾贴近上限。留足余量但不要掩盖慢步骤：
  // 单个用例只放一个用户场景，慢在哪一步由 trace 里的 action 时间线定位。
  test.setTimeout(240_000);

  test("拒绝 → 作者看到备注与未通过 → 重新提交 → 通过 → 公开可搜", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      postId = await createPendingPost(creator, packageIds.rejectFlow);
      // 待审核 ≠ 公开：审核通过前搜索不到，避免用例只验证「DB 写了」。
      expect(await searchTotal(creator)).toBe(0);

      /* ---------- 1. 管理员：审核中心里点「拒绝」 ---------- */
      const adminPage = await admin.newPage();
      const adminErrors: string[] = [];
      adminPage.on("pageerror", (error) => adminErrors.push(error.message));
      await bootDesktop(adminPage);
      const adminWin = await openCommunity(adminPage);
      await navTo(adminWin, "moderation", "审核中心");
      const queueCard = adminWin.locator(`.cx-mod-card[data-post="${postId}"]`);
      await expect(queueCard).toBeVisible({ timeout: 20_000 });
      await queueCard.locator('[data-action="review-reject"]').click();

      const rejectDialog = adminWin.locator(".g14-modal");
      await expect(rejectDialog).toBeVisible();
      await rejectDialog.locator("[data-review-note]").fill(REJECT_NOTE);
      await rejectDialog.locator('[data-mv="reject"]').click();
      // 拒绝后这条从「待审核」队列里消失
      await expect(adminWin.locator(`.cx-mod-card[data-post="${postId}"]`)).toHaveCount(0, {
        timeout: 20_000,
      });
      expect(adminErrors, `管理员页面异常：${adminErrors.join("\n")}`).toEqual([]);

      /* ---------- 2. 作者：我的作品里看到备注与「未通过」 ---------- */
      const authorPage = await creator.newPage();
      const authorErrors: string[] = [];
      authorPage.on("pageerror", (error) => authorErrors.push(error.message));
      await bootDesktop(authorPage);
      const win = await openCommunity(authorPage);
      await navTo(win, "creations", "我的作品");
      const card = win.locator(`[data-post="${postId}"]`);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.locator(".cx-modnote")).toContainText(REJECT_NOTE);
      await expect(card.locator(".cx-status-chip")).toHaveText("未通过");

      // 「未通过」筛选也能看到它（说明筛选走的是服务端状态，不是前端猜测）
      await win.locator('[data-creations-status="rejected"]').click();
      await expect(win.locator(`[data-post="${postId}"]`)).toBeVisible({ timeout: 20_000 });

      /* ---------- 3. 作者点「提交审核」→ 回到待审核 ---------- */
      await win.locator('[data-creations-status="all"]').click();
      await expect(win.locator(`[data-post="${postId}"]`)).toBeVisible({ timeout: 20_000 });
      await win.locator(`[data-owner-post="${postId}"] [data-action="publish"]`).click();
      await expect(win.locator(`[data-post="${postId}"] .cx-status-chip`)).toHaveText("待审核", {
        timeout: 20_000,
      });

      /* ---------- 4. 管理员点「通过」→ 公开可搜、可打开详情 ---------- */
      await navTo(adminWin, "moderation", "审核中心");
      await expect(adminWin.locator(`.cx-mod-card[data-post="${postId}"]`)).toBeVisible({
        timeout: 20_000,
      });
      await adminWin.locator(`.cx-mod-card[data-post="${postId}"] [data-action="review-approve"]`).click();
      const approveDialog = adminWin.locator(".g14-modal");
      await expect(approveDialog).toBeVisible();
      await approveDialog.locator("[data-review-note]").fill(`通过 ${RUN_ID}`);
      await approveDialog.locator('[data-mv="approve"]').click();
      await expect(adminWin.locator(`.cx-mod-card[data-post="${postId}"]`)).toHaveCount(0, {
        timeout: 20_000,
      });

      expect(await searchTotal(creator)).toBe(1);
      const publicCard = await searchCard(win, postId);
      await publicCard.click();
      await expect(win.locator(".cx-detail-hero h1")).toHaveText(TITLE, { timeout: 20_000 });
      expect(authorErrors, `作者页面异常：${authorErrors.join("\n")}`).toEqual([]);
    } finally {
      if (postId) await call(creator, "DELETE", `/api/community/posts/${postId}`);
      await Promise.all([creator.close(), admin.close()]);
    }
  });

  test("举报 → 隐藏 → 公开搜不到 → 已隐藏队列恢复 → 重新出现", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const outsider = await sessionContext(browser, fixtures.tokens.outsider);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      postId = await createPendingPost(creator, packageIds.reportHideFlow);
      expectOk(await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }), 200);
      expect(await searchTotal(creator)).toBe(1);
      await reportPost(outsider, postId);

      const authorPage = await creator.newPage();
      await bootDesktop(authorPage);
      const win = await openCommunity(authorPage);
      await searchCard(win, postId);

      const adminPage = await admin.newPage();
      const adminErrors: string[] = [];
      adminPage.on("pageerror", (error) => adminErrors.push(error.message));
      await bootDesktop(adminPage);
      const adminWin = await openCommunity(adminPage);
      await navTo(adminWin, "moderation", "审核中心");

      /* ---------- 1. 举报处理 → 隐藏作品 ---------- */
      await adminWin.locator('[data-mod-tab="reports"]').click();
      const reportRow = adminWin.locator(".cx-report").filter({ hasText: RUN_ID }).first();
      await expect(reportRow).toBeVisible({ timeout: 20_000 });
      await reportRow.locator('[data-action="report-hide-post"]').click();
      const hideDialog = adminWin.locator(".g14-modal");
      await expect(hideDialog).toBeVisible();
      await hideDialog.locator("[data-report-resolution]").fill(HIDE_NOTE);
      await hideDialog.locator('[data-mv="go"]').click();
      // 处理过的举报离开「待处理」列表，作品同时进入 hidden。
      await expect(adminWin.locator(".cx-report").filter({ hasText: RUN_ID })).toHaveCount(0, {
        timeout: 20_000,
      });
      expect(await searchTotal(creator)).toBe(0);

      /* ---------- 2. 作者：公开搜索里消失 ---------- */
      await searchExpectEmpty(win, postId);

      /* ---------- 3. 已隐藏队列 → 通过（恢复公开） ---------- */
      await adminWin.locator('[data-mod-tab="queue"]').click();
      const hiddenChip = adminWin.locator('[data-queue-status="hidden"]');
      await expect(hiddenChip).toBeVisible({ timeout: 20_000 });
      await hiddenChip.click();
      const hiddenRow = adminWin.locator(`.cx-mod-card[data-post="${postId}"]`);
      await expect(hiddenRow).toBeVisible({ timeout: 20_000 });
      // 审核卡片里有 2 个状态芯片：封面角落（coverHtml）与标题行。取标题行那个，避免 strict mode 撞车。
      await expect(hiddenRow.locator(".cx-mod-head .cx-status-chip")).toHaveText("已隐藏");
      await hiddenRow.locator('[data-action="review-approve"]').click();
      const restoreDialog = adminWin.locator(".g14-modal");
      await expect(restoreDialog).toBeVisible();
      await restoreDialog.locator('[data-mv="approve"]').click();
      await expect(hiddenRow).toHaveCount(0, { timeout: 20_000 });

      /* ---------- 4. 作者：重新出现在公开搜索 ---------- */
      expect(await searchTotal(creator)).toBe(1);
      await searchCard(win, postId);
      expect(adminErrors, "审核中心不应抛 pageerror").toEqual([]);

      await authorPage.close();
      await adminPage.close();
    } finally {
      // 清理失败不能盖住真正的断言失败：DELETE 只做“尽力而为”。
      if (postId) await call(creator, "DELETE", `/api/community/posts/${postId}`).catch(() => undefined);
      await Promise.all([creator.close(), admin.close(), outsider.close()]);
    }
  });

  test("作者撤回已发布作品 → 变草稿，公开搜索消失", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      postId = await createPendingPost(creator, packageIds.withdrawFlow);
      expectOk(await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" }), 200);
      expect(await searchTotal(creator)).toBe(1);

      const authorPage = await creator.newPage();
      await bootDesktop(authorPage);
      const win = await openCommunity(authorPage);
      await navTo(win, "creations", "我的作品");
      const ownCard = win.locator(`[data-post="${postId}"]`);
      await expect(ownCard).toBeVisible({ timeout: 20_000 });
      // 作品卡片的状态芯片只在「非已发布」时渲染（coverHtml 的规则）：已发布时没有芯片。
      await expect(ownCard.locator(".cx-status-chip")).toHaveCount(0);

      await win.locator(`[data-owner-post="${postId}"] [data-action="withdraw"]`).click();
      const withdrawDialog = win.locator(".g14-modal");
      await expect(withdrawDialog).toBeVisible();
      await withdrawDialog.locator('[data-mv="withdraw"]').click();
      await expect(win.locator(`[data-post="${postId}"] .cx-status-chip`)).toHaveText("草稿", {
        timeout: 20_000,
      });
      expect(await searchTotal(creator)).toBe(0);

      await authorPage.close();
    } finally {
      if (postId) await call(creator, "DELETE", `/api/community/posts/${postId}`).catch(() => undefined);
      await Promise.all([creator.close(), admin.close()]);
    }
  });

  test("审核接口：非审核员 403、未知动作 400、作品不存在 404", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const creator = await sessionContext(browser, fixtures.tokens.installer);
    const admin = await sessionContext(browser, fixtures.tokens.admin);
    let postId = "";

    try {
      postId = await createPendingPost(creator, packageIds.permission);

      // 普通成员不能审核（包括审核自己的作品）
      const denied = await call(creator, "POST", `/api/community/admin/posts/${postId}/review`, {
        action: "reject",
      });
      expect(denied.status).toBe(403);

      // 未知动作必须被拒绝，不能静默成功
      const unknown = await call(admin, "POST", `/api/community/admin/posts/${postId}/review`, {
        action: "explode",
      });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.body)).toContain("未知的审核操作");

      // 不存在的作品
      const missing = await call(
        admin,
        "POST",
        `/api/community/admin/posts/00000000-0000-4000-8000-000000000000/review`,
        { action: "approve" },
      );
      expect(missing.status).toBe(404);
    } finally {
      if (postId) await call(creator, "DELETE", `/api/community/posts/${postId}`);
      await Promise.all([creator.close(), admin.close()]);
    }
  });
});