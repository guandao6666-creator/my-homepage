import { expect, test, type Page } from "@playwright/test";

/**
 * 2.0.8 · 市场搜索过滤后不能留下旧详情
 *
 * 复现（2.0.7）：先选中一张卡片，再输入一个匹配不到任何资源的关键词。
 * 列表变成空态，右侧详情栏仍显示上一张卡片的标题与「安装」按钮，
 * 但 `state.selected` 已被清空 —— 点安装没有任何反应。
 *
 * 这个用例只走真实 UI：打开市场、点卡片、输入关键词，断言详情栏一起变成空态。
 */

const EMPTY_HINT = "选择左侧任意一张卡片查看详情";
const EMPTY_LIST = "没有匹配的资源";

async function bootDesktop(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // 内核启动是异步的：GOS14/GOS20 接口要等 GOS20_READY 之后才稳定，只等 #boot 消失会抢跑
  await page.waitForFunction(() => Boolean((window as unknown as { GOS20_READY?: unknown }).GOS20_READY), null, {
    timeout: 20_000,
  });
  await expect(page.locator("#boot")).toBeHidden();
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    if (await skip.isVisible()) {
      await skip.click();
      await expect(page.locator(".os20-onb")).toHaveCount(0);
    }
  }
}

async function openMarket(page: Page): Promise<void> {
  // openApp 的返回值在早启动阶段不稳定：调用一次，然后用窗口是否存在来判定成功
  await page.evaluate(() => {
    const gos = (window as unknown as { GOS14?: { ctx: { openApp(id: string): void } } }).GOS14;
    gos?.ctx.openApp("market");
  });
  const win = page.locator('.window[data-app="market"]');
  await expect(win).toBeVisible();
  await expect(win.locator(".os20-mk-card").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("市场 · 搜索过滤后的详情一致性", () => {
  test("选中卡片后搜索空关键词，详情栏一起变空态", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await bootDesktop(page);
    await openMarket(page);

    const win = page.locator('.window[data-app="market"]');
    const detail = win.locator(".os20-mk-detail");

    // 先选中一张真实卡片，确保详情栏不是初始空态
    const firstCard = win.locator(".os20-mk-card").first();
    const firstTitle = (await firstCard.locator("h4").innerText()).trim();
    await firstCard.click();
    await expect(detail.locator("h3")).toHaveText(firstTitle);
    await expect(detail).not.toHaveClass(/is-empty/);

    // 输入一个不可能匹配的关键词：列表与详情必须同时变空
    await win.locator("[data-mk-search]").fill("zzz-no-such-resource-2-0-8");
    await expect(win.locator(".os20-mk-list .g14-empty-title")).toHaveText(EMPTY_LIST);
    await expect(detail).toHaveClass(/is-empty/);
    await expect(detail).toContainText(EMPTY_HINT);
    await expect(detail.locator("h3")).toHaveCount(0);
    await expect(win.locator(".os20-mk-card")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});