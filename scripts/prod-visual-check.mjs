#!/usr/bin/env node
/**
 * 生产 UI 只读复测（Phase 2.1 验收补证）。
 *
 * 只做 GET 与截图：
 * - 不登录、不写任何数据、不调用管理接口；
 * - 不修改、不部署、不清理生产资源。
 *
 * 用法：
 *   node scripts/prod-visual-check.mjs
 *   PROD_BASE=https://guandao.xin node scripts/prod-visual-check.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.PROD_BASE || "https://guandao.xin";
const OUT = path.resolve(".shots/prod-2.1");
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, at: new Date().toISOString(), states: [], checks: [] };
function check(name, pass, detail = "") {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function newPage({ width, height, mobile = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  return { context, page };
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  report.states.push(name);
  console.log(`  shot ${name}`);
}

try {
  /* ---------------- 桌面 ---------------- */
  const { context, page } = await newPage({ width: 1440, height: 900 });
  const cssAssets = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.endsWith(".css")) cssAssets.push({ url: url.split("/").pop(), status: response.status() });
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 30_000 }).catch(() => undefined);
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.click().catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector(".os20-onb"), null, { timeout: 15_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(1500);

  const boxes = {};
  for (const [key, selector] of Object.entries({
    menubar: ".menubar",
    dock: "#dock",
    os: "#os",
    widgets: "#widgets",
  })) {
    const locator = page.locator(selector).first();
    boxes[key] = (await locator.count()) ? await locator.boundingBox() : null;
  }
  report.desktopBoxes = boxes;

  check("桌面：菜单栏已渲染", Boolean(boxes.menubar), JSON.stringify(boxes.menubar));
  check("桌面：程序坞已渲染", Boolean(boxes.dock), JSON.stringify(boxes.dock));
  check("桌面：外壳占满视口", Boolean(boxes.os) && boxes.os.width === 1440, JSON.stringify(boxes.os));

  const iconCount = await page.locator(".desk-icon").count();
  check("桌面：图标数量合理", iconCount >= 15, `icons=${iconCount}`);

  const bundle = cssAssets.find((a) => a.url.startsWith("index."));
  check("桌面：桌面样式包已加载", Boolean(bundle) && bundle.status === 200, bundle?.url ?? "missing");

  await shot(page, "1440x900-desktop");

  /* 打开一个窗口，确认窗口系统正常 */
  await page.evaluate(() => window.GOS14?.ctx?.openApp("notes"));
  const win = page.locator('.window[data-app="notes"]');
  const winVisible = await win.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
  check("桌面：窗口可以打开", winVisible, winVisible ? "" : "notes 窗口未出现");
  if (winVisible) {
    await page.waitForTimeout(600);
    await shot(page, "1440x900-window");
    const titlebar = await win.locator(".titlebar").boundingBox();
    check("桌面：标题栏尺寸正常", Boolean(titlebar) && titlebar.height > 20, JSON.stringify(titlebar));
  }

  await context.close();

  /* ---------------- 移动端 ---------------- */
  const mobileView = await newPage({ width: 390, height: 844, mobile: true });
  await mobileView.page.goto(`${BASE}/m/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const root = await mobileView.page.locator("#mobile-root").waitFor({ state: "attached", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("移动端：/m/ 已渲染", root);
  await mobileView.page.waitForTimeout(1200);

  const tabbarCount = await mobileView.page.locator(".m-tabbar, .mb-tabbar, [data-tabbar]").count();
  check("移动端：底栏存在", tabbarCount > 0, `matches=${tabbarCount}`);
  await shot(mobileView.page, "390x844-mobile");
  await mobileView.context.close();
} catch (error) {
  check("生产复测执行", false, String(error?.message ?? error).slice(0, 200));
} finally {
  await browser.close();
}

const failed = report.checks.filter((c) => !c.pass);
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log("");
console.log(`[prod-visual] ${report.checks.length - failed.length}/${report.checks.length} 通过 → ${OUT}`);
process.exit(failed.length ? 1 : 0);