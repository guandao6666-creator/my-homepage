/**
 * Phase 3.4 · OAuth 可重复测试模式 E2E（真实 Worker + 本地 D1）
 *
 * 覆盖：
 *   1. testMode 派生规则（单元级）：默认关闭、只认 env、必须 loopback、
 *      APP_ORIGIN 指向生产时即使请求来自本机也不开启；
 *   2. 生产 origin（Host 伪造为 guandao.xin）拒绝测试入口；
 *   3. 测试入口 302 到自己的 callback，并下发真实 state Cookie（属性与生产一致）；
 *   4. 正常回调全链路：Session Cookie → /api/auth/me 已登录 → logout 撤销；
 *   5. state 不匹配 / 缺失 / D1 无记录（等价过期或伪造）/ 重放，全部 invalid_state；
 *   6. 测试身份白名单：test_login 只能是 qa-<role>，篡改 code 也拿不到身份；
 *   7. 测试模式不支持 join / reauth 流程（显式报错，不静默降级）。
 *
 * 前提：`scripts/e2e-server.mjs` 以 `--var AUTH_TEST_MODE:1` 启动本地 Worker
 * （playwright.config.ts 的 worker project webServer 会自动这样做）。
 * 若同一分钟内反复执行导致 429，先跑 `node scripts/e2e-reset-limits.mjs`。
 */
import {
  expect,
  test,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";

import { authConfig } from "../../worker/api/auth/config.js";
import { API_BASE, waitForFixtures } from "./support/worker-api";

const TEST_LOGIN = "qa-developer";
const START_PATH = "/api/auth/github";
const CALLBACK_PATH = "/api/auth/github/callback";
const LOOPBACK_ORIGIN = API_BASE;
const PROD_ORIGIN = "https://guandao.xin";

const loopbackRequest = { url: `${LOOPBACK_ORIGIN}${START_PATH}` };
const prodRequest = { url: `${PROD_ORIGIN}${START_PATH}` };

function newContext(options: { maxRedirects?: number } = {}): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: API_BASE,
    timeout: 20_000,
    maxRedirects: options.maxRedirects ?? 0,
  });
}

function locationOf(response: APIResponse): string {
  const location = response.headers()["location"];
  if (!location) throw new Error(`响应 ${response.status()} 没有 Location 头`);
  return location;
}

function setCookieHeaders(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);
}

/** 把一条 Set-Cookie 拆成 name/value + 小写属性表（httponly 为空串）。 */
function parseSetCookie(raw: string): Record<string, string> {
  const [pair, ...attributes] = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const equal = pair.indexOf("=");
  const parsed: Record<string, string> = {
    name: pair.slice(0, equal),
    value: pair.slice(equal + 1),
  };
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    if (index === -1) parsed[attribute.toLowerCase()] = "";
    else parsed[attribute.slice(0, index).trim().toLowerCase()] = attribute.slice(index + 1).trim();
  }
  return parsed;
}

function findSetCookie(response: APIResponse, name: string): Record<string, string> | null {
  for (const raw of setCookieHeaders(response)) {
    const parsed = parseSetCookie(raw);
    if (parsed.name === name) return parsed;
  }
  return null;
}

/** 发起测试登录入口，返回 302 响应；调用方负责 dispose context。 */
async function startTestLogin(context: APIRequestContext, query = `test_login=${TEST_LOGIN}`): Promise<APIResponse> {
  const response = await context.get(`${START_PATH}?${query}`);
  expect(response.status(), "authStart 应返回 302").toBe(302);
  return response;
}

async function expectAuthError(response: APIResponse, code: string): Promise<void> {
  expect(response.status()).toBe(302);
  expect(locationOf(response)).toBe(`${API_BASE}/?auth_error=${code}`);
}

test.beforeAll(async () => {
  await waitForFixtures("accounts");

  // 明确提示：本文件的 positive 用例依赖 e2e-server 注入 AUTH_TEST_MODE=1。
  const context = await newContext();
  const response = await context.get(`${START_PATH}?test_login=${TEST_LOGIN}`);
  const location = locationOf(response);
  await context.dispose();
  expect(
    location.startsWith(`${API_BASE}${CALLBACK_PATH}`),
    `本地 Worker 未启用 OAuth 测试模式（authStart 实际 302 到 ${location}）。` +
      "请用 node scripts/e2e-server.mjs 启动 8788（它会传 --var AUTH_TEST_MODE:1）。",
  ).toBe(true);
});

/* ------------------------------------------------------------------ */
/* 1. testMode 派生规则（单元级，不需要 Worker）                        */
/* ------------------------------------------------------------------ */

test.describe("testMode 派生规则", () => {
  test("默认关闭，查询参数不能开启测试模式", () => {
    expect(authConfig({}, loopbackRequest).testMode).toBe(false);
    expect(
      authConfig({}, { url: `${LOOPBACK_ORIGIN}${START_PATH}?test_login=${TEST_LOGIN}` }).testMode,
    ).toBe(false);
  });

  test("env 必须精确等于字符串 '1'", () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(authConfig({ AUTH_TEST_MODE: value }, loopbackRequest).testMode, `AUTH_TEST_MODE=${value}`).toBe(false);
    }
    expect(authConfig({ AUTH_TEST_MODE: "1" }, loopbackRequest).testMode).toBe(true);
  });

  test("请求 origin 必须是 loopback（生产域名一律拒绝）", () => {
    expect(authConfig({ AUTH_TEST_MODE: "1" }, prodRequest).testMode).toBe(false);
    expect(authConfig({ AUTH_TEST_MODE: "1" }, { url: `http://localhost:8788${START_PATH}` }).testMode).toBe(true);
    expect(authConfig({ AUTH_TEST_MODE: "1" }, { url: `http://[::1]:8788${START_PATH}` }).testMode).toBe(true);
    expect(authConfig({ AUTH_TEST_MODE: "1" }, { url: `http://127.0.0.1.nip.io:8788${START_PATH}` }).testMode).toBe(
      false,
    );
  });

  test("APP_ORIGIN 指向生产时，即使请求来自 loopback 也不开启", () => {
    expect(authConfig({ AUTH_TEST_MODE: "1", APP_ORIGIN: PROD_ORIGIN }, loopbackRequest).testMode).toBe(false);
    expect(
      authConfig({ AUTH_TEST_MODE: "1", APP_ORIGIN: "http://localhost:8788" }, loopbackRequest).testMode,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 生产 origin：测试入口必须不生效                                   */
/* ------------------------------------------------------------------ */

test.describe("生产 origin 拒绝测试模式", () => {
  test("Host 伪造成生产域名时，test_login 不会触发测试回调", async () => {
    const context = await newContext();
    const response = await context.get(`${START_PATH}?test_login=${TEST_LOGIN}`, {
      headers: { Host: "guandao.xin" },
    });
    const location = locationOf(response);
    const stateCookie = findSetCookie(response, "gauth_state");
    await context.dispose();

    expect(response.status()).toBe(302);
    // 关键断言：生产 origin 下绝不跳回本地 callback（那才是测试模式入口）。
    expect(location).not.toContain(CALLBACK_PATH);
    expect(location.startsWith("http://guandao.xin/")).toBe(true);
    // 本地未配置 OAuth 凭据时走 not_configured；若配置了则应跳真实 GitHub 授权页。
    expect(
      location === "http://guandao.xin/?auth_error=not_configured" ||
        location.startsWith("https://github.com/login/oauth/authorize"),
    ).toBe(true);
    expect(stateCookie, "生产 origin 下不应下发 state Cookie").toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. 测试入口与正常回调全链路                                          */
/* ------------------------------------------------------------------ */

test.describe("测试模式回调链路", () => {
  test("入口：302 到自己的 callback，state Cookie 属性与生产一致", async () => {
    const context = await newContext();
    const response = await startTestLogin(context);
    const location = locationOf(response);
    const stateCookie = findSetCookie(response, "gauth_state");
    await context.dispose();

    const callback = new URL(location);
    expect(callback.origin).toBe(API_BASE);
    expect(callback.pathname).toBe(CALLBACK_PATH);
    expect(callback.searchParams.get("code")).toBe("qa:developer");
    expect(callback.searchParams.get("state")).toBeTruthy();
    // 不是跳去真实 GitHub 授权页，但 state / PKCE 记录已经真实落库。
    expect(location).not.toContain("github.com/login/oauth/authorize");

    expect(stateCookie, "测试入口也必须下发真实 state Cookie").not.toBeNull();
    expect(stateCookie!.httponly, "state Cookie 必须 HttpOnly").toBeDefined();
    expect(stateCookie!.samesite?.toLowerCase()).toBe("lax");
    expect(stateCookie!.path).toBe("/api/auth");
    expect(stateCookie!["max-age"]).toBe("600");
    expect(stateCookie!.secure, "http loopback 下不应带 Secure").toBeUndefined();
  });

  test("正常回调：拿到 Session → /api/auth/me 已登录 → logout 后匿名", async () => {
    const context = await newContext();
    const start = await startTestLogin(context);
    const startLocation = locationOf(start);
    expect(new URL(startLocation).searchParams.get("state")).toBeTruthy();

    const callback = await context.get(startLocation);
    expect(callback.status()).toBe(302);
    expect(locationOf(callback)).toBe(`${API_BASE}/?auth=ok`);

    const sessionCookie = findSetCookie(callback, "gauth_sid");
    expect(sessionCookie, "成功回调应下发 gauth_sid").not.toBeNull();
    expect(sessionCookie!.httponly, "Session Cookie 必须 HttpOnly").toBeDefined();
    expect(sessionCookie!.samesite?.toLowerCase()).toBe("lax");
    expect(sessionCookie!.path).toBe("/");
    expect(sessionCookie!["max-age"]).toBe(String(30 * 24 * 3600));
    expect(sessionCookie!.secure, "http loopback 下不应带 Secure").toBeUndefined();
    expect(findSetCookie(callback, "gauth_state")?.["max-age"], "回调后应清掉一次性 state").toBe("0");

    const me = await context.get("/api/auth/me");
    expect(me.status()).toBe(200);
    const meBody = await me.json();
    expect(meBody.authenticated).toBe(true);
    // 身份只可能来自固定 qa-* 映射：落在本地夹具行 qa-p3-developer 上。
    expect(meBody.user.id).toBe("qa-p3-developer");
    expect(meBody.user.githubUsername).toBe("qa-p3-developer");
    expect(meBody.user.role).toBe("member");
    expect(meBody.session.deviceId).toBeTruthy();
    // /api/auth/me 是裸 JSON，不是 {success,data} 信封（与 /api/auth/status 不同）。
    expect(meBody.success).toBeUndefined();
    expect(meBody.data).toBeUndefined();
    // 测试身份令牌只在 Worker 进程内使用一次：不回传浏览器、不写库、不出现在任何响应中。
    expect(JSON.stringify(setCookieHeaders(callback))).not.toContain("qa-test-token");
    expect(JSON.stringify(meBody)).not.toContain("qa-test-token");

    const logout = await context.post("/api/auth/logout", { headers: { Origin: API_BASE } });
    expect(logout.status()).toBe(200);
    const logoutBody = await logout.json();
    expect(logoutBody.success).toBe(true);
    expect(logoutBody.data.loggedOut).toBe(true);
    const clearedSession = findSetCookie(logout, "gauth_sid");
    expect(clearedSession?.["max-age"], "logout 应清掉 Session Cookie").toBe("0");
    expect(clearedSession?.httponly).toBeDefined();
    expect(clearedSession?.path).toBe("/");

    const meAfter = await context.get("/api/auth/me");
    const meAfterBody = await meAfter.json();
    expect(meAfterBody.authenticated).toBe(false);
    expect(meAfterBody.user).toBeNull();
    await context.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* 4. state 防护：测试模式同样不跳过                                     */
/* ------------------------------------------------------------------ */

test.describe("state 防护", () => {
  test("state Cookie 被篡改 → invalid_state", async () => {
    const starter = await newContext();
    const start = await startTestLogin(starter);
    const startLocation = locationOf(start);
    expect(new URL(startLocation).searchParams.get("state")).toBeTruthy();
    await starter.dispose();

    const attacker = await newContext();
    const response = await attacker.get(startLocation, {
      headers: { Cookie: `gauth_state=${encodeURIComponent("tampered-state-value")}` },
    });
    await attacker.dispose();

    await expectAuthError(response, "invalid_state");
    expect(findSetCookie(response, "gauth_state")?.["max-age"], "失败路径也要清掉 state Cookie").toBe("0");
  });

  test("state 缺失（query 或 Cookie 任一缺失）→ invalid_state", async () => {
    const context = await newContext();

    const noCookie = await context.get(`${CALLBACK_PATH}?code=qa%3Adeveloper&state=some-state-value`);
    await expectAuthError(noCookie, "invalid_state");

    const noQuery = await context.get(`${CALLBACK_PATH}?code=qa%3Adeveloper`, {
      headers: { Cookie: "gauth_state=some-state-value" },
    });
    await expectAuthError(noQuery, "invalid_state");

    await context.dispose();
  });

  test("Cookie 与 query 一致但 D1 无记录（等价过期/伪造）→ invalid_state", async () => {
    const context = await newContext();
    const forged = `forged-${Date.now()}`;
    const response = await context.get(`${CALLBACK_PATH}?code=qa%3Adeveloper&state=${forged}`, {
      headers: { Cookie: `gauth_state=${forged}` },
    });
    await context.dispose();
    await expectAuthError(response, "invalid_state");
  });

  test("同一个 state 只能消费一次：重放 → invalid_state", async () => {
    const starter = await newContext();
    const start = await startTestLogin(starter);
    const startLocation = locationOf(start);
    const state = new URL(startLocation).searchParams.get("state");
    expect(state).toBeTruthy();
    await starter.dispose();

    const cookieForReplay = { Cookie: `gauth_state=${state}` };

    const first = await newContext();
    const firstCallback = await first.get(startLocation, { headers: cookieForReplay });
    await first.dispose();
    expect(firstCallback.status()).toBe(302);
    expect(locationOf(firstCallback)).toBe(`${API_BASE}/?auth=ok`);

    const second = await newContext();
    const secondCallback = await second.get(startLocation, { headers: cookieForReplay });
    await second.dispose();
    await expectAuthError(secondCallback, "invalid_state");
  });
});

/* ------------------------------------------------------------------ */
/* 5. 测试身份白名单与不支持流程                                        */
/* ------------------------------------------------------------------ */

test.describe("测试身份白名单", () => {
  test("test_login 只接受 qa-<role> 白名单，其余一律 test_login_invalid", async () => {
    const context = await newContext();
    for (const login of ["octocat", "qa-evil", "qa-"]) {
      const response = await startTestLogin(context, `test_login=${encodeURIComponent(login)}`);
      await expectAuthError(response, "test_login_invalid");
    }
    await context.dispose();
  });

  test("回调 code 被换成 qa:evil：state 合法也拿不到身份（oauth_failed）", async () => {
    const starter = await newContext();
    const start = await startTestLogin(starter);
    const startLocation = locationOf(start);
    const state = new URL(startLocation).searchParams.get("state");
    expect(state).toBeTruthy();
    await starter.dispose();

    const callbackUrl = new URL(startLocation);
    callbackUrl.searchParams.set("code", "qa:evil");

    const attacker = await newContext();
    const response = await attacker.get(callbackUrl.toString(), {
      headers: { Cookie: `gauth_state=${state}` },
    });
    await expectAuthError(response, "oauth_failed");
    const me = await attacker.get("/api/auth/me");
    expect((await me.json()).authenticated).toBe(false);
    await attacker.dispose();
  });

  test("join / reauth 流程在测试模式下显式不支持", async () => {
    const context = await newContext();
    const join = await startTestLogin(context, `test_login=${TEST_LOGIN}&mode=join`);
    await expectAuthError(join, "test_login_unsupported");

    const reauth = await startTestLogin(context, `test_login=${TEST_LOGIN}&reauth=delete`);
    await expectAuthError(reauth, "test_login_unsupported");
    await context.dispose();
  });
});