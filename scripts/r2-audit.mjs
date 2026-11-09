#!/usr/bin/env node
/**
 * R2 只读巡检客户端。
 *
 * 调用 Worker 的 GET /api/admin/r2-audit（仅管理员），
 * 打印数据库引用、R2 对象、缺失引用、孤儿候选。
 *
 * 安全：
 *   - 不接受命令行里的密码；只接受 Session Cookie（或 GUANDAO_SESSION 环境变量）；
 *   - 生产地址必须显式 --yes-production，避免误操作；
 *   - 不打印 Cookie，也不打印完整 Object Key（服务端只回哈希前缀）。
 *
 * 用法：
 *   node scripts/r2-audit.mjs --base https://guandao.xin --session "<cookie>" --yes-production
 *   GUANDAO_SESSION="gauth_sid=..." node scripts/r2-audit.mjs --base http://127.0.0.1:8787
 */

import process from "node:process";

function parseArgs(argv) {
  const args = { base: "http://127.0.0.1:8787", session: "", yesProduction: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") args.base = argv[++i] || args.base;
    else if (arg === "--session") args.session = argv[++i] || "";
    else if (arg === "--yes-production") args.yesProduction = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/r2-audit.mjs --base <url> --session <cookie> [--yes-production] [--json]");
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function isProduction(base) {
  try {
    const host = new URL(base).hostname;
    return host === "guandao.xin" || host.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
const session = args.session || process.env.GUANDAO_SESSION || "";

if (!session) {
  console.error("缺少 --session（或 GUANDAO_SESSION 环境变量）。需要管理员账号的 gauth_sid Cookie。");
  process.exit(2);
}
if (isProduction(args.base) && !args.yesProduction) {
  console.error("目标看起来是生产环境。确认只读巡检后，加 --yes-production 再执行。");
  process.exit(2);
}

const cookie = session.startsWith("gauth_sid=") ? session : `gauth_sid=${session}`;
const url = new URL("/api/admin/r2-audit", args.base).toString();

let response;
try {
  response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", cookie },
  });
} catch (error) {
  console.error(`请求失败: ${error?.message ?? error}`);
  process.exit(1);
}

const payload = await response.json().catch(() => null);
if (!response.ok || !payload?.success) {
  const code = payload?.error?.code || `HTTP_${response.status}`;
  const message = payload?.error?.message || "巡检接口返回失败";
  console.error(`[r2-audit] ${code}: ${message}`);
  process.exit(1);
}

const report = payload.data;
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const b = report.database;
console.log("R2 只读巡检报告");
console.log(`  时间        ${report.generatedAt}（${report.durationMs} ms）`);
console.log(`  数据库引用  ${b.refs} 条 / 去重 ${b.unique} 个`);
console.log(`    ${Object.entries(b.bySource).map(([key, value]) => `${key}=${value}`).join("  ")}`);
console.log(`  R2 对象     ${report.r2.objects} 个（${report.r2.pages} 页${report.r2.truncated ? "，已截断" : ""}）`);
console.log(`  已匹配      ${report.matched}`);
console.log(`  缺失引用    ${report.missing.count}`);
for (const sample of report.missing.samples) {
  console.log(`    - ${sample.ref} ← ${sample.sources.join(", ")}`);
}
console.log(`  孤儿候选    ${report.orphans.count}`);
for (const sample of report.orphans.samples) {
  console.log(`    - ${sample.ref}  ${sample.size} B  ${sample.uploaded ?? ""}`);
}
for (const limitation of report.limitations) console.log(`  限制        ${limitation}`);
for (const error of report.errors) console.log(`  错误        ${error.source}: ${error.message}`);
console.log("\n提示：孤儿候选只代表「当前没有数据库引用」，不等于可删除；本工具不会删除任何对象。");