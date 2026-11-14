/**
 * Guandao OS 1.6 · 社区后端公共设施
 *
 * 只做「请求边界」相关的事：会话、来源校验、请求体上限、角色、审计、
 * 通知与配额。业务查询集中在 store.js，路由集中在 handlers.js。
 */

import { ApiError } from "../http.js";
import {
  assertSameOriginFor,
  readJson as readJsonBody,
  requireSession as requireSessionGuard,
  sessionOrNull as sessionOrNullGuard,
} from "../guards.js";
import { getPostRow, mapPost } from "./store.js";

export const STAFF_ROLES = new Set(["admin", "moderator"]);

/** 非 GET 请求必须同源：实现统一在 guards.js，这里保留社区原有的签名。 */
export function assertSameOrigin(request, env) {
  return assertSameOriginFor(request, env);
}

export async function sessionOrNull(env, request) {
  return sessionOrNullGuard(env, request);
}

export async function requireSession(env, request) {
  return requireSessionGuard(env, request, { message: "请先登录 Guandao Account" });
}

/** 读取 JSON，带显式上限；content-length 与实际字节都检查（实现见 guards.js）。 */
export async function readJson(request, max = 160 * 1024) {
  return readJsonBody(request, max);
}

export async function readForm(request, max) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > max) throw new ApiError("PAYLOAD_TOO_LARGE", "上传内容过大", 413);
  try {
    return await request.formData();
  } catch {
    throw new ApiError("INVALID_BODY", "上传表单读取失败", 400);
  }
}

/** 有效角色：users.role='admin' 永远优先；审核员在 community_roles 中。 */
export async function effectiveRole(env, userId, userRow = null) {
  if (!userId) return "visitor";
  if (userRow?.role === "admin") return "admin";
  const row = await env.DB.prepare("SELECT role FROM community_roles WHERE user_id = ?").bind(userId).first();
  if (row?.role === "moderator") return "moderator";
  return "member";
}

export function isStaff(role) {
  return STAFF_ROLES.has(role);
}

export async function requireStaff(env, session) {
  const role = await effectiveRole(env, session.user.id, session.user);
  if (!isStaff(role)) throw new ApiError("FORBIDDEN", "需要社区审核权限", 403);
  return role;
}

export async function requireAdmin(env, session) {
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin") throw new ApiError("FORBIDDEN", "需要社区管理员权限", 403);
  return role;
}

/* ============================================================
   浏览者上下文 / 作品可见性
   ============================================================ */

export async function viewerContext(env, session) {
  if (!session) {
    return { id: null, role: "visitor", staff: false, admin: false, user: null };
  }
  const role = await effectiveRole(env, session.user.id, session.user);
  return {
    id: session.user.id,
    role,
    staff: role === "admin" || role === "moderator",
    admin: role === "admin",
    user: session.user,
  };
}

/**
 * 统一的可见性闸门：
 *   published → 所有人（unlisted 只保证不出现在列表，直链可读）
 *   draft / pending_review / hidden / rejected / deleted → 作者与审核员
 * 删除的作品对作者也只返回 404。
 */
export async function loadPost(env, id, viewer, { allowDeleted = false } = {}) {
  if (!id) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const row = await getPostRow(env, id, viewer.id);
  if (!row) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const isOwner = viewer.id != null && row.author_id === viewer.id;
  const allowed = row.status === "published" || isOwner || viewer.staff;
  if (!allowed || (!allowDeleted && row.status === "deleted")) {
    throw new ApiError("NOT_FOUND", "作品不存在", 404);
  }
  const canModerate = viewer.staff;
  const post = mapPost(row, { includeModeration: isOwner || canModerate });
  return { row, post, isOwner, canManage: isOwner || viewer.admin, canModerate };
}

export async function assertPublishingAllowed(env, userId) {
  const settings = await env.DB.prepare("SELECT * FROM community_settings WHERE id = 1").first();
  if (!settings || !settings.allow_publishing) {
    throw new ApiError("PUBLISHING_DISABLED", "社区当前已暂停发布新内容", 403);
  }
  const profile = await env.DB.prepare("SELECT restriction FROM community_profiles WHERE user_id = ?").bind(userId).first();
  if (profile?.restriction === "blocked") {
    throw new ApiError("PUBLISHING_BLOCKED", "你的账号已被限制发布内容，如有疑问请联系管理员", 403);
  }
  return settings;
}

export async function assertCommentAllowed(env, userId) {
  const profile = await env.DB.prepare("SELECT restriction FROM community_profiles WHERE user_id = ?").bind(userId).first();
  if (profile?.restriction === "blocked") {
    throw new ApiError("COMMENT_BLOCKED", "你的账号已被限制发表评论", 403);
  }
}

/* ============================================================
   页码 / 字段
   ============================================================ */

export function pageParams(url, { defaultLimit = 24, maxLimit = 48 } = {}) {
  const page = Math.max(1, Math.min(500, Number(url.searchParams.get("page")) || 1));
  const limit = Math.max(1, Math.min(maxLimit, Number(url.searchParams.get("limit")) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function safeId(value, pattern = /^[0-9a-f-]{36}$/) {
  const id = String(value ?? "");
  return pattern.test(id) ? id : "";
}

export function escapeLike(value) {
  return String(value ?? "").replace(/[\\%_]/g, (char) => `\\${char}`);
}

/* ============================================================
   资料
   ============================================================ */

export async function ensureProfile(env, user) {
  const existing = await env.DB.prepare("SELECT * FROM community_profiles WHERE user_id = ?").bind(user.id).first();
  if (existing) return existing;
  const now = Date.now();
  const display = String(user.display_name || user.github_username || "创作者").slice(0, 40);
  await env.DB.prepare(
    `INSERT INTO community_profiles (user_id, display_name, bio, creator_title, avatar_asset_id, cover_asset_id,
                                     visibility, restriction, created_at, updated_at)
     VALUES (?, ?, '', '', NULL, NULL, 'public', 'none', ?, ?)
     ON CONFLICT (user_id) DO NOTHING`,
  )
    .bind(user.id, display, now, now)
    .run();
  return env.DB.prepare("SELECT * FROM community_profiles WHERE user_id = ?").bind(user.id).first();
}

/** 作者字段统一从这里取，绝不回传 email / github_id / session。 */
export function mapAuthor(row, prefix = "author_") {
  if (!row?.[`${prefix}id`]) return null;
  return {
    id: row[`${prefix}id`],
    displayName: row[`${prefix}display_name`] || row[`${prefix}username`] || "创作者",
    avatarUrl: row[`${prefix}avatar_asset_id`] ? `/api/community/media/${row[`${prefix}avatar_asset_id`]}` : null,
    creatorTitle: row[`${prefix}creator_title`] || "",
    role: row[`${prefix}user_role`] === "admin" ? "admin" : row[`${prefix}moderator_role`] ? "moderator" : "member",
  };
}

/* ============================================================
   审计 / 通知 / 配额
   ============================================================ */

export async function audit(env, { actorId, action, targetType, targetId = null, detail = {} }) {
  await env.DB.prepare(
    `INSERT INTO community_audit_logs (id, actor_id, action, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), actorId ?? null, action, targetType, targetId, JSON.stringify(detail), Date.now())
    .run();
}

export async function notify(env, { userId, type, actorId = null, postId = null, commentId = null, payload = {} }) {
  if (!userId || userId === actorId) return;
  await env.DB.prepare(
    `INSERT INTO community_notifications (id, user_id, type, actor_id, post_id, comment_id, payload_json, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), userId, type, actorId, postId, commentId, JSON.stringify(payload), Date.now())
    .run();
}

/** 真实配额：以数据库记录为准，不信任前端。 */
export async function assertDailyPostQuota(env, userId, limit) {
  const since = Date.now() - 24 * 3600 * 1000;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM community_posts WHERE author_id = ? AND created_at >= ? AND status <> 'deleted'",
  )
    .bind(userId, since)
    .first();
  if (Number(row?.total || 0) >= limit) {
    throw new ApiError("POST_QUOTA_EXCEEDED", `24 小时内最多发布 ${limit} 个作品`, 429);
  }
}

export async function assertCommentQuota(env, userId, limit) {
  const since = Date.now() - 24 * 3600 * 1000;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM community_comments WHERE user_id = ? AND created_at >= ? AND status <> 'deleted'",
  )
    .bind(userId, since)
    .first();
  if (Number(row?.total || 0) >= limit) {
    throw new ApiError("COMMENT_QUOTA_EXCEEDED", `24 小时内最多发表 ${limit} 条评论`, 429);
  }
}

export async function assertPackageQuota(env, userId, limit) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM community_packages WHERE author_id = ? AND status = 'active'",
  )
    .bind(userId)
    .first();
  if (Number(row?.total || 0) >= limit) {
    throw new ApiError("PACKAGE_QUOTA_EXCEEDED", `每个账号最多保留 ${limit} 个作品包`, 429);
  }
}

export async function assertStorageQuota(env, userId, limit, incoming) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM community_assets WHERE user_id = ? AND status <> 'deleted'`,
  )
    .bind(userId)
    .first();
  const used = Number(row?.total || 0);
  if (used + incoming > limit) {
    throw new ApiError("STORAGE_QUOTA_EXCEEDED", "社区存储空间不足，请清理旧资源后再上传", 413);
  }
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
