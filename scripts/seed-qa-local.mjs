#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Guandao OS · 本地 QA 种子数据（scripts/seed-qa-local.mjs）
//
// 目的：让 `qa:plugins` / `qa:continuity` 在不连接任何远程环境的前提下可重复运行。
// 只操作 wrangler 的 **本地** D1（`--local`），不读取 .dev.vars、不连接生产。
//
// 固定身份（scripts/plugins-qa.mjs 与 scripts/continuity-qa.mjs 依赖）：
//   qa-plugin-admin-token-1234567890        role=admin（供 plugins-qa 审核）
//   qa-plugin-dev-token-1234567890          dev 账号，设备 qa-dev-laptop
//   qa-continuity-phone-token-1234567890    同一 dev 账号的第二台设备 qa-dev-phone
//   qa-plugin-other-token-1234567890        独立账号（越权测试对象）
//
// 说明：
//   * token 只以 SHA-256 形式写库，明文只出现在本地测试脚本里，不是生产凭据。
//   * 数据库只允许一个 admin：若本地已有其他 admin（例如 e2e-server 的 qa-p3-admin），
//     直接复用该账号，不新建第二个 admin。
//   * 清空 rate_limits，避免本地反复运行时被进程外窗口额度影响。
//   * 脚本可被 `scripts/qa-local-run.mjs` 直接调用，也可单独执行。
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
const DB_NAME = "guandao-db";

const WRANGLER_ENV = {
  ...process.env,
  TEMP: TMP_DIR,
  TMP: TMP_DIR,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};

/** qa:plugins / qa:continuity 约定的固定明文 token。 */
export const QA_TOKENS = {
  admin: "qa-plugin-admin-token-1234567890",
  dev: "qa-plugin-dev-token-1234567890",
  phone: "qa-continuity-phone-token-1234567890",
  other: "qa-plugin-other-token-1234567890",
};

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function playWrangler(args, options = {}) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: WRANGLER_ENV,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
}

export function applyMigrations() {
  playWrangler(["d1", "migrations", "apply", DB_NAME, "--local"], { capture: true });
}

function runSql(sql) {
  playWrangler(["d1", "execute", DB_NAME, "--local", "--command", sql], { capture: true });
}

function queryJson(sql) {
  const out = playWrangler(["d1", "execute", DB_NAME, "--local", "--json", "--command", sql], { capture: true });
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`wrangler d1 输出无法解析：${out.slice(-200)}`);
  return JSON.parse(out.slice(start))[0].results ?? [];
}

const NOW = () => Date.now();

/**
 * 写入 / 刷新本地 QA 夹具。幂等：重复执行不会累积重复行。
 * 返回写入结果的摘要，便于 CLI 打印与断言。
 */
export function seedQaFixtures() {
  const now = NOW();
  const sixHours = now + 6 * 60 * 60 * 1000;

  // ---- users --------------------------------------------------------------
  const existingAdmins = queryJson("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  const adminId = existingAdmins.length > 0 ? existingAdmins[0].id : "qa-plugin-admin";

  const statements = [];
  const users = [
    {
      id: adminId,
      email: adminId === "qa-plugin-admin" ? "qa-plugin-admin@example.test" : null,
      githubId: adminId === "qa-plugin-admin" ? 990001 : null,
      githubUsername: adminId === "qa-plugin-admin" ? "qa-plugin-admin" : null,
      displayName: adminId === "qa-plugin-admin" ? "QA Admin" : null,
      role: "admin",
    },
    {
      id: "qa-plugin-dev",
      email: "qa-plugin-dev@example.test",
      githubId: 990002,
      githubUsername: "qa-plugin-dev",
      displayName: "QA Plugin Dev",
      role: "member",
    },
    {
      id: "qa-plugin-other",
      email: "qa-plugin-other@example.test",
      githubId: 990003,
      githubUsername: "qa-plugin-other",
      displayName: "QA Plugin Other",
      role: "member",
    },
  ];

  for (const user of users) {
    if (user.email != null) {
      statements.push(
        `INSERT OR IGNORE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at, deletion_state)
         VALUES ('${user.id}', '${user.email}', '${user.displayName}', 'active', ${now}, ${now}, ${user.githubId}, '${user.githubUsername}', NULL, '${user.role}', ${now}, 'none')`,
      );
    }
    // 已存在的账号：保活并修正角色/身份字段（不删除行，避免级联清掉历史插件数据）。
    statements.push(
      `UPDATE users SET status = 'active', deletion_state = 'none', role = '${user.role}', last_login_at = ${now}, updated_at = ${now}
       WHERE id = '${user.id}'`,
    );
    if (user.githubId != null) {
      statements.push(
        `UPDATE users SET github_id = ${user.githubId}, github_username = COALESCE(github_username, '${user.githubUsername}'), display_name = COALESCE(display_name, '${user.displayName}')
         WHERE id = '${user.id}' AND github_id IS NULL`,
      );
    }
  }

  // ---- devices ------------------------------------------------------------
  const devices = [
    { id: "qa-dev-admin", userId: adminId, name: "QA Admin 设备", type: "desktop", browser: "Chrome", os: "Windows" },
    { id: "qa-dev-laptop", userId: "qa-plugin-dev", name: "QA Laptop", type: "laptop", browser: "Chrome", os: "Windows" },
    { id: "qa-dev-phone", userId: "qa-plugin-dev", name: "QA Phone", type: "mobile", browser: "Chrome", os: "Android" },
    { id: "qa-dev-other", userId: "qa-plugin-other", name: "QA Other 设备", type: "desktop", browser: "Chrome", os: "Windows" },
  ];
  for (const device of devices) {
    statements.push(
      `INSERT OR REPLACE INTO devices (id, user_id, name, platform, app_version, last_seen_at, revoked_at, created_at, device_type, browser_name, os_name, last_active_at, last_sync_at, trusted_at, status, user_agent)
       VALUES ('${device.id}', '${device.userId}', '${device.name}', 'web', '2.0.0', ${now}, NULL, ${now}, '${device.type}', '${device.browser}', '${device.os}', ${now}, NULL, ${now}, 'active', 'GuandaoQA/2.0')`,
    );
  }

  // ---- 清理历史配对/测试遗留的设备与会话，保证设备数量可预期 --------------
  // 配对流程会通过 confirm 动态创建随机 UUID 设备与对应 session；这些行不属于
  // 固定夹具，若不清掉会让设备总览的数量断言随运行次数漂移。
  const qaUserIds = users.map((user) => `'${user.id}'`).join(", ");
  const fixedDeviceIds = devices.map((device) => `'${device.id}'`).join(", ");
  statements.push(
    `DELETE FROM sessions WHERE user_id IN (${qaUserIds}) AND (device_id IS NULL OR device_id NOT IN (${fixedDeviceIds}))`,
  );
  statements.push(`DELETE FROM devices WHERE user_id IN (${qaUserIds}) AND id NOT IN (${fixedDeviceIds})`);

  // ---- sessions -----------------------------------------------------------
  const sessions = [
    { id: "qa-sess-admin", userId: adminId, token: QA_TOKENS.admin, device: "qa-dev-admin" },
    { id: "qa-sess-dev", userId: "qa-plugin-dev", token: QA_TOKENS.dev, device: "qa-dev-laptop" },
    { id: "qa-sess-phone", userId: "qa-plugin-dev", token: QA_TOKENS.phone, device: "qa-dev-phone" },
    { id: "qa-sess-other", userId: "qa-plugin-other", token: QA_TOKENS.other, device: "qa-dev-other" },
  ];
  const tokenHashes = Object.values(QA_TOKENS).map((token) => `'${sha256Hex(token)}'`).join(", ");
  statements.push(`DELETE FROM sessions WHERE token_hash IN (${tokenHashes})`);
  for (const session of sessions) {
    statements.push(
      `INSERT INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at, revoked_at)
       VALUES ('${session.id}', '${session.userId}', '${sha256Hex(session.token)}', '${session.device}', 'GuandaoQA/2.0', ${sixHours}, ${now}, ${now}, NULL)`,
    );
  }

  // ---- 清理这些账号遗留的接力/配对/限流状态，保证脚本可重复 ---------------
  const userIds = [...new Set(users.map((user) => user.id))].map((id) => `'${id}'`).join(", ");
  for (const table of [
    "device_pairings",
    "continuity_items",
    "clipboard_items",
    "device_contexts",
    "device_activity",
    "device_sync_state",
  ]) {
    statements.push(`DELETE FROM ${table} WHERE user_id IN (${userIds})`);
  }
  statements.push("DELETE FROM rate_limits");

  runSql(statements.join(";\n"));
  return { adminId, users: users.length, devices: devices.length, sessions: sessions.length };
}

export function main() {
  applyMigrations();
  const result = seedQaFixtures();
  console.log(
    `[qa-seed] 本地 QA 夹具就绪：admin=${result.adminId}，用户 ${result.users}，设备 ${result.devices}，会话 ${result.sessions}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}