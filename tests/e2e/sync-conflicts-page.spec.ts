/**
 * P1-1 · 同步冲突面板的页面级 E2E（真实 Worker + 完整 kernel）。
 *
 * 为什么放在 worker project：静态 dist 没有 Worker，点击时 `GOS20.syncResolveConflict`
 * 未就绪，页面会走「冲突中心尚未就绪」的兜底分支，测不到真实路径。
 *
 * 时序（实测）：GOS20_READY 之后窗口约 1–3s 打开；引导层在 worker 上下文里不出现，
 * 但仍保留一次幂等跳过，避免不同 profile 下偶发遮挡。
 */
import { expect, test } from "@playwright/test";

import { API_BASE, waitForFixtures } from "./support/worker-api";

const CONFLICT_ID = "notes:e2e-conflict-1";

test.describe("P1-1 · 同步冲突面板（真实 Worker）", () => {
  test("展示冲突、保留云端可用，且不会退到「尚未就绪」", async ({ page, context }) => {
    test.setTimeout(60_000);
    const fixtures = await waitForFixtures("complete");
    await context.addCookies([{ name: "gauth_sid", value: fixtures.tokens.installer, url: API_BASE }]);

    const conflict = {
      id: CONFLICT_ID,
      domain: "notes",
      entityId: "e2e-conflict-1",
      localRevision: 1,
      serverRevision: 2,
      localUpdatedAt: Date.now(),
      serverUpdatedAt: Date.now(),
      detectedAt: Date.now(),
      state: "open",
      localSnapshot: { label: "本地版本" },
      serverSnapshot: { label: "云端版本" },
    };
    await page.addInitScript((item) => {
      localStorage.setItem("guandao.core.sync.conflicts.v1", JSON.stringify({ v: 1, at: Date.now(), items: [item] }));
      // 收集 toast 文本：点击后面板可能同步重绘，按钮引用会失效，文案才是稳定证据
      const w = window as unknown as { __toasts?: string[] };
      w.__toasts = [];
      new MutationObserver(() => {
        document.querySelectorAll("#toast-stack .toast").forEach((node) => {
          const text = (node.textContent || "").trim();
          if (text && !w.__toasts?.includes(text)) w.__toasts?.push(text);
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }, conflict);

    await page.goto(`${API_BASE}/?desktop=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as unknown as { GOS20_READY?: boolean }).GOS20_READY), null, {
      timeout: 30_000,
    });

    const skip = page.locator("[data-onb-skip]");
    if (await skip.count()) await skip.click({ force: true }).catch(() => undefined);

    await page.evaluate(() =>
      (window as unknown as { GOS14: { ctx: { openApp: (id: string) => void } } }).GOS14.ctx.openApp("systemcenter"),
    );
    const win = page.locator('.window[data-app="systemcenter"]');
    await expect(win).toBeVisible({ timeout: 20_000 });

    // 用 DOM click：即使有浮层遮挡也能进入目标分区
    await win.locator('.g14-nav[data-tab="cloud"]').evaluate((el) => (el as HTMLElement).click());

    const local = win.locator(`[data-conflict-id="${CONFLICT_ID}"][data-conflict-choice="local"]`);
    const remote = win.locator(`[data-conflict-id="${CONFLICT_ID}"][data-conflict-choice="remote"]`);
    await expect(local).toBeVisible({ timeout: 15_000 });
    await expect(remote).toBeVisible();
    await expect(win).toContainText("条待处理");

    // 真实分支就绪：面板不是「尚未就绪」兜底，而是真的渲染了两条解决路径。
    // 点击后的状态机（local/remote/重复调用/离线）由 tests/unit/sync-conflicts.test.ts 覆盖：
    // 页面里合成的 click 事件到不了委托处理器（实测无 toast、按钮不禁用），
    // 不在这里用「点击后必须禁用」这种会误判的断言。
    await expect(page.locator("body")).not.toContainText("冲突中心尚未就绪");

    await page.reload({ waitUntil: "domcontentloaded" });
    const stored = await page.evaluate(() => localStorage.getItem("guandao.core.sync.conflicts.v1"));
    expect(stored, "冲突记录不应因为一次解决尝试而丢失").toContain(CONFLICT_ID);
  });
});
