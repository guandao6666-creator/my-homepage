/**
 * Cookie 读写。
 *
 * Session Cookie 约束：HttpOnly / Secure（生产）/ SameSite=Lax / Path=/
 * 原始 token 只存在于浏览器 Cookie，数据库只保存哈希。
 */

export const SESSION_COOKIE = "gauth_sid";
export const DEVICE_COOKIE = "gauth_did";
export const STATE_COOKIE = "gauth_state";
export const SETUP_COOKIE = "gauth_setup";

const AUTH_PATH = "/api/auth";

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    if (trimmed.slice(0, index) === name) {
      try {
        return decodeURIComponent(trimmed.slice(index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    path = "/",
    httpOnly = true,
    sameSite = "Lax",
    secure = false,
  } = options;

  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) cookie += "; HttpOnly";
  if (secure) cookie += "; Secure";
  if (typeof maxAge === "number") cookie += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  return cookie;
}

export function sessionCookie(token, origin, maxAgeSeconds) {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: maxAgeSeconds,
    path: "/",
    secure: origin.startsWith("https://"),
  });
}

export function clearSessionCookie(origin) {
  return serializeCookie(SESSION_COOKIE, "", {
    maxAge: 0,
    path: "/",
    secure: origin.startsWith("https://"),
  });
}

export function deviceCookie(deviceId, origin) {
  return serializeCookie(DEVICE_COOKIE, deviceId, {
    maxAge: 365 * 24 * 3600,
    path: "/",
    secure: origin.startsWith("https://"),
  });
}

export function stateCookie(state, origin) {
  return serializeCookie(STATE_COOKIE, state, {
    maxAge: 600,
    path: AUTH_PATH,
    secure: origin.startsWith("https://"),
  });
}

export function clearStateCookie(origin) {
  return serializeCookie(STATE_COOKIE, "", {
    maxAge: 0,
    path: AUTH_PATH,
    secure: origin.startsWith("https://"),
  });
}

export function setupCookie(token, origin) {
  return serializeCookie(SETUP_COOKIE, token, {
    maxAge: 600,
    path: AUTH_PATH,
    secure: origin.startsWith("https://"),
  });
}

export function clearSetupCookie(origin) {
  return serializeCookie(SETUP_COOKIE, "", {
    maxAge: 0,
    path: AUTH_PATH,
    secure: origin.startsWith("https://"),
  });
}
