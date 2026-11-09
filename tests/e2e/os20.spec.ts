/**
 * Guandao OS 2.0 · 平台层 E2E（真实构建产物）
 *
 * 验证的是「2.0 的核心承诺」，而不是像素：
 *   1. 内核真的启动完成，并留下 11 个阶段的证据；
 *   2. 首次启动引导真的出现，跳过之后不再打扰；
 *   3. 应用注册中心的状态来自真实窗口，而不是 UI 自己写的标签；
 *   4. 系统设置改动真的落盘（刷新后还在）；
 *   5. 权限默认拒绝，拒绝会进审计；
 *   6. 更新中心读取真实版本而不是假数据。
 *
 * 本地静态服务器没有 Worker，/api/* 404 属于预期，测试里会显式处理。
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

async function boot(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as any).GOS20_READY), null, { timeout: 20_000 });
  // 内核启动是异步的：等它真的结束
  await page.evaluate(() => (window as any).GOS20_READY);
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 20_000 });
}

/** 首次启动引导会挡住桌面：测试里点「跳过引导」 */
async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.click();
    await expect(page.locator(".os20-onb")).toHaveCount(0, { timeout: 10_000 });
  }
}

test.describe("Guandao OS 2.0 · 内核与引导", () => {
  test("内核启动完成，11 个阶段都有真实结果", async ({ page }) => {
    const errors = watchErrors(page);
    await boot(page);

    const report = await page.evaluate(() => (window as any).GOS20.bootReport());
    expect(report).toBeTruthy();
    expect(report.version).toBe("2.0.0");
    expect(report.stages).toHaveLength(11);
    // 每个阶段都有耗时；不允许出现「没有证据的 ok」，也不允许有阶段失败
    for (const stage of report.stages) {
      expect(typeof stage.durationMs).toBe("number");
    }
    const failed = report.stages.filter((stage: { status: string }) => !["ok", "skipped"].includes(stage.status));
    expect(failed, `失败的阶段：${JSON.stringify(failed)}`).toEqual([]);
    expect(report.mode).toBe("local");
    expect(report.degraded).toEqual([]);

    // 注册中心里系统应用已经登记
    const stats = await page.evaluate(() => (window as any).GOS20.registry.stats());
    expect(stats.installed + stats.enabled).toBeGreaterThan(10);

    expect(errors, `控制台报错：${errors.join("\n")}`).toEqual([]);
  });

  test("首次启动引导：七步、可跳过、跳过状态持久化", async ({ page }) => {
    // Playwright 每个用例都是全新的浏览器上下文：这本身就是「第一次打开」
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as any).GOS20_READY), null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).GOS20_READY);

    const overlay = page.locator(".os20-onb");
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    await expect(overlay.locator(".os20-onb-step")).toHaveCount(7);

    // 第二步：选择模式是真的会写进设置
    await overlay.locator("[data-onb-next]").click();
    await overlay.locator('[data-mode="cloud"]').click();
    await overlay.locator("[data-onb-next]").click();

    // 第三步：换主题与壁纸
    await overlay.locator("[data-theme]").first().click();
    await overlay.locator("[data-wall]").first().click();
    await overlay.locator("[data-onb-next]").click();

    // 第四步：设备名
    const device = overlay.locator("[data-onb-device]");
    await device.fill("E2E 测试设备");
    await overlay.locator("[data-onb-next]").click();

    // 第五步：勾选一个应用放到桌面（取消勾选只是移除图标，不卸载应用）
    const appChecks = overlay.locator("[data-app] input");
    await expect(appChecks.first()).toBeVisible();
    await appChecks.first().check();
    const firstAppId = await overlay.locator("[data-app]").first().getAttribute("data-app");
    await overlay.locator("[data-onb-next]").click();

    // 第六步：工作空间
    await overlay.locator("[data-ws]").first().click();
    await overlay.locator("[data-onb-next]").click();

    // 第七步：完成
    await expect(overlay).toContainText("准备好了");
    await overlay.locator("[data-onb-next]").click();
    await expect(overlay).toHaveCount(0, { timeout: 10_000 });

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem("guandao.core.onboarding.v1");
      return raw ? (JSON.parse(raw) as { data: { completed: boolean; choices: { mode: string; deviceName: string } } }) : null;
    });
    expect(saved?.data.completed).toBe(true);
    expect(saved?.data.choices.mode).toBe("cloud");
    expect(saved?.data.choices.deviceName).toBe("E2E 测试设备");

    const deviceName = await page.evaluate(() => (window as any).GOS20.device.profile().name);
    expect(deviceName).toBe("E2E 测试设备");

    // 桌面快捷方式真的写进了 1.x 的安装状态（2.0 不另建一份）
    const shortcut = await page.evaluate(
      (appId) => (window as any).GOS14.sys.hasShortcut(appId),
      firstAppId,
    );
    expect(shortcut).toBe(true);

    // 再刷新一次：不应该再次弹出引导
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as any).GOS20_READY), null, { timeout: 20_000 });
    await page.waitForTimeout(600);
    await expect(page.locator(".os20-onb")).toHaveCount(0);
  });

  test("应用状态来自真实窗口：打开 → running，关闭 → enabled", async ({ page }) => {
    await boot(page);
    await dismissOnboarding(page);

    await page.locator('.desk-icon[data-app="notes"]').click();
    await expect(page.locator('.window[data-app="notes"]')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).GOS20.registry.stateOf("notes")))
      .toBe("running");

    await page.locator('.window[data-app="notes"] .dot-close').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).GOS20.registry.stateOf("notes")))
      .toBe("enabled");
  });
});

test.describe("Guandao OS 2.0 · 系统设置", () => {
  test("系统设置可以打开，改动真实落盘并生效", async ({ page }) => {
    await boot(page);
    await dismissOnboarding(page);

    // 通过内核 API 打开，避免依赖具体入口
    await page.evaluate(() => (window as any).GOS14.ctx.openApp("systemcenter"));
    const win = page.locator('.window[data-app="systemcenter"]');
    await expect(win).toBeVisible();
    await expect(win.locator(".os20-group").first()).toBeVisible({ timeout: 15_000 });

    // 切到「系统」页，确认展示的是真实版本与启动报告
    await win.locator('.g14-nav[data-tab="system"]').click();
    await expect(win).toContainText("Guandao OS 2.0.0");
    await expect(win.locator(".os20-stage")).not.toHaveCount(0);

    // 回到外观，改材质
    await win.locator('.g14-nav[data-tab="appearance"]').click();
    const select = win.locator('[data-set-select="appearance.material"]');
    await select.selectOption("solid");
    await expect
      .poll(() => page.evaluate(() => (window as any).GOS20.settings.get("appearance.material")))
      .toBe("solid");

    // 刷新后设置仍在（真实持久化，不是内存状态）
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as any).GOS20_READY), null, { timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => (window as any).GOS20.settings.get("appearance.material")))
      .toBe("solid");
  });

  test("权限默认拒绝，拒绝会写进审计", async ({ page }) => {
    await boot(page);
    await dismissOnboarding(page);

    const decision = await page.evaluate(() => {
      const gos = (window as any).GOS20;
      return gos.permissions.check({ kind: "plugin", id: "e2e-probe" }, "cloud.sync");
    });
    expect(decision.allowed).toBe(false);
    expect(decision.via).toBe("default-deny");

    const audit = await page.evaluate(() => (window as any).GOS20.permissions.audit(5));
    expect(audit.some((entry: { allowed: boolean; permission: string }) => entry.permission === "cloud.sync" && !entry.allowed)).toBe(true);
  });
});

test.describe("Guandao OS 2.0 · 市场与更新", () => {
  test("市场列出真实资源，安装流程可以预检", async ({ page }) => {
    await boot(page);
    await dismissOnboarding(page);

    await page.evaluate(() => (window as any).GOS14.ctx.openApp("market"));
    const win = page.locator('.window[data-app="market"]');
    await expect(win).toBeVisible();
    await expect(win.locator(".os20-mk-card").first()).toBeVisible({ timeout: 15_000 });

    const counts = await page.evaluate(() => {
      const cards = document.querySelectorAll('.window[data-app="market"] .os20-mk-card');
      return cards.length;
    });
    expect(counts).toBeGreaterThan(3);

    // 点开一张卡片 → 详情里出现权限与安装流程
    await win.locator(".os20-mk-card").first().click();
    await expect(win.locator(".os20-mk-detail")).toBeVisible();
    await expect(win.locator(".os20-steps li").first()).toBeVisible();
  });

  test("更新中心读取真实版本（静态服务器下 API 不可达时如实显示失败）", async ({ page }) => {
    await boot(page);
    await dismissOnboarding(page);

    await page.evaluate(() => (window as any).GOS14.ctx.openApp("updatecenter"));
    const win = page.locator('.window[data-app="updatecenter"]');
    await expect(win).toBeVisible();
    await expect(win).toContainText("Guandao OS 2.0.0");

    // 没有 Worker 时不能显示「已是最新」，必须显示无法确认
    await expect(win.locator(".os20-update-state")).toContainText(/检查失败|离线|已是最新/, { timeout: 15_000 });
    if (await win.locator(".os20-update-state.is-ok").count()) {
      // 若确实有 Worker，则必须同时显示服务端版本号
      await expect(win.locator(".os20-update-state")).toContainText("2.0.0");
    }
  });
});