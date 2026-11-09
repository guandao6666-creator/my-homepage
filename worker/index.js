/**
 * Cloudflare Worker 入口（Worker + Static Assets）。
 *
 * 注意架构：本项目不是 Cloudflare Pages，也不使用 Pages Functions。
 * `functions/` 目录在 Worker 部署模式下不会被执行（历史提交已踩过这个坑），
 * 所以后端接口统一挂在这里，由 worker/api/* 处理。
 *
 * 职责：
 * 1. /api/*      → worker/api/router.js（D1 / R2 连通性等）
 * 2. /sb/*       → 反向代理到 Supabase（国内直连 *.supabase.co 容易挂住）
 * 3. 其余请求    → 原样交给静态资源（env.ASSETS）
 */

import { handleApiRequest } from "./api/router.js";
import { rateLimit } from "./api/ratelimit.js";
import { runScheduledBackups } from "./api/backups/handlers.js";
import { runDeletionMaintenance, runPrivacyCleanup } from "./api/privacy/handlers.js";
import { runDataMonitor, runBackupMonitor } from "./api/admin/monitor.js";
import { runCommunityMaintenance } from "./api/community/maintenance.js";
import { SCRIPT_HASHES } from "./api/csp-hashes.js";

// Workflow 类必须从 Worker 入口导出，供 Workflows binding 绑定。
export { D1BackupWorkflow } from "./workflows/d1-backup.js";

const SUPABASE_HOST = "mkcnftjhftpiofnhenjf.supabase.co";

/**
 * /sb 同源反代（Supabase）的限制。
 *
 * 2.0 之前这个代理不限流、不限路径、不限方法，等于给任何人一个免费中继；
 * 现在：
 *   - 只放行 /rest/v1、/auth/v1、/storage/v1 三个前缀（页面实际只用到这三个）；
 *   - 只接受常见的 HTTP 方法；
 *   - 每 IP 300 次 / 分钟（页面首屏最多几十次请求，正常使用不会碰到）；
 *   - 上游错误不再回显 err.message。
 */
const SUPABASE_PROXY_PREFIX = /^\/(rest|auth|storage)\/v1\//;
const SUPABASE_PROXY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const simpleJson = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

/**
 * 手机访问站点根地址时，在服务端直接 302 到手机伴侣。
 *
 * 为什么不在页面里跳：`/` 的 HTML 会带出 497 KB 的桌面主包，
 * 手机先下载再跳走会白费流量，首屏也更慢。
 * `?desktop=1` 是底栏「桌面」入口的显式选择，服务端不再拦截。
 */
const MOBILE_UA = /iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/i;

function isMobileDocumentRequest(request) {
  const hint = request.headers.get("sec-ch-ua-mobile");
  if (hint === "?1") return true;
  if (hint === "?0") return false;
  return MOBILE_UA.test(request.headers.get("user-agent") || "");
}

function mobileCompanionRedirect(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname !== "/" && url.pathname !== "/index.html") return null;
  if (url.searchParams.get("desktop") === "1") return null;
  if (!isMobileDocumentRequest(request)) return null;
  const target = new URL("/m/", url.origin);
  target.search = url.search;
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

/**
 * 内联脚本按内容哈希放行（构建时由 scripts/gen-csp.mjs 生成）。
 * 拿不到哈希时退回 'unsafe-inline'，保证不会因为构建顺序把页面打死。
 */
const SCRIPT_SRC = SCRIPT_HASHES.length
  ? `script-src 'self' ${SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ")} https://static.cloudflareinsights.com`
  : "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";

/**
 * 插件沙箱专用 CSP。
 *
 * /sandbox/runner.html 只会被 sandbox="allow-scripts" 的 iframe 加载：
 * 文档的实际 origin 是 opaque（"null"），拿不到宿主 Cookie / LocalStorage / DOM。
 * 为了让第三方插件自己的内联脚本能跑，这里必须放开 'unsafe-inline'；
 * 但网络出口被 connect-src 'none' 彻底关死，插件要联网只能走宿主 Broker，
 * 图片也只允许 data:/blob:，避免用 <img> 做数据外泄。
 */
const SANDBOX_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  SCRIPT_SRC,
  // 桌面有大量内联 style 属性（窗口位置、主题变量），无法用哈希逐个覆盖。
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  // 天气组件直接请求 open-meteo；Supabase 走同源 /sb 代理但保留直连白名单；
  // Cloudflare 会向 HTML 注入 Web Analytics beacon，这里显式放行并接受其上报。
  "connect-src 'self' https://api.open-meteo.com https://*.supabase.co https://cloudflareinsights.com",
  // Cloud Drive 的 PDF 预览使用 blob: URL 的 iframe。
  "frame-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://github.com",
  "object-src 'none'",
].join("; ");

/**
 * 统一安全响应头。
 * CSP 已从 Report-Only 切换为强制模式：脚本靠内容哈希放行，
 * 没有 unsafe-eval；样式保留 unsafe-inline（内联 style 属性）。
 */
function secure(response, request) {
  const url = new URL(request.url);
  const isSandbox = url.pathname === "/sandbox" || url.pathname.startsWith("/sandbox/");
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");

  if (isSandbox) {
    // 沙箱文档必须允许被主页面 iframe 嵌入；其余安全头保持最小集。
    headers.delete("x-frame-options");
    headers.delete("cross-origin-opener-policy");
    headers.set("content-security-policy", SANDBOX_CONTENT_SECURITY_POLICY);
    headers.set("cache-control", "no-store");
  } else {
    headers.set("x-frame-options", "DENY");
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  }

  if (url.protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const companion = mobileCompanionRedirect(request, url);
    if (companion) return secure(companion, request);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    if (url.pathname === "/sb" || url.pathname.startsWith("/sb/")) {
      const rest = url.pathname.slice(3) || "/";

      // 只代理页面真正用到的 Supabase 前缀，其余一律 404（不给开放式中继）
      if (!SUPABASE_PROXY_PREFIX.test(rest)) {
        return secure(simpleJson(404, { success: false, error: { code: "NOT_FOUND", message: "接口不存在" } }), request);
      }
      if (!SUPABASE_PROXY_METHODS.has(request.method)) {
        return secure(
          simpleJson(
            405,
            { success: false, error: { code: "METHOD_NOT_ALLOWED", message: "该接口不支持这个请求方法" } },
            { allow: [...SUPABASE_PROXY_METHODS].join(", ") },
          ),
          request,
        );
      }

      const gate = await rateLimit(env, request, {
        rule: "supabase-proxy",
        label: "同源代理请求",
        limit: 300,
        windowMs: 60_000,
      });
      if (!gate.allowed) {
        return secure(
          simpleJson(
            429,
            { success: false, error: { code: "RATE_LIMITED", message: `请求过于频繁，请 ${gate.retryAfter} 秒后再试` } },
            { "retry-after": String(gate.retryAfter) },
          ),
          request,
        );
      }

      const target = new URL(`https://${SUPABASE_HOST}${rest}`);
      target.search = url.search;

      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("cf-connecting-ip");
      headers.delete("cf-ipcountry");
      headers.delete("cf-ray");
      headers.delete("cf-visitor");
      // 1.9 安全修复：/sb 是同源代理，浏览器会自动带上 guandao.xin 的 Cookie。
      // 这些 Cookie 属于本站会话，绝不能透传给 Supabase（第三方）。
      headers.delete("cookie");
      headers.delete("authorization");
      headers.set("origin", `https://${SUPABASE_HOST}`);
      headers.set("referer", `https://${SUPABASE_HOST}/`);

      const hasBody = !["GET", "HEAD"].includes(request.method);

      let upstream;
      try {
        upstream = await fetch(target.toString(), {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          redirect: "follow",
        });
      } catch (error) {
        // 不回显上游错误细节（可能包含内网/项目信息）
        console.error("[proxy] /sb upstream failed:", error?.name ?? "error");
        return secure(
          simpleJson(502, { success: false, error: { code: "UPSTREAM_ERROR", message: "上游服务暂时不可用" } }),
          request,
        );
      }

      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      out.delete("transfer-encoding");
      out.set("access-control-allow-origin", "*");

      return secure(
        new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: out,
        }),
        request,
      );
    }

    const asset = await env.ASSETS.fetch(request);

    // 404 页面绝不能被边缘缓存：
    // 部署前访问过某个路径的人，否则会在部署后继续拿到缓存里的 404
    // （/api/health 就这样被"记住"过）。CDN-Cache-Control 直接约束 Cloudflare 边缘。
    if (asset.status === 404) {
      const headers = new Headers(asset.headers);
      headers.set("cache-control", "no-store");
      headers.set("cdn-cache-control", "no-store");
      return secure(
        new Response(asset.body, {
          status: 404,
          statusText: asset.statusText,
          headers,
        }),
        request,
      );
    }

    return secure(asset, request);
  },

  /**
   * Cloudflare Cron Trigger：每 15 分钟一次。
   * - 自动备份按 daily/weekly 到期判断，多触发不会重复备份；
   * - 续跑无人轮询的删除 / 注销任务（关掉页面也能删完）；
   * - 清理过期导出包、超期安全日志与限流窗口。
   */
  async scheduled(event, env, ctx) {
    // Phase 1.6：Workflows 的 schedules 需要付费 Workers 计划；
    // 这里用现有 Cron Trigger 在 UTC 19:00 创建每日备份实例，不依赖付费 schedule。
    if (event.cron === "0 19 * * *" && env.BACKUP_WORKFLOW) {
      const day = new Date().toISOString().slice(0, 10);
      ctx.waitUntil(
        env.BACKUP_WORKFLOW.create({ id: `d1-backup-${day}` }).catch((error) => {
          console.error("[d1-backup] workflow create failed:", error?.message ?? error);
        }),
      );
    }
    ctx.waitUntil(
      runScheduledBackups(env).catch((error) => {
        console.error("[backups] scheduled run failed:", error?.message ?? error);
      }),
    );
    ctx.waitUntil(
      runPrivacyCleanup(env).catch((error) => {
        console.error("[privacy] cleanup failed:", error?.message ?? error);
      }),
    );
    ctx.waitUntil(
      runDeletionMaintenance(env).catch((error) => {
        console.error("[privacy] deletion resume failed:", error?.message ?? error);
      }),
    );
    ctx.waitUntil(
      runCommunityMaintenance(env).catch((error) => {
        console.error("[community] maintenance failed:", error?.message ?? error);
      }),
    );
    // 2.0：每 15 分钟做一次只读数据量检查；失败只记录，不影响请求。
    ctx.waitUntil(
      runDataMonitor(env).catch((error) => {
        console.error("[monitor] data monitor failed:", error?.message ?? error);
      }),
    );
    // 1.6：检查独立 R2 备份状态；无绑定/无记录时报告 unknown，不伪装健康。
    ctx.waitUntil(
      runBackupMonitor(env).catch((error) => {
        console.error("[monitor] backup monitor failed:", error?.message ?? error);
      }),
    );
  },
};
