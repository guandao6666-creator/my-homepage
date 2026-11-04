/** D1 访问层：所有 SQL 都使用绑定参数，不接受字符串拼接。 */

import { randomToken, sha256Hex, nowMs } from "./crypto.js";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
export const SETUP_TTL_MS = 10 * 60 * 1000;

export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    githubUsername: row.github_username,
    displayName: row.display_name || row.github_username,
    avatarUrl: row.avatar_url,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function findUserByGithubId(env, githubId) {
  return env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first();
}

export async function findUserById(env, id) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function countAdmins(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").first();
  return Number(row?.total ?? 0);
}

export function noreplyEmail(githubId, login) {
  return `${githubId}+${login}@users.noreply.github.com`;
}

/**
 * 新建用户。role=admin 时由 idx_users_single_admin 保证只有一个管理员，
 * 并发初始化会抛唯一约束，由上层转成 409。
 */
export async function insertUser(env, { id, githubId, login, displayName, avatarUrl, role }) {
  const now = nowMs();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, status, created_at, updated_at,
                        github_id, github_username, avatar_url, role, last_login_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, noreplyEmail(githubId, login), displayName, now, now, githubId, login, avatarUrl, role, now)
    .run();
}

/** 初始化时如果 GitHub 身份已存在（例如早前以 member 写入），提升为 admin。 */
export async function promoteToAdmin(env, userId, { login, displayName, avatarUrl }) {
  const now = nowMs();
  await env.DB.prepare(
    `UPDATE users
        SET role = 'admin', github_username = ?, display_name = ?, avatar_url = ?,
            updated_at = ?, last_login_at = ?
      WHERE id = ?`,
  )
    .bind(login, displayName, avatarUrl, now, now, userId)
    .run();
}

export async function updateDisplayName(env, userId, displayName) {
  await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
    .bind(displayName, nowMs(), userId)
    .run();
}

export async function touchUserLogin(env, userId) {
  await env.DB.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowMs(), nowMs(), userId)
    .run();
}

/* ------------------------------------------------------------------ */
/* OAuth state                                                         */
/* ------------------------------------------------------------------ */

export async function createOAuthState(env, { intent, verifier }) {
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const now = nowMs();

  await env.DB.prepare(
    `INSERT INTO oauth_states (id, state_hash, code_verifier, intent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), stateHash, verifier, intent, now + STATE_TTL_MS, now)
    .run();

  // 顺手清理过期记录，避免表无限增长。
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now - 86_400_000).run();

  return state;
}

export async function getOAuthState(env, state) {
  const hash = await sha256Hex(state);
  return env.DB.prepare(
    `SELECT * FROM oauth_states
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(hash, nowMs())
    .first();
}

export async function consumeOAuthState(env, id) {
  const result = await env.DB.prepare(
    "UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
  )
    .bind(nowMs(), id)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/* ------------------------------------------------------------------ */
/* Setup ticket（首次管理员初始化）                                     */
/* ------------------------------------------------------------------ */

export async function createSetupTicket(env, profile) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowMs();

  await env.DB.prepare("DELETE FROM setup_tickets WHERE github_id = ? AND consumed_at IS NULL")
    .bind(profile.id)
    .run();

  await env.DB.prepare(
    `INSERT INTO setup_tickets (id, token_hash, github_id, github_username, display_name, avatar_url, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      tokenHash,
      profile.id,
      profile.login,
      profile.name,
      profile.avatarUrl,
      now + SETUP_TTL_MS,
      now,
    )
    .run();

  return token;
}

export async function getSetupTicket(env, token) {
  const hash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT * FROM setup_tickets
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(hash, nowMs())
    .first();
}

export async function consumeSetupTicket(env, id) {
  await env.DB.prepare("UPDATE setup_tickets SET consumed_at = ? WHERE id = ?")
    .bind(nowMs(), id)
    .run();
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function createSessionRow(env, { userId, tokenHash, deviceId, userAgent }) {
  const now = nowMs();
  const expiresAt = now + SESSION_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, tokenHash, deviceId, userAgent, expiresAt, now, now)
    .run();

  return { expiresAt, createdAt: now };
}

export async function findSessionByTokenHash(env, tokenHash) {
  return env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.device_id, s.expires_at AS session_expires_at,
            s.created_at AS session_created_at, s.last_used_at,
            u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
}

export async function touchSession(env, sessionId) {
  await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
    .bind(nowMs(), sessionId)
    .run();
}

export async function deleteSession(env, sessionId) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function deleteSessionByHash(env, tokenHash) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function listSessions(env, userId, currentSessionId) {
  const rows = await env.DB.prepare(
    `SELECT id, device_id, user_agent, expires_at, created_at, last_used_at
       FROM sessions
      WHERE user_id = ? AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 20`,
  )
    .bind(userId, nowMs())
    .all();

  return (rows.results || []).map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    userAgent: row.user_agent,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    current: row.id === currentSessionId,
  }));
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export async function upsertDevice(env, { deviceId, userId, name, platform }) {
  const now = nowMs();
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       user_id = excluded.user_id,
       name = excluded.name,
       platform = excluded.platform,
       last_seen_at = excluded.last_seen_at,
       revoked_at = NULL`,
  )
    .bind(deviceId, userId, name, platform, now, now)
    .run();
}

export function purgeExpired(env) {
  const cutoff = nowMs();
  return env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(cutoff - 86_400_000),
    env.DB.prepare("DELETE FROM setup_tickets WHERE expires_at < ?").bind(cutoff - 86_400_000),
  ]);
}
