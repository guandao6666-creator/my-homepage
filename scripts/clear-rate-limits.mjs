#!/usr/bin/env node
// 清本地 D1 的 rate_limits。
// 为什么需要它：e2e-server 每轮会造约 20 个签名插件包，`plugin-upload` 是 20 次/小时，
// 同一小时内连跑两遍全量 E2E 会被自己的限流挡住，报错看起来像产品回归。
// 默认动作是「拒绝执行」，必须显式传 run + sqlite 路径：
//   node scripts/clear-rate-limits.mjs run .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
import { DatabaseSync } from "node:sqlite";

const mode = process.argv[2];
const file = process.argv[3];

if (mode !== "run" || !file) {
  console.error("REFUSED: 用法 node scripts/clear-rate-limits.mjs run <sqlite 路径>");
  process.exit(2);
}

const db = new DatabaseSync(file);
try {
  const before = db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n;
  db.prepare("DELETE FROM rate_limits").run();
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
  const after = db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n;
  console.log(`rate_limits: ${before} -> ${after}`);
} finally {
  db.close();
}