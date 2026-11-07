#!/usr/bin/env node
/**
 * Phase 2.1 CSS 拆分的视觉回归截图。
 *
 * 用法：
 *   node scripts/visual-css-shots.mjs .shots/phase-2.1-before
 *
 * 说明：
 * - 只读访问本地 dist（由 scripts/serve-dist.mjs 提供），不接触生产；
 * - 截图时禁用 animation/transition，避免壁纸/时钟造成非确定性差异；
 * - 同时输出 layout.json（关键元素 boundingBox），便于逐项对比。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:4399";
const OUT = path.resolve(process.argv[2] || ".shots/phase-2.1-before");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const layouts = {};

async function newPage({ width, height, mobile = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: "dark",
  });
  const origin = new URL(BASE).origin;
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  // 固定时钟，避免截图期间时间/日期变化造成伪差异。
  await page.clock.install({ time: new Date("2026-11-06T10:52:00Z") });
  return { context, page };
}

async function bootDesktop(page, { desktopQuery = false } = {}) {
  await page.goto(desktopQuery ? `${BASE}/?desktop=1` : `${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.GOS20_READY === true || !document.getElementById("boot"),
    null,
    { timeout: 20_000 },
  ).catch(() => undefined);
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 20_000 }).catch(() => undefined);
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.click().catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector(".os20-onb"), null, { timeout: 10_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(300);
}

async function bootMobile(page) {
  await page.goto(`${BASE}/m/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mobile-root", { timeout: 20_000 });
  await page.waitForTimeout(600);
}

async function freeze(page) {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
    .toast,.os-toast,.ach-toast,.notif-toast{display:none!important}`,
  });
}

async function setTheme(page, theme) {
  await page.evaluate((value) => {
    document.body.dataset.osTheme = value;
    document.documentElement.dataset.osTheme = value;
    try { localStorage.setItem("guandao.os.theme.v1", value); } catch {}
  }, theme);
  await page.waitForTimeout(200);
}

async function capture(page, name) {
  await freeze(page);
  const boxes = {};
  for (const [key, selector] of Object.entries({
    os: "#os",
    menubar: ".menubar",
    dock: "#dock",
    windows: ".window",
    widgets: "#widgets",
    spotlight: "#spotlight",
    mission: "#mission",
  })) {
    const locator = page.locator(selector).first();
    boxes[key] = (await locator.count()) ? await locator.boundingBox() : null;
  }
  layouts[name] = boxes;
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  console.log(`  shot ${name}`);
}

async function desktopState(width, height, name, fn) {
  const { context, page } = await newPage({ width, height });
  await bootDesktop(page);
  await setTheme(page, "dark");
  await fn(page);
  await capture(page, name);
  await context.close();
}

/* 桌面 1440×900：完整状态 */
await desktopState(1440, 900, "1440x900-initial-dark", async () => {});
await desktopState(1440, 900, "1440x900-light", async (page) => setTheme(page, "light"));
await desktopState(1440, 900, "1440x900-dock-hidden", async (page) => {
  await page.evaluate(() => {
    const os = document.querySelector(".os");
    if (!os) return;
    os.dataset.dockAuto = "1";
    os.dataset.dockPos = "bottom";
    os.classList.remove("dock-awake");
  });
  await page.waitForTimeout(300);
});
await desktopState(1440, 900, "1440x900-dock-visible", async (page) => {
  await page.evaluate(() => {
    const os = document.querySelector(".os");
    if (!os) return;
    os.dataset.dockAuto = "1";
    os.dataset.dockPos = "bottom";
    os.classList.add("dock-awake");
  });
  await page.waitForTimeout(300);
});
await desktopState(1440, 900, "1440x900-menubar-open", async (page) => {
  await page.locator('[data-menu-btn="view"]').click();
  await page.waitForTimeout(300);
});
await desktopState(1440, 900, "1440x900-window-open", async (page) => {
  await page.evaluate(() => window.GOS14?.ctx?.openApp("notes"));
  await page.locator('.window[data-app="notes"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
});
await desktopState(1440, 900, "1440x900-window-max", async (page) => {
  await page.evaluate(() => window.GOS14?.ctx?.openApp("notes"));
  const win = page.locator('.window[data-app="notes"]');
  await win.waitFor({ state: "visible", timeout: 15_000 });
  await win.locator(".dot-max").click();
  await page.waitForTimeout(500);
});
await desktopState(1440, 900, "1440x900-window-drag", async (page) => {
  await page.evaluate(() => window.GOS14?.ctx?.openApp("terminal"));
  const win = page.locator('.window[data-app="terminal"]');
  await win.waitFor({ state: "visible", timeout: 15_000 });
  const box = await win.locator(".titlebar").boundingBox();
  if (box) {
    await page.mouse.move(box.x + 80, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 120, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
});
await desktopState(1440, 900, "1440x900-multi-window", async (page) => {
  await page.evaluate(() => {
    window.GOS14?.ctx?.openApp("notes");
    window.GOS14?.ctx?.openApp("terminal");
    window.GOS14?.ctx?.openApp("settings");
  });
  await page.locator('.window[data-app="settings"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800);
});
await desktopState(1440, 900, "1440x900-spotlight", async (page) => {
  await page.keyboard.press("Control+k");
  await page.locator("#spotlight").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#spotlight-input").fill("终端");
  await page.waitForTimeout(300);
});
await desktopState(1440, 900, "1440x900-widget", async (page) => {
  await page.evaluate(() => {
    const host = document.getElementById("widgets");
    if (host) host.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
});
/* 桌面卡片选择器：点击 #card-tools 触发 openCardPicker（该按钮在 1440 宽度下不可见，故直接派发 click） */
await desktopState(1440, 900, "1440x900-dialog", async (page) => {
  await page.evaluate(() => {
    document.getElementById("card-tools")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.locator("#card-picker").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400);
});

/* 1920×1080：初始 + 多窗口 */
await desktopState(1920, 1080, "1920x1080-initial-dark", async () => {});
await desktopState(1920, 1080, "1920x1080-multi-window", async (page) => {
  await page.evaluate(() => {
    window.GOS14?.ctx?.openApp("notes");
    window.GOS14?.ctx?.openApp("terminal");
  });
  await page.locator('.window[data-app="terminal"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
});

/* 平板 */
for (const [width, height] of [[768, 1024], [1024, 768]]) {
  await desktopState(width, height, `${width}x${height}-initial`, async () => {});
  await desktopState(width, height, `${width}x${height}-window`, async (page) => {
    await page.evaluate(() => window.GOS14?.ctx?.openApp("notes"));
    await page.locator('.window[data-app="notes"]').waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(500);
  });
}

/* 手机：移动端页面 + 强制桌面布局（验证响应式 CSS） */
for (const [width, height] of [[390, 844], [430, 932]]) {
  {
    const { context, page } = await newPage({ width, height, mobile: true });
    await bootMobile(page);
    await capture(page, `${width}x${height}-mobile`);
    await context.close();
  }
  await desktopState(width, height, `${width}x${height}-desktop-shell`, async (page) => {
    // bootDesktop 默认进入 /；这里用 ?desktop=1 覆盖移动重定向
    await page.goto(`${BASE}/?desktop=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  });
}

writeFileSync(path.join(OUT, "layout.json"), `${JSON.stringify(layouts, null, 2)}\n`, "utf8");
await browser.close();
console.log(`[shots] ${Object.keys(layouts).length} 张 → ${OUT}`);