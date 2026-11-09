#!/usr/bin/env node
/**
 * Guandao OS 1.9 · 真实性能测量
 *
 * 用本机 Chrome 打开构建产物，采集：
 *   TTFB / FCP / LCP / CLS / 资源传输量 / 首屏 JS 与 CSS 体积
 *
 * 口径说明（不要误读）：
 *   - 这些是「本机、本网络、无节流」的数字，代表开发机的上限，不是用户设备的中位数；
 *   - 没有使用 Lighthouse，因为它需要额外依赖；这里用的是浏览器原生的
 *     Navigation Timing 与 PerformanceObserver，和 Performance Lab 里的实现同源；
 *   - 首次访问会在浏览器缓存为空的情况下跑，第二次访问用于观察缓存效果。
 *
 * 用法：node scripts/measure-perf.mjs [url]
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

const root = path.resolve(process.cwd(), "dist");
const port = Number(process.env.PERF_PORT || 4517);
const target = process.argv[2] || `http://127.0.0.1:${port}/`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let file = path.join(root, decoded);
  if (!file.startsWith(root)) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, "index.html");
  } catch {
    if (!path.extname(file)) file = `${file}.html`;
  }
  try {
    await stat(file);
    return file;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const file = await resolveFile(req.url || "/");
  if (!file) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  res.end(body);
});

await new Promise((resolve) => server.listen(port, resolve));

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// 在页面脚本之前挂观察器，避免错过 LCP / CLS
await page.addInitScript(() => {
  window.__perf = { lcp: 0, cls: 0, fcp: 0, inp: 0 };
  window.__perfObservers = [];
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.lcp = Math.max(window.__perf.lcp, entry.renderTime || entry.loadTime || entry.startTime);
      }
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
    window.__perfObservers.push(lcpObserver);
  } catch {
    /* 不支持 */
  }
  try {
    let session = 0;
    let value = 0;
    let start = 0;
    let last = 0;
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        const ts = entry.startTime;
        if (!start || ts - last > 1000 || ts - start > 5000) {
          start = ts;
          value = 0;
        }
        value += entry.value;
        last = ts;
        session = Math.max(session, value);
        window.__perf.cls = session;
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
    window.__perfObservers.push(clsObserver);
  } catch {
    /* 不支持 */
  }
  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") window.__perf.fcp = entry.startTime;
      }
    });
    paintObserver.observe({ type: "paint", buffered: true });
    window.__perfObservers.push(paintObserver);
  } catch {
    /* 不支持 */
  }
});

async function measure(label, options = {}) {
  await page.goto(target, { waitUntil: "load" });
  // 等待桌面外壳真正可用（开机遮罩移除）
  await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 15000 });
  await page.waitForTimeout(1500); // 让 LCP / CLS 稳定
  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const byType = {};
    let total = 0;
    for (const entry of resources) {
      const type = entry.initiatorType || "other";
      byType[type] = (byType[type] || 0) + (entry.transferSize || 0);
      total += entry.transferSize || 0;
    }
    return {
      ttfb: Math.round(nav.responseStart - nav.startTime),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      load: Math.round(nav.loadEventEnd - nav.startTime),
      fcp: Math.round(window.__perf.fcp),
      lcp: Math.round(window.__perf.lcp),
      cls: Math.round(window.__perf.cls * 1000) / 1000,
      transferTotal: total,
      byType,
      resourceCount: resources.length,
    };
  });
  return { label, ...data };
}

const cold = await measure("冷启动（新上下文，无缓存）");
// 同一上下文再访问一次，观察缓存效果
const warm = await measure("二次访问（同一上下文，已缓存）");

await browser.close();
server.close();

const report = {
  measuredAt: new Date().toISOString(),
  environment: {
    browser: "Google Chrome (channel=chrome, Playwright)",
    viewport: "1440x900",
    throttle: "无（本机直连，非真实移动网络）",
    build: "dist（astro build 产物）",
  },
  runs: [cold, warm],
};

await mkdir("docs", { recursive: true });
await writeFile("docs/perf-measurements.json", JSON.stringify(report, null, 2), "utf8");

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
console.log("Guandao OS 1.9 · 实测性能（本机，无节流）\n");
for (const run of report.runs) {
  console.log(run.label);
  console.log(`  TTFB ${run.ttfb} ms · FCP ${run.fcp} ms · LCP ${run.lcp} ms · CLS ${run.cls}`);
  console.log(`  DOMContentLoaded ${run.domContentLoaded} ms · Load ${run.load} ms`);
  console.log(`  资源 ${run.resourceCount} 个，传输 ${kb(run.transferTotal)}`);
  console.log(`  按类型：${Object.entries(run.byType).map(([k, v]) => `${k}=${kb(v)}`).join(" · ")}`);
  console.log("");
}
console.log("已写入 docs/perf-measurements.json");