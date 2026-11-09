#!/usr/bin/env node
/**
 * 安全事件日志自测（不连接真实 D1）。
 *
 * 覆盖：
 *   1. 白名单事件能记录；
 *   2. 非白名单事件被拒绝；
 *   3. Token / Cookie / Secret / 邮箱不会进入日志；
 *   4. 超长字符串被截断；
 *   5. 日志写入失败不抛出、不影响主流程。
 */

import assert from "node:assert/strict";
import { logSecurityEvent, safeMetadata, SECURITY_EVENT_TYPES } from "../worker/api/privacy/events.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

function fakeEnv(inserts) {
  return {
    DB: {
      prepare() {
        return {
          bind(...args) {
            return {
              run() {
                inserts.push(args);
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

async function collect() {
  const inserts = [];
  const env = fakeEnv(inserts);
  await logSecurityEvent(env, {
    eventType: "account_deletion_failed",
    result: "failure",
    metadata: { code: "ACCOUNT_DELETE_FAILED", token: "secret", cookie: "gauth_sid=abc", email: "a@b.test" },
  });
  return inserts;
}

const inserts = await collect();

await check("1. 白名单事件能记录", () => {
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][2], "account_deletion_failed");
  assert.equal(inserts[0][4], "failure");
});

await check("2. 非白名单事件被拒绝", async () => {
  // 同步检查：直接调用并等待
  const before = inserts.length;
  await logSecurityEvent(fakeEnv(inserts), { eventType: "evil_event", metadata: { code: "X" } });
  assert.equal(inserts.length, before);
});

await check("3. Token / Cookie / Secret / 邮箱不会进入日志", () => {
  const metadata = JSON.parse(inserts[0][5]);
  const text = JSON.stringify(metadata);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("gauth_sid"), false);
  assert.equal(text.includes("a@b.test"), false);
  assert.equal(metadata.code, "ACCOUNT_DELETE_FAILED");
});

await check("4. 超长字符串被截断", () => {
  const meta = safeMetadata({ reason: "x".repeat(500), code: "C" });
  assert.equal(meta.reason.length, 120);
});

await check("5. 日志写入失败不抛出", async () => {
  const env = { DB: { prepare() { throw new Error("D1 down"); } } };
  await logSecurityEvent(env, { eventType: "data_backup_completed", metadata: { backupId: "b1" } });
});

await check("6. 白名单包含本次新增的关键事件", () => {
  for (const event of [
    "account_deletion_failed",
    "account_deletion_r2_incomplete",
    "data_monitor_alert",
    "data_monitor_acknowledged",
    "data_backup_completed",
    "data_backup_failed",
    "qa_cleanup_started",
    "qa_cleanup_completed",
  ]) {
    assert.equal(SECURITY_EVENT_TYPES.has(event), true, event);
  }
});

const failed = results.filter((item) => !item.pass).length;
console.log(`\n[security-log] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);