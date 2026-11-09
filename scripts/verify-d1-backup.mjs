#!/usr/bin/env node
/**
 * 在隔离 SQLite 中验证 D1 备份文件（不连接生产 D1，不执行恢复）。
 *
 * 用法：
 *   BACKUP_ENCRYPTION_KEY="<base64-32B>" node scripts/verify-d1-backup.mjs \
 *     --manifest ./run.manifest.json --sql ./run.sql.enc
 *
 * 校验：manifest → 对象 SHA-256 → AES-GCM 解密 → 明文 SHA-256 → SQL 结构
 * → 表/索引/外键/迁移版本/行数（node:sqlite 内存库）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { inspectSql } from "./lib/db-backup-core.mjs";
import {
  assertSqlComplete,
  decryptSql,
  sha256Hex,
  validateManifest,
} from "../worker/workflows/d1-backup-core.js";

function args(argv) {
  const out = { manifest: "", sql: "", report: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") out.manifest = argv[++i] || "";
    else if (argv[i] === "--sql") out.sql = argv[++i] || "";
    else if (argv[i] === "--report") out.report = argv[++i] || "";
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return out;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.help) {
    console.log("node scripts/verify-d1-backup.mjs --manifest <manifest.json> --sql <backup.sql.enc> [--report <json>]");
    return;
  }
  if (!opts.manifest || !opts.sql) throw new Error("需要 --manifest 与 --sql");
  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!key) throw new Error("缺少 BACKUP_ENCRYPTION_KEY 环境变量");

  const manifest = JSON.parse(fs.readFileSync(path.resolve(opts.manifest), "utf8"));
  validateManifest(manifest);
  const ciphertext = fs.readFileSync(path.resolve(opts.sql));
  const objectSha = crypto.createHash("sha256").update(ciphertext).digest("hex");
  if (objectSha !== manifest.object.sha256) throw new Error("OBJECT_SHA256_MISMATCH，拒绝导入");
  const plain = await decryptSql(
    new Uint8Array(ciphertext),
    key,
    manifest.sql.encryption.iv,
  );
  const plainSha = await sha256Hex(plain);
  if (plainSha !== manifest.sql.sha256) throw new Error("PLAINTEXT_SHA256_MISMATCH，拒绝导入");
  assertSqlComplete(plain);
  const sql = new TextDecoder().decode(plain);
  const stats = inspectSql(sql);

  const report = {
    ok: true,
    runId: manifest.workflow?.runId ?? null,
    exportedAt: manifest.exportedAt,
    bookmark: manifest.bookmark,
    objectSha256: objectSha,
    plainSha256: plainSha,
    bytes: ciphertext.byteLength,
    tables: stats.tables.length,
    indexes: stats.indexes.length,
    foreignKeys: stats.foreignKeys.length,
    migrations: stats.migrations,
    rowCounts: stats.rowCounts,
    isolated: true,
    productionTouched: false,
  };
  if (opts.report) fs.writeFileSync(path.resolve(opts.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[verify-d1-backup] ${error?.message ?? error}`);
  process.exit(1);
});