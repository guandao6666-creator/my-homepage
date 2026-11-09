/**
 * Phase 3.3 · 设备配对 / 跨设备接力 / 剪贴板 E2E 的浏览器上下文辅助。
 *
 * 这一层的核心不是「封装 HTTP」，而是把**独立浏览器身份**做成一等公民：
 *
 *   - 每个 Actor 都拥有自己的 `browser.newContext()`，绝不共享 storageState；
 *   - 所有请求都从该 Context 自己的 `context.request` 发出，Cookie 只存在于
 *     这个 Context 的 Cookie jar 里（测试代码不手工拼 Cookie 头）；
 *   - 写请求显式补 `Origin`：真实浏览器会自动带，Playwright 的 request 不会，
 *     这属于还原浏览器行为，不是绕过 Worker 的同源校验。
 *
 * 设备配对 E2E 的全部价值都建立在「B 端一开始没有 Cookie」之上，所以不要为了
 * 省事把 A 的 headers 直接传给 B 的请求。
 */

import type { APIResponse, Browser, BrowserContext, Cookie } from "@playwright/test";

import { API_BASE, as, type FixtureRole, type Fixtures } from "./worker-api";

/** 每轮测试创建的配对设备统一用这个前缀，suite 开始时按前缀清理历史残留。 */
export const QA_DEVICE_PREFIX = "qa-dp-";

/**
 * 移动端 UA。
 *
 * 配对 claim 时 Worker 会从 User-Agent 推导设备画像；固定成 Android + Chrome
 * 才能断言 `device.type === "mobile"`、`browser === "Chrome"`、`os === "Android"`。
 */
export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

export type ActorRole = FixtureRole | "anonymous";

/** 一个独立浏览器身份的句柄。 */
export type ApiActor = {
  label: string;
  role: ActorRole;
  context: BrowserContext;
  /**
   * 本轮测试专用的模拟客户端地址（只用于本地 `wrangler dev`）。
   *
   * 限流（`worker/api/ratelimit.js` 的 `clientIdentity`）优先读 `cf-connecting-ip`；
   * 生产环境该头由 Cloudflare 覆写、客户端无法伪造，而本地所有请求都来自 127.0.0.1，
   * 反复运行会共用同一个计数桶。这里给每个 Actor 分配一次运行内唯一、跨运行随机的
   * 地址，让「上一轮用掉的配额」不影响「这一轮」，同时不改变限流本身的阈值行为。
   */
  clientIp: string;
};

/** 生成短随机后缀，用于隔离并行/连续运行产生的数据。 */
export function uniqueTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从标签派生一个稳定的测试客户端地址。
 *
 * 用 FNV-1a 折叠成 10.x.y.z，不依赖随机源也足够分散；标签里带 `uniqueTag()`，
 * 所以同一 Actor 在一次运行内稳定、不同运行之间不同。
 */
function testClientIp(label: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  const octets = [10, (unsigned >>> 24) & 0xff, (unsigned >>> 16) & 0xff, ((unsigned >>> 8) & 0xff) || 1];
  return octets.join(".");
}

/** 已 seed 的 QA 账号：创建空 Context 后注入它自己的 gauth_sid。 */
export async function newSeededActor(
  browser: Browser,
  fixtures: Fixtures,
  role: FixtureRole,
): Promise<ApiActor> {
  const token = fixtures.tokens[role];
  if (!token) {
    throw new Error(`fixtures.tokens.${role} 为空，e2e-server 可能还没 seed 完 QA 账号`);
  }
  const context = await browser.newContext();
  await context.addCookies([{ name: "gauth_sid", value: token, url: API_BASE }]);
  return { label: role, role, context, clientIp: testClientIp(`seeded:${role}:${uniqueTag()}`) };
}

/** 全新浏览器：初始零 Cookie，模拟「另一台还没接入账号的设备」。 */
export async function newAnonymousActor(
  browser: Browser,
  label: string,
  options: { userAgent?: string } = {},
): Promise<ApiActor> {
  const context = await browser.newContext(options.userAgent ? { userAgent: options.userAgent } : {});
  return { label, role: "anonymous", context, clientIp: testClientIp(`anon:${label}:${uniqueTag()}`) };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export type ApiResult<T = any> = {
  status: number;
  /** 原始 JSON：成功为 `{success:true,data}`，失败为 `{success:false,error}`。 */
  body: any;
  /** `body.data`（仅成功信封有）。 */
  data: T | undefined;
  response: APIResponse;
};

export type ApiOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  /** 故意省略 Origin，用于验证同源校验。 */
  omitOrigin?: boolean;
};

export async function api(
  actor: ApiActor,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const url = new URL(path, API_BASE).toString();
  const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) };
  // 本地限流按 cf-connecting-ip 分桶（生产由 Cloudflare 覆写该头）。每个 Actor 一个
  // 本轮专用地址，避免连续多次运行共用 127.0.0.1 的计数桶。
  headers["cf-connecting-ip"] = actor.clientIp;
  if (method !== "GET" && !options.omitOrigin) headers.origin = API_BASE;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await actor.context.request.fetch(url, {
    method,
    headers,
    data: options.body === undefined ? undefined : JSON.stringify(options.body),
    failOnStatusCode: false,
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `[${actor.label}] ${method} ${path} 返回非 JSON（HTTP ${response.status()}）：${text.slice(0, 300)}`,
      );
    }
  }
  return {
    status: response.status(),
    body,
    data: body && body.success === true ? body.data : undefined,
    response,
  };
}

export function get(actor: ApiActor, path: string, options: ApiOptions = {}) {
  return api(actor, "GET", path, options);
}

export function post(actor: ApiActor, path: string, body?: unknown, options: ApiOptions = {}) {
  return api(actor, "POST", path, { ...options, body });
}

export function del(actor: ApiActor, path: string, options: ApiOptions = {}) {
  return api(actor, "DELETE", path, options);
}

/**
 * 重新播种 e2e-server 的「已过期配对」夹具。
 *
 * 配对接口在 create 时会顺带 `expirePairings()`，把夹具里 status='claimed' 的行翻成
 * 'expired'。同一进程内连续跑第二轮设备 E2E 时，confirm 会先撞 409 PAIRING_STATE，
 * 而不是要验证的 410 PAIRING_EXPIRED。这里调用仅本地存在的夹具管理端点复位，
 * 不改任何 Worker 生产代码、不动限流计数。
 */
export async function reseedExpiredPairings(actor: ApiActor, adminUrl: string | undefined): Promise<void> {
  if (!adminUrl) {
    throw new Error("夹具里缺少 adminUrl：请用 scripts/e2e-server.mjs 启动真实 Worker 再跑设备 E2E");
  }
  const response = await actor.context.request.post(
    new URL("/__e2e/reset-expired", adminUrl).toString(),
    { failOnStatusCode: false, timeout: 20_000 },
  );
  if (response.status() !== 200) {
    throw new Error(
      `重新播种过期配对夹具失败（HTTP ${response.status()}）：${(await response.text()).slice(0, 300)}`,
    );
  }
}

/** 断言成功信封并返回 data；失败时给出可读的诊断信息。 */
export function okData<T = any>(result: ApiResult, expectedStatus: number, label: string): T {
  if (result.status !== expectedStatus || result.body?.success !== true) {
    throw new Error(
      `${label} 失败：期望 HTTP ${expectedStatus} 成功信封，实际 HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`,
    );
  }
  return result.data as T;
}

/** 断言失败信封的状态码与错误码，返回 error 对象。 */
export function expectError(
  result: ApiResult,
  expectedStatus: number,
  expectedCode: string,
  label: string,
): { code: string; message: string } {
  const actualCode = result.body?.error?.code;
  if (result.status !== expectedStatus || result.body?.success !== false || actualCode !== expectedCode) {
    throw new Error(
      `${label} 失败：期望 HTTP ${expectedStatus} / ${expectedCode}，实际 HTTP ${result.status} / ${actualCode ?? "无错误码"} ${JSON.stringify(result.body).slice(0, 500)}`,
    );
  }
  return result.body.error;
}

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

export async function cookiesOf(
  actor: ApiActor,
): Promise<{ session: string | null; device: string | null; all: Cookie[] }> {
  const all = await actor.context.cookies();
  return {
    session: all.find((cookie) => cookie.name === "gauth_sid")?.value ?? null,
    device: all.find((cookie) => cookie.name === "gauth_did")?.value ?? null,
    all,
  };
}

export type PairingCookieBundle = {
  session: string | null;
  device: string | null;
  setCookies: string[];
  headers: Record<string, string>;
};

function cookieValueFromSetCookie(setCookie: string, name: string): string | null {
  if (!setCookie.startsWith(`${name}=`)) return null;
  const firstSegment = setCookie.split(";")[0] ?? "";
  return firstSegment.slice(name.length + 1) || null;
}

/** 从「确认后轮询」的响应里取出服务端下发的 Session / Device Cookie。 */
export function pairingCookiesFrom(response: APIResponse): PairingCookieBundle {
  const setCookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);

  let session: string | null = null;
  let device: string | null = null;
  for (const setCookie of setCookies) {
    session ??= cookieValueFromSetCookie(setCookie, "gauth_sid");
    device ??= cookieValueFromSetCookie(setCookie, "gauth_did");
  }

  return { session, device, setCookies, headers: response.headers() };
}

/**
 * 把服务端下发的一次性 Cookie 显式写进 B 的 Context。
 *
 * `context.request` 与浏览器共享 Cookie jar，正常情况下 Set-Cookie 已经落进去了；
 * 这里再显式接管一次，既幂等，也让「B 用自己的 Session」成为测试里可见的动作。
 */
export async function adoptCookies(actor: ApiActor, bundle: PairingCookieBundle): Promise<void> {
  const cookies: Array<{ name: string; value: string; url: string }> = [];
  if (bundle.session) cookies.push({ name: "gauth_sid", value: bundle.session, url: API_BASE });
  if (bundle.device) cookies.push({ name: "gauth_did", value: bundle.device, url: API_BASE });
  if (cookies.length > 0) await actor.context.addCookies(cookies);
}

/* ------------------------------------------------------------------ */
/* 配对                                                                */
/* ------------------------------------------------------------------ */

export type PairingCreated = {
  pairingId: string;
  code: string;
  token: string;
  expiresAt: number;
  ttl: number;
  qrUrl: string;
  origin: string;
};

export type PairingClaim = {
  pairingId: string;
  claimSecret: string;
  status: "claimed";
  device: { name: string; type: string; browser: string; os: string };
  source: { name: string; type: string };
  expiresAt: number;
};

export type PairingList = {
  items: Array<{
    id: string;
    status: string;
    sourceDeviceId: string;
    sourceName: string;
    sourceType: string;
    targetDeviceId: string | null;
    target: { name: string; type: string; browser: string; os: string } | null;
    attempts: number;
    maxAttempts: number;
    expiresAt: number;
    createdAt: number;
    expired: boolean;
  }>;
  currentDeviceId: string | null;
};

export function createPairing(actor: ApiActor): Promise<ApiResult<PairingCreated>> {
  return post(actor, "/api/pairing/create");
}

export function claimPairing(
  actor: ApiActor,
  identity: { code?: string; token?: string; device?: { name?: string; type?: string } },
): Promise<ApiResult<PairingClaim>> {
  return post(actor, "/api/pairing/claim", identity);
}

export function listPairings(actor: ApiActor): Promise<ApiResult<PairingList>> {
  return get(actor, "/api/pairing");
}

export function confirmPairing(actor: ApiActor, pairingId: string): Promise<ApiResult> {
  return post(actor, `/api/pairing/${pairingId}/confirm`);
}

export function cancelPairing(actor: ApiActor, pairingId: string): Promise<ApiResult> {
  return post(actor, `/api/pairing/${pairingId}/cancel`);
}

/** 轮询领取：200（pending/claimed/completed）、404、410 都要由调用方断言。 */
export function pollPairingClaim(
  actor: ApiActor,
  pairingId: string,
  secret: string,
): Promise<ApiResult> {
  return get(
    actor,
    `/api/pairing/claim/${encodeURIComponent(pairingId)}?secret=${encodeURIComponent(secret)}`,
  );
}

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

export type PublicDevice = {
  id: string;
  name: string;
  type: string;
  browser: string;
  os: string;
  createdAt: number;
  lastSeenAt: number | null;
  lastActiveAt: number | null;
  revokedAt: number | null;
  status: "active" | "revoked";
  trusted: boolean;
  isCurrent: boolean;
  sessionCount: number;
  activeSessionCount: number;
};

export type DevicesOverview = {
  currentDeviceId: string | null;
  account: { displayName: string; githubUsername: string; avatarUrl: string | null; role: string };
  overview: {
    deviceCount: number;
    revokedCount: number;
    activeDeviceCount: number;
    signedInDeviceCount: number;
    activeSessionCount: number;
  };
  devices: PublicDevice[];
  alerts: unknown[];
};

export async function listDevices(actor: ApiActor): Promise<DevicesOverview> {
  return okData<DevicesOverview>(await get(actor, "/api/devices"), 200, "读取设备列表");
}

export function revokeDevice(actor: ApiActor, deviceId: string): Promise<ApiResult> {
  return post(actor, `/api/devices/${encodeURIComponent(deviceId)}/revoke`);
}

/**
 * 清理本轮之前（上一次中断的运行）遗留的配对设备。
 *
 * e2e-server 只在启动时清 D1，跨多次测试运行会累积设备；而 confirm 有
 * MAX_DEVICES=10 的硬上限（只数未撤销设备）。撤销后的设备不占名额，
 * 所以这里通过公开撤销 API 清理，绝不直接改数据库。
 */
export async function cleanupQaPairingDevices(actor: ApiActor): Promise<string[]> {
  const overview = await listDevices(actor);
  const stale = overview.devices.filter(
    (device) => device.status === "active" && device.name.startsWith(QA_DEVICE_PREFIX),
  );
  const removed: string[] = [];
  for (const device of stale) {
    const result = await revokeDevice(actor, device.id);
    if (result.status !== 200) {
      throw new Error(
        `清理历史配对设备失败：${device.name}（${device.id}）HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`,
      );
    }
    removed.push(device.name);
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 跨设备接力                                                          */
/* ------------------------------------------------------------------ */

export type ContinuityItem = {
  id: string;
  itemType: string;
  title: string;
  status: "pending" | "delivered" | "opened" | "completed" | "cancelled" | "expired";
  sourceDeviceId: string | null;
  sourceName: string;
  targetDeviceId: string | null;
  targetName: string;
  outgoing: boolean;
  payload: unknown;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  openedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
};

export type ContinuityInbox = {
  items: ContinuityItem[];
  currentDeviceId: string | null;
  serverTime: number;
};

export type ContinuitySendInput = {
  itemType: string;
  title?: string;
  payload?: unknown;
  resourceId?: string;
  targetDeviceId?: string;
  ttlMs?: number;
};

export function sendContinuity(actor: ApiActor, input: ContinuitySendInput): Promise<ApiResult> {
  return post(actor, "/api/continuity/send", input);
}

export function continuityInbox(actor: ApiActor): Promise<ApiResult<ContinuityInbox>> {
  return get(actor, "/api/continuity/inbox");
}

export function continuityHistory(actor: ApiActor): Promise<ApiResult<ContinuityInbox>> {
  return get(actor, "/api/continuity/history");
}

export function openContinuity(actor: ApiActor, itemId: string): Promise<ApiResult> {
  return post(actor, `/api/continuity/${encodeURIComponent(itemId)}/open`);
}

export function completeContinuity(actor: ApiActor, itemId: string): Promise<ApiResult> {
  return post(actor, `/api/continuity/${encodeURIComponent(itemId)}/complete`);
}

export function cancelContinuity(actor: ApiActor, itemId: string): Promise<ApiResult> {
  return post(actor, `/api/continuity/${encodeURIComponent(itemId)}/cancel`);
}

/* ------------------------------------------------------------------ */
/* 剪贴板                                                              */
/* ------------------------------------------------------------------ */

export type ClipboardEntry = {
  id: string;
  content: string;
  sourceDeviceId: string | null;
  sourceName: string;
  targetDeviceId: string | null;
  outgoing: boolean;
  createdAt: number;
  expiresAt: number;
};

export type ClipboardList = {
  items: ClipboardEntry[];
  ttl: number;
  enabled: boolean;
};

export function sendClipboard(
  actor: ApiActor,
  input: { content: string; targetDeviceId?: string },
): Promise<ApiResult> {
  return post(actor, "/api/clipboard/send", input);
}

export function listClipboard(actor: ApiActor): Promise<ApiResult<ClipboardList>> {
  return get(actor, "/api/clipboard");
}

export function deleteClipboard(actor: ApiActor, clipboardId: string): Promise<ApiResult> {
  return del(actor, `/api/clipboard/${encodeURIComponent(clipboardId)}`);
}