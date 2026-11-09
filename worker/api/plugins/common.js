/**
 * Guandao OS 1.7 · 插件后端公共设施
 *
 * 只处理请求边界：同源校验、Session、角色、请求体上限、审计与开发者资料。
 * 业务查询在 store.js，路由在 handlers.js。
 */

import { ApiError } from "../http.js";
import {
  assertSameOriginFor,
  readJson as readJsonBody,
  requireSession as requireSessionGuard,
  sessionOrNull as sessionOrNullGuard,
} from "../guards.js";
import { randomToken } from "../auth/crypto.js";

/** 非 GET 请求必须同源：实现统一在 guards.js，这里保留插件模块原有的签名。 */
export function assertSameOrigin(request, env) {
  return assertSameOriginFor(request, env);
}

export async function sessionOrNull(env, request) {
  return sessionOrNullGuard(env, request);
}

export async function requireSession(env, request) {
  return requireSessionGuard(env, request, { message: "请先登录 Guandao Account" });
}

/** JSON 读取上限：普通接口 256 KB，插件包上传单独放宽（实现见 guards.js）。 */
export async function readJson(request, max = 256 * 1024) {
  return readJsonBody(request, max);
}

export async function effectiveRole(env, userId, userRow = null) {
  if (!userId) return "visitor";
  if (userRow?.role === "admin") return "admin";
  const row = await env.DB.prepare("SELECT role FROM community_roles WHERE user_id = ?").bind(userId).first();
  if (row?.role === "moderator") return "moderator";
  return "member";
}

export async function requireStaff(env, session) {
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin" && role !== "moderator") {
    throw new ApiError("FORBIDDEN", "需要插件审核权限", 403);
  }
  return role;
}

export async function requireAdmin(env, session) {
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin") throw new ApiError("FORBIDDEN", "需要管理员权限", 403);
  return role;
}

export async function viewerContext(env, session) {
  if (!session) {
    return { id: null, role: "visitor", staff: false, admin: false, developer: false, user: null };
  }
  const role = await effectiveRole(env, session.user.id, session.user);
  const dev = await env.DB.prepare("SELECT user_id FROM developer_profiles WHERE user_id = ?")
    .bind(session.user.id)
    .first();
  return {
    id: session.user.id,
    role,
    staff: role === "admin" || role === "moderator",
    admin: role === "admin",
    developer: Boolean(dev),
    user: session.user,
  };
}

let auditReady = false;
let auditTableMissing = false;

/**
 * 审计日志。写失败不能影响主流程，但要在服务端留下痕迹。
 * 迁移未执行时降级为 console，而不是让审核接口 500。
 */
export async function audit(env, { actorId = null, action, pluginId = null, targetUserId = null, detail = {} }) {
  const payload = {
    id: `pal-${randomToken(12)}`,
    actorId,
    action,
    pluginId,
    targetUserId,
    detail,
    createdAt: Date.now(),
  };
  if (!env?.DB) {
    console.log("[plugins][audit]", JSON.stringify(payload));
    return;
  }
  if (auditTableMissing) {
    console.log("[plugins][audit]", JSON.stringify(payload));
    return;
  }
  try {
    await env.DB.prepare(
      `INSERT INTO plugin_audit_logs (id, actor_id, action, plugin_id, target_user_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        payload.id,
        payload.actorId,
        payload.action,
        payload.pluginId,
        payload.targetUserId,
        JSON.stringify(payload.detail).slice(0, 2000),
        payload.createdAt,
      )
      .run();
    auditReady = true;
  } catch (error) {
    if (!auditReady) {
      auditTableMissing = true;
      console.warn("[plugins][audit] 审计表不可用，已降级为日志：", error?.message);
    }
    console.log("[plugins][audit]", JSON.stringify(payload));
  }
}

export async function readAudit(env, { pluginId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  try {
    const rows = pluginId
      ? await env.DB.prepare(
          `SELECT a.*, u.github_username AS actor_username
             FROM plugin_audit_logs a LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.plugin_id = ? ORDER BY a.created_at DESC LIMIT ?`,
        )
          .bind(pluginId, safeLimit)
          .all()
      : await env.DB.prepare(
          `SELECT a.*, u.github_username AS actor_username
             FROM plugin_audit_logs a LEFT JOIN users u ON u.id = a.actor_id
            ORDER BY a.created_at DESC LIMIT ?`,
        )
          .bind(safeLimit)
          .all();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      action: row.action,
      pluginId: row.plugin_id,
      actor: row.actor_id ? { id: row.actor_id, name: row.actor_username || "管理员" } : null,
      targetUserId: row.target_user_id,
      detail: safeParse(row.detail_json, {}),
      createdAt: Number(row.created_at),
    }));
  } catch {
    return [];
  }
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 开发者资料：首次进入开发者中心时自动创建，名称取社区昵称或 GitHub 用户名。
 * 只写 developer_profiles，不影响 users 表的私人字段。
 */
export async function ensureDeveloperProfile(env, userId) {
  const existing = await env.DB.prepare("SELECT * FROM developer_profiles WHERE user_id = ?").bind(userId).first();
  if (existing) return existing;

  const row = await env.DB.prepare(
    `SELECT COALESCE(cp.display_name, u.github_username, '开发者') AS name
       FROM users u LEFT JOIN community_profiles cp ON cp.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first();
  const now = Date.now();
  const displayName = String(row?.name || "开发者").slice(0, 40);
  await env.DB.prepare(
    `INSERT INTO developer_profiles (user_id, display_name, bio, website, created_at, updated_at)
     VALUES (?, ?, '', '', ?, ?)
     ON CONFLICT (user_id) DO NOTHING`,
  )
    .bind(userId, displayName, now, now)
    .run();
  return env.DB.prepare("SELECT * FROM developer_profiles WHERE user_id = ?").bind(userId).first();
}

/**
 * 发布限制：被社区限制的账号不能发布插件；社区暂停发布时同样生效。
 * 这是与 1.6 社区共用的一条边界，不另建一套黑名单。
 */
export async function assertPublishingAllowed(env, userId) {
  const settings = await env.DB.prepare("SELECT allow_publishing FROM community_settings WHERE id = 1").first();
  if (settings && !settings.allow_publishing) {
    throw new ApiError("PUBLISHING_DISABLED", "社区当前已暂停发布新内容", 403);
  }
  const profile = await env.DB.prepare("SELECT restriction FROM community_profiles WHERE user_id = ?")
    .bind(userId)
    .first();
  if (profile?.restriction === "blocked") {
    throw new ApiError("PUBLISHING_BLOCKED", "你的账号已被限制发布内容，如有疑问请联系管理员", 403);
  }
}
