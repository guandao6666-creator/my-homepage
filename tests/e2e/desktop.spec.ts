/**
 * 桌面端 E2E（Guandao OS 1.9）
 *
 * 覆盖真实构建产物上的核心用户路径：
 *   启动 → 打开应用（走按需加载）→ 关闭窗口 → 拖拽窗口 → 主题切换 →
 *   写一条便签 → 刷新后数据仍在 → 搜索面板 → 单个应用出错不影响桌面。
 *
 * 说明：本地静态服务器没有 Worker，/api/* 会 404。这在本地模式下是预期行为，
 * 因此只在「不是 /api/ 请求」且「不是被测试主动触发的错误」时断言控制台干净。
 */
import { expect, test, type Page } from "@playwright/test";

/** 收集控制台错误与被拒绝的 Promise，忽略本地模式下的 API 缺失 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/\/api\//.test(text)) return;
    if (/Failed to load resource/.test(text)) return; // 静态服务器没有 Worker
    // 本地静态预览没有 Worker，账号状态接口 404 属于预期，不作为回归失败
    if (/Guandao Account/.test(text) || /ApiError/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function bootDesktop(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // 开机遮罩由内核启动完成后移除；最多等 15 秒
  await expect(page.locator("#os")).toBeVisible();
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 15_000 });
  // 2.0：首次启动引导会盖在桌面上。桌面回归测试显式跳过它，
  // 引导本身的七步流程由 tests/e2e/os20.spec.ts 覆盖。
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.click();
    await page.waitForFunction(() => !document.querySelector(".os20-onb"), null, { timeout: 10_000 });
  }
}

test.describe("桌面外壳", () => {
  test("启动后渲染菜单栏、桌面图标与程序坞", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);

    await expect(page.locator(".menubar")).toBeVisible();
    await expect(page.locator("#dock .dock-item").first()).toBeVisible();
    await expect(page.locator(".desk-icon").first()).toBeVisible();

    // 版本号来自单一版本源
    await expect(page.locator(".mb-version")).toHaveText("2.0");

    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("按需加载：第一次打开便签时才下载应用模块", async ({ page }) => {
    await bootDesktop(page);

    const requests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (/\/_astro\/.*\.js/.test(url)) requests.push(url);
    });

    await page.locator('.desk-icon[data-app="notes"]').click();
    const win = page.locator('.window[data-app="notes"]');
    await expect(win).toBeVisible();
    // 骨架会在模块到位后被真实内容替换
    await expect(win.locator(".n14-search")).toBeVisible({ timeout: 15_000 });
    await expect(win.locator(".g19-loading")).toHaveCount(0);

    // 打开便签确实触发了一个新的 JS chunk
    expect(requests.length).toBeGreaterThan(0);
  });

  test("打开与关闭窗口，程序坞状态同步", async ({ page }) => {
    await bootDesktop(page);
    const dockItem = page.locator('.dock-item[data-app="posts"]');
    await dockItem.click();
    const win = page.locator('.window[data-app="posts"]');
    await expect(win).toBeVisible();
    await expect(dockItem).toHaveClass(/has-open/);

    await win.locator(".dot-close").click();
    await expect(win).toHaveCount(0);
    await expect(dockItem).not.toHaveClass(/has-open/);
  });

  test("拖动窗口后位置改变并写入本地状态", async ({ page }) => {
    await bootDesktop(page);
    await page.locator('.dock-item[data-app="terminal"]').click();
    const win = page.locator('.window[data-app="terminal"]');
    await expect(win).toBeVisible();

    const before = await win.boundingBox();
    expect(before).not.toBeNull();
    const titlebar = win.locator(".titlebar");
    const box = await titlebar.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + 80, box!.y + 12);
    await page.mouse.down();
    await page.mouse.move(box!.x + 220, box!.y + 120, { steps: 12 });
    await page.mouse.up();

    const after = await win.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(40);

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem("guandao.os.state.v1");
      return raw ? (JSON.parse(raw) as { windows?: Record<string, { left: number; top: number }> }) : null;
    });
    expect(saved?.windows?.terminal).toBeTruthy();
  });

  test("切换外观：深色 ↔ 浅色", async ({ page }) => {
    await bootDesktop(page);
    const current = await page.evaluate(() => document.body.dataset.osTheme ?? "dark");
    await page.locator('[data-menu-btn="view"]').click();
    await page.locator('[data-menu-panel="view"] [data-menu-action="theme"]').click();
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.osTheme ?? "dark"))
      .not.toBe(current);
  });

  test("便签：新建、输入、刷新后仍在", async ({ page }) => {
    await bootDesktop(page);
    await page.locator('.desk-icon[data-app="notes"]').click();
    const win = page.locator('.window[data-app="notes"]');
    await expect(win.locator(".n14-search")).toBeVisible({ timeout: 15_000 });

    await win.locator("[data-n-new]").click();
    const title = win.locator("[data-n-title]");
    await expect(title).toBeVisible();
    await title.fill("1.9 回归测试便签");
    await win.locator("[data-n-body]").fill("这条内容用于验证刷新后仍然存在。");
    // 自动保存有防抖，等本地存储出现内容
    await page.waitForFunction(
      () => (localStorage.getItem("guandao.os14.notes.v1") ?? "").includes("1.9 回归测试便签"),
      null,
      { timeout: 10_000 },
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 10_000 });
    const persisted = await page.evaluate(() =>
      (localStorage.getItem("guandao.os14.notes.v1") ?? "").includes("1.9 回归测试便签"),
    );
    expect(persisted).toBe(true);
  });

  test("Spotlight 可以打开、搜索并关闭", async ({ page }) => {
    await bootDesktop(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#spotlight")).toBeVisible();
    await page.locator("#spotlight-input").fill("终端");
    await expect(page.locator("#spotlight-results")).toContainText("终端");
    await page.keyboard.press("Escape");
    await expect(page.locator("#spotlight")).toBeHidden();
  });

  test("性能实验室可以打开并展示真实指标（不是占位）", async ({ page }) => {
    await bootDesktop(page);
    await page.locator('[data-menu-btn="apps"]').click();
    await page.locator('[data-menu-panel="apps"] [data-menu-action="perflab"]').click();
    const win = page.locator('.window[data-app="perflab"]');
    await expect(win).toBeVisible();
    await expect(win.locator(".g19-card").first()).toBeVisible({ timeout: 15_000 });
    await expect(win).toContainText("性能概览");
    // 真实计数：应用数量与窗口数量都应该是数字
    await expect(win.locator(".g19-card").filter({ hasText: "应用 / 窗口" })).toContainText(/\d+ \/ \d+/);
  });
});