/**
 * D1 整库备份核心（Guandao OS 2.0 · 生产数据保护）。
 *
 * 只处理「文件字节」：哈希、gzip、AES-256-GCM、SQL 结构检查、保留期判断。
 * 不包含任何 D1 写入逻辑；恢复检查在隔离的 node:sqlite 内存库中完成。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export const BACKUP_FORMAT = "guandao-d1-backup-v1";
export const ALGORITHM = "aes-256-gcm";

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeKey(raw) {
  const key = Buffer.from(String(raw || "").trim(), "base64");
  if (key.length !== 32) {
    throw new Error("D1_BACKUP_KEY 必须是 base64 编码的 32 字节密钥（AES-256）");
  }
  return key;
}

export function encrypt(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decrypt(ciphertext, key, ivB64, tagB64) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 在内存 SQLite 中执行整库 SQL，返回结构统计。
 * 不接触任何生产 D1；D1 导出文件与 SQLite 兼容。
 */
export function inspectSql(sql) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const foreignKeys = [];
    for (const table of tables) {
      const rows = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all();
      for (const row of rows) {
        foreignKeys.push({ table, to: row.table, from: row.from, onDelete: row.on_delete });
      }
    }
    const rowCounts = {};
    for (const table of tables) {
      rowCounts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(table)}`).get().n);
    }
    const migrations = tables.includes("d1_migrations")
      ? Number(db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get().n)
      : 0;
    return { tables, indexes, foreignKeys, rowCounts, migrations };
  } finally {
    db.close();
  }
}

export function assertSqlLooksComplete(sql) {
  const text = String(sql || "");
  if (!text.includes("CREATE TABLE")) throw new Error("SQL 中没有任何 CREATE TABLE，疑似空备份");
  if (text.includes("\u0000")) throw new Error("SQL 含 NUL 字节，文件可能损坏");
  if (text.trim().length < 100) throw new Error("SQL 过短，疑似不完整备份");
  return true;
}

export function isExpired(createdAt, retentionDays, now = Date.now()) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) throw new Error("createdAt 不是有效时间");
  return now - created > Number(retentionDays) * 86400_000;
}

export function validateMetadata(meta) {
  const required = ["format", "id", "createdAt", "database", "mode", "file", "bytes", "sha256", "archiveSha256", "encrypted", "stats"];
  for (const key of required) {
    if (meta?.[key] === undefined || meta?.[key] === null) throw new Error(`备份元数据缺少 ${key}`);
  }
  if (meta.format !== BACKUP_FORMAT) throw new Error(`未知备份格式：${meta.format}`);
  if (!/^[A-Za-z0-9-]+$/.test(meta.id)) throw new Error("备份 id 非法");
  if (!meta.stats || !Array.isArray(meta.stats.tables) || typeof meta.stats.rowCounts !== "object") {
    throw new Error("备份 stats 不完整");
  }
  if (meta.encrypted && (!meta.iv || !meta.tag || meta.algorithm !== ALGORITHM)) {
    throw new Error("加密备份缺少 iv/tag/algorithm");
  }
  return true;
}

export function gzip(buffer) {
  return gzipSync(buffer, { level: 9 });
}

export function gunzip(buffer) {
  return gunzipSync(buffer);
}