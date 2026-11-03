/**
 * Guandao OS 1.3 视觉/交互回归脚本（本地用，不进产物）
 * 用法：node scripts/os13-check.mjs [url]
 */
import puppeteer from "puppeteer-core";
import path from "node:path";

const URL = process.argv[2] || "http://localhost:4321/";
const OUT = path.resolve(".shots");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
});

const page = await browser.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") errors.push(`[${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

const metrics = await page.evaluate(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    dock: rect(".dock"),
    dockItem: rect(".dock-item"),
    icons: document.querySelectorAll(".desk-icon:not([hidden])").length,
    widget: rect(".widget"),
    widgets: [...document.querySelectorAll(".widget")].map((w) => ({ id: w.dataset.widget, ...(() => { const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; })() })),
    wall: getComputedStyle(document.querySelector(".wp-layer.is-on") || document.body).backgroundImage.slice(0, 90),
    accent: getComputedStyle(document.querySelector("#os")).getPropertyValue("--os-accent"),
    version: document.querySelector(".mb-version")?.textContent,
    settings13: !!document.querySelector(".settings13"),
    localStorageKeys: Object.keys(localStorage).filter((k) => k.startsWith("guandao")).length,
  };
});

console.log(JSON.stringify(metrics, null, 2));
await page.screenshot({ path: path.join(OUT, "check-desktop.png") });

// 打开设置 → 壁纸
await page.evaluate(() => window.GOS13?.openSettings("wallpaper"));
await new Promise((r) => setTimeout(r, 900));
const settings = await page.evaluate(() => {
  const win = document.querySelector('.window[data-app="settings"]');
  const r = win?.getBoundingClientRect();
  return {
    mounted: !!document.querySelector(".settings13"),
    size: r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } : null,
    cards: document.querySelectorAll(".wall-card").length,
    tabs: document.querySelectorAll(".s13-tabs button").length,
    panelVisible: document.querySelector('.s-panel[data-panel="wallpaper"]')?.hidden === false,
  };
});
console.log(JSON.stringify(settings, null, 2));
await page.screenshot({ path: path.join(OUT, "check-settings.png") });

// 切主题 + 换壁纸
await page.evaluate(() => {
  document.querySelector('[data-preset="ocean"]')?.click();
});
await new Promise((r) => setTimeout(r, 900));
const afterPreset = await page.evaluate(() => ({
  accent: getComputedStyle(document.querySelector("#os")).getPropertyValue("--os-accent"),
  wallId: JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}").wall?.id,
  body: document.body.dataset.osTheme,
}));
console.log(JSON.stringify(afterPreset, null, 2));
await page.screenshot({ path: path.join(OUT, "check-ocean.png") });

// 右键菜单
await page.mouse.click(760, 620, { button: "right" });
await new Promise((r) => setTimeout(r, 350));
const menu = await page.evaluate(() => ({ open: !!document.querySelector(".ctxmenu"), items: document.querySelectorAll(".ctxmenu .ctx-item").length }));
console.log(JSON.stringify(menu, null, 2));
await page.screenshot({ path: path.join(OUT, "check-menu.png") });

console.log("CONSOLE:", errors.length ? errors.slice(0, 12) : "clean");

await browser.close();
