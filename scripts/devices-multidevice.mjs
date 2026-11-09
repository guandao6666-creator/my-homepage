#!/usr/bin/env node
/**
 * Guandao Devices 双设备实测。
 *
 * 用两个独立浏览器上下文模拟两台真实设备（不同 Cookie、不同 UA 视图），
 * 验证：两台设备各自登记 → A 撤销 B → B 下一次请求收到 401 并回到登录界面。
 *
 * 用法：
 *   GDV_TOKEN=设备A令牌 GDV_TOKEN_B=设备B令牌 node scripts/devices-multidevice.mjs
 */
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.OS14_BASE || "http://127.0.0.1:8787/";
const TOKEN_A = process.env.GDV_TOKEN;
const TOKEN_B = process.env.GDV_TOKEN_B;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => existsSync(path));

if (!TOKEN_A || !TOKEN_B) {
  console.error("缺少 GDV_TOKEN 或 GDV_TOKEN_B");
  process.exit(1);
}
if (!CHROME) {
  console.error("找不到 Chrome / Edge");
  process.exit(1);
}
if (!existsSync(".shots")) mkdirSync(".shots", { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
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

const openAs = async (token) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setCookie({
    name: "gauth_sid",
    value: token,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.GOS14), { timeout: 20000 });
  await wait(2300);
  return page;
};

try {
  console.log("→ 设备 A / 设备 B 分别登录");
  const pageA = await openAs(TOKEN_A);
  const pageB = await openAs(TOKEN_B);

  const apiA = await pageA.evaluate(async () => {
    const response = await fetch("/api/devices", { credentials: "same-origin" });
    return response.json();
  });
  const apiB = await pageB.evaluate(async () => {
    const response = await fetch("/api/devices", { credentials: "same-origin" });
    return response.json();
  });

  const idA = apiA.data.currentDeviceId;
  const idB = apiB.data.currentDeviceId;
  check("两台设备生成了不同的 device_id", Boolean(idA && idB && idA !== idB));
  check("设备 A 能在列表中看到设备 B", apiA.data.devices.some((device) => device.id === idB));
  check("设备 B 也把 A 视为另一台设备", apiB.data.devices.some((device) => device.id === idA));

  const currentA = apiA.data.devices.find((device) => device.id === idA);
  const currentB = apiA.data.devices.find((device) => device.id === idB);
  check("设备 A/B 的 UA 解析结果不同", currentA?.os !== currentB?.os || currentA?.browser !== currentB?.browser);

  console.log("→ 设备 B 打开 Guandao Devices");
  await pageB.evaluate(() => window.GOS14.openDevices());
  await pageB.waitForSelector(".gdv-hero", { timeout: 15000 });
  const bCurrent = await pageB.evaluate(() => document.querySelector("[data-current]")?.textContent || "");
  check("设备 B 正确标记为当前设备", bCurrent.includes("当前"));

  console.log("→ 设备 A 撤销设备 B");
  await pageA.evaluate(() => window.GOS14.openDevices());
  await pageA.waitForSelector(".gdv-hero", { timeout: 15000 });
  await pageA.click('[data-view="devices"]');
  await pageA.waitForSelector(".gdv-card", { timeout: 10000 });

  const revoked = await pageA.evaluate((targetId) => {
    const card = document.querySelector(`.gdv-card[data-device="${targetId}"]`);
    if (!card) return "no-card";
    const button = card.querySelector('[data-act="revoke"]');
    if (!button) return "no-button";
    button.click();
    return "clicked";
  }, idB);
  check("设备 A 的设备卡片上有撤销入口", revoked === "clicked");

  await pageA.waitForSelector(".gdv-modal", { timeout: 5000 });
  await pageA.click('.gdv-modal [data-dv="confirm"]');
  await wait(1500);
  await pageA.screenshot({ path: ".shots/devices-two-a.png" });

  const afterA = await pageA.evaluate(async () => {
    const response = await fetch("/api/devices", { credentials: "same-origin" });
    return response.json();
  });
  const bRow = afterA.data.devices.find((device) => device.id === idB);
  check("设备 B 在 D1 中变为已撤销", bRow?.status === "revoked");
  check("设备 B 的有效 Session 归零", bRow?.activeSessionCount === 0);

  console.log("→ 设备 B 下一次请求");
  await pageB.click('[data-act="refresh"]');
  await wait(1400);

  const bState = await pageB.evaluate(() => ({
    signedOut: document.body.innerText.includes("登录已失效") || document.body.innerText.includes("登录权限已被撤销"),
    loginVisible: !document.getElementById("gauth")?.hidden,
    text: document.querySelector(".gdv [data-body]")?.textContent?.slice(0, 120) || "",
  }));
  check("设备 B 收到 401 并显示登录失效界面", bState.signedOut);
  check("设备 B 弹出重新登录层", bState.loginVisible);
  await pageB.screenshot({ path: ".shots/devices-two-b-revoked.png" });

  console.log("→ 设备 A 重命名设备");
  const renameTarget = afterA.data.devices.find(
    (device) => device.status === "active" && !device.isCurrent,
  );
  if (renameTarget) {
    await pageA.evaluate((targetId) => {
      const card = document.querySelector(`.gdv-card[data-device="${targetId}"]`);
      card?.querySelector('[data-act="rename"]')?.click();
    }, renameTarget.id);
    await pageA.waitForSelector(".gdv-modal [data-field='name']", { timeout: 5000 });
    await pageA.evaluate(() => {
      const input = document.querySelector(".gdv-modal [data-field='name']");
      if (input) input.value = "Study Laptop QA";
    });
    await pageA.click('.gdv-modal [data-dv="confirm"]');
    await wait(1200);

    const renamed = await pageA.evaluate(async (targetId) => {
      const response = await fetch("/api/devices", { credentials: "same-origin" });
      const payload = await response.json();
      return payload.data.devices.find((device) => device.id === targetId)?.name;
    }, renameTarget.id);
    check("设备名称写入 D1 并回读一致", renamed === "Study Laptop QA");
  } else {
    check("存在可重命名的其他设备", false);
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n双设备实测通过");
