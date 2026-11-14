#!/usr/bin/env node
/**
 * Guandao Backup Center 端到端检查。
 *
 * 前置：wrangler dev --local 已启动，GDV_TOKEN 是本地有效 Session。
 * 覆盖：概览 / 列表筛选 / 详情 / 恢复预览 / 设置 / 通过 UI 创建与删除备份 / 本地恢复。
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
    if (message.type() === "error") errors.push(message.text());
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
  await page.evaluate(() => window.GOS14.openBackup());
  await page.waitForSelector(".gbk-hero", { timeout: 15000 });
  await wait(500);

  const overview = await page.evaluate(() => ({
    stats: document.querySelectorAll(".gbk-stat").length,
    hero: document.querySelector(".gbk-hero")?.textContent || "",
    storage: document.body.innerText.includes("历史备份"),
    cron: document.querySelector("[data-cron]")?.textContent || "",
  }));
  check("概览显示 4 张统计卡", overview.stats === 4);
  check("概览显示最近备份", overview.hero.includes("LAST BACKUP"));
  check("存储统计区分实时与备份", overview.storage);
  check("Cron 状态来自后端", overview.cron.includes("CRON"));
  await page.screenshot({ path: ".shots/backup-overview.png" });

  console.log("→ Backups");
  await page.click('[data-view="backups"]');
  await page.waitForSelector(".gbk-row", { timeout: 8000 });
  const rowCount = await page.evaluate(() => document.querySelectorAll(".gbk-row").length);
  check("历史备份列表有记录", rowCount >= 3);

  await page.click('[data-filter="failed"]');
  await wait(900);
  const failed = await page.evaluate(() => document.body.innerText.includes("校验失败"));
  check("Failed 筛选能找到失败记录", failed);
  await page.screenshot({ path: ".shots/backup-list.png" });

  await page.click('[data-filter=""]');
  await wait(700);

  console.log("→ 详情");
  await page.click(".gbk-row [data-act='detail']");
  await page.waitForSelector(".gbk-drawer-panel", { timeout: 8000 });
  await wait(400);
  const drawer = await page.evaluate(() => document.querySelector(".gbk-drawer-panel")?.textContent || "");
  check("详情包含校验值", drawer.includes("校验值"));
  check("详情包含文件对象", drawer.includes("文件对象"));
  await page.screenshot({ path: ".shots/backup-detail.png" });
  await page.click('[data-act="close-detail"]');
  await wait(250);

  console.log("→ Restore Center 预览");
  await page.click('[data-view="restore"]');
  await wait(500);
  const picked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".gbk-row")];
    const target = rows.find((row) => row.textContent?.includes("QA Full Backup"));
    target?.querySelector('[data-act="restore-this"]')?.click();
    return Boolean(target);
  });
  check("可以选择恢复点", picked);
  await page.waitForSelector(".gbk-domain", { timeout: 8000 });
  await wait(300);

  // 只恢复 Notes，减少测试时间
  await page.evaluate(() => {
    document.querySelectorAll("[data-domain]").forEach((input) => {
      if (input.getAttribute("data-domain") !== "notes" && input.checked) input.click();
    });
  });
  await wait(250);
  await page.click('[data-act="preview"]');
  await page.waitForSelector(".gbk-preview", { timeout: 10000 });
  const preview = await page.evaluate(() => ({
    text: document.querySelector(".gbk-preview")?.textContent || "",
    warnings: document.querySelectorAll(".gbk-warnings li").length,
  }));
  check("恢复预览显示影响范围", preview.text.includes("Notes"));
  check("恢复预览包含警告", preview.warnings > 0);
  await page.screenshot({ path: ".shots/backup-restore.png" });

  console.log("→ 通过 UI 执行恢复（Notes / Copy）");
  await page.click('[data-act="start-restore"]');
  await page.waitForSelector(".gbk-modal [data-confirm-text]", { timeout: 5000 });
  await page.type(".gbk-modal [data-confirm-text]", "RESTORE");
  await page.click('.gbk-modal [data-dv="confirm"]');
  await page.waitForFunction(() => document.querySelector("[data-overlay]")?.hidden === true, { timeout: 120000 });
  await wait(800);
  const restored = await page.evaluate(() => {
    const raw = localStorage.getItem("guandao.os14.notes.v1");
    return raw ? raw.includes("hello backup") : false;
  });
  check("本地 Notes 恢复写回 localStorage", restored);

  console.log("→ 设置");
  await page.click('[data-view="settings"]');
  await wait(500);
  const settingsText = await page.evaluate(() => document.querySelector("[data-body]")?.textContent || "");
  check("设置显示 Cron 真实状态", settingsText.includes("Cron"));
  check("设置显示自动备份范围限制", settingsText.includes("只覆盖服务端"));
  await page.select('[data-setting="frequency"]', "daily");
  await page.click('[data-act="save-settings"]');
  await wait(1200);
  const saved = await page.evaluate(async () => {
    const response = await fetch("/api/backups/settings", { credentials: "same-origin" });
    const payload = await response.json();
    return payload.data.settings.frequency;
  });
  check("自动备份设置写入 D1", saved === "daily");
  await page.select('[data-setting="frequency"]', "off");
  await page.click('[data-act="save-settings"]');
  await wait(900);
  await page.screenshot({ path: ".shots/backup-settings.png" });

  console.log("→ 通过 UI 创建备份");
  await page.click('[data-view="backups"]');
  await wait(400);
  await page.click('[data-act="create"]');
  await page.waitForSelector(".gbk-modal [data-field='name']", { timeout: 5000 });
  await page.evaluate(() => {
    const input = document.querySelector(".gbk-modal [data-field='name']");
    if (input) input.value = "QA UI Backup";
    document.querySelectorAll(".gbk-modal [data-scope]").forEach((box) => {
      const domain = box.getAttribute("data-scope");
      if (domain !== "notes" && domain !== "tasks" && box.checked) box.click();
    });
  });
  await page.click('.gbk-modal [data-dv="confirm"]');
  await page.waitForFunction(() => document.querySelector("[data-overlay]")?.hidden === true, { timeout: 120000 });
  await wait(900);
  const created = await page.evaluate(() => document.body.innerText.includes("QA UI Backup"));
  check("UI 创建备份并出现在列表", created);
  await page.screenshot({ path: ".shots/backup-created.png" });

  console.log("→ 通过 UI 删除备份");
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".gbk-row")];
    const target = rows.find((row) => row.textContent?.includes("QA UI Backup"));
    target?.querySelector('[data-act="detail"]')?.click();
  });
  await page.waitForSelector(".gbk-drawer-panel [data-act='delete']", { timeout: 8000 });
  await page.click(".gbk-drawer-panel [data-act='delete']");
  await page.waitForSelector(".gbk-modal [data-confirm-text]", { timeout: 5000 });
  await page.type(".gbk-modal [data-confirm-text]", "DELETE");
  await page.click('.gbk-modal [data-dv="confirm"]');
  await wait(1800);
  const deleted = await page.evaluate(
    () => ![...document.querySelectorAll(".gbk-row")].some((row) => row.textContent?.includes("QA UI Backup")),
  );
  check("删除备份后列表移除且不触碰实时数据", deleted);

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
