#!/usr/bin/env node
/**
 * 浏览器操控桥：连接一个带 --remote-debugging-port 的 Chrome，
 * 让我（助手）可以截图、点按钮、填表单。
 *
 * 优先复用已有实例（9222 端口），没有就启动一个带独立配置目录的窗口。
 * 独立配置目录的好处：不碰用户主配置，登录一次后长期保留会话。
 *
 * 用法：
 *   node scripts/browser.mjs open <url>
 *   node scripts/browser.mjs shot <out.png>
 *   node scripts/browser.mjs text [maxChars]
 *   node scripts/browser.mjs click "<css selector>"
 *   node scripts/browser.mjs click_text "<按钮文字>"
 *   node scripts/browser.mjs type "<selector>" "<value>"
 *   node scripts/browser.mjs eval "<expression>"
 *   node scripts/browser.mjs close
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = "C:/Users/1/AppData/Local/Temp/wb-chrome-profile";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}

async function isAlive() {
  try {
    await json("/json/version");
    return true;
  } catch {
    return false;
  }
}

async function launch(url) {
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,960",
      "--window-position=60,40",
      url || "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  for (let i = 0; i < 60; i += 1) {
    if (await isAlive()) return;
    await sleep(300);
  }
  throw new Error("Chrome 调试端口未就绪");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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
}

async function connect() {
  let targets = await json("/json/list");
  const targetHint = (process.argv.find((a) => a.startsWith("--target=")) || "").slice(9);
  const pages = targets.filter((t) => t.type === "page");
  let page = targetHint
    ? pages.find((t) => t.url.includes(targetHint) || t.title.includes(targetHint))
    : pages[pages.length - 1];
  if (!page) page = pages[pages.length - 1];
  if (!page) {
    page = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { cdp, ws };
}

const [cmd, ...args] = process.argv.slice(2).filter((a) => !a.startsWith("--target="));

if (!["open", "close"].includes(cmd) && !(await isAlive())) {
  console.error("浏览器未启动，先执行：node scripts/browser.mjs open <url>");
  process.exit(1);
}

if (cmd === "open") {
  const url = args[0] || "about:blank";
  if (!(await isAlive())) await launch(url);
  const { cdp, ws } = await connect();
  await cdp.send("Page.navigate", { url });
  await sleep(2500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(".shots", { recursive: true });
  await writeFile(".shots/browser.png", Buffer.from(shot.data, "base64"));
  console.log("opened:", url, "→ .shots/browser.png");
  ws.close();
  process.exit(0);
}

if (cmd === "close") {
  const { cdp, ws } = await connect().catch(() => ({ cdp: null, ws: null }));
  if (cdp) {
    await cdp.send("Browser.close").catch(() => {});
    ws.close();
  }
  process.exit(0);
}

const { cdp, ws } = await connect();

if (cmd === "shot") {
  const out = args[0] || ".shots/browser.png";
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(shot.data, "base64"));
  console.log("saved →", out);
} else if (cmd === "text") {
  const max = Number(args[0] || 2000);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.body ? document.body.innerText : "";
      return document.title + " || " + t.replace(/\\n{2,}/g, "\\n").slice(0, ${max});
    })()`,
    returnByValue: true,
  });
  console.log(result.value);
} else if (cmd === "click") {
  const selector = args[0];
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "not found: " + ${JSON.stringify(selector)};
      el.click();
      return "clicked " + (el.innerText || el.tagName).slice(0, 60);
    })()`,
    returnByValue: true,
  });
  console.log(result.value);
  await sleep(1200);
} else if (cmd === "click_text") {
  const text = args.join(" ");
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const want = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll('button, a, [role="button"], li, div, span')];
      const hit = nodes.filter(el => (el.innerText || "").trim() === want).pop()
        || nodes.filter(el => (el.innerText || "").includes(want)).pop();
      if (!hit) return "no element with text: " + want;
      hit.click();
      return "clicked: " + (hit.innerText || hit.tagName).slice(0, 60);
    })()`,
    returnByValue: true,
  });
  console.log(result.value);
  await sleep(1500);
} else if (cmd === "type") {
  const selector = args[0];
  const value = args.slice(1).join(" ");
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "not found";
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return "typed";
    })()`,
    returnByValue: true,
  });
  console.log(result.value);
} else if (cmd === "eval") {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: args.join(" "),
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result.value ?? result.description ?? null));
} else if (cmd === "key") {
  // 发送真实键盘事件，例如 key "Control+Enter"
  const combo = args[0] || "";
  const parts = combo.split("+");
  const key = parts.pop();
  const modMap = { Control: 2, Alt: 1, Shift: 8, Meta: 4 };
  let mods = 0;
  for (const p of parts) mods |= modMap[p] ?? 0;
  const vkMap = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, " ": 32 };
  const vk = vkMap[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      modifiers: mods,
      key,
      code: vkMap[key] ? key : `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }
  console.log("key sent:", combo);
  await sleep(800);
} else if (cmd === "evalfile") {
  // 从文件读取 JS 片段执行，避免命令行长度与转义问题
  const { readFile } = await import("node:fs/promises");
  const code = await readFile(args[0], "utf8");
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result.value ?? result.description ?? null));
} else {
  console.error("未知命令:", cmd);
}

ws.close();
process.exit(0);
