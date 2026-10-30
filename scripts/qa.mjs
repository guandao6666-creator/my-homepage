#!/usr/bin/env node
/**
 * 本地视觉质检：用 Chrome DevTools Protocol 截图 + 检测横向溢出。
 *
 * 用法：
 *   node scripts/qa.mjs <url> <输出png> [宽度] [高度] [--full]
 * 例：
 *   node scripts/qa.mjs http://localhost:4321/ .shots/home.png 1440 900 --full
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;

const [url = "http://localhost:4321/", out = ".shots/shot.png", w = "1440", h = "900"] =
  process.argv.slice(2);
const full = process.argv.includes("--full");
const width = Number(w);
const height = Number(h);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await getJSON("/json/version");
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome 调试端口未就绪");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const waiters = this.events.get(msg.method) ?? [];
        this.events.delete(msg.method);
        waiters.forEach((fn) => fn(msg.params));
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.events.get(method) ?? [];
      list.push(resolve);
      this.events.set(method, list);
    });
  }
}

const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve(".shots/chrome-profile")}`,
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await waitForChrome();
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then(
    (r) => r.json(),
  );

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  await sleep(1200);

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const de = document.documentElement;
      const overflow = de.scrollWidth - de.clientWidth;
      const offenders = [];
      if (overflow > 1) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > de.clientWidth + 1 && r.width > 0) {
            offenders.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className || '').toString().slice(0, 40),
              right: Math.round(r.right),
              width: Math.round(r.width),
            });
          }
        }
      }
      return JSON.stringify({
        title: document.title,
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        scrollHeight: de.scrollHeight,
        overflow,
        offenders: offenders.slice(0, 6),
      });
    })()`,
    returnByValue: true,
  });

  const info = JSON.parse(result.value);
  console.log(JSON.stringify(info, null, 2));

  const jsFlag = process.argv.find((a) => a.startsWith("--js="));
  if (jsFlag) {
    const expression = jsFlag.slice("--js=".length);
    const run = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    console.log("eval →", JSON.stringify(run.result?.value ?? run.result?.description ?? ""));
    await sleep(600);
  }

  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: full,
    ...(full ? { clip: { x: 0, y: 0, width, height: info.scrollHeight, scale: 1 } } : {}),
  });

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(shot.data, "base64"));
  console.log(`saved → ${out}`);
  ws.close();
} finally {
  child.kill();
}
