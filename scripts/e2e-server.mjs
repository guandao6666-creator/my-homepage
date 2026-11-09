#!/usr/bin/env node
/**
 * Guandao OS 2.2 · Phase 3 E2E 服务端夹具
 *
 * 为什么需要它：
 *   现有的 Playwright 只跑 `dist/` 静态产物（scripts/serve-dist.mjs），**从不启动 Worker**。
 *   结果就是：CSP 响应头、插件上传/审核/下载、安装验签、设备配对、接力、OAuth 回调，
 *   在自动化测试里从来没有被真实执行过一次。
 *
 * 这个脚本补上那一层：
 *   1. 把迁移应用到**本地** D1（.wrangler/state，永远不碰线上）；
 *   2. 直插 qa-* 测试用户 / Session / 设备 / 发布者公钥（不经过 GitHub OAuth）；
 *   3. 启动 `wrangler dev --local`，同时提供 Worker API 与 dist 静态资源与真实安全响应头；
 *   4. 等 /api/health 就绪后，用**真实 API** 创建插件、上传签名包、审核通过，
 *      并把夹具写进 .wrangler/e2e-fixtures.json 供测试读取；
 *   5. 常驻，直到 Playwright 结束进程。
 *
 * 安全边界：
 *   - 只用 `--local`；不读取任何生产凭据；不写线上 D1 / R2；
 *   - 私钥只存在于本进程内存，签完即丢，不落盘、不入库、不进日志；
 *   - 数据全部以 `qa-` 前缀标识，重复运行前会先清掉上一次的。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  base64urlEncode,
  buildSignatureEnvelope,
  bundleDigests,
  keyIdForPublicKey,
  registerProofPayloadText,
  signEd25519,
  signaturePayloadBytes,
} from "../shared/plugin-signature.js";

const ROOT = process.cwd();
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const PORT = Number(process.env.E2E_API_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;
// 仅本地夹具管理端口：给 Playwright 一个重新播种过期配对夹具的入口（见 startAdminServer）。
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT || PORT + 1);
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const DB = "guandao-db";
const FIXTURE_FILE = join(ROOT, ".wrangler", "e2e-fixtures.json");

const log = (message) => console.log(`[e2e-server] ${message}`);

// workerd 在本机沙箱里无法在系统临时目录创建 miniflare-email-store，
// 把 TEMP/TMP 指到工作区内（与 scripts/sync-qa.mjs 的处理方式一致）。
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
fs.mkdirSync(TMP_DIR, { recursive: true });

const WRANGLER_ENV = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
  TEMP: TMP_DIR,
  TMP: TMP_DIR,
};

/* ------------------------------------------------------------------ */
/* 本地 D1                                                             */
/* ------------------------------------------------------------------ */

function d1(sql) {
  execFileSync(process.execPath, [WRANGLER, "d1", "execute", DB, "--local", "--command", sql], {
    stdio: "ignore",
    env: WRANGLER_ENV,
  });
}

function d1Json(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DB, "--local", "--json", "--command", sql],
    { env: WRANGLER_ENV, encoding: "utf8" },
  );
  const start = out.indexOf("[");
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  return Array.isArray(parsed) ? parsed[0]?.results ?? [] : [];
}

function applyMigrations() {
  log("应用本地迁移…");
  execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", DB, "--local"], {
    stdio: "ignore",
    env: WRANGLER_ENV,
  });
}

const TOKENS = {
  developer: randomBytes(32).toString("base64url"),
  installer: randomBytes(32).toString("base64url"),
  // 同一账号（qa-p3-installer）的第二台已登录设备：验证只有发起配对的设备能批准。
  installer2: randomBytes(32).toString("base64url"),
  admin: randomBytes(32).toString("base64url"),
  outsider: randomBytes(32).toString("base64url"),
  // 已占满 MAX_DEVICES=10 的账号：验证 DEVICE_LIMIT 分支。
  crowded: randomBytes(32).toString("base64url"),
};

const USER_IDS = {
  developer: "qa-p3-developer",
  installer: "qa-p3-installer",
  admin: "qa-p3-admin",
  outsider: "qa-p3-outsider",
  crowded: "qa-p3-crowded",
};

/**
 * 预置两条**已过期**的配对会话（直插本地 D1，不经过配对 API）：
 *   pending：6 位码 / token 都已过期 → claim 只能得到 404（实现不区分「不存在」与「已过期」）；
 *   claimed：新设备已认领、旧设备还没批准但已过期 → 轮询与确认都必须 410 PAIRING_EXPIRED。
 * 设备 E2E 在**任何 create 之前**使用它们：create 会顺带 expirePairings，把 claimed 翻成 expired。
 */
const EXPIRED_PAIRINGS = {
  pending: {
    id: "qa-p3-expired-pending",
    code: "482913",
    token: randomBytes(24).toString("base64url"),
  },
  claimed: {
    id: "qa-p3-expired-claimed",
    token: randomBytes(24).toString("base64url"),
    claimSecret: randomBytes(32).toString("base64url"),
  },
};

const FIXTURES = {
  baseUrl: BASE,
  adminUrl: ADMIN_BASE,
  generatedAt: Date.now(),
  stage: "booting",
  tokens: TOKENS,
  users: USER_IDS,
  expiredPairing: EXPIRED_PAIRINGS,
  plugins: {},
  keys: {},
};

/**
 * 分两阶段写夹具文件：accounts（账号与 Worker 就绪）→ complete（插件夹具齐了）。
 * 设备 / OAuth 测试只等 accounts；插件签名测试等 complete。
 */
function writeFixtures(stage) {
  FIXTURES.stage = stage;
  FIXTURES.generatedAt = Date.now();
  fs.mkdirSync(join(ROOT, ".wrangler"), { recursive: true });
  fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify(FIXTURES, null, 2)}\n`);
  log(`夹具已写入（stage=${stage}）${FIXTURE_FILE}`);
}

function sha256HexSync(text) {
  return createHash("sha256").update(text).digest("hex");
}

function seedAccounts() {
  log("写入 qa-* 账号与 Session…");
  const now = Date.now();
  const expires = now + 6 * 60 * 60 * 1000;
  const rows = Object.entries(USER_IDS)
    .map(([role, id], index) => {
      const github = 920000001 + index;
      const token = TOKENS[role];
      // crowded 账号预置 MAX_DEVICES(10) 台设备，用来验证第 11 台被 DEVICE_LIMIT 拒绝。
      const deviceCount = role === "crowded" ? 10 : 1;
      const deviceIds = Array.from({ length: deviceCount }, (_, seat) =>
        deviceCount === 1 ? `${id}-device` : `${id}-device-${seat}`,
      );
      const deviceRows = deviceIds
        .map(
          (deviceId, seat) => `
        INSERT OR REPLACE INTO devices (id, user_id, name, device_type, browser_name, os_name, user_agent,
          trusted_at, status, revoked_at, created_at, last_seen_at, last_active_at, last_sync_at)
        VALUES ('${deviceId}', '${id}', 'QA ${role} 设备${deviceCount === 1 ? "" : ` ${seat + 1}`}', 'desktop', 'Chrome', 'Windows', 'e2e-fixtures',
          ${now}, 'active', NULL, ${now}, ${now}, ${now}, NULL);`,
        )
        .join("");
      return `
        INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at,
          github_id, github_username, avatar_url, role, last_login_at)
        VALUES ('${id}', '${id}@example.test', 'QA ${role}', 'active', ${now}, ${now},
          ${github}, '${id}', NULL, '${role === "admin" ? "admin" : "member"}', ${now});
        ${deviceRows}
        INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
        VALUES ('${id}-session', '${id}', '${sha256HexSync(token)}', '${deviceIds[0]}', 'e2e-fixtures', ${expires}, ${now}, ${now});
      `;
    })
    .join("\n");

  // 同一账号（qa-p3-installer）的第二台已登录设备：验证只有发起配对的设备能批准（WRONG_DEVICE）。
  d1(`${rows}
      INSERT OR REPLACE INTO devices (id, user_id, name, device_type, browser_name, os_name, user_agent,
        trusted_at, status, revoked_at, created_at, last_seen_at, last_active_at, last_sync_at)
      VALUES ('qa-p3-installer-device-2', 'qa-p3-installer', 'QA installer 第二设备', 'desktop', 'Chrome', 'Windows', 'e2e-fixtures',
        ${now}, 'active', NULL, ${now}, ${now}, ${now}, NULL);
      INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
      VALUES ('qa-p3-installer-session-2', 'qa-p3-installer', '${sha256HexSync(TOKENS.installer2)}', 'qa-p3-installer-device-2',
        'e2e-fixtures', ${expires}, ${now}, ${now});
  `);
}

/**
 * 直插两条已过期配对（不经过配对 API）：
 *   pending —— 6 位码与 token 都已过期，claim 只能得到 404（实现不区分「不存在」与「已过期」）；
 *   claimed —— 新设备已认领、旧设备还没批准但已过期，轮询与确认都必须 410 PAIRING_EXPIRED。
 * 设备 E2E 必须在**任何 create 之前**使用它们：create 会顺带 expirePairings，把 claimed 翻成 expired。
 */
// 每次 reset 后更新时间戳，保证夹具始终是「已过期」而不是未来时间。
function seedExpiredPairings() {
  log("写入已过期配对夹具…");
  const now = Date.now();
  const createdAt = now - 30 * 60 * 1000;
  const expiresAt = now - 60 * 1000;
  const pending = EXPIRED_PAIRINGS.pending;
  const claimed = EXPIRED_PAIRINGS.claimed;
  d1(`
    INSERT OR REPLACE INTO device_pairings (id, user_id, source_device_id, target_device_id, token_hash, code_hash,
      claim_secret_hash, status, attempts, max_attempts, target_name, target_type, target_browser, target_os,
      target_user_agent, expires_at, created_at, claimed_at, confirmed_at, completed_at, cancelled_at)
    VALUES
      ('${pending.id}', 'qa-p3-installer', 'qa-p3-installer-device', NULL,
        '${sha256HexSync(pending.token)}', '${sha256HexSync(`code:${pending.code}`)}', NULL,
        'pending', 0, 5, NULL, NULL, NULL, NULL, NULL,
        ${expiresAt}, ${createdAt}, NULL, NULL, NULL, NULL),
      ('${claimed.id}', 'qa-p3-installer', 'qa-p3-installer-device', 'qa-p3-expired-claimed-target',
        '${sha256HexSync(claimed.token)}', '${sha256HexSync("code:999999")}', '${sha256HexSync(claimed.claimSecret)}',
        'claimed', 1, 5, 'QA 过期 claim 设备', 'mobile', 'Chrome', 'Android', 'e2e-fixtures',
        ${expiresAt}, ${createdAt}, ${createdAt + 60 * 1000}, NULL, NULL, NULL);
  `);
}

/**
 * 仅本地测试辅助服务器：让 Playwright 能重新播种过期配对夹具。
 *
 * 为什么需要：配对接口在 create 时会顺带 expirePairings()，把夹具里 status='claimed'
 * 的行翻成 'expired'。于是同一进程内第二次跑设备 E2E 时，confirm 会先撞
 * 409 PAIRING_STATE，而不是期望的 410 PAIRING_EXPIRED。
 *
 * 安全边界：只监听 127.0.0.1、只做夹具播种、只在 scripts/e2e-server.mjs（本地测试脚本）
 * 里存在；它不是 Worker 代码，不会进入生产构建，也不接受任何外部输入。
 */
function startAdminServer() {
  const server = createServer((request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`${JSON.stringify(payload)}\n`);
    };
    // Playwright 的 webServer 就绪探针指向这里（见 playwright.config.ts）。
    // 本函数只在夹具全部生成完毕后启动监听，所以「能连上」等同于「夹具已就绪」——
    // 这样可以避免测试在 buildFixtures() 仍在 wrangler d1 execute 时就开始跑，
    // 与夹具写入抢同一个本地 D1（曾导致 SQLITE_BUSY 夹具生成失败、服务退出）。
    if (request.method === "GET" && request.url === "/__e2e/ready") {
      send(200, { ok: true, ready: true });
      return;
    }
    if (request.method === "POST" && request.url === "/__e2e/reset-expired") {
      try {
        seedExpiredPairings();
        send(200, {
          ok: true,
          ids: [EXPIRED_PAIRINGS.pending.id, EXPIRED_PAIRINGS.claimed.id],
        });
      } catch (error) {
        send(500, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }
    send(404, { ok: false, error: "not_found" });
  });
  server.listen(ADMIN_PORT, "127.0.0.1", () => log(`本地夹具管理端点：${ADMIN_BASE}`));
  return server;
}

function resetFixtureRows() {
  // 只清 qa-* 前缀的行；本地库，不会影响任何真实数据。
  try {
    d1(`
      DELETE FROM plugin_versions WHERE plugin_id LIKE 'com.qa.%';
      DELETE FROM plugin_reviews WHERE plugin_id LIKE 'com.qa.%';
      DELETE FROM plugin_permissions WHERE plugin_id LIKE 'com.qa.%';
      DELETE FROM plugin_installations WHERE plugin_id LIKE 'com.qa.%';
      DELETE FROM plugin_audit_logs WHERE plugin_id LIKE 'com.qa.%';
      DELETE FROM plugins WHERE id LIKE 'com.qa.%';
      DELETE FROM publisher_keys WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM developer_profiles WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM continuity_items WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM clipboard_items WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM device_contexts WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM device_pairings WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM device_activity WHERE device_id IN (SELECT id FROM devices WHERE user_id LIKE 'qa-p3-%');
      DELETE FROM device_sync_state WHERE device_id IN (SELECT id FROM devices WHERE user_id LIKE 'qa-p3-%');
      DELETE FROM sessions WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM devices WHERE user_id LIKE 'qa-p3-%';
      DELETE FROM users WHERE id LIKE 'qa-p3-%';
      DELETE FROM rate_limits;
    `);
  } catch (error) {
    log(`清理旧夹具失败（本地数据，可忽略）：${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body, token = TOKENS.developer, expectRaw = false } = {}) {
  const headers = { accept: "application/json", origin: BASE };
  if (token) headers.cookie = `gauth_sid=${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (expectRaw) return { status: response.status, headers: response.headers, response };
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload, headers: response.headers };
}

function unwrap(result) {
  return result.payload?.data ?? result.payload ?? null;
}

async function waitForWorker(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { headers: { accept: "application/json" } });
      if (response.status === 200 || response.status === 503) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(1000);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 签名材料（只在内存里，不落盘）                                        */
/* ------------------------------------------------------------------ */

async function makeKeyPair(label, userId) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = base64urlEncode(raw);
  const keyId = await keyIdForPublicKey(raw);
  const issuedAt = Date.now();
  const payload = new TextEncoder().encode(registerProofPayloadText({ userId, keyId, publicKey, issuedAt }));
  const proof = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payload));
  return {
    label,
    privateKey: pair.privateKey,
    publicKey,
    keyId,
    issuedAt,
    proof: base64urlEncode(proof),
  };
}

function manifest(overrides) {
  return {
    manifestVersion: 1,
    name: "QA 插件",
    type: "application",
    description: "Phase 3 E2E 夹具插件，用于验证签名链路",
    author: { name: "QA Publisher" },
    entry: "index.html",
    compatibility: { sdkVersion: 1, minimumOSVersion: "1.7.0" },
    permissions: [],
    ...overrides,
  };
}

function packageBundle(pluginManifest) {
  const files = [
    { path: "index.html", encoding: "utf8", content: `<h1>${pluginManifest.id}</h1>` },
    { path: "manifest.json", encoding: "utf8", content: JSON.stringify(pluginManifest) },
  ];
  return { files };
}

async function signedBundle(key, pluginId, version, overrides = {}) {
  const { signature: signatureOverrides, ...manifestOverrides } = overrides;
  const pluginManifest = manifest({ id: pluginId, version, ...manifestOverrides });
  const { files } = packageBundle(pluginManifest);
  const digests = await bundleDigests({ manifest: pluginManifest }, files);
  const envelope = buildSignatureEnvelope({
    keyId: key.keyId,
    publisherId: USER_IDS.developer,
    pluginId,
    version,
    filesDigest: digests.filesDigest,
    manifestDigest: digests.manifestDigest,
    ...signatureOverrides,
  });
  const sig = await signEd25519(key.privateKey, signaturePayloadBytes(envelope));
  const bundle = {
    format: "guandao-plugin",
    formatVersion: 1,
    manifest: pluginManifest,
    files,
    filesDigest: digests.filesDigest,
  };
  return { bundle, signature: { ...envelope, sig: base64urlEncode(sig) } };
}

async function unsignedBundle(pluginId, version) {
  const pluginManifest = manifest({ id: pluginId, version });
  const { files } = packageBundle(pluginManifest);
  const digests = await bundleDigests({ manifest: pluginManifest }, files);
  return {
    bundle: {
      format: "guandao-plugin",
      formatVersion: 1,
      manifest: pluginManifest,
      files,
      filesDigest: digests.filesDigest,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 夹具编排                                                             */
/* ------------------------------------------------------------------ */

async function createPlugin(id, name) {
  const result = await api("/api/developer/plugins", {
    method: "POST",
    body: { id, name, type: "application", category: "productivity", license: "MIT", description: "Phase 3 E2E 夹具" },
  });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`createPlugin ${id} 失败：${result.status} ${JSON.stringify(result.payload)}`);
  }
}

async function uploadVersion(id, bundle, signature) {
  const body = { bundle: JSON.stringify(bundle), changelog: "E2E 夹具版本" };
  if (signature) body.signature = signature;
  return api(`/api/developer/plugins/${id}/versions`, { method: "POST", body });
}

async function approve(pluginId, version) {
  return api(`/api/plugins/admin/${pluginId}/review`, {
    method: "POST",
    token: TOKENS.admin,
    body: { decision: "approve", version },
  });
}

async function publish(pluginId) {
  // submitForReview 把 draft 推进到 pending_review；审核通过后插件即可见。
  const submitted = await api(`/api/developer/plugins/${pluginId}/submit`, { method: "POST" });
  if (submitted.status !== 200) {
    throw new Error(`submit ${pluginId} 失败：${submitted.status} ${JSON.stringify(submitted.payload)}`);
  }
}

async function buildFixtures() {
  const fixtures = FIXTURES;
  log("生成 Ed25519 发布者密钥（仅内存）…");
  const primaryKey = await makeKeyPair("qa-primary", USER_IDS.developer);
  const revokedKey = await makeKeyPair("qa-revoked", USER_IDS.developer);

  // 1) 登记两把公钥（证明持有私钥）
  for (const key of [primaryKey, revokedKey]) {
    const registered = await api("/api/developer/keys", {
      method: "POST",
      body: {
        publicKey: key.publicKey,
        keyId: key.keyId,
        issuedAt: key.issuedAt,
        proof: key.proof,
        label: key.label,
      },
    });
    if (registered.status !== 200) {
      throw new Error(`登记公钥 ${key.keyId} 失败：${registered.status} ${JSON.stringify(registered.payload)}`);
    }
  }
  fixtures.keys.primary = primaryKey.keyId;
  fixtures.keys.revoked = revokedKey.keyId;

  // 2) com.qa.signed —— 正确签名、审核通过
  {
    const id = "com.qa.signed";
    await createPlugin(id, "QA 已签名插件");
    const { bundle, signature } = await signedBundle(primaryKey, id, "1.0.0");
    const uploaded = await uploadVersion(id, bundle, signature);
    if (uploaded.status !== 200) throw new Error(`上传已签名版本失败：${uploaded.status} ${JSON.stringify(uploaded.payload)}`);
    await publish(id);
    await approve(id, "1.0.0");
    fixtures.plugins.signed = { id, version: "1.0.0" };
  }

  // 3) com.qa.unsigned —— 旧式无签名包（阶段 A 兼容）
  {
    const id = "com.qa.unsigned";
    await createPlugin(id, "QA 未签名插件");
    const { bundle } = await unsignedBundle(id, "1.0.0");
    const uploaded = await uploadVersion(id, bundle);
    if (uploaded.status !== 200) throw new Error(`上传未签名版本失败：${uploaded.status} ${JSON.stringify(uploaded.payload)}`);
    await publish(id);
    await approve(id, "1.0.0");
    fixtures.plugins.unsigned = { id, version: "1.0.0" };
  }

  // 4) com.qa.tampered —— 包本身完好，但签名是对另一份文件算的
  {
    const id = "com.qa.tampered";
    await createPlugin(id, "QA 被篡改签名插件");
    const { bundle, signature } = await signedBundle(primaryKey, id, "1.0.0");
    const uploaded = await uploadVersion(id, bundle, signature);
    if (uploaded.status !== 200) throw new Error(`上传篡改夹具失败：${uploaded.status}`);
    await publish(id);
    await approve(id, "1.0.0");
    // 换成一个「结构合法、密钥正确、但摘要对应另一份包」的签名信封
    const other = await signedBundle(primaryKey, id, "1.0.0", {
      description: "different content for digest mismatch",
    });
    const escaped = JSON.stringify(other.signature).replace(/'/g, "''");
    d1(`UPDATE plugin_versions SET signature_json = '${escaped}' WHERE plugin_id = '${id}' AND version = '1.0.0';`);
    fixtures.plugins.tampered = { id, version: "1.0.0" };
  }

  // 5) com.qa.revoked —— 签名有效，但随后公钥被撤销
  {
    const id = "com.qa.revoked";
    await createPlugin(id, "QA 已撤销密钥插件");
    const { bundle, signature } = await signedBundle(revokedKey, id, "1.0.0");
    const uploaded = await uploadVersion(id, bundle, signature);
    if (uploaded.status !== 200) throw new Error(`上传撤销夹具失败：${uploaded.status} ${JSON.stringify(uploaded.payload)}`);
    await publish(id);
    await approve(id, "1.0.0");
    const revoked = await api(`/api/developer/keys/${revokedKey.keyId}/revoke`, {
      method: "POST",
      body: { reason: "E2E 夹具：模拟私钥泄露" },
    });
    if (revoked.status !== 200) throw new Error(`撤销公钥失败：${revoked.status} ${JSON.stringify(revoked.payload)}`);
    fixtures.plugins.revoked = { id, version: "1.0.0" };
  }

  // 6) com.qa.integrity —— 摘要记录被改，模拟包被替换
  {
    const id = "com.qa.integrity";
    await createPlugin(id, "QA 完整性夹具");
    const { bundle, signature } = await signedBundle(primaryKey, id, "1.0.0");
    const uploaded = await uploadVersion(id, bundle, signature);
    if (uploaded.status !== 200) throw new Error(`上传完整性夹具失败：${uploaded.status}`);
    await publish(id);
    await approve(id, "1.0.0");
    d1(
      `UPDATE plugin_versions SET package_sha256 = '${"0".repeat(64)}' WHERE plugin_id = '${id}' AND version = '1.0.0';`,
    );
    fixtures.plugins.integrity = { id, version: "1.0.0" };
  }

  // 7) 签名被替换（结构合法但签名对不上）+ 算法不受支持 + 他人公钥
  {
    const id = "com.qa.badsig";
    await createPlugin(id, "QA 坏签名插件");
    const { bundle, signature } = await signedBundle(primaryKey, id, "1.0.0");
    await uploadVersion(id, bundle, signature);
    await publish(id);
    await approve(id, "1.0.0");
    // 保留信封结构，只把 sig 换成 64 字节随机值：签名验证必然失败
    const broken = { ...signature, sig: base64urlEncode(crypto.getRandomValues(new Uint8Array(64))) };
    d1(
      `UPDATE plugin_versions SET signature_json = '${JSON.stringify(broken).replace(/'/g, "''")}' WHERE plugin_id = '${id}' AND version = '1.0.0';`,
    );
    fixtures.plugins.badsig = { id, version: "1.0.0" };
  }

  {
    const id = "com.qa.alg";
    await createPlugin(id, "QA 算法不支持插件");
    const { bundle, signature } = await signedBundle(primaryKey, id, "1.0.0");
    await uploadVersion(id, bundle, signature);
    await publish(id);
    await approve(id, "1.0.0");
    const weakened = { ...signature, alg: "rsa2048" };
    d1(
      `UPDATE plugin_versions SET signature_json = '${JSON.stringify(weakened).replace(/'/g, "''")}' WHERE plugin_id = '${id}' AND version = '1.0.0';`,
    );
    fixtures.plugins.alg = { id, version: "1.0.0" };
  }

  {
    // 他人公钥：先用 outsider 账号登记一把公钥，再把它的签名塞进 developer 的版本行
    const outsiderKey = await makeKeyPair("qa-outsider", USER_IDS.outsider);
    const registered = await api("/api/developer/keys", {
      method: "POST",
      token: TOKENS.outsider,
      body: {
        publicKey: outsiderKey.publicKey,
        keyId: outsiderKey.keyId,
        issuedAt: outsiderKey.issuedAt,
        proof: outsiderKey.proof,
        label: outsiderKey.label,
      },
    });
    if (registered.status !== 200) {
      throw new Error(`登记他人公钥失败：${registered.status} ${JSON.stringify(registered.payload)}`);
    }
    const id = "com.qa.foreign";
    await createPlugin(id, "QA 冒用公钥插件");
    const unsigned = await unsignedBundle(id, "1.0.0");
    await uploadVersion(id, unsigned.bundle);
    await publish(id);
    await approve(id, "1.0.0");
    const forged = await signedBundle(outsiderKey, id, "1.0.0", {
      signature: { publisherId: USER_IDS.developer },
    });
    d1(
      `UPDATE plugin_versions SET signature_json = '${JSON.stringify(forged.signature).replace(/'/g, "''")}',
         signature_key_id = '${outsiderKey.keyId}', signature_status = 'verified'
       WHERE plugin_id = '${id}' AND version = '1.0.0';`,
    );
    fixtures.keys.outsider = outsiderKey.keyId;
    fixtures.plugins.foreign = { id, version: "1.0.0" };
  }

  // 8) 版本降级 + 重复发布：都用 com.qa.signed 触发
  {
    const id = "com.qa.signed";
    const older = await signedBundle(primaryKey, id, "0.9.0");
    const downgrade = await uploadVersion(id, older.bundle, older.signature);
    fixtures.expect = fixtures.expect ?? {};
    fixtures.expect.downgrade = { status: downgrade.status, code: downgrade.payload?.error?.code ?? null };

    const same = await signedBundle(primaryKey, id, "1.0.0");
    const duplicate = await uploadVersion(id, same.bundle, same.signature);
    fixtures.expect.duplicate = { status: duplicate.status, code: duplicate.payload?.error?.code ?? null };
  }

  // 8) 记录「签名缺失」的上传响应（服务端应明确标 unsigned，而不是拒绝）
  {
    const id = "com.qa.unsigned";
    fixtures.expect.unsignedTrust = (await api(`/api/plugins/${id}/package?version=1.0.0`)).payload?.data?.signature ?? null;
  }

  return fixtures;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let child = null;

function stop() {
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
  child = null;
}

async function main() {
  applyMigrations();
  resetFixtureRows();
  seedAccounts();
  seedExpiredPairings();

  log(`启动 wrangler dev --local（:${PORT}）…`);
  // Phase 3.4：OAuth 测试模式开关只注入到本地 e2e 的 wrangler dev 进程，
  // 不写 wrangler.jsonc（避免污染生产配置），也不进入任何部署产物。
  // worker/api/auth/config.js 仍要求「env=1 且请求 origin 与站点 origin 都是 loopback」
  // 才真正生效，生产部署不设置该变量、生产域名也不是 loopback。
  child = spawn(
    process.execPath,
    [WRANGLER, "dev", "--local", "--port", String(PORT), "--var", "AUTH_TEST_MODE:1"],
    {
      stdio: "ignore",
      env: WRANGLER_ENV,
    },
  );

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
  process.on("exit", stop);

  const ready = await waitForWorker();
  if (!ready) {
    log("Worker 启动超时");
    stop();
    process.exit(1);
  }
  log("Worker 就绪，先发布账号夹具（accounts）…");
  writeFixtures("accounts");

  try {
    await buildFixtures();
  } catch (error) {
    log(`夹具生成失败：${error?.stack ?? error}`);
    stop();
    process.exit(1);
  }

  writeFixtures("complete");
  // 夹具全部写完后才开管理端口：Playwright 用 GET /__e2e/ready 作为就绪信号，
  // 端口可连即代表 buildFixtures() 已结束，测试不会与夹具写入抢同一个本地 D1。
  startAdminServer();
  log(`E2E API 服务就绪：${BASE}`);
  // 常驻：Playwright 会在结束时杀掉本进程。
  await new Promise(() => {});
}

main().catch((error) => {
  log(`致命错误：${error?.stack ?? error}`);
  stop();
  process.exit(1);
});