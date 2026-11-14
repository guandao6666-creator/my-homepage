/** /api/auth/* 处理器。所有副作用操作都要求同源请求。 */

import { ApiError, json, ok } from "../http.js";
import { assertSameOrigin, readJson, requireSession } from "../guards.js";
import { authConfig, isOAuthConfigured } from "./config.js";
import {
  SETUP_COOKIE,
  STATE_COOKIE,
  clearSessionCookie,
  clearSetupCookie,
  clearStateCookie,
  getCookie,
  reauthCookie,
  setupCookie,
  stateCookie,
} from "./cookies.js";
import { pkceChallenge, randomToken, sha256Hex, timingSafeEqual } from "./crypto.js";
import { buildAuthorizeUrl, exchangeCode, fetchGithubUser, isKnownTestLogin } from "./github.js";
import {
  clearCookieHeader,
  inspectSession,
  issueSession,
  readSession,
  revokeSession,
} from "./session.js";
import { logActivity } from "../devices/model.js";
import { rateLimit } from "../ratelimit.js";
import { handleDevicesRequest } from "../devices/handlers.js";
import { logSecurityEvent } from "../privacy/events.js";
import { effectiveRole, ensureProfile } from "../community/common.js";
import {
  consumeJoinIntent,
  createJoinIntent,
  findValidInvite,
  getJoinIntent,
  registrationSettings,
  registrationSummary,
  releaseInvite,
  useInvite,
} from "../community/registration.js";
import {
  consumeOAuthState,
  consumeSetupTicket,
  countAdmins,
  createOAuthState,
  createReauthTicket,
  createSetupTicket,
  findUserByGithubId,
  getOAuthState,
  getSetupTicket,
  insertUser,
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

/* 同源校验 / JSON 读取 / Session 统一走 guards.js（2.0） */

/* ------------------------------------------------------------------ */
/* GET /api/auth/status                                                */
/* ------------------------------------------------------------------ */

export async function authStatus({ env, request }) {
  const config = authConfig(env, request);
  const admins = await countAdmins(env);
  const community = await registrationSummary(env);

  return ok({
    configured: isOAuthConfigured(config),
    initialized: admins > 0,
    setupAvailable: admins === 0 && Boolean(config.setupTokenValid),
    provider: "github",
    community,
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/github                                                 */
/* ------------------------------------------------------------------ */

export async function authStart({ env, request, url }) {
  const config = authConfig(env, request);
  const join = url?.searchParams.get("mode") === "join";
  const reauth = url?.searchParams.get("reauth") === "delete";
  const query = url?.search || "";

  // 统一在 APP_ORIGIN 上发起：否则从 www 进入时 state Cookie 落在 www，
  // GitHub 回调到 apex 会读不到 Cookie，表现为 invalid_state。
  const requestOrigin = new URL(request.url).origin;
  if (requestOrigin !== config.origin) {
    return redirect(`${config.origin}/api/auth/github${query}`);
  }

  // Phase 3.4 · OAuth 测试模式入口（只有 config.testMode 才生效）。
  // 它只把「跳去 GitHub 授权页」换成「跳回自己的 callback」：state Cookie、D1 里的
  // 一次性 state 记录、callback 的 state 校验与授权码兑换流程全部照常执行，没有
  // 跳过任何安全检查。身份只能来自 test_login 白名单（qa-<role>），不接受任何
  // 请求头或查询参数直接指定 github_id。
  const testLogin = config.testMode ? url?.searchParams.get("test_login") : null;
  if (testLogin !== null) {
    // 加入社区 / 注销重新验证依赖真实 GitHub 身份与邀请流程，测试模式明确不支持。
    if (join || reauth) return redirect(authError(config.origin, "test_login_unsupported"));
    if (!isKnownTestLogin(testLogin)) {
      return redirect(authError(config.origin, "test_login_invalid"));
    }

    const current = await readSession(env, request);
    if (current) return redirect(`${config.origin}/?account=1`);

    const admins = await countAdmins(env);
    // 与真实流程一致：没有管理员时必须先完成初始化；测试模式不提供任何默认 setup 密钥。
    if (admins === 0 && !config.setupTokenValid) {
      return redirect(authError(config.origin, "setup_disabled"));
    }

    // code_verifier 仍按真实流程随机生成并持久化到 state 记录；测试回调不经过
    // GitHub，但 callback 侧与生产共用同一段 state / 兑换代码。
    const verifier = randomToken(32);
    const state = await createOAuthState(env, {
      intent: admins > 0 ? "login" : "setup",
      verifier,
      purpose: "auth",
    });

    const callbackUrl = new URL(`${config.origin}/api/auth/github/callback`);
    callbackUrl.searchParams.set("code", `qa:${testLogin.slice("qa-".length)}`);
    callbackUrl.searchParams.set("state", state);
    return redirect(callbackUrl.toString(), [stateCookie(state, config.origin)]);
  }

  if (!isOAuthConfigured(config)) {
    return redirect(authError(config.origin, "not_configured"));
  }

  const current = await readSession(env, request);

  // 注销重新验证：必须已经登录，且走一次真实的 GitHub 授权。
  if (reauth) {
    if (!current) return redirect(authError(config.origin, "login_required"));
  } else if (current) {
    return redirect(`${config.origin}/${join ? "?community=1" : "?account=1"}`);
  }

  const admins = await countAdmins(env);
  if (admins === 0) {
    if (join) return redirect(authError(config.origin, "not_initialized"));
    if (!config.setupTokenValid) {
      return redirect(authError(config.origin, "setup_disabled"));
    }
  }

  // 社区注册：必须在进入 GitHub 授权前就通过服务端策略检查，
  // 不能靠前端隐藏按钮。回调时还会再校验一次，防止期间策略变更。
  let joinMode = null;
  let invite = null;
  if (join) {
    const settings = await registrationSettings(env);
    if (!settings || settings.mode === "closed") {
      return redirect(authError(config.origin, "registration_closed"));
    }
    if (settings.mode === "invite") {
      invite = await findValidInvite(env, url?.searchParams.get("invite"));
      if (!invite) return redirect(authError(config.origin, "invalid_invite"));
    }
    joinMode = settings.mode;
  }

  const verifier = randomToken(32);
  const challenge = await pkceChallenge(verifier);
  const state = await createOAuthState(env, {
    intent: admins > 0 ? "login" : "setup",
    verifier,
    purpose: reauth ? "delete" : "auth",
  });

  if (join && joinMode) {
    await createJoinIntent(env, {
      stateHash: await sha256Hex(state),
      mode: joinMode,
      inviteId: invite?.id ?? null,
    });
  }

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
      // 仅本地回环 + env 开关同时命中时为 true；生产恒为 false（见 config.js）。
      testMode: config.testMode,
    });

    if (!accessToken) {
      return redirect(authError(config.origin, "oauth_failed"), [clearState]);
    }

    // 测试哨兵令牌只允许在 testMode 下被识别（纵深防御：即使将来有别的代码把
    // 外部字符串传进来，生产环境也永远解析不出测试身份）。
    profile = await fetchGithubUser(accessToken, { testMode: config.testMode });
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
    if (!config.setupTokenValid) {
      return redirect(authError(config.origin, "setup_disabled"), [clearState]);
    }
    const ticket = await createSetupTicket(env, profile);
    return redirect(`${config.origin}/?setup=1`, [
      clearState,
      setupCookie(ticket, config.origin),
    ]);
  }

  const user = await findUserByGithubId(env, profile.id);
  const settings = await registrationSettings(env);

  if (user) {
    if (user.status !== "active") {
      await logSecurityEvent(env, {
        userId: user.id,
        eventType: "failed_login",
        result: "blocked",
        metadata: { reason: "account_disabled" },
      });
      return redirect(authError(config.origin, "account_disabled"), [clearState]);
    }
    if (user.deletion_state && user.deletion_state !== "none") {
      await logSecurityEvent(env, {
        userId: user.id,
        eventType: "failed_login",
        result: "blocked",
        metadata: { reason: "pending_deletion" },
      });
      return redirect(authError(config.origin, "pending_deletion"), [clearState]);
    }

    // 注销前的重新验证：必须是同一个 GitHub 身份，只发短期票据，不发新 Session。
    if (record.purpose === "delete") {
      const current = await readSession(env, request);
      if (!current || String(current.user.github_id) !== String(profile.id)) {
        return redirect(authError(config.origin, "reauth_mismatch"), [clearState]);
      }
      // 2.0 修复：这里曾经额外要求 role === "admin"，导致普通成员永远拿不到
      // 重新验证票据、账号注销恒为 403。身份已经由上一行的 Session 比对确认，
      // 注销自己的账号不需要管理员权限。
      const ticket = await createReauthTicket(env, user.id);
      return redirect(`${config.origin}/?delete_verified=1`, [
        clearState,
        reauthCookie(ticket, config.origin),
      ]);
    }

    // 社区成员登录：由管理员设置 member_login 控制；管理员与审核员不受此开关影响。
    const effective = await effectiveRole(env, user.id, user);
    if (effective === "member" && !settings?.memberLogin) {
      await logSecurityEvent(env, {
        userId: user.id,
        eventType: "failed_login",
        result: "failure",
        metadata: { reason: "member_login_disabled" },
      });
      return redirect(authError(config.origin, "member_login_disabled"), [clearState]);
    }

    try {
      const issued = await issueSession(env, {
        userId: user.id,
        request,
        origin: config.origin,
      });
      await touchUserLogin(env, user.id);
      await logSecurityEvent(env, {
        userId: user.id,
        eventType: "successful_login",
        deviceId: issued.deviceId,
        metadata: { reason: "github_oauth", role: user.role },
      });
      purgeExpired(env).catch(() => undefined);

      return redirect(`${config.origin}/?auth=ok`, [...issued.cookies, clearState]);
    } catch (error) {
      console.error("[auth] session issue failed:", error?.message ?? error);
      return redirect(authError(config.origin, "server_error"), [clearState]);
    }
  }

  // 还没有这个 GitHub 身份：只有明确走「加入社区」流程才允许创建账号。
  if (record.purpose === "delete") {
    return redirect(authError(config.origin, "not_allowed"), [clearState]);
  }

  const stateHash = await sha256Hex(state);
  const intent = await getJoinIntent(env, stateHash);
  if (!intent) {
    await logSecurityEvent(env, {
      userId: null,
      eventType: "failed_login",
      result: "failure",
      metadata: { reason: "not_member" },
    });
    return redirect(authError(config.origin, "not_member"), [clearState]);
  }
  if (!settings || settings.mode === "closed") {
    return redirect(authError(config.origin, "registration_closed"), [clearState]);
  }

  // 回调时重新校验邀请码，防止发起后邀请被作废或名额耗尽。
  let inviteId = null;
  if (settings.mode === "invite") {
    const valid = intent.invite_id
      ? await env.DB.prepare(
          `SELECT id FROM community_invites
            WHERE id = ? AND revoked_at IS NULL AND used_count < max_uses
              AND (expires_at IS NULL OR expires_at > ?)`,
        )
          .bind(intent.invite_id, Date.now())
          .first()
      : null;
    if (!valid) return redirect(authError(config.origin, "invalid_invite"), [clearState]);
    inviteId = valid.id;
  }

  const displayName = String(profile.name || profile.login || "创作者").slice(0, 60);
  let created;
  try {
    const id = crypto.randomUUID();
    await insertUser(env, {
      id,
      githubId: profile.id,
      login: profile.login,
      displayName,
      avatarUrl: profile.avatarUrl,
      role: "member",
    });
    created = await findUserByGithubId(env, profile.id);
    if (!created) throw new Error("user insert not visible");
    await ensureProfile(env, created);
  } catch (error) {
    console.error("[auth] community signup failed:", error?.message ?? error);
    return redirect(authError(config.origin, "server_error"), [clearState]);
  }

  const inviteUsed = await useInvite(env, inviteId);
  if (!inviteUsed) {
    // 并发下名额被抢完：回滚刚创建的用户（profile 由外键级联删除），不留半成品。
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(created.id).run();
    return redirect(authError(config.origin, "invalid_invite"), [clearState]);
  }
  await consumeJoinIntent(env, stateHash);

  try {
    const issued = await issueSession(env, {
      userId: created.id,
      request,
      origin: config.origin,
    });
    await touchUserLogin(env, created.id);
    await logSecurityEvent(env, {
      userId: created.id,
      eventType: "successful_login",
      deviceId: issued.deviceId,
      metadata: { reason: "community_signup", invite: Boolean(inviteId) },
    });
    purgeExpired(env).catch(() => undefined);

    return redirect(`${config.origin}/?joined=1&community=1`, [...issued.cookies, clearState]);
  } catch (error) {
    console.error("[auth] community session issue failed:", error?.message ?? error);
    await releaseInvite(env, inviteId);
    return redirect(authError(config.origin, "server_error"), [clearState]);
  }
}

/* ------------------------------------------------------------------ */
/* POST /api/auth/initialize                                           */
/* ------------------------------------------------------------------ */

export async function authInitialize({ env, request }) {
  const config = authConfig(env, request);
  assertSameOrigin(request, config.origin);

  if (!config.setupTokenValid) {
    throw new ApiError(
      "SETUP_DISABLED",
      "首次初始化未开启，或初始化密钥强度不足（至少 24 个字符）",
      503,
    );
  }

  // 2.0：全局尝试锁。原本只有「每 IP 5 次 / 10 分钟」，分布式来源可以无限试探；
  // 这里再加一道与 IP 无关的全局额度，10 次失败后整小时关闭初始化入口。
  const gate = await rateLimit(
    env,
    request,
    { rule: "auth-initialize-global", label: "初始化管理员（全局）", limit: 10, windowMs: 60 * 60_000 },
    { scope: "global", subject: "initial-admin" },
  );
  if (!gate.allowed) {
    throw new ApiError("RATE_LIMITED", `初始化尝试次数过多，请 ${gate.retryAfter} 秒后再试`, 429);
  }

  const body = await readJson(request, 4096);
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
  const inspected = await inspectSession(env, request);

  if (inspected.state !== "active") {
    const response = json({
      authenticated: false,
      user: null,
      reason: inspected.state,
    });
    // 过期 / 撤销的 Cookie 立刻清掉；pending_deletion 仍需保留会话用于注销任务轮询。
    if (
      inspected.state !== "missing" &&
      inspected.state !== "pending_deletion"
    ) {
      response.headers.append(
        "set-cookie",
        clearSessionCookie(authConfig(env, request).origin),
      );
    }
    return response;
  }

  const session = inspected.session;

  return json({
    authenticated: true,
    user: toPublicUser(inspected.user),
    session: {
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      deviceId: session.deviceId,
    },
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/auth/logout                                               */
/* ------------------------------------------------------------------ */

export async function authLogout({ env, request }) {
  const config = authConfig(env, request);
  assertSameOrigin(request, config.origin);

  const revoked = await revokeSession(env, request);
  if (revoked) {
    await logActivity(env, {
      userId: revoked.user_id,
      deviceId: revoked.device_id,
      eventType: "signed_out",
    });
    await logSecurityEvent(env, {
      userId: revoked.user_id,
      eventType: "session_revoked",
      deviceId: revoked.device_id,
      metadata: { reason: "user_logout" },
    });
  }

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
  const body = await readJson(request, 4096);

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
/* GET /api/auth/devices（兼容别名，等价于 GET /api/devices）           */
/* ------------------------------------------------------------------ */

export async function authDevices({ env, request, url }) {
  const response = await handleDevicesRequest({
    request,
    env,
    url,
    path: "/api/devices",
  });
  if (!response) throw new ApiError("NOT_FOUND", "接口不存在", 404);

  response.headers.set("deprecation", "true");
  response.headers.set("link", '</api/devices>; rel="successor-version"');
  return response;
}
