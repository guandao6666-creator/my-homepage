/**
 * 设备配对 · 数据访问层
 *
 * 安全约束：
 *   * token / 配对码 / claim secret 只存 SHA-256 哈希，原始值只在创建响应里出现一次；
 *   * 配对会话与 user_id 绑定，确认时必须同时匹配 user_id 与 source_device_id；
 *   * 配对码只用于「找到待配对会话」，真正的身份确认发生在已登录设备上；
 *   * 新设备 Session 在领取时才签发，未领取的 confirmed 会话不会提前产生凭证。
 */

import { randomToken, sha256Hex } from "../auth/crypto.js";
import { DEVICE_TYPES, describeUserAgent } from "../devices/model.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const CLAIM_SECRET_BYTES = 32;
export const MAX_DEVICES = 10;

/** 6 位数字，使用密码学安全随机源；不会出现 000000 之外的格式问题。 */
export function pairingCode() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1_000_000).padStart(6, "0");
}

export async function createPairing(env, { userId, sourceDeviceId }) {
  const now = Date.now();
  const token = randomToken(24);
  const code = pairingCode();
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO device_pairings
       (id, user_id, source_device_id, token_hash, code_hash, status,
        attempts, max_attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?)`,
  )
    .bind(id, userId, sourceDeviceId, await sha256Hex(token), await sha256Hex(`code:${code}`), now + PAIRING_TTL_MS, now)
    .run();

  return { id, token, code, expiresAt: now + PAIRING_TTL_MS };
}

export async function listActivePairings(env, userId, now = Date.now()) {
  const rows = await env.DB.prepare(
    `SELECT p.*, d.name AS source_name, d.device_type AS source_type
       FROM device_pairings p
       LEFT JOIN devices d ON d.id = p.source_device_id AND d.user_id = p.user_id
      WHERE p.user_id = ? AND p.status IN ('pending', 'claimed', 'confirmed')
        AND p.expires_at > ?
      ORDER BY p.created_at DESC LIMIT 10`,
  )
    .bind(userId, now)
    .all();
  return rows.results ?? [];
}

export async function getPairing(env, id) {
  return env.DB.prepare("SELECT * FROM device_pairings WHERE id = ?").bind(id).first();
}

export async function findByIdentity(env, { token, code }, now = Date.now()) {
  if (token) {
    return env.DB.prepare(
      "SELECT * FROM device_pairings WHERE token_hash = ? AND status = 'pending' AND expires_at > ?",
    )
      .bind(await sha256Hex(token), now)
      .first();
  }
  if (code) {
    // 6 位码可能碰撞：只在最近的待配对会话里找，取最新的一条。
    const rows = await env.DB.prepare(
      `SELECT * FROM device_pairings
        WHERE code_hash = ? AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(await sha256Hex(`code:${code}`), now)
      .all();
    return rows.results?.[0] ?? null;
  }
  return null;
}

export async function markClaimed(env, { pairing, request, device }) {
  const now = Date.now();
  const claimSecret = randomToken(CLAIM_SECRET_BYTES);
  const info = describeUserAgent(request.headers.get("user-agent") || "");
  const name = String(device?.name || "").trim().slice(0, 40) || info.name;
  const type = DEVICE_TYPES.includes(device?.type) ? device.type : info.type;

  await env.DB.prepare(
    `UPDATE device_pairings
        SET status = 'claimed', claim_secret_hash = ?, claimed_at = ?,
            target_name = ?, target_type = ?, target_browser = ?, target_os = ?,
            target_user_agent = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'pending'`,
  )
    .bind(
      await sha256Hex(claimSecret),
      now,
      name,
      type,
      info.browser,
      info.os,
      info.userAgent.slice(0, 200),
      pairing.id,
    )
    .run();

  return { claimSecret, device: { name, type, browser: info.browser, os: info.os } };
}

export async function getByClaimSecret(env, { id, secret }) {
  const row = await getPairing(env, id);
  if (!row) return null;
  if (!row.claim_secret_hash) return null;
  if ((await sha256Hex(secret)) !== row.claim_secret_hash) return null;
  return row;
}

/**
 * 旧设备确认配对：在这里真正登记设备记录（不是等到领取 Session）。
 * 新设备记录由服务端生成 UUID，名称/类型仅作展示，可信状态由这次确认写入。
 */
export async function confirmPairing(env, { pairing, userId }) {
  const now = Date.now();
  if (pairing.user_id !== userId) return null;

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM devices WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(userId)
    .first();
  if (Number(count?.total ?? 0) >= MAX_DEVICES) {
    const error = new Error("DEVICE_LIMIT");
    error.code = "DEVICE_LIMIT";
    throw error;
  }

  const deviceId = crypto.randomUUID();
  const type = DEVICE_TYPES.includes(pairing.target_type) ? pairing.target_type : "desktop";
  const name = String(pairing.target_name || "").slice(0, 40) || "Paired Device";

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices
         (id, user_id, name, platform, device_type, browser_name, os_name,
          user_agent, last_seen_at, last_active_at, trusted_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).bind(
      deviceId,
      userId,
      name,
      pairing.target_os || null,
      type,
      pairing.target_browser || null,
      pairing.target_os || null,
      pairing.target_user_agent || null,
      now,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE device_pairings
          SET status = 'confirmed', target_device_id = ?, confirmed_at = ?
        WHERE id = ? AND user_id = ? AND status = 'claimed'`,
    ).bind(deviceId, now, pairing.id, userId),
  ]);

  return { deviceId, name, type };
}

export async function cancelPairing(env, { id, userId, now = Date.now() }) {
  await env.DB.prepare(
    `UPDATE device_pairings
        SET status = 'cancelled', cancelled_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'claimed', 'confirmed')`,
  )
    .bind(now, id, userId)
    .run();
}

export async function expirePairings(env, now = Date.now()) {
  await env.DB.prepare(
    `UPDATE device_pairings SET status = 'expired'
      WHERE status IN ('pending', 'claimed', 'confirmed') AND expires_at <= ?`,
  )
    .bind(now)
    .run();
}

export function publicPairing(row, now = Date.now()) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    sourceDeviceId: row.source_device_id,
    sourceName: row.source_name || "另一台设备",
    sourceType: row.source_type || "desktop",
    targetDeviceId: row.target_device_id || null,
    target: row.status === "pending"
      ? null
      : {
          name: row.target_name || "新设备",
          type: row.target_type || "desktop",
          browser: row.target_browser || "",
          os: row.target_os || "",
        },
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 5,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    expired: Number(row.expires_at) <= now,
  };
}
