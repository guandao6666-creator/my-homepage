/**
 * Guandao OS 1.6 · 社区注册策略
 *
 * 与账号系统的交界处只有这里：
 *   - 注册模式（closed / invite / open）由管理员设置，服务端强制执行；
 *   - 邀请码只保存 SHA-256，注册意图按 OAuth state 哈希短期保存并一次性消费；
 *   - 新用户永远以 member 身份创建，不能通过注册获得管理员权限。
 */

import { sha256Hex } from "../auth/crypto.js";

export const JOIN_TTL_MS = 10 * 60 * 1000;

export async function registrationSettings(env) {
  const row = await env.DB.prepare("SELECT * FROM community_settings WHERE id = 1").first();
  if (!row) return null;
  return {
    mode: row.registration_mode,
    memberLogin: Boolean(row.member_login),
    requireReview: Boolean(row.require_review),
    allowPublishing: Boolean(row.allow_publishing),
    communityName: row.community_name,
  };
}

export async function registrationSummary(env) {
  const settings = await registrationSettings(env);
  const admins = await env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").first();
  return {
    mode: settings?.mode || "closed",
    memberLogin: settings?.memberLogin ?? false,
    joinAvailable: Number(admins?.total || 0) > 0 && Boolean(settings) && settings.mode !== "closed",
    invitationRequired: settings?.mode === "invite",
  };
}

export async function findValidInvite(env, code) {
  const raw = String(code || "").trim();
  if (!/^GD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(raw)) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    `SELECT * FROM community_invites
      WHERE code_hash = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND used_count < max_uses`,
  )
    .bind(hash, Date.now())
    .first();
  return row || null;
}

export async function createJoinIntent(env, { stateHash, mode, inviteId = null }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_join_intents (state_hash, invite_id, mode, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(stateHash, inviteId, mode, now, now + JOIN_TTL_MS)
    .run();
  await env.DB.prepare("DELETE FROM community_join_intents WHERE expires_at < ?").bind(now - 86_400_000).run();
}

export async function getJoinIntent(env, stateHash) {
  return env.DB.prepare(
    `SELECT * FROM community_join_intents
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(stateHash, Date.now())
    .first();
}

export async function consumeJoinIntent(env, stateHash) {
  const result = await env.DB.prepare(
    "UPDATE community_join_intents SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL",
  )
    .bind(Date.now(), stateHash)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** 原子占用一次邀请名额；返回 false 表示名额已用完 / 已作废。 */
export async function useInvite(env, inviteId) {
  if (!inviteId) return true;
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE community_invites
        SET used_count = used_count + 1
      WHERE id = ? AND revoked_at IS NULL AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(inviteId, now)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function releaseInvite(env, inviteId) {
  if (!inviteId) return;
  await env.DB.prepare(
    "UPDATE community_invites SET used_count = MAX(0, used_count - 1) WHERE id = ?",
  )
    .bind(inviteId)
    .run();
}
