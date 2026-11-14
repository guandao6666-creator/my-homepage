/**
 * Guandao OS 1.7 · 插件数据访问
 *
 * 所有 SQL 都集中在这里，路由只做参数与权限判断。
 * 原则：
 *   - 只有 status='published' 且存在 approved 版本的插件会进入市场；
 *   - 计数列只是缓存，写入后用 COUNT(*) 重算；
 *   - 客户端传入的任何 user_id / developer_id 一律忽略。
 */

import { compareSemver } from "../../../shared/plugin-spec.js";

export const PLUGIN_SELECT = `
  SELECT p.*,
         p.developer_id AS author_id,
         COALESCE(dp.display_name, cp.display_name, u.github_username, '开发者') AS author_display_name,
         cp.avatar_asset_id AS author_avatar_asset_id,
         u.github_username AS author_username,
         u.role AS author_user_role
    FROM plugins p
    LEFT JOIN developer_profiles dp ON dp.user_id = p.developer_id
    LEFT JOIN community_profiles cp ON cp.user_id = p.developer_id
    LEFT JOIN users u ON u.id = p.developer_id
`;

export function safeParse(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function mapAuthor(row) {
  const id = row?.author_id ?? row?.developer_id;
  if (!id) return { id: "", name: "开发者", avatarUrl: null, role: "member" };
  return {
    id,
    name: row.author_display_name || row.author_username || "开发者",
    avatarUrl: row.author_avatar_asset_id ? `/api/community/media/${row.author_avatar_asset_id}` : null,
    role: row.author_user_role === "admin" ? "admin" : "member",
  };
}

export function iconUrlFor(row) {
  if (!row?.icon_key) return "";
  return `/api/plugins/${encodeURIComponent(row.id)}/icon?v=${Number(row.updated_at) || 0}`;
}

export function mapSignatureTrust(row) {
  if (!row) return { status: "unsigned", keyId: null, signedAt: null };
  const status = row.signature_status || "unsigned";
  return {
    status: status === "verified" || status === "invalid" ? status : "unsigned",
    keyId: row.signature_key_id || null,
    signedAt: row.signed_at ? Number(row.signed_at) : null,
  };
}

export function mapPluginCard(row, options = {}) {
  const version = options.version ?? null;
  const manifest = safeParse(version?.manifest_json ?? row.latest_manifest_json, null);
  const install = options.install ?? null;
  const permissions = manifest?.permissions ?? safeParse(row.permissions_json, []);
  const compatibility = manifest?.compatibility ?? safeParse(row.compatibility_json, {});
  const ratingCount = Number(row.rating_count || 0);
  const ratingSum = Number(row.rating_sum || 0);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    category: row.category,
    license: row.license,
    author: mapAuthor(row),
    iconUrl: iconUrlFor(row),
    version: version?.version ?? row.latest_version ?? "",
    compatibility: {
      minimumOSVersion: String(compatibility?.minimumOSVersion ?? "1.7.0"),
      sdkVersion: Number(compatibility?.sdkVersion ?? 1),
    },
    permissions: Array.isArray(permissions) ? permissions : [],
    networkDomains: Array.isArray(manifest?.networkDomains) ? manifest.networkDomains : [],
    downloads: Number(row.download_count || 0),
    installs: Number(row.install_count || 0),
    recentDownloads: Number(row.recent_downloads || 0),
    rating: {
      average: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
      count: ratingCount,
    },
    featured: Boolean(row.featured_at),
    status: row.status,
    security: {
      reviewStatus: version?.status ?? null,
      reviewedAt: version?.reviewed_at ? Number(version.reviewed_at) : null,
      audited: Boolean(version?.reviewed_at),
      signature: mapSignatureTrust(version),
    },
    installed: Boolean(install),
    installedVersion: install?.version ?? null,
    enabled: install ? Boolean(install.enabled) : false,
    updateAvailable: Boolean(
      install && version?.version && compareSemver(version.version, install.version) > 0,
    ),
    publishedAt: row.published_at ? Number(row.published_at) : null,
    updatedAt: Number(row.updated_at),
  };
}

export function mapVersion(row, { includePackage = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    version: row.version,
    changelog: row.changelog ?? "",
    status: row.status,
    sizeBytes: Number(row.size_bytes || 0),
    checksum: row.package_sha256,
    manifest: safeParse(row.manifest_json, null),
    reviewNote: row.review_note ?? "",
    reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : null,
    createdAt: Number(row.created_at),
    publishedAt: row.published_at ? Number(row.published_at) : null,
    signature: mapSignatureTrust(row),
  };
  if (includePackage) out.packageKey = row.package_key;
  return out;
}

export function mapInstallation(row) {
  if (!row) return null;
  return {
    pluginId: row.plugin_id,
    version: row.version,
    enabled: Boolean(row.enabled),
    status: row.status,
    source: row.source,
    packageSha256: row.package_sha256,
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
    lastLaunchedAt: row.last_launched_at ? Number(row.last_launched_at) : null,
  };
}

export async function getPluginRow(env, id) {
  if (!id) return null;
  return env.DB.prepare(`${PLUGIN_SELECT} WHERE p.id = ? AND p.status != 'deleted'`).bind(String(id)).first();
}

/** 开发者的原始行（不含作者联表），用于校验归属。 */
export async function getOwnedPlugin(env, id, userId) {
  return env.DB.prepare("SELECT * FROM plugins WHERE id = ? AND developer_id = ? AND status != 'deleted'")
    .bind(String(id), userId)
    .first();
}

export async function getAnyPluginRaw(env, id) {
  return env.DB.prepare("SELECT * FROM plugins WHERE id = ?").bind(String(id)).first();
}

export async function latestApprovedVersion(env, pluginId) {
  const rows = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 50",
  )
    .bind(pluginId)
    .all();
  const list = rows.results ?? [];
  if (!list.length) return null;
  return list.sort((a, b) => compareSemver(b.version, a.version))[0];
}

export async function approvedVersions(env, pluginId, limit = 30) {
  const rows = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT ?",
  )
    .bind(pluginId, limit)
    .all();
  return (rows.results ?? []).sort((a, b) => compareSemver(b.version, a.version));
}

export async function allVersions(env, pluginId, limit = 50) {
  const rows = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(pluginId, limit)
    .all();
  return rows.results ?? [];
}

export async function getVersionRow(env, pluginId, version) {
  if (!version) {
    return env.DB.prepare(
      "SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(pluginId)
      .first();
  }
  return env.DB.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(pluginId, String(version))
    .first();
}

export async function installFor(env, userId, pluginId) {
  if (!userId) return null;
  return env.DB.prepare("SELECT * FROM plugin_installations WHERE user_id = ? AND plugin_id = ?")
    .bind(userId, pluginId)
    .first();
}

export async function installationsForUser(env, userId) {
  const rows = await env.DB.prepare(
    `${PLUGIN_SELECT}
       INNER JOIN plugin_installations i ON i.plugin_id = p.id AND i.user_id = ?
      WHERE p.status != 'deleted'
      ORDER BY i.updated_at DESC`,
  )
    .bind(userId)
    .all();
  return rows.results ?? [];
}

export async function permissionsFor(env, userId, pluginId) {
  const rows = await env.DB.prepare(
    "SELECT permission FROM plugin_permissions WHERE user_id = ? AND plugin_id = ? ORDER BY permission",
  )
    .bind(userId, pluginId)
    .all();
  return (rows.results ?? []).map((row) => row.permission);
}

export async function setPermissions(env, userId, pluginId, permissions, via = "install") {
  const list = [...new Set(Array.isArray(permissions) ? permissions.map(String) : [])];
  const existing = await permissionsFor(env, userId, pluginId);
  const remove = existing.filter((id) => !list.includes(id));
  const now = Date.now();
  const statements = [];
  for (const id of remove) {
    statements.push(
      env.DB.prepare("DELETE FROM plugin_permissions WHERE user_id = ? AND plugin_id = ? AND permission = ?")
        .bind(userId, pluginId, id),
    );
  }
  for (const id of list) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO plugin_permissions (user_id, plugin_id, permission, granted_via, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, plugin_id, permission) DO NOTHING`,
      ).bind(userId, pluginId, id, via, now),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return permissionsFor(env, userId, pluginId);
}

export async function recomputePluginCounters(env, pluginId) {
  await env.DB.prepare(
    `UPDATE plugins SET
       install_count = (SELECT COUNT(*) FROM plugin_installations WHERE plugin_id = ?),
       rating_count = (SELECT COUNT(*) FROM plugin_reviews WHERE plugin_id = ? AND status = 'visible'),
       rating_sum = (SELECT COALESCE(SUM(rating), 0) FROM plugin_reviews WHERE plugin_id = ? AND status = 'visible')
     WHERE id = ?`,
  )
    .bind(pluginId, pluginId, pluginId, pluginId)
    .run();
}

export async function ratingDistribution(env, pluginId) {
  const rows = await env.DB.prepare(
    `SELECT rating, COUNT(*) AS n FROM plugin_reviews
      WHERE plugin_id = ? AND status = 'visible' GROUP BY rating`,
  )
    .bind(pluginId)
    .all();
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows.results ?? []) out[Number(row.rating)] = Number(row.n);
  return out;
}

export async function listReviews(env, pluginId, { limit = 12, offset = 0 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT r.*, COALESCE(cp.display_name, u.github_username, '用户') AS display_name,
            cp.avatar_asset_id AS avatar_asset_id
       FROM plugin_reviews r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN community_profiles cp ON cp.user_id = r.user_id
      WHERE r.plugin_id = ? AND r.status = 'visible'
      ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(pluginId, limit, offset)
    .all();
  return (rows.results ?? []).map((row) => ({
    userId: row.user_id,
    author: {
      name: row.display_name,
      avatarUrl: row.avatar_asset_id ? `/api/community/media/${row.avatar_asset_id}` : null,
    },
    rating: Number(row.rating),
    body: row.body,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function countReviews(env, pluginId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plugin_reviews WHERE plugin_id = ? AND status = 'visible'",
  )
    .bind(pluginId)
    .first();
  return Number(row?.n || 0);
}

/**
 * 市场列表。
 * sort=latest | downloads | rating | trending
 * trending 用「近 30 天去重下载」排序，没有事件的插件排后面，不生成随机数。
 */
export async function marketList(env, { category = "", q = "", sort = "latest", page = 1, limit = 12, userId = null }) {
  const where = ["p.status = 'published'"];
  const bind = [];
  if (category) {
    where.push("p.category = ?");
    bind.push(category);
  }
  if (q) {
    const like = `%${String(q).replace(/[%_]/g, (m) => `\\${m}`).slice(0, 40)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
    bind.push(like, like);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM plugins p WHERE ${whereSql}`)
    .bind(...bind)
    .first();
  const total = Number(totalRow?.n || 0);

  const order =
    sort === "downloads"
      ? "p.download_count DESC, p.published_at DESC"
      : sort === "rating"
        ? "(CASE WHEN p.rating_count > 0 THEN (p.rating_sum * 1.0 / p.rating_count) ELSE 0 END) DESC, p.rating_count DESC, p.published_at DESC"
        : "p.published_at DESC, p.updated_at DESC";

  // trending 需要「近 30 天去重下载」，SQLite 里无法按未 SELECT 的聚合列排序。
  // 插件总量很小（个人 OS 的量级），先取候选集再在内存里排序并分页，
  // 比给每一行挂相关子查询更可控，也不会出现随机数冒充热度。
  const trending = sort === "trending";
  const offset = (page - 1) * limit;

  const rows = await env.DB.prepare(
    `${PLUGIN_SELECT}
     WHERE ${whereSql}
     ORDER BY ${trending ? "p.download_count DESC, p.published_at DESC" : order}
     LIMIT ? OFFSET ?`,
  )
    .bind(...bind, trending ? 200 : limit, trending ? 0 : offset)
    .all();

  let items = rows.results ?? [];
  if (!items.length) return { items: [], total };

  // 近 30 天去重下载数：单独一次聚合查询，避免为每行写相关子查询。
  const since = Date.now() - 30 * 86_400_000;
  const ids = items.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const trendRows = await env.DB.prepare(
    `SELECT plugin_id, COUNT(*) AS n FROM plugin_download_events
      WHERE created_at >= ? AND plugin_id IN (${placeholders}) GROUP BY plugin_id`,
  )
    .bind(since, ...ids)
    .all();
  const trend = new Map((trendRows.results ?? []).map((row) => [row.plugin_id, Number(row.n)]));

  if (trending) {
    items = items
      .map((row) => ({ ...row, recent_downloads: trend.get(row.id) ?? 0 }))
      .sort((a, b) => {
        if (b.recent_downloads !== a.recent_downloads) return b.recent_downloads - a.recent_downloads;
        if (b.download_count !== a.download_count) return b.download_count - a.download_count;
        return Number(b.published_at || 0) - Number(a.published_at || 0);
      })
      .slice(offset, offset + limit);
    if (!items.length) return { items: [], total };
  }

  const pageIds = items.map((row) => row.id);
  const pagePlaceholders = pageIds.map(() => "?").join(",");

  const installMap = new Map();
  if (userId) {
    const installs = await env.DB.prepare(
      `SELECT plugin_id, version, enabled FROM plugin_installations
        WHERE user_id = ? AND plugin_id IN (${pagePlaceholders})`,
    )
      .bind(userId, ...pageIds)
      .all();
    for (const row of installs.results ?? []) installMap.set(row.plugin_id, row);
  }

  const versionMap = new Map();
  for (const row of items) {
    const version = await latestApprovedVersion(env, row.id);
    if (version) versionMap.set(row.id, version);
  }

  return {
    items: items.map((row) =>
      mapPluginCard(
        { ...row, recent_downloads: trend.get(row.id) ?? 0 },
        { version: versionMap.get(row.id) ?? null, install: installMap.get(row.id) ?? null },
      ),
    ),
    total,
  };
}

export async function featuredPlugins(env, userId, limit = 4) {
  const rows = await env.DB.prepare(
    `${PLUGIN_SELECT} WHERE p.status = 'published' AND p.featured_at IS NOT NULL
      ORDER BY p.featured_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  const out = [];
  for (const row of rows.results ?? []) {
    const version = await latestApprovedVersion(env, row.id);
    const install = userId ? await installFor(env, userId, row.id) : null;
    out.push(mapPluginCard(row, { version, install }));
  }
  return out;
}

/** 已安装用户的插件 id，用于依赖检查。 */
export async function installedPluginIds(env, userId) {
  const rows = await env.DB.prepare("SELECT plugin_id FROM plugin_installations WHERE user_id = ?")
    .bind(userId)
    .all();
  return new Set((rows.results ?? []).map((row) => row.plugin_id));
}

export async function pluginStats(env) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM plugins WHERE status = 'published') AS published,
       (SELECT COUNT(*) FROM plugins WHERE status = 'pending_review') AS pending,
       (SELECT COUNT(*) FROM plugin_installations) AS installations,
       (SELECT COUNT(*) FROM plugin_download_events) AS downloads`,
  ).first();
  return {
    published: Number(row?.published || 0),
    pending: Number(row?.pending || 0),
    installations: Number(row?.installations || 0),
    downloads: Number(row?.downloads || 0),
  };
}

export async function listDeveloperPlugins(env, userId) {
  const rows = await env.DB.prepare(
    `${PLUGIN_SELECT} WHERE p.developer_id = ? AND p.status != 'deleted' ORDER BY p.updated_at DESC`,
  )
    .bind(userId)
    .all();
  const items = [];
  for (const row of rows.results ?? []) {
    const version = await latestApprovedVersion(env, row.id);
    const latest = await env.DB.prepare(
      "SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(row.id)
      .first();
    items.push({
      ...mapPluginCard(row, { version }),
      latestVersion: latest ? mapVersion(latest) : null,
      moderationNote: row.moderation_note ?? "",
      status: row.status,
    });
  }
  return items;
}

export function publicAuthor(row) {
  return mapAuthor(row);
}
