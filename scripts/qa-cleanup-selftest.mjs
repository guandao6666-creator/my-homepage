#!/usr/bin/env node
/**
 * QA 清理护栏自测（隔离 SQLite，不接触生产 D1）。
 *
 * 覆盖 8 类误删场景：
 *   1. QA 账号可以正常清理；
 *   2. 真实用户不会被 QA 删除 SQL 匹配；
 *   3. 真实邮箱 + qa 前缀被拒绝；
 *   4. 前缀匹配但邮箱不匹配被拒绝；
 *   5. id 匹配但账号身份不匹配被拒绝；
 *   6. 匹配到多行时中止；
 *   7. 删除行数超过预期时中止；
 *   8. 缺少测试上下文标记时拒绝执行。
 *
 * 另外覆盖：关联资源超限、创建时间早于本次运行、非白名单表。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  assertCleanupResourceCounts,
  assertDeleteCount,
  assertQaCleanupTarget,
  buildQaChildDeleteSql,
  buildQaUserDeleteSql,
  isQaEmail,
  isQaUserId,
} from "../scripts/lib/qa-cleanup.mjs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    github_username TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
  );
`);

const now = Date.now();
const QA_ID = "qa-e2e-selftest";
const QA_EMAIL = "qa-e2e-selftest@example.test";
const QA_USERNAME = "qa-e2e";
const REAL_ID = "57a27b19-c853-422c-8470-136fa04030e1";
const REAL_EMAIL = "real-user@users.noreply.github.com";

db.prepare("INSERT INTO users (id, email, github_username, created_at) VALUES (?, ?, ?, ?)").run(
  QA_ID,
  QA_EMAIL,
  QA_USERNAME,
  now - 1000,
);
db.prepare("INSERT INTO users (id, email, github_username, created_at) VALUES (?, ?, ?, ?)").run(
  REAL_ID,
  REAL_EMAIL,
  "guandao6666",
  now - 86400_000,
);
db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run("qa-session", QA_ID);
db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run("real-session", REAL_ID);

function rowsFor(id) {
  return db.prepare("SELECT id, email, github_username, created_at FROM users WHERE id = ?").all(id);
}

function base(overrides = {}) {
  return {
    enabled: true,
    marker: "prod-e2e",
    expectedMarker: "prod-e2e",
    runId: "run-1",
    expectedRunId: "run-1",
    userId: QA_ID,
    email: QA_EMAIL,
    expectedUserId: QA_ID,
    expectedEmail: QA_EMAIL,
    rows: rowsFor(QA_ID),
    expectedUsername: QA_USERNAME,
    createdAfter: now - 5000,
    ...overrides,
  };
}

check("1. QA 账号可以正常清理", () => {
  assert.equal(isQaUserId(QA_ID), true);
  assert.equal(isQaEmail(QA_EMAIL), true);
  const row = assertQaCleanupTarget(base());
  assert.equal(row.id, QA_ID);
  const deleted = db.prepare(buildQaUserDeleteSql({ userId: QA_ID, email: QA_EMAIL })).run();
  assert.equal(Number(deleted.changes), 1);
  assert.equal(rowsFor(QA_ID).length, 0);
});

check("2. 真实用户不会被 QA 删除 SQL 匹配", () => {
  const deleted = db.prepare(buildQaUserDeleteSql({ userId: REAL_ID, email: REAL_EMAIL })).run();
  assert.equal(Number(deleted.changes), 0);
  assert.equal(rowsFor(REAL_ID).length, 1);
});

check("3. 真实邮箱 + qa 前缀被拒绝", () => {
  assert.throws(() =>
    assertQaCleanupTarget(base({ email: REAL_EMAIL, expectedEmail: REAL_EMAIL })),
  );
});

check("4. 前缀匹配但邮箱不匹配被拒绝", () => {
  assert.throws(() =>
    assertQaCleanupTarget(
      base({ email: "qa-other@example.test", expectedEmail: QA_EMAIL }),
    ),
  );
});

check("5. id 匹配但账号身份不匹配被拒绝", () => {
  assert.throws(() =>
    assertQaCleanupTarget(
      base({ rows: [{ ...rowsFor(REAL_ID)[0], id: QA_ID, email: QA_EMAIL }] }),
    ),
  );
});

check("6. 匹配到多个用户时中止", () => {
  const row = rowsFor(REAL_ID)[0];
  assert.throws(() => assertQaCleanupTarget(base({ rows: [row, row] })));
});

check("7. 删除行数超出预期时中止", () => {
  assert.throws(() => assertDeleteCount(2, 1));
  assert.throws(() => assertDeleteCount(0, 1));
  assert.doesNotThrow(() => assertDeleteCount(1, 1));
});

check("8. 缺少必要测试上下文标记时拒绝执行", () => {
  assert.throws(() => assertQaCleanupTarget(base({ enabled: false })));
  assert.throws(() => assertQaCleanupTarget(base({ marker: "" })));
  assert.throws(() => assertQaCleanupTarget(base({ runId: "other-run" })));
});

check("9. 关联资源超限时中止", () => {
  assert.doesNotThrow(() => assertCleanupResourceCounts({ files: 10, sessions: 3 }, 100));
  assert.throws(() => assertCleanupResourceCounts({ files: 101 }, 100));
});

check("10. 创建时间早于本次运行被拒绝", () => {
  assert.throws(() => assertQaCleanupTarget(base({ createdAfter: now + 60_000 })));
});

check("11. 子表清理只匹配 qa- 前缀，且拒绝非白名单表", () => {
  const sql = buildQaChildDeleteSql("sessions", QA_ID);
  assert.match(sql, /user_id LIKE 'qa-%'/);
  assert.throws(() => buildQaChildDeleteSql("users; DROP TABLE users", QA_ID));
});

const failed = results.filter((item) => !item.pass).length;
console.log(`\n[qa-cleanup] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);