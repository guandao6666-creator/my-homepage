/** /api/auth/* 处理器。所有副作用操作都要求同源请求。 */

import { ApiError, json, ok } from "../http.js";
import { authConfig, isOAuthConfigured } from "./config.js";
import {
  SETUP_COOKIE,
  STATE_COOKIE,
  clearSetupCookie,
  clearStateCookie,
  getCookie,
  setupCookie,
  stateCookie,
} from "./cookies.js";
import { pkceChallenge, randomToken, sha256Hex, timingSafeEqual } from "./crypto.js";import { buildAuthorizeUrl, exchangeCode, fetchGithubUser } from "./github.js";
import {
  clearCookieHeader,
  issueSession,
  readSession,
  revokeSession,
} from "./session.js";
import {
  consumeOAuthState,
  consumeSetupTicket,
  countAdmins,
  createOAuthState,
  createSetupTicket,
  findUserByGithubId,
  getOAuthState,
  getSetupTicket,
  insertUser,
  listSessions,
  promoteToAdmin,
  purgeExpired,
  toPublicUser,
  touchUserLogin,
  updateDisplayName,
} from "./store.js";

function redirect(location, cookies = []) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function authError(origin, code) {
  return `${origin}/?auth_error=${encodeURIComponent(code)}`;
}

function assertSameOrigin(request, origin) {
  const requestOrigin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");

  if (requestOrigin) {
    if (requestOrigin !== origin) {
      throw new ApiError("CSRF_REJECTED", "请求来源不被允许", 403);
    }
    return;
  }

  if (site === "same-origin") return;
  throw new ApiError("CSRF_REJECTED", "请求来源不被允许", 403);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) throw new ApiError("PAYLOAD_TOO_LARGE", "请求体过大", 413);

  try {
    return await request.json();
  } catch {
    throw new ApiError("INVALID_JSON", "请求格式不正确", 400);
  }
}

async function requireSession(env, request) {
  const session = await readSession(env, request);
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录", 401);
  return session;
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/status                                                */
/* ------------------------------------------------------------------ */

export async function authStatus({ env, request }) {
  const config = authConfig(env, request);
  const admins = await countAdmins(env);

  return ok({
    configured: isOAuthConfigured(config),
    initialized: admins > 0,
    setupAvailable: admins === 0 && Boolean(config.setupToken),
    provider: "github",
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/github                                                 */
/* ------------------------------------------------------------------ */

export async function authStart({ env, request }) {
  const config = authConfig(env, request);

  // 统一在 APP_ORIGIN 上发起：否则从 www 进入时 state Cookie 落在 www，
  // GitHub 回调到 apex 会读不到 Cookie，表现为 invalid_state。
  const requestOrigin = new URL(request.url).origin;
  if (requestOrigin !== config.origin) {
    return redirect(`${config.origin}/api/auth/github`);
  }

  if (!isOAuthConfigured(config)) {
    return redirect(authError(config.origin, "not_configured"));
  }

  const current = await readSession(env, request);
  if (current) return redirect(`${config.origin}/?account=1`);

  const admins = await countAdmins(env);
  if (admins === 0 && !config.setupToken) {
    return redirect(authError(config.origin, "setup_disabled"));
  }

  const verifier = randomToken(32);
  const challenge = await pkceChallenge(verifier);
  const state = await createOAuthState(env, {
    intent: admins > 0 ? "login" : "setup",
    verifier,
  });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
    codeChallenge: challenge,
  });

  return redirect(authorizeUrl, [stateCookie(state, config.origin)]);
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/github/callback                                        */
/* ------------------------------------------------------------------ */

export async function authCallback({ env, request }) {
  const config = authConfig(env, request);
  const url = new URL(request.url);
  const clearState = clearStateCookie(config.origin);

  if (url.searchParams.get("error")) {
    return redirect(authError(config.origin, "access_denied"), [clearState]);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = getCookie(request, STATE_COOKIE);

  if (!code || !state || !cookieState || !timingSafeEqual(state, cookieState)) {
    return redirect(authError(config.origin, "invalid_state"), [clearState]);
  }

  const record = await getOAuthState(env, state);
  if (!record) {
    return redirect(authError(config.origin, "invalid_state"), [clearState]);
  }

  const consumed = await consumeOAuthState(env, record.id);
  if (!consumed) {
    return redirect(authError(config.origin, "invalid_state"), [clearState]);
  }

  let profile;
  try {
    const accessToken = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: config.redirectUri,
      codeVerifier: record.code_verifier,
    });

    if (!accessToken) {
      return redirect(authError(config.origin, "oauth_failed"), [clearState]);
    }

    profile = await fetchGithubUser(accessToken);
  } catch (error) {
    console.error("[auth] github exchange failed:", error?.message ?? error);
    return redirect(authError(config.origin, "oauth_failed"), [clearState]);
  }

  if (!profile) {
    return redirect(authError(config.origin, "profile_failed"), [clearState]);
  }

  const admins = await countAdmins(env);

  // 还没有管理员：先进入初始化，不发放正式 Session。
  if (admins === 0) {
    if (!config.setupToken) {
      return redirect(authError(config.origin, "setup_disabled"), [clearState]);
    }
    const ticket = await createSetupTicket(env, profile);
    return redirect(`${config.origin}/?setup=1`, [
      clearState,
      setupCookie(ticket, config.origin),
    ]);
  }

  const user = await findUserByGithubId(env, profile.id);
  if (!user || user.role !== "admin" || user.status !== "active") {
    return redirect(authError(config.origin, "not_allowed"), [clearState]);
  }

  try {
    const issued = await issueSession(env, {
      userId: user.id,
      request,
      origin: config.origin,
    });
    await touchUserLogin(env, user.id);
    purgeExpired(env).catch(() => undefined);

    return redirect(`${config.origin}/?auth=ok`, [...issued.cookies, clearState]);
  } catch (error) {
    console.error("[auth] session issue failed:", error?.message ?? error);
    return redirect(authError(config.origin, "server_error"), [clearState]);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/auth/initialize                                           */
/* ------------------------------------------------------------------ */

export async function authInitialize({ env, request }) {
  const config = authConfig(env, request);
  assertSameOrigin(request, config.origin);

  if (!config.setupToken) {
    throw new ApiError("SETUP_DISABLED", "首次初始化尚未开启", 503);
  }

  const body = await readJson(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 200) {
    throw new ApiError("INVALID_SETUP_TOKEN", "初始化密钥不正确", 401);
  }

  const setupToken = getCookie(request, SETUP_COOKIE);
  if (!setupToken) {
    throw new ApiError("SETUP_EXPIRED", "初始化会话已过期，请重新通过 GitHub 验证", 401);
  }

  const ticket = await getSetupTicket(env, setupToken);
  if (!ticket) {
    throw new ApiError("SETUP_EXPIRED", "初始化会话已过期，请重新通过 GitHub 验证", 401);
  }

  if ((await countAdmins(env)) > 0) {
    throw new ApiError("ALREADY_INITIALIZED", "管理员已初始化", 409);
  }

  const matched = timingSafeEqual(
    await sha256Hex(token),
    await sha256Hex(config.setupToken),
  );
  if (!matched) {
    throw new ApiError("INVALID_SETUP_TOKEN", "初始化密钥不正确", 401);
  }

  const displayName = (ticket.display_name || ticket.github_username || "Guandao").slice(0, 60);

  let user = await findUserByGithubId(env, ticket.github_id);
  try {
    if (user) {
      await promoteToAdmin(env, user.id, {
        login: ticket.github_username,
        displayName,
        avatarUrl: ticket.avatar_url,
      });
    } else {
      const id = crypto.randomUUID();
      await insertUser(env, {
        id,
        githubId: ticket.github_id,
        login: ticket.github_username,
        displayName,
        avatarUrl: ticket.avatar_url,
        role: "admin",
      });
    }
  } catch (error) {
    // 并发初始化会被 idx_users_single_admin 拒绝。
    console.error("[auth] initialize insert failed:", error?.message ?? error);
    throw new ApiError("ALREADY_INITIALIZED", "管理员已初始化", 409);
  }

  user = await findUserByGithubId(env, ticket.github_id);
  await consumeSetupTicket(env, ticket.id);
  await touchUserLogin(env, user.id);

  const issued = await issueSession(env, {
    userId: user.id,
    request,
    origin: config.origin,
  });

  const response = ok({
    user: toPublicUser(user),
    session: { expiresAt: issued.expiresAt, createdAt: issued.createdAt },
  });

  for (const cookie of issued.cookies) response.headers.append("set-cookie", cookie);
  response.headers.append("set-cookie", clearSetupCookie(config.origin));
  response.headers.append("set-cookie", clearStateCookie(config.origin));

  return response;
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/me                                                    */
/* ------------------------------------------------------------------ */

export async function authMe({ env, request }) {
  const session = await readSession(env, request);

  if (!session) {
    return json({ authenticated: false, user: null });
  }

  return json({
    authenticated: true,
    user: toPublicUser(session.user),
    session: {
      expiresAt: session.session.expiresAt,
      createdAt: session.session.createdAt,
      deviceId: session.session.deviceId,
    },
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/auth/logout                                               */
/* ------------------------------------------------------------------ */

export async function authLogout({ env, request }) {
  const config = authConfig(env, request);
  assertSameOrigin(request, config.origin);

  await revokeSession(env, request);

  const response = ok({ loggedOut: true });
  response.headers.append("set-cookie", clearCookieHeader(config.origin));
  return response;
}

/* ------------------------------------------------------------------ */
/* PATCH /api/auth/profile                                             */
/* ------------------------------------------------------------------ */

export async function authUpdateProfile({ env, request }) {
  const config = authConfig(env, request);
  assertSameOrigin(request, config.origin);

  const session = await requireSession(env, request);
  const body = await readJson(request);

  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName || displayName.length > 60) {
    throw new ApiError("INVALID_DISPLAY_NAME", "昵称长度需在 1–60 个字符之间", 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new ApiError("INVALID_DISPLAY_NAME", "昵称包含不允许的字符", 400);
  }

  await updateDisplayName(env, session.user.id, displayName);
  const updated = await findUserByGithubId(env, session.user.github_id);

  return ok({ user: toPublicUser(updated) });
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/devices                                               */
/* ------------------------------------------------------------------ */

export async function authDevices({ env, request }) {
  const session = await requireSession(env, request);
  const devices = await listSessions(env, session.user.id, session.session.id);

  return ok({
    devices,
    currentDeviceId: session.session.deviceId,
    note: "当前仅展示登录会话；设备吊销与命名将在后续版本开放。",
  });
}
