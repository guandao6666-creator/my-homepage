/**
 * Guandao OS 1.4 深度功能测试
 * 覆盖五款新应用、组件计时、工作空间快照、自定义主题、彩蛋与数据迁移。
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.OS14_BASE || "http://127.0.0.1:4399/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("/sb/") && !m.text().includes("Failed to load resource")) errors.push(`console: ${m.text()}`);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, pass, extra = "") => results.push(`${pass ? "PASS" : "FAIL"}  ${n}${extra ? "  · " + extra : ""}`);

const fixture = path.resolve(".shots/fixture.txt");
fs.mkdirSync(".shots", { recursive: true });
fs.writeFileSync(fixture, "# 测试文档\n\n这是一段用于验证阅读器的文本。\n" + "行内容。\n".repeat(60));

await page.goto(BASE + "?t=" + Date.now(), { waitUntil: "networkidle2" });
await page.evaluate(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("guandao-os14");
});
await page.reload({ waitUntil: "networkidle2" });
await wait(2600);
await page.evaluate(() => {
  document.querySelectorAll(".window").forEach((w) => w.querySelector(".dot-close")?.click());
  window.GOS14.install("gallery");
  window.GOS14.install("reader");
});
await wait(600);

/* ---------------- 笔记 ---------------- */
await page.evaluate(() => window.GOS14.open("notes"));
await wait(800);
await page.evaluate(() => document.querySelector("[data-n-new]")?.click());
await wait(300);
await page.type("[data-n-title]", "深度测试笔记");
await page.type("[data-n-body]", "\n## 小节\n\n自动保存测试。\n");
await wait(900);
const noteSaved = await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}");
  return st.notes?.some((n) => n.title === "深度测试笔记" && n.body.includes("自动保存测试"));
});
ok("笔记自动保存", noteSaved);
await page.evaluate(() => {
  [...document.querySelectorAll("[data-n-mode]")].find((b) => b.textContent === "预览")?.click();
});
await wait(400);
const mdRendered = await page.evaluate(() => Boolean(document.querySelector(".n14-preview h5, .n14-preview h4, .n14-preview h3")));
ok("Markdown 预览渲染", mdRendered);
await page.evaluate(() => document.querySelector('[data-n-mode="edit"]')?.click());
await wait(200);
await page.evaluate(() => document.querySelector(".window[data-app='notes'] .dot-close")?.click());
await wait(300);

/* ---------------- 日历 ---------------- */
await page.evaluate(() => window.GOS14.open("calendar"));
await wait(800);
await page.evaluate(() => [...document.querySelectorAll("[data-c14-new]")].pop()?.click());
await wait(400);
await page.evaluate(() => {
  const input = document.querySelector('[data-ef="title"]');
  if (input) input.value = "深度测试日程";
});
await page.evaluate(() => {
  [...document.querySelectorAll(".g14-modal-actions .g14-btn")].find((b) => b.textContent.trim() === "创建")?.click();
});
await wait(500);
const eventSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os14.calendar.v1") || "{}").events?.some((e) => e.title === "深度测试日程"));
ok("日历新建日程", eventSaved);
await page.evaluate(() => document.querySelector(".window[data-app='calendar'] .dot-close")?.click());
await wait(300);

/* ---------------- 相册 ---------------- */
await page.evaluate(() => window.GOS14.open("gallery"));
await wait(800);
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click("[data-ga-import]")]);
await chooser.accept([path.resolve("public/wallpapers/coast.webp")]);
await wait(2200);
const galleryState = await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("guandao.os14.gallery.v1") || "{}");
  return { count: st.photos?.length ?? 0, thumbs: document.querySelectorAll(".ga14-thumb img").length };
});
ok("相册导入图片并显示缩略图", galleryState.count === 1 && galleryState.thumbs >= 1, JSON.stringify(galleryState));
await page.evaluate(() => document.querySelector("[data-ga-open]")?.click());
await wait(500);
ok("相册大图预览", await page.evaluate(() => Boolean(document.querySelector(".ga14-lightbox img")?.getAttribute("src"))));
await page.evaluate(() => document.querySelector("[data-lb-close]")?.click());
await page.evaluate(() => document.querySelector(".window[data-app='gallery'] .dot-close")?.click());
await wait(300);

/* ---------------- 阅读器 ---------------- */
await page.evaluate(() => window.GOS14.open("reader"));
await wait(800);
const [chooser2] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click("[data-rd-import]")]);
await chooser2.accept([fixture]);
await wait(1600);
const readerState = await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("guandao.os14.reader.v1") || "{}");
  return { books: st.books?.length ?? 0, text: document.querySelector(".rd14-text")?.textContent?.slice(0, 10) ?? "" };
});
ok("阅读器导入文本并显示", readerState.books === 1 && readerState.text.includes("测试文档"), JSON.stringify(readerState));
await page.evaluate(() => document.querySelector("[data-rd-font='+']")?.click());
await wait(200);
const fontSize = await page.evaluate(() => document.querySelector(".rd14-page")?.style.fontSize);
ok("阅读器字号调整", fontSize === "18px", String(fontSize));
await page.evaluate(() => document.querySelector(".window[data-app='reader'] .dot-close")?.click());
await wait(300);

/* ---------------- 文件管理器 ---------------- */
await page.evaluate(() => window.GOS14.open("files"));
await wait(800);
const [chooser3] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click("[data-fs-import]")]);
await chooser3.accept([fixture]);
await wait(1600);
const fsImported = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os.fs.v1") || "[]").some((n) => n.name?.startsWith("fixture")));
ok("文件导入写入虚拟文件系统", fsImported);
// 移到回收站
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".fs14-card")].find((c) => c.textContent.includes("fixture"));
  card?.querySelector("[data-fs-menu]")?.click();
});
await wait(300);
await page.evaluate(() => {
  [...document.querySelectorAll(".g14-modal .g14-menu-item")].find((b) => b.dataset.mm === "trash")?.click();
});
await wait(500);
const trashed = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os.fs.v1") || "[]").some((n) => n.name?.startsWith("fixture") && n.trashed));
ok("文件移入回收站", trashed);
await page.evaluate(() => {
  [...document.querySelectorAll("[data-fs-view]")].find((b) => b.dataset.fsView === "trash")?.click();
});
await wait(400);
ok("回收站显示已删除文件", await page.evaluate(() => document.querySelectorAll(".fs14-card").length >= 1));
await page.evaluate(() => {
  const card = document.querySelector(".fs14-card");
  card?.querySelector("[data-fs-menu]")?.click();
});
await wait(300);
await page.evaluate(() => {
  [...document.querySelectorAll(".g14-modal .g14-menu-item")].find((b) => b.dataset.mm === "restore")?.click();
});
await wait(500);
const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os.fs.v1") || "[]").some((n) => n.name?.startsWith("fixture") && !n.trashed));
ok("从回收站恢复文件", restored);
await page.evaluate(() => document.querySelector(".window[data-app='files'] .dot-close")?.click());
await wait(300);

/* ---------------- 组件计时 ---------------- */
await page.evaluate(() => {
  window.GOS14.ctx.widgets.setEnabled("countdown", true);
  window.GOS14.ctx.widgets.setEnabled("focus", true);
});
await wait(1500);
const widgetTick = await page.evaluate(() => ({
  count: document.querySelector('[data-widget="countdown"] [data-w14c-num]')?.textContent,
  focus: document.querySelector('[data-widget="focus"] [data-f-time]')?.textContent,
}));
ok("倒计时 / 专注组件渲染", Boolean(widgetTick.count) && Boolean(widgetTick.focus), JSON.stringify(widgetTick));
await page.evaluate(() => {
  const btn = document.querySelector('[data-widget="focus"] [data-f-toggle]');
  btn?.click();
});
await wait(1200);
const focusRunning = await page.evaluate(() => ({
  label: document.querySelector('[data-widget="focus"] [data-f-toggle]')?.textContent,
  stored: JSON.parse(localStorage.getItem("guandao.os14.focus.v1") || "{}").running,
}));
ok("专注计时可以开始", focusRunning.stored === true && focusRunning.label === "暂停", JSON.stringify(focusRunning));

/* ---------------- 工作空间快照 ---------------- */
await page.evaluate(() => window.GOS14.open("notes"));
await wait(700);
await page.evaluate(() => window.GOS14.open("workspaces"));
await wait(700);
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".ws14-card")].find((c) => c.textContent.includes("Daily"));
  card?.querySelector("[data-ws-save]")?.click();
});
await wait(600);
const savedOpen = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os14.ws.v1") || "{}").list?.find((w) => w.id === "daily")?.openApps);
ok("保存当前布局到工作空间", Array.isArray(savedOpen) && savedOpen.includes("notes"), JSON.stringify(savedOpen));
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".ws14-card")].find((c) => c.textContent.includes("Study"));
  card?.querySelector("[data-ws-apply]")?.click();
});
await wait(1800);
const afterSwitch = await page.evaluate(() => ({
  current: JSON.parse(localStorage.getItem("guandao.os14.ws.v1") || "{}").current,
  windows: [...document.querySelectorAll(".window")].map((w) => w.dataset.app),
}));
ok("切换 Study 后窗口按场景重开", afterSwitch.current === "study" && afterSwitch.windows.includes("reader"), JSON.stringify(afterSwitch));

/* ---------------- 自定义主题 ---------------- */
await page.evaluate(() => window.GOS14.open("themes"));
await wait(800);
await page.evaluate(() => {
  [...document.querySelectorAll(".g14-nav")].find((n) => n.dataset.tab === "editor")?.click();
});
await wait(400);
await page.evaluate(() => {
  const name = document.querySelector('[data-f="name"]');
  if (name) name.value = "测试主题";
  const accent = document.querySelector('[data-f="accent"]');
  if (accent) accent.value = "#ff6b6b";
});
await page.evaluate(() => document.querySelector("[data-save]")?.click());
await wait(900);
const custom = await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem("guandao.os14.themes.v1") || "{}");
  return { n: st.custom?.length ?? 0, current: st.current, accent: JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}").appearance?.accent };
});
ok("自定义主题保存并应用", custom.n === 1 && custom.accent === "#ff6b6b", JSON.stringify(custom));

/* ---------------- 彩蛋 / 终端 ---------------- */
const terminal = await page.evaluate(() => {
  const r1 = window.GOS14.terminal("guandao");
  const r2 = window.GOS14.terminal("play");
  return { r1, r2, eggs: Object.keys(JSON.parse(localStorage.getItem("guandao.os14.eggs.v1") || "{}").found || {}) };
});
ok("终端隐藏命令与彩蛋", Boolean(terminal.r1) && terminal.eggs.includes("terminal"), JSON.stringify(terminal));

/* ---------------- 错误 ---------------- */
ok("深度测试期间无 JS 错误", errors.length === 0, errors.slice(0, 5).join(" | "));
console.log(results.join("\n"));
console.log("\nERRORS:", errors.length ? errors.slice(0, 10).join("\n") : "none");
await browser.close();
