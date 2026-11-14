#!/usr/bin/env node
/**
 * 隔离恢复验证测试（真实 node:sqlite，不连接生产 D1）。
 *
 * 覆盖：
 * - 正常加密 SQL 可导入隔离库；
 * - 对象 SHA-256 不匹配拒绝导入；
 * - 不完整 SQL 拒绝；
 * - 表/索引/外键/迁移版本/行数可读取；
 * - 报告明确 productionTouched=false。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encryptSql, sha256Hex } from "../worker/workflows/d1-backup-core.js";

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

const KEY = randomBytes(32).toString("base64");
const SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE);
CREATE INDEX idx_sessions_user ON sessions (user_id);
INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-11-04');
INSERT INTO users (id, email) VALUES ('u1', 'a@example.test');
INSERT INTO sessions (id, user_id) VALUES ('s1', 'u1');
`;
const dir = mkdtempSync(path.join(tmpdir(), "guandao-d1-recovery-"));

async function makeArtifact({ tamper = false, incomplete = false } = {}) {
  const plain = new TextEncoder().encode(incomplete ? "CREATE TABLE x (id TEXT);\n" : SQL);
  const encrypted = await encryptSql(plain, KEY);
  const objectSha = await sha256Hex(encrypted.ciphertext);
  const object = new Uint8Array(encrypted.ciphertext);
  if (tamper) object[0] ^= 0xff;
  const manifest = {
    schemaVersion: 1,
    database: { name: "guandao-db", ref: "guandao-db/test" },
    workflow: { runId: "run-recovery", schedule: "0 19 * * *" },
    exportedAt: "2026-11-07T19:00:00.000Z",
    bookmark: "bookmark-test",
    r2: { sqlKey: "daily/2026/11/07/run-recovery.sql.enc", manifestKey: "daily/2026/11/07/run-recovery.manifest.json" },
    sql: { bytes: plain.byteLength, sha256: await sha256Hex(plain), encryption: { algorithm: "AES-256-GCM", iv: encrypted.iv } },
    object: { bytes: object.byteLength, sha256: objectSha },
    upload: { status: "put_ok" },
    verify: { status: "sha256_match", verifiedAt: "2026-11-07T19:01:00.000Z" },
  };
  const sqlPath = path.join(dir, `backup-${Math.random().toString(36).slice(2)}.sql.enc`);
  const manifestPath = `${sqlPath}.manifest.json`;
  writeFileSync(sqlPath, object);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { sqlPath, manifestPath };
}

function runCli(sqlPath, manifestPath) {
  return execFileSync(
    process.execPath,
    ["scripts/verify-d1-backup.mjs", "--manifest", manifestPath, "--sql", sqlPath],
    { encoding: "utf8", env: { ...process.env, BACKUP_ENCRYPTION_KEY: KEY } },
  );
}

await check("1. 正常加密 SQL 可导入隔离库并输出结构", async () => {
  const { sqlPath, manifestPath } = await makeArtifact();
  const report = JSON.parse(runCli(sqlPath, manifestPath));
  assert.equal(report.ok, true);
  assert.equal(report.isolated, true);
  assert.equal(report.productionTouched, false);
  assert.equal(report.tables, 3);
  assert.equal(report.foreignKeys, 1);
  assert.equal(report.migrations, 1);
  assert.equal(report.rowCounts.users, 1);
  assert.equal(report.rowCounts.sessions, 1);
});

await check("2. 对象 SHA-256 不匹配时拒绝导入", async () => {
  const { sqlPath, manifestPath } = await makeArtifact({ tamper: true });
  assert.throws(() => runCli(sqlPath, manifestPath), /OBJECT_SHA256_MISMATCH/);
});

await check("3. 不完整 SQL 不能标记为恢复成功", async () => {
  const { sqlPath, manifestPath } = await makeArtifact({ incomplete: true });
  assert.throws(() => runCli(sqlPath, manifestPath), /SQL_TOO_SMALL|SQL_NO_CREATE_TABLE|SQL_TOO/);
});

await check("4. 恢复只在隔离内存库执行，报告不含生产库连接", async () => {
  const { sqlPath, manifestPath } = await makeArtifact();
  const report = JSON.parse(runCli(sqlPath, manifestPath));
  assert.equal(report.productionTouched, false);
  assert.equal(JSON.stringify(report).includes("database_id"), false);
});

rmSync(dir, { recursive: true, force: true });
const failed = results.filter((item) => !item.pass).length;
console.log(`\n[d1-recovery] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);