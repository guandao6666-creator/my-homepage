#!/usr/bin/env node
/**
 * Supabase anon key → publishable key 轮换（Guandao OS 2.0 · Phase 1）。
 *
 * 官方路径（Supabase: Migrating to publishable and secret API keys）：
 *   1. 创建 publishable key（与 legacy anon 并存，不立刻断流量）；
 *   2. 前端切到 publishable key，构建 + 部署；
 *   3. 线上验证 /sb 与社区读取；
 *   4. 停用 legacy JWT keys（anon + service_role）；
 *   5. 验证旧 anon 401、新 publishable 正常。
 *
 * 安全：
 *   - 令牌只从环境变量 SUPABASE_ACCESS_TOKEN 或 ~/.supabase/access-token 读取；
 *   - 不打印令牌、不打印完整 key（只打印前缀/名称）；
 *   - 验证通过前绝不停用 legacy key；
 *   - 失败时恢复 .env。
 *
 * 用法：
 *   node scripts/rotate-supabase-key.mjs --dry-run
 *   node scripts/rotate-supabase-key.mjs --yes
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";

const API = "https://api.supabase.com/v1";
const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");
const BACKUP_PATH = path.join(os.tmpdir(), `guandao-env-${Date.now()}.bak`);

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function loadToken() {
  const fromEnv = (process.env.SUPABASE_ACCESS_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const file = path.join(os.homedir(), ".supabase", "access-token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return { token, source: "~/.supabase/access-token" };
  }
  return null;
}

function projectRef(env) {
  const url = env.PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "";
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

async function api(token, pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`Supabase API ${pathname} 失败：${String(message).slice(0, 200)}`);
  }
  return body;
}

function updateEnvKey(text, key, value) {
  const lines = text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  return next.join("\n");
}

function run(label, command, args) {
  console.log(`[rotate] ${label}`);
  execFileSync(command, args, { stdio: "inherit", cwd: ROOT });
}

async function verifyKey(base, key) {
  // /auth/v1/settings 只要 key 有效就返回 200，不依赖任何表的 RLS；
  // 旧 key 被停用后这里应返回 401。比拿 posts 表验证更可靠。
  const response = await fetch(`${base}/sb/auth/v1/settings`, {
    headers: { apikey: key, accept: "application/json" },
  });
  const text = await response.text();
  return { status: response.status, sample: text.slice(0, 120) };
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmed = args.has("--yes");
if (!dryRun && !confirmed) {
  console.error("这是生产轮换操作。先 --dry-run 查看计划；确认后加 --yes。");
  process.exit(2);
}

const envText = readFileSync(ENV_PATH, "utf8");
const env = parseEnv(envText);
const ref = projectRef(env);
if (!ref) {
  console.error("无法从 .env 的 PUBLIC_SUPABASE_URL 解析项目 ref。");
  process.exit(2);
}

const tokenInfo = loadToken();
if (!tokenInfo) {
  console.error("缺少 Supabase 管理令牌：请设置 SUPABASE_ACCESS_TOKEN，或写入 ~/.supabase/access-token。");
  process.exit(2);
}
console.log(`[rotate] 项目 ${ref} · 令牌来源 ${tokenInfo.source}${dryRun ? " · dry-run" : ""}`);

const legacy = await api(tokenInfo.token, `/projects/${ref}/api-keys/legacy`);
console.log(`[rotate] legacy JWT keys enabled: ${legacy?.enabled}`);
if (legacy?.enabled === false && !dryRun) {
  console.log("[rotate] legacy keys 已经停用，无需重复轮换。");
  process.exit(0);
}

const keys = await api(tokenInfo.token, `/projects/${ref}/api-keys?reveal=true`);
const list = Array.isArray(keys) ? keys : keys?.data ?? [];
const publishable = list.filter((item) => item.type === "publishable");
console.log(
  `[rotate] 现有 keys: ${list.map((item) => `${item.type}:${item.name}${item.prefix ? `(${item.prefix})` : ""}`).join(", ") || "无"}`,
);

let selected = publishable.find((item) => item.name === "guandao_web") ?? publishable[0];
if (!selected) {
  if (dryRun) {
    console.log("[rotate] 将创建 publishable key: guandao_web");
  } else {
    selected = await api(tokenInfo.token, `/projects/${ref}/api-keys?reveal=true`, {
      method: "POST",
      body: JSON.stringify({ type: "publishable", name: "guandao_web", description: "Guandao OS web client" }),
    });
    console.log(`[rotate] 已创建 publishable key: ${selected.name} (${selected.prefix ?? "?"})`);
  }
} else {
  console.log(`[rotate] 使用现有 publishable key: ${selected.name} (${selected.prefix ?? "?"})`);
}

if (dryRun) {
  console.log("[rotate] 计划：更新 .env → npm run build → wrangler deploy → /sb 验证 → 停用 legacy → 旧 key 401 验证");
  process.exit(0);
}
if (!selected?.api_key) {
  throw new Error("Supabase 未返回 publishable key 明文；请确认令牌有 secrets:write 权限。");
}

copyFileSync(ENV_PATH, BACKUP_PATH);
let deployed = false;
try {
  let nextEnv = updateEnvKey(envText, "PUBLIC_SUPABASE_ANON_KEY", selected.api_key);
  nextEnv = updateEnvKey(nextEnv, "SUPABASE_ANON_KEY", selected.api_key);
  writeFileSync(ENV_PATH, nextEnv, "utf8");

  run("构建", process.execPath, [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "run", "build"]);
  run("部署", process.execPath, [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy"]);
  deployed = true;

  const newKeyCheck = await verifyKey("https://guandao.xin", selected.api_key);
  console.log(`[rotate] 新 key 经 /sb/auth/v1/settings 验证: HTTP ${newKeyCheck.status}`);
  if (newKeyCheck.status !== 200 && newKeyCheck.status !== 206) {
    throw new Error(`新 key 线上验证失败（HTTP ${newKeyCheck.status}）：${newKeyCheck.sample}`);
  }

  await api(tokenInfo.token, `/projects/${ref}/api-keys/legacy?enabled=false`, { method: "PUT" });
  console.log("[rotate] 已停用 legacy JWT keys（anon + service_role）");

  const legacyKey = env.PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || "";
  if (legacyKey) {
    const oldCheck = await verifyKey("https://guandao.xin", legacyKey);
    console.log(`[rotate] 旧 anon key 经 /sb 访问: HTTP ${oldCheck.status}`);
    if (oldCheck.status !== 401 && oldCheck.status !== 403) {
      console.warn("[rotate] 警告：旧 key 未返回 401/403，可能仍有边缘缓存；稍后复核。");
    }
  }

  console.log("[rotate] 完成：publishable key 已上线，legacy keys 已停用。");
  console.log("[rotate] 建议：删除 ~/.supabase/access-token（若为本次临时创建），并在 Supabase 控制台确认 legacy 状态。");
  rmSync(BACKUP_PATH, { force: true });
} catch (error) {
  console.error(`[rotate] 失败：${error?.message ?? error}`);
  if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, ENV_PATH);
    console.error("[rotate] 已恢复 .env");
  }
  if (deployed) {
    console.error("[rotate] 注意：若新 key 已部署但验证失败，请检查 Supabase legacy 是否仍启用；旧 key 未被停用。");
  }
  process.exitCode = 1;
}