/**
 * Guandao OS 1.6 · 社区 D1 访问层
 *
 * 所有查询都使用绑定参数。作品可见性只由 status 决定，浏览者身份只用于
 * 计算「我是否点赞 / 收藏 / 关注」以及作者 / 审核员的越权读取，绝不由前端传入。
 */

const POST_VIEWER_SELECT = `
  EXISTS (SELECT 1 FROM community_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS viewer_liked,
  EXISTS (SELECT 1 FROM community_favorites f WHERE f.post_id = p.id AND f.user_id = ?) AS viewer_favorited,
  EXISTS (SELECT 1 FROM community_follows cf WHERE cf.follower_id = ? AND cf.following_id = p.author_id) AS viewer_following`;

const POST_FROM = `
  FROM community_posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN community_profiles pr ON pr.user_id = p.author_id
  LEFT JOIN community_roles cr ON cr.user_id = p.author_id`;

const POST_COLUMNS = `
  p.*,
  u.github_username AS author_username,
  u.role AS author_user_role,
  cr.role AS author_moderator_role,
  COALESCE(pr.display_name, u.display_name, u.github_username, '创作者') AS author_display_name,
  pr.avatar_asset_id AS author_avatar_asset_id,
  pr.creator_title AS author_creator_title,
  pr.visibility AS author_visibility,
  (SELECT COUNT(*) FROM community_reports r
    WHERE r.target_type = 'post' AND r.target_id = p.id AND r.status IN ('open', 'reviewing')) AS report_count`;

const SORT_SQL = {
  latest: "COALESCE(p.published_at, p.created_at) DESC, p.created_at DESC",
  updated: "p.updated_at DESC",
  popular: "(p.like_count * 3 + p.favorite_count * 4 + p.comment_count * 2 + p.download_count * 2) DESC, COALESCE(p.published_at, p.created_at) DESC",
  downloads: "p.download_count DESC, COALESCE(p.published_at, p.created_at) DESC",
  favorites: "p.favorite_count DESC, COALESCE(p.published_at, p.created_at) DESC",
  likes: "p.like_count DESC, COALESCE(p.published_at, p.created_at) DESC",
  newest: "p.created_at DESC",
  // 真实互动数据 + 时间衰减：互动量 / (1 + 发布天数 / 7)
  trending: `((p.like_count * 3 + p.favorite_count * 4 + p.comment_count * 2 + p.download_count * 2 + p.view_count * 0.15)
    / (1.0 + (MAX(0, (? - COALESCE(p.published_at, p.created_at))) / 86400000.0) / 7.0)) DESC,
    (p.like_count + p.favorite_count + p.comment_count + p.download_count + p.view_count) DESC`,
};

export function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    url: `/api/community/media/${row.id}`,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    parentAssetId: row.parent_asset_id || null,
    sortOrder: Number(row.sort_order || 0),
  };
}

export function mapAuthor(row, prefix = "author_") {
  const id = row?.[`${prefix}id`];
  if (!id) return null;
  const avatar = row[`${prefix}avatar_asset_id`];
  return {
    id,
    displayName: row[`${prefix}display_name`] || row[`${prefix}username`] || "创作者",
    avatarUrl: avatar ? `/api/community/media/${avatar}` : null,
    creatorTitle: row[`${prefix}creator_title`] || "",
    role: row[`${prefix}user_role`] === "admin" ? "admin" : row[`${prefix}moderator_role`] ? "moderator" : "member",
  };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function mapPost(row, { includeModeration = false } = {}) {
  if (!row) return null;
  const post = {
    id: row.id,
    type: row.post_type,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: parseJson(row.tags_json, []),
    license: row.license,
    licenseNote: row.license_note || "",
    status: row.status,
    visibility: row.visibility,
    version: row.version,
    compatibility: parseJson(row.compatibility_json, {}),
    packageId: row.package_id || null,
    featured: Boolean(row.featured_at),
    featuredAt: row.featured_at ? Number(row.featured_at) : null,
    likeCount: Number(row.like_count || 0),
    favoriteCount: Number(row.favorite_count || 0),
    commentCount: Number(row.comment_count || 0),
    downloadCount: Number(row.download_count || 0),
    viewCount: Number(row.view_count || 0),
    reportCount: Number(row.report_count || 0),
    viewer: {
      liked: Boolean(row.viewer_liked),
      favorited: Boolean(row.viewer_favorited),
      following: Boolean(row.viewer_following),
    },
    author: mapAuthor(row),
    coverUrl: row.cover_asset_id ? `/api/community/media/${row.cover_asset_id}` : null,
    coverThumbUrl: row.cover_thumb_asset_id
      ? `/api/community/media/${row.cover_thumb_asset_id}`
      : row.cover_asset_id
        ? `/api/community/media/${row.cover_asset_id}`
        : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    publishedAt: row.published_at ? Number(row.published_at) : null,
  };
  if (includeModeration) {
    post.moderationNote = row.moderation_note || "";
    post.rightsConfirmed = Boolean(row.rights_confirmed);
  }
  return post;
}

/* ============================================================
   列表
   ============================================================ */

export async function listPosts(env, options = {}) {
  const {
    viewerId = null,
    status = "published",
    statuses = null,
    authorId = null,
    type = null,
    category = null,
    tag = null,
    search = null,
    featured = false,
    followingOf = null,
    sort = "latest",
    limit = 24,
    offset = 0,
    minInteractions = false,
    excludeIds = [],
    publicOnly = true,
  } = options;

  const viewer = viewerId || "__anonymous__";
  const where = [];
  const binds = [];

  if (statuses?.length) {
    where.push(`p.status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  } else {
    where.push("p.status = ?");
    binds.push(status);
  }
  if (publicOnly) where.push("p.visibility = 'public'");
  if (authorId) {
    where.push("p.author_id = ?");
    binds.push(authorId);
  }
  if (type) {
    where.push("p.post_type = ?");
    binds.push(type);
  }
  if (category) {
    where.push("p.category = ?");
    binds.push(category);
  }
  if (tag) {
    where.push("p.tags_json LIKE ? ESCAPE '\\'");
    binds.push(`%"${tag.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`);
  }
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.tags_json LIKE ? ESCAPE '\\'
                 OR COALESCE(pr.display_name, u.display_name, u.github_username) LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like, like);
  }
  if (featured) where.push("p.featured_at IS NOT NULL");
  if (followingOf) {
    where.push("p.author_id IN (SELECT following_id FROM community_follows WHERE follower_id = ?)");
    binds.push(followingOf);
  }
  if (minInteractions) {
    where.push("(p.like_count + p.favorite_count + p.comment_count + p.download_count + p.view_count) > 0");
  }
  if (excludeIds.length) {
    where.push(`p.id NOT IN (${excludeIds.map(() => "?").join(", ")})`);
    binds.push(...excludeIds);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const orderSql = SORT_SQL[sort] ?? SORT_SQL.latest;
  const orderBinds = sort === "trending" ? [Date.now()] : [];
  const safeLimit = Math.max(1, Math.min(60, Number(limit) || 24));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const sql = `SELECT ${POST_COLUMNS}, ${POST_VIEWER_SELECT}
    ${POST_FROM} ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?`;
  const result = await env.DB.prepare(sql)
    .bind(viewer, viewer, viewer, ...orderBinds, ...binds, safeLimit, safeOffset)
    .all();

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total ${POST_FROM} ${whereSql}`)
    .bind(...binds)
    .first();

  return {
    items: (result.results || []).map((row) => mapPost(row)),
    total: Number(countRow?.total || 0),
  };
}

export async function getPostRow(env, id, viewerId = null) {
  const viewer = viewerId || "__anonymous__";
  return env.DB.prepare(
    `SELECT ${POST_COLUMNS}, ${POST_VIEWER_SELECT} ${POST_FROM} WHERE p.id = ?`,
  )
    .bind(viewer, viewer, viewer, id)
    .first();
}

export async function getPostAssets(env, postId) {
  const rows = await env.DB.prepare(
    `SELECT * FROM community_assets
      WHERE post_id = ? AND status = 'ready'
      ORDER BY sort_order ASC, created_at ASC`,
  )
    .bind(postId)
    .all();
  return (rows.results || []).map(mapAsset);
}

export async function listPostVersions(env, postId) {
  const rows = await env.DB.prepare(
    `SELECT v.* FROM package_versions v
       JOIN community_packages p ON p.id = v.package_id
      WHERE p.post_id = ?
      ORDER BY v.created_at DESC`,
  )
    .bind(postId)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    version: row.version,
    changelog: row.changelog,
    compatibility: parseJson(row.compatibility_json, {}),
    checksum: row.checksum_sha256,
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: Number(row.created_at),
    publishedAt: row.published_at ? Number(row.published_at) : null,
  }));
}

export async function getPackageForPost(env, postId, version = null) {
  const pkg = await env.DB.prepare("SELECT * FROM community_packages WHERE post_id = ? AND status = 'active'").bind(postId).first();
  if (!pkg) return null;
  if (!version || version === pkg.version) {
    return {
      packageRowId: pkg.id,
      packageId: pkg.package_id,
      type: pkg.package_type,
      version: pkg.version,
      license: pkg.license,
      compatibility: parseJson(pkg.compatibility_json, {}),
      packageKey: pkg.package_object_key,
      manifestKey: pkg.manifest_object_key,
      checksum: pkg.checksum_sha256,
      sizeBytes: Number(pkg.size_bytes || 0),
      createdAt: Number(pkg.created_at),
    };
  }
  const row = await env.DB.prepare(
    "SELECT * FROM package_versions WHERE package_id = ? AND version = ?",
  )
    .bind(pkg.id, version)
    .first();
  if (!row) return null;
  return {
    packageRowId: pkg.id,
    packageId: pkg.package_id,
    type: pkg.package_type,
    version: row.version,
    license: pkg.license,
    compatibility: parseJson(row.compatibility_json, {}),
    packageKey: row.package_object_key,
    manifestKey: row.manifest_object_key,
    checksum: row.checksum_sha256,
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: Number(row.created_at),
  };
}

/* ============================================================
   评论
   ============================================================ */

const COMMENT_SELECT = `
  c.*,
  COALESCE(pr.display_name, u.display_name, u.github_username, '用户') AS author_display_name,
  pr.avatar_asset_id AS author_avatar_asset_id,
  u.role AS author_user_role,
  cr.role AS author_moderator_role,
  u.id AS author_id`;

function mapComment(row, viewerId, staff) {
  const hidden = row.status === "hidden";
  if (hidden && !staff) return null;
  const deleted = row.status === "deleted";
  return {
    id: row.id,
    postId: row.post_id,
    parentId: row.parent_id || null,
    content: deleted ? "" : row.content,
    status: row.status,
    canDelete: !deleted && (row.user_id === viewerId || staff),
    author: deleted
      ? null
      : {
          id: row.user_id,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_asset_id ? `/api/community/media/${row.author_avatar_asset_id}` : null,
          role: row.author_user_role === "admin" ? "admin" : row.author_moderator_role ? "moderator" : "member",
        },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listComments(env, postId, { viewerId = null, staff = false, page = 1, limit = 12 } = {}) {
  const offset = (page - 1) * limit;
  const visibleSql = staff ? "c.status IN ('visible', 'hidden', 'deleted')" : "c.status IN ('visible', 'deleted')";
  const topRows = await env.DB.prepare(
    `SELECT ${COMMENT_SELECT}
       FROM community_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN community_profiles pr ON pr.user_id = c.user_id
       LEFT JOIN community_roles cr ON cr.user_id = c.user_id
      WHERE c.post_id = ? AND c.parent_id IS NULL AND ${visibleSql}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(postId, limit, offset)
    .all();

  const tops = (topRows.results || []).map((row) => mapComment(row, viewerId, staff)).filter(Boolean);
  const ids = tops.map((comment) => comment.id);
  let replies = [];
  if (ids.length) {
    const replyRows = await env.DB.prepare(
      `SELECT ${COMMENT_SELECT}
         FROM community_comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN community_profiles pr ON pr.user_id = c.user_id
         LEFT JOIN community_roles cr ON cr.user_id = c.user_id
        WHERE c.parent_id IN (${ids.map(() => "?").join(", ")}) AND ${visibleSql}
        ORDER BY c.created_at ASC
        LIMIT 120`,
    )
      .bind(...ids)
      .all();
    replies = (replyRows.results || []).map((row) => mapComment(row, viewerId, staff)).filter(Boolean);
  }

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM community_comments
      WHERE post_id = ? AND parent_id IS NULL AND status = 'visible'`,
  )
    .bind(postId)
    .first();

  return {
    items: tops.map((top) => ({ ...top, replies: replies.filter((reply) => reply.parentId === top.id) })),
    total: Number(totalRow?.total || 0),
    page,
    limit,
    hasMore: offset + tops.length < Number(totalRow?.total || 0),
  };
}

/* ============================================================
   创作者
   ============================================================ */

export async function getCreatorRow(env, userId) {
  return env.DB.prepare(
    `SELECT u.id, u.github_username, u.role, u.status, u.created_at,
            COALESCE(pr.display_name, u.display_name, u.github_username) AS display_name,
            pr.bio, pr.creator_title, pr.avatar_asset_id, pr.cover_asset_id,
            COALESCE(pr.visibility, 'public') AS visibility,
            pr.restriction, cr.role AS moderator_role
       FROM users u
       LEFT JOIN community_profiles pr ON pr.user_id = u.id
       LEFT JOIN community_roles cr ON cr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first();
}

export async function creatorStats(env, userId) {
  const [stats, followers, following, followingViewer] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS posts,
              COALESCE(SUM(like_count), 0) AS likes,
              COALESCE(SUM(favorite_count), 0) AS favorites,
              COALESCE(SUM(download_count), 0) AS downloads
         FROM community_posts
        WHERE author_id = ? AND status = 'published'`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_follows WHERE following_id = ?").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_follows WHERE follower_id = ?").bind(userId).first(),
    Promise.resolve(null),
  ]);
  return {
    posts: Number(stats?.posts || 0),
    likes: Number(stats?.likes || 0),
    favorites: Number(stats?.favorites || 0),
    downloads: Number(stats?.downloads || 0),
    followers: Number(followers?.total || 0),
    following: Number(following?.total || 0),
    followingViewer,
  };
}

export async function listCreators(env, { viewerId = null, sort = "active", limit = 12, offset = 0, search = null } = {}) {
  const where = [
    "u.status = 'active'",
    "COALESCE(pr.visibility, 'public') = 'public'",
    // 只有真正发布过作品的创作者才进入目录，避免把只是注册/浏览的用户
    // 未经主动展示就列成公开创作者主页。
    "EXISTS (SELECT 1 FROM community_posts p WHERE p.author_id = u.id AND p.status = 'published')",
  ];
  const binds = [];
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(COALESCE(pr.display_name, u.display_name, u.github_username) LIKE ? ESCAPE '\\' OR pr.bio LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const order = sort === "new"
    ? "u.created_at DESC"
    : "(SELECT COUNT(*) FROM community_posts p WHERE p.author_id = u.id AND p.status = 'published') DESC, u.created_at ASC";
  const rows = await env.DB.prepare(
    `SELECT u.id, u.github_username, u.role, u.created_at AS user_created_at,
            COALESCE(pr.display_name, u.display_name, u.github_username) AS display_name,
            pr.bio, pr.creator_title, pr.avatar_asset_id, pr.cover_asset_id, pr.visibility,
            cr.role AS moderator_role,
            (SELECT COUNT(*) FROM community_posts p WHERE p.author_id = u.id AND p.status = 'published') AS post_count,
            (SELECT COUNT(*) FROM community_follows f WHERE f.following_id = u.id) AS follower_count,
            (SELECT COUNT(*) FROM community_posts p WHERE p.author_id = u.id AND p.status = 'published' AND p.featured_at IS NOT NULL) AS featured_count
       FROM users u
       LEFT JOIN community_profiles pr ON pr.user_id = u.id
       LEFT JOIN community_roles cr ON cr.user_id = u.id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all();
  let followed = new Set();
  if (viewerId) {
    const followRows = await env.DB.prepare(
      "SELECT following_id FROM community_follows WHERE follower_id = ?",
    )
      .bind(viewerId)
      .all();
    followed = new Set((followRows.results || []).map((row) => row.following_id));
  }
  return (rows.results || []).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_asset_id ? `/api/community/media/${row.avatar_asset_id}` : null,
    coverUrl: row.cover_asset_id ? `/api/community/media/${row.cover_asset_id}` : null,
    creatorTitle: row.creator_title || "",
    bio: row.bio || "",
    role: row.role === "admin" ? "admin" : row.moderator_role ? "moderator" : "member",
    postCount: Number(row.post_count || 0),
    followerCount: Number(row.follower_count || 0),
    featuredCount: Number(row.featured_count || 0),
    joinedAt: Number(row.user_created_at),
    isFollowing: followed.has(row.id),
  }));
}

export async function isFollowing(env, followerId, followingId) {
  if (!followerId || !followingId) return false;
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM community_follows WHERE follower_id = ? AND following_id = ?")
      .bind(followerId, followingId)
      .first(),
  );
}

/* ============================================================
   我的收藏 / 通知 / 用量
   ============================================================ */

export async function listFavorites(env, userId, { collection = null, limit = 24, offset = 0 } = {}) {
  const where = ["f.user_id = ?", "p.status = 'published'"];
  const binds = [userId];
  if (collection) {
    where.push("f.collection = ?");
    binds.push(collection);
  }
  const viewer = userId;
  const rows = await env.DB.prepare(
    `SELECT ${POST_COLUMNS}, ${POST_VIEWER_SELECT}, f.collection AS favorite_collection, f.created_at AS favorited_at
       ${POST_FROM}
       JOIN community_favorites f ON f.post_id = p.id
      WHERE ${where.join(" AND ")}
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(viewer, viewer, viewer, ...binds, limit, offset)
    .all();
  return (rows.results || []).map((row) => ({
    ...mapPost(row),
    favoriteCollection: row.favorite_collection,
    favoritedAt: Number(row.favorited_at),
  }));
}

export async function listFavoriteCollections(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT collection, COUNT(*) AS total FROM community_favorites WHERE user_id = ? GROUP BY collection ORDER BY total DESC",
  )
    .bind(userId)
    .all();
  return (rows.results || []).map((row) => ({ name: row.collection, count: Number(row.total) }));
}

export async function listNotifications(env, userId, { limit = 30, offset = 0 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT n.*, COALESCE(pr.display_name, u.display_name, u.github_username) AS actor_display_name,
            pr.avatar_asset_id AS actor_avatar_asset_id, p.title AS post_title, p.post_type
       FROM community_notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN community_profiles pr ON pr.user_id = n.actor_id
       LEFT JOIN community_posts p ON p.id = n.post_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(userId, limit, offset)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    type: row.type,
    actor: row.actor_id
      ? {
          id: row.actor_id,
          displayName: row.actor_display_name || "用户",
          avatarUrl: row.actor_avatar_asset_id ? `/api/community/media/${row.actor_avatar_asset_id}` : null,
        }
      : null,
    postId: row.post_id || null,
    postTitle: row.post_title || "",
    postType: row.post_type || null,
    commentId: row.comment_id || null,
    payload: parseJson(row.payload_json, {}),
    read: Boolean(row.read_at),
    createdAt: Number(row.created_at),
  }));
}

export async function unreadNotificationCount(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM community_notifications WHERE user_id = ? AND read_at IS NULL",
  )
    .bind(userId)
    .first();
  return Number(row?.total || 0);
}

export async function userUsage(env, userId) {
  const [assets, packages, posts] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM community_assets WHERE user_id = ? AND status <> 'deleted'",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes FROM community_packages WHERE author_id = ? AND status = 'active'",
    )
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_posts WHERE author_id = ? AND status <> 'deleted'")
      .bind(userId)
      .first(),
  ]);
  return {
    assetCount: Number(assets?.files || 0),
    assetBytes: Number(assets?.bytes || 0),
    packageCount: Number(packages?.total || 0),
    packageBytes: Number(packages?.bytes || 0),
    postCount: Number(posts?.total || 0),
    totalBytes: Number(assets?.bytes || 0) + Number(packages?.bytes || 0),
  };
}

/* ============================================================
   举报 / 审核 / 审计 / 统计
   ============================================================ */

export async function listReports(env, { status = "open", limit = 24, offset = 0 } = {}) {
  const where = status === "all" ? "" : "WHERE r.status = ?";
  const binds = status === "all" ? [] : [status];
  const rows = await env.DB.prepare(
    `SELECT r.*,
            rp.display_name AS reporter_name,
            tp.title AS post_title, tp.post_type AS post_type, tp.author_id AS post_author_id,
            tc.content AS comment_content, tc.post_id AS comment_post_id, tc.user_id AS comment_author_id,
            tpr.display_name AS profile_name
       FROM community_reports r
       LEFT JOIN community_profiles rp ON rp.user_id = r.reporter_id
       LEFT JOIN community_posts tp ON r.target_type = 'post' AND tp.id = r.target_id
       LEFT JOIN community_comments tc ON r.target_type = 'comment' AND tc.id = r.target_id
       LEFT JOIN community_profiles tpr ON r.target_type = 'profile' AND tpr.user_id = r.target_id
       ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name || "社区成员",
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    description: row.description,
    status: row.status,
    resolution: row.resolution || "",
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : null,
    target:
      row.target_type === "post"
        ? { title: row.post_title || "已删除作品", postType: row.post_type, authorId: row.post_author_id }
        : row.target_type === "comment"
          ? { content: (row.comment_content || "").slice(0, 180), postId: row.comment_post_id, authorId: row.comment_author_id }
          : { displayName: row.profile_name || "已删除用户" },
  }));
}

export async function communityStats(env) {
  const [users, posts, pending, reports, assets, packages] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_profiles").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_posts WHERE status = 'published'").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_posts WHERE status = 'pending_review'").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM community_reports WHERE status IN ('open', 'reviewing')").first(),
    env.DB.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM community_assets WHERE status = 'ready'").first(),
    env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes FROM community_packages WHERE status = 'active'").first(),
  ]);
  return {
    creators: Number(users?.total || 0),
    publishedPosts: Number(posts?.total || 0),
    pendingReview: Number(pending?.total || 0),
    openReports: Number(reports?.total || 0),
    assetFiles: Number(assets?.files || 0),
    assetBytes: Number(assets?.bytes || 0),
    packages: Number(packages?.total || 0),
    packageBytes: Number(packages?.bytes || 0),
    storageBytes: Number(assets?.bytes || 0) + Number(packages?.bytes || 0),
  };
}

export async function listAuditLogs(env, { limit = 40, offset = 0 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT a.*, COALESCE(pr.display_name, u.display_name, u.github_username) AS actor_name
       FROM community_audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN community_profiles pr ON pr.user_id = a.actor_id
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name || "系统",
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: parseJson(row.detail_json, {}),
    createdAt: Number(row.created_at),
  }));
}

export async function listUsersForAdmin(env, { search = null, limit = 30, offset = 0 } = {}) {
  const where = [];
  const binds = [];
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(u.github_username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR pr.display_name LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const rows = await env.DB.prepare(
    `SELECT u.id, u.github_username, u.display_name, u.role, u.status, u.created_at,
            pr.display_name AS profile_name, pr.avatar_asset_id, pr.restriction, pr.restriction_reason,
            cr.role AS moderator_role,
            (SELECT COUNT(*) FROM community_posts p WHERE p.author_id = u.id AND p.status = 'published') AS post_count,
            (SELECT COUNT(*) FROM community_reports r WHERE r.target_type = 'profile' AND r.target_id = u.id AND r.status = 'open') AS report_count
       FROM users u
       LEFT JOIN community_profiles pr ON pr.user_id = u.id
       LEFT JOIN community_roles cr ON cr.user_id = u.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.created_at ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    username: row.github_username,
    displayName: row.profile_name || row.display_name || row.github_username,
    avatarUrl: row.avatar_asset_id ? `/api/community/media/${row.avatar_asset_id}` : null,
    role: row.role === "admin" ? "admin" : row.moderator_role ? "moderator" : "member",
    status: row.status,
    restriction: row.restriction || "none",
    restrictionReason: row.restriction_reason || "",
    postCount: Number(row.post_count || 0),
    reportCount: Number(row.report_count || 0),
    createdAt: Number(row.created_at),
  }));
}

/* ============================================================
   计数重算（避免并发导致缓存计数漂移）
   ============================================================ */

export async function recomputePostCounters(env, postId) {
  await env.DB.prepare(
    `UPDATE community_posts
        SET like_count = (SELECT COUNT(*) FROM community_likes WHERE post_id = ?),
            favorite_count = (SELECT COUNT(*) FROM community_favorites WHERE post_id = ?),
            comment_count = (SELECT COUNT(*) FROM community_comments WHERE post_id = ? AND status = 'visible')
      WHERE id = ?`,
  )
    .bind(postId, postId, postId, postId)
    .run();
}

export async function getRawPost(env, postId) {
  return env.DB.prepare("SELECT * FROM community_posts WHERE id = ?").bind(postId).first();
}

export async function getSettings(env) {
  return env.DB.prepare("SELECT * FROM community_settings WHERE id = 1").first();
}

export function publicSettings(row) {
  if (!row) return null;
  return {
    registrationMode: row.registration_mode,
    requireReview: Boolean(row.require_review),
    memberLogin: Boolean(row.member_login),
    allowPublishing: Boolean(row.allow_publishing),
    maxPostsPerDay: Number(row.max_posts_per_day),
    maxCommentsPerDay: Number(row.max_comments_per_day),
    maxPackagesPerUser: Number(row.max_packages_per_user),
    maxUserStorageBytes: Number(row.max_user_storage_bytes),
    maxUploadBytes: Number(row.max_upload_bytes),
    communityName: row.community_name,
    announcement: row.announcement,
  };
}

export async function overviewCounts(env) {
  const rows = await env.DB.prepare(
    "SELECT post_type, COUNT(*) AS total FROM community_posts WHERE status = 'published' GROUP BY post_type",
  ).all();
  const byType = {};
  for (const row of rows.results || []) byType[row.post_type] = Number(row.total);
  return byType;
}
