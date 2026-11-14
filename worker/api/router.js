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
import { WORKER_VERSION, VERSION_HEADER } from "./version.js";
import { matchRateRule, rateLimit } from "./ratelimit.js";
import { healthHandler } from "./health.js";
import { handleFilesRequest } from "./files/handlers.js";
import { handleSyncRequest } from "./sync/handlers.js";
import { handleDevicesRequest } from "./devices/handlers.js";
import { handlePairingRequest } from "./pairing/handlers.js";
import { handleContinuityRequest } from "./continuity/handlers.js";
import { handleBackupsRequest } from "./backups/handlers.js";
import { handlePrivacyRequest } from "./privacy/handlers.js";
import { handleCommunityRequest } from "./community/handlers.js";
import { handleAdminRequest } from "./admin/r2.js";
import { handleAdminMonitorRequest } from "./admin/monitor.js";
import { handleAdminBackupRequest } from "./admin/backup.js";
import { handlePluginsRequest } from "./plugins/handlers.js";
import { handleDeveloperRequest } from "./plugins/developer.js";
import {
  authCallback,
  authDevices,
  authInitialize,
  authLogout,
  authMe,
  authStart,
  authStatus,
  authUpdateProfile,
} from "./auth/handlers.js";

const ROUTES = new Map([
  ["/api/health", { handler: healthHandler, methods: ["GET", "HEAD"] }],

  ["/api/auth/status", { handler: authStatus, methods: ["GET"] }],
  ["/api/auth/github", { handler: authStart, methods: ["GET"] }],
  ["/api/auth/github/callback", { handler: authCallback, methods: ["GET"] }],
  ["/api/auth/me", { handler: authMe, methods: ["GET"] }],
  ["/api/auth/logout", { handler: authLogout, methods: ["POST"] }],
  ["/api/auth/initialize", { handler: authInitialize, methods: ["POST"] }],
  ["/api/auth/profile", { handler: authUpdateProfile, methods: ["PATCH"] }],
  ["/api/auth/devices", { handler: authDevices, methods: ["GET"] }],
]);

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
    // 频率限制先于任何业务逻辑执行：登录、上传、导出、删除、下载、同步都有独立配额，
    // 其余接口走宽松的全局上限。
    // 2.0：/api/health 不再完全跳过限流（120 次/分钟），避免匿名探针无限消耗 D1 + R2。
    let gate = null;
    {
      const rule = matchRateRule(path, request.method);
      gate = await rateLimit(env, request, rule);
      if (!gate.allowed) {
        return fail(
          new ApiError("RATE_LIMITED", `请求过于频繁，请 ${gate.retryAfter} 秒后再试`, 429),
          {
            requestId,
            headers: {
              "retry-after": String(gate.retryAfter),
              "x-ratelimit-limit": String(gate.limit),
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.ceil(gate.resetAt / 1000)),
            },
          },
        );
      }
    }

    const stamp = (response) => {
      try {
        response.headers.set("x-request-id", requestId);
        // 1.9：所有 API 响应都带版本，方便确认线上到底跑的是哪一版
        response.headers.set(VERSION_HEADER, WORKER_VERSION);
        if (gate) {
          response.headers.set("x-ratelimit-limit", String(gate.limit));
          response.headers.set("x-ratelimit-remaining", String(gate.remaining));
        }
      } catch {
        // 上游 fetch 响应头可能是 immutable，这里不为了两个诊断头重建响应体。
      }
      return response;
    };

    const pluginsResponse = await handlePluginsRequest({ request, env, url, path });
    if (pluginsResponse) return stamp(pluginsResponse);

    const adminResponse = await handleAdminRequest({ request, env, url, path });
    if (adminResponse) return stamp(adminResponse);

    const monitorResponse = await handleAdminMonitorRequest({ request, env, url, path });
    if (monitorResponse) return stamp(monitorResponse);

    const backupResponse = await handleAdminBackupRequest({ request, env, url, path });
    if (backupResponse) return stamp(backupResponse);

    const developerResponse = await handleDeveloperRequest({ request, env, url, path });
    if (developerResponse) return stamp(developerResponse);

    const communityResponse = await handleCommunityRequest({ request, env, url, path });
    if (communityResponse) return stamp(communityResponse);

    const filesResponse = await handleFilesRequest({ request, env, url, path });
    if (filesResponse) return stamp(filesResponse);

    const syncResponse = await handleSyncRequest({ request, env, url, path });
    if (syncResponse) return stamp(syncResponse);

    const pairingResponse = await handlePairingRequest({ request, env, url, path });
    if (pairingResponse) return stamp(pairingResponse);

    const continuityResponse = await handleContinuityRequest({ request, env, url, path });
    if (continuityResponse) return stamp(continuityResponse);

    const devicesResponse = await handleDevicesRequest({ request, env, url, path });
    if (devicesResponse) return stamp(devicesResponse);

    const backupsResponse = await handleBackupsRequest({ request, env, url, path });
    if (backupsResponse) return stamp(backupsResponse);

    const privacyResponse = await handlePrivacyRequest({ request, env, url, path });
    if (privacyResponse) return stamp(privacyResponse);

    if (!route) {
      throw new ApiError("NOT_FOUND", "接口不存在", 404);
    }

    if (!route.methods.includes(request.method)) {
      const allow = route.methods.join(", ");
      return fail(new ApiError("METHOD_NOT_ALLOWED", `该接口仅支持 ${allow}`, 405), {
        requestId,
        headers: { allow },
      });
    }

    const response = await route.handler({ request, env, requestId, url });
    response.headers.set("x-request-id", requestId);

    // HEAD 与 GET 同状态、同头部，但不返回响应体。
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }

    return stamp(response);
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
