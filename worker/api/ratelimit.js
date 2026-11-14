/**
 * Guandao OS · 请求频率限制
 *
 * 设计取舍：
 * 1. 计数落在 D1（固定窗口），跨 isolate、跨 colo 生效；不用 Durable Object，
 *    避免为「每 IP 一个计数器」引入额外的付费资源与迁移成本。
 * 2. 身份只保存 SHA-256 前缀（带窗口起点一起哈希），不落库 IP 原文，
 *    窗口结束后哈希不可关联，降低日志隐私风险。
 * 3. D1 写入失败时退化为 isolate 内存计数，fail-open 但会在安全中心标记
 *    「限流降级」，不假装已经完全生效。
 * 4. 规则只覆盖高风险与高成本接口；普通读接口走一个宽松的全局上限，
 *    避免把正常使用误伤成 429。
 */

import { sha256Hex } from "./auth/crypto.js";

/** 全局兜底：同一 IP 每分钟最多 600 次 /api/* 请求。 */
export const GLOBAL_RULE = {
  rule: "api-global",
  label: "API 总请求",
  limit: 600,
  windowMs: 60_000,
};

/**
 * 健康检查：供监控探活，额度给得宽但不无限。
 * 1.x 直接把 /api/health 排除在限流之外，等于一个免费且不限量的 D1 + R2 探针。
 */
export const HEALTH_RULE = {
  rule: "api-health",
  label: "健康检查",
  method: "GET",
  test: (path) => path === "/api/health",
  limit: 120,
  windowMs: 60_000,
};

/**
 * 敏感接口规则。
 * test(path) 只匹配路径，method 为空表示不限制方法。
 */
export const RATE_RULES = [
  HEALTH_RULE,
  {
    rule: "sync-pull",
    label: "云同步拉取",
    method: "GET",
    test: (path) => path.startsWith("/api/sync/"),
    limit: 600,
    windowMs: 60 * 60_000,
  },
  {
    rule: "sync-push",
    label: "云同步推送",
    method: "POST",
    test: (path) => path === "/api/sync/push",
    limit: 300,
    windowMs: 60 * 60_000,
  },
  {
    rule: "auth-start",
    label: "发起 GitHub 登录",
    method: "GET",
    test: (path) => path === "/api/auth/github",
    limit: 20,
    windowMs: 60_000,
  },
  {
    rule: "auth-callback",
    label: "OAuth 回调",
    method: "GET",
    test: (path) => path === "/api/auth/github/callback",
    limit: 40,
    windowMs: 60_000,
  },
  {
    rule: "auth-initialize",
    label: "初始化管理员",
    method: "POST",
    test: (path) => path === "/api/auth/initialize",
    limit: 5,
    windowMs: 10 * 60_000,
  },
  {
    // 1.9：配对码是 6 位数字，一条 20 次/10 分钟的通用额度对枚举来说仍偏宽松。
    // 单独收紧到 10 次 / 10 分钟，配合 max_attempts 一起挡住暴力尝试。
    rule: "pairing-claim",
    label: "设备配对尝试",
    method: "POST",
    test: (path) => path === "/api/pairing/claim",
    limit: 10,
    windowMs: 10 * 60_000,
  },
  {
    rule: "file-upload",
    label: "文件上传",
    method: "POST",
    test: (path) => path === "/api/files/upload",
    limit: 60,
    windowMs: 10 * 60_000,
  },
  {
    // 1.9：此前落到了 600/分钟的全局兜底。下载是 R2 → Worker 的整段转发，
    // 成本远高于普通 JSON 接口，单独收紧。
    rule: "file-content",
    label: "文件下载",
    method: "GET",
    test: (path) => /^\/api\/files\/[^/]+\/download$/.test(path),
    limit: 120,
    windowMs: 10 * 60_000,
  },
  {
    rule: "file-download",
    label: "文件下载",
    method: "GET",
    test: (path) => /^\/api\/files\/[^/]+\/content$/.test(path),
    limit: 120,
    windowMs: 10 * 60_000,
  },
  {
    rule: "backup-create",
    label: "创建备份",
    method: "POST",
    test: (path) => path === "/api/backups",
    limit: 20,
    windowMs: 60 * 60_000,
  },
  {
    rule: "backup-run",
    label: "备份 / 校验分批执行",
    method: "POST",
    test: (path) => /^\/api\/backups\/[^/]+\/(run|verify)$/.test(path),
    limit: 400,
    windowMs: 60 * 60_000,
  },
  {
    rule: "backup-download",
    label: "备份下载",
    method: "GET",
    test: (path) => /^\/api\/backups\/[^/]+\/(download|export)$/.test(path),
    limit: 60,
    windowMs: 10 * 60_000,
  },
  {
    rule: "backup-restore",
    label: "恢复备份",
    method: "POST",
    test: (path) => /^\/api\/backups\/[^/]+\/restore(\/|$)/.test(path),
    limit: 20,
    windowMs: 60 * 60_000,
  },
  {
    // 1.9：恢复记录的 run 与恢复预览此前都落到 600/分钟的全局兜底。
    rule: "restore-run",
    label: "恢复 / 预览分批执行",
    method: "POST",
    test: (path) => /^\/api\/backups\/restores\/[^/]+\/run$/.test(path) || /^\/api\/backups\/[^/]+\/restore\/preview$/.test(path),
    limit: 240,
    windowMs: 60 * 60_000,
  },
  {
    rule: "export-create",
    label: "创建数据导出",
    method: "POST",
    test: (path) => path === "/api/privacy/export",
    limit: 6,
    windowMs: 60 * 60_000,
  },
  {
    rule: "export-download",
    label: "导出包下载",
    method: "GET",
    test: (path) => /^\/api\/privacy\/export\/[^/]+\/download$/.test(path),
    limit: 60,
    windowMs: 10 * 60_000,
  },
  {
    rule: "export-run",
    label: "导出分批执行",
    method: "POST",
    test: (path) => /^\/api\/privacy\/export\/[^/]+\/run$/.test(path),
    limit: 400,
    windowMs: 60 * 60_000,
  },
  {
    rule: "delete-data",
    label: "删除云端数据",
    method: "POST",
    test: (path) => path === "/api/privacy/delete-data",
    limit: 10,
    windowMs: 60 * 60_000,
  },
  {
    rule: "deletion-run",
    label: "删除任务分批执行",
    method: "POST",
    test: (path) => /^\/api\/privacy\/deletion\/[^/]+\/run$/.test(path),
    limit: 400,
    windowMs: 60 * 60_000,
  },
  {
    rule: "delete-account",
    label: "注销账号",
    method: "POST",
    test: (path) => path === "/api/privacy/delete-account",
    limit: 3,
    windowMs: 60 * 60_000,
  },
  {
    rule: "community-upload",
    label: "社区图片上传",
    method: "POST",
    test: (path) => path === "/api/community/uploads",
    limit: 40,
    windowMs: 10 * 60_000,
  },
  {
    rule: "community-comment",
    label: "社区评论",
    method: "POST",
    test: (path) => /^\/api\/community\/posts\/[^/]+\/comments$/.test(path),
    limit: 40,
    windowMs: 10 * 60_000,
  },
  {
    rule: "community-write",
    label: "社区写入",
    methods: ["POST", "PATCH", "DELETE"],
    test: (path) =>
      path.startsWith("/api/community/") &&
      path !== "/api/community/uploads" &&
      !path.startsWith("/api/community/media/"),
    limit: 240,
    windowMs: 10 * 60_000,
  },
  {
    rule: "community-media",
    label: "社区图片读取",
    method: "GET",
    test: (path) => path.startsWith("/api/community/media/"),
    limit: 6000,
    windowMs: 10 * 60_000,
  },
  {
    rule: "plugin-upload",
    label: "插件包上传",
    method: "POST",
    test: (path) => /^\/api\/developer\/plugins\/[^/]+\/versions$/.test(path),
    limit: 20,
    windowMs: 60 * 60_000,
  },
  {
    rule: "plugin-package",
    label: "插件包下载",
    method: "GET",
    test: (path) => /^\/api\/plugins\/[^/]+\/package$/.test(path),
    limit: 120,
    windowMs: 10 * 60_000,
  },
  {
    rule: "plugin-install",
    label: "安装插件",
    method: "POST",
    test: (path) => path === "/api/plugins/install",
    limit: 30,
    windowMs: 10 * 60_000,
  },
  {
    rule: "plugin-net",
    label: "插件外部请求",
    method: "POST",
    test: (path) => path === "/api/plugins/net",
    limit: 300,
    windowMs: 10 * 60_000,
  },
  {
    rule: "plugin-review",
    label: "插件审核",
    method: "POST",
    test: (path) => /^\/api\/plugins\/admin\/[^/]+\/(review|takedown|feature|restore)$/.test(path),
    limit: 120,
    windowMs: 60 * 60_000,
  },
  {
    rule: "pairing-claim",
    label: "设备配对提交",
    method: "POST",
    test: (path) => path === "/api/pairing/claim",
    limit: 20,
    windowMs: 10 * 60_000,
  },
  {
    rule: "pairing-create",
    label: "生成配对码",
    method: "POST",
    test: (path) => path === "/api/pairing/create",
    limit: 12,
    windowMs: 60 * 60_000,
  },
  {
    rule: "continuity-send",
    label: "发送接力内容",
    method: "POST",
    test: (path) => path === "/api/continuity/send",
    limit: 120,
    windowMs: 10 * 60_000,
  },
  {
    rule: "clipboard-send",
    label: "发送剪贴板",
    method: "POST",
    test: (path) => path === "/api/clipboard/send",
    limit: 60,
    windowMs: 10 * 60_000,
  },
  {
    rule: "plugin-write",
    label: "插件写入",
    methods: ["POST", "PATCH", "DELETE"],
    test: (path) =>
      (path.startsWith("/api/plugins/") && path !== "/api/plugins/install" && path !== "/api/plugins/net") ||
      path.startsWith("/api/developer/"),
    limit: 240,
    windowMs: 10 * 60_000,
  },
];

const MEMORY_LIMIT = 4000;
/** @type {Map<string, { hits: number, exp: number }>} */
const memory = new Map();

export function matchRateRule(path, method) {
  for (const rule of RATE_RULES) {
    if (rule.method && rule.method !== method) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (rule.test(path)) return rule;
  }
  return GLOBAL_RULE;
}

export function clientIdentity(request) {
  const direct = (request.headers.get("cf-connecting-ip") || "").trim();
  if (direct) return direct;
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || "unknown";
}

function memoryHit(bucket, now) {
  const entry = memory.get(bucket);
  if (!entry || entry.exp <= now) {
    if (memory.size > MEMORY_LIMIT) {
      for (const [key, value] of memory) {
        if (value.exp <= now) memory.delete(key);
      }
      if (memory.size > MEMORY_LIMIT) memory.clear();
    }
    memory.set(bucket, { hits: 1, exp: now + 60 * 60_000 });
    return 1;
  }
  entry.hits += 1;
  return entry.hits;
}

/**
 * @returns {Promise<{allowed: boolean, limit: number, hits: number, remaining: number,
 *   retryAfter: number, resetAt: number, degraded: boolean, source: "d1" | "memory"}>}
 */
export async function rateLimit(env, request, rule, { scope = "ip", subject = null } = {}) {
  const now = Date.now();
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const resetAt = windowStart + rule.windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));

  const identity = subject || clientIdentity(request);
  // 窗口起点参与哈希：同一 IP 在不同窗口得到不同 bucket，无法跨窗口关联。
  const salt = env?.RATE_LIMIT_SALT || "guandao-rate-v1";
  const digest = await sha256Hex(`${rule.rule}|${scope}|${identity}|${windowStart}|${salt}`);
  const bucket = `${rule.rule}:${digest.slice(0, 28)}`;

  const localHits = memoryHit(bucket, now);
  if (localHits > rule.limit) {
    return {
      allowed: false,
      limit: rule.limit,
      hits: localHits,
      remaining: 0,
      retryAfter,
      resetAt,
      degraded: false,
      source: "memory",
    };
  }

  if (!env?.DB) {
    return {
      allowed: localHits <= rule.limit,
      limit: rule.limit,
      hits: localHits,
      remaining: Math.max(0, rule.limit - localHits),
      retryAfter,
      resetAt,
      degraded: true,
      source: "memory",
    };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, rule, scope, window_start, hits, blocked, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT (bucket) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at`,
    )
      .bind(bucket, rule.rule, scope, windowStart, now)
      .run();

    const row = await env.DB.prepare("SELECT hits FROM rate_limits WHERE bucket = ?")
      .bind(bucket)
      .first();
    const hits = Math.max(Number(row?.hits || 0), localHits);

    if (hits > rule.limit) {
      await env.DB.prepare("UPDATE rate_limits SET blocked = blocked + 1 WHERE bucket = ?")
        .bind(bucket)
        .run();
      return {
        allowed: false,
        limit: rule.limit,
        hits,
        remaining: 0,
        retryAfter,
        resetAt,
        degraded: false,
        source: "d1",
      };
    }

    return {
      allowed: true,
      limit: rule.limit,
      hits,
      remaining: Math.max(0, rule.limit - hits),
      retryAfter,
      resetAt,
      degraded: false,
      source: "d1",
    };
  } catch (error) {
    console.error("[ratelimit] d1 write failed, degraded to memory:", error?.message ?? error);
    return {
      allowed: localHits <= rule.limit,
      limit: rule.limit,
      hits: localHits,
      remaining: Math.max(0, rule.limit - localHits),
      retryAfter,
      resetAt,
      degraded: true,
      source: "memory",
    };
  }
}

/** 安全中心用的真实统计：过去 24 小时的窗口、请求与拦截次数。 */
export async function rateLimitStats(env) {
  const since = Date.now() - 24 * 60 * 60_000;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS buckets,
            COALESCE(SUM(hits), 0) AS hits,
            COALESCE(SUM(blocked), 0) AS blocked
       FROM rate_limits WHERE window_start >= ?`,
  )
    .bind(since)
    .first();

  return {
    buckets: Number(row?.buckets || 0),
    hits: Number(row?.hits || 0),
    blocked24h: Number(row?.blocked || 0),
    degraded: false,
  };
}

/** 供界面展示的规则清单（不包含内部实现细节）。 */
export function publicRateLimitRules() {
  const toView = (rule) => ({
    id: rule.rule,
    label: rule.label ?? "API 总请求",
    limit: rule.limit,
    windowSeconds: Math.round(rule.windowMs / 1000),
  });
  return {
    global: toView(GLOBAL_RULE),
    rules: RATE_RULES.map(toView),
  };
}
