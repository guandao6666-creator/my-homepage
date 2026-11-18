/**
 * P4-1 · 平板模式判定与第三套布局。
 *
 * 判定规则在 src/lib/shell/adaptive.ts:50-68：
 *   w<640 或 (coarse 且短边<500) → mobile；w<1024 或 (coarse 且 w<1280) → tablet；否则 desktop。
 * 这里只断言可观测入口 `documentElement.dataset.shell` 与平板布局的关键尺寸，不靠截图。
 */
import { expect, test } from "@playwright/test";

const CASES = [
  { width: 820, height: 1180, shell: "tablet" },
  { width: 1024, height: 768, shell: "tablet" },
  { width: 1280, height: 800, shell: "desktop" },
  { width: 1440, height: 900, shell: "desktop" },
];

test("平板断点：820/1024 → tablet，1280/1440 → desktop", async ({ browser }) => {
  for (const item of CASES) {
    const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: true });
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 20_000 });
    await expect(page.locator("html")).toHaveAttribute("data-shell", item.shell);
    if (item.shell === "tablet") {
      // 平板第三套布局生效的证据：菜单栏 46px、Dock 变量 58px（adaptive.css:8-61）
      const menubarHeight = await page.locator(".menubar").evaluate((el) => getComputedStyle(el).height);
      expect(menubarHeight).toBe("46px");
      const dockSize = await page.locator(".dock").evaluate((el) => getComputedStyle(el).getPropertyValue("--dock-size").trim());
      expect(dockSize).toBe("58px");
    }
    await context.close();
  }
});

test("手机断点仍走 /m/，不会被误判成平板", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/m\//, { timeout: 20_000 });
  expect(page.url()).toContain("/m/");
  await context.close();
});
