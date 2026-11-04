/** Session 签发、校验与设备信息。 */

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
  deleteSessionByHash,
  findSessionByTokenHash,
  touchSession,
  upsertDevice,
} from "./store.js";

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sessionToken(request) {
  return getCookie(request, SESSION_COOKIE);
}

export async function issueSession(env, { userId, request, origin }) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const userAgent = (request.headers.get("user-agent") || "").slice(0, 200);

  let deviceId = getCookie(request, DEVICE_COOKIE);
  const newDevice = !deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId);
  if (newDevice) deviceId = crypto.randomUUID();

  const { name, platform } = deviceLabel(userAgent);
  await upsertDevice(env, { deviceId, userId, name, platform });

  const row = await createSessionRow(env, { userId, tokenHash, deviceId, userAgent });

  const cookies = [sessionCookie(token, origin, SESSION_TTL_MS / 1000)];
  if (newDevice) cookies.push(deviceCookie(deviceId, origin));

  return { cookies, deviceId, expiresAt: row.expiresAt, createdAt: row.createdAt };
}

export async function readSession(env, request) {
  const token = sessionToken(request);
  if (!token) return null;

  const hash = await sha256Hex(token);
  const row = await findSessionByTokenHash(env, hash);
  if (!row) return null;

  const now = Date.now();
  if (Number(row.session_expires_at) <= now) {
    await deleteSession(env, row.session_id);
    return null;
  }

  if (row.status !== "active") {
    await deleteSession(env, row.session_id);
    return null;
  }

  if (now - Number(row.last_used_at) > TOUCH_INTERVAL_MS) {
    await touchSession(env, row.session_id);
  }

  return {
    user: row,
    session: {
      id: row.session_id,
      deviceId: row.device_id,
      expiresAt: Number(row.session_expires_at),
      createdAt: Number(row.session_created_at),
    },
  };
}

export async function revokeSession(env, request) {
  const token = sessionToken(request);
  if (token) {
    await deleteSessionByHash(env, await sha256Hex(token));
  }
}

export function clearCookieHeader(origin) {
  return clearSessionCookie(origin);
}

export { SESSION_COOKIE };

function deviceLabel(userAgent) {
  const platform = /Windows/i.test(userAgent)
    ? "Windows"
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? "iOS"
      : /Android/i.test(userAgent)
        ? "Android"
        : /Mac OS X|Macintosh/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : "未知系统";

  const browser = /Edg\//i.test(userAgent)
    ? "Edge"
    : /Chrome\//i.test(userAgent)
      ? "Chrome"
      : /Firefox\//i.test(userAgent)
        ? "Firefox"
        : /Safari\//i.test(userAgent)
          ? "Safari"
          : "浏览器";

  return { name: `${browser} · ${platform}`.slice(0, 80), platform };
}
