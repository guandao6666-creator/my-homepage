import { expect, test } from "@playwright/test";
import { waitForFixtures } from "./support/worker-api";

/**
 * 2.0.9 回归：系统设置与市场的分区状态是模块级的，重开窗口时必须把
 * 「当前内容所在分区」传给 shell/bindTabs，否则侧栏高亮停在默认值，
 * 看起来像窗口自己跳走到了别的分区。
 */

async function bootDesktop(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as unknown as { GOS20_READY?: boolean }).GOS20_READY), null, {
    timeout: 25_000,
  });
  // 引导层可能晚于 READY 挂载，按「看到就关、直到消失」循环，避免抢跑后被模态挡住点击。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const overlay = page.locator(".os20-onb");
    if (!(await overlay.count())) break;
    const skip = page.locator("[data-onb-skip]");
    if (await skip.count()) await skip.first().click().catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(page.locator(".os20-onb")).toHaveCount(0);
  const welcome = page.locator('.window[data-app="posts"] .dot-close');
  if (await welcome.count()) {
    await welcome.first().click().catch(() => undefined);
    await expect(page.locator('.window[data-app="posts"]')).toHaveCount(0);
  }
}

test.describe("Guandao OS 2.0 · 重开窗口的分区高亮", () => {
  test.beforeAll(async () => {
    await waitForFixtures("accounts");
  });

  test("系统设置重开时高亮跟随当前分区", async ({ page }) => {
    await bootDesktop(page);
    await page.evaluate(() => (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("systemcenter"));
    const win = page.locator('.window[data-app="systemcenter"]');
    await expect(win).toBeVisible();
    await win.locator('.g14-nav[data-tab="system"]').click();
    await expect(win.locator('.g14-nav[data-tab="system"]')).toHaveClass(/is-active/);

    await win.locator(".dot-close").click();
    await expect(page.locator('.window[data-app="systemcenter"]')).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("systemcenter"));
    const reopened = page.locator('.window[data-app="systemcenter"]');
    await expect(reopened).toBeVisible();
    await expect(reopened.locator(".g14-nav.is-active")).toContainText("系统");
    await expect(reopened.locator('.g14-nav[data-tab="system"]')).toHaveClass(/is-active/);
    await expect(reopened.locator('.g14-nav[data-tab="appearance"]')).not.toHaveClass(/is-active/);
  });

  test("市场重开时高亮跟随当前分区", async ({ page }) => {
    await bootDesktop(page);
    await page.evaluate(() => (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("market"));
    const win = page.locator('.window[data-app="market"]');
    await expect(win).toBeVisible();
    await win.locator('.g14-nav[data-tab="community"]').click();
    await expect(win.locator('.g14-nav[data-tab="community"]')).toHaveClass(/is-active/);

    await win.locator(".dot-close").click();
    await expect(page.locator('.window[data-app="market"]')).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("market"));
    const reopened = page.locator('.window[data-app="market"]');
    await expect(reopened).toBeVisible();
    await expect(reopened.locator(".g14-nav.is-active")).toContainText("社区");
    await expect(reopened.locator('.g14-nav[data-tab="community"]')).toHaveClass(/is-active/);
  });
});