/**
 * Guandao OS 1.3 功能回归（本地）
 * 覆盖：壁纸切换/适配/自定义上传、Dock 位置与尺寸、图标自由布局与持久化、
 *       右键菜单、设置分类、主题持久化、移动端布局。
 */
import puppeteer from "puppeteer-core";
import path from "node:path";

const OUT = path.resolve(".shots");
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = () => page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}"));
const results = [];
const ok = (name, pass, extra = "") => {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  · " + extra : ""}`);
};

await page.goto("http://localhost:4321/", { waitUntil: "networkidle2" });
await wait(1500);

// 清空后重载，从默认状态开始
await page.evaluate(() => {
  localStorage.clear();
  indexedDB.deleteDatabase("guandao-os13");
});
await page.reload({ waitUntil: "networkidle2" });
await wait(2000);
await page.evaluate(() => document.querySelectorAll(".window").forEach((w) => w.remove()));
await wait(300);

ok("默认壁纸 = aurora", (await cfg()).wall?.id === "aurora", JSON.stringify(await page.evaluate(() => getComputedStyle(document.querySelector("#os")).getPropertyValue("--os-accent"))));

// 设置窗口 + 每个分类
await page.evaluate(() => window.GOS13.openSettings("desktop"));
await wait(700);
const tabs = await page.evaluate(() => [...document.querySelectorAll(".s13-tabs [data-tab]")].map((b) => b.dataset.tab));
let tabsOk = true;
for (const t of tabs) {
  await page.click(`.s13-tabs [data-tab="${t}"]`);
  await wait(120);
  const vis = await page.evaluate((tab) => {
    const p = document.querySelector(`.s-panel[data-panel="${tab}"]`);
    return !!p && !p.hidden;
  }, t);
  if (!vis) tabsOk = false;
}
ok("10 个设置分类都能打开", tabsOk, tabs.join(","));

// 壁纸分类 + 切换
await page.click('.s13-tabs [data-tab="wallpaper"]');
await wait(150);
await page.click('[data-cat="nature"]');
await wait(200);
const natureCards = await page.evaluate(() => document.querySelectorAll(".wall-card").length);
ok("自然分类 8 张", natureCards === 8, String(natureCards));

await page.click('[data-wall-id="sunset"]');
await wait(900);
const afterWall = await cfg();
const layerBg = await page.evaluate(() => getComputedStyle(document.querySelector(".wp-layer.is-on")).backgroundImage);
ok("切换到日落壁纸", afterWall.wall.id === "sunset" && layerBg.includes("sunset.webp"), layerBg.slice(0, 60));
ok("强调色跟随壁纸", afterWall.appearance.accent.toLowerCase() === "#c97f62");
ok("壁纸卡片选中态同步", await page.evaluate(() => document.querySelector('[data-wall-id="sunset"]')?.classList.contains("is-active")));

// 适配方式
await page.click('[data-seg="wall.fit"] button[data-val="contain"]');
await wait(250);
ok("壁纸适配 contain", (await page.evaluate(() => document.querySelector("#os").dataset.wpFit)) === "contain");

// 收藏
await page.evaluate(() => document.querySelector('[data-fav="ridge"]')?.click());
await wait(200);
ok("收藏壁纸", (await cfg()).wall.favorites.includes("ridge"));

// 自动轮换
await page.click('[data-seg="wall.auto"] button[data-val="slideshow"]');
await wait(200);
ok("轮播模式已保存", (await cfg()).wall.auto === "slideshow");

// 自定义上传
const [chooser] = await Promise.all([
  page.waitForFileChooser({ timeout: 5000 }),
  page.click('[data-act="upload-wall"]'),
]);
await chooser.accept([path.resolve("public/wallpapers/coast.webp")]);
await wait(1800);
const custom = (await cfg()).custom || [];
const customWall = (await cfg()).wall.id || "";
ok("上传自定义壁纸", custom.length === 1 && customWall.startsWith("custom:"), `${custom.length} / ${customWall}`);
ok("上传后生成缩略卡", await page.evaluate(() => document.querySelectorAll('.wall-card[data-wall-id^="custom:"]').length === 1));

// Dock 位置 / 尺寸
await page.click('.s13-tabs [data-tab="dock"]');
await wait(150);
await page.click('[data-seg="dock.pos"] button[data-val="left"]');
await wait(350);
const dockLeft = await page.evaluate(() => {
  const d = document.querySelector(".dock").getBoundingClientRect();
  return { x: Math.round(d.x), y: Math.round(d.y), h: Math.round(d.height), pos: document.querySelector("#os").dataset.dockPos };
});
ok("Dock 移到左侧", dockLeft.pos === "left" && dockLeft.x < 30, JSON.stringify(dockLeft));
await page.screenshot({ path: path.join(OUT, "f-dock-left.png") });

await page.evaluate(() => {
  const input = document.querySelector('input[data-k="dock.size"]');
  input.value = "58";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await wait(300);
const dockSize = await page.evaluate(() => Math.round(document.querySelector(".dock-item").getBoundingClientRect().width));
ok("Dock 图标尺寸生效", dockSize === 58, String(dockSize));
await page.click('[data-seg="dock.pos"] button[data-val="bottom"]');
await wait(300);

// 图标自由模式 + 拖动
await page.click('.s13-tabs [data-tab="desktop"]');
await wait(150);
await page.click('[data-seg="icons.mode"] button[data-val="free"]');
await wait(350);
const iconCount = await page.evaluate(() => document.querySelectorAll(".desk-icon:not([hidden])").length);
const positions = await page.evaluate(() => {
  const host = document.querySelector(".desk-icons").getBoundingClientRect();
  return [...document.querySelectorAll(".desk-icon:not([hidden])")].slice(0, 4).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x - host.x), y: Math.round(r.y - host.y) };
  });
});
ok("自由模式图标有初始坐标", positions.some((p) => p.x > 0 || p.y > 0), JSON.stringify(positions));

const box = await page.evaluate(() => {
  const el = document.querySelector('.desk-icon[data-app="notes"]');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x + 140, box.y + 120, { steps: 8 });
await page.mouse.up();
await wait(300);
const moved = await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}").icons.pos.notes);
ok("拖动图标写入坐标", moved && moved.x > 80, JSON.stringify(moved));
await page.reload({ waitUntil: "networkidle2" });
await wait(1800);
const restored = await page.evaluate(() => {
  const el = document.querySelector('.desk-icon[data-app="notes"]');
  const host = document.querySelector(".desk-icons").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x - host.x), y: Math.round(r.y - host.y), free: document.querySelector(".desk-icons").classList.contains("is-free") };
});
ok("刷新后自由布局保留", restored.free && Math.abs(restored.x - moved.x) < 4, JSON.stringify(restored));

// 桌面右键（先清掉自动打开的窗口）
await page.evaluate(() => document.querySelectorAll(".window").forEach((w) => w.remove()));
await wait(250);
await page.mouse.click(1050, 300, { button: "right" });
await wait(300);
const menuCount = await page.evaluate(() => document.querySelectorAll(".ctxmenu .ctx-item").length);
ok("桌面右键菜单", menuCount >= 8, String(menuCount));
await page.screenshot({ path: path.join(OUT, "f-menu.png") });
await page.evaluate(() => Array.from(document.querySelectorAll(".ctxmenu .ctx-item")).find((b) => b.textContent.includes("新建文件夹"))?.click());
await wait(300);
ok("新建文件夹写入文件系统", await page.evaluate(() => JSON.parse(localStorage.getItem("guandao.os.fs.v1") || "[]").some((n) => n.name === "新建文件夹")));

// Dock 右键
await page.mouse.click(800, 960, { button: "right" });
await wait(300);
const dockMenu = await page.evaluate(() => [...document.querySelectorAll(".ctxmenu .ctx-item")].map((b) => b.textContent.trim()));
ok("Dock 右键菜单", dockMenu.some((t) => t.includes("固定")) || dockMenu.some((t) => t.includes("取消固定")), dockMenu.join("|"));
await page.keyboard.press("Escape");
await page.mouse.click(1100, 700);

// 浅色主题持久化
await page.evaluate(() => window.GOS13.applyPreset("minimal"));
await wait(800);
await page.reload({ waitUntil: "networkidle2" });
await wait(1800);
const light = await page.evaluate(() => ({ theme: document.body.dataset.osTheme, wall: JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}").wall.id }));
ok("浅色主题 + 壁纸刷新后保留", light.theme === "light" && light.wall === "dunes", JSON.stringify(light));

// 移动端
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.reload({ waitUntil: "networkidle2" });
await wait(1800);
const mobile = await page.evaluate(() => {
  const dock = document.querySelector(".dock").getBoundingClientRect();
  const mbar = document.querySelector(".menubar").getBoundingClientRect();
  return { dockW: Math.round(dock.width), dockX: Math.round(dock.x), mbarH: Math.round(mbar.height), vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
});
ok("移动端无横向溢出", !mobile.overflow && mobile.dockX > 0 && mobile.dockW < 390, JSON.stringify(mobile));
await page.screenshot({ path: path.join(OUT, "f-mobile.png") });

console.log(results.join("\n"));
console.log("\nERRORS:", errors.length ? errors.slice(0, 15).join("\n") : "none");
await browser.close();
