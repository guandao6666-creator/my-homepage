#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Guandao OS · 配对 TTL 真实时间验证（scripts/pairing-ttl-check.mjs）
//
// 为什么单独一个脚本：设备配对码的有效期是 10 分钟，普通 E2E 不能等 10 分钟，
// 之前的覆盖用「直接插入已过期行」代替。这里做**一次真实等待**：
//   创建配对 → 第二设备 claim → 真实等待到 expiresAt 之后 → 断言
//   confirm 和轮询都返回 410 PAIRING_EXPIRED、配对码不能再次 claim（404）。
//
// 它自己启动 scripts/e2e-server.mjs（本地 wrangler dev --local + 本地 D1/R2 +
// 真实 HTTP 夹具），结束时关闭；只在本机 127.0.0.1:8788 运行，不接触生产。
//
// 用法：npm run qa:pairing-ttl（约 11 分钟）
// 输出：每步结果 + 实测 elapsedMs / 声明的 ttl，退出码 0 表示全部通过。
// ---------------------------------------------------------------------------

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = process.cwd();
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
const LOG_FILE = join(ROOT, ".wrangler", "pairing-ttl-server.log");
const FIXTURE_FILE = join(ROOT, ".wrangler", "e2e-fixtures.json");
const PORT = Number(process.env.E2E_API_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;

const WRANGLER_ENV = {
  ...process.env,
  TEMP: TMP_DIR,
  TMP: TMP_DIR,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (ok) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function http(path, { method = "GET", token = null, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.cookie = `gauth_sid=${token}`;
  if (method !== "GET") headers.origin = BASE;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { status: response.status, json, text, headers: response.headers };
}

function readFixtures() {
  try {
    if (!existsSync(FIXTURE_FILE)) return null;
    return JSON.parse(readFileSync(FIXTURE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function waitForFixtures(startedAt) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const fixtures = readFixtures();
    // e2e-server 写的是毫秒时间戳（number）；兼容 ISO 字符串写法。
    const rawGenerated = fixtures?.generatedAt;
    const generatedAt =
      typeof rawGenerated === "number" ? rawGenerated : Date.parse(String(rawGenerated ?? ""));
    const fresh = fixtures && Number.isFinite(generatedAt) && generatedAt >= startedAt;
    if (fixtures?.stage === "complete" && fresh) return fixtures;
    await sleep(500);
  }
  throw new Error(`等待 E2E 夹具超时（240s）。服务日志：${LOG_FILE}`);
}

function killServer(child) {
  if (!child) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* 已退出 */
  }
}

async function main() {
  console.log("Guandao OS · 配对 TTL 真实时间验证");
  console.log(`  Worker：${BASE}（本地 wrangler dev --local）`);
  console.log("  说明：会真实等待配对码过期，预计约 11 分钟。\n");

  mkdirSync(TMP_DIR, { recursive: true });
  const startedAt = Date.now() - 2000;
  const logFd = openSync(LOG_FILE, "w");
  const server = spawn(process.execPath, [join(ROOT, "scripts", "e2e-server.mjs")], {
    cwd: ROOT,
    env: WRANGLER_ENV,
    stdio: ["ignore", logFd, logFd],
  });

  let exitCode = 1;
  try {
    const fixtures = await waitForFixtures(startedAt);
    const token = fixtures.tokens.installer;
    check("E2E 夹具就绪", Boolean(token && fixtures.plugins), `generatedAt=${fixtures.generatedAt}`);

    // 记录创建前的设备快照：后面用它证明「过期配对没有偷偷新增设备」。
    const baselineDevices = await http("/api/devices", { token });
    const baselineIds = (baselineDevices.json?.data?.devices ?? [])
      .map((device) => device.id)
      .sort();

    console.log("\n[1] 创建配对并记录声明的 TTL");
    const created = await http("/api/pairing/create", { method: "POST", token });
    const pairing = created.json?.data;
    check("创建配对返回 200", created.status === 200 && Boolean(pairing?.pairingId), created.text.slice(0, 160));
    const now = Date.now();
    const ttl = Number(pairing?.ttl);
    const expiresAt = Number(pairing?.expiresAt);
    check("声明的 TTL 为 600000ms", ttl === 600_000, String(ttl));
    check(
      "expiresAt ≈ 创建时间 + 10 分钟（±10s）",
      Number.isFinite(expiresAt) && Math.abs(expiresAt - (now + 600_000)) <= 10_000,
      `expiresAt-now=${expiresAt - now}ms`,
    );
    check("配对码是 6 位数字", /^\d{6}$/.test(String(pairing?.code)), String(pairing?.code));

    console.log("\n[2] 第二台设备认领（真实 HTTP，无 Cookie）");
    const claim = await http("/api/pairing/claim", {
      method: "POST",
      body: { code: pairing.code, device: { name: "TTL 验证设备", type: "mobile", browser: "Firefox", os: "Android" } },
    });
    const claimed = claim.json?.data;
    check("认领返回 claimed", claim.status === 200 && claimed?.status === "claimed", claim.text.slice(0, 160));
    check("返回 claimSecret", typeof claimed?.claimSecret === "string" && claimed.claimSecret.length >= 32);
    const claimSecret = claimed?.claimSecret;

    console.log("\n[3] 真实等待配对码过期（不修改任何时间戳）…");
    const waitMs = Math.max(0, expiresAt - Date.now()) + 5_000;
    console.log(`  等待 ${Math.round(waitMs / 1000)}s …`);
    await sleep(waitMs);
    const elapsed = Date.now() - now;
    check("真实经过时间 ≥ 10 分钟", elapsed >= 600_000, `elapsedMs=${elapsed}`);

    console.log("\n[4] 过期后的行为");
    const polled = await http(`/api/pairing/claim/${encodeURIComponent(pairing.pairingId)}?secret=${encodeURIComponent(claimSecret)}`);
    check(
      "第二设备轮询返回 410 PAIRING_EXPIRED",
      polled.status === 410 && polled.json?.error?.code === "PAIRING_EXPIRED",
      `${polled.status} ${polled.json?.error?.code ?? ""}`,
    );

    const confirmed = await http(`/api/pairing/${encodeURIComponent(pairing.pairingId)}/confirm`, {
      method: "POST",
      token,
      body: {},
    });
    check(
      "原设备确认返回 410 PAIRING_EXPIRED",
      confirmed.status === 410 && confirmed.json?.error?.code === "PAIRING_EXPIRED",
      `${confirmed.status} ${confirmed.json?.error?.code ?? ""}`,
    );

    const reclaim = await http("/api/pairing/claim", { method: "POST", body: { code: pairing.code } });
    check(
      "过期配对码不能再次认领（404 PAIRING_NOT_FOUND）",
      reclaim.status === 404 && reclaim.json?.error?.code === "PAIRING_NOT_FOUND",
      `${reclaim.status} ${reclaim.json?.error?.code ?? ""}`,
    );

    const devices = await http("/api/devices", { token });
    // 注意：不能用 activeDeviceCount —— 它按「最近在线窗口」计算，等待 10 分钟后
    // 种子设备会被判为 stale。这里用创建前的设备 id 快照比较（种子账号本身有 2 台设备）。
    const deviceIds = (devices.json?.data?.devices ?? [])
      .map((device) => device.id)
      .sort();
    check(
      "过期配对没有新增设备",
      JSON.stringify(deviceIds) === JSON.stringify(baselineIds),
      `before=${JSON.stringify(baselineIds)} after=${JSON.stringify(deviceIds)}`,
    );

    const tail = results.slice(-5);
    console.log(`\n结果：${results.length - failures} 项通过，${failures} 项失败（最近 5 项：${tail.map((item) => (item.ok ? "✓" : "✗")).join("")}）`);
    exitCode = failures === 0 ? 0 : 1;
  } finally {
    killServer(server);
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error("[pairing-ttl] 失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});