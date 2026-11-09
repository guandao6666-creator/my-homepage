/**
 * Worker API 统一请求边界（Guandao OS 2.0 · Phase 1）。
 *
 * 2.0 之前同源校验、JSON 读取、Session 读取在 8 个模块里各写了一份，
 * 行为已经开始漂移（例如 sync 允许缺失 Origin，其余模块不允许）。
 * 这里收敛成唯一实现：错误码、状态码、文案保持与旧代码一致，
 * 各模块只保留业务逻辑。
 *
 * 约定：
 * - 写入接口必须先过 assertSameOrigin（Cookie 是 SameSite=Lax，但仍显式校验）；
 * - 所有 JSON 体必须走 readJsonLimited（content-length + 实际字节双重复核）；
 * - 未登录统一 UNAUTHENTICATED / 401，来源不符统一 CSRF_REJECTED / 403。
 */

import { ApiError, readJsonLimited } from "./http.js";
import { authConfig } from "./auth/config.js";
import { inspectSession, readSession } from "./auth/session.js";

export { readJsonLimited };

/**
 * 校验请求来源。
 *
 * 规则（与 1.9 多数模块一致，2.0 统一为严格模式）：
 * - 有 Origin 时必须与站点 Origin 完全一致；
 * - 没有 Origin 时，只接受 Sec-Fetch-Site: same-origin（同源页面导航）；
 * - 其余一律 403 CSRF_REJECTED。
 *
 * 注意：这里刻意不接受 Sec-Fetch-Site: none。sync 之前在缺失 Origin 时放行，
 * 但同步接口只服务浏览器同源页面，严格校验不会影响合法客户端。
 */
export function assertSameOrigin(request, origin) {
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

/** 需要从 env 推导站点 Origin 的模块（community / plugins）。 */
export function assertSameOriginFor(request, env) {
  return assertSameOrigin(request, authConfig(env, request).origin);
}

/**
 * 读取有上限的 JSON 请求体。
 * 第二个参数是字节上限；默认 1 MB，调用方按接口收紧（如认证 4 KB、设备 8 KB）。
 */
export async function readJson(request, maxBytes = 1_000_000) {
  return readJsonLimited(request, maxBytes);
}

/**
 * 读取登录会话；没有会话直接抛 401。
 *
 * @param {{ DB?: D1Database }} env
 * @param {Request} request
 * @param {{ message?: string }} [options]
 */
export async function requireSession(env, request, options = {}) {
  const session = await readSession(env, request);
  if (!session) {
    throw new ApiError("UNAUTHENTICATED", options.message ?? "请先登录", 401);
  }
  return session;
}

/** 读取会话，但允许匿名（公开列表、媒体读取等）。 */
export async function sessionOrNull(env, request) {
  return readSession(env, request);
}

/**
 * 会话失效原因 → 统一 401 错误码。
 *
 * 2.0 审计发现：devices 能区分 SESSION_REVOKED / DEVICE_REVOKED / SESSION_EXPIRED，
 * 而 continuity / clipboard / pairing 把所有失效都折叠成 UNAUTHENTICATED，
 * 客户端无法判断「账号可能已从其他设备退出」还是「从未登录」。
 * 这里收敛成唯一映射，所有需要登录的模块共用。
 */
export function sessionFailure(state) {
  if (state === "device_revoked") {
    return new ApiError("DEVICE_REVOKED", "该设备已被撤销登录权限", 401);
  }
  if (state === "revoked") {
    return new ApiError("SESSION_REVOKED", "登录已在其他设备被撤销", 401);
  }
  if (state === "expired") {
    return new ApiError("SESSION_EXPIRED", "登录已过期，请重新登录", 401);
  }
  if (state === "disabled") {
    return new ApiError("ACCOUNT_DISABLED", "账号已被停用", 401);
  }
  return new ApiError("UNAUTHENTICATED", "请先登录", 401);
}

/**
 * 需要活跃会话；失败时按原因抛 401。
 * 注意 pending_deletion 的会话在 inspectSession 里仍带 session，会正常放行，
 * 由账号删除流程自行决定可见范围（与 devices 模块既有行为一致）。
 */
export async function requireActiveSession(env, request) {
  const inspected = await inspectSession(env, request);
  if (!inspected.session) throw sessionFailure(inspected.state);
  return inspected;
}

/**
 * 统一的安全头检查：只允许同源页面发起的 JSON 写请求。
 * 目前没有额外自定义头要求；保留这个入口，避免各模块再各写一份。
 */
export function assertJsonRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "请求必须是 JSON", 415);
  }
}