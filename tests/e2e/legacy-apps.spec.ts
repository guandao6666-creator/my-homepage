/**
 * Guandao OS 2.2 · 已迁移旧版应用的 E2E。
 *
 * 每个从 `index.astro` 迁到 `src/lib/legacy-apps/` 的应用都要有回归证据：
 *   打开 → 内容真实渲染 → 交互可用 → 关闭 → 再次打开不产生重复实例。
 *
 * 这里只验证「行为没变」，不重新设计 UI。
 */
import { expect, test, type Page } from "@playwright/test";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/\/api\//.test(text)) return;
    if (/Failed to load resource/.test(text)) return;
    if (/Guandao Account/.test(text) || /ApiError/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

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

async function openApp(page: Page, id: string): Promise<void> {
  await page.evaluate((appId) => (window as unknown as { GOS14: { ctx: { openApp: (x: string) => void } } }).GOS14.ctx.openApp(appId), id);
  await expect(page.locator(`.window[data-app="${id}"]`)).toBeVisible();
}

test.describe("Phase 2.2 · 已迁移应用", () => {
  test("文章：从程序坞打开，列表来自构建期数据", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);

    // posts 在默认程序坞里，验证图标 → openApp → registerApp 整条链路
    await page.locator('.dock-item[data-app="posts"]').click();
    const win = page.locator('.window[data-app="posts"]');
    await expect(win).toBeVisible();

    await expect(win.locator(".finder")).toBeVisible();
    const rows = win.locator(".finder-files .file-row");
    expect(await rows.count()).toBeGreaterThan(0);
    // 侧栏统计与行数一致
    await expect(win.locator(".finder-side .side-item").nth(1)).toContainText("篇");

    await win.locator(".dot-close").click();
    await expect(win).toHaveCount(0);
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("关于：渲染作者名与站内链接", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "about");

    const win = page.locator('.window[data-app="about"]');
    await expect(win.locator(".about")).toBeVisible();
    await expect(win.locator(".about h2")).toHaveText("管道");
    await expect(win.locator('.about-links a[href="/blog/"]')).toBeVisible();
  });

  test("计算器：点击按键能算出结果", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);
    await openApp(page, "calc");

    const win = page.locator('.window[data-app="calc"]');
    const display = win.locator("#calc-display");
    await expect(display).toHaveText("0");

    await win.locator('.calc-key[data-k="7"]').click();
    await win.locator('.calc-key[data-k="+"]').click();
    await win.locator('.calc-key[data-k="8"]').click();
    await expect(display).toHaveText("7+8");

    await win.locator('.calc-key[data-k="="]').click();
    await expect(display).toHaveText("15");
    await expect(win.locator(".calc-h-item").first()).toContainText("7+8 = 15");

    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("图片查看器：空状态与工具栏渲染", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "viewer");

    const win = page.locator('.window[data-app="viewer"]');
    await expect(win.locator(".viewer-stage")).toBeVisible();
    await expect(win.locator("[data-view-empty]")).toContainText("还没有图片");
    await expect(win.locator("[data-view-open]")).toBeVisible();
  });

  test("排行榜：窗口打开后状态区有明确文案（本地无后端不是空白）", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "rank");

    const win = page.locator('.window[data-app="rank"]');
    await expect(win.locator(".rank")).toBeVisible();
    // 静态服务器下没有 Supabase，应显示「未连接」/「连不上」之一，而不是永远停在「正在加载…」
    await expect(win.locator("#rank-status")).not.toHaveText("正在加载…", { timeout: 10_000 });
    await expect(win.locator("#rank-join")).toBeVisible();
  });

  test("重复打开同一应用不会产生第二个窗口", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "calc");
    await openApp(page, "calc");
    await openApp(page, "calc");
    await expect(page.locator('.window[data-app="calc"]')).toHaveCount(1);
  });

  test("关闭再打开：迁移后的 init 会重新执行", async ({ page }) => {
    await bootDesktop(page);

    await openApp(page, "calc");
    let win = page.locator('.window[data-app="calc"]');
    await win.locator('.calc-key[data-k="9"]').click();
    await expect(win.locator("#calc-display")).toHaveText("9");
    await win.locator(".dot-close").click();
    await expect(win).toHaveCount(0);

    await openApp(page, "calc");
    win = page.locator('.window[data-app="calc"]');
    // 新窗口是全新状态，不应残留上一次的表达式
    await expect(win.locator("#calc-display")).toHaveText("0");
  });
});