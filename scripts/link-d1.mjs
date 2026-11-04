#!/usr/bin/env node
/**
 * 把 D1 数据库的真实 ID 写入 wrangler.jsonc。
 *
 * 为什么需要这一步：D1 的 database_id 只能从账号里读出来，手抄容易出错；
 * 而 `wrangler deploy` 要求 d1_databases[].database_id 必须是真实 ID，
 * 否则会报 "bindings must have a database_id field"。
 *
 * 用法：
 *   npx wrangler login          # 只需一次
 *   npm run cf:link             # 自动读取 guandao-db 的 UUID 并写回配置
 *   npm run cf:link -- --id <uuid>   # 已知 ID 时可跳过 API 查询
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "wrangler.jsonc");
const BINDING = "DB";
const DEFAULT_DATABASE = "guandao-db";

const args = process.argv.slice(2);
const databaseName = readOption("--name") ?? DEFAULT_DATABASE;
const providedId = readOption("--id");

function readOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

const config = readFileSync(CONFIG_PATH, "utf8");
const d1Match = config.match(/"d1_databases"\s*:\s*\[([\s\S]*?)\]/);

if (!d1Match) {
  fail("wrangler.jsonc 里找不到 d1_databases 字段。", "请确认文件未被手动改坏。");
}

if (/"database_id"\s*:\s*"[0-9a-f-]{36}"/i.test(d1Match[1])) {
  console.log("✓ wrangler.jsonc 已经包含 D1 database_id，无需重复链接。");
  process.exit(0);
}

let databaseId = providedId;

if (!databaseId) {
  console.log(`→ 正在通过 Wrangler 查询数据库「${databaseName}」…`);
  let output;
  try {
    output = execSync("npx wrangler d1 list --json", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = (error.stderr ?? "").toString().trim();
    if (/not authenticated|login/i.test(detail)) {
      fail("Wrangler 尚未登录 Cloudflare。", "先执行 `npx wrangler login`，再重新运行 `npm run cf:link`。");
    }
    fail("执行 `npx wrangler d1 list --json` 失败。", detail.split("\n").slice(-3).join(" "));
  }

  const databases = parseJsonArray(output);
  if (!databases) {
    fail("无法解析 `wrangler d1 list --json` 的输出。", "可改用 `npm run cf:link -- --id <database_id>` 手动指定。");
  }

  const target = databases.find((item) => item?.name === databaseName);
  if (!target) {
    fail(
      `账号下找不到名为「${databaseName}」的 D1 数据库。`,
      `现有数据库：${databases.map((item) => item?.name).filter(Boolean).join("、") || "（无）"}`,
    );
  }

  databaseId = target.uuid ?? target.id;
  if (!databaseId) fail("数据库记录里没有 uuid 字段，无法写入配置。");
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  fail("database_id 格式不合法，应为 36 位 UUID。", `收到的值：${databaseId}`);
}

const replacement = [
  `"d1_databases": [`,
  `    {`,
  `      "binding": "${BINDING}",`,
  `      "database_name": "${databaseName}",`,
  `      "database_id": "${databaseId}",`,
  `      "migrations_dir": "migrations"`,
  `    }`,
  `  ]`,
].join("\n");

const updated = config.replace(/"d1_databases"\s*:\s*\[\s*\]/, replacement);
if (updated === config) {
  fail("未能替换 wrangler.jsonc 中的 d1_databases 空数组。", "请手动检查该字段。");
}

writeFileSync(CONFIG_PATH, updated, "utf8");

console.log(`✓ 已写入 D1 绑定：${BINDING} → ${databaseName} (${databaseId})`);
console.log("  下一步：npm run db:migrate:local（本地）或 npm run db:migrate:remote（线上）");
console.log("  然后：npm run cf:deploy");

function parseJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
