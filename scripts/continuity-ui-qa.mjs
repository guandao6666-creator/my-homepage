/**
 * Guandao OS 1.8 · Adaptive Shell / Mobile / Continuity UI 冒烟测试
 *
 * 覆盖：
 *   - 桌面 / 平板 / 超宽屏 / 手机竖屏 / 手机横屏 五种视口
 *   - 接力中心、发送到设备、设备配对二维码
 *   - 移动端首页、笔记编辑、任务抽屉、日历、设备页
 *   - 横向溢出、控制台错误与关键可点击尺寸
 *
 * 用法：BASE=http://127.0.0.1:8787 node scripts/continuity-ui-qa.mjs
 */

import puppeteer from "puppeteer-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LAPTOP = process.env.QA_LAPTOP || "qa-plugin-dev-token-1234567890";
const PHONE = process.env.QA_PHONE || "qa-continuity-phone-token-1234567890";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function open({ width, height, mobile = false, cookie = LAPTOP, url = "/" }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "gd-uiqa-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const userAgent = mobile
    ? "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";
  await page.setUserAgent(userAgent);
  await page.setCookie({ name: "gauth_sid", value: cookie, domain: "127.0.0.1", path: "/" });
  const errors = [];
  page.on("pageerror", (error) => errors.push("PAGEERROR " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(1600);
  return { browser, page, profile, errors };
}

const clickLaunch = (page, name) =>
  page.evaluate((label) => {
    const node = [...document.querySelectorAll("#launchpad *")].find((item) => (item.innerText || "").trim() === label);
    node?.click();
  }, name);

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function desktop() {
  console.log("\n[1] 桌面 1440×900");
  const { browser, page, profile, errors } = await open({ width: 1440, height: 900 });
  check("外壳为 desktop", (await page.evaluate(() => document.documentElement.dataset.shell)) === "desktop");
  check("版本号 1.8", (await page.evaluate(() => document.querySelector(".mb-version")?.textContent)) === "1.8");
  check("没有横向溢出", (await overflow(page)) <= 1);

  await page.click("[data-launchpad]");
  await sleep(350);
  await clickLaunch(page, "接力中心");
  await sleep(1400);
  check("接力中心打开", await page.evaluate(() => Boolean(document.querySelector("[data-cx]"))));
  const nav = await page.evaluate(() => {
    const item = document.querySelector(".cty-nav-item");
    const style = getComputedStyle(item);
    return { height: item.getBoundingClientRect().height, bg: style.backgroundColor, text: item.innerText };
  });
  check("侧栏项可点击高度 ≥ 36", nav.height >= 36, `${nav.height}`);
  check("侧栏项不是浏览器默认白底", !nav.bg.startsWith("rgb(240"), nav.bg);

  await page.evaluate(() => document.querySelector('.window[data-app="continuity"] .dot-close')?.click());
  await sleep(400);
  await page.click("[data-launchpad]");
  await sleep(300);
  await clickLaunch(page, "Guandao Notes");
  await sleep(1100);
  await page.evaluate(() => document.querySelector("[data-n-send]")?.click());
  await sleep(700);
  check("发送到设备弹窗出现", await page.evaluate(() => Boolean(document.querySelector('input[name="cty-target"]'))));
  check("目标设备列表非空", (await page.evaluate(() => document.querySelectorAll('input[name="cty-target"]').length)) >= 2);
  await page.screenshot({ path: ".shots/ui-desktop-send.png" });
  await page.evaluate(() => document.querySelector(".g14-modal-actions [data-mv='']")?.click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('.window[data-app="notes"] .dot-close')?.click());
  await sleep(300);

  await page.click("[data-launchpad]");
  await sleep(300);
  await clickLaunch(page, "Guandao Devices");
  await sleep(1400);
  await page.evaluate(() => document.querySelector('[data-act="pair"]')?.click());
  await sleep(1300);
  const pairing = await page.evaluate(() => ({
    code: document.querySelector(".cty-code")?.textContent?.trim() || "",
    qr: Boolean(document.querySelector(".cty-qr svg")),
  }));
  check("配对码为 6 位数字", /^\d{6}$/.test(pairing.code), pairing.code);
  check("二维码已渲染", pairing.qr);
  await page.evaluate(() => document.querySelector(".cty-close")?.click());
  await sleep(300);
  check("桌面无脚本错误", errors.filter((line) => !/favicon|ERR_|status of 404/i.test(line)).length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

async function tablet() {
  console.log("\n[2] 平板 834×1112");
  const { browser, page, profile, errors } = await open({ width: 834, height: 1112, mobile: true });
  check("外壳为 tablet", (await page.evaluate(() => document.documentElement.dataset.shell)) === "tablet");
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll(".mb-menu-btn")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), text: button.textContent };
    }),
  );
  check("菜单项保持横排且可点", menu.every((item) => item.width >= 40 && item.height <= 48), JSON.stringify(menu));
  check("没有横向溢出", (await overflow(page)) <= 1);
  await page.screenshot({ path: ".shots/ui-tablet.png" });

  await page.click("[data-launchpad]");
  await sleep(350);
  await clickLaunch(page, "Guandao Notes");
  await sleep(1200);
  const win = await page.evaluate(() => {
    const rect = document.querySelector('.window[data-app="notes"]').getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), viewport: window.innerWidth };
  });
  check("平板窗口接近满宽", win.width >= win.viewport - 48, JSON.stringify(win));
  check("平板窗口高度 ≥ 600", win.height >= 600, `${win.height}`);
  await page.screenshot({ path: ".shots/ui-tablet-notes.png" });
  check("平板无脚本错误", errors.filter((line) => !/favicon|ERR_|status of 404/i.test(line)).length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

async function landscape() {
  console.log("\n[3] 平板横屏 1112×834");
  const { browser, page, profile } = await open({ width: 1112, height: 834, mobile: true });
  check("横屏仍为 tablet", (await page.evaluate(() => document.documentElement.dataset.shell)) === "tablet");
  check("没有横向溢出", (await overflow(page)) <= 1);
  const menu = await page.evaluate(() => [...document.querySelectorAll(".mb-menu-btn")].map((b) => Math.round(b.getBoundingClientRect().width)));
  check("横屏菜单未被压扁", menu.every((width) => width >= 40), JSON.stringify(menu));
  await page.screenshot({ path: ".shots/ui-tablet-landscape.png" });
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

async function ultrawide() {
  console.log("\n[4] 超宽屏 2560×1080");
  const { browser, page, profile } = await open({ width: 2560, height: 1080 });
  check("外壳为 desktop", (await page.evaluate(() => document.documentElement.dataset.shell)) === "desktop");
  await page.click("[data-launchpad]");
  await sleep(350);
  await clickLaunch(page, "Guandao Notes");
  await sleep(1200);
  const width = await page.evaluate(() => Math.round(document.querySelector('.window[data-app="notes"]').getBoundingClientRect().width));
  check("超宽屏窗口不超过 1480px", width <= 1480, `${width}`);
  check("没有横向溢出", (await overflow(page)) <= 1);
  await page.screenshot({ path: ".shots/ui-ultrawide.png" });
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

async function mobile() {
  console.log("\n[5] 手机 390×844");
  const { browser, page, profile, errors } = await open({ width: 390, height: 844, mobile: true, cookie: PHONE });
  check("自动进入 /m/", page.url().includes("/m/"), page.url());
  check("外壳为 mobile", (await page.evaluate(() => document.documentElement.dataset.shell)) === "mobile");
  check("底部导航 5 项", (await page.evaluate(() => document.querySelectorAll(".m-tab").length)) === 5);
  check("没有横向溢出", (await overflow(page)) <= 1);
  await page.screenshot({ path: ".shots/ui-mobile-home.png" });

  await page.evaluate(() => document.querySelector('[data-m-act="tab"][data-tab="notes"]')?.click());
  await sleep(500);
  await page.evaluate(() => document.querySelector(".m-fab")?.click());
  await sleep(500);
  check("新笔记标题为空", (await page.evaluate(() => document.querySelector('[data-m-input="note-title"]')?.value)) === "");
  await page.type('[data-m-input="note-body"]', "移动端布局测试内容");
  await sleep(700);
  check("笔记已保存到本地", await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os14.notes.v1")).notes.some((n) => n.body.includes("移动端布局测试内容"))));
  await page.screenshot({ path: ".shots/ui-mobile-editor.png" });
  // 编辑态不显示底部导航，先返回列表再切换
  await page.evaluate(() => document.querySelector('[data-m-act="back"]')?.click());
  await sleep(500);

  await page.evaluate(() => document.querySelector('[data-m-act="tab"][data-tab="tasks"]')?.click());
  await sleep(500);
  await page.evaluate(() => document.querySelector(".m-fab")?.click());
  await sleep(500);
  const sheet = await page.evaluate(() => {
    const actions = document.querySelector(".m-sheet-actions")?.getBoundingClientRect();
    return { visible: Boolean(actions && actions.bottom <= window.innerHeight + 1), bottom: actions?.bottom };
  });
  check("任务抽屉操作区可见", sheet.visible, JSON.stringify(sheet));
  await page.screenshot({ path: ".shots/ui-mobile-task-sheet.png" });
  await page.evaluate(() => document.querySelector('[data-sheet-value=""]')?.click());
  await sleep(300);

  await page.evaluate(() => document.querySelector('[data-m-act="tab"][data-tab="calendar"]')?.click());
  await sleep(600);
  const today = await page.evaluate(() => {
    const button = document.querySelector(".m-cal-nav .m-btn");
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  check("今天按钮不换行", today.width >= 50 && today.height <= 44, JSON.stringify(today));
  check("没有横向溢出", (await overflow(page)) <= 1);
  await page.screenshot({ path: ".shots/ui-mobile-calendar.png" });

  await page.evaluate(() => document.querySelector('[data-m-act="tab"][data-tab="more"]')?.click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('[data-m-act="sub"][data-sub="devices"]')?.click());
  await sleep(900);
  check("设备页读取真实设备", (await page.evaluate(() => document.querySelectorAll(".m-device-row").length)) >= 1);
  await page.screenshot({ path: ".shots/ui-mobile-devices.png" });

  check("手机无脚本错误", errors.filter((line) => !/favicon|ERR_|status of 404/i.test(line)).length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

async function mobileLandscape() {
  console.log("\n[6] 手机横屏 844×390");
  const { browser, page, profile, errors } = await open({ width: 844, height: 390, mobile: true, cookie: PHONE });
  check("横屏手机仍为 mobile", (await page.evaluate(() => document.documentElement.dataset.shell)) === "mobile");
  check("没有横向溢出", (await overflow(page)) <= 1);
  check("底部导航仍可见", await page.evaluate(() => document.querySelector(".m-tabbar")?.getBoundingClientRect().bottom <= window.innerHeight + 1));
  await page.screenshot({ path: ".shots/ui-mobile-landscape.png" });
  check("横屏无脚本错误", errors.filter((line) => !/favicon|ERR_|status of 404/i.test(line)).length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}

await mkdir(".shots", { recursive: true });
await desktop();
await tablet();
await landscape();
await ultrawide();
await mobile();
await mobileLandscape();

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log(`失败项：${failures.join(" / ")}`);
  process.exit(1);
}
