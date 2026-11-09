#!/usr/bin/env node
/**
 * Guandao Plugin CLI · 1.7
 *
 * 只做五件事：创建项目、校验 Manifest、构建插件包、本地预览、发布到开发者中心。
 * 零第三方依赖；不会读取 GitHub / Cloudflare 凭据，发布只用你显式传入的会话 Cookie。
 *
 * 用法：
 *   node cli/guandao.mjs create my-plugin --id com.example.tool --name "My Tool" --type application
 *   node cli/guandao.mjs validate my-plugin
 *   node cli/guandao.mjs build my-plugin
 *   node cli/guandao.mjs dev my-plugin
 *   node cli/guandao.mjs package my-plugin
 *   node cli/guandao.mjs publish my-plugin --cookie "gauth_sid=..." --changelog "首个版本"
 *
 * 2.2 新增（发布者签名，见 docs/security/PLUGIN-SIGNING.md）：
 *   node cli/guandao.mjs keygen                       # 生成 Ed25519 私钥/公钥（私钥只落本地文件）
 *   node cli/guandao.mjs keys register --cookie ...    # 把公钥登记到开发者中心
 *   node cli/guandao.mjs sign my-plugin --key <file>   # 给已构建的包签名
 *   node cli/guandao.mjs publish my-plugin --key <file> --cookie ...
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

import {
  PLUGIN_LIMITS,
  PLUGIN_TYPE_META,
  canonicalFilesJson,
  isSafePackagePath,
  validateManifest,
} from "../shared/plugin-spec.js";
import {
  SIG_ALGORITHM,
  SIG_KEY_ID_PREFIX,
  SIG_SPEC_VERSION,
  base64urlDecode,
  base64urlEncode,
  buildSignatureEnvelope,
  bundleDigests,
  keyIdForPublicKey,
  registerProofPayloadText,
  signaturePayloadBytes,
  signEd25519,
} from "../shared/plugin-signature.js";

const CLI_VERSION = "2.0.0";
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "woff", "woff2", "ttf", "otf"]);
const IGNORED = new Set(["node_modules", ".git", "dist", ".DS_Store"]);

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const log = (...args) => console.log(...args);
const ok = (text) => log(`${c.green}✓${c.reset} ${text}`);
const warn = (text) => log(`${c.yellow}!${c.reset} ${text}`);
const bad = (text) => log(`${c.red}✗${c.reset} ${text}`);

function usage() {
  log(`
${c.bold}Guandao Plugin CLI${c.reset} ${c.dim}v${CLI_VERSION}${c.reset}

用法:
  guandao create <dir> [--id <id>] [--name <name>] [--type <type>]
  guandao validate [dir]
  guandao test [dir]
  guandao build [dir]
  guandao dev [dir] [--port 5173]
  guandao package [dir]          # 与 build 等价（同一产物），保留旧名兼容脚本
  guandao preview [dir] [--port 5174]
  guandao publish [dir] --cookie <cookie> [--url https://guandao.xin] [--changelog <text>]
  guandao keygen [--out <file>] [--label <text>]      # 生成发布者 Ed25519 密钥对（私钥只在本地）
  guandao keys register --key <file> --cookie <cookie> [--url ...] [--label <text>]
  guandao sign [dir] --key <file> --publisher <userId>

退出码:
  0 成功 · 1 校验 / 打包 / 测试失败 · 2 未知命令

类型:
  ${Object.keys(PLUGIN_TYPE_META).join(" / ")}

说明:
  - 插件源码放在 src/，Manifest 放在项目根目录 guandao.plugin.json；
  - test 是静态自检：Manifest、入口、SDK 调用表面与打包摘要（不启动浏览器）；
  - build / package 会生成 dist/<id>-<version>.gplug（JSON 文本，含 filesDigest）；
  - dev 的 Mock Host 会授予全部权限，只用于开发，不能代表正式安装后的权限行为；
  - publish 只向 /api/developer/* 发请求，不自动获取任何第三方权限；
  - keygen 生成的私钥只写在你指定的本地文件里，CLI 从不上传、从不打印私钥；
  - 2.2 起签名是「阶段 A」：不签名的旧包仍可发布，但市场会标为「未签名」；
  - publish 带 --key 时自动签名；不带则明确提示这次是未签名发布；
  - Cookie 形如 gauth_sid=...，可在浏览器开发者工具里复制，用完请退出登录使其失效。
`);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { flags, positional };
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
   项目读取与校验
   ============================================================ */

async function loadProject(dir) {
  const root = path.resolve(dir || ".");
  const manifestPath = path.join(root, "guandao.plugin.json");
  if (!(await exists(manifestPath))) {
    throw new Error(`找不到 ${manifestPath}，先运行 guandao create`);
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Manifest 不是有效 JSON：${error.message}`);
  }
  const sourceDir = path.join(root, "src");
  if (!(await exists(sourceDir))) throw new Error("找不到 src/ 目录");
  return { root, manifestPath, sourceDir, raw };
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

async function collectFiles(project) {
  const paths = await walk(project.sourceDir);
  const files = [];
  const problems = [];
  let total = 0;
  for (const relative of paths.sort()) {
    if (!isSafePackagePath(relative)) {
      problems.push(`不允许的文件路径或类型：${relative}`);
      continue;
    }
    const full = path.join(project.sourceDir, relative);
    const info = await stat(full);
    if (info.size > PLUGIN_LIMITS.fileBytes) {
      problems.push(`单文件超过 ${Math.round(PLUGIN_LIMITS.fileBytes / 1024)} KB：${relative}`);
      continue;
    }
    total += info.size;
    const ext = relative.split(".").pop().toLowerCase();
    const buffer = await readFile(full);
    files.push({
      path: relative,
      encoding: BINARY_EXT.has(ext) ? "base64" : "utf8",
      content: BINARY_EXT.has(ext) ? buffer.toString("base64") : buffer.toString("utf8"),
    });
  }
  if (files.length > PLUGIN_LIMITS.files) problems.push(`文件数量超过 ${PLUGIN_LIMITS.files} 个`);
  if (total > PLUGIN_LIMITS.bundleBytes) problems.push("源码总体积超过插件包上限");
  return { files, problems, total };
}

async function validateProject(project) {
  const result = validateManifest(project.raw, { expectedId: project.raw?.id });
  const { files, problems, total } = await collectFiles(project);
  const errors = result.errors.map((issue) => `${issue.path}: ${issue.message}`);
  const warnings = result.warnings.map((issue) => `${issue.path}: ${issue.message}`);
  errors.push(...problems);

  if (result.manifest) {
    const paths = new Set(files.map((file) => file.path.toLowerCase()));
    if (result.manifest.entry && !paths.has(result.manifest.entry.toLowerCase())) {
      errors.push(`entry: 入口文件不在 src/ 中：${result.manifest.entry}`);
    }
    if (result.manifest.icon && !paths.has(result.manifest.icon.toLowerCase())) {
      errors.push(`icon: 图标文件不在 src/ 中：${result.manifest.icon}`);
    }
    for (const shot of result.manifest.screenshots) {
      if (!paths.has(shot.toLowerCase())) errors.push(`screenshots: 预览图不在 src/ 中：${shot}`);
    }
  }

  return { manifest: result.manifest, files, errors, warnings, total };
}

function makeBundle(manifest, files, signature = null) {
  const filesDigest = createHash("sha256").update(canonicalFilesJson(files), "utf8").digest("hex");
  const bundle = {
    format: "guandao-plugin",
    formatVersion: 1,
    manifest,
    files,
    filesDigest,
  };
  // 签名放在包顶层：validateBundle 不拒绝未知顶层键，旧客户端会直接忽略。
  if (signature) bundle.signature = signature;
  return JSON.stringify(bundle, null, 2);
}

/* ============================================================
   发布者密钥 / 签名（2.2）
   ============================================================ */

const KEY_FILE_VERSION = 1;

async function loadKeyFile(file) {
  const text = await readFile(file, "utf8");
  const key = JSON.parse(text);
  if (!key || key.type !== "guandao-publisher-key" || !key.privateKey || !key.publicKey || !key.keyId) {
    throw new Error("密钥文件格式不正确：应包含 type/privateKey/publicKey/keyId");
  }
  if (key.algorithm !== SIG_ALGORITHM) throw new Error("不支持的签名算法：" + key.algorithm);
  return key;
}

async function importPrivateKey(base64url) {
  const der = base64urlDecode(base64url);
  if (!der) throw new Error("私钥损坏：不是合法的 base64url");
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

/** 生成信封并签名；返回带 signature 的包对象。 */
async function signBundleObject(bundle, key, publisherId) {
  const digests = await bundleDigests(bundle, bundle.files);
  const envelope = buildSignatureEnvelope({
    keyId: key.keyId,
    publisherId,
    pluginId: bundle.manifest.id,
    version: bundle.manifest.version,
    filesDigest: digests.filesDigest,
    manifestDigest: digests.manifestDigest,
  });
  const privateKey = await importPrivateKey(key.privateKey);
  const signature = await signEd25519(privateKey, signaturePayloadBytes(envelope));
  envelope.sig = base64urlEncode(signature);
  // 包自身的 filesDigest 必须一起写回：服务端 inspectBundle 会核对声明值与实际值。
  return { ...bundle, filesDigest: bundle.filesDigest ?? digests.filesDigest, signature: envelope };
}

async function apiCall(base, cookie, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { cookie, origin: base, accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const message = payload?.error?.message || "HTTP " + response.status;
    const error = new Error(message);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function whoAmI(base, cookie) {
  const payload = await apiCall(base, cookie, "GET", "/api/auth/me");
  const user = payload?.user ?? payload?.data?.user;
  if (!user?.id) throw new Error("没有读取到当前账号（/api/auth/me），请确认 Cookie 有效");
  return user;
}

async function keygenCommand(flags) {
  const out = String(flags.out || "guandao-publisher-key.json");
  let exists = true;
  try {
    await access(out, constants.F_OK);
  } catch {
    exists = false;
  }
  if (exists) throw new Error("密钥文件已存在：" + out + "（不会覆盖已有私钥；请换 --out）");

  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = base64urlEncode(publicRaw);
  const keyId = await keyIdForPublicKey(publicRaw);
  if (!keyId.startsWith(SIG_KEY_ID_PREFIX)) throw new Error("keyId 派生异常");

  const file = {
    type: "guandao-publisher-key",
    version: KEY_FILE_VERSION,
    spec: SIG_SPEC_VERSION,
    algorithm: SIG_ALGORITHM,
    keyId,
    publicKey,
    privateKey: base64urlEncode(privatePkcs8),
    label: String(flags.label || "").slice(0, 64),
    createdAt: Date.now(),
  };
  await writeFile(out, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  ok("已生成发布者密钥：" + keyId);
  log("  公钥  " + publicKey);
  log("  私钥  " + c.yellow + out + c.reset + c.dim + "（本地文件，请立刻备份，不要提交到仓库）" + c.reset);
  log("  " + c.dim + "下一步：node cli/guandao.mjs keys register --key " + out + " --cookie \"gauth_sid=...\"" + c.reset);
  log("  " + c.dim + "服务端只保存公钥；私钥丢失只能换新密钥，旧签名版本仍可验证。" + c.reset);
}

async function keysRegisterCommand(flags) {
  const keyFile = String(flags.key || "guandao-publisher-key.json");
  const cookie = String(flags.cookie || process.env.GUANDAO_COOKIE || "");
  if (!cookie) throw new Error("缺少 --cookie（形如 gauth_sid=...），或用环境变量 GUANDAO_COOKIE");
  const base = String(flags.url || "https://guandao.xin").replace(/\/+$/, "");

  const key = await loadKeyFile(keyFile);
  const user = await whoAmI(base, cookie);
  const issuedAt = Date.now();
  const payload = registerProofPayloadText({ userId: user.id, publicKey: key.publicKey, keyId: key.keyId, issuedAt });
  const privateKey = await importPrivateKey(key.privateKey);
  const signature = await signEd25519(privateKey, new TextEncoder().encode(payload));

  const result = await apiCall(base, cookie, "POST", "/api/developer/keys", {
    publicKey: key.publicKey,
    keyId: key.keyId,
    issuedAt,
    proof: base64urlEncode(signature),
    label: String(flags.label || key.label || "").slice(0, 64),
  });
  ok("公钥已登记：" + (result?.data?.key?.keyId ?? key.keyId));
  log("  " + c.dim + "登记成功后，用它签名的版本会在客户端显示「已签名」。" + c.reset);
}

async function signCommand(dir, flags) {
  const keyFile = String(flags.key || "guandao-publisher-key.json");
  const key = await loadKeyFile(keyFile);
  const result = await validateCommand(dir);
  const publisherId = String(flags.publisher || "");
  if (!publisherId) throw new Error("缺少 --publisher <userId>：签名必须绑定发布者账号");
  const signed = await signBundleObject(
    { format: "guandao-plugin", formatVersion: 1, manifest: result.manifest, files: result.files },
    key,
    publisherId,
  );
  const text = JSON.stringify(signed, null, 2);
  const project = await loadProject(dir);
  const outDir = path.join(project.root, "dist");
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, result.manifest.id + "-" + result.manifest.version + ".gplug");
  await writeFile(out, text, "utf8");
  ok("已签名：" + out);
  log("  keyId " + key.keyId);
}

/* ============================================================
   create
   ============================================================ */

const TEMPLATES = {
  application: {
    html: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="style.css" />
    <title>__NAME__</title>
  </head>
  <body>
    <main class="app">
      <header>
        <h1>__NAME__</h1>
        <p>由 Guandao Plugin CLI 创建</p>
      </header>
      <section class="card">
        <button type="button" id="notify">发送通知</button>
        <pre id="out">等待调用…</pre>
      </section>
      <footer id="ctx">正在读取插件上下文…</footer>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`,
    js: `(function () {
  var out = document.getElementById("out");
  var ctx = document.getElementById("ctx");

  function show(value) {
    out.textContent = JSON.stringify(value, null, 2);
  }
  function fail(error) {
    out.textContent = (error.code || "ERROR") + ": " + error.message;
  }

  document.getElementById("notify").addEventListener("click", function () {
    window.guandao.notifications.success("来自插件", "这条通知经过了宿主授权。")
      .then(function (result) { show(result); })
      .catch(fail);
  });

  window.guandao.lifecycle.on("ready", function () {
    window.guandao.context().then(function (value) {
      ctx.textContent = value.pluginId + " · v" + value.version + " · SDK " + value.sdkVersion;
    }).catch(fail);
  });
})();
`,
    css: `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  color: #eef1f7;
  background: radial-gradient(120% 90% at 10% 0%, #1c2338, #0b0e15 70%);
  padding: 22px;
}
.app { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; height: 100%; }
h1 { margin: 0; font-size: 18px; }
header p { margin: 3px 0 0; color: #99a1b6; font-size: 11.5px; }
.card { padding: 14px; border-radius: 13px; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); }
button { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; cursor: pointer; }
pre { margin: 10px 0 0; padding: 10px; border-radius: 9px; background: rgba(0,0,0,.3); font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #b9c2d8; min-height: 48px; white-space: pre-wrap; }
footer { margin-top: auto; color: #7f879b; font-size: 11px; }
`,
    manifest: (base) => ({
      ...base,
      type: "application",
      entry: "index.html",
      permissions: ["window.open", "notification.show", "plugin.storage.read", "plugin.storage.write"],
      contributes: {},
    }),
    icon: (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#0f1420"/><circle cx="48" cy="48" r="22" fill="none" stroke="${color}" stroke-width="7"/></svg>`,
  },
  widget: {
    html: `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><link rel="stylesheet" href="style.css" /></head>
  <body>
    <span class="time" id="time">--:--</span>
    <span class="date" id="date">__NAME__</span>
    <script src="app.js"></script>
  </body>
</html>
`,
    js: `(function () {
  var timeEl = document.getElementById("time");
  var dateEl = document.getElementById("date");
  function pad(n) { return String(n).padStart(2, "0"); }
  function tick() {
    var now = new Date();
    timeEl.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
    dateEl.textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  }
  window.guandao.lifecycle.on("ready", function () {
    tick();
    window.guandao.ui.theme().then(function (theme) {
      document.body.dataset.mode = theme.mode;
      timeEl.style.color = theme.accent;
    }).catch(function () {});
  });
  tick();
  window.setInterval(tick, 1000);
})();
`,
    css: `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; }
body { font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; color: #eef1f7; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 2px 4px; }
.time { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.date { font-size: 10.5px; color: rgba(238,241,247,.55); }
body[data-mode="light"] { color: #1b2130; }
body[data-mode="light"] .date { color: rgba(27,33,48,.6); }
`,
    manifest: (base) => ({
      ...base,
      type: "widget",
      entry: "index.html",
      permissions: ["desktop.add_widget", "theme.read"],
      contributes: {
        widget: { title: base.name, defaultSize: "m", height: 132, description: "由 CLI 创建的组件" },
      },
    }),
    icon: (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#0f1420"/><rect x="26" y="30" width="44" height="36" rx="8" fill="none" stroke="${color}" stroke-width="6"/></svg>`,
  },
  theme: {
    html: "",
    js: "",
    css: "",
    manifest: (base) => ({
      ...base,
      type: "theme",
      entry: "",
      permissions: ["theme.apply"],
      contributes: {
        theme: {
          name: base.name,
          en: "Custom",
          desc: "由 CLI 创建的声明式主题。",
          wall: "aurora",
          mode: "dark",
          accent: "#6f8cff",
          accent2: "#b06eff",
          material: "glass",
          radius: "round",
          font: "sans",
          grain: false,
        },
      },
    }),
    icon: (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#0f1420"/><path d="M30 48a18 18 0 0 1 36 0" fill="none" stroke="${color}" stroke-width="7"/></svg>`,
  },
};

async function createCommand(dir, flags) {
  if (!dir) throw new Error("请指定目录：guandao create my-plugin");
  const root = path.resolve(dir);
  if (await exists(path.join(root, "guandao.plugin.json"))) throw new Error("这个目录里已经有 guandao.plugin.json");

  let answers = {
    id: flags.id,
    name: flags.name,
    type: flags.type || "application",
    description: flags.description,
    author: flags.author,
  };

  if (!answers.id || !answers.name) {
    if (!process.stdin.isTTY) {
      throw new Error("非交互环境请提供 --id 与 --name");
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    answers.id = answers.id || (await rl.question("插件 ID（反向域名，例如 com.example.tool）："));
    answers.name = answers.name || (await rl.question("插件名称："));
    answers.description = answers.description || (await rl.question("一句话介绍："));
    answers.author = answers.author || (await rl.question("作者名称："));
    await rl.close();
  }

  if (!Object.prototype.hasOwnProperty.call(TEMPLATES, answers.type)) {
    throw new Error(`不支持的类型：${answers.type}。可选：${Object.keys(TEMPLATES).join(" / ")}`);
  }
  const template = TEMPLATES[answers.type];
  const base = {
    manifestVersion: 1,
    id: String(answers.id).trim(),
    name: String(answers.name).trim().slice(0, 48),
    version: "1.0.0",
    description: String(answers.description || "一个由 Guandao Plugin CLI 创建的插件。").slice(0, 2000),
    author: { name: String(answers.author || "你的名字").slice(0, 48), url: "" },
    category: answers.type === "theme" ? "creative" : "productivity",
    license: "MIT",
    homepage: "",
    repository: "",
    changelog: "第一个版本。",
    screenshots: [],
    compatibility: { minimumOSVersion: "2.0.0", sdkVersion: 1 },
    networkDomains: [],
    dependencies: [],
  };
  const manifest = template.manifest(base);
  manifest.icon = template.html ? "icon.svg" : "icon.svg";

  const check = validateManifest(manifest, { expectedId: manifest.id });
  if (!check.ok) throw new Error(`生成的 Manifest 不合法：${check.errors.map((e) => e.message).join("；")}`);

  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "guandao.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "src", "icon.svg"), template.icon("#6f8cff"), "utf8");
  if (template.html) {
    await writeFile(path.join(root, "src", manifest.entry), template.html.replaceAll("__NAME__", manifest.name), "utf8");
    await writeFile(path.join(root, "src", "app.js"), template.js, "utf8");
    await writeFile(path.join(root, "src", "style.css"), template.css, "utf8");
  } else {
    await writeFile(
      path.join(root, "src", "theme.json"),
      `${JSON.stringify(manifest.contributes.theme, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(root, "README.md"),
    `# ${manifest.name}\n\n${manifest.description}\n\n## 开发\n\n\`\`\`bash\nnode ../cli/guandao.mjs dev .\n\`\`\`\n\n## 打包\n\n\`\`\`bash\nnode ../cli/guandao.mjs package .\n\`\`\`\n`,
    "utf8",
  );
  await writeFile(path.join(root, ".gitignore"), "dist/\nnode_modules/\n", "utf8");

  ok(`已创建 ${manifest.id}`);
  log(`  ${c.dim}${root}${c.reset}`);
  log(`  下一步：node cli/guandao.mjs dev ${dir}`);
}

/* ============================================================
   validate / build / package
   ============================================================ */

async function validateCommand(dir) {
  const project = await loadProject(dir);
  const result = await validateProject(project);
  if (result.errors.length) {
    for (const error of result.errors) bad(error);
    throw new Error(`Manifest / 源码校验失败（${result.errors.length} 项）`);
  }
  for (const warning of result.warnings) warn(warning);
  ok(`Manifest 合法：${result.manifest.id} v${result.manifest.version}`);
  log(`  类型 ${result.manifest.type} · 文件 ${result.files.length} 个 · 源码 ${(result.total / 1024).toFixed(1)} KB`);
  return result;
}

async function buildCommand(dir) {
  const result = await validateCommand(dir);
  const project = await loadProject(dir);
  const bundle = makeBundle(result.manifest, result.files);
  const outDir = path.join(project.root, "dist");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${result.manifest.id}-${result.manifest.version}.gplug`);
  await writeFile(file, bundle, "utf8");
  const size = Buffer.byteLength(bundle, "utf8");
  if (size > PLUGIN_LIMITS.bundleBytes) throw new Error("插件包超过 2 MB 上限");
  ok(`已生成 ${path.relative(process.cwd(), file)}`);
  log(`  ${(size / 1024).toFixed(1)} KB · filesDigest ${createHash("sha256").update(canonicalFilesJson(result.files)).digest("hex").slice(0, 16)}…`);
  return { file, bundle, result };
}

/* ============================================================
   test：本地静态自检
   ============================================================ */

/**
 * 2.0 新增。`test` 不启动浏览器，做的是「装到真实系统之前能查出来的问题」：
 *   1. Manifest / 文件 / 体积 / 路径校验（和 validate 同一套规则）；
 *   2. 入口文件存在且非空；
 *   3. 插件源码里调用的 `guandao.*` API 是否在 SDK 表面之内
 *      （例如 widget.setTitle 曾经在 SDK 里有、Broker 里没有）；
 *   4. 打包后再解包，filesDigest 必须一致（能发现编码/换行导致的摘要漂移）。
 *
 * 失败返回 1，成功返回 0，方便直接进 CI。
 */
const SDK_SURFACE = {
  app: ["context", "close", "setTitle", "resize", "openApp"],
  widget: ["context", "setEnabled", "setTitle"],
  ui: ["toast", "notify", "dialog", "openApp", "setTitle", "resize", "close", "theme"],
  storage: ["get", "set", "delete", "keys", "clear"],
  notifications: ["show", "success", "warning", "error"],
  files: ["pick", "read"],
  theme: ["get", "apply"],
  commands: ["register", "onInvoke"],
  calendar: ["readSelected", "createEvent"],
  notes: ["readSelected", "create"],
  network: ["fetch"],
  device: ["info"],
  lifecycle: ["ready", "on", "reportError"],
  root: ["context", "has"],
};

async function testCommand(dir) {
  const project = await loadProject(dir);
  const result = await validateProject(project);
  const checks = [];

  const record = (name, pass, detail = "") => {
    checks.push({ name, pass, detail });
    if (pass) ok(`${name}${detail ? ` · ${detail}` : ""}`);
    else bad(`${name}${detail ? ` · ${detail}` : ""}`);
  };

  record("Manifest 与源码校验", result.errors.length === 0, result.errors[0] ?? `${result.files.length} 个文件`);
  if (result.errors.length) return { checks, ok: false };

  const manifest = result.manifest;
  const entry = (manifest.contributes?.app?.entry || manifest.entry || "index.html").replace(/^\.\//, "");
  const entryFile = result.files.find((file) => file.path === entry);
  record("入口文件存在", Boolean(entryFile), entry);
  record(
    "入口文件非空",
    Boolean(entryFile && entryFile.content.trim().length > 40),
    entryFile ? `${(entryFile.content.length / 1024).toFixed(1)} KB` : "缺少内容",
  );

  // 静态扫描：guandao.xxx.yyy( 是否在 SDK 表面内
  const source = result.files
    .filter((file) => file.content.length < 400_000)
    .map((file) => file.content)
    .join("\n");
  const unknown = new Set();
  for (const match of source.matchAll(/guandao\.([a-z]+)\.([a-zA-Z]+)\s*\(/g)) {
    const [, module, method] = match;
    const allowed = SDK_SURFACE[module];
    if (!allowed) {
      unknown.add(`guandao.${module}（未知模块）`);
      continue;
    }
    if (!allowed.includes(method)) unknown.add(`guandao.${module}.${method}`);
  }
  record(
    "SDK 调用都在公开表面内",
    unknown.size === 0,
    unknown.size ? [...unknown].join("、") : "未发现未定义 API",
  );

  // 打包 / 解包往返：摘要必须一致
  const bundleText = makeBundle(manifest, result.files);
  const parsed = JSON.parse(bundleText);
  const digest = createHash("sha256").update(canonicalFilesJson(parsed.files), "utf8").digest("hex");
  record("打包往返摘要一致", !parsed.filesDigest || parsed.filesDigest === digest, `${digest.slice(0, 16)}…`);
  record(
    "插件包体积在上限内",
    Buffer.byteLength(bundleText, "utf8") <= PLUGIN_LIMITS.bundleBytes,
    `${(Buffer.byteLength(bundleText, "utf8") / 1024).toFixed(1)} KB`,
  );

  for (const warning of result.warnings) warn(warning);
  const failed = checks.filter((check) => !check.pass);
  if (failed.length) {
    log(`\n${c.red}${failed.length} 项检查失败${c.reset}`);
    return { checks, ok: false };
  }
  log(`\n${c.green}全部 ${checks.length} 项检查通过${c.reset} ${c.dim}（静态检查；真机权限行为请在系统里安装后验证）${c.reset}`);
  return { checks, ok: true };
}

/* ============================================================
   本地预览（Mock Host）
   ============================================================ */

const HARNESS_JS = `
(function () {
  var frame = document.getElementById('frame');
  var status = document.getElementById('status');
  var granted = window.__GRANTED__;
  var pluginId = window.__PLUGIN_ID__;
  var pending = new Map();
  var seq = 0;

  function send(message) {
    frame.contentWindow.postMessage(message, '*');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.channel !== 'guandao.plugin' || data.kind !== 'RPC') return;
    handle(data);
  });

  function reply(requestId, ok, result, error) {
    send({ channel: 'guandao.plugin', kind: 'RESULT', requestId: requestId, ok: ok, result: result, error: error });
  }

  function has(permission) { return granted.indexOf(permission) >= 0; }
  function denied(permission) {
    return { code: 'PERMISSION_DENIED', message: '本地预览未授予 ' + permission + '（可在工具栏打开）' };
  }

  function handle(message) {
    var method = message.method;
    var payload = message.payload || {};
    var id = message.requestId;
    try {
      if (method === 'app.context') {
        reply(id, true, { pluginId: pluginId, version: window.__VERSION__, type: window.__TYPE__, mode: 'app', osVersion: '1.7.0', sdkVersion: 1, granted: granted, sandbox: true });
        return;
      }
      if (method === 'ui.toast') { toast(payload.text); reply(id, true, { ok: true }); return; }
      if (method === 'ui.notify') {
        if (!has('notification.show')) return reply(id, false, null, denied('notification.show'));
        toast(payload.title + ' · ' + (payload.body || ''), payload.level);
        reply(id, true, { ok: true });
        return;
      }
      if (method === 'ui.dialog') {
        if (!has('dialog.open')) return reply(id, false, null, denied('dialog.open'));
        var choice = window.confirm(payload.title + '\\n\\n' + (payload.message || ''));
        reply(id, true, { action: choice ? (payload.actions && payload.actions[0] ? payload.actions[0].value : 'ok') : null });
        return;
      }
      if (method === 'theme.get') {
        if (!has('theme.read')) return reply(id, false, null, denied('theme.read'));
        reply(id, true, { mode: 'dark', accent: '#6f8cff', accent2: '#b06eff', material: 'glass', radius: 'round', font: 'sans', wall: 'aurora' });
        return;
      }
      if (method.indexOf('storage.') === 0) {
        var need = method === 'storage.set' || method === 'storage.delete' || method === 'storage.clear' ? 'plugin.storage.write' : 'plugin.storage.read';
        if (!has(need)) return reply(id, false, null, denied(need));
        var key = 'guandao.preview.' + pluginId;
        var store = {};
        try { store = JSON.parse(localStorage.getItem(key) || '{}'); } catch (error) { store = {}; }
        if (method === 'storage.get') return reply(id, true, { value: Object.prototype.hasOwnProperty.call(store, payload.key) ? store[payload.key] : null });
        if (method === 'storage.keys') return reply(id, true, { keys: Object.keys(store) });
        if (method === 'storage.set') {
          store[payload.key] = payload.value;
          localStorage.setItem(key, JSON.stringify(store));
          return reply(id, true, { ok: true });
        }
        if (method === 'storage.delete') { delete store[payload.key]; localStorage.setItem(key, JSON.stringify(store)); return reply(id, true, { deleted: true }); }
        if (method === 'storage.clear') { localStorage.removeItem(key); return reply(id, true, { ok: true }); }
      }
      if (method === 'ui.close') { status.textContent = '插件请求关闭窗口（预览环境不会关闭）'; reply(id, true, { ok: true }); return; }
      if (method === 'ui.setTitle' || method === 'ui.resize') { reply(id, true, { ok: true }); return; }
      reply(id, false, null, { code: 'PREVIEW_UNSUPPORTED', message: '本地预览不支持 ' + method + '，请到 Guandao OS 里测试' });
    } catch (error) {
      reply(id, false, null, { code: 'PREVIEW_ERROR', message: error.message });
    }
  }

  function toast(text, level) {
    var node = document.createElement('div');
    node.className = 'toast';
    node.dataset.level = level || 'info';
    node.textContent = text;
    document.getElementById('toasts').appendChild(node);
    setTimeout(function () { node.remove(); }, 3200);
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.channel === 'guandao.plugin' && event.data.kind === 'READY') {
      status.textContent = '插件已启动 · 沙箱预览';
    }
  });
  setTimeout(function () { status.textContent = '等待插件启动…'; }, 1200);
})();
`;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function themePreviewHtml(manifest) {
  const theme = manifest.contributes.theme || {};
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%}
    body{font:13px/1.6 ui-sans-serif,system-ui,sans-serif;color:#eef1f7;background:linear-gradient(160deg,${theme.accent}22,#0b0e15 65%);display:grid;place-items:center;padding:24px}
    .card{width:min(460px,100%);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:18px;background:rgba(20,24,34,.9)}
    h1{margin:0;font-size:17px}
    p{margin:6px 0 0;color:rgba(238,241,247,.62);font-size:11.5px}
    .swatches{display:flex;gap:8px;margin-top:14px}
    .swatches span{height:34px;flex:1;border-radius:9px}
    .meta{margin-top:12px;font-size:10.5px;color:rgba(238,241,247,.45)}
    button{margin-top:14px;font:inherit;font-size:12px;padding:7px 12px;border-radius:8px;border:0;background:linear-gradient(135deg,${theme.accent},${theme.accent2});color:#fff;font-weight:600}
  </style></head><body><div class="card">
    <h1>${escapeHtml(theme.name || manifest.name)}</h1>
    <p>${escapeHtml(theme.desc || "声明式主题预设")}</p>
    <div class="swatches"><span style="background:${theme.accent}"></span><span style="background:${theme.accent2}"></span><span style="background:rgba(255,255,255,.1)"></span></div>
    <div class="meta">壁纸 ${escapeHtml(theme.wall)} · ${escapeHtml(theme.mode)} · ${escapeHtml(theme.material)} · ${escapeHtml(theme.radius)}</div>
    <button type="button">示例按钮</button>
    <p style="margin-top:14px">主题扩展只包含声明式配置，不执行任何 JavaScript。</p>
  </div></body></html>`;
}

function buildHarness({ manifest, html, sdk, permissions, mode }) {
  const config = {
    channel: "guandao.plugin",
    pluginId: manifest.id,
    mountId: "preview",
    granted: permissions,
    theme: { mode: "dark", accent: "#6f8cff", accent2: "#b06eff" },
    context: { osVersion: "1.7.0", sdkVersion: 1, version: manifest.version, type: manifest.type, mode: "app" },
  };
  const ready = "<script>window.addEventListener('load',function(){parent.postMessage({channel:'guandao.plugin',kind:'READY'},'*')});<\/script>";
  const injection =
    "<script>window.__GUANDAO_PLUGIN__=" +
    JSON.stringify(config).replace(/</g, "\\u003c") +
    ";<\/script><script>" +
    sdk.replace(/<\/script/gi, "<\\/script") +
    "<\/script>";

  // 把 SDK 注入到插件自己的 <head> 里，保留插件原有的样式与结构
  let injected = String(html);
  if (/<head[^>]*>/i.test(injected)) {
    injected = injected.replace(/<head([^>]*)>/i, (all) => all + injection);
  } else if (/<html[^>]*>/i.test(injected)) {
    injected = injected.replace(/<html([^>]*)>/i, (all) => all + "<head>" + injection + "</head>");
  } else {
    injected = "<!doctype html><html><head>" + injection + "</head><body>" + injected + "</body></html>";
  }
  injected = /<\/body>/i.test(injected) ? injected.replace(/<\/body>/i, ready + "</body>") : injected + ready;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>预览 · ${escapeHtml(manifest.name)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #080b12; color: #eef1f7; font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,.1); background: #0d1119; }
  header b { font-size: 12.5px; }
  header span { color: #7f879b; font-size: 10.5px; }
  header em { margin-left: auto; font-style: normal; color: #f0c07a; font-size: 10.5px; }
  #frame { flex: 1; width: 100%; border: 0; background: #0b0e15; }
  #toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 6px; z-index: 20; }
  .toast { padding: 8px 12px; border-radius: 9px; background: rgba(30,36,50,.95); border: 1px solid rgba(255,255,255,.14); font-size: 11.5px; max-width: 320px; }
  .toast[data-level="error"] { border-color: rgba(255,110,110,.4); color: #ffb0b0; }
  .toast[data-level="success"] { border-color: rgba(94,207,154,.4); color: #9fe9c6; }
</style>
</head>
<body>
  <header>
    <b>${escapeHtml(manifest.name)}</b>
    <span>v${escapeHtml(manifest.version)} · ${mode} · 本地 Mock Host</span>
    <span id="status">正在启动…</span>
    <em>沙箱 iframe · 不是 Guandao OS 正式运行环境</em>
  </header>
  <iframe id="frame" sandbox="allow-scripts"></iframe>
  <div id="toasts"></div>
  <script>
    window.__PLUGIN_ID__ = ${JSON.stringify(manifest.id)};
    window.__VERSION__ = ${JSON.stringify(manifest.version)};
    window.__TYPE__ = ${JSON.stringify(manifest.type)};
    window.__GRANTED__ = ${JSON.stringify(permissions)};
    ${HARNESS_JS}
    var frame = document.getElementById('frame');
    frame.srcdoc = ${JSON.stringify(injected).replace(/</g, "\\u003c")};
  </script>
</body>
</html>`;
}

function inlineSourceHtml(manifest, files) {
  const map = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const entry = map.get(manifest.entry.toLowerCase());
  if (!entry) throw new Error("找不到入口文件");
  let html = entry.content;
  html = html.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (all, href) => {
    const file = map.get(href.replace(/^\.\//, "").toLowerCase());
    return file && file.encoding === "utf8" ? `<style>${file.content}</style>` : all;
  });
  html = html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi, (all, src) => {
    const file = map.get(src.replace(/^\.\//, "").toLowerCase());
    return file && file.encoding === "utf8" ? `<script>${file.content}</script>` : all;
  });
  html = html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (all, src) => {
    const file = map.get(src.replace(/^\.\//, "").toLowerCase());
    if (!file) return all;
    const mime = src.endsWith(".svg") ? "image/svg+xml" : "image/png";
    return file.encoding === "base64" ? all.replace(src, `data:${mime};base64,${file.content}`) : all;
  });
  return html;
}

async function devCommand(dir, flags, preview = false) {
  const project = await loadProject(dir);
  const result = await validateProject(project);
  if (result.errors.length) {
    for (const error of result.errors) bad(error);
    throw new Error("源码校验失败，先修复再启动预览");
  }
  let files = result.files;
  let manifest = result.manifest;
  let mode = "dev";

  if (preview) {
    const projectRoot = project.root;
    const distDir = path.join(projectRoot, "dist");
    let bundleFile = pathsIn(await readdir(distDir).catch(() => []), manifest.id, manifest.version);
    if (!bundleFile) {
      const built = await buildCommand(dir);
      bundleFile = path.basename(built.file);
    }
    const raw = await readFile(path.join(distDir, bundleFile), "utf8");
    const bundle = JSON.parse(raw);
    const digest = createHash("sha256").update(canonicalFilesJson(bundle.files), "utf8").digest("hex");
    if (bundle.filesDigest && bundle.filesDigest !== digest) throw new Error("插件包摘要不一致，拒绝预览");
    files = bundle.files;
    manifest = bundle.manifest;
    mode = "package";
  }

  const port = Number(flags.port || (preview ? 5174 : 5173));
  const sdkPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/sandbox/sdk.js");
  let sdk;
  try {
    sdk = await readFile(sdkPath, "utf8");
  } catch {
    throw new Error(`找不到 SDK：${sdkPath}`);
  }
  const html = manifest.type === "theme" ? themePreviewHtml(manifest) : inlineSourceHtml(manifest, files);
  const page = buildHarness({ manifest, html, sdk, permissions: manifest.permissions, mode });

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page);
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  ok(`预览已启动：${c.cyan}http://127.0.0.1:${port}/${c.reset}`);
  log(`  ${c.dim}${mode === "package" ? "从 .gplug 插件包加载（已校验摘要）" : "从 src/ 源码加载"} · 权限已全部授予 · Mock Host 只用于开发${c.reset}`);
  // 2.0：开发预览与生产语义不同，必须说清楚，避免「本地能跑、装到系统里被拒」
  warn("开发预览会授予 Manifest 里的全部权限；正式安装时用户会逐项授权，未被授予的能力会返回 PERMISSION_DENIED");
  log(`  ${c.dim}Ctrl+C 结束${c.reset}`);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

function pathsIn(list, id, version) {
  return list.find((name) => name === `${id}-${version}.gplug`) || list.find((name) => name.endsWith(".gplug"));
}

/* ============================================================
   publish
   ============================================================ */

async function publishCommand(dir, flags) {
  const cookie = String(flags.cookie || process.env.GUANDAO_COOKIE || "");
  if (!cookie) throw new Error("缺少 --cookie（形如 gauth_sid=...），或用环境变量 GUANDAO_COOKIE");
  const base = String(flags.url || "https://guandao.xin").replace(/\/+$/, "");
  const result = await validateCommand(dir);
  let publisherId = String(flags.publisher || "");
  let publisherKey = null;
  if (flags.key) {
    publisherKey = await loadKeyFile(String(flags.key));
    if (!publisherId) publisherId = (await whoAmI(base, cookie)).id;
  }
  let bundle;
  if (publisherKey) {
    const signed = await signBundleObject(
      { format: "guandao-plugin", formatVersion: 1, manifest: result.manifest, files: result.files },
      publisherKey,
      publisherId,
    );
    bundle = JSON.stringify(signed, null, 2);
  } else {
    bundle = makeBundle(result.manifest, result.files);
    warn("未提供 --key：这次发布是未签名的，市场会标记为「未签名」");
  }
  if (Buffer.byteLength(bundle, "utf8") > PLUGIN_LIMITS.bundleBytes) throw new Error("插件包超过 2 MB");

  const headers = {
    cookie,
    origin: base,
    accept: "application/json",
    "content-type": "application/json",
  };

  const call = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };

  log(`${c.dim}发布到 ${base} · ${result.manifest.id} v${result.manifest.version}${c.reset}`);

  const create = await call("/api/developer/plugins", {
    id: result.manifest.id,
    name: result.manifest.name,
    type: result.manifest.type,
    category: result.manifest.category,
    description: result.manifest.description,
    license: result.manifest.license,
  });
  if (create.status === 200) ok("已创建开发者草稿");
  else if (create.payload?.error?.code === "ID_TAKEN") log(`  ${c.dim}插件已存在，直接上传新版本${c.reset}`);
  else throw new Error(`创建失败：${create.payload?.error?.message || create.status}`);

  const upload = await call(`/api/developer/plugins/${encodeURIComponent(result.manifest.id)}/versions`, {
    bundle,
    changelog: String(flags.changelog || result.manifest.changelog || "新版本"),
  });
  if (upload.status !== 200) {
    const issues = upload.payload?.error?.issues || [];
    for (const issue of issues) bad(`${issue.path}: ${issue.message}`);
    throw new Error(`上传失败：${upload.payload?.error?.message || upload.status}`);
  }
  ok(`已上传 v${upload.payload.data.version.version}`);

  const submit = await call(`/api/developer/plugins/${encodeURIComponent(result.manifest.id)}/submit`, {});
  if (submit.status !== 200) throw new Error(`提交审核失败：${submit.payload?.error?.message || submit.status}`);
  ok("已提交审核，审核通过后会出现在插件市场");
  log(`  ${c.dim}不需要 CLI 持有任何 GitHub / Cloudflare 权限；会话只用于这一次请求。${c.reset}`);
}

/* ============================================================
   入口
   ============================================================ */

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0];
const target = positional[1];

try {
  if (!command || flags.help || command === "help") usage();
  else if (command === "create") await createCommand(target, flags);
  else if (command === "validate") await validateCommand(target);
  else if (command === "test") {
    const result = await testCommand(target);
    if (!result.ok) process.exitCode = 1;
  }
  else if (command === "build") await buildCommand(target);
  else if (command === "package") await buildCommand(target);
  else if (command === "dev") await devCommand(target, flags, false);
  else if (command === "preview") await devCommand(target, flags, true);
  else if (command === "publish") await publishCommand(target, flags);
  else if (command === "keygen") await keygenCommand(flags);
  else if (command === "sign") await signCommand(target, flags);
  else if (command === "keys" && target === "register") await keysRegisterCommand(flags);
  else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  bad(error.message || String(error));
  process.exitCode = 1;
}
