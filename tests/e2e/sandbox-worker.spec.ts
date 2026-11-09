import { createHash } from "node:crypto";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { canonicalFilesJson, type BundleFile } from "../../shared/plugin-spec.js";

/**
 * Phase 3.2 · 插件沙箱安全边界 · 真实 Worker E2E
 *
 * 这个 spec 跑在 playwright.config.ts 的 `worker` project 上（baseURL = 真实 Worker
 * http://127.0.0.1:8788，由 scripts/e2e-server.mjs 用 wrangler dev --local 拉起），
 * 因此宿主页、/sandbox/runner、CSP 响应头都是真实产物，而不是静态服务器模拟。
 *
 * 覆盖任务书里的 10 个场景：
 *  1. 正常插件运行（宿主 iframe 属性 + 内层 iframe 属性 + 插件实际启动）
 *  2. 消息通信链路（HELLO → MOUNT[一次性端口] → RPC 往返）
 *  3. 非法消息来源（伪造 event.source 的 HELLO / RPC 不影响真实会话）
 *  4. 恶意 postMessage（错误 nonce / 错误 channel / 超大 payload / 非法 id / 伪造 pluginId）
 *  5. 未授权 Broker 调用（PERMISSION_DENIED、UNKNOWN_METHOD）
 *  6. 宿主存储隔离（插件读不到宿主 localStorage，也读不到父文档）
 *  7. Cookie 与网络隔离（插件读不到宿主 Cookie，被自身 CSP 禁止联网）
 *  8. 导航逃逸（第二次 load → sandbox:navigation → 会话销毁 + 持久禁用）
 *  9. 权限撤销后运行实例销毁（走插件管理器「官方示例 → 管理 → 权限 → 保存授权」真实 UI）
 * 10. 跨标签页撤销（别的标签页改 guandao.plugins.v1 → 本页 storage 事件销毁实例）
 *
 * 说明：第 9 项没有使用本地探针插件，因为插件管理器「已安装」标签在存在本地安装记录时
 * 会退化成「安全策略」卡片（manager.ts listView 缺少 installed 列表分支），本地插件没有
 * 进入详情/权限页的 UI 入口。这里改用内置官方示例 com.guandao.hello，它和第三方插件走
 * 完全相同的 Manifest / 权限 / 沙箱流程，撤销权限最终命中的也是同一个
 * registry.saveGrantedPermissions → destroySessionsFor 代码路径。
 */

const PLUGIN_ID = "com.e2e.sandbox.probe";
const PLUGIN_VERSION = "1.0.0";
const APP_ID = `plugin:${PLUGIN_ID}`;
const STATE_KEY = "guandao.plugins.v1";
const SANDBOX_CHANNEL = "guandao.plugin.sandbox";
const PLUGIN_CHANNEL = "guandao.plugin";
const RUNNER_PATH = /\/sandbox\/runner/;
const OFFICIAL_PLUGIN_ID = "com.guandao.hello";
const DECLARED_PERMISSIONS = ["plugin.storage.read", "plugin.storage.write", "theme.read"];

/* -------------------------------------------------------------------------- */
/* 探针插件包：真实走 host.ts 的 getBundle → verifyBundle → buildEntryHtml 链路   */
/* -------------------------------------------------------------------------- */

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PROBE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>E2E 沙箱探针</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { font: 13px/1.5 system-ui, sans-serif; background: #101827; color: #e5e7eb; }
  main { padding: 18px; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  [data-probe-state] { margin: 0; color: #93c5fd; }
</style>
</head>
<body>
<main id="probe">
  <h1 data-probe-title>E2E 沙箱探针</h1>
  <p data-probe-state>booting</p>
</main>
<script>
(function () {
  "use strict";
  var CHANNEL = "guandao.plugin";
  window.__probeBooted = true;
  var stateEl = document.querySelector("[data-probe-state]");
  var config = window.__GUANDAO_PLUGIN__ || {};

  function waitForApi(timeoutMs) {
    if (window.guandao) return Promise.resolve(window.guandao);
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      var timer = setInterval(function () {
        if (window.guandao) {
          clearInterval(timer);
          resolve(window.guandao);
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 25);
    });
  }

  function invoke(path, args) {
    return waitForApi(3000).then(function (client) {
      if (!client) return { ok: false, code: "NO_API", message: "宿主 SDK 尚未就绪" };
      var parts = path.split(".");
      var fn = client;
      for (var i = 0; i < parts.length; i += 1) fn = fn && fn[parts[i]];
      if (typeof fn !== "function") return { ok: false, code: "NO_METHOD", message: "SDK 缺少方法 " + path };
      try {
        return Promise.resolve(fn.apply(client, args || [])).then(
          function (value) { return { ok: true, value: value }; },
          function (error) {
            return {
              ok: false,
              code: (error && error.code) || "FAILED",
              name: error && error.name,
              message: error && error.message ? error.message : String(error),
            };
          },
        );
      } catch (error) {
        return {
          ok: false,
          code: (error && error.code) || "FAILED",
          name: error && error.name,
          message: error && error.message ? error.message : String(error),
        };
      }
    });
  }

  function rawReply(requestId, method, payload, overrides) {
    overrides = overrides || {};
    var timeoutMs = overrides.timeoutMs || 4000;
    return new Promise(function (resolve) {
      var finished = false;
      var timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, timeoutMs);
      function onMessage(event) {
        var data = event.data;
        if (!data || typeof data !== "object") return;
        if (data.channel !== CHANNEL || data.kind !== "RESULT" || data.requestId !== requestId) return;
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve({ ok: Boolean(data.ok), result: data.result, error: data.error || null });
      }
      window.addEventListener("message", onMessage);
      var message = {
        channel: overrides.channel || CHANNEL,
        kind: "RPC",
        requestId: requestId,
        method: method,
      };
      if (payload !== undefined) message.payload = payload;
      if (overrides.pluginId) message.pluginId = overrides.pluginId;
      window.parent.postMessage(message, "*");
    });
  }

  window.__probe = {
    booted: function () {
      var cfg = window.__GUANDAO_PLUGIN__ || {};
      return {
        hasSdk: Boolean(window.guandao),
        pluginId: String(cfg.pluginId || ""),
        mountId: String(cfg.mountId || ""),
        channel: String(cfg.channel || ""),
        granted: Array.isArray(cfg.granted) ? cfg.granted.slice() : [],
        theme: Boolean(cfg.theme),
      };
    },
    context: function () { return invoke("app.context"); },
    storageSet: function (key, value) { return invoke("storage.set", [key, value]); },
    rawReply: rawReply,
  };

  if (stateEl) stateEl.textContent = window.guandao ? "booted" : "waiting-sdk";
})();
</script>
</body>
</html>
`;

const PROBE_MANIFEST = {
  manifestVersion: 1,
  id: PLUGIN_ID,
  name: "E2E 沙箱探针",
  version: PLUGIN_VERSION,
  description: "Phase 3.2 E2E 探针：验证沙箱握手、消息通道、权限与隔离边界。",
  type: "application",
  entry: "index.html",
  author: { name: "E2E Harness" },
  license: "MIT",
  category: "developer",
  compatibility: { minimumOSVersion: "1.7.0", sdkVersion: 1 },
  networkDomains: [],
  permissions: [...DECLARED_PERMISSIONS],
};

const PROBE_FILES: BundleFile[] = [
  { path: "index.html", encoding: "utf8", content: PROBE_HTML },
  { path: "manifest.json", encoding: "utf8", content: JSON.stringify(PROBE_MANIFEST) },
];
const PROBE_FILES_DIGEST = sha256Hex(canonicalFilesJson(PROBE_FILES));
const PROBE_BUNDLE_TEXT = JSON.stringify({
  format: "guandao-plugin",
  formatVersion: 1,
  manifest: PROBE_MANIFEST,
  files: PROBE_FILES,
  filesDigest: PROBE_FILES_DIGEST,
});
const PROBE_PACKAGE_HASH = sha256Hex(PROBE_BUNDLE_TEXT);

function buildProbeRecord(granted: string[]): Record<string, unknown> {
  const now = Date.now();
  return {
    id: PLUGIN_ID,
    name: PROBE_MANIFEST.name,
    version: PLUGIN_VERSION,
    previousVersion: null,
    type: PROBE_MANIFEST.type,
    category: PROBE_MANIFEST.category,
    author: PROBE_MANIFEST.author,
    description: PROBE_MANIFEST.description,
    manifest: PROBE_MANIFEST,
    permissions: [...DECLARED_PERMISSIONS],
    granted: [...granted],
    enabled: true,
    source: "dev",
    installedAt: now,
    updatedAt: now,
    packageHash: PROBE_PACKAGE_HASH,
    filesDigest: PROBE_FILES_DIGEST,
    bundleKey: `plugin:${PLUGIN_ID}@${PLUGIN_VERSION}`,
    iconUrl: "",
    blocked: false,
    failure: "",
    logs: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 页面注入 / 观测辅助                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 在所有 frame（宿主页、/sandbox/runner、blob 插件帧）里预埋消息 trace。
 * 用 page.addInitScript 注入，子 frame 创建时同样执行。
 */
function installTrace(): void {
  const scope = window as unknown as { __e2eTrace: Array<Record<string, unknown>> };
  scope.__e2eTrace = [];
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || typeof data.kind !== "string") return;
    scope.__e2eTrace.push({
      kind: data.kind,
      channel: typeof data.channel === "string" ? data.channel : null,
      pluginId: typeof data.pluginId === "string" ? data.pluginId : null,
      nonce: typeof data.nonce === "string" ? data.nonce : null,
      requestId: typeof data.requestId === "string" ? data.requestId : null,
      method: typeof data.method === "string" ? data.method : null,
      event: typeof data.event === "string" ? data.event : null,
      ok: typeof data.ok === "boolean" ? data.ok : null,
      ports: event.ports ? event.ports.length : 0,
      htmlLength: typeof data.html === "string" ? data.html.length : null,
      sdkLength: typeof data.sdk === "string" ? data.sdk.length : null,
      payloadLength: typeof data.payload === "string" ? data.payload.length : null,
      sourceIsSelf: event.source === window,
      sourceIsParent: event.source === window.parent,
    });
  });
}

async function dismissOnboarding(page: Page): Promise<void> {
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count().catch(() => 0)) {
    await skip.first().click({ timeout: 2_000 }).catch(() => undefined);
  }
  await page
    .waitForFunction(() => !document.querySelector(".os20-onb"), undefined, { timeout: 5_000 })
    .catch(() => undefined);
}

async function waitOsReady(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).GOS20_READY), undefined, {
    timeout: 30_000,
  });
  await page.evaluate(() => (window as unknown as Record<string, unknown>).GOS20_READY);
  await page.waitForFunction(() => !document.getElementById("boot"), undefined, { timeout: 30_000 });
  await dismissOnboarding(page);
  await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).GOS14), undefined, {
    timeout: 15_000,
  });
}

async function bootOs(page: Page): Promise<void> {
  await page.addInitScript(installTrace);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitOsReady(page);
}

/** 把探针插件「安装」进 localStorage + IndexedDB，然后 reload 让 initPlugins 注册。 */
async function installProbe(page: Page, granted: string[]): Promise<void> {
  const record = buildProbeRecord(granted);
  await page.evaluate(
    async ({ stateKey, pluginId, recordJson, bundleKey, bundleText }) => {
      window.localStorage.setItem(stateKey, JSON.stringify({ v: 1, installs: { [pluginId]: recordJson } }));
      await new Promise<void>((resolve, reject) => {
        const request = window.indexedDB.open("guandao-os14", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
          if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("blobs", "readwrite");
          tx.objectStore("blobs").put(bundleText, bundleKey);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    {
      stateKey: STATE_KEY,
      pluginId: PLUGIN_ID,
      recordJson: record,
      bundleKey: `plugin:${PLUGIN_ID}@${PLUGIN_VERSION}`,
      bundleText: PROBE_BUNDLE_TEXT,
    },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitOsReady(page);
}

async function bootWithProbe(page: Page, granted: string[] = [...DECLARED_PERMISSIONS]): Promise<void> {
  await bootOs(page);
  await installProbe(page, granted);
}

async function readInstall(page: Page, id: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    ({ stateKey, pluginId }) => {
      const raw = window.localStorage.getItem(stateKey);
      if (!raw) return null;
      try {
        const state = JSON.parse(raw) as { installs?: Record<string, Record<string, unknown>> };
        return state.installs?.[pluginId] ?? null;
      } catch {
        return null;
      }
    },
    { stateKey: STATE_KEY, pluginId: id },
  );
}

function findRunnerFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => RUNNER_PATH.test(frame.url()));
}

function findPluginFrame(runner: Frame): Frame | undefined {
  return runner.childFrames().find((frame) => frame.url().startsWith("blob:"));
}

async function waitForRunnerFrame(page: Page, timeout = 25_000): Promise<Frame> {
  await expect.poll(() => Boolean(findRunnerFrame(page)), { timeout, message: "沙箱 runner iframe 未出现" }).toBe(true);
  return findRunnerFrame(page)!;
}

async function waitForPluginFrame(page: Page, timeout = 25_000): Promise<Frame> {
  const runner = await waitForRunnerFrame(page, timeout);
  await expect
    .poll(() => Boolean(findPluginFrame(runner)), { timeout, message: "插件内层 blob iframe 未出现" })
    .toBe(true);
  return findPluginFrame(runner)!;
}

async function waitForProbeBooted(page: Page, timeout = 25_000): Promise<Frame> {
  const plugin = await waitForPluginFrame(page, timeout);
  await expect
    .poll(
      async () => {
        try {
          return await plugin.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__probeBooted));
        } catch {
          return false;
        }
      },
      { timeout, message: "插件脚本没有执行（MOUNT 未送达？）" },
    )
    .toBe(true);
  return plugin;
}

async function openApp(page: Page, appId: string): Promise<void> {
  await page.evaluate((target) => {
    const gos = (window as unknown as { GOS14: { ctx: { openApp: (id: string) => unknown } } }).GOS14;
    return gos.ctx.openApp(target);
  }, appId);
  await expect(page.locator(`.window[data-app="${appId}"]`)).toBeVisible({ timeout: 20_000 });
}

async function openProbe(page: Page): Promise<{ runner: Frame; plugin: Frame }> {
  await openApp(page, APP_ID);
  const runner = await waitForRunnerFrame(page);
  const plugin = await waitForProbeBooted(page);
  return { runner, plugin };
}

function traceOf(frame: Frame): Promise<Array<Record<string, unknown>>> {
  return frame.evaluate(() => ((window as unknown as { __e2eTrace?: Array<Record<string, unknown>> }).__e2eTrace ?? []).slice());
}

/* -------------------------------------------------------------------------- */
/* 1. 正常插件运行                                                              */
/* -------------------------------------------------------------------------- */

test("1. 正常插件运行：宿主 iframe 与内层 iframe 都使用 allow-scripts 沙箱", async ({ page }) => {
  await bootWithProbe(page);
  const { runner, plugin } = await openProbe(page);

  // 宿主侧 iframe 的属性是安全边界的第一层
  const hostFrame = await page.evaluate(() => {
    const el = document.querySelector<HTMLIFrameElement>(".gp-frame");
    if (!el) return null;
    return {
      sandbox: el.getAttribute("sandbox"),
      referrerPolicy: el.getAttribute("referrerpolicy"),
      src: el.getAttribute("src"),
      title: el.getAttribute("title"),
      count: document.querySelectorAll(".gp-frame").length,
    };
  });
  expect(hostFrame).not.toBeNull();
  expect(hostFrame!.count).toBe(1);
  expect(hostFrame!.sandbox).toBe("allow-scripts");
  expect(hostFrame!.sandbox).not.toContain("allow-same-origin");
  expect(hostFrame!.referrerPolicy).toBe("no-referrer");
  expect(hostFrame!.src).toContain("/sandbox/runner");
  expect(hostFrame!.src).toContain("v=");

  // runner 页面本身也是真实 Worker 提供、带沙箱 CSP 的文档（CSP 来自响应头，不是 meta）
  const sandboxCsp = await page.evaluate(async () => {
    const response = await fetch("/sandbox/runner?v=1.7.0", { cache: "no-store" });
    return response.headers.get("content-security-policy") ?? "";
  });
  expect(sandboxCsp).toContain("default-src 'none'");
  expect(sandboxCsp).toContain("connect-src 'none'");
  expect(sandboxCsp).toContain("frame-src 'self' data: blob:");
  expect(sandboxCsp).toContain("frame-ancestors 'self'");

  // 内层插件 iframe：内容经 Blob URL 载入，同样只有 allow-scripts
  const innerFrame = await runner.evaluate(() => {
    const el = document.querySelector<HTMLIFrameElement>("iframe");
    if (!el) return null;
    return {
      sandbox: el.getAttribute("sandbox"),
      referrerPolicy: el.getAttribute("referrerpolicy"),
      src: el.getAttribute("src") ?? "",
      hasSrcdoc: el.hasAttribute("srcdoc"),
    };
  });
  expect(innerFrame).not.toBeNull();
  expect(innerFrame!.sandbox).toBe("allow-scripts");
  expect(innerFrame!.sandbox).not.toContain("allow-same-origin");
  expect(innerFrame!.referrerPolicy).toBe("no-referrer");
  expect(innerFrame!.src.startsWith("blob:") || innerFrame!.hasSrcdoc).toBe(true);

  // 插件脚本真的执行了，且拿到 MOUNT 注入的配置
  const booted = await plugin.evaluate(() => (window as unknown as { __probe: { booted: () => Record<string, unknown> } }).__probe.booted());
  expect(booted.hasSdk).toBe(true);
  expect(booted.pluginId).toBe(PLUGIN_ID);
  expect(booted.channel).toBe(PLUGIN_CHANNEL);
  expect(booted.granted).toEqual([...DECLARED_PERMISSIONS]);
  expect(String(booted.mountId).startsWith("mnt-")).toBe(true);

  // 宿主记录：已启用、未封禁、日志里有「应用窗口已启动」
  const record = await readInstall(page, PLUGIN_ID);
  expect(record).not.toBeNull();
  expect(record!.enabled).toBe(true);
  expect(record!.blocked).toBe(false);
  await expect
    .poll(async () => {
      const current = await readInstall(page, PLUGIN_ID);
      return Array.isArray(current?.logs) ? (current!.logs as Array<{ message: string }>).map((log) => log.message) : [];
    })
    .toContain("应用窗口已启动");
});

/* -------------------------------------------------------------------------- */
/* 2. 消息通信链路                                                              */
/* -------------------------------------------------------------------------- */

test("2. 消息通信：HELLO → 一次性端口 MOUNT → RPC 往返", async ({ page }) => {
  await bootWithProbe(page);
  const { runner, plugin } = await openProbe(page);
  const context = await plugin.evaluate(() => (window as unknown as { __probe: { context: () => Promise<Record<string, unknown>> } }).__probe.context());
  expect(context.ok).toBe(true);
  const value = context.value as Record<string, unknown>;
  expect(value.pluginId).toBe(PLUGIN_ID);
  expect(value.sandbox).toBe(true);
  expect(value.type).toBe("application");
  expect(value.mode).toBe("app");
  expect(Array.isArray(value.granted)).toBe(true);

  // 宿主页收到 runner 的 HELLO，且来源不是宿主自己（伪造来源会在下个用例验证）
  const hostTrace = await traceOf(page.mainFrame());
  const hello = hostTrace.find((entry) => entry.kind === "HELLO");
  expect(hello, "宿主页没有收到 HELLO").toBeTruthy();
  expect(hello!.channel).toBe(SANDBOX_CHANNEL);
  expect(typeof hello!.nonce).toBe("string");
  expect(String(hello!.nonce).length).toBeGreaterThan(0);
  expect(hello!.sourceIsSelf).toBe(false);

  // runner 收到 MOUNT：必须携带一次性 MessagePort、html/sdk 预置内容与同一 nonce
  const runnerTrace = await traceOf(runner);
  const mount = runnerTrace.find((entry) => entry.kind === "MOUNT");
  expect(mount, "runner 没有收到 MOUNT").toBeTruthy();
  expect(mount!.channel).toBe(SANDBOX_CHANNEL);
  expect(mount!.pluginId).toBe(PLUGIN_ID);
  expect(mount!.ports).toBe(1);
  expect(Number(mount!.htmlLength)).toBeGreaterThan(0);
  expect(Number(mount!.sdkLength)).toBeGreaterThan(0);
  expect(mount!.nonce).toBe(hello!.nonce);
  expect(mount!.sourceIsParent).toBe(true);

  // 插件帧收到 RPC 的 RESULT 回包（app.context 的返回值）
  const pluginTrace = await traceOf(plugin);
  const result = pluginTrace.find((entry) => entry.kind === "RESULT" && entry.channel === PLUGIN_CHANNEL);
  expect(result, "插件帧没有收到 RESULT").toBeTruthy();
  expect(result!.ok).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* 3. 非法消息来源（伪造 event.source）                                         */
/* -------------------------------------------------------------------------- */

test("3. 非法来源：伪造 event.source 的 HELLO / RPC 不会影响真实会话", async ({ page }) => {
  await bootWithProbe(page);
  const { runner, plugin } = await openProbe(page);

  const beforeHello = (await traceOf(page.mainFrame())).filter((entry) => entry.kind === "HELLO").length;
  const beforeMount = (await traceOf(runner)).filter((entry) => entry.kind === "MOUNT").length;
  const beforeFrames = await page.locator(".gp-frame").count();
  expect(beforeFrames).toBe(1);

  // 在宿主页里插入一个 sandbox="allow-scripts" 的 data: iframe，并让它向宿主页发
  // 伪造的沙箱消息：event.source 是它而不是真实 runner iframe，宿主必须丢弃。
  // data: 文档会继承宿主页 CSP（内联脚本被 script-src 阻止），所以通过 frame.evaluate 发送。
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "e2e-forged-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "data:text/html;charset=utf-8," + encodeURIComponent("<p>forged</p>");
    document.body.appendChild(frame);
  });
  await expect
    .poll(() => Boolean(page.frames().find((frame) => frame.url().startsWith("data:text/html"))), {
      timeout: 10_000,
      message: "伪造来源 iframe 未就绪",
    })
    .toBe(true);
  const forgedFrame = page.frames().find((frame) => frame.url().startsWith("data:text/html"))!;
  await forgedFrame.evaluate((pluginId: string) => {
    parent.postMessage({ channel: "guandao.plugin.sandbox", kind: "HELLO", nonce: "forged-nonce" }, "*");
    parent.postMessage({ channel: "guandao.plugin.sandbox", kind: "READY" }, "*");
    parent.postMessage(
      {
        channel: "guandao.plugin",
        kind: "RPC",
        pluginId,
        requestId: "forged-1",
        method: "storage.set",
        payload: { key: "forged", value: 1 },
      },
      "*",
    );
  }, PLUGIN_ID);

  // 伪造消息确实到达宿主页（宿主 trace 能看见），但来源不是宿主自己
  await expect
    .poll(async () => (await traceOf(page.mainFrame())).filter((entry) => entry.kind === "HELLO").length, { timeout: 10_000 })
    .toBeGreaterThan(beforeHello);
  const hostTrace = await traceOf(page.mainFrame());
  expect(hostTrace.some((entry) => entry.kind === "RPC" && entry.method === "storage.set" && entry.sourceIsSelf === false)).toBe(true);
  expect(hostTrace.some((entry) => entry.kind === "READY" && entry.sourceIsSelf === false)).toBe(true);

  // 真实会话不受影响：没有新的 MOUNT、iframe 数量不变、插件记录干净、RPC 仍可用
  const afterMount = (await traceOf(runner)).filter((entry) => entry.kind === "MOUNT").length;
  expect(afterMount).toBe(beforeMount);
  expect(await page.locator(".gp-frame").count()).toBe(1);
  const record = await readInstall(page, PLUGIN_ID);
  expect(record!.enabled).toBe(true);
  expect(record!.blocked).toBe(false);
  expect((record!.logs as Array<Record<string, unknown>>).some((log) => String(log.message).includes("拒绝未授权调用"))).toBe(false);
  const context = await plugin.evaluate(() => (window as unknown as { __probe: { context: () => Promise<Record<string, unknown>> } }).__probe.context());
  expect(context.ok).toBe(true);

  await page.evaluate(() => document.getElementById("e2e-forged-frame")?.remove());
});

/* -------------------------------------------------------------------------- */
/* 4. 恶意 postMessage                                                          */
/* -------------------------------------------------------------------------- */

test("4. 恶意 postMessage：错误 nonce / 错误 channel / 超大 payload 都被拒绝", async ({ page, context }) => {
  // 4a. 直接攻击 runner 握手：错误 nonce 不能创建插件 iframe，正确 nonce 才可以
  const runnerPage = await context.newPage();
  await runnerPage.addInitScript(installTrace);
  const response = await runnerPage.goto("/sandbox/runner", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  const sandboxCsp = response?.headers()["content-security-policy"] ?? "";
  expect(sandboxCsp).toContain("connect-src 'none'");
  expect(sandboxCsp).toContain("frame-ancestors 'self'");

  await expect
    .poll(async () => (await runnerPage.evaluate(() => (window as unknown as { __e2eTrace?: Array<Record<string, unknown>> }).__e2eTrace ?? [])).filter((entry) => entry.kind === "HELLO").length)
    .toBeGreaterThan(0);
  const helloNonce = await runnerPage.evaluate(() => {
    const trace = (window as unknown as { __e2eTrace?: Array<Record<string, unknown>> }).__e2eTrace ?? [];
    const hello = trace.find((entry) => entry.kind === "HELLO");
    return hello ? String(hello.nonce) : "";
  });
  expect(helloNonce.length).toBeGreaterThan(0);

  const mountRunner = async (nonce: string) =>
    runnerPage.evaluate(async (mountNonce) => {
      const channel = new MessageChannel();
      const ready = new Promise<boolean>((resolve) => {
        channel.port1.onmessage = (event) => {
          const data = event.data as Record<string, unknown> | null;
          if (data && data.kind === "READY") resolve(true);
        };
        setTimeout(() => resolve(false), 3_000);
      });
      channel.port1.start();
      window.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          pluginId: "com.e2e.negative",
          mountId: "mnt-e2e",
          nonce: mountNonce,
          html: "<!doctype html><html><body>negative</body></html>",
          sdk: "window.__negativeSdk = true;",
          granted: [],
          theme: {},
          context: { osVersion: "2.0.0", sdkVersion: 1, version: "1.0.0", type: "application", mode: "app" },
        },
        "*",
        [channel.port2],
      );
      const mounted = await ready;
      const frame = document.querySelector("iframe");
      return {
        ready: mounted,
        frames: document.querySelectorAll("iframe").length,
        sandbox: frame ? frame.getAttribute("sandbox") : null,
      };
    }, nonce);

  const wrongNonce = await mountRunner("not-the-real-nonce");
  expect(wrongNonce.ready).toBe(false);
  expect(wrongNonce.frames).toBe(0);

  const goodNonce = await mountRunner(helloNonce);
  expect(goodNonce.ready).toBe(true);
  expect(goodNonce.frames).toBe(1);
  expect(goodNonce.sandbox).toBe("allow-scripts");
  await runnerPage.close();

  // 4b. 真实插件帧里的攻击面
  await bootWithProbe(page);
  const { plugin } = await openProbe(page);
  const raw = (requestId: string, method: string, payload: unknown, overrides: Record<string, unknown> = {}) =>
    plugin.evaluate(
      ({ requestId: id, method: name, payload: body, overrides: options }) =>
        (
          window as unknown as {
            __probe: { rawReply: (a: string, b: string, c: unknown, d: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
          }
        ).__probe.rawReply(id, name, body, options),
      { requestId, method, payload, overrides },
    );

  // 错误 channel：runner 不会转发，插件得不到任何回包
  const wrongChannel = await raw("e2e-wrong-channel", "app.context", {}, { channel: "guandao.plugin.evil", timeoutMs: 800 });
  expect(wrongChannel).toBeNull();
  // 非法 requestId / method 字符：直接被 runner 丢弃
  expect(await raw("bad id!", "app.context", {}, { timeoutMs: 600 })).toBeNull();
  expect(await raw("e2e-bad-method", "bad method!", {}, { timeoutMs: 600 })).toBeNull();
  // 30KB payload：runner 放行（<64KB），宿主以 24KB 上限拒绝
  const tooLargeForHost = await raw("e2e-24kb", "storage.get", { key: "x".repeat(30 * 1024) });
  expect(tooLargeForHost).not.toBeNull();
  expect((tooLargeForHost!.error as Record<string, unknown>).code).toBe("PAYLOAD_TOO_LARGE");
  expect(String((tooLargeForHost!.error as Record<string, unknown>).message)).toContain("24 KB");
  // 70KB payload：runner 的 64KB 上限先拒绝
  const tooLargeForRunner = await raw("e2e-64kb", "storage.get", { key: "x".repeat(70 * 1024) });
  expect(tooLargeForRunner).not.toBeNull();
  expect((tooLargeForRunner!.error as Record<string, unknown>).code).toBe("PAYLOAD_TOO_LARGE");
  expect(String((tooLargeForRunner!.error as Record<string, unknown>).message)).toContain("大小限制");
  // 伪造 pluginId：runner 用 mount 时确认的身份覆盖，宿主不会把请求算到别人头上
  const spoofed = await raw("e2e-self-id", "app.context", {}, { pluginId: "com.attacker.someone.else" });
  expect(spoofed).not.toBeNull();
  expect(spoofed!.ok).toBe(true);
  expect((spoofed!.result as Record<string, unknown>).pluginId).toBe(PLUGIN_ID);
});

/* -------------------------------------------------------------------------- */
/* 5. 未授权 Broker 调用                                                        */
/* -------------------------------------------------------------------------- */

test("5. 未授权 Broker 调用：PERMISSION_DENIED 与 UNKNOWN_METHOD", async ({ page }) => {
  await bootWithProbe(page, []);
  const { plugin } = await openProbe(page);

  const denied = await plugin.evaluate(() =>
    (window as unknown as { __probe: { storageSet: (key: string, value: string) => Promise<Record<string, unknown>> } }).__probe.storageSet("probe.key", "probe-value"),
  );
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe("PERMISSION_DENIED");
  expect(String(denied.message)).toContain("缺少权限");

  const unknown = await plugin.evaluate(() =>
    (
      window as unknown as {
        __probe: { rawReply: (a: string, b: string, c: unknown, d: Record<string, unknown>) => Promise<Record<string, unknown> | null> };
      }
    ).__probe.rawReply("e2e-unknown-method", "os.exfiltrate", {}, { timeoutMs: 4_000 }),
  );
  expect(unknown).not.toBeNull();
  expect(unknown!.ok).toBe(false);
  expect((unknown!.error as Record<string, unknown>).code).toBe("UNKNOWN_METHOD");
  expect(String((unknown!.error as Record<string, unknown>).message)).toContain("宿主没有提供方法");

  // 不需要权限的 app.context 仍然可用（证明沙箱本身没有坏掉）
  const context = await plugin.evaluate(() =>
    (window as unknown as { __probe: { context: () => Promise<Record<string, unknown>> } }).__probe.context(),
  );
  expect(context.ok).toBe(true);
  const record = await readInstall(page, PLUGIN_ID);
  expect(record!.granted).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 6. 宿主存储隔离                                                              */
/* -------------------------------------------------------------------------- */

test("6. 存储隔离：插件读不到宿主 localStorage，也拿不到父文档", async ({ page }) => {
  const secret = `host-secret-${Date.now()}`;
  await bootWithProbe(page);
  await page.evaluate((value) => window.localStorage.setItem("e2e.host.secret", value), secret);
  const { plugin } = await openProbe(page);

  const isolation = await plugin.evaluate(async () => {
    const result: Record<string, unknown> = {};
    try {
      result.localStorage = { ok: true, value: window.localStorage.getItem("e2e.host.secret") };
    } catch (error) {
      result.localStorage = { ok: false, name: (error as Error).name, message: String((error as Error).message) };
    }
    try {
      result.parentStorage = { ok: true, value: (window.parent as Window).localStorage.getItem("e2e.host.secret") };
    } catch (error) {
      result.parentStorage = { ok: false, name: (error as Error).name };
    }
    try {
      result.parentDocument = { ok: true, text: window.parent.document.body.textContent?.slice(0, 20) ?? "" };
    } catch (error) {
      result.parentDocument = { ok: false, name: (error as Error).name };
    }
    result.indexedDb = await new Promise<Record<string, unknown>>((resolve) => {
      try {
        const request = window.indexedDB.open("e2e-probe");
        request.onerror = () => resolve({ ok: false, name: request.error?.name ?? "Error" });
        request.onsuccess = () => {
          request.result.close();
          resolve({ ok: true });
        };
      } catch (error) {
        resolve({ ok: false, name: (error as Error).name });
      }
    });
    return result;
  });

  expect(isolation.localStorage).toMatchObject({ ok: false, name: "SecurityError" });
  expect(isolation.parentStorage).toMatchObject({ ok: false, name: "SecurityError" });
  expect(isolation.parentDocument).toMatchObject({ ok: false, name: "SecurityError" });
  expect(isolation.indexedDb).toMatchObject({ ok: false });

  // 宿主侧的数据没有被插件改写
  expect(await page.evaluate(() => window.localStorage.getItem("e2e.host.secret"))).toBe(secret);
  const record = await readInstall(page, PLUGIN_ID);
  expect(record!.id).toBe(PLUGIN_ID);
});

/* -------------------------------------------------------------------------- */
/* 7. Cookie 与网络隔离                                                         */
/* -------------------------------------------------------------------------- */

test("7. Cookie 与网络隔离：插件读不到宿主 Cookie，也无法自行联网", async ({ page }) => {
  await bootWithProbe(page);
  const hostCookie = await page.evaluate(() => {
    document.cookie = "e2e_host_cookie=host-cookie-secret; path=/";
    return document.cookie;
  });
  expect(hostCookie).toContain("e2e_host_cookie");
  const { plugin } = await openProbe(page);

  const isolation = await plugin.evaluate(async () => {
    const result: Record<string, unknown> = {};
    try {
      result.cookies = { ok: true, value: document.cookie };
    } catch (error) {
      result.cookies = { ok: false, name: (error as Error).name, message: String((error as Error).message) };
    }
    try {
      result.parentCookies = { ok: true, value: window.parent.document.cookie };
    } catch (error) {
      result.parentCookies = { ok: false, name: (error as Error).name };
    }
    try {
      await fetch("http://127.0.0.1:8788/api/health", { cache: "no-store", credentials: "include" });
      result.fetch = { ok: true };
    } catch (error) {
      result.fetch = { ok: false, name: (error as Error).name, message: String((error as Error).message) };
    }
    const meta = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]');
    result.csp = meta ? meta.getAttribute("content") : null;
    return result;
  });

  expect(isolation.cookies).toMatchObject({ ok: false, name: "SecurityError" });
  expect(isolation.parentCookies).toMatchObject({ ok: false, name: "SecurityError" });
  expect(isolation.fetch).toMatchObject({ ok: false });
  expect(String(isolation.csp)).toContain("connect-src 'none'");
  expect(String(isolation.csp)).toContain("frame-src 'none'");

  // 宿主页自己的 Cookie 完好，插件侧没有可读取的值
  const stillThere = await page.evaluate(() => document.cookie);
  expect(stillThere).toContain("e2e_host_cookie");
});

/* -------------------------------------------------------------------------- */
/* 8. 导航逃逸                                                                  */
/* -------------------------------------------------------------------------- */

test("8. 导航逃逸：插件跳出沙箱后会话被销毁并持久禁用", async ({ page }) => {
  await bootWithProbe(page);
  const { plugin } = await openProbe(page);

  // 用 setTimeout 让 evaluate 先返回，避免导航把执行上下文一起销毁
  await plugin.evaluate(() => {
    window.setTimeout(() => {
      window.location.replace("about:blank");
    }, 0);
    return true;
  });

  await expect
    .poll(
      async () => {
        const record = await readInstall(page, PLUGIN_ID);
        return record ? { blocked: record.blocked, enabled: record.enabled } : null;
      },
      { timeout: 20_000, message: "导航逃逸没有被持久禁用" },
    )
    .toEqual({ blocked: true, enabled: false });

  // 宿主侧沙箱 iframe 被移除（EVENT → fail → destroy），窗口本身还在但已没有运行上下文
  await expect.poll(() => page.locator(".gp-frame").count(), { timeout: 15_000 }).toBe(0);
  await expect.poll(() => page.frames().filter((frame) => frame.url().startsWith("blob:")).length, { timeout: 15_000 }).toBe(0);
  await expect(page.locator(`.window[data-app="${APP_ID}"]`)).toBeVisible();

  const record = await readInstall(page, PLUGIN_ID);
  const messages = (record!.logs as Array<{ message: string }>).map((log) => log.message);
  expect(messages.some((message) => message.includes("插件试图导航出沙箱，已强制禁用"))).toBe(true);
  expect(messages.some((message) => message.includes("插件试图跳出沙箱"))).toBe(true);

  // 关闭窗口后再次打开：宿主看到 enabled=false，直接显示禁用态，不再创建沙箱
  await page.locator(`.window[data-app="${APP_ID}"] .dot-close`).click();
  await expect(page.locator(`.window[data-app="${APP_ID}"]`)).toHaveCount(0);
  await openApp(page, APP_ID);
  await expect(page.locator(`.window[data-app="${APP_ID}"] .gp-blocked`)).toBeVisible();
  expect(await page.locator(".gp-frame").count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* 9. 权限撤销后运行实例销毁                                                    */
/* -------------------------------------------------------------------------- */

test("9. 权限撤销：运行中的插件实例被销毁", async ({ page }) => {
  // 见文件头说明：走插件管理器的官方示例安装 → 管理 → 权限 → 全部拒绝 → 保存授权。
  await bootOs(page);
  await openApp(page, "pm");
  const manager = page.locator('.window[data-app="pm"]');
  await manager.locator('[data-tab="official"]').click();

  const installButton = manager.locator(`[data-act="install-official"][data-id="${OFFICIAL_PLUGIN_ID}"]`);
  await expect(installButton).toBeVisible({ timeout: 20_000 });
  await installButton.click();

  const installDialog = page.locator(".gp-dialog-layer .gp-dialog");
  await expect(installDialog).toBeVisible({ timeout: 10_000 });
  await installDialog.locator("[data-perm-all]").click();
  await installDialog.locator('[data-gp-action="ok"]').click();
  await expect
    .poll(async () => Boolean(await readInstall(page, OFFICIAL_PLUGIN_ID)), { timeout: 20_000, message: "官方插件没有安装成功" })
    .toBe(true);

  // 打开官方插件，确认它真的在沙箱里跑起来了
  await openApp(page, `plugin:${OFFICIAL_PLUGIN_ID}`);
  await expect.poll(() => page.locator(".gp-frame").count(), { timeout: 20_000 }).toBe(1);

  // 回到插件管理器（重新 open 会聚焦已有窗口），进入详情页的「权限」
  await page.evaluate((appId) => {
    const gos = (window as unknown as { GOS14: { ctx: { openApp: (id: string) => unknown } } }).GOS14;
    return gos.ctx.openApp(appId);
  }, "pm");
  await manager.locator('[data-tab="official"]').click();
  const manageButton = manager.locator(`[data-act="open-detail"][data-id="${OFFICIAL_PLUGIN_ID}"]`);
  await expect(manageButton).toBeVisible({ timeout: 15_000 });
  await manageButton.click();
  const permissionsButton = manager.locator(`[data-act="permissions"][data-id="${OFFICIAL_PLUGIN_ID}"]`);
  await expect(permissionsButton).toBeVisible({ timeout: 10_000 });
  await permissionsButton.click();

  const permissionsDialog = page.locator(".gp-dialog-layer .gp-dialog");
  await expect(permissionsDialog).toBeVisible({ timeout: 10_000 });
  expect(await permissionsDialog.locator("input[data-perm]").count()).toBeGreaterThan(0);
  await permissionsDialog.locator("[data-perm-none]").click();
  await permissionsDialog.locator('[data-gp-action="ok"]').click();

  // 撤销权限 → destroySessionsFor → 运行实例 iframe 被移除
  await expect.poll(() => page.locator(".gp-frame").count(), { timeout: 20_000, message: "撤销权限后运行实例没有被销毁" }).toBe(0);
  await expect.poll(async () => {
    const record = await readInstall(page, OFFICIAL_PLUGIN_ID);
    return record ? record.granted : null;
  }, { timeout: 10_000 }).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 10. 跨标签页撤销                                                             */
/* -------------------------------------------------------------------------- */

test("10. 跨标签页撤销：其他标签页修改插件状态会销毁本页运行实例", async ({ page, context }) => {
  await bootWithProbe(page);
  await openProbe(page);
  expect(await page.locator(".gp-frame").count()).toBe(1);

  const other = await context.newPage();
  try {
    await other.goto("/", { waitUntil: "domcontentloaded" });
    await other.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).GOS14), undefined, { timeout: 30_000 });
    await other.evaluate((stateKey) => {
      const raw = window.localStorage.getItem(stateKey);
      if (!raw) throw new Error("另一个标签页没有读到插件状态");
      const state = JSON.parse(raw) as { installs: Record<string, Record<string, unknown>> };
      const record = state.installs["com.e2e.sandbox.probe"];
      if (!record) throw new Error("另一个标签页没有读到探针插件记录");
      record.updatedAt = Date.now() + 5_000;
      record.logs = Array.isArray(record.logs) ? [...(record.logs as unknown[]), { at: Date.now(), level: "info", message: "跨标签页更新" }] : [];
      window.localStorage.setItem(stateKey, JSON.stringify(state));
    }, STATE_KEY);

    // 宿主页监听 storage 事件，必须销毁所有运行中的沙箱会话
    await expect.poll(() => page.locator(".gp-frame").count(), { timeout: 20_000, message: "跨标签页撤销没有销毁沙箱实例" }).toBe(0);
    await expect.poll(() => page.frames().filter((frame) => frame.url().startsWith("blob:")).length, { timeout: 15_000 }).toBe(0);
    // 插件记录本身仍然存在（只是运行上下文被销毁），没有被误删
    const record = await readInstall(page, PLUGIN_ID);
    expect(record).not.toBeNull();
    expect(record!.id).toBe(PLUGIN_ID);
  } finally {
    await other.close();
  }
});