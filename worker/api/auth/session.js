/** Session 签发、校验与设备绑定。 */

import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  getCookie,
  sessionCookie,
  deviceCookie,
  clearSessionCookie,
} from "./cookies.js";
import { randomToken, sha256Hex } from "./crypto.js";
import {
  SESSION_TTL_MS,
  createSessionRow,
  deleteSession,
  findSessionByTokenHash,
  revokeSessionByHash,
  touchSession,
} from "./store.js";
import { bindDeviceOnLogin, logActivity } from "../devices/model.js";
import { logSecurityEvent } from "../privacy/events.js";

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sessionToken(request) {
  return getCookie(request, SESSION_COOKIE);
}

export async function issueSession(env, { userId, request, origin }) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const userAgent = (request.headers.get("user-agent") || "").slice(0, 200);
  const candidate = getCookie(request, DEVICE_COOKIE);

  // 设备归属在这里收口：Cookie 里的 ID 只有属于当前用户且未撤销才会复用，
  // 其余情况一律换发新记录，避免通过伪造 Cookie 抢占他人的设备记录。
  const binding = await bindDeviceOnLogin(env, {
    userId,
    candidateId: candidate,
    userAgent,
  });

  const row = await createSessionRow(env, {
    userId,
    tokenHash,
    deviceId: binding.deviceId,
    userAgent,
  });

  const cookies = [sessionCookie(token, origin, SESSION_TTL_MS / 1000)];
  if (candidate !== binding.deviceId) {
    cookies.push(deviceCookie(binding.deviceId, origin));
  }

  await logActivity(env, {
    userId,
    deviceId: binding.deviceId,
    eventType: "signed_in",
    metadata: { browser: binding.info.browser, os: binding.info.os },
  });

  await logSecurityEvent(env, {
    userId,
    eventType: "session_created",
    deviceId: binding.deviceId,
    metadata: { browser: binding.info.browser, os: binding.info.os },
  });

  return {
    cookies,
    deviceId: binding.deviceId,
    isNewDevice: binding.isNew,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * 详细会话检查：除「有效 / 无」之外，还要能区分过期与撤销，
 * 让前端能显示「账号可能已从其他设备退出」而不是笼统的未登录。
 */
export async function inspectSession(env, request) {
  const token = sessionToken(request);
  if (!token) return { state: "missing", user: null, session: null, row: null };

  const hash = await sha256Hex(token);
  const row = await findSessionByTokenHash(env, hash);
  if (!row) return { state: "missing", user: null, session: null, row: null };

  const now = Date.now();

  if (row.session_revoked_at) {
    return { state: "revoked", user: row, session: null, row };
  }

  if (row.device_revoked_at) {
    return { state: "device_revoked", user: row, session: null, row };
  }

  if (Number(row.session_expires_at) <= now) {
    await deleteSession(env, row.session_id);
    return { state: "expired", user: row, session: null, row };
  }

  if (row.status !== "active") {
    return { state: "disabled", user: row, session: null, row };
  }

  if (row.deletion_state === "pending") {
    return {
      state: "pending_deletion",
      user: row,
      row,
      session: {
        id: row.session_id,
        deviceId: row.device_id,
        expiresAt: Number(row.session_expires_at),
        createdAt: Number(row.session_created_at),
      },
    };
  }

  if (now - Number(row.last_used_at) > TOUCH_INTERVAL_MS) {
    await touchSession(env, row.session_id);
  }

  return {
    state: "active",
    user: row,
    row,
    session: {
      id: row.session_id,
      deviceId: row.device_id,
      expiresAt: Number(row.session_expires_at),
      createdAt: Number(row.session_created_at),
    },
  };
}

export async function readSession(env, request) {
  const inspected = await inspectSession(env, request);
  if (inspected.state !== "active") return null;
  return { user: inspected.user, session: inspected.session };
}

/** 撤销当前请求携带的 Session，返回设备信息供审计使用。 */
export async function revokeSession(env, request) {
  const token = sessionToken(request);
  if (!token) return null;
  return revokeSessionByHash(env, await sha256Hex(token));
}

export function clearCookieHeader(origin) {
  return clearSessionCookie(origin);
}

export { SESSION_COOKIE };
