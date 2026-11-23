import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForFixtures } from "./support/worker-api";

/**
 * 数值滑杆用键盘（方向键 / Home / End）调整后必须落盘。
 *
 * 2.0.10 之前只有 pointerup 会写 settings，键盘只更新旁边的数字标签，
 * 关窗重开就恢复旧值 —— 用户以为改过了，实际没保存。
 */

/**
 * 引导层与欢迎文章窗都可能「晚一步」挂载（全量套件时机器更慢）。
 * 这里反复清理而不是只清一次：一次清理赶在挂载之前，后续点击就会被模态吃掉
 * （2.0.11 全量 E2E 里设置侧栏点击曾因此超时 120s）。
 */
async function dismissOverlays(page: Page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let acted = false;
    const skip = page.locator("[data-onb-skip]");
    if (await skip.count()) {
      await skip.first().click({ timeout: 1_500 }).catch(() => undefined);
      acted = true;
    }
    const welcome = page.locator('.window[data-app="posts"] .dot-close');
    if (await welcome.count()) {
      await welcome.first().click({ timeout: 1_500 }).catch(() => undefined);
      acted = true;
    }
    if (!acted) await page.waitForTimeout(200);
    await page.waitForTimeout(150);
  }
}

async function bootDesktop(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as unknown as { GOS20_READY?: boolean }).GOS20_READY), null, {
    timeout: 30_000,
  });
  await expect(page.locator("#os")).toBeVisible();
  await dismissOverlays(page);
  await expect(page.locator(".os20-onb")).toHaveCount(0);
}

async function openSettings(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("systemcenter"),
  );
  const win = page.locator('.window[data-app="systemcenter"]');
  await expect(win).toBeVisible();
  return win;
}

test.describe("系统设置 · 数值滑杆键盘提交", () => {
  test.beforeAll(async () => {
    await waitForFixtures("accounts");
  });

  test.setTimeout(120_000);

  test("系统设置：键盘调整音量后关窗重开仍保留", async ({ page }) => {
  await bootDesktop(page);
  let win = await openSettings(page);

  // 打开设置之后引导层也可能刚挂上，再清一遍，避免侧栏点击被吃掉
  await dismissOverlays(page);
  await win.locator('.g14-nav[data-tab="personal"]').click({ timeout: 20_000 });
  const slider = win.locator('input[data-set-number="notifications.volume"]');
  await expect(slider).toBeVisible();

  const original = await slider.inputValue();
  await slider.focus();
  await slider.press("ArrowLeft");

  // 键盘交互会同步触发 change；等待 value 真正变化，避免读到渲染前的旧值
  await expect
    .poll(async () => slider.inputValue(), { message: "方向键应改变滑杆值" })
    .not.toBe(original);
  const changed = await slider.inputValue();
  expect(changed).not.toBe(original);

  // 让 change 处理函数跑完再关窗
  await page.waitForTimeout(200);
  await win.locator(".dot-close").click();
  await expect(page.locator('.window[data-app="systemcenter"]')).toHaveCount(0);

  win = await openSettings(page);
  // 打开设置之后引导层也可能刚挂上，再清一遍，避免侧栏点击被吃掉
  await dismissOverlays(page);
  await win.locator('.g14-nav[data-tab="personal"]').click({ timeout: 20_000 });
  const reopened = win.locator('input[data-set-number="notifications.volume"]');
  await expect(reopened).toBeVisible();
  await expect(reopened).toHaveValue(changed);
  });
});