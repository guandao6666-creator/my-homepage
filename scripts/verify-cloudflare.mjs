#!/usr/bin/env node
/**
 * Cloudflare 后端连通性校验。
 *
 * 用法：
 *   npm run verify:cloudflare
 *   npm run verify:cloudflare -- --base http://127.0.0.1:8788
 *   npm run verify:cloudflare -- --allow-degraded   # D1/R2 异常时只告警，不失败
 *
 * 校验项：
 *   1. 首页、博客列表仍可访问；
 *   2. /api/health 返回 JSON，D1 为 connected、R2 为 available；
 *   3. 健康响应不泄露内部信息；
 *   4. 非 GET/HEAD 返回 405 且带 Allow 头；
 *   5. 未注册的 /api/* 返回 JSON 404，而不是静态 HTML。
 */

const DEFAULT_BASE = "https://guandao.xin";
const TIMEOUT_MS = 15_000;

const args = process.argv.slice(2);
const base = readOption("--base") ?? process.env.VERIFY_BASE_URL ?? DEFAULT_BASE;
const allowDegraded = args.includes("--allow-degraded");

function readOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

/** @type {{ name: string, run: () => Promise<{ ok: boolean, detail: string, warn?: boolean }> }[]} */
const checks = [];

checks.push({
  name: "首页可访问",
  run: async () => {
    const { response, body } = await request("/");
    const ok = response.status === 200 && /text\/html/i.test(response.headers.get("content-type") ?? "") && body.length > 0;
    return { ok, detail: `${response.status} ${response.headers.get("content-type") ?? "?"}` };
  },
});

checks.push({
  name: "博客列表可访问",
  run: async () => {
    const { response, body } = await request("/blog/");
    const ok = response.status === 200 && /text\/html/i.test(response.headers.get("content-type") ?? "") && body.length > 0;
    return { ok, detail: `${response.status} ${response.headers.get("content-type") ?? "?"}` };
  },
});

checks.push({
  name: "健康接口返回 ok",
  run: async () => {
    const { response, body } = await request("/api/health", { headers: { accept: "application/json" } });
    const type = response.headers.get("content-type") ?? "";

    if (!/application\/json/i.test(type)) {
      return { ok: false, detail: `Content-Type 不是 JSON：${type || "（缺失）"}` };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, detail: "响应体不是合法 JSON" };
    }

    const d1 = payload?.services?.d1;
    const r2 = payload?.services?.r2;
    const summary = `${response.status} d1=${d1 ?? "?"} r2=${r2 ?? "?"}`;

    const healthy = response.status === 200 && payload?.success === true && d1 === "connected" && r2 === "available";
    if (healthy) return { ok: true, detail: summary };

    if (allowDegraded) {
      return { ok: true, warn: true, detail: `${summary}（降级，已按 --allow-degraded 放行）` };
    }
    return { ok: false, detail: summary };
  },
});

checks.push({
  name: "健康响应不泄露内部信息",
  run: async () => {
    const { body } = await request("/api/health");
    const forbidden = ["stack", "sqlite", "guandao-db", "guandao-files", "supabase", "d1_error", "select 1"];
    const hits = forbidden.filter((token) => body.toLowerCase().includes(token));
    return {
      ok: hits.length === 0,
      detail: hits.length === 0 ? "未发现敏感字段" : `出现可疑字段：${hits.join(", ")}`,
    };
  },
});

checks.push({
  name: "健康接口只允许 GET/HEAD",
  run: async () => {
    const { response, body } = await request("/api/health", { method: "POST" });
    const allow = response.headers.get("allow") ?? "";

    let code = null;
    try {
      code = JSON.parse(body)?.error?.code ?? null;
    } catch {
      /* 忽略解析失败，下面统一判定 */
    }

    const ok = response.status === 405 && /GET/i.test(allow) && code === "METHOD_NOT_ALLOWED";
    return { ok, detail: `${response.status} allow=${allow || "（缺失）"} code=${code ?? "?"}` };
  },
});

checks.push({
  name: "未知 /api 路径返回 JSON 404",
  run: async () => {
    const { response, body } = await request("/api/__probe__");
    const type = response.headers.get("content-type") ?? "";

    let code = null;
    try {
      code = JSON.parse(body)?.error?.code ?? null;
    } catch {
      /* 同上 */
    }

    const ok = response.status === 404 && /application\/json/i.test(type) && code === "NOT_FOUND";
    return { ok, detail: `${response.status} ${type || "?"} code=${code ?? "?"}` };
  },
});

checks.push({
  name: "HEAD 请求不返回响应体",
  run: async () => {
    const { response, body } = await request("/api/health", { method: "HEAD" });
    const statusOk = response.status === 200 || (allowDegraded && response.status === 503);
    const ok = statusOk && body.length === 0;
    return { ok, detail: `${response.status} body=${body.length}B` };
  },
});

async function request(pathname, init = {}) {
  const url = new URL(pathname, base).toString();
  const response = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { "user-agent": "guandao-os-verify/1.5", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  return { response, body };
}

async function main() {
  console.log(`Cloudflare 后端校验 · ${base}`);
  console.log("─".repeat(52));

  let failed = 0;
  let warned = 0;

  for (const check of checks) {
    try {
      const result = await check.run();
      if (result.ok && result.warn) {
        warned += 1;
        console.log(`! ${check.name} — ${result.detail}`);
      } else if (result.ok) {
        console.log(`✓ ${check.name} — ${result.detail}`);
      } else {
        failed += 1;
        console.log(`✗ ${check.name} — ${result.detail}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`✗ ${check.name} — 请求失败：${error?.message ?? error}`);
    }
  }

  console.log("─".repeat(52));
  const passed = checks.length - failed - warned;
  console.log(`通过 ${passed}/${checks.length}${warned ? `，告警 ${warned}` : ""}${failed ? `，失败 ${failed}` : ""}`);

  if (failed > 0) {
    process.exitCode = 1;
    console.log("提示：本地可用 `npm run cf:dev` 启动 Worker 后再跑 --base http://127.0.0.1:8788。");
  }
}

main();
