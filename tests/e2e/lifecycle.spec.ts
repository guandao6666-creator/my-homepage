/**
 * Guandao OS 2.2 · 生命周期检查（补齐 Phase 2.2 门禁第 6 项）。
 *
 * 目标：连续开关应用后，**事件监听与定时器不增长**，DOM 不残留。
 *
 * 不改任何产品代码：读的是项目自带的 `quality/resources.ts` 计数器，
 * 由「性能实验室」应用把 `resourceStats()` 的真实值渲染到面板上。
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
  await page.evaluate(
    (appId) => (window as unknown as { GOS14: { ctx: { openApp: (x: string) => void } } }).GOS14.ctx.openApp(appId),
    id,
  );
  await expect(page.locator(`.window[data-app="${id}"]`)).toBeVisible();
}

async function closeApp(page: Page, id: string): Promise<void> {
  await page.locator(`.window[data-app="${id}"] .dot-close`).click();
  await expect(page.locator(`.window[data-app="${id}"]`)).toHaveCount(0);
}

/** 从性能实验室面板读一项资源计数 */
async function readCounter(page: Page, label: string): Promise<string> {
  const row = page.locator('.window[data-app="perflab"] li', { hasText: label }).first();
  return (await row.locator("b").first().innerText()).trim();
}

interface Snapshot {
  listeners: number;
  intervals: number;
  timeouts: number;
  rafs: number;
  scopes: number;
}

async function sample(page: Page): Promise<Snapshot> {
  await openApp(page, "perflab");
  const win = page.locator('.window[data-app="perflab"]');
  // 资源计数在「应用性能」标签页
  await win.locator('.g14-nav[data-tab="apps"]').click();
  await expect(win.locator("li", { hasText: "事件监听" }).first()).toBeVisible({ timeout: 10_000 });

  const listeners = Number.parseInt(await readCounter(page, "事件监听"), 10);
  const timers = await readCounter(page, "定时器（timeout / interval）");
  const [timeouts, intervals] = timers.split("/").map((part) => Number.parseInt(part.trim(), 10));
  const rafs = Number.parseInt(await readCounter(page, "动画帧回调"), 10);
  const scopes = Number.parseInt(await readCounter(page, "存活资源域"), 10);

  await closeApp(page, "perflab");
  return { listeners, intervals, timeouts, rafs, scopes };
}

test.describe("Phase 2.2 · 生命周期", () => {
  test.setTimeout(180_000);

  test("连续开关 20 次：事件监听与定时器不增长", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);

    // 让启动期的一次性定时器（开机兜底、通知播种等）先跑完
    await page.waitForTimeout(3000);
    // 桌面启动时会自动打开「文章」窗口，窗口总数以此为准
    const baselineWindows = await page.locator(".window").count();
    const before = await sample(page);

    for (let i = 0; i < 20; i += 1) {
      await openApp(page, "calc");
      await closeApp(page, "calc");
    }

    const after = await sample(page);

    console.log(
      `[lifecycle] listeners ${before.listeners} → ${after.listeners}；` +
        `timeouts ${before.timeouts} → ${after.timeouts}；` +
        `intervals ${before.intervals} → ${after.intervals}；` +
        `rafs ${before.rafs} → ${after.rafs}；scopes ${before.scopes} → ${after.scopes}`,
    );

    // 20 次开关不允许留下监听器或定时器
    expect(after.listeners - before.listeners, "事件监听增长").toBeLessThanOrEqual(2);
    expect(after.timeouts - before.timeouts, "timeout 增长").toBeLessThanOrEqual(2);
    expect(after.intervals - before.intervals, "interval 增长").toBeLessThanOrEqual(1);
    expect(after.rafs - before.rafs, "动画帧回调增长").toBeLessThanOrEqual(2);
    expect(after.scopes - before.scopes, "存活资源域增长").toBeLessThanOrEqual(1);

    // DOM 不残留：回到开机时的窗口数，且没有 calc 窗口
    await expect(page.locator(".window")).toHaveCount(baselineWindows);
    await expect(page.locator('.window[data-app="calc"]')).toHaveCount(0);
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("重应用（终端）连续开关 10 次后仍可用且无残留", async ({ page }) => {
    const errors = watchErrors(page);
    await bootDesktop(page);
    await page.waitForTimeout(3000);
    const baselineWindows = await page.locator(".window").count();
    const before = await sample(page);

    for (let i = 0; i < 10; i += 1) {
      await openApp(page, "terminal");
      await closeApp(page, "terminal");
      await expect(page.locator('.window[data-app="terminal"]')).toHaveCount(0);
    }
    await expect(page.locator(".window")).toHaveCount(baselineWindows);

    // 第 11 次打开，功能仍正常
    await openApp(page, "terminal");
    await expect(page.locator('.window[data-app="terminal"] .term-out')).toBeVisible();
    await closeApp(page, "terminal");

    const after = await sample(page);
    console.log(
      `[lifecycle:terminal] listeners ${before.listeners} → ${after.listeners}；` +
        `timeouts ${before.timeouts} → ${after.timeouts}；intervals ${before.intervals} → ${after.intervals}`,
    );

    expect(after.listeners - before.listeners, "事件监听增长").toBeLessThanOrEqual(2);
    expect(after.timeouts - before.timeouts, "timeout 增长").toBeLessThanOrEqual(2);
    expect(after.intervals - before.intervals, "interval 增长").toBeLessThanOrEqual(1);
    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });
});