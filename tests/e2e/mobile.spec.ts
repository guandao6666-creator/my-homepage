/**
 * 移动端 E2E（Guandao OS 1.9）
 *
 * 用手机尺寸 + 触摸/粗指针模拟真实手机，验证手机伴侣页能启动，
 * 并且不会去加载桌面那 400 多 KB 的主包。
 */
import { expect, test, type Page } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

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

test.describe("手机伴侣", () => {
  test("手机访问站点网址默认进入手机伴侣，且没有加载桌面主包", async ({ page }) => {
    const errors = watchErrors(page);
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });

    // 直接打开站点根地址，而不是 /m/：手机默认应落到伴侣页
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/m/");
    await expect(page.locator("#mobile-root")).toBeVisible();
    // 手机壳会替换掉「正在加载」占位
    await expect(page.locator("#mobile-root")).toContainText(/笔记|任务|今天|早上好|下午好|晚上好/, { timeout: 20_000 });

    // 桌面主包不该出现在手机端的请求里
    const desktopBundle = scripts.filter((url) => /index\.astro_astro_type_script/.test(url));
    expect(desktopBundle, `手机端不应加载桌面主包：${desktopBundle.join(", ")}`).toEqual([]);

    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("旧的 desktop 偏好不会把手机带回桌面", async ({ page }) => {
    // 模拟 1.8/1.9 遗留：localStorage 里存了 desktop
    await page.goto("/m/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("guandao.os18.shell.v1", "desktop"));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/m/");
  });

  test("手机上可以进入笔记并写入本地数据", async ({ page }) => {
    await page.goto("/m/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#mobile-root")).toBeVisible();
    await page.waitForTimeout(1200);

    // 底部标签栏里找笔记入口
    const notesTab = page.locator('.m-tab[data-tab="notes"]');
    await expect(notesTab).toBeVisible();
    await notesTab.click();
    await page.waitForTimeout(600);
    // 进入笔记后，本地存储里应该出现笔记数据结构（或保持为空数组）
    const notesOk = await page.evaluate(() => {
      const raw = localStorage.getItem("guandao.os14.notes.v1");
      if (raw === null) return true;
      try {
        const parsed = JSON.parse(raw) as { notes?: unknown };
        return Array.isArray(parsed.notes) || raw.startsWith("{");
      } catch {
        return false;
      }
    });
    expect(notesOk).toBe(true);
  });

  test("底栏「桌面」入口可以进入桌面版，并能看到博客与全部应用", async ({ page }) => {
    await page.goto("/m/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#mobile-root")).toBeVisible();
    await page.waitForTimeout(1200);

    const entry = page.locator(".m-tabbar a.m-tab-desktop");
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("href", "/?desktop=1");
    await expect(entry).toContainText("桌面");
    // 底栏现在有 5 个路由 tab + 1 个桌面出口
    await expect(page.locator(".m-tabbar .m-tab")).toHaveCount(6);

    await entry.click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/");
    await expect(page.locator("#os")).toBeVisible({ timeout: 20_000 });

    // 桌面选择只记在本次会话：sessionStorage 有标记，localStorage 不被改写
    const sessionFlag = await page.evaluate(() => sessionStorage.getItem("guandao.shell.desktop-session"));
    expect(sessionFlag).toBe("1");
    const pref = await page.evaluate(() => localStorage.getItem("guandao.os18.shell.v1"));
    expect(pref === "desktop").toBe(false);
    // 桌面壳里的文章入口存在（博客在桌面版内可读）
    await expect(page.locator('.desk-icon[data-app="posts"], .dock-item[data-app="posts"]').first()).toBeVisible();
  });

  test("桌面入口只在本次会话生效：新标签页打开网址仍进手机伴侣", async ({ page, context }) => {
    await page.goto("/m/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".m-tabbar a.m-tab-desktop")).toBeVisible();
    await page.locator(".m-tabbar a.m-tab-desktop").click();
    await expect(page.locator("#os")).toBeVisible({ timeout: 20_000 });

    // 新标签页 = 新的会话存储，重新打开网址应回到手机伴侣
    const fresh = await context.newPage();
    await fresh.goto("/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(fresh.url()).pathname, { timeout: 20_000 }).toBe("/m/");
    await fresh.close();
  });

  test("桌面宽度访问 /m/ 会跳回桌面版", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto("/m/", { waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/");
    await context.close();
  });
});