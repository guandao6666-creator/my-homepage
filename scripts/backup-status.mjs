#!/usr/bin/env node
/**
 * D1 备份状态 CLI。
 *
 * 用法：
 *   node scripts/backup-status.mjs --file ./backup-status.json
 *   node scripts/backup-status.mjs --file ./backup-status.json --check
 *   node scripts/backup-status.mjs --remote          # 只读查询 d1_backup_runs
 *
 * 安全：不输出 Token、SQL、signed_url；只输出计数与状态。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildBackupAlert,
  evaluateBackupStatus,
} from "../worker/workflows/d1-backup-core.js";

function parseArgs(argv) {
  const args = { file: "", remote: false, json: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i] || "";
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function readLocal(file) {
  if (!file) throw new Error("--file 为空");
  try {
    const raw = fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    return {
      lastSuccessAt: null,
      lastRun: null,
      error: `STATUS_FILE_UNREADABLE:${String(error?.code || error?.message || error).slice(0, 120)}`,
    };
  }
}

function readRemote() {
  const wrangler = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
  const sql = `SELECT run_id, status, started_at, finished_at, object_key, manifest_key, sql_bytes, sha256, error_code, notify_error
               FROM d1_backup_runs ORDER BY started_at DESC LIMIT 20`;
  try {
    const raw = execFileSync(
      process.execPath,
      [wrangler, "d1", "execute", "guandao-db", "--remote", "--json", "--command", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" } },
    );
    const start = raw.indexOf("[");
    if (start < 0) throw new Error("无法解析 wrangler 输出");
    const rows = JSON.parse(raw.slice(start))[0]?.results ?? [];
    const latest = rows[0] ?? null;
    const success = rows.find((row) => row.status === "success");
    return {
      lastSuccessAt: success?.finished_at ? new Date(success.finished_at).toISOString() : null,
      lastRun: latest
        ? {
            runId: latest.run_id,
            status: latest.status,
            startedAt: latest.started_at ? new Date(latest.started_at).toISOString() : null,
            finishedAt: latest.finished_at ? new Date(latest.finished_at).toISOString() : null,
            objectKey: latest.object_key,
            manifestKey: latest.manifest_key,
            sqlBytes: latest.sql_bytes,
            sha256: latest.sha256,
            errorCode: latest.error_code,
            notifyError: latest.notify_error,
          }
        : null,
      runs: rows,
      source: "d1_backup_runs",
    };
  } catch (error) {
    return { lastSuccessAt: null, lastRun: null, source: "d1_backup_runs", error: String(error?.message ?? error).slice(0, 160) };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/backup-status.mjs --file <status.json> [--check] [--json]");
    console.log("      node scripts/backup-status.mjs --remote [--check] [--json]");
    return;
  }
  if (args.remote && args.file) throw new Error("--remote 与 --file 不能同时使用");
  const status = args.remote ? readRemote() : readLocal(args.file);
  const health = evaluateBackupStatus(status);
  const alert = health.state === "healthy" ? null : buildBackupAlert(health);
  const output = { health, alert, source: args.remote ? "remote" : path.resolve(args.file) };
  console.log(JSON.stringify(output, null, args.json ? 2 : 2));
  if (args.check && health.state !== "healthy") process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(`[backup-status] ${error?.message ?? error}`);
  process.exit(1);
}