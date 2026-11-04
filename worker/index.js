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

const SUPABASE_HOST = "mkcnftjhftpiofnhenjf.supabase.co";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    if (url.pathname === "/sb" || url.pathname.startsWith("/sb/")) {
      const rest = url.pathname.slice(3) || "/";
      const target = new URL(`https://${SUPABASE_HOST}${rest}`);
      target.search = url.search;

      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("cf-connecting-ip");
      headers.delete("cf-ipcountry");
      headers.delete("cf-ray");
      headers.delete("cf-visitor");
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
      } catch (err) {
        return new Response(`proxy error: ${err.message}`, { status: 502 });
      }

      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      out.delete("transfer-encoding");
      out.set("access-control-allow-origin", "*");

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: out,
      });
    }

    return env.ASSETS.fetch(request);
  },
};
