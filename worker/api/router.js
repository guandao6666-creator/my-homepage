/**
 * /api/* 路由分发。
 *
 * 这里刻意不用文件系统路由（Pages Functions 那套），原因是本项目部署为
 * Worker + Static Assets，`functions/` 目录不会被执行。详见 worker/index.js 注释。
 *
 * 规则：
 * - 未知路径返回 JSON 404，绝不回退到静态资源（避免拿到 HTML 404 页）；
 * - 方法不在白名单内返回 405，并带 Allow 头；
 * - 任何未捕获异常统一折叠为 500 INTERNAL_ERROR。
 */

import { ApiError, fail, toApiError } from "./http.js";
import { healthHandler } from "./health.js";

const ROUTES = new Map([
  ["/api/health", { handler: healthHandler, methods: ["GET", "HEAD"] }],
]);

const ALLOWED_METHODS = "GET, HEAD";

/**
 * @param {Request} request
 * @param {{ DB?: D1Database, FILES?: R2Bucket }} env
 */
export async function handleApiRequest(request, env) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const route = ROUTES.get(path);

  try {
    if (!route) {
      throw new ApiError("NOT_FOUND", "接口不存在", 404);
    }

    if (!route.methods.includes(request.method)) {
      return fail(new ApiError("METHOD_NOT_ALLOWED", `该接口仅支持 ${ALLOWED_METHODS}`, 405), {
        requestId,
        headers: { allow: ALLOWED_METHODS },
      });
    }

    const response = await route.handler({ request, env, requestId });
    response.headers.set("x-request-id", requestId);

    // HEAD 与 GET 同状态、同头部，但不返回响应体。
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }

    return response;
  } catch (error) {
    if (!(error instanceof ApiError)) {
      console.error(`[api] ${requestId} unhandled:`, error?.stack ?? error);
    }
    return fail(toApiError(error), { requestId });
  }
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}
