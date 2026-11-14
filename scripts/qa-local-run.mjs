#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Guandao OS · 本地 QA 运行器（scripts/qa-local-run.mjs）
//
// 用法：
//   node scripts/qa-local-run.mjs plugins
//   node scripts/qa-local-run.mjs continuity
//   node scripts/qa-local-run.mjs devices
//   node scripts/qa-local-run.mjs community   （额外带 --test-scheduled，供清理触发维护任务）
//
// 做的事：
//   1. 确认 dist/ 已构建（缺失时先执行 npm run build）；
//   2. 只对本地 D1 应用迁移并写入 QA 夹具（scripts/seed-qa-local.mjs）；
//   3. 启动 `wrangler dev --local` 于 127.0.0.1:<QA_PORT|8794>；
//   4. 等待 /api/health 返回 200；
//   5. 以隔离的 BASE / QA_BASE / QA_ORIGIN 环境变量运行对应 QA 脚本；
//   6. 结束时关闭本地 Worker。
//
// 安全边界：进程只监听 127.0.0.1、只使用 `--local`（Miniflare 本地模拟），
// 不读取远程 D1/R2、不调用 wrangler deploy、不访问 guandao.xin。
// 这是本地测试脚手架，不是 Worker 生产代码。
// ---------------------------------------------------------------------------

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { applyMigrations, seedQaFixtures } from "./seed-qa-local.mjs";

const ROOT = process.cwd();
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
const LOG_FILE = join(ROOT, ".wrangler", "qa-local-wrangler.log");

const TARGETS = {
  plugins: join(ROOT, "scripts", "plugins-qa.mjs"),
  continuity: join(ROOT, "scripts", "continuity-qa.mjs"),
  devices: join(ROOT, "scripts", "devices-api-qa.mjs"),
  community: join(ROOT, "scripts", "community-qa.mjs"),
};

function baseEnv() {
  return {
    ...process.env,
    TEMP: TMP_DIR,
    TMP: TMP_DIR,
    WRANGLER_SEND_METRICS: "false",
    CI: "true",
  };
}

function ensureDist() {
  if (existsSync(join(ROOT, "dist", "index.html"))) return;
  console.log("[qa-local] dist/ 不存在，先执行 npm run build …");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: baseEnv(),
    shell: process.platform === "win32",
  });
}

async function waitForHealth(base, serverRef) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (serverRef.exited) {
      const tail = readTail(LOG_FILE, 4000);
      throw new Error(`wrangler dev 提前退出（code=${serverRef.code}）。日志片段：\n${tail}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // 尚未就绪，继续轮询。
    }
    await sleep(500);
  }
  throw new Error(`等待 ${base}/api/health 超时（120s）。日志：${LOG_FILE}`);
}

function readTail(file, maxChars) {
  try {
    const text = readFileSync(file, "utf8");
    return text.slice(-maxChars);
  } catch {
    return "(无日志)";
  }
}

function killServer(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // 进程可能已自行退出。
  }
}

async function main() {
  const targetName = process.argv[2];
  const targetScript = TARGETS[targetName];
  if (!targetScript) {
    console.error(`[qa-local] 未知目标：${targetName ?? "(空)"}；可用：plugins | continuity | devices | community`);
    process.exitCode = 2;
    return;
  }

  const port = Number(process.env.QA_PORT || 8794);
  const base = `http://127.0.0.1:${port}`;

  mkdirSync(TMP_DIR, { recursive: true });
  ensureDist();

  console.log("[qa-local] 应用本地迁移并写入 QA 夹具 …");
  applyMigrations();
  const seed = seedQaFixtures();
  console.log(`[qa-local] 夹具：admin=${seed.adminId}，设备 ${seed.devices}，会话 ${seed.sessions}`);

  const logFd = openSync(LOG_FILE, "w");
  console.log(`[qa-local] 启动 wrangler dev --local（${base}）…`);
  // community 需要 --test-scheduled 才能用 POST /__scheduled 触发维护任务清理 R2 孤儿。
  const devArgs = ["dev", "--local", "--port", String(port)];
  if (targetName === "community") devArgs.push("--test-scheduled");
  const server = spawn(process.execPath, [WRANGLER, ...devArgs], {
    cwd: ROOT,
    env: baseEnv(),
    stdio: ["ignore", logFd, logFd],
  });
  const serverRef = { exited: false, code: null };
  server.on("exit", (code) => {
    serverRef.exited = true;
    serverRef.code = code;
  });

  let child = null;
  let childCode = 1;
  try {
    await waitForHealth(base, serverRef);
    console.log("[qa-local] Worker 就绪，运行 QA 脚本 …");
    child = spawn(process.execPath, [targetScript], {
      cwd: ROOT,
      env: { ...baseEnv(), BASE: base, QA_BASE: base, QA_ORIGIN: base },
      stdio: "inherit",
    });
    childCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    killServer(server);
    child?.kill?.();
  }

  console.log(`[qa-local] ${targetName} 退出码：${childCode}（wrangler 日志：${LOG_FILE}）`);
  process.exitCode = childCode;
}

main().catch((error) => {
  console.error("[qa-local] 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});