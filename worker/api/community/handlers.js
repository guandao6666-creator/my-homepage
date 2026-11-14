/**
 * Guandao OS 1.6 · 社区只读接口与路由分发
 *
 * 写接口在 write.js，管理接口在 admin.js。这里负责：
 *   - 路由匹配（/api/community/*）
 *   - 公开读取：首页、发现、搜索、作品、评论、创作者、内容包、媒体
 *   - 统一的可见性与 R2 私有读取检查
 */

import { ApiError, ok } from "../http.js";
import { sha256Hex } from "../auth/crypto.js";
import {
  assertSameOrigin,
  isStaff,
  oneOf,
  pageParams,
  readJson,
  sessionOrNull,
  viewerContext,
  loadPost,
  ensureProfile,
} from "./common.js";
import {
  CATEGORIES,
  LICENSE_IDS,
  OS_VERSION,
  POST_TYPES,
  WIDGET_TYPES,
  WIDGET_PERMISSIONS,
  validateManifest,
} from "./validate.js";
import {
  communityStats,
  getCreatorRow,
  getPackageForPost,
  getPostAssets,
  getSettings,
  isFollowing,
  listComments,
  listCreators,
  listPostVersions,
  listPosts,
  listReports,
  mapAsset,
  overviewCounts,
  publicSettings,
  unreadNotificationCount,
  creatorStats,
} from "./store.js";
import {
  adminQueueHandler,
  adminReportsHandler,
  adminStatsHandler,
  adminAuditHandler,
  adminUsersHandler,
  adminSettingsGet,
  adminSettingsPatch,
  adminInvitesGet,
  adminInvitesPost,
  adminInvitesDelete,
  adminReviewPost,
  adminFeaturePost,
  adminReviewReport,
  adminUserRole,
  adminUserStatus,
  adminUserRestriction,
} from "./admin.js";
import {
  createUpload,
  createPost,
  patchPost,
  deletePost,
  publishPost,
  withdrawPost,
  createVersion,
  viewPost,
  likePost,
  unlikePost,
  favoritePost,
  unfavoritePost,
  createComment,
  deleteComment,
  createReport,
  followCreator,
  unfollowCreator,
  myCreations,
  myFavorites,
  myProfileGet,
  myProfilePatch,
  myNotifications,
  markNotifications,
  myUsage,
  myFavoriteCollections,
  listFollowingFeed,
} from "./write.js";

const PREFIX = "/api/community";

export async function handleCommunityRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  if (!env?.DB) throw new ApiError("SERVICE_UNAVAILABLE", "社区数据库尚未配置", 503);

  const method = request.method;
  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const parts = rest ? rest.split("/") : [];
  const session = await sessionOrNull(env, request);

  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(request, env);
  }

  /* ------------------------------ 媒体 ------------------------------ */
  if (parts[0] === "media") {
    if (method !== "GET" && method !== "HEAD") throw new ApiError("METHOD_NOT_ALLOWED", "媒体只支持读取", 405);
    return mediaHandler({ env, request, parts, session });
  }

  /* ------------------------------ 公共元信息 ------------------------------ */
  if (parts.length === 1 && parts[0] === "meta" && method === "GET") {
    return metaHandler({ env, session });
  }
  if (parts.length === 1 && parts[0] === "feed" && method === "GET") {
    return feedHandler({ env, session, url });
  }
  if (parts.length === 1 && parts[0] === "explore" && method === "GET") {
    return exploreHandler({ env, session, url });
  }
  if (parts.length === 1 && parts[0] === "search" && method === "GET") {
    return searchHandler({ env, session, url });
  }
  if (parts.length === 1 && parts[0] === "creators" && method === "GET") {
    return creatorsHandler({ env, session, url });
  }
  if (parts.length === 1 && parts[0] === "reports" && method === "POST") {
    const viewer = await requireViewer(env, session);
    return createReport({ env, request, session, viewer });
  }

  /* ------------------------------ 作品读取 ------------------------------ */
  if (parts[0] === "posts" && parts.length >= 2) {
    const id = parts[1];

    if (parts.length === 2 && method === "GET") {
      return postDetailHandler({ env, session, id });
    }
    if (parts.length === 3 && parts[2] === "comments" && method === "GET") {
      return commentsHandler({ env, session, id, url });
    }
    if (parts.length === 3 && parts[2] === "versions" && method === "GET") {
      return versionsHandler({ env, session, id });
    }
    if (parts.length === 3 && parts[2] === "package" && method === "GET") {
      return packageHandler({ env, session, id, url });
    }
    if (parts.length === 3 && parts[2] === "view" && method === "POST") {
      return viewPost({ env, session, id });
    }

    // 以下都要求登录
    const viewer = await requireViewer(env, session);
    if (parts.length === 2 && method === "PATCH") return patchPost({ env, request, session, viewer, id });
    if (parts.length === 2 && method === "DELETE") return deletePost({ env, request, session, viewer, id });
    if (parts.length === 3 && parts[2] === "publish" && method === "POST") return publishPost({ env, request, session, viewer, id });
    if (parts.length === 3 && parts[2] === "withdraw" && method === "POST") return withdrawPost({ env, request, session, viewer, id });
    if (parts.length === 3 && parts[2] === "versions" && method === "POST") return createVersion({ env, request, session, viewer, id });
    if (parts.length === 3 && parts[2] === "like" && method === "POST") return likePost({ env, session, viewer, id });
    if (parts.length === 3 && parts[2] === "like" && method === "DELETE") return unlikePost({ env, session, viewer, id });
    if (parts.length === 3 && parts[2] === "favorite" && method === "POST") return favoritePost({ env, request, session, viewer, id });
    if (parts.length === 3 && parts[2] === "favorite" && method === "DELETE") return unfavoritePost({ env, session, viewer, id });
    if (parts.length === 3 && parts[2] === "comments" && method === "POST") return createComment({ env, request, session, viewer, id });
  }

  if (parts.length === 2 && parts[0] === "comments" && method === "DELETE") {
    const viewer = await requireViewer(env, session);
    return deleteComment({ env, request, session, viewer, id: parts[1] });
  }
  if (parts.length === 3 && parts[0] === "comments" && parts[2] === "report" && method === "POST") {
    const viewer = await requireViewer(env, session);
    return createReport({ env, request, session, viewer, fixedTarget: { type: "comment", id: parts[1] } });
  }

  /* ------------------------------ 创作者 ------------------------------ */
  if (parts[0] === "creators" && parts.length >= 2 && (method === "GET" || method === "POST" || method === "DELETE")) {
    const targetId = parts[1];
    if (parts.length === 2 && method === "GET") {
      return creatorHandler({ env, session, id: targetId, url });
    }
    if (parts.length === 3 && parts[2] === "follow") {
      const viewer = await requireViewer(env, session);
      if (method === "POST") return followCreator({ env, session, viewer, targetId });
      if (method === "DELETE") return unfollowCreator({ env, session, viewer, targetId });
    }
  }

  /* ------------------------------ 我的 ------------------------------ */
  if (parts[0] === "me") {
    const viewer = await requireViewer(env, session);
    if (parts.length === 2 && parts[1] === "creations" && method === "GET") return myCreations({ env, session, viewer, url });
    if (parts.length === 2 && parts[1] === "favorites" && method === "GET") return myFavorites({ env, session, viewer, url });
    if (parts.length === 2 && parts[1] === "favorite-collections" && method === "GET") return myFavoriteCollections({ env, session, viewer });
    if (parts.length === 2 && parts[1] === "notifications" && method === "GET") return myNotifications({ env, session, viewer, url });
    if (parts.length === 2 && parts[1] === "notifications" && method === "PATCH") return markNotifications({ env, request, session, viewer });
    if (parts.length === 2 && parts[1] === "profile" && method === "GET") return myProfileGet({ env, session, viewer });
    if (parts.length === 2 && parts[1] === "profile" && method === "PATCH") return myProfilePatch({ env, request, session, viewer });
    if (parts.length === 2 && parts[1] === "usage" && method === "GET") return myUsage({ env, session, viewer });
    if (parts.length === 2 && parts[1] === "following" && method === "GET") return listFollowingFeed({ env, session, viewer, url });
  }

  /* ------------------------------ 上传 / 新建 ------------------------------ */
  if (parts.length === 1 && parts[0] === "uploads" && method === "POST") {
    const viewer = await requireViewer(env, session);
    return createUpload({ env, request, session, viewer });
  }
  if (parts.length === 1 && parts[0] === "posts" && method === "POST") {
    const viewer = await requireViewer(env, session);
    return createPost({ env, request, session, viewer });
  }

  /* ------------------------------ 管理 ------------------------------ */
  if (parts[0] === "admin") {
    const viewer = await requireViewer(env, session);
    if (!isStaff(viewer.role)) throw new ApiError("FORBIDDEN", "需要社区审核权限", 403);
    const view = { env, session, viewer, url, request };
    if (parts.length === 2 && parts[1] === "queue" && method === "GET") return adminQueueHandler(view);
    if (parts.length === 2 && parts[1] === "reports" && method === "GET") return adminReportsHandler(view);
    if (parts.length === 2 && parts[1] === "stats" && method === "GET") return adminStatsHandler(view);
    if (parts.length === 2 && parts[1] === "audit" && method === "GET") return adminAuditHandler(view);
    if (parts.length === 2 && parts[1] === "users" && method === "GET") return adminUsersHandler(view);
    if (parts.length === 2 && parts[1] === "settings" && method === "GET") return adminSettingsGet(view);
    if (parts.length === 2 && parts[1] === "settings" && method === "PATCH") return adminSettingsPatch(view);
    if (parts.length === 2 && parts[1] === "invites" && method === "GET") return adminInvitesGet(view);
    if (parts.length === 2 && parts[1] === "invites" && method === "POST") return adminInvitesPost(view);
    if (parts.length === 3 && parts[1] === "invites" && method === "DELETE") return adminInvitesDelete({ ...view, id: parts[2] });
    if (parts.length === 4 && parts[1] === "posts" && parts[3] === "review" && method === "POST") {
      return adminReviewPost({ ...view, id: parts[2] });
    }
    if (parts.length === 4 && parts[1] === "posts" && parts[3] === "feature" && method === "POST") {
      return adminFeaturePost({ ...view, id: parts[2] });
    }
    if (parts.length === 4 && parts[1] === "reports" && parts[3] === "review" && method === "POST") {
      return adminReviewReport({ ...view, id: parts[2] });
    }
    if (parts.length === 4 && parts[1] === "users" && parts[3] === "role" && method === "PATCH") {
      return adminUserRole({ ...view, id: parts[2] });
    }
    if (parts.length === 4 && parts[1] === "users" && parts[3] === "status" && method === "PATCH") {
      return adminUserStatus({ ...view, id: parts[2] });
    }
    if (parts.length === 4 && parts[1] === "users" && parts[3] === "restriction" && method === "PATCH") {
      return adminUserRestriction({ ...view, id: parts[2] });
    }
  }

  throw new ApiError("NOT_FOUND", "社区接口不存在", 404);
}

async function requireViewer(env, session) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  return viewerContext(env, session);
}

/* ============================================================
   GET /api/community/meta
   ============================================================ */

async function metaHandler({ env, session }) {
  const settings = await getSettings(env);
  const counts = await overviewCounts(env);
  const viewer = session ? await viewerContext(env, session) : null;
  let me = null;
  let unread = 0;
  if (session && viewer) {
    const profile = await ensureProfile(env, session.user);
    unread = await unreadNotificationCount(env, session.user.id);
    me = {
      id: session.user.id,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_asset_id ? `/api/community/media/${profile.avatar_asset_id}` : null,
      role: viewer.role,
      staff: viewer.staff,
      admin: viewer.admin,
      visibility: profile.visibility,
      restriction: profile.restriction || "none",
      unreadNotifications: unread,
    };
  }
  return ok({
    communityName: settings?.community_name || "Guandao Community",
    announcement: settings?.announcement || "",
    osVersion: OS_VERSION,
    registrationMode: settings?.registration_mode || "closed",
    requireReview: Boolean(settings?.require_review),
    memberLogin: Boolean(settings?.member_login),
    allowPublishing: Boolean(settings?.allow_publishing),
    counts,
    viewer: me,
    unreadNotifications: unread,
    licenses: LICENSE_IDS,
    categories: CATEGORIES,
    widgetTypes: WIDGET_TYPES,
    widgetPermissions: WIDGET_PERMISSIONS,
    limits: {
      maxUploadBytes: Number(settings?.max_upload_bytes || 0),
      maxPostsPerDay: Number(settings?.max_posts_per_day || 0),
      maxCommentsPerDay: Number(settings?.max_comments_per_day || 0),
      maxPackagesPerUser: Number(settings?.max_packages_per_user || 0),
      maxUserStorageBytes: Number(settings?.max_user_storage_bytes || 0),
    },
  });
}

/* ============================================================
   列表
   ============================================================ */

async function feedHandler({ env, session, url }) {
  const viewer = await viewerContext(env, session);
  const tab = oneOf(url.searchParams.get("tab"), ["featured", "latest", "trending", "following"], "latest");
  const type = oneOf(url.searchParams.get("type"), POST_TYPES, null);
  const page = pageParams(url);
  if (tab === "following" && !session) {
    throw new ApiError("UNAUTHENTICATED", "关注动态需要先登录", 401);
  }
  const result = await listPosts(env, {
    viewerId: viewer.id,
    type,
    sort: tab === "featured" ? "latest" : tab === "trending" ? "trending" : "latest",
    featured: tab === "featured",
    followingOf: tab === "following" ? viewer.id : null,
    minInteractions: tab === "trending",
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    tab,
    ...result,
    page: page.page,
    limit: page.limit,
    hasMore: page.offset + result.items.length < result.total,
    viewer: { id: viewer.id, role: viewer.role, staff: viewer.staff },
  });
}

async function exploreHandler({ env, session, url }) {
  const viewer = await viewerContext(env, session);
  const page = pageParams(url);
  const type = oneOf(url.searchParams.get("type"), POST_TYPES, null);
  const category = String(url.searchParams.get("category") || "").slice(0, 32) || null;
  const tag = String(url.searchParams.get("tag") || "").slice(0, 20) || null;
  const sort = oneOf(url.searchParams.get("sort"), ["latest", "popular", "downloads", "favorites", "likes", "updated", "trending"], "latest");
  const result = await listPosts(env, {
    viewerId: viewer.id,
    type,
    category,
    tag,
    sort,
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    ...result,
    page: page.page,
    limit: page.limit,
    hasMore: page.offset + result.items.length < result.total,
    typeCounts: await overviewCounts(env),
  });
}

async function searchHandler({ env, session, url }) {
  const viewer = await viewerContext(env, session);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
  if (!q) throw new ApiError("INVALID_QUERY", "请输入搜索关键词", 400);
  const page = pageParams(url);
  const type = oneOf(url.searchParams.get("type"), POST_TYPES, null);
  const category = String(url.searchParams.get("category") || "").slice(0, 32) || null;
  const sort = oneOf(url.searchParams.get("sort"), ["latest", "popular", "downloads", "favorites", "likes", "updated"], "latest");
  const [posts, creators] = await Promise.all([
    listPosts(env, {
      viewerId: viewer.id,
      type,
      category,
      search: q,
      sort,
      limit: page.limit,
      offset: page.offset,
    }),
    listCreators(env, { viewerId: viewer.id, search: q, limit: 4, sort: "active" }),
  ]);
  return ok({
    query: q,
    ...posts,
    creators,
    page: page.page,
    limit: page.limit,
    hasMore: page.offset + posts.items.length < posts.total,
  });
}

async function creatorsHandler({ env, session, url }) {
  const viewer = await viewerContext(env, session);
  const page = pageParams(url, { defaultLimit: 18, maxLimit: 36 });
  const sort = oneOf(url.searchParams.get("sort"), ["active", "new"], "active");
  const search = String(url.searchParams.get("q") || "").trim().slice(0, 60) || null;
  const items = await listCreators(env, { viewerId: viewer.id, sort, limit: page.limit, offset: page.offset, search });
  return ok({ items, page: page.page, limit: page.limit, hasMore: items.length === page.limit });
}

async function creatorHandler({ env, session, id, url }) {
  const viewer = await viewerContext(env, session);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError("NOT_FOUND", "创作者不存在", 404);
  const row = await getCreatorRow(env, id);
  if (!row || row.status !== "active") throw new ApiError("NOT_FOUND", "创作者不存在", 404);

  const isSelf = viewer.id === row.id;
  if (row.visibility === "private" && !isSelf && !viewer.staff) {
    throw new ApiError("PROFILE_PRIVATE", "该创作者将主页设为私密", 403);
  }

  const stats = await creatorStats(env, row.id);
  const type = oneOf(url.searchParams.get("type"), POST_TYPES, null);
  const page = pageParams(url);
  const sort = oneOf(url.searchParams.get("sort"), ["latest", "popular", "downloads"], "latest");
  const [posts, featured, following] = await Promise.all([
    listPosts(env, {
      viewerId: viewer.id,
      authorId: row.id,
      type,
      sort,
      status: isSelf ? "published" : "published",
      limit: page.limit,
      offset: page.offset,
    }),
    listPosts(env, { viewerId: viewer.id, authorId: row.id, featured: true, sort: "latest", limit: 3 }),
    isFollowing(env, viewer.id, row.id),
  ]);

  return ok({
    creator: {
      id: row.id,
      displayName: row.display_name,
      bio: row.bio || "",
      creatorTitle: row.creator_title || "",
      avatarUrl: row.avatar_asset_id ? `/api/community/media/${row.avatar_asset_id}` : null,
      coverUrl: row.cover_asset_id ? `/api/community/media/${row.cover_asset_id}` : null,
      visibility: row.visibility,
      role: row.role === "admin" ? "admin" : row.moderator_role ? "moderator" : "member",
      joinedAt: Number(row.created_at),
      isSelf,
      isFollowing: following,
      canFollow: Boolean(viewer.id) && !isSelf,
      canModerate: viewer.staff,
      stats,
    },
    featured: featured.items,
    posts: posts.items,
    total: posts.total,
    page: page.page,
    hasMore: page.offset + posts.items.length < posts.total,
  });
}

/* ============================================================
   作品详情 / 评论 / 版本 / 内容包
   ============================================================ */

async function postDetailHandler({ env, session, id }) {
  const viewer = await viewerContext(env, session);
  const { row, post, isOwner, canModerate } = await loadPost(env, id, viewer);
  if (isOwner && row.draft_manifest_json) {
    try {
      post.draftManifest = JSON.parse(row.draft_manifest_json);
    } catch {
      post.draftManifest = null;
    }
  }
  const [assets, versions, pkg] = await Promise.all([
    getPostAssets(env, id),
    listPostVersions(env, id),
    getPackageForPost(env, id),
  ]);

  const previews = assets.filter((asset) => asset.kind === "preview");
  const wallpapers = assets.filter((asset) => asset.kind === "wallpaper");
  const thumbsByParent = new Map(
    assets
      .filter((asset) => asset.kind === "preview_thumb" || asset.kind === "wallpaper_thumb")
      .map((asset) => [asset.parentAssetId, asset.url]),
  );

  return ok({
    post,
    previews,
    wallpapers,
    versions: post.status === "published" || isOwner || canModerate ? versions : [],
    package: pkg
      ? {
          version: pkg.version,
          type: pkg.type,
          checksum: pkg.checksum,
          sizeBytes: pkg.sizeBytes,
          license: pkg.license,
          compatibility: pkg.compatibility,
        }
      : null,
    viewer: {
      id: viewer.id,
      role: viewer.role,
      staff: viewer.staff,
      admin: viewer.admin,
      isOwner,
      canModerate,
    },
    thumbsByParent: Object.fromEntries(thumbsByParent),
  });
}

async function commentsHandler({ env, session, id, url }) {
  const viewer = await viewerContext(env, session);
  await loadPost(env, id, viewer);
  const page = pageParams(url, { defaultLimit: 12, maxLimit: 30 });
  const result = await listComments(env, id, {
    viewerId: viewer.id,
    staff: viewer.staff,
    page: page.page,
    limit: page.limit,
  });
  return ok({ ...result, viewer: { id: viewer.id, role: viewer.role, staff: viewer.staff } });
}

async function versionsHandler({ env, session, id }) {
  const viewer = await viewerContext(env, session);
  const { post, isOwner, canModerate } = await loadPost(env, id, viewer);
  if (post.status !== "published" && !isOwner && !canModerate) {
    throw new ApiError("NOT_FOUND", "作品不存在", 404);
  }
  return ok({ versions: await listPostVersions(env, id) });
}

async function packageHandler({ env, session, id, url }) {
  const viewer = await viewerContext(env, session);
  const { post, row } = await loadPost(env, id, viewer);
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 文件存储尚未配置", 503);
  const version = String(url.searchParams.get("version") || "").slice(0, 40) || null;
  const pkg = await getPackageForPost(env, id, version);
  if (!pkg) throw new ApiError("PACKAGE_NOT_FOUND", "该作品还没有可安装的内容包", 404);

  const object = await env.FILES.get(pkg.packageKey);
  if (!object) throw new ApiError("PACKAGE_MISSING", "内容包文件缺失，请联系作者", 404);
  const text = await object.text();
  const digest = await sha256Hex(text);
  if (digest !== pkg.checksum) {
    throw new ApiError("PACKAGE_INTEGRITY_ERROR", "内容包校验失败，已阻止安装", 409);
  }

  if (url.searchParams.get("count") === "1" && post.status === "published") {
    await env.DB.prepare("UPDATE community_posts SET download_count = download_count + 1 WHERE id = ?").bind(id).run();
  }

  return ok({
    postId: id,
    packageId: pkg.packageId,
    type: pkg.type,
    version: pkg.version,
    license: pkg.license,
    compatibility: pkg.compatibility,
    checksum: pkg.checksum,
    sizeBytes: pkg.sizeBytes,
    packageJson: text,
    postVersion: row.version,
  });
}

/* ============================================================
   媒体：R2 私有读取 + 发布状态闸门
   ============================================================ */

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function mediaHandler({ env, request, parts, session }) {
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 文件存储尚未配置", 503);
  const assetId = parts[1];
  if (!/^[0-9a-f-]{36}$/.test(String(assetId))) throw new ApiError("NOT_FOUND", "资源不存在", 404);

  const asset = await env.DB.prepare("SELECT * FROM community_assets WHERE id = ? AND status = 'ready'").bind(assetId).first();
  if (!asset) throw new ApiError("NOT_FOUND", "资源不存在", 404);

  const viewer = await viewerContext(env, session);
  const isOwner = viewer.id === asset.user_id;

  // 可见性只由「所在作品的发布状态」或「是否被公开资料引用」决定。
  // 草稿 / 待审核作品的封面同样不能被公开读取，避免通过猜 UUID 泄露未发布内容。
  let isPublic = false;
  if (asset.post_id) {
    const post = await env.DB.prepare("SELECT status FROM community_posts WHERE id = ?")
      .bind(asset.post_id)
      .first();
    if (post?.status === "published") isPublic = true;
  } else if (asset.kind === "avatar" || asset.kind === "cover") {
    const referenced = await env.DB.prepare(
      "SELECT 1 AS ok FROM community_profiles WHERE avatar_asset_id = ? OR cover_asset_id = ? LIMIT 1",
    )
      .bind(asset.id, asset.id)
      .first();
    if (referenced) isPublic = true;
  }

  if (!isPublic && !isOwner && !viewer.staff) {
    throw new ApiError("NOT_FOUND", "资源不存在", 404);
  }

  const etag = `"${asset.id}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const object = await env.FILES.get(asset.object_key);
  if (!object) throw new ApiError("NOT_FOUND", "资源文件不存在", 404);

  const headers = new Headers({
    "content-type": asset.mime_type,
    "content-length": String(object.size),
    etag,
    "x-content-type-options": "nosniff",
    "cache-control": isPublic ? "public, max-age=300" : "private, no-store",
    "content-security-policy": "default-src 'none'; img-src 'self'",
  });
  if (request.url.includes("download=1")) {
    const ext = MIME_EXT[asset.mime_type] || "jpg";
    headers.set("content-disposition", `attachment; filename="guandao-${asset.kind}-${asset.id.slice(0, 8)}.${ext}"`);
    headers.set("cache-control", "private, no-store");
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

/* ============================================================
   导出给其它路由使用（健康检查 / 测试）
   ============================================================ */

export async function communityHealth(env) {
  const settings = await getSettings(env);
  const stats = await communityStats(env);
  return { configured: Boolean(settings), settings: publicSettings(settings), stats };
}

export { mapAsset, validateManifest };
