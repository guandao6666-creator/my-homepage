#!/usr/bin/env node
/**
 * 数据库迁移静态检查（2.0）
 *
 * 背景：2.0 审计发现 0006 / 0012 里有两个索引因为「重名 + IF NOT EXISTS」
 * 被静默跳过，线上实际缺索引，而 CI 只跑 `migrations apply`，不会报错。
 *
 * 这个脚本在 CI 里做静态校验：
 *   1. 文件名必须是 000N_描述.sql，且从 0001 开始连续；
 *   2. 每条迁移都要有头部注释（说明背景与回滚方式）；
 *   3. CREATE INDEX 必须带 IF NOT EXISTS；
 *   4. 不允许出现「同名但定义不同」的索引（已知历史冲突在 allowlist 里）；
 *   5. 不允许在迁移里出现 DROP TABLE / DROP COLUMN（D1 不支持后者，
 *      前者必须先备份并在评审里单独说明）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "migrations";
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** 1.x 已经存在的重名索引：只记录，不阻断（0013 已用新名字补齐） */
const KNOWN_DUPLICATES = new Set(["idx_backups_user_created", "idx_backups_user_status"]);

const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const problems = [];
const warnings = [];

if (!files.length) problems.push("migrations/ 目录里没有任何 .sql 文件");

let expected = 1;
for (const file of files) {
  const match = NAME_RE.exec(file);
  if (!match) {
    problems.push(`${file}：文件名不符合 000N_描述.sql`);
    continue;
  }
  const number = Number(match[1]);
  if (number !== expected) {
    problems.push(`${file}：编号应为 ${String(expected).padStart(4, "0")}，实际 ${match[1]}`);
  }
  expected = number + 1;
}

/** 索引名 → { columns, files } */
const indexes = new Map();

for (const file of files) {
  const text = readFileSync(join(DIR, file), "utf8");
  const header = text.slice(0, 400);
  if (!/^--/m.test(header)) problems.push(`${file}：缺少头部注释（说明背景与回滚方式）`);

  if (/^\s*DROP\s+TABLE/im.test(text)) problems.push(`${file}：包含 DROP TABLE，需要单独评审`);
  if (/^\s*DROP\s+COLUMN/im.test(text) || /ALTER\s+TABLE[^;]*DROP\s+COLUMN/i.test(text)) {
    problems.push(`${file}：包含 DROP COLUMN（D1 不支持，需要重建表并单独评审）`);
  }

  for (const match of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+([^;]+);/gi)) {
    const hasIfNotExists = Boolean(match[1]);
    const name = match[2];
    const body = match[3].replace(/\s+/g, " ").trim();
    if (!hasIfNotExists) problems.push(`${file}：索引 ${name} 缺少 IF NOT EXISTS（重复执行会失败）`);
    const existing = indexes.get(name);
    if (!existing) {
      indexes.set(name, { body, files: [file] });
    } else {
      existing.files.push(file);
      if (existing.body !== body && !KNOWN_DUPLICATES.has(name)) {
        problems.push(
          `${file}：索引 ${name} 与 ${existing.files[0]} 定义不同（同名会被 IF NOT EXISTS 静默跳过）`,
        );
      }
    }
  }
}

for (const [name, info] of indexes) {
  if (info.files.length > 1 && KNOWN_DUPLICATES.has(name)) {
    warnings.push(`索引 ${name} 在 ${info.files.join(" / ")} 重复定义（历史遗留，0013 已用新名字补齐）`);
  }
}

if (warnings.length) {
  console.warn("[migrations] 警告：");
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

if (problems.length) {
  console.error("[migrations] 检查失败：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[migrations] 通过：${files.length} 个迁移文件，${indexes.size} 个索引定义`);