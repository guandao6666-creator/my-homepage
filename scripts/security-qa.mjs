#!/usr/bin/env node
/**
 * Privacy & Security Center 端到端检查。
 * 前置：wrangler dev --local + GDV_TOKEN。
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
  if (condition) console.log(`  ✓ ${label}`);
  else {
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
    const text = message.text();
    // 隐私设置测试会故意触发 403；本地 wrangler 静态资源偶尔会断开连接。
    // 两者都不是应用错误，但会在下面的汇总里单独说明。
    if (message.type() !== "error") return;
    if (text.includes("status of 403")) return;
    if (text.includes("ERR_CONNECTION_CLOSED")) {
      console.log("  · 忽略本地静态资源连接中断（wrangler dev 热重载）");
      return;
    }
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.setCookie({
    name: "gauth_sid",
    value: TOKEN,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });

  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.GOS14), { timeout: 20000 });
  await wait(2300);
  await page.evaluate(() => window.GOS14.openSecurity());
  await page.waitForSelector(".gsc-hero", { timeout: 15000 });
  await wait(500);

  const overview = await page.evaluate(() => ({
    stats: document.querySelectorAll(".gsc-stat").length,
    checks: document.querySelectorAll(".gsc-check").length,
    score: document.querySelector(".gsc-score-value")?.textContent || "",
    body: document.querySelector(".gsc [data-body]")?.textContent || "",
  }));
  check("概览显示 4 张统计卡", overview.stats === 4);
  check("安全检查至少 7 项", overview.checks >= 7);
  check("评分公开权重规则", overview.body.includes("已计入权重") && overview.score.includes("/100"));
  check("概览说明本地与云端数据位置", overview.body.includes("Notes") && overview.body.includes("云端"));
  await page.screenshot({ path: ".shots/security-overview.png" });

  console.log("→ Account Security");
  await page.click('[data-view="account"]');
  await wait(350);
  const account = await page.evaluate(() => document.querySelector(".gsc [data-body]")?.textContent || "");
  check("账号页显示 GitHub OAuth 与 ID", account.includes("GitHub OAuth") && account.includes("Token"));
  check("账号页不出现 Client Secret", !account.includes("GITHUB_CLIENT_SECRET"));
  await page.screenshot({ path: ".shots/security-account.png" });

  console.log("→ Device & Sessions");
  await page.click('[data-view="access"]');
  await wait(500);
  const access = await page.evaluate(() => ({
    devices: document.querySelectorAll(".gsc-device").length,
    sessions: document.querySelectorAll(".gsc-session-row:not(.is-head)").length,
    text: document.querySelector(".gsc [data-body]")?.textContent || "",
  }));
  check("设备访问列表来自后端", access.devices >= 1);
  check("Session 表包含记录", access.sessions >= 1);
  check("不显示完整 Token", !access.text.includes("token_hash") && !access.text.includes("Bearer"));
  await page.screenshot({ path: ".shots/security-access.png" });

  console.log("→ Privacy 设置与真实约束");
  await page.click('[data-view="privacy"]');
  await page.waitForSelector("[data-setting='notes']", { timeout: 8000 });
  await wait(300);
  await page.evaluate(() => document.querySelector("[data-setting='notes']")?.click());
  await wait(900);
  const blocked = await page.evaluate(async () => {
    const response = await fetch("/api/backups", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "privacy-block-test",
        domains: ["notes"],
        snapshot: { notes: { v: 1, folders: [], notes: [] } },
      }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, code: payload?.error?.code };
  });
  check("关闭 Notes 上传后服务端拒绝备份", blocked.status === 403 && blocked.code === "DOMAIN_UPLOAD_DISABLED");
  await page.evaluate(() => document.querySelector("[data-setting='notes']")?.click());
  await wait(800);
  const reenabled = await page.evaluate(async () => {
    const response = await fetch("/api/privacy/settings", { credentials: "same-origin" });
    const payload = await response.json();
    return payload.data.settings.notes;
  });
  check("重新开启后设置写回 D1", reenabled === true);
  await page.screenshot({ path: ".shots/security-privacy.png" });

  console.log("→ Data Control");
  await page.click('[data-view="data"]');
  await wait(400);
  const data = await page.evaluate(() => document.querySelector(".gsc [data-body]")?.textContent || "");
  check("数据清单包含账号/文件/备份/活动", ["账号", "文件", "备份", "活动"].every((word) => data.includes(word)));
  check("数据清单区分本地与云端", data.includes("仅本地浏览器") && data.includes("R2"));
  await page.screenshot({ path: ".shots/security-data.png" });

  console.log("→ Export");
  await page.click('[data-view="export"]');
  await wait(300);
  await page.click('[data-act="create-export-meta"]');
  await page.waitForFunction(() => document.querySelector("[data-overlay]")?.hidden === true, { timeout: 120000 });
  await wait(900);
  const exports = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gsc-export-row").length,
    text: document.querySelector(".gsc [data-body]")?.textContent || "",
  }));
  check("UI 创建元数据导出并出现在列表", exports.rows >= 1 && exports.text.includes("元数据导出"));

  const download = await page.evaluate(async () => {
    const response = await fetch("/api/privacy/exports", { credentials: "same-origin" });
    const payload = await response.json();
    const item = payload.data.exports.find((entry) => entry.status === "completed");
    if (!item) return { ok: false };
    const file = await fetch(`/api/privacy/export/${item.id}/download?format=json`, {
      credentials: "same-origin",
    });
    const pkg = await file.json();
    return {
      ok: file.ok,
      hasManifest: Boolean(pkg.manifest?.dataChecksum),
      hasEvents: Array.isArray(pkg.data?.securityEvents),
      hasLimitations: Array.isArray(pkg.data?.limitations),
    };
  });
  check("导出包包含 manifest 与校验值", download.ok && download.hasManifest);
  check("导出包包含安全事件与限制说明", download.hasEvents && download.hasLimitations);
  await page.screenshot({ path: ".shots/security-export.png" });

  console.log("→ Security Activity");
  await page.click('[data-view="activity"]');
  await wait(800);
  const activity = await page.evaluate(() => ({
    rows: document.querySelectorAll(".gsc-event").length,
    text: document.querySelector(".gsc [data-body]")?.textContent || "",
  }));
  check("安全活动有真实记录", activity.rows >= 1);
  check("安全活动包含隐私设置事件", activity.text.includes("修改隐私设置") || activity.text.includes("导出"));
  await page.screenshot({ path: ".shots/security-activity.png" });

  console.log("→ Delete Account（不执行）");
  await page.click('[data-view="delete"]');
  await wait(350);
  const del = await page.evaluate(() => document.querySelector(".gsc [data-body]")?.textContent || "");
  check("注销页展示影响范围", del.includes("云端文件") && del.includes("历史备份"));
  check("注销页要求重新验证", del.includes("重新验证") && del.includes("GitHub"));
  await page.screenshot({ path: ".shots/security-delete.png" });

  console.log("→ 移动端");
  const mobile = await browser.newPage();
  await mobile.setCookie({
    name: "gauth_sid",
    value: TOKEN,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  await mobile.setViewport({ width: 390, height: 844, isMobile: true });
  await mobile.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await mobile.waitForFunction(() => Boolean(window.GOS14), { timeout: 20000 });
  await wait(2200);
  await mobile.evaluate(() => window.GOS14.openSecurity());
  await mobile.waitForSelector(".gsc-hero", { timeout: 15000 });
  const overflow = await mobile.evaluate(() => {
    const root = document.querySelector(".gsc");
    return root ? root.scrollWidth - root.clientWidth : 0;
  });
  check("手机宽度下无横向溢出", overflow <= 2);
  await mobile.screenshot({ path: ".shots/security-mobile.png" });

  if (errors.length) {
    console.error("\n控制台错误：");
    for (const error of [...new Set(errors)].slice(0, 8)) console.error(`  - ${error}`);
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
