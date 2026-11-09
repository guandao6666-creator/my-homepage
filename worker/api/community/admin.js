/**
 * Guandao OS 1.6 · 社区管理后台接口
 *
 * 权限模型：
 *   moderator → 审核作品、处理举报、隐藏评论与违规内容
 *   admin     → 管理用户、社区设置、邀请、删除作品、角色与封禁
 * 所有操作都写 community_audit_logs；所有权限都在服务端校验。
 */

import { ApiError, ok } from "../http.js";
import { sha256Hex } from "../auth/crypto.js";
import {
  audit,
  notify,
  pageParams,
  readJson,
} from "./common.js";
import { cleanText } from "./validate.js";
import {
  communityStats,
  getPostRow,
  getRawPost,
  getSettings,
  listAuditLogs,
  listPosts,
  listReports,
  listUsersForAdmin,
  mapPost,
  publicSettings,
} from "./store.js";

const UUID = /^[0-9a-f-]{36}$/;

function requireAdminRole(viewer) {
  if (viewer.role !== "admin") throw new ApiError("FORBIDDEN", "需要社区管理员权限", 403);
}

function bad(message, code = "INVALID_INPUT") {
  throw new ApiError(code, message, 400);
}

async function postForModeration(env, id, viewerId) {
  const row = await getPostRow(env, id, viewerId);
  return row ? { row, post: mapPost(row, { includeModeration: true }) } : null;
}

/* ============================================================
   待审核队列
   ============================================================ */

export async function adminQueueHandler({ env, url }) {
  const status = ["pending_review", "hidden", "rejected", "draft"].includes(url.searchParams.get("status"))
    ? url.searchParams.get("status")
    : "pending_review";
  const page = pageParams(url, { defaultLimit: 18, maxLimit: 40 });
  const result = await listPosts(env, {
    statuses: [status],
    sort: status === "draft" ? "updated" : "newest",
    publicOnly: false,
    limit: page.limit,
    offset: page.offset,
  });

  const ids = result.items.map((item) => item.id);
  let extra = new Map();
  if (ids.length) {
    const rows = await env.DB.prepare(
      `SELECT id, moderation_note, rights_confirmed, featured_at FROM community_posts
        WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .all();
    extra = new Map((rows.results || []).map((row) => [row.id, row]));
  }

  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS total FROM community_posts WHERE status IN ('pending_review','hidden','rejected','draft') GROUP BY status",
  ).all();
  const byStatus = {};
  for (const row of counts.results || []) byStatus[row.status] = Number(row.total);

  return ok({
    status,
    items: result.items.map((item) => ({
      ...item,
      moderationNote: extra.get(item.id)?.moderation_note || "",
      rightsConfirmed: Boolean(extra.get(item.id)?.rights_confirmed),
    })),
    total: result.total,
    byStatus,
    page: page.page,
    limit: page.limit,
  });
}

/* ============================================================
   作品审核
   ============================================================ */

export async function adminReviewPost({ env, request, viewer, id }) {
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const raw = await getRawPost(env, id);
  if (!raw) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  if (raw.status === "deleted") throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const body = await readJson(request, 16 * 1024);
  const action = String(body?.action ?? "");
  const note = cleanText(body?.note ?? "", 600);
  const now = Date.now();

  if (action === "delete" && viewer.role !== "admin") {
    throw new ApiError("FORBIDDEN", "删除作品需要管理员权限", 403);
  }

  if (action === "approve" || action === "restore") {
    if (raw.author_id === viewer.id && viewer.role !== "admin") {
      throw new ApiError("FORBIDDEN", "审核员不能审核自己的作品，请让其他审核员或管理员处理", 403);
    }
    if (!["pending_review", "hidden", "rejected", "draft"].includes(raw.status) && action !== "restore") {
      bad("当前状态不能通过审核");
    }
    const pkg = await env.DB.prepare(
      "SELECT 1 AS ok FROM community_packages WHERE post_id = ? AND status = 'active'",
    )
      .bind(id)
      .first();
    if (!pkg) bad("作品还没有可安装的内容包，不能通过审核");
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_posts
            SET status = 'published', published_at = COALESCE(published_at, ?), moderation_note = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(now, note || null, now, id),
      env.DB.prepare(
        `UPDATE package_versions SET published_at = COALESCE(published_at, ?)
          WHERE package_id IN (SELECT id FROM community_packages WHERE post_id = ?)
            AND version = (SELECT version FROM community_posts WHERE id = ?)`,
      ).bind(now, id, id),
    ]);
    await notify(env, {
      userId: raw.author_id,
      type: "post_review",
      postId: id,
      payload: { title: raw.title, status: "published", message: "作品已通过审核并公开" },
    });
    await audit(env, {
      actorId: viewer.id,
      action: "post.approve",
      targetType: "post",
      targetId: id,
      detail: { from: raw.status, note, title: raw.title },
    });
  } else if (action === "reject") {
    await env.DB.prepare(
      "UPDATE community_posts SET status = 'rejected', moderation_note = ?, updated_at = ? WHERE id = ?",
    )
      .bind(note || "内容未通过审核", now, id)
      .run();
    await notify(env, {
      userId: raw.author_id,
      type: "post_review",
      postId: id,
      payload: { title: raw.title, status: "rejected", message: note || "内容未通过审核" },
    });
    await audit(env, {
      actorId: viewer.id,
      action: "post.reject",
      targetType: "post",
      targetId: id,
      detail: { from: raw.status, note, title: raw.title },
    });
  } else if (action === "hide") {
    await env.DB.prepare(
      "UPDATE community_posts SET status = 'hidden', moderation_note = ?, updated_at = ? WHERE id = ?",
    )
      .bind(note || "内容已被管理员隐藏", now, id)
      .run();
    await notify(env, {
      userId: raw.author_id,
      type: "post_review",
      postId: id,
      payload: { title: raw.title, status: "hidden", message: note || "内容已被管理员隐藏" },
    });
    await audit(env, {
      actorId: viewer.id,
      action: "post.hide",
      targetType: "post",
      targetId: id,
      detail: { from: raw.status, note, title: raw.title },
    });
  } else if (action === "delete") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE community_posts SET status = 'deleted', deleted_at = ?, updated_at = ?, featured_at = NULL WHERE id = ?",
      ).bind(now, now, id),
      env.DB.prepare("UPDATE community_packages SET status = 'deleted', updated_at = ? WHERE post_id = ?").bind(now, id),
      env.DB.prepare(
        "UPDATE community_assets SET status = 'deleting', post_id = NULL WHERE post_id = ? AND status = 'ready'",
      ).bind(id),
      env.DB.prepare(
        "UPDATE community_reports SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ? WHERE target_type = 'post' AND target_id = ? AND status IN ('open', 'reviewing')",
      ).bind(note || "内容已被管理员删除", viewer.id, now, id),
    ]);
    await notify(env, {
      userId: raw.author_id,
      type: "moderation",
      postId: id,
      payload: { title: raw.title, message: note || "你的作品已被管理员删除" },
    });
    await audit(env, {
      actorId: viewer.id,
      action: "post.delete_moderator",
      targetType: "post",
      targetId: id,
      detail: { from: raw.status, note, title: raw.title },
    });
  } else {
    bad("未知的审核操作");
  }

  const updated = await postForModeration(env, id, viewer.id);
  return ok({ post: updated?.post ?? null, message: "审核操作已执行" });
}

export async function adminFeaturePost({ env, request, viewer, id }) {
  requireAdminRole(viewer);
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const raw = await getRawPost(env, id);
  if (!raw) throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const body = await readJson(request, 8 * 1024);
  const featured = Boolean(body?.featured);
  if (featured && raw.status !== "published") bad("只有已发布的作品可以被精选");
  await env.DB.prepare("UPDATE community_posts SET featured_at = ?, featured_by = ?, updated_at = ? WHERE id = ?")
    .bind(featured ? Date.now() : null, featured ? viewer.id : null, Date.now(), id)
    .run();
  await audit(env, {
    actorId: viewer.id,
    action: featured ? "post.feature" : "post.unfeature",
    targetType: "post",
    targetId: id,
    detail: { title: raw.title },
  });
  return ok({ featured, message: featured ? "已加入编辑精选" : "已取消精选" });
}

/* ============================================================
   举报处理
   ============================================================ */

export async function adminReportsHandler({ env, url }) {
  const status = ["open", "reviewing", "resolved", "dismissed", "all"].includes(url.searchParams.get("status"))
    ? url.searchParams.get("status")
    : "open";
  const page = pageParams(url, { defaultLimit: 18, maxLimit: 40 });
  const items = await listReports(env, { status, limit: page.limit, offset: page.offset });
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS total FROM community_reports GROUP BY status",
  ).all();
  const byStatus = {};
  for (const row of counts.results || []) byStatus[row.status] = Number(row.total);
  return ok({ status, items, byStatus, page: page.page, limit: page.limit });
}

export async function adminReviewReport({ env, request, viewer, id }) {
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "举报不存在", 404);
  const report = await env.DB.prepare("SELECT * FROM community_reports WHERE id = ?").bind(id).first();
  if (!report) throw new ApiError("NOT_FOUND", "举报不存在", 404);
  const body = await readJson(request, 16 * 1024);
  const action = String(body?.action ?? "");
  const resolution = cleanText(body?.resolution ?? "", 600);
  const now = Date.now();

  if (action === "delete_post" && viewer.role !== "admin") {
    throw new ApiError("FORBIDDEN", "删除作品需要管理员权限", 403);
  }
  if (action === "restrict_user" && viewer.role !== "admin") {
    throw new ApiError("FORBIDDEN", "限制用户需要管理员权限", 403);
  }

  let targetUserId = null;
  let message = "举报已处理";

  if (action === "dismiss") {
    await env.DB.prepare(
      "UPDATE community_reports SET status = 'dismissed', resolution = ?, reviewer_id = ?, reviewed_at = ? WHERE id = ?",
    ).bind(resolution || "经核查未违反社区规范", viewer.id, now, id).run();
    message = "举报已驳回";
  } else if (action === "hide_post" || action === "delete_post") {
    const post = report.target_type === "post" ? await getRawPost(env, report.target_id) : null;
    if (!post) throw new ApiError("NOT_FOUND", "被举报作品不存在", 404);
    targetUserId = post.author_id;
    if (action === "hide_post") {
      await env.DB.prepare(
        "UPDATE community_posts SET status = 'hidden', moderation_note = ?, updated_at = ? WHERE id = ?",
      ).bind(resolution || "因举报核查被隐藏", now, post.id).run();
      message = "作品已隐藏";
    } else {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE community_posts SET status = 'deleted', deleted_at = ?, updated_at = ?, featured_at = NULL WHERE id = ?",
        ).bind(now, now, post.id),
        env.DB.prepare("UPDATE community_packages SET status = 'deleted', updated_at = ? WHERE post_id = ?").bind(now, post.id),
        env.DB.prepare(
          "UPDATE community_assets SET status = 'deleting', post_id = NULL WHERE post_id = ? AND status = 'ready'",
        ).bind(post.id),
      ]);
      message = "作品已删除";
    }
    await env.DB.prepare(
      `UPDATE community_reports
          SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ?
        WHERE target_type = 'post' AND target_id = ? AND status IN ('open', 'reviewing')`,
    )
      .bind(resolution || message, viewer.id, now, post.id)
      .run();
    await notify(env, {
      userId: post.author_id,
      type: "moderation",
      postId: post.id,
      payload: { title: post.title, message: resolution || message },
    });
  } else if (action === "hide_comment") {
    if (report.target_type !== "comment") bad("该举报不是评论");
    const comment = await env.DB.prepare("SELECT * FROM community_comments WHERE id = ?").bind(report.target_id).first();
    if (!comment) throw new ApiError("NOT_FOUND", "评论不存在", 404);
    targetUserId = comment.user_id;
    await env.DB.prepare("UPDATE community_comments SET status = 'hidden', updated_at = ? WHERE id = ?")
      .bind(now, comment.id)
      .run();
    await env.DB.prepare(
      "UPDATE community_posts SET comment_count = (SELECT COUNT(*) FROM community_comments WHERE post_id = ? AND status = 'visible') WHERE id = ?",
    )
      .bind(comment.post_id, comment.post_id)
      .run();
    await env.DB.prepare(
      "UPDATE community_reports SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ? WHERE id = ?",
    ).bind(resolution || "评论已隐藏", viewer.id, now, id).run();
    await notify(env, {
      userId: comment.user_id,
      type: "moderation",
      postId: comment.post_id,
      commentId: comment.id,
      payload: { message: resolution || "你的评论因违反社区规范被隐藏" },
    });
    message = "评论已隐藏";
  } else if (action === "restrict_user") {
    let userId = report.target_type === "profile" ? report.target_id : null;
    if (!userId && report.target_type === "post") {
      const post = await getRawPost(env, report.target_id);
      userId = post?.author_id || null;
    }
    if (!userId && report.target_type === "comment") {
      const comment = await env.DB.prepare("SELECT user_id FROM community_comments WHERE id = ?")
        .bind(report.target_id)
        .first();
      userId = comment?.user_id || null;
    }
    if (!userId) bad("该举报没有可限制的用户");
    const user = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(userId).first();
    if (!user) throw new ApiError("NOT_FOUND", "用户不存在", 404);
    if (user.role === "admin") throw new ApiError("FORBIDDEN", "不能限制管理员账号", 403);
    const restriction = body?.restriction === "blocked" ? "blocked" : "limited";
    await env.DB.prepare(
      `INSERT INTO community_profiles (user_id, display_name, bio, creator_title, visibility, restriction,
                                       restriction_reason, created_at, updated_at)
       VALUES (?, ?, '', '', 'public', ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET restriction = excluded.restriction,
                                           restriction_reason = excluded.restriction_reason,
                                           updated_at = excluded.updated_at`,
    )
      .bind(
        userId,
        (await env.DB.prepare("SELECT COALESCE(display_name, github_username, '用户') AS name FROM users WHERE id = ?").bind(userId).first())?.name || "用户",
        restriction,
        resolution || "因举报核查限制发布",
        now,
        now,
      )
      .run();
    await env.DB.prepare(
      "UPDATE community_reports SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ? WHERE id = ?",
    ).bind(resolution || "已限制用户发布权限", viewer.id, now, id).run();
    await notify(env, {
      userId,
      type: "moderation",
      payload: { message: resolution || "你的账号发布权限已被限制" },
    });
    await audit(env, {
      actorId: viewer.id,
      action: "user.restrict",
      targetType: "user",
      targetId: userId,
      detail: { restriction, reportId: id, resolution },
    });
    message = "用户发布权限已限制";
  } else if (action === "warn_user") {
    const userId = report.target_type === "profile" ? report.target_id : null;
    if (!userId) bad("该举报暂时只能警告被举报资料的用户");
    await notify(env, {
      userId,
      type: "moderation",
      payload: { message: resolution || "你收到一条社区规范警告" },
    });
    await env.DB.prepare(
      "UPDATE community_reports SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ? WHERE id = ?",
    ).bind(resolution || "已向用户发出警告", viewer.id, now, id).run();
    message = "已向用户发出警告";
  } else {
    bad("未知的举报处理操作");
  }

  await audit(env, {
    actorId: viewer.id,
    action: `report.${action}`,
    targetType: "report",
    targetId: id,
    detail: { reportTargetType: report.target_type, reportTargetId: report.target_id, resolution },
  });
  return ok({ message });
}

/* ============================================================
   用户管理
   ============================================================ */

export async function adminUsersHandler({ env, url }) {
  const page = pageParams(url, { defaultLimit: 24, maxLimit: 60 });
  const search = String(url.searchParams.get("q") || "").trim().slice(0, 60) || null;
  const items = await listUsersForAdmin(env, { search, limit: page.limit, offset: page.offset });
  return ok({ items, page: page.page, limit: page.limit });
}

export async function adminUserRole({ env, request, viewer, id }) {
  requireAdminRole(viewer);
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  const target = await env.DB.prepare("SELECT id, role, display_name, github_username FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  if (target.role === "admin") bad("不能修改管理员角色");
  if (id === viewer.id) bad("不能修改自己的角色");
  const body = await readJson(request, 8 * 1024);
  const role = String(body?.role ?? "");
  if (!["moderator", "member"].includes(role)) bad("角色只能是 moderator 或 member");
  if (role === "moderator") {
    await env.DB.prepare(
      `INSERT INTO community_roles (user_id, role, granted_by, created_at)
       VALUES (?, 'moderator', ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET granted_by = excluded.granted_by`,
    )
      .bind(id, viewer.id, Date.now())
      .run();
  } else {
    await env.DB.prepare("DELETE FROM community_roles WHERE user_id = ?").bind(id).run();
  }
  await audit(env, {
    actorId: viewer.id,
    action: role === "moderator" ? "user.grant_moderator" : "user.revoke_moderator",
    targetType: "user",
    targetId: id,
    detail: { user: target.github_username },
  });
  await notify(env, {
    userId: id,
    type: "moderation",
    payload: { message: role === "moderator" ? "你已被任命为社区审核员" : "你的社区审核员权限已被移除" },
  });
  return ok({ role, message: "角色已更新" });
}

export async function adminUserStatus({ env, request, viewer, id }) {
  requireAdminRole(viewer);
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  const target = await env.DB.prepare("SELECT id, role, status, github_username FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  if (target.role === "admin") bad("不能停用管理员账号");
  if (id === viewer.id) bad("不能停用自己的账号");
  const body = await readJson(request, 8 * 1024);
  const status = String(body?.status ?? "");
  if (!["active", "disabled"].includes(status)) bad("账号状态不合法");
  const now = Date.now();
  await env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, id).run();
  if (status === "disabled") {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, id)
      .run();
  }
  await audit(env, {
    actorId: viewer.id,
    action: status === "disabled" ? "user.disable" : "user.enable",
    targetType: "user",
    targetId: id,
    detail: { user: target.github_username },
  });
  return ok({ status, message: status === "disabled" ? "账号已停用" : "账号已恢复" });
}

export async function adminUserRestriction({ env, request, viewer, id }) {
  if (!UUID.test(id)) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  const target = await env.DB.prepare("SELECT id, role, github_username, display_name FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new ApiError("NOT_FOUND", "用户不存在", 404);
  if (target.role === "admin") bad("不能限制管理员账号");
  const body = await readJson(request, 8 * 1024);
  const restriction = String(body?.restriction ?? "");
  if (!["none", "limited", "blocked"].includes(restriction)) bad("限制类型不合法");
  if (restriction === "blocked" && viewer.role !== "admin") {
    throw new ApiError("FORBIDDEN", "封禁发布权限需要管理员权限", 403);
  }
  const reason = cleanText(body?.reason ?? "", 300);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_profiles (user_id, display_name, bio, creator_title, visibility, restriction,
                                     restriction_reason, created_at, updated_at)
     VALUES (?, ?, '', '', 'public', ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET restriction = excluded.restriction,
                                         restriction_reason = excluded.restriction_reason,
                                         updated_at = excluded.updated_at`,
  )
    .bind(id, target.display_name || target.github_username || "用户", restriction, reason || null, now, now)
    .run();
  await audit(env, {
    actorId: viewer.id,
    action: `user.restriction_${restriction}`,
    targetType: "user",
    targetId: id,
    detail: { reason, user: target.github_username },
  });
  if (restriction !== "none") {
    await notify(env, {
      userId: id,
      type: "moderation",
      payload: { message: reason || "你的社区发布权限已被调整" },
    });
  }
  return ok({ restriction, message: "用户限制已更新" });
}

/* ============================================================
   社区设置
   ============================================================ */

export async function adminSettingsGet({ env }) {
  const settings = await getSettings(env);
  return ok({ settings: publicSettings(settings), raw: {
    registrationMode: settings.registration_mode,
    requireReview: Boolean(settings.require_review),
    memberLogin: Boolean(settings.member_login),
    allowPublishing: Boolean(settings.allow_publishing),
    communityName: settings.community_name,
    announcement: settings.announcement,
  } });
}

export async function adminSettingsPatch({ env, request, viewer }) {
  requireAdminRole(viewer);
  const body = await readJson(request, 16 * 1024);
  const updates = [];
  const binds = [];

  if (body.registrationMode !== undefined) {
    if (!["closed", "invite", "open"].includes(body.registrationMode)) bad("注册模式不合法");
    updates.push("registration_mode = ?");
    binds.push(body.registrationMode);
  }
  for (const [key, column] of [
    ["requireReview", "require_review"],
    ["memberLogin", "member_login"],
    ["allowPublishing", "allow_publishing"],
  ]) {
    if (body[key] !== undefined) {
      updates.push(`${column} = ?`);
      binds.push(body[key] ? 1 : 0);
    }
  }
  for (const [key, column, min, max] of [
    ["maxPostsPerDay", "max_posts_per_day", 1, 100],
    ["maxCommentsPerDay", "max_comments_per_day", 1, 500],
    ["maxPackagesPerUser", "max_packages_per_user", 1, 500],
    ["maxUserStorageBytes", "max_user_storage_bytes", 1024 * 1024, 1024 * 1024 * 1024],
    ["maxUploadBytes", "max_upload_bytes", 64 * 1024, 32 * 1024 * 1024],
  ]) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max) bad(`${key} 超出允许范围`);
    updates.push(`${column} = ?`);
    binds.push(Math.round(value));
  }
  if (body.communityName !== undefined) {
    const name = cleanText(body.communityName, 60, { required: true, allowNewline: false });
    if (name.length < 2) bad("社区名称至少 2 个字符");
    updates.push("community_name = ?");
    binds.push(name);
  }
  if (body.announcement !== undefined) {
    updates.push("announcement = ?");
    binds.push(cleanText(body.announcement, 600));
  }
  if (!updates.length) return ok({ unchanged: true });
  updates.push("updated_at = ?", "updated_by = ?");
  binds.push(Date.now(), viewer.id);
  await env.DB.prepare(`UPDATE community_settings SET ${updates.join(", ")} WHERE id = 1`).bind(...binds).run();
  await audit(env, {
    actorId: viewer.id,
    action: "settings.update",
    targetType: "settings",
    targetId: "1",
    detail: { fields: updates.map((item) => item.split(" = ")[0]) },
  });
  return ok({ settings: publicSettings(await getSettings(env)), message: "社区设置已保存" });
}

/* ============================================================
   邀请注册
   ============================================================ */

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function inviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
  return `GD-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

export async function adminInvitesGet({ env, viewer }) {
  requireAdminRole(viewer);
  const rows = await env.DB.prepare(
    `SELECT i.*, COALESCE(pr.display_name, u.display_name, u.github_username) AS creator_name
       FROM community_invites i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN community_profiles pr ON pr.user_id = i.created_by
      ORDER BY i.created_at DESC
      LIMIT 50`,
  ).all();
  return ok({
    items: (rows.results || []).map((row) => ({
      id: row.id,
      prefix: row.code_prefix,
      label: row.label,
      maxUses: Number(row.max_uses),
      usedCount: Number(row.used_count),
      expiresAt: row.expires_at ? Number(row.expires_at) : null,
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
      createdAt: Number(row.created_at),
      creatorName: row.creator_name || "管理员",
      exhausted: Number(row.used_count) >= Number(row.max_uses),
    })),
    registrationMode: (await getSettings(env)).registration_mode,
  });
}

export async function adminInvitesPost({ env, request, viewer }) {
  requireAdminRole(viewer);
  const body = await readJson(request, 8 * 1024);
  const label = cleanText(body?.label ?? "", 60, { allowNewline: false });
  const maxUses = Math.max(1, Math.min(500, Number(body?.maxUses) || 1));
  const expiresInDays = Math.max(0, Math.min(365, Number(body?.expiresInDays) || 0));
  const code = inviteCode();
  const hash = await sha256Hex(code);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_invites (id, code_hash, code_prefix, label, created_by, max_uses, used_count, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      hash,
      code.slice(0, 8),
      label,
      viewer.id,
      maxUses,
      expiresInDays ? now + expiresInDays * 86400000 : null,
      now,
    )
    .run();
  await audit(env, {
    actorId: viewer.id,
    action: "invite.create",
    targetType: "invite",
    targetId: code.slice(0, 8),
    detail: { maxUses, expiresInDays, label },
  });
  return ok(
    {
      code,
      maxUses,
      expiresInDays,
      message: "邀请码只显示这一次，请立即复制发给对方",
    },
    { status: 201 },
  );
}

export async function adminInvitesDelete({ env, viewer, id }) {
  requireAdminRole(viewer);
  const invite = await env.DB.prepare("SELECT * FROM community_invites WHERE id = ?").bind(id).first();
  if (!invite) throw new ApiError("NOT_FOUND", "邀请码不存在", 404);
  await env.DB.prepare("UPDATE community_invites SET revoked_at = ? WHERE id = ?").bind(Date.now(), id).run();
  await audit(env, {
    actorId: viewer.id,
    action: "invite.revoke",
    targetType: "invite",
    targetId: id,
    detail: { prefix: invite.code_prefix },
  });
  return ok({ revoked: true, message: "邀请码已作废" });
}

/* ============================================================
   审计 / 统计
   ============================================================ */

export async function adminAuditHandler({ env, url }) {
  const page = pageParams(url, { defaultLimit: 30, maxLimit: 80 });
  const items = await listAuditLogs(env, { limit: page.limit, offset: page.offset });
  return ok({ items, page: page.page, limit: page.limit });
}

export async function adminStatsHandler({ env }) {
  const stats = await communityStats(env);
  const [users, drafts] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'active'").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_posts WHERE status = 'draft'").first(),
  ]);
  return ok({
    stats: {
      ...stats,
      accounts: Number(users?.total || 0),
      drafts: Number(drafts?.total || 0),
    },
  });
}
