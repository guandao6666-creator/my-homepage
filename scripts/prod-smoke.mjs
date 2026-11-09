#!/usr/bin/env node
/**
 * 生产环境冒烟（1.9）
 *
 * 只做只读检查：页面能否启动、版本号是否正确、关键接口是否健康。
 * 不写入任何数据，不登录账号。
 *
 * 用法：node scripts/prod-smoke.mjs [url]
 */
import { chromium } from "playwright";

const base = process.argv[2] || "https://guandao.xin";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const health = await fetch(`${base}/api/health`, { headers: { accept: "application/json" } })
  .then((response) => response.json())
  .catch((error) => ({ error: String(error) }));
check("GET /api/health 可达", health.success === true, health.status ?? health.error);
check("版本为 1.9.0", health.version === "1.9.0", `version=${health.version}`);
check("D1 已连接", health.services?.d1 === "connected", health.services?.d1);
check("R2 可用", health.services?.r2 === "available", health.services?.r2);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !/\/api\/|Failed to load resource/.test(message.text())) {
    errors.push(message.text());
  }
});

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector("#os", { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 30_000 });
check("桌面外壳启动", true);
check("版本标签为 1.9", (await page.locator(".mb-version").innerText()).trim() === "1.9", await page.locator(".mb-version").innerText());

// 打开一个按需加载的应用（便签），确认 chunk 能在生产环境取到
await page.locator('.desk-icon[data-app="notes"]').click();
const notesReady = await page
  .waitForSelector('.window[data-app="notes"] .n14-search', { timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
check("按需加载应用（便签）可打开", notesReady);

check("无未捕获脚本错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);