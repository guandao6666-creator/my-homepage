/**
 * /api/pairing/* 设备配对。
 *
 * 流程：
 *   1. 已登录设备 A：POST /create → 拿到 6 位配对码 + 一次性 token（二维码内容）；
 *   2. 新设备 B：POST /claim → 记录设备信息，拿到 claimSecret，等待 A 确认；
 *   3. 设备 A：POST /:id/confirm → 服务端登记新设备；
 *   4. 设备 B：GET /claim/:id?secret= → 领取独立 Session，配对完成。
 *
 * 任何一步都不在二维码里放长期凭证；A 不确认，B 拿不到任何东西。
 */

import { ApiError, ok } from "../http.js";
import { authConfig } from "../auth/config.js";
import { requireActiveSession } from "../guards.js";
import { DEVICE_COOKIE, SESSION_COOKIE, deviceCookie, sessionCookie } from "../auth/cookies.js";
import { SESSION_TTL_MS, createSessionRow } from "../auth/store.js";
import { randomToken, sha256Hex } from "../auth/crypto.js";
import { logActivity } from "../devices/model.js";
import { logSecurityEvent } from "../privacy/events.js";
import { assertSameOrigin, readJson } from "../community/common.js";
import {
  PAIRING_TTL_MS,
  cancelPairing,
  confirmPairing,
  createPairing,
  expirePairings,
  findByIdentity,
  getByClaimSecret,
  getPairing,
  listActivePairings,
  markClaimed,
  publicPairing,
} from "./store.js";

const PREFIX = "/api/pairing";

export async function handlePairingRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const parts = rest ? rest.split("/") : [];
  const method = request.method;
  const origin = authConfig(env, request).origin;

  /* ------------------------------ 创建 ------------------------------ */
  if (parts.length === 1 && parts[0] === "create" && method === "POST") {
    assertSameOrigin(request, env);
    const session = await requireActiveSession(env, request);
    if (!session.session.deviceId) throw new ApiError("NO_DEVICE", "当前会话没有绑定设备", 409);

    await expirePairings(env);
    const created = await createPairing(env, {
      userId: session.user.id,
      sourceDeviceId: session.session.deviceId,
    });

    return ok({
      pairingId: created.id,
      code: created.code,
      token: created.token,
      expiresAt: created.expiresAt,
      ttl: PAIRING_TTL_MS,
      // 二维码只包含短期 token，不包含 Cookie / Session / GitHub Token
      qrUrl: `${origin}/pair/#t=${encodeURIComponent(created.token)}`,
      origin,
    });
  }

  /* ------------------------------ 列表 ------------------------------ */
  if (parts.length === 0 && method === "GET") {
    const session = await requireActiveSession(env, request);
    await expirePairings(env);
    const rows = await listActivePairings(env, session.user.id);
    return ok({
      items: rows.map((row) => publicPairing(row)),
      currentDeviceId: session.session.deviceId,
    });
  }

  /* ------------------------------ 新设备提交 ------------------------ */
  if (parts.length === 1 && parts[0] === "claim" && method === "POST") {
    // Phase 3.3 审计补齐：认领也要同源。`/pair/` 页面是同源 fetch，因此正常流程
    // 不受影响；但缺了这道校验，任意第三方页面都能替用户提交 claim（配合已被泄漏
    // 的配对码可把 Session 引到攻击者设备）。与 /create、/:id/confirm 保持一致。
    assertSameOrigin(request, env);
    const body = await readJson(request, 8 * 1024);
    const token = String(body.token || "").trim();
    const code = String(body.code || "").trim();
    if (!token && !/^\d{6}$/.test(code)) {
      throw new ApiError("INVALID_CODE", "配对码是 6 位数字", 400);
    }
    if (token && token.length > 128) throw new ApiError("INVALID_TOKEN", "配对链接不完整", 400);

    const pairing = await findByIdentity(env, { token, code });
    if (!pairing) throw new ApiError("PAIRING_NOT_FOUND", "配对码无效或已过期", 404);

    // Phase 3.3 审计：旧版这里检查 attempts >= max_attempts，但 `findByIdentity`
    // 只匹配 status='pending' 的行，而 markClaimed 会把该行置为 claimed ——
    // 同一配对会话最多只能被成功认领一次，attempts 永远不会累加到上限，
    // 所以分支是**不可达的假保护**。真正的暴力破解防线是：
    //   1) 6 位码 / 一次性 token 只存在 10 分钟；
    //   2) pairing-claim 限流 10 次 / 10 分钟 / IP（worker/api/ratelimit.js）；
    //   3) 认领成功后仍必须由已登录的原设备 confirm 才会签发 Session，
    //      原设备能看到目标设备信息并拒绝。
    // 删除不可达分支，避免维护者误以为还有一层尝试次数限制。
    // DB 的 attempts / max_attempts 列保留（历史数据兼容），markClaimed 仍写入 1。

    const claimed = await markClaimed(env, {
      pairing,
      request,
      device: body.device && typeof body.device === "object" ? body.device : null,
    });
    const source = await sourceInfo(env, pairing);

    return ok({
      pairingId: pairing.id,
      claimSecret: claimed.claimSecret,
      status: "claimed",
      device: claimed.device,
      source,
      expiresAt: Number(pairing.expires_at),
    });
  }

  /* ------------------------------ 新设备轮询 / 领取 Session --------- */
  if (parts.length === 2 && parts[0] === "claim" && method === "GET") {
    const id = parts[1];
    const secret = String(url.searchParams.get("secret") || "");
    if (!id || !secret) throw new ApiError("INVALID_CLAIM", "配对信息不完整", 400);

    const pairing = await getByClaimSecret(env, { id, secret });
    if (!pairing) throw new ApiError("PAIRING_NOT_FOUND", "配对会话不存在", 404);

    if (pairing.status === "cancelled") throw new ApiError("PAIRING_CANCELLED", "配对已被取消", 410);
    if (pairing.status === "expired" || Number(pairing.expires_at) <= Date.now()) {
      throw new ApiError("PAIRING_EXPIRED", "配对码已过期，请重新生成", 410);
    }

    if (pairing.status !== "confirmed" && pairing.status !== "completed") {
      return ok({
        status: pairing.status,
        expiresAt: Number(pairing.expires_at),
        source: await sourceInfo(env, pairing),
        paired: false,
      });
    }

    // confirmed：领取一次性 Session；已完成的不再重复发放。
    if (pairing.status === "completed") {
      return ok({ status: "completed", paired: true, alreadyDelivered: true });
    }
    if (!pairing.target_device_id) throw new ApiError("BROKEN_PAIRING", "配对状态不完整", 409);

    const token = randomToken(32);
    const now = Date.now();
    await createSessionRow(env, {
      userId: pairing.user_id,
      tokenHash: await sha256Hex(token),
      deviceId: pairing.target_device_id,
      userAgent: pairing.target_user_agent || request.headers.get("user-agent") || "",
    });
    await env.DB.prepare(
      "UPDATE device_pairings SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'confirmed'",
    )
      .bind(now, pairing.id)
      .run();

    await logActivity(env, {
      userId: pairing.user_id,
      deviceId: pairing.target_device_id,
      eventType: "signed_in",
      metadata: { browser: pairing.target_browser || "", os: pairing.target_os || "", paired: true },
    });
    await logSecurityEvent(env, {
      userId: pairing.user_id,
      eventType: "session_created",
      deviceId: pairing.target_device_id,
      metadata: { browser: pairing.target_browser || "", os: pairing.target_os || "" },
    });

    const user = await env.DB.prepare(
      "SELECT display_name, github_username, avatar_url FROM users WHERE id = ?",
    )
      .bind(pairing.user_id)
      .first();

    const response = ok({
      status: "completed",
      paired: true,
      deviceId: pairing.target_device_id,
      user: {
        displayName: user?.display_name || user?.github_username || "Guandao",
        githubUsername: user?.github_username || null,
        avatarUrl: user?.avatar_url || null,
      },
    });
    response.headers.append("set-cookie", sessionCookie(token, origin, SESSION_TTL_MS / 1000));
    response.headers.append("set-cookie", deviceCookie(pairing.target_device_id, origin));
    response.headers.append("x-pairing-cookie", SESSION_COOKIE);
    response.headers.append("x-pairing-device-cookie", DEVICE_COOKIE);
    return response;
  }

  /* ------------------------------ 旧设备确认 ------------------------ */
  if (parts.length === 2 && parts[1] === "confirm" && method === "POST") {
    assertSameOrigin(request, env);
    const session = await requireActiveSession(env, request);

    const pairing = await getPairing(env, parts[0]);
    if (!pairing || pairing.user_id !== session.user.id) {
      throw new ApiError("PAIRING_NOT_FOUND", "配对会话不存在", 404);
    }
    if (pairing.status !== "claimed") {
      throw new ApiError("PAIRING_STATE", "这个配对还没有待确认的新设备", 409);
    }
    if (Number(pairing.expires_at) <= Date.now()) {
      throw new ApiError("PAIRING_EXPIRED", "配对码已过期，请重新生成", 410);
    }
    if (pairing.source_device_id !== session.session.deviceId) {
      throw new ApiError("WRONG_DEVICE", "请回到发起配对的那台设备上确认", 403);
    }

    let confirmed;
    try {
      confirmed = await confirmPairing(env, { pairing, userId: session.user.id });
    } catch (error) {
      if (error?.code === "DEVICE_LIMIT") {
        throw new ApiError("DEVICE_LIMIT", "设备数量已达上限，请先移除一台旧设备", 409);
      }
      throw error;
    }

    await logActivity(env, {
      userId: session.user.id,
      deviceId: confirmed.deviceId,
      eventType: "trusted",
      metadata: { pairedBy: session.session.deviceId, name: confirmed.name, type: confirmed.type },
    });
    await logSecurityEvent(env, {
      userId: session.user.id,
      eventType: "new_device_registered",
      deviceId: confirmed.deviceId,
      metadata: { browser: pairing.target_browser || "", os: pairing.target_os || "", deviceType: confirmed.type },
    });

    return ok({
      status: "confirmed",
      device: { id: confirmed.deviceId, name: confirmed.name, type: confirmed.type },
      pairing: publicPairing({ ...pairing, status: "confirmed", target_device_id: confirmed.deviceId }),
    });
  }

  /* ------------------------------ 取消 ------------------------------ */
  if (parts.length === 2 && parts[1] === "cancel" && method === "POST") {
    assertSameOrigin(request, env);
    const session = await requireActiveSession(env, request);

    const pairing = await getPairing(env, parts[0]);
    if (!pairing || pairing.user_id !== session.user.id) {
      throw new ApiError("PAIRING_NOT_FOUND", "配对会话不存在", 404);
    }
    await cancelPairing(env, { id: pairing.id, userId: session.user.id });
    return ok({ cancelled: true });
  }

  return null;
}

async function sourceInfo(env, pairing) {
  const row = await env.DB.prepare("SELECT name, device_type FROM devices WHERE id = ? AND user_id = ?")
    .bind(pairing.source_device_id, pairing.user_id)
    .first();
  return { name: row?.name || "另一台设备", type: row?.device_type || "desktop" };
}
