#!/usr/bin/env node
/**
 * Guandao Devices 端到端检查。
 *
 * 前置：
 *   - `npx wrangler dev --local --port 8787` 已启动
 *   - 本地 D1 里存在一个有效 Session，令牌通过 GDV_TOKEN 传入
 *
 * 用法：GDV_TOKEN=xxx node scripts/devices-qa.mjs
 * 输出：.shots/devices-*.png + 控制台断言结果
 */
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.OS14_BASE || "http://127.0.0.1:8787/";
const TOKEN = process.env.GDV_TOKEN;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => existsSync(path));

if (!TOKEN) {
  console.error("缺少 GDV_TOKEN");
  process.exit(1);
}
if (!CHROME) {
  console.error("找不到 Chrome / Edge");
  process.exit(1);
}

if (!existsSync(".shots")) mkdirSync(".shots", { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const errors = [];

const check = (label, condition) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures.push(label);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 900 },
});

try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("requestfailed", (request) =>
    errors.push(`request failed: ${request.url()} (${request.failure()?.errorText || "unknown"})`),
  );

  await page.setCookie({
    name: "gauth_sid",
    value: TOKEN,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });

  console.log("→ 载入桌面");
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.GOS14), { timeout: 20000 });
  await wait(2400);

  console.log("→ 打开 Guandao Devices");
  await page.evaluate(() => window.GOS14.openDevices());
  await page.waitForSelector(".gdv", { timeout: 10000 });
  await page.waitForSelector(".gdv-hero", { timeout: 15000 });
  await wait(600);

  const overview = await page.evaluate(async () => {
    const response = await fetch("/api/devices", { credentials: "same-origin" });
    const payload = await response.json();
    return {
      hero: document.querySelector(".gdv-hero")?.textContent || "",
      stats: document.querySelectorAll(".gdv-stat").length,
      currentBadge: document.body.innerText.includes("CURRENT DEVICE"),
      alertBanner: Boolean(document.querySelector(".gdv-alert-banner")),
      apiAlerts: payload.data.alerts.length,
      apiDevices: payload.data.devices.length,
    };
  });

  check("概览渲染账号与当前设备", overview.hero.includes("Test Admin") && overview.hero.includes("Office PC"));
  check("概览包含四张统计卡", overview.stats === 4);
  check(
    "新设备提示与后端告警一致",
    overview.alertBanner === overview.apiAlerts > 0,
  );
  await page.screenshot({ path: ".shots/devices-overview.png" });

  console.log("→ My Devices");
  await page.click('[data-view="devices"]');
  await page.waitForSelector(".gdv-card", { timeout: 8000 });
  await wait(350);
  const groups = await page.evaluate(() => ({
    groups: document.querySelectorAll(".gdv-group").length,
    cards: document.querySelectorAll(".gdv-card").length,
    current: document.querySelectorAll(".gdv-card.is-current").length,
  }));
  check("按设备类型分组", groups.groups >= 3);
  check("设备卡片包含已撤销设备", groups.cards >= 4);
  check("当前设备唯一", groups.current === 1);
  await page.screenshot({ path: ".shots/devices-list.png" });

  console.log("→ 设备详情");
  await page.click('.gdv-card [data-act="detail"]');
  await page.waitForSelector(".gdv-drawer-panel", { timeout: 8000 });
  await wait(400);
  const drawer = await page.evaluate(() => ({
    text: document.querySelector(".gdv-drawer-panel")?.textContent || "",
    sessions: document.querySelectorAll(".gdv-drawer-panel .gdv-session-row").length,
  }));
  check("详情抽屉包含基础信息", drawer.text.includes("基础信息") && drawer.text.includes("登录信息"));
  check("详情包含同步状态", drawer.text.includes("Cloud Drive"));
  check("详情列出 Session", drawer.sessions > 0);
  await page.screenshot({ path: ".shots/devices-detail.png" });
  await page.click('[data-act="close-detail"]');
  await wait(250);

  console.log("→ Sessions");
  await page.click('[data-view="sessions"]');
  await wait(400);
  const sessions = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gdv-session-row").length,
    current: document.body.innerText.includes("当前会话"),
  }));
  check("Session 列表有数据", sessions.rows > 0);
  check("当前会话被标记", sessions.current);
  await page.screenshot({ path: ".shots/devices-sessions.png" });

  console.log("→ Security Activity");
  await page.click('[data-view="activity"]');
  await page.waitForSelector(".gdv-tl-item", { timeout: 8000 });
  const activity = await page.evaluate(() => document.querySelectorAll(".gdv-tl-item").length);
  check("安全活动有记录", activity > 0);
  await page.screenshot({ path: ".shots/devices-activity.png" });

  console.log("→ 移动端布局");
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, isMobile: true });
  await mobile.setCookie({
    name: "gauth_sid",
    value: TOKEN,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  await mobile.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await mobile.waitForFunction(() => Boolean(window.GOS14), { timeout: 20000 });
  await wait(2200);
  await mobile.evaluate(() => window.GOS14.openDevices());
  await mobile.waitForSelector(".gdv-hero", { timeout: 15000 });
  await mobile.click('[data-view="devices"]');
  await mobile.waitForSelector(".gdv-card", { timeout: 10000 });
  await wait(400);
  const overflow = await mobile.evaluate(() => {
    const root = document.querySelector(".gdv");
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  check("手机宽度下无横向溢出", overflow <= 2);
  await mobile.screenshot({ path: ".shots/devices-mobile.png" });

  if (errors.length) {
    console.error("\n控制台错误：");
    for (const error of [...new Set(errors)].slice(0, 10)) console.error(`  - ${error}`);
  }
  check("没有控制台错误", errors.length === 0);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
