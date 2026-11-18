#!/usr/bin/env node
/**
 * 文档一致性检查（只读，无网络）。
 *
 * 为什么需要它：STATUS / BACKLOG / ACCEPTANCE / RELEASE 四份文档长期手写，
 * 出现过「同一任务登记两次」「历史结论与当前结论并存」「同一指标三个数字」这类问题。
 * 这里只做**可机检**的几条，避免规则过宽导致频繁误报：
 *
 *   1. BACKLOG 里同一任务 ID 只能出现一次；
 *   2. BACKLOG 中状态同时含 Verified 与 Blocked/Not Started 的行视为冲突；
 *   3. ACCEPTANCE 里「未达标」的段落若同文件另有「通过」，必须标注「历史」；
 *   4. 文档中引用的脚本路径必须存在。
 *
 * 用法：node scripts/check-docs.mjs
 */
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const problems = [];

const read = async (file) => {
  try {
    return await readFile(path.join(ROOT, file), "utf8");
  } catch {
    problems.push(`${file}：文件不存在`);
    return "";
  }
};

const backlog = await read("docs/AI-BUILD-BACKLOG.md");
const acceptance = await read("docs/ACCEPTANCE-2.0.md");

/* 1. 重复任务 ID（只看表格首列） */
const ids = new Map();
for (const line of backlog.split(/\r?\n/)) {
  const match = line.match(/^\|\s*(P\d-\d+)\s*\|/);
  if (!match) continue;
  const id = match[1];
  ids.set(id, (ids.get(id) ?? 0) + 1);
}
for (const [id, count] of ids) {
  if (count > 1) problems.push(`BACKLOG：任务 ${id} 重复登记 ${count} 次`);
}

/* 2. 状态自相矛盾 */
for (const line of backlog.split(/\r?\n/)) {
  const match = line.match(/^\|\s*(P\d-\d+)\s*\|.*?\|\s*([^|]*)\|/);
  if (!match) continue;
  const [, id, status] = match;
  if (/Verified/.test(status) && /Blocked|Not Started/.test(status)) {
    problems.push(`BACKLOG：${id} 的状态同时含 Verified 与 Blocked/Not Started`);
  }
}

/* 3. 历史结论未标注 */
if (/未达标/.test(acceptance) && /通过/.test(acceptance)) {
  const lines = acceptance.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/未达标/.test(line)) return;
    if (/历史/.test(line)) return;
    problems.push(`ACCEPTANCE:${index + 1} 含「未达标」但未标注「历史」，可能与当前结论冲突`);
  });
}

/* 4. 引用的脚本必须存在 */
const scriptRefs = new Set();
for (const text of [backlog, acceptance]) {
  for (const match of text.matchAll(/`?(scripts\/[\w.-]+\.mjs)`?/g)) scriptRefs.add(match[1]);
}
for (const ref of scriptRefs) {
  try {
    await access(path.join(ROOT, ref));
  } catch {
    problems.push(`引用的脚本不存在：${ref}`);
  }
}

if (problems.length === 0) {
  console.log("[check-docs] 通过：任务 ID 唯一、状态无冲突、历史结论已标注、脚本引用有效");
  process.exit(0);
}
console.error(`[check-docs] 发现 ${problems.length} 个问题：`);
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
