/**
 * Guandao OS 2.2 · 插件发布者签名（服务端）
 *
 * 职责边界：
 *   - 公钥登记 / 撤销 / 查询（publisher_keys）
 *   - 上传、下载、安装三条路径上的验签
 *
 * 三条铁律：
 *   1. 服务端**不持有**发布者私钥，也从不生成私钥。只保存公钥与状态。
 *   2. 公钥必须归属插件作者本人（key.user_id === plugin.developer_id），
 *      否则任何人都能拿别人的公钥给自己签个名。
 *   3. 撤销是**动态**的：每次下载/安装都重新读 key.status，
 *      不把「上传时验过了」当成永久通行证。
 */

import { ApiError } from "../http.js";
import {
  SIG_PUBLIC_KEY_BYTES,
  SIG_STATUS,
  base64urlDecode,
  checkRegisterProof,
  keyIdForPublicKey,
  registerProofPayloadText,
  signaturePayloadBytes,
  utf8Bytes,
  validateSignatureEnvelope,
  verifyBundleSignature,
  verifyEd25519,
} from "../../../shared/plugin-signature.js";
import { canonicalJson, isSemver } from "../../../shared/plugin-spec.js";

/** 一个账号最多登记多少把活跃公钥。 */
export const MAX_ACTIVE_KEYS = 10;

/** 密钥状态缓存时间：0 表示每次都读 D1，撤销立即生效。 */
export const KEY_STATUS_CACHE = "no-store";

function nowMs() {
  return Date.now();
}

/* ============================================================
   读取
   ============================================================ */

export async function getKeyRow(env, keyId) {
  if (typeof keyId !== "string" || !keyId) return null;
  return env.DB.prepare(
    `SELECT key_id, user_id, public_key, algorithm, status, label,
            created_at, revoked_at, revoke_reason, last_used_at
       FROM publisher_keys WHERE key_id = ?`,
  )
    .bind(keyId)
    .first();
}

/** 账号自己的密钥列表（含公钥，因为公钥本来就是公开的）。 */
export async function listKeysForUser(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT key_id, public_key, algorithm, status, label, created_at, revoked_at, revoke_reason, last_used_at
       FROM publisher_keys WHERE user_id = ? ORDER BY created_at DESC, key_id ASC`,
  )
    .bind(userId)
    .all();
  return (rows?.results ?? []).map(mapKeyRow);
}

/**
 * 公开的发布者公钥列表：客户端验签时取这份。
 * 只给 keyId / 公钥 / 状态 / 时间，不给 user_id 之外任何账号信息。
 */
export async function listPublicKeysForPublisher(env, publisherId) {
  const rows = await env.DB.prepare(
    `SELECT key_id, public_key, algorithm, status, created_at, revoked_at
       FROM publisher_keys WHERE user_id = ? ORDER BY created_at ASC, key_id ASC`,
  )
    .bind(publisherId)
    .all();
  return (rows?.results ?? []).map((row) => ({
    keyId: row.key_id,
    publicKey: row.public_key,
    algorithm: row.algorithm,
    status: row.status,
    createdAt: Number(row.created_at) || 0,
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  }));
}

export function mapKeyRow(row) {
  return {
    keyId: row.key_id,
    publicKey: row.public_key,
    algorithm: row.algorithm,
    status: row.status,
    label: row.label ?? "",
    createdAt: Number(row.created_at) || 0,
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    revokeReason: row.revoke_reason ?? "",
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

/* ============================================================
   登记 / 撤销
   ============================================================ */

/**
 * 登记一把公钥。必须同时提交「持有私钥」的证明：
 *   proof = Ed25519Sign(privateKey, canonicalJson({action, spec, userId, keyId, publicKey, issuedAt}))
 *
 * 只提供公钥的登记是拒绝的 —— 否则可以把别人的公钥挂到自己名下，
 * 让自己的插件冒充对方的签名。
 */
export async function registerPublisherKey(env, { userId, publicKey, keyId, issuedAt, proof, label }) {
  if (typeof publicKey !== "string") throw new ApiError("PUBLIC_KEY_REQUIRED", "缺少公钥", 400);

  const rawBytes = base64urlDecode(publicKey);
  if (!rawBytes || rawBytes.length !== SIG_PUBLIC_KEY_BYTES) {
    throw new ApiError("PUBLIC_KEY_INVALID", `公钥必须是 ${SIG_PUBLIC_KEY_BYTES} 字节 base64url 的 Ed25519 原始公钥`, 400);
  }

  // keyId 只能由公钥派生，不接受客户端自选
  const derived = await keyIdForPublicKey(rawBytes);
  if (keyId != null && String(keyId) !== derived) {
    throw new ApiError("KEY_ID_MISMATCH", "keyId 与公钥不匹配", 400);
  }

  const issued = Number(issuedAt);
  const code = checkRegisterProof({ userId, publicKey, keyId: derived, issuedAt: issued, now: nowMs() });
  if (code) throw new ApiError(code, describeProofError(code), 400);

  const proofBytes = base64urlDecode(proof);
  if (!proofBytes || proofBytes.length !== 64) {
    throw new ApiError("PROOF_MALFORMED", "缺少持有私钥的证明", 400);
  }
  const payload = utf8Bytes(registerProofPayloadText({ userId, publicKey, keyId: derived, issuedAt: issued }));
  const proven = await verifyEd25519(publicKey, payload, proofBytes);
  if (!proven) {
    throw new ApiError("PROOF_INVALID", "持有私钥的证明无效，私钥与公钥不匹配", 400);
  }

  const existing = await getKeyRow(env, derived);
  if (existing) {
    if (existing.user_id !== userId) {
      // 不透露对方是谁，只说明这把公钥已被登记
      throw new ApiError("KEY_TAKEN", "这把公钥已被其他账号登记", 409);
    }
    if (existing.status === "revoked") {
      throw new ApiError("KEY_REVOKED", "这把公钥已经撤销，不能重新启用；请生成新密钥", 409);
    }
    return mapKeyRow(existing);
  }

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM publisher_keys WHERE user_id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first();
  if (Number(active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new ApiError("KEY_LIMIT", `最多只能登记 ${MAX_ACTIVE_KEYS} 把有效公钥，请先撤销不用的密钥`, 409);
  }

  const createdAt = nowMs();
  await env.DB.prepare(
    `INSERT INTO publisher_keys (key_id, user_id, public_key, algorithm, status, label, created_at)
     VALUES (?, ?, ?, 'ed25519', 'active', ?, ?)`,
  )
    .bind(derived, userId, publicKey, truncate(label, 60), createdAt)
    .run();

  return mapKeyRow({
    key_id: derived,
    public_key: publicKey,
    algorithm: "ed25519",
    status: "active",
    label: truncate(label, 60),
    created_at: createdAt,
    revoked_at: null,
    revoke_reason: null,
    last_used_at: null,
  });
}

export async function revokePublisherKey(env, { userId, keyId, reason }) {
  const row = await getKeyRow(env, keyId);
  if (!row || row.user_id !== userId) {
    throw new ApiError("NOT_FOUND", "没有找到这把密钥", 404);
  }
  if (row.status === "revoked") {
    return mapKeyRow(row);
  }
  const revokedAt = nowMs();
  await env.DB.prepare(
    `UPDATE publisher_keys SET status = 'revoked', revoked_at = ?, revoke_reason = ?
      WHERE key_id = ? AND user_id = ? AND status = 'active'`,
  )
    .bind(revokedAt, truncate(reason, 200), keyId, userId)
    .run();
  // 撤销后，历史版本不会被动改写成 invalid —— 状态由验签时动态判定。
  return mapKeyRow({ ...row, status: "revoked", revoked_at: revokedAt, revoke_reason: truncate(reason, 200) });
}

function describeProofError(code) {
  switch (code) {
    case "PROOF_EXPIRED":
      return "登记证明已过期，请重新生成（有效期 10 分钟）";
    case "PUBLIC_KEY_INVALID":
      return "公钥格式不正确";
    default:
      return "登记证明格式不正确";
  }
}

function truncate(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/* ============================================================
   验签
   ============================================================ */

/**
 * 对「一个插件版本 + 它的签名 + 它的包内容」做完整验签。
 *
 * @param {*} env
 * @param {{
 *   bundle: any,
 *   signature: unknown,
 *   plugin: { id: string, developer_id: string },
 *   version: string,
 * }} input
 */
export async function resolveSignature(env, { bundle, signature, plugin, version }) {
  if (signature == null) {
    return {
      status: SIG_STATUS.UNSIGNED,
      code: "SIG_MISSING",
      message: "这个版本没有发布者签名",
      errors: [],
      keyId: null,
      signedAt: null,
      envelope: null,
    };
  }

  const shape = validateSignatureEnvelope(signature);
  if (!shape.ok) {
    return invalid(shape.errors[0]?.code || "SIG_MALFORMED", shape.errors[0]?.message || "签名格式不正确", shape.errors);
  }
  const envelope = shape.envelope;

  const keyRow = await getKeyRow(env, envelope.keyId);
  if (!keyRow) {
    return invalid("SIG_KEY_UNKNOWN", `未知的签名密钥：${envelope.keyId}`, [
      { code: "SIG_KEY_UNKNOWN", path: "signature.keyId", message: "该公钥没有登记" },
    ]);
  }
  if (keyRow.user_id !== plugin.developer_id) {
    return invalid("SIG_IDENTITY_MISMATCH", "签名公钥不属于该插件的发布者", [
      { code: "SIG_IDENTITY_MISMATCH", path: "signature.keyId", message: "公钥归属与插件作者不一致" },
    ]);
  }

  const result = await verifyBundleSignature({
    signature: envelope,
    bundle,
    publicKey: keyRow.public_key,
    keyStatus: keyRow.status === "revoked" ? "revoked" : "active",
    expected: { publisherId: plugin.developer_id, pluginId: plugin.id, version },
  });

  return {
    ...result,
    keyId: envelope.keyId,
    signedAt: Number(envelope.signedAt) || null,
    publisherId: envelope.publisherId,
    envelope,
  };
}

function invalid(code, message, errors = []) {
  return { status: SIG_STATUS.INVALID, code, message, errors, keyId: null, signedAt: null, envelope: null };
}

/** 把数据库里的签名列还原成响应结构。 */
export function signatureOfVersionRow(row) {
  const status = row?.signature_status || SIG_STATUS.UNSIGNED;
  if (status === SIG_STATUS.UNSIGNED) return null;
  if (!row?.signature_json) return null;
  try {
    const parsed = JSON.parse(row.signature_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 版本行 → 客户端展示用的信任状态。 */
export function trustOfVersionRow(row) {
  const status = row?.signature_status || SIG_STATUS.UNSIGNED;
  return {
    status,
    keyId: row?.signature_key_id ?? null,
    signedAt: row?.signed_at == null ? null : Number(row.signed_at),
  };
}

/* ============================================================
   写入
   ============================================================ */

/**
 * 上传时把验签结果写进 plugin_versions。
 * 只允许写入 verified / unsigned —— invalid 在调用方已被拒绝，
 * 这里再兜一层，避免以后有人「先写进去再说」。
 */
export async function storeVersionSignature(env, { versionId, verification }) {
  const status = verification?.status === SIG_STATUS.VERIFIED ? SIG_STATUS.VERIFIED : SIG_STATUS.UNSIGNED;
  const envelope = status === SIG_STATUS.VERIFIED ? verification.envelope : null;
  await env.DB.prepare(
    `UPDATE plugin_versions
        SET signature_json = ?, signature_status = ?, signature_key_id = ?, signed_at = ?
      WHERE id = ?`,
  )
    .bind(
      envelope ? canonicalJson(envelope) : null,
      status,
      envelope ? envelope.keyId : null,
      envelope && Number.isSafeInteger(Number(envelope.signedAt)) ? Number(envelope.signedAt) : null,
      versionId,
    )
    .run();
  return { status, keyId: envelope ? envelope.keyId : null };
}

/** 记录一次成功验签，便于审计「密钥最近被谁用过」。失败不影响主流程。 */
export async function touchKeyUsage(env, keyId) {
  if (!keyId) return;
  try {
    await env.DB.prepare(`UPDATE publisher_keys SET last_used_at = ? WHERE key_id = ?`)
      .bind(nowMs(), keyId)
      .run();
  } catch {
    /* 统计失败不能阻断安装/下载 */
  }
}

export function isSupportedVersion(version) {
  return isSemver(version) && !version.includes("+");
}