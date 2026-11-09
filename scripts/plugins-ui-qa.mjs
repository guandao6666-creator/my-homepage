#!/usr/bin/env node
/**
 * Guandao OS 1.7 · 插件沙箱 UI 冒烟测试
 *
 * 前置条件：
 *   1. npm run build
 *   2. node scripts/serve-dist.mjs 4321      （或 QA_BASE 指向任意可访问的构建产物）
 *
 * 覆盖：
 *   - 从插件管理器安装官方 Hello World（真实校验 + 权限确认）
 *   - 通过 Window Manager 启动沙箱应用
 *   - SDK 存储 / 通知 / 对话框 / 主题读取
 *   - 插件无法访问父页面 DOM、localStorage（opaque origin）
 *   - QA_CSP=1 时额外验证 CSP 阻断插件直连外网
 *   - QA_CSP=1 时额外验证 CSP 阻断插件直连外网
 *   - 关闭窗口后运行上下文被回收
 *   - 安装组件插件后桌面出现沙箱 iframe
 *
 * 注意：静态服务器不会下发 Worker 的 CSP，本脚本只验证沙箱隔离与功能；
 * 含 CSP、D1、R2 的安全测试见 scripts/plugins-qa.mjs。
 */

import puppeteer from "puppeteer-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.QA_BASE || "http://127.0.0.1:4321").replace(/\/+$/, "");
const CHROME =
  process.env.CHROME_PATH ||
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) =>
    existsSync(p),
  );

if (!CHROME) {
  console.error("找不到 Chrome，请设置 CHROME_PATH");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "guandao-plugin-qa-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,960"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [];
  const notFound = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  const clickText = async (text) => {
    const hit = await page.evaluate((want) => {
      const nodes = [...document.querySelectorAll("button, a")];
      const exact = nodes.find((node) => (node.innerText || "").trim() === want);
      const partial = nodes.find((node) => (node.innerText || "").includes(want));
      const el = exact || partial;
      if (!el) return false;
      el.click();
      return true;
    }, text);
    if (!hit) throw new Error(`找不到按钮：${text}`);
    await sleep(350);
  };

  const waitFor = async (fn, timeout = 15000, label = "条件") => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await fn()) return true;
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  };

  try {
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("[data-launchpad]", { timeout: 20000 });
    await sleep(2200); // 开机动画

    console.log("\n[1] 启动插件管理器");
    await page.click("[data-launchpad]");
    await sleep(500);
    await clickText("插件管理器");
    await page.waitForSelector('.window[data-app="pm"]', { timeout: 8000 });
    check("插件管理器窗口已打开", true);

    console.log("\n[2] 安装官方 Hello World");
    await page.click('.g14-shell[data-g14="pm"] .g14-nav[data-tab="official"]');
    await page.waitForSelector('[data-act="install-official"][data-id="com.guandao.hello"]', { timeout: 8000 });
    await page.click('[data-act="install-official"][data-id="com.guandao.hello"]');
    await page.waitForSelector(".gp-dialog-layer", { timeout: 8000 });
    const dialogTitle = await page.$eval(".gp-dialog-title", (node) => node.textContent || "");
    check("安装前展示权限审批", /权限/.test(dialogTitle), dialogTitle);
    const permissionCount = await page.$$eval('input[data-perm]', (nodes) => nodes.length);
    check("权限逐项可勾选", permissionCount >= 5, `checkbox=${permissionCount}`);
    await page.click('[data-gp-action="ok"]');
    await waitFor(
      async () => Boolean(await page.$('[data-act="open-detail"][data-id="com.guandao.hello"]')),
      15000,
      "安装完成",
    );
    check("插件安装完成并写入本地记录", true);

    console.log("\n[3] 启动沙箱应用");
    await page.click('[data-act="open-detail"][data-id="com.guandao.hello"]');
    await sleep(300);
    await page.click('[data-act="open-app"]');
    await page.waitForSelector('.window[data-app="plugin:com.guandao.hello"]', { timeout: 12000 });

    let frame = null;
    await waitFor(
      async () => {
        frame = page.frames().find((item) => item.url().startsWith("blob:"));
        return Boolean(frame);
      },
      15000,
      "插件沙箱 iframe",
    );
    await frame.waitForSelector("#count", { timeout: 10000 });
    check("插件在独立 iframe 中渲染", true);

    const origin = await frame.evaluate(() => location.origin);
    check("插件 origin 为 opaque（null）", origin === "null", origin);

    const parentAccess = await frame.evaluate(() => {
      try {
        return window.parent.document.title || "readable";
      } catch {
        return "blocked";
      }
    });
    check("插件无法读取父页面 DOM", parentAccess === "blocked", parentAccess);

    const storageAccess = await frame.evaluate(() => {
      try {
        return String(localStorage.length);
      } catch {
        return "blocked";
      }
    });
    check("插件无法读取宿主 localStorage", storageAccess === "blocked", storageAccess);

    if (process.env.QA_CSP === "1") {
      const network = await frame.evaluate(async () => {
        try {
          await fetch("https://example.com/", { mode: "no-cors", cache: "no-store" });
          return "allowed";
        } catch {
          return "blocked";
        }
      });
      check("CSP 阻断插件直连外网", network === "blocked", network);
    }

    console.log("\n[4] SDK 能力");
    await frame.click("#inc");
    await frame.click("#inc");
    await sleep(300);
    const count = await frame.$eval("#count", (node) => node.textContent?.trim());
    check("插件命名空间存储可用", count === "2", count);

    await frame.click("#notify");
    await sleep(1200);
    const notifyOut = await frame.$eval("#out", (node) => node.textContent || "");
    const notifyStore = await page.evaluate(() => localStorage.getItem("guandao.os.notif.v1") || "");
    const notifyOk = notifyOut.includes('"ok": true') || notifyStore.includes("Hello from a plugin");
    check(
      "通知经过宿主授权后发出",
      notifyOk,
      `frame=${notifyOut.replace(/\s+/g, " ").slice(0, 80)} store=${notifyStore.slice(0, 80)}`,
    );

    await frame.click("#dialog");
    await page.waitForSelector('.gp-dialog-layer [data-value="ok"]', { timeout: 6000 });
    await page.click('.gp-dialog-layer [data-value="ok"]');
    await waitFor(
      async () => {
        const text = await frame.$eval("#out", (node) => node.textContent || "");
        return text.includes('"action": "ok"');
      },
      6000,
      "对话框返回",
    );
    check("对话框由宿主渲染并返回结果", true);

    await frame.click("#theme");
    await waitFor(
      async () => {
        const text = await frame.$eval("#out", (node) => node.textContent || "");
        return text.includes("accent");
      },
      6000,
      "主题读取",
    );
    check("只读主题信息可用", true);

    console.log("\n[5] 关闭窗口后清理上下文");
    await page.click('.window[data-app="plugin:com.guandao.hello"] .dot-close');
    await waitFor(async () => (await page.$$("iframe.gp-frame")).length === 0, 8000, "iframe 移除");
    check("关闭窗口后沙箱 iframe 被销毁", true);

    console.log("\n[6] 组件插件");
    // 详情页需要先返回列表；用 DOM click 避免窗口层级影响命中点
    await page.evaluate(() => {
      const back = document.querySelector('[data-act="back"]');
      if (back) back.click();
      document.querySelector('.g14-shell[data-g14="pm"] .g14-nav[data-tab="official"]')?.click();
    });
    await sleep(500);
    await page.waitForSelector('[data-act="install-official"][data-id="com.guandao.clock"]', { timeout: 8000 });
    await page.click('[data-act="install-official"][data-id="com.guandao.clock"]');
    await page.waitForSelector(".gp-dialog-layer [data-gp-action='ok']", { timeout: 8000 });
    await page.click('[data-gp-action="ok"]');
    await waitFor(
      async () => Boolean(await page.$('[data-widget="plugin-widget:com.guandao.clock"]')),
      12000,
      "组件出现",
    );
    const widgetFrame = await page.$eval(
      '[data-widget="plugin-widget:com.guandao.clock"]',
      (node) => Boolean(node.querySelector("iframe.gp-frame")),
    );
    check("组件插件挂载沙箱 iframe", widgetFrame);

    const serious = consoleErrors.filter(
      (line) =>
        !/favicon|net::ERR_|status of 404|Guandao Account.*404|Content Security Policy|Refused to connect/i.test(line),
    );
    check("主页面没有脚本错误", serious.length === 0, serious.slice(0, 2).join(" | "));
    // 静态服务器没有 Worker，/api/plugins/* 返回 404 是预期行为；其它 404 才是问题
    const missing = notFound.filter((url) => !url.includes("/api/") && !url.includes("/sb/"));
    check("静态资源没有 404", missing.length === 0, missing.slice(0, 3).join(" | "));

    await mkdir(".shots", { recursive: true });
    await page.screenshot({ path: ".shots/plugins-ui-qa.png" });
  } catch (error) {
    failures += 1;
    console.error("\n测试中断：", error.message);
    try {
      await mkdir(".shots", { recursive: true });
      await page.screenshot({ path: ".shots/plugins-ui-qa-failure.png" });
    } catch {
      /* 忽略 */
    }
  } finally {
    await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${results.length - failures}/${results.length} 项通过`);
  process.exit(failures ? 1 : 0);
}

main();
