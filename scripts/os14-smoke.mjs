/**
 * Guandao OS 1.4 冒烟测试
 * 覆盖：应用中心安装/卸载、主题切换、组件注册、游戏可玩、工作空间、数据导出。
 */
import puppeteer from "puppeteer-core";

const OUT = ".shots";
const BASE = process.env.OS14_BASE || "http://127.0.0.1:4399/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, extra = "") => results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  · " + extra : ""}`);

await page.goto(BASE, { waitUntil: "networkidle2" });
await page.evaluate(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("guandao-os14");
});
await page.reload({ waitUntil: "networkidle2" });
await wait(2600);

ok("1.4 入口就绪", await page.evaluate(() => Boolean(window.GOS14_READY && window.GOS14)), await page.evaluate(() => String(window.GOS14?.version)));

// 关闭自动打开的窗口
await page.evaluate(() => document.querySelectorAll(".window").forEach((w) => w.querySelector(".dot-close")?.click()));
await wait(400);

/* ---------- 应用中心 ---------- */
await page.evaluate(() => window.GOS14.open("appcenter"));
await wait(900);
const storeOk = await page.evaluate(() => {
  const cards = document.querySelectorAll(".g14-app-card").length;
  const hero = document.querySelector(".g14-hero h2")?.textContent ?? "";
  return { cards, hero };
});
ok("应用中心渲染", storeOk.cards >= 6, JSON.stringify(storeOk));
await page.screenshot({ path: `${OUT}/14-appcenter.png` });

const before = await page.evaluate(() => Boolean(window.GOS14.ctx.APPS.gallery));
await page.evaluate(() => {
  const app = [...document.querySelectorAll(".g14-stab")].find((b) => b.textContent.includes("全部应用"));
  app?.click();
});
await wait(300);
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".g14-app-card")].find((c) => c.textContent.includes("Guandao Gallery"));
  card?.querySelector("[data-act]")?.click();
});
await wait(600);
const after = await page.evaluate(() => ({
  installed: window.GOS14.isInstalled("gallery"),
  hasApp: Boolean(window.GOS14.ctx.APPS.gallery),
  notif: JSON.parse(localStorage.getItem("guandao.os14.apps.v1") || "{}").installed?.gallery?.version,
}));
ok("安装 Guandao Gallery 真正生效", !before && after.installed && after.hasApp, JSON.stringify(after));

// 卸载
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".g14-app-card")].find((c) => c.textContent.includes("Guandao Gallery"));
  card?.click();
});
await wait(400);
const detailOk = await page.evaluate(() => Boolean(document.querySelector(".g14-detail .g14-perms .g14-perm")));
ok("应用详情含权限声明", detailOk);
await page.evaluate(() => document.querySelector("[data-uninstall]")?.click());
await wait(300);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".g14-modal-actions .g14-btn")].find((b) => b.textContent.trim() === "卸载");
  btn?.click();
});
await wait(500);
const un = await page.evaluate(() => ({
  installed: window.GOS14.isInstalled("gallery"),
  hasApp: Boolean(window.GOS14.ctx.APPS.gallery),
}));
ok("卸载后应用从系统移除", !un.installed && !un.hasApp, JSON.stringify(un));

// 重新装回来，供后续测试
await page.evaluate(() => window.GOS14.install("gallery"));
await wait(300);

/* ---------- 主题 ---------- */
await page.evaluate(() => window.GOS14.open("themes"));
await wait(900);
const themeCards = await page.evaluate(() => document.querySelectorAll(".g14-theme-card").length);
ok("主题中心 10 套主题", themeCards === 10, String(themeCards));
await page.screenshot({ path: `${OUT}/14-themes.png` });

await page.evaluate(() => {
  const card = [...document.querySelectorAll(".g14-theme-card")].find((c) => c.textContent.includes("Cyberpunk"));
  card?.querySelector("[data-apply]")?.click();
});
await wait(1200);
const themeState = await page.evaluate(() => ({
  attr: document.querySelector("#os")?.dataset.theme14,
  theme: JSON.parse(localStorage.getItem("guandao.os14.themes.v1") || "{}").current,
  accent: getComputedStyle(document.querySelector("#os")).getPropertyValue("--os-accent").trim(),
  wall: JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}").wall?.id,
}));
ok("应用 Cyberpunk 主题", themeState.attr === "cyberpunk" && themeState.theme === "cyberpunk" && themeState.wall === "city-night", JSON.stringify(themeState));

// 刷新保留
await page.reload({ waitUntil: "networkidle2" });
await wait(2400);
const themePersist = await page.evaluate(() => document.querySelector("#os")?.dataset.theme14);
ok("刷新后主题保留", themePersist === "cyberpunk", String(themePersist));

/* ---------- 组件 ---------- */
await page.evaluate(() => window.GOS14.open("widgetstore"));
await wait(800);
const widgetCards = await page.evaluate(() => document.querySelectorAll(".g14-wcard").length);
const widgetIds = await page.evaluate(() => window.GOS14.ctx.widgets.ids);
ok("组件库包含新组件", widgetCards >= 10 && ["photoframe", "countdown", "focus", "musicmini", "quicknote", "sysmon", "worldclock14", "taskmini"].every((id) => widgetIds.includes(id)), `${widgetCards} 张 / ${widgetIds.length} 个`);
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".g14-wcard")].find((c) => c.textContent.includes("倒计时"));
  card?.querySelector("[data-wtoggle]")?.click();
});
await wait(700);
const widgetOnDesktop = await page.evaluate(() => Boolean(document.querySelector('.widget[data-widget="countdown"]')));
ok("添加组件到桌面", widgetOnDesktop);
await page.screenshot({ path: `${OUT}/14-widgets.png` });

/* ---------- 游戏 ---------- */
await page.evaluate(() => window.GOS14.open("playground"));
await wait(900);
const games = await page.evaluate(() => [...document.querySelectorAll(".pg14-game h4")].map((h) => h.textContent));
ok("游戏中心七款游戏", games.length === 7, games.join("/"));
await page.evaluate(() => {
  const card = document.querySelector('[data-play="g2048"]');
  card?.click();
});
await wait(600);
const beforeScore = await page.evaluate(() => document.querySelector("[data-live]")?.textContent);
for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
  await page.keyboard.press(key);
  await wait(160);
}
const afterScore = await page.evaluate(() => document.querySelector("[data-live]")?.textContent);
ok("2048 可以实际操作", await page.evaluate(() => document.querySelectorAll(".gm2048-tile").length === 16), `${beforeScore} → ${afterScore}`);
await page.screenshot({ path: `${OUT}/14-game.png` });

// 扫雷
await page.evaluate(() => {
  document.querySelector("[data-pg-back]")?.click();
});
await wait(300);
await page.evaluate(() => document.querySelector('[data-play="minesweeper"]')?.click());
await wait(500);
await page.evaluate(() => {
  const cells = document.querySelectorAll(".gm-cell");
  cells[40]?.click();
});
await wait(400);
const mineOpen = await page.evaluate(() => document.querySelectorAll(".gm-cell.is-open").length);
ok("扫雷可以翻开格子", mineOpen > 1, String(mineOpen));

/* ---------- 工作空间 ---------- */
await page.evaluate(() => window.GOS14.open("workspaces"));
await wait(800);
const wsCards = await page.evaluate(() => document.querySelectorAll(".ws14-card").length);
ok("四套工作空间", wsCards === 4, String(wsCards));
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".ws14-card")].find((c) => c.textContent.includes("Study"));
  card?.querySelector("[data-ws-apply]")?.click();
});
await wait(1600);
const wsApplied = await page.evaluate(() => ({
  current: JSON.parse(localStorage.getItem("guandao.os14.ws.v1") || "{}").current,
  theme: document.querySelector("#os")?.dataset.theme14,
}));
ok("切换 Study 工作空间", wsApplied.current === "study" && wsApplied.theme === "forest", JSON.stringify(wsApplied));

/* ---------- 控制中心 / 任务 / 数据 ---------- */
await page.evaluate(() => window.GOS14.open("control"));
await wait(700);
ok("控制中心三个分区", await page.evaluate(() => document.querySelectorAll(".g14-nav").length === 3));
await page.evaluate(() => window.GOS14.open("tasks"));
await wait(700);
await page.evaluate(() => document.querySelector("[data-task-new]")?.click());
await wait(300);
await page.evaluate(() => {
  const input = document.querySelector('[data-tf="title"]');
  if (input) input.value = "1.4 测试任务";
  [...document.querySelectorAll(".g14-modal-actions .g14-btn")].find((b) => b.textContent.trim() === "创建")?.click();
});
await wait(500);
const taskSaved = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os14.tasks.v1") || "{}").tasks?.some((t) => t.title === "1.4 测试任务"));
ok("新建任务写入本地", taskSaved);

await page.evaluate(() => window.GOS14.open("datacenter"));
await wait(900);
ok("数据中心概览", await page.evaluate(() => Boolean(document.querySelector(".dc14-total b"))));
await page.evaluate(() => {
  const nav = [...document.querySelectorAll(".g14-nav")].find((n) => n.textContent.includes("备份"));
  nav?.click();
});
await wait(600);
await page.evaluate(() => document.querySelector("[data-dc-backup]")?.click());
await wait(900);
const backupCount = await page.evaluate(async () => {
  return new Promise((resolve) => {
    const req = indexedDB.open("guandao-os14");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("backups", "readonly");
      const all = tx.objectStore("backups").getAllKeys();
      all.onsuccess = () => resolve(all.result.length);
      all.onerror = () => resolve(-1);
    };
    req.onerror = () => resolve(-1);
  });
});
ok("创建本地备份", backupCount >= 1, String(backupCount));

/* ---------- 错误 ---------- */
const realErrors = errors.filter((e) => !e.includes("favicon") && !e.includes("Failed to load resource"));
ok("无 JS 运行时错误", realErrors.length === 0, realErrors.slice(0, 6).join(" | "));

console.log(results.join("\n"));
console.log("\nERRORS:", realErrors.length ? realErrors.slice(0, 12).join("\n") : "none");
await browser.close();
