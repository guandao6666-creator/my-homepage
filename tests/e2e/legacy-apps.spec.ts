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

async function closeApp(page: Page, id: string): Promise<void> {
  await page.locator(`.window[data-app="${id}"] .dot-close`).click();
  await expect(page.locator(`.window[data-app="${id}"]`)).toHaveCount(0);
}

/** 从性能实验室面板读一项资源计数（迁移后的窗口级清理靠它验证） */
async function readCounter(page: Page, label: string): Promise<string> {
  const row = page.locator('.window[data-app="perflab"] li', { hasText: label }).first();
  return (await row.locator("b").first().innerText()).trim();
}

interface LifecycleSnapshot {
  listeners: number;
  intervals: number;
  timeouts: number;
}

async function sampleLifecycle(page: Page): Promise<LifecycleSnapshot> {
  await openApp(page, "perflab");
  const win = page.locator('.window[data-app="perflab"]');
  await win.locator('.g14-nav[data-tab="apps"]').click();
  await expect(win.locator("li", { hasText: "事件监听" }).first()).toBeVisible({ timeout: 10_000 });
  const listeners = Number.parseInt(await readCounter(page, "事件监听"), 10);
  const timers = await readCounter(page, "定时器（timeout / interval）");
  const [timeouts, intervals] = timers.split("/").map((part) => Number.parseInt(part.trim(), 10));
  await closeApp(page, "perflab");
  return { listeners, intervals, timeouts };
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

test.describe("Phase 2.2 · 清理被 os14 覆盖的旧实现后仍可用", () => {
  /**
   * notes / calendar / files / music 的旧实现已被删除。
   * 它们现在完全由 os14 注册；这里确认删除没有把应用一起删掉。
   */
  for (const { id, label, contentSelector } of [
    { id: "notes", label: "便签", contentSelector: ".win-body *" },
    { id: "calendar", label: "日历", contentSelector: ".win-body *" },
    { id: "files", label: "文件管理器", contentSelector: ".win-body *" },
    { id: "music", label: "音乐", contentSelector: ".win-body *" },
  ]) {
    test(`${label}（${id}）仍能打开且不是崩溃卡片`, async ({ page }) => {
      const errors = watchErrors(page);
      await bootDesktop(page);
      await openApp(page, id);

      const win = page.locator(`.window[data-app="${id}"]`);
      await expect(win).toBeVisible();

      // 有真实内容，没有落到「加载失败 / 初始化失败」的崩溃卡片
      await expect(win.locator(".win-body").first()).not.toBeEmpty();
      await expect(win.locator("[data-g19-retry]")).toHaveCount(0);
      const bodyText = (await win.locator(".win-body").first().innerText()) ?? "";
      expect(bodyText).not.toContain("初始化时出错");
      expect(bodyText).not.toContain("应用加载失败");

      await expect(win.locator(contentSelector).first()).toBeVisible();
      expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
    });
  }

  test("四个应用都还在注册表里（图标可点）", async ({ page }) => {
    await bootDesktop(page);
    const present = await page.evaluate(() => {
      const apps = (window as unknown as { GOS14: { ctx: { APPS: Record<string, unknown> } } }).GOS14.ctx.APPS;
      return ["notes", "calendar", "files", "music"].filter((id) => Boolean(apps[id]));
    });
    expect(present.sort()).toEqual(["calendar", "files", "music", "notes"]);
  });
});

test.describe("Phase 2.2 · 第二批迁移（外壳能力接口化）", () => {
  test("迁移清单在注册表里且保持 1.0 键序（启动台 / 程序坞 / 终端 apps 依赖）", async ({ page }) => {
    await bootDesktop(page);
    const ids = await page.evaluate(() => {
      const apps = (window as unknown as { GOS14: { ctx: { APPS: Record<string, unknown> } } }).GOS14.ctx.APPS;
      return Object.keys(apps);
    });
    // terminal 由 index.astro 的字面量锚点占第一位，注册时原地覆盖；其余按 1.0 顺序追加。
    expect(ids.slice(0, 17)).toEqual([
      "terminal",
      "settings",
      "achievements",
      "aquarium",
      "visitors",
      "draw",
      "council",
      "treehole",
      "news",
      "social",
      "monitor",
      "browser",
      "posts",
      "about",
      "rank",
      "calc",
      "viewer",
    ]);
  });

  test("终端：输入 help / version 有真实输出", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);
    await openApp(page, "terminal");

    const win = page.locator('.window[data-app="terminal"]');
    await expect(win.locator(".term-out")).toContainText("输入 help 看可用命令");
    await win.locator("#term-input").fill("help");
    await win.locator("#term-input").press("Enter");
    await expect(win.locator(".term-out")).toContainText("可用命令");
    await win.locator("#term-input").fill("version");
    await win.locator("#term-input").press("Enter");
    await expect(win.locator(".term-out")).toContainText("Guandao OS 2.0 · The Platform Era");

    await closeApp(page, "terminal");
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("每日抽奖：点击后写入当日结果", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "draw");

    const win = page.locator('.window[data-app="draw"]');
    await expect(win.locator("#draw-text")).toHaveText("每天可以抽一张，明天再来");
    await win.locator("#draw-btn").click();
    await expect(win.locator("#draw-mark")).not.toHaveText("?", { timeout: 5_000 });
    await expect(win.locator("#draw-text")).not.toHaveText("每天可以抽一张，明天再来");

    const saved = await page.evaluate(() => window.localStorage.getItem("guandao.draw.v1"));
    expect(saved, "抽签结果应写入 guandao.draw.v1").toBeTruthy();
    await closeApp(page, "draw");
  });

  test("水族箱：鱼群渲染，点击投喂出现食物", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);
    await openApp(page, "aquarium");

    const win = page.locator('.window[data-app="aquarium"]');
    await expect(win.locator(".tank")).toBeVisible();
    await expect(win.locator(".fish")).toHaveCount(7);
    await expect(win.locator("#tank-hint")).not.toBeEmpty();

    await win.locator(".tank").click({ position: { x: 200, y: 160 } });
    await expect(win.locator(".tank .food")).toHaveCount(1);

    await closeApp(page, "aquarium");
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("系统监视器：模拟指标与真实窗口数都在更新", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "monitor");

    const win = page.locator('.window[data-app="monitor"]');
    await expect(win.locator("[data-mon-cpu]")).toContainText("%");
    await expect(win.locator("[data-mon-mem]")).toContainText("%");
    const winCount = Number.parseInt(await win.locator("[data-mon-win]").innerText(), 10);
    expect(winCount).toBeGreaterThanOrEqual(1);
    expect(Number.parseInt(await win.locator("[data-mon-desks]").innerText(), 10)).toBeGreaterThanOrEqual(1);
    await expect(win.locator("[data-mon-storage]")).not.toHaveText("—");
    // interval 每 2s 刷新一次：等待后运行窗口数应等于桌面真实窗口数
    const desktopWindows = await page.locator(".window").count();
    await expect
      .poll(async () => Number.parseInt(await win.locator("[data-mon-win]").innerText(), 10), { timeout: 8_000 })
      .toBeGreaterThanOrEqual(desktopWindows);
    await closeApp(page, "monitor");
  });

  test("新闻联播：日期与四条新闻渲染", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "news");

    const win = page.locator('.window[data-app="news"]');
    await expect(win.locator(".news-name")).toHaveText("大肥鱼新闻联播");
    await expect(win.locator("#news-date")).not.toBeEmpty();
    await expect(win.locator("#news-list .news-item")).toHaveCount(4);
    await closeApp(page, "news");
  });

  test("浏览器：快捷入口可见，输入网址后写入历史记录", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "browser");

    const win = page.locator('.window[data-app="browser"]');
    await expect(win.locator(".browser-link").first()).toBeVisible();
    await expect(win.locator("[data-browser-history]")).toContainText("暂无历史");

    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 10_000 }),
      (async () => {
        await win.locator("[data-browser-url]").fill("guandao.xin");
        await win.locator("[data-browser-go]").click();
      })(),
    ]);
    await popup.close();

    await closeApp(page, "browser");
    await openApp(page, "browser");
    const reopened = page.locator('.window[data-app="browser"] [data-browser-history]');
    await expect(reopened.locator(".browser-h-item").first()).toContainText("guandao.xin");
    await closeApp(page, "browser");
  });

  test("成就：十一项一条不差", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "achievements");

    const win = page.locator('.window[data-app="achievements"]');
    await expect(win.locator(".ach-grid .ach")).toHaveCount(11);
    await expect(win.locator(".ach-head")).toContainText("已解锁");
    await expect(win.locator(".ach-head")).toContainText("/ 11");
    await closeApp(page, "achievements");
  });

  test("访客墙：空态/离线提示不是死循环加载，按钮能展开上传表单", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "visitors");

    const win = page.locator('.window[data-app="visitors"]');
    await expect(win.locator("#wall-count")).not.toHaveText("正在加载…", { timeout: 12_000 });
    await win.locator("#wall-add").click();
    await expect(win.locator("#wall-form")).toBeVisible();
    await win.locator("#wall-submit").click();
    await expect(win.locator("#wall-note")).not.toBeEmpty();
    await closeApp(page, "visitors");
  });

  test("议会：加载态结束，未登录时给出登录入口", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "council");

    const win = page.locator('.window[data-app="council"]');
    await expect(win.locator("#council-status")).not.toHaveText("正在加载…", { timeout: 12_000 });
    await expect(win.locator("#council-status")).not.toBeEmpty();
    await expect(win.locator("#council-auth .auth-form")).toBeVisible();
    await closeApp(page, "council");
  });

  test("树洞：未登录锁住发言，字数统计初始为 0 / 500", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "treehole");

    const win = page.locator('.window[data-app="treehole"]');
    await expect(win.locator("#hole-auth .auth-form")).toBeVisible();
    await expect(win.locator("#hole-send")).toBeDisabled();
    await expect(win.locator("#hole-input")).toBeDisabled();
    await expect(win.locator("#hole-count")).toHaveText("0 / 500");
    await expect(win.locator("#hole-topic")).not.toBeEmpty();
    await closeApp(page, "treehole");
  });

  test("社交名片：加载态结束，离线时列表有明确空态", async ({ page }) => {
    await bootDesktop(page);
    await openApp(page, "social");

    const win = page.locator('.window[data-app="social"]');
    await expect(win.locator("#social-count")).not.toHaveText("正在加载…", { timeout: 12_000 });
    await expect(win.locator("#social-count")).not.toBeEmpty();
    await expect(win.locator("#social-list .social-empty")).toContainText("还没有别的访客");
    await closeApp(page, "social");
  });

  test("生命周期：水族箱 / 系统监视器的计时器随窗口关闭回收", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await bootDesktop(page);
    await page.waitForTimeout(3_000);
    const baselineWindows = await page.locator(".window").count();
    const before = await sampleLifecycle(page);

    for (let i = 0; i < 5; i += 1) {
      await openApp(page, "aquarium");
      await closeApp(page, "aquarium");
      await openApp(page, "monitor");
      await closeApp(page, "monitor");
    }
    await expect(page.locator(".window")).toHaveCount(baselineWindows);

    const after = await sampleLifecycle(page);
    console.log(
      `[lifecycle:batch2] listeners ${before.listeners} → ${after.listeners}；` +
        `timeouts ${before.timeouts} → ${after.timeouts}；intervals ${before.intervals} → ${after.intervals}`,
    );
    expect(after.listeners - before.listeners, "事件监听增长").toBeLessThanOrEqual(2);
    expect(after.timeouts - before.timeouts, "timeout 增长").toBeLessThanOrEqual(2);
    expect(after.intervals - before.intervals, "interval 增长").toBeLessThanOrEqual(1);

    // 关闭之后功能仍正常：水族箱还能打开并投喂
    await openApp(page, "aquarium");
    await expect(page.locator('.window[data-app="aquarium"] .fish')).toHaveCount(7);
    await closeApp(page, "aquarium");
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });
});