/**
 * Guandao OS 1.7 · 插件接口（/api/plugins/*）
 *
 * 路由顺序原则：固定段（meta / installed / admin / net）先于 :id 匹配，
 * 否则 /api/plugins/installed 会被当成插件 id。
 *
 * 安全边界：
 *   - 所有写接口要求同源 + Session；
 *   - 安装前必须已经拿到并校验过插件包摘要（packageHash 与版本记录一致）；
 *   - 权限只能是 Manifest 声明过的子集，撤销立即生效；
 *   - 下载计数去重（同一用户/版本/天只记一次）。
 */

import { ApiError, ok } from "../http.js";
import { sha256Hex, randomToken } from "../auth/crypto.js";
import {
  assertSameOrigin,
  audit,
  readJson,
  requireStaff,
  requireAdmin,
  requireSession,
  sessionOrNull,
  viewerContext,
} from "./common.js";
import {
  resolveSignature,
  signatureOfVersionRow,
  touchKeyUsage,
  getKeyRow,
  listPublicKeysForPublisher,
} from "./signature.js";
import {
  PLUGIN_LIMITS,
  PERMISSION_BY_ID,
  PLUGIN_CATEGORIES,
  PERMISSION_MODULE_LABELS,
  OS_VERSION,
  SDK_VERSION,
  compareSemver,
  isSemver,
  PERMISSIONS,
  PLUGIN_TYPE_META,
  CATEGORY_LABELS,
  groupPermissions,
  riskOf,
} from "./spec.js";
import {
  PLUGIN_SELECT,
  allVersions,
  approvedVersions,
  countReviews,
  featuredPlugins,
  getAnyPluginRaw,
  getPluginRow,
  getVersionRow,
  iconUrlFor,
  installFor,
  installationsForUser,
  installedPluginIds,
  latestApprovedVersion,
  listReviews,
  mapInstallation,
  mapPluginCard,
  mapSignatureTrust,
  mapVersion,
  marketList,
  permissionsFor,
  pluginStats,
  ratingDistribution,
  recomputePluginCounters,
  safeParse,
  setPermissions,
} from "./store.js";

const PREFIX = "/api/plugins";
const MAX_INSTALLED = 40;
const DAY_MS = 86_400_000;

export async function handlePluginsRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  if (!env?.DB) throw new ApiError("SERVICE_UNAVAILABLE", "插件数据库尚未配置", 503);

  const method = request.method;
  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const parts = rest ? rest.split("/") : [];
  const session = await sessionOrNull(env, request);
  const viewer = await viewerContext(env, session);

  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request, env);

  /* ------------------------------ 元信息 ------------------------------ */
  if (parts.length === 1 && parts[0] === "meta" && method === "GET") {
    const stats = await pluginStats(env);
    return ok({
      osVersion: OS_VERSION,
      sdkVersion: SDK_VERSION,
      categories: PLUGIN_CATEGORIES,
      categoryLabels: CATEGORY_LABELS,
      types: PLUGIN_TYPE_META,
      permissions: PERMISSIONS,
      permissionModules: PERMISSION_MODULE_LABELS,
      limits: PLUGIN_LIMITS,
      stats,
      viewer,
    });
  }

  /* ------------------------------ 我的安装 ------------------------------ */
  if (parts.length === 1 && parts[0] === "installed" && method === "GET") {
    if (!session) return ok({ items: [], viewer });
    const rows = await installationsForUser(env, session.user.id);
    const items = [];
    for (const row of rows) {
      const install = await installFor(env, session.user.id, row.id);
      const version = await latestApprovedVersion(env, row.id);
      items.push({
        ...mapPluginCard(row, { version, install }),
        installation: mapInstallation(install),
        granted: await permissionsFor(env, session.user.id, row.id),
      });
    }
    return ok({ items, viewer });
  }

  /* ------------------------------ 管理员 ------------------------------ */
  if (parts[0] === "admin") {
    return handleAdmin({ request, env, parts, method, session, viewer });
  }

  /* ------------------------------ 网络代理 ------------------------------ */
  if (parts.length === 1 && parts[0] === "net" && method === "POST") {
    return handleNetworkProxy({ request, env, session });
  }

  /* ------------------------------ 列表 ------------------------------ */
  if (parts.length === 0 && method === "GET") {
    const tab = String(url.searchParams.get("tab") || "latest").slice(0, 20);
    const category = String(url.searchParams.get("category") || "").slice(0, 24);
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 40);
    const page = Math.max(1, Math.min(500, Number(url.searchParams.get("page")) || 1));
    const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit")) || 12));
    const sort = String(url.searchParams.get("sort") || "").slice(0, 16);

    if (tab === "featured") {
      const items = await featuredPlugins(env, viewer.id, 6);
      return ok({ items, total: items.length, page: 1, limit: 6, hasMore: false, tab });
    }
    if (category && !PLUGIN_CATEGORIES.includes(category)) {
      throw new ApiError("INVALID_CATEGORY", "分类不存在", 400);
    }

    const sortMode = sort || (tab === "trending" ? "trending" : tab === "downloads" ? "downloads" : tab === "rating" ? "rating" : "latest");
    const result = await marketList(env, { category, q, sort: sortMode, page, limit, userId: viewer.id });
    return ok({
      ...result,
      page,
      limit,
      hasMore: page * limit < result.total,
      tab,
      sort: sortMode,
    });
  }

  /* ---------------------------- 单个插件 ---------------------------- */
  const id = decodeURIComponent(parts[0] || "");
  if (!id) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (parts.length === 1 && method === "GET") return pluginDetail({ env, session, viewer, id });
  if (parts.length === 2 && parts[1] === "versions" && method === "GET") {
    return pluginVersions({ env, viewer, id });
  }
  if (parts.length === 2 && parts[1] === "icon" && method === "GET") {
    return pluginIcon({ env, viewer, id });
  }
  if (parts.length === 2 && parts[1] === "file" && method === "GET") {
    return pluginFile({ env, viewer, url, id });
  }
  if (parts.length === 2 && parts[1] === "package" && method === "GET") {
    return pluginPackage({ env, session, viewer, url, id });
  }
  if (parts.length === 2 && parts[1] === "reviews" && method === "GET") {
    return pluginReviews({ env, session, url, id });
  }
  if (parts.length === 2 && parts[1] === "reviews" && method === "POST") {
    return writeReview({ request, env, session, id });
  }
  if (parts.length === 3 && parts[1] === "reviews" && parts[2] === "mine" && method === "DELETE") {
    return deleteReview({ env, session, id });
  }
  if (parts.length === 2 && parts[1] === "report" && method === "POST") {
    return reportPlugin({ request, env, session, id });
  }
  if (parts.length === 2 && parts[1] === "security" && method === "POST") {
    return reportSecurityEvent({ request, env, session, id });
  }

  /* ---------------------------- 安装与状态 ---------------------------- */
  if (parts.length === 2 && parts[1] === "permissions" && method === "GET") {
    return readPermissions({ env, session, id });
  }
  if (parts.length === 2 && parts[1] === "permissions" && method === "POST") {
    return grantPermissions({ request, env, session, id });
  }
  if (parts.length === 3 && parts[1] === "permissions" && method === "DELETE") {
    return revokePermission({ env, session, id, permission: decodeURIComponent(parts[2]) });
  }
  if (parts.length === 2 && (parts[1] === "enable" || parts[1] === "disable") && method === "POST") {
    return setEnabledState({ env, session, id, enabled: parts[1] === "enable" });
  }
  if (parts.length === 2 && parts[1] === "update" && method === "POST") {
    return updateInstallation({ request, env, session, id });
  }
  if (parts.length === 2 && parts[1] === "rollback" && method === "POST") {
    return rollbackInstallation({ request, env, session, id });
  }
  if (parts.length === 2 && parts[1] === "launch" && method === "POST") {
    return markLaunched({ env, session, id });
  }
  if (parts.length === 2 && parts[1] === "install" && method === "DELETE") {
    return uninstallPlugin({ env, session, id });
  }
  if (parts.length === 1 && parts[0] === "install" && method === "POST") {
    return installPlugin({ request, env, session, id: "" });
  }

  throw new ApiError("NOT_FOUND", "接口不存在", 404);
}

/* ============================================================
   读取
   ============================================================ */

async function pluginDetail({ env, session, viewer, id }) {
  const row = await getPluginRow(env, id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);

  const isOwner = Boolean(viewer.id && row.developer_id === viewer.id);
  const canSeeUnpublished = isOwner || viewer.staff;
  if (row.status !== "published" && !canSeeUnpublished) {
    throw new ApiError("NOT_FOUND", "插件不存在", 404);
  }

  const version = (await latestApprovedVersion(env, id)) ?? (canSeeUnpublished ? await getVersionRow(env, id) : null);
  const install = viewer.id ? await installFor(env, viewer.id, id) : null;
  const granted = viewer.id ? await permissionsFor(env, viewer.id, id) : [];
  const manifest = safeParse(version?.manifest_json ?? row.latest_manifest_json, null);
  const versions = canSeeUnpublished ? await allVersions(env, id, 20) : await approvedVersions(env, id, 20);
  const distribution = await ratingDistribution(env, id);
  const reviewCount = await countReviews(env, id);
  const reviews = await listReviews(env, id, { limit: 6 });

  const developer = await env.DB.prepare(
    `SELECT dp.*, cp.avatar_asset_id AS avatar_asset_id, u.github_username AS username
       FROM developer_profiles dp
       LEFT JOIN community_profiles cp ON cp.user_id = dp.user_id
       LEFT JOIN users u ON u.id = dp.user_id
      WHERE dp.user_id = ?`,
  )
    .bind(row.developer_id)
    .first();

  const screenshotUrls = (manifest?.screenshots ?? []).map((path) => ({
    path,
    url: `/api/plugins/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version?.version ?? "")}`,
  }));

  return ok({
    plugin: {
      ...mapPluginCard(row, { version, install }),
      manifest,
      screenshots: screenshotUrls,
      changelog: version?.changelog ?? "",
      homepage: manifest?.homepage ?? "",
      repository: manifest?.repository ?? "",
      manifestVersion: manifest?.manifestVersion ?? 1,
      dependencies: manifest?.dependencies ?? [],
      contributes: manifest?.contributes ?? {},
      isOwner,
    },
    versions: versions.map((v) => mapVersion(v, { includePackage: false })),
    reviews,
    reviewCount,
    distribution,
    installation: mapInstallation(install),
    granted,
    permissionGroups: groupPermissions(manifest?.permissions ?? []),
    risk: riskOf(manifest?.permissions ?? []),
    developer: developer
      ? {
          id: row.developer_id,
          name: developer.display_name,
          bio: developer.bio,
          website: developer.website,
          avatarUrl: developer.avatar_asset_id ? `/api/community/media/${developer.avatar_asset_id}` : null,
          joinedAt: Number(developer.created_at),
        }
      : { id: row.developer_id, name: "开发者", bio: "", website: "", avatarUrl: null, joinedAt: 0 },
    viewer,
  });
}

async function pluginVersions({ env, viewer, id }) {
  const row = await getPluginRow(env, id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  const isOwner = Boolean(viewer.id && row.developer_id === viewer.id);
  if (row.status !== "published" && !isOwner && !viewer.staff) {
    throw new ApiError("NOT_FOUND", "插件不存在", 404);
  }
  const versions = isOwner || viewer.staff ? await allVersions(env, id, 50) : await approvedVersions(env, id, 50);
  return ok({ versions: versions.map((v) => mapVersion(v)) });
}

async function pluginIcon({ env, viewer, id }) {
  const row = await getAnyPluginRaw(env, id);
  if (!row || row.status === "deleted" || !row.icon_key) throw new ApiError("NOT_FOUND", "图标不存在", 404);
  if (row.status !== "published" && row.developer_id !== viewer.id && !viewer.staff) {
    throw new ApiError("NOT_FOUND", "图标不存在", 404);
  }
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置", 503);
  const object = await env.FILES.get(row.icon_key);
  if (!object) throw new ApiError("NOT_FOUND", "图标不存在", 404);
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": row.icon_mime || object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function pluginFile({ env, viewer, url, id }) {
  const row = await getPluginRow(env, id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  const isOwner = Boolean(viewer.id && row.developer_id === viewer.id);
  if (row.status !== "published" && !isOwner && !viewer.staff) {
    throw new ApiError("NOT_FOUND", "插件不存在", 404);
  }
  const path = String(url.searchParams.get("path") || "");
  if (!path || path.length > 120 || path.includes("..") || path.startsWith("/")) {
    throw new ApiError("INVALID_PATH", "文件路径不合法", 400);
  }
  const version = await latestApprovedVersion(env, id);
  if (!version) throw new ApiError("NOT_FOUND", "插件文件不存在", 404);
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置", 503);
  const object = await env.FILES.get(version.package_key);
  if (!object) throw new ApiError("NOT_FOUND", "插件文件不存在", 404);
  const bundle = safeParse(await object.text(), null);
  const file = (bundle?.files ?? []).find((item) => String(item.path).toLowerCase() === path.toLowerCase());
  if (!file) throw new ApiError("NOT_FOUND", "文件不存在", 404);
  if (file.encoding === "base64") {
    const binary = atob(String(file.content).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": mimeFromPath(path),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }
  return new Response(String(file.content), {
    status: 200,
    headers: {
      "content-type": mimeFromPath(path),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function mimeFromPath(path) {
  const ext = String(path).split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      woff2: "font/woff2",
      woff: "font/woff",
      md: "text/markdown; charset=utf-8",
    }[ext] ?? "application/octet-stream"
  );
}

/**
 * 插件包下载。
 * 必须登录：安装动作和账号绑定，下载量也按账号去重。
 * 作者 / 审核员可以带 preview=1 下载未审核版本，用于自测。
 */
async function pluginPackage({ env, session, viewer, url, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const row = await getPluginRow(env, id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置", 503);

  const requested = String(url.searchParams.get("version") || "").slice(0, 32) || null;
  const preview = url.searchParams.get("preview") === "1";
  const isOwner = row.developer_id === session.user.id;
  let version;
  if (preview) {
    if (!isOwner && !viewer.staff) throw new ApiError("FORBIDDEN", "只有作者可以预览未发布版本", 403);
    version = await getVersionRow(env, id, requested);
    if (!version) throw new ApiError("PACKAGE_NOT_FOUND", "插件包不存在", 404);
  } else {
    if (row.status !== "published") throw new ApiError("NOT_PUBLISHED", "插件尚未发布", 409);
    version = requested
      ? await env.DB.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND status = 'approved'")
          .bind(id, requested)
          .first()
      : await latestApprovedVersion(env, id);
    if (!version) throw new ApiError("PACKAGE_NOT_FOUND", "该版本不可安装", 404);
  }

  const object = await env.FILES.get(version.package_key);
  if (!object) throw new ApiError("PACKAGE_MISSING", "插件包文件缺失，请联系开发者", 404);
  const text = await object.text();
  const digest = await sha256Hex(text);
  if (digest !== version.package_sha256) {
    throw new ApiError("PACKAGE_INTEGRITY_ERROR", "插件包校验失败，已阻止安装", 409);
  }

  // 发布者签名：下载出口再验一次，保证密钥撤销后立刻生效。
  // 签名缺失（unsigned）在阶段 A 仍允许下载，但必须如实告知客户端。
  const bundle = safeParse(text, null);
  const verification = await resolveSignature(env, {
    bundle,
    signature: signatureOfVersionRow(version) ?? bundle?.signature ?? null,
    plugin: { id: row.id, developer_id: row.developer_id },
    version: version.version,
  });
  if (verification.status === "invalid") {
    throw new ApiError("SIGNATURE_INVALID", `插件签名校验失败：${verification.message}`, 409, {
      signatureCode: verification.code || "SIG_VERIFY_FAILED",
      issues: (verification.errors ?? []).map((item) => item.code).slice(0, 8),
    });
  }
  if (verification.status === "verified" && verification.keyId) {
    await touchKeyUsage(env, verification.keyId);
  }

  if (!preview && row.status === "published") {
    const day = new Date().toISOString().slice(0, 10);
    try {
      // 只有真的插入了下载事件才加计数：同一用户/版本/天重复下载不刷量。
      const inserted = await env.DB.prepare(
        `INSERT INTO plugin_download_events (id, plugin_id, user_id, version, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id, user_id, version, day) DO NOTHING`,
      )
        .bind(`pde-${randomToken(10)}`, id, session.user.id, version.version, day, Date.now())
        .run();
      if (inserted.meta?.changes) {
        await env.DB.prepare("UPDATE plugins SET download_count = download_count + 1 WHERE id = ?").bind(id).run();
      }
    } catch {
      // 下载事件写失败不回滚下载：安装仍应继续，计数下次会重算。
    }
  }

  return ok({
    pluginId: id,
    version: version.version,
    checksum: version.package_sha256,
    sizeBytes: Number(version.size_bytes),
    manifest: safeParse(version.manifest_json, null),
    packageJson: text,
    signature: {
      status: verification.status,
      keyId: verification.keyId ?? null,
      signedAt: verification.signedAt ?? null,
      payload: verification.envelope ?? null,
    },
    publisherKeys: await listPublicKeysForPublisher(env, row.developer_id),
  });
}

/* ============================================================
   安装 / 状态
   ============================================================ */

async function installPlugin(context) {
  const { request, env, session } = context;
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account 再安装插件", 401);
  const body = await readJson(request, 64 * 1024);

  const pluginId = String(body.pluginId || context.id || "").trim();
  const versionText = String(body.version || "").trim();
  const packageHash = String(body.packageHash || "").trim().toLowerCase();
  const granted = Array.isArray(body.permissions) ? body.permissions.map(String) : [];

  const row = await getPluginRow(env, pluginId);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (row.status === "blocked") throw new ApiError("PLUGIN_BLOCKED", "该插件已被安全下架，不能安装", 409);
  if (row.status !== "published") throw new ApiError("NOT_PUBLISHED", "插件尚未发布", 409);
  if (!isSemver(versionText)) throw new ApiError("INVALID_VERSION", "版本号不合法", 400);

  const version = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND status = 'approved'",
  )
    .bind(pluginId, versionText)
    .first();
  if (!version) throw new ApiError("VERSION_NOT_AVAILABLE", "该版本不可安装", 409);
  if (!/^[a-f0-9]{64}$/.test(packageHash)) {
    throw new ApiError("PACKAGE_HASH_REQUIRED", "缺少插件包校验值，请重新下载", 400);
  }
  if (packageHash !== version.package_sha256) {
    throw new ApiError("PACKAGE_INTEGRITY_ERROR", "插件包校验值与服务端记录不一致，已阻止安装", 409);
  }

  // 签名门禁：invalid 直接拒绝；已撤销/不可信密钥签出的版本也必须拒绝，
  // 否则撤回密钥后旧包仍可被安装，「撤销」就只是装饰。
  if (version.signature_status === "invalid") {
    throw new ApiError("SIGNATURE_INVALID", "该版本的发布者签名无效，已阻止安装", 409, {
      signatureCode: "SIG_INVALID",
    });
  }
  if (version.signature_key_id) {
    const key = await getKeyRow(env, version.signature_key_id);
    if (!key || key.user_id !== row.developer_id) {
      throw new ApiError("SIGNATURE_KEY_UNKNOWN", "该版本的签名密钥不可信，已阻止安装", 409, {
        signatureCode: "SIG_KEY_UNKNOWN",
      });
    }
    if (key.status !== "active") {
      throw new ApiError("SIGNATURE_KEY_REVOKED", "该版本的签名密钥已撤销，请升级到新版本", 409, {
        signatureCode: "SIG_KEY_REVOKED",
      });
    }
  }

  const manifest = safeParse(version.manifest_json, null);
  if (!manifest) throw new ApiError("INVALID_MANIFEST", "插件清单损坏，不能安装", 409);

  const declared = new Set(manifest.permissions ?? []);
  for (const permission of granted) {
    if (!PERMISSION_BY_ID[permission] || !declared.has(permission)) {
      throw new ApiError("PERMISSION_NOT_DECLARED", `权限未在清单中声明：${permission}`, 400);
    }
  }

  const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_installations WHERE user_id = ?")
    .bind(session.user.id)
    .first();
  const existing = await installFor(env, session.user.id, pluginId);
  if (!existing && Number(installs?.n || 0) >= MAX_INSTALLED) {
    throw new ApiError("INSTALL_LIMIT", `最多同时安装 ${MAX_INSTALLED} 个插件`, 409);
  }

  const installedIds = await installedPluginIds(env, session.user.id);
  const missing = (manifest.dependencies ?? [])
    .filter((dep) => !dep.optional && !installedIds.has(dep.id))
    .map((dep) => dep.id);
  if (missing.length) {
    throw new ApiError("DEPENDENCY_MISSING", `缺少依赖插件：${missing.join("、")}`, 409);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO plugin_installations
       (id, user_id, plugin_id, version, enabled, status, package_sha256, source, installed_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'installed', ?, 'market', ?, ?)
     ON CONFLICT (user_id, plugin_id) DO UPDATE SET
       version = excluded.version,
       enabled = 1,
       status = 'installed',
       package_sha256 = excluded.package_sha256,
       installed_at = excluded.installed_at,
       updated_at = excluded.updated_at`,
  )
    .bind(`pins-${randomToken(10)}`, session.user.id, pluginId, versionText, packageHash, now, now)
    .run();

  const effective = await setPermissions(env, session.user.id, pluginId, granted, "install");
  await recomputePluginCounters(env, pluginId);
  await audit(env, {
    actorId: session.user.id,
    action: existing ? "plugin.reinstall" : "plugin.install",
    pluginId,
    detail: {
      version: versionText,
      permissions: effective,
      signatureStatus: version.signature_status || "unsigned",
      signatureKeyId: version.signature_key_id || null,
    },
  });

  return ok({
    installation: mapInstallation(await installFor(env, session.user.id, pluginId)),
    permissions: effective,
    manifest,
    signature: mapSignatureTrust(version),
  });
}

async function setEnabledState({ env, session, id, enabled }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "这个插件还没有安装", 404);
  const row = await getAnyPluginRaw(env, id);
  if (row?.status === "blocked") throw new ApiError("PLUGIN_BLOCKED", "插件已被安全下架，不能启用", 409);

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE plugin_installations SET enabled = ?, status = ?, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
  )
    .bind(enabled ? 1 : 0, enabled ? "installed" : "disabled", now, session.user.id, id)
    .run();
  await audit(env, {
    actorId: session.user.id,
    action: enabled ? "plugin.enable" : "plugin.disable",
    pluginId: id,
    detail: { version: install.version },
  });
  return ok({ installation: mapInstallation(await installFor(env, session.user.id, id)) });
}

async function updateInstallation({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 64 * 1024);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);

  const versionText = String(body.version || "").trim();
  if (!isSemver(versionText)) throw new ApiError("INVALID_VERSION", "版本号不合法", 400);
  if (compareSemver(versionText, install.version) <= 0) {
    throw new ApiError("NOT_AN_UPGRADE", "新版本必须高于当前安装的版本", 409);
  }
  const row = await getPluginRow(env, id);
  if (!row || row.status !== "published") throw new ApiError("NOT_PUBLISHED", "插件当前不可更新", 409);
  const version = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND status = 'approved'",
  )
    .bind(id, versionText)
    .first();
  if (!version) throw new ApiError("VERSION_NOT_AVAILABLE", "该版本不可安装", 409);

  const packageHash = String(body.packageHash || "").trim().toLowerCase();
  if (packageHash !== version.package_sha256) {
    throw new ApiError("PACKAGE_INTEGRITY_ERROR", "插件包校验值与服务端记录不一致", 409);
  }

  const manifest = safeParse(version.manifest_json, null);
  const current = await env.DB.prepare("SELECT manifest_json FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(id, install.version)
    .first();
  const previousManifest = safeParse(current?.manifest_json, null);
  const declared = new Set(manifest?.permissions ?? []);
  const before = new Set(previousManifest?.permissions ?? []);
  const added = [...declared].filter((permission) => !before.has(permission));

  const granted = Array.isArray(body.permissions) ? body.permissions.map(String) : null;
  if (added.length) {
    if (!granted) {
      return ok({ needsConsent: true, added, manifest, version: versionText });
    }
    const missing = added.filter((permission) => !granted.includes(permission));
    if (missing.length) {
      throw new ApiError("PERMISSION_CONSENT_REQUIRED", `新版本申请了新权限：${missing.join("、")}`, 409);
    }
  }
  const effective = granted ?? (await permissionsFor(env, session.user.id, id));
  for (const permission of effective) {
    if (!declared.has(permission)) {
      throw new ApiError("PERMISSION_NOT_DECLARED", `权限未在清单中声明：${permission}`, 400);
    }
  }

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE plugin_installations SET version = ?, package_sha256 = ?, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
  )
    .bind(versionText, packageHash, now, session.user.id, id)
    .run();
  await setPermissions(env, session.user.id, id, effective, "update");
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.update",
    pluginId: id,
    detail: { from: install.version, to: versionText, added },
  });

  return ok({
    installation: mapInstallation(await installFor(env, session.user.id, id)),
    permissions: await permissionsFor(env, session.user.id, id),
    manifest,
    needsConsent: false,
  });
}

/**
 * 回退：只允许回到已经审核通过的历史版本。
 * 权限取交集，回退不会保留新版本才有的权限。
 */
async function rollbackInstallation({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 16 * 1024);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);
  const versionText = String(body.version || "").trim();
  if (!isSemver(versionText)) throw new ApiError("INVALID_VERSION", "版本号不合法", 400);
  if (compareSemver(versionText, install.version) >= 0) {
    throw new ApiError("NOT_A_ROLLBACK", "回退版本必须低于当前版本", 409);
  }
  const version = await env.DB.prepare(
    "SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ? AND status IN ('approved', 'superseded')",
  )
    .bind(id, versionText)
    .first();
  if (!version) throw new ApiError("VERSION_NOT_AVAILABLE", "这个历史版本不可用", 409);
  const packageHash = String(body.packageHash || "").trim().toLowerCase();
  if (packageHash !== version.package_sha256) {
    throw new ApiError("PACKAGE_INTEGRITY_ERROR", "插件包校验值与服务端记录不一致", 409);
  }
  const manifest = safeParse(version.manifest_json, null);
  const declared = new Set(manifest?.permissions ?? []);
  const keep = (await permissionsFor(env, session.user.id, id)).filter((permission) => declared.has(permission));
  await env.DB.prepare(
    "UPDATE plugin_installations SET version = ?, package_sha256 = ?, updated_at = ? WHERE user_id = ? AND plugin_id = ?",
  )
    .bind(versionText, packageHash, Date.now(), session.user.id, id)
    .run();
  const effective = await setPermissions(env, session.user.id, id, keep, "update");
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.rollback",
    pluginId: id,
    detail: { from: install.version, to: versionText },
  });
  return ok({
    installation: mapInstallation(await installFor(env, session.user.id, id)),
    permissions: effective,
  });
}

async function markLaunched({ env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);
  if (!install.enabled) throw new ApiError("PLUGIN_DISABLED", "插件已禁用", 409);
  await env.DB.prepare("UPDATE plugin_installations SET last_launched_at = ? WHERE user_id = ? AND plugin_id = ?")
    .bind(Date.now(), session.user.id, id)
    .run();
  return ok({ ok: true });
}

async function uninstallPlugin({ env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);

  await env.DB.prepare("DELETE FROM plugin_installations WHERE user_id = ? AND plugin_id = ?")
    .bind(session.user.id, id)
    .run();
  await env.DB.prepare("DELETE FROM plugin_permissions WHERE user_id = ? AND plugin_id = ?")
    .bind(session.user.id, id)
    .run();
  await recomputePluginCounters(env, id);
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.uninstall",
    pluginId: id,
    detail: { version: install.version },
  });
  return ok({ ok: true, pluginId: id, uninstalledVersion: install.version });
}

/* ============================================================
   权限
   ============================================================ */

async function readPermissions({ env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);
  const version = await env.DB.prepare("SELECT manifest_json FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(id, install.version)
    .first();
  const manifest = safeParse(version?.manifest_json, null);
  return ok({
    pluginId: id,
    declared: manifest?.permissions ?? [],
    granted: await permissionsFor(env, session.user.id, id),
    groups: groupPermissions(manifest?.permissions ?? []),
    networkDomains: manifest?.networkDomains ?? [],
  });
}

async function grantPermissions({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 16 * 1024);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);
  const version = await env.DB.prepare("SELECT manifest_json FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(id, install.version)
    .first();
  const declared = new Set(safeParse(version?.manifest_json, null)?.permissions ?? []);
  const list = Array.isArray(body.permissions) ? [...new Set(body.permissions.map(String))] : [];
  for (const permission of list) {
    if (!declared.has(permission)) {
      throw new ApiError("PERMISSION_NOT_DECLARED", `该插件没有声明权限：${permission}`, 400);
    }
  }
  const effective = await setPermissions(env, session.user.id, id, list, "manual");
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.permissions.grant",
    pluginId: id,
    detail: { permissions: effective },
  });
  return ok({ granted: effective });
}

async function revokePermission({ env, session, id, permission }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  if (!PERMISSION_BY_ID[permission]) throw new ApiError("UNKNOWN_PERMISSION", "未知权限", 400);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "插件尚未安装", 404);
  await env.DB.prepare("DELETE FROM plugin_permissions WHERE user_id = ? AND plugin_id = ? AND permission = ?")
    .bind(session.user.id, id, permission)
    .run();
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.permissions.revoke",
    pluginId: id,
    detail: { permission },
  });
  return ok({ granted: await permissionsFor(env, session.user.id, id) });
}

/* ============================================================
   评价 / 举报
   ============================================================ */

async function pluginReviews({ env, session, url, id }) {
  const row = await getPluginRow(env, id);
  if (!row || row.status !== "published") throw new ApiError("NOT_FOUND", "插件不存在", 404);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit")) || 8));
  const items = await listReviews(env, id, { limit, offset: (page - 1) * limit });
  const total = await countReviews(env, id);
  let mine = null;
  if (session) {
    const rowMine = await env.DB.prepare("SELECT * FROM plugin_reviews WHERE plugin_id = ? AND user_id = ?")
      .bind(id, session.user.id)
      .first();
    if (rowMine) mine = { rating: Number(rowMine.rating), body: rowMine.body, updatedAt: Number(rowMine.updated_at) };
  }
  return ok({
    items,
    total,
    page,
    limit,
    hasMore: page * limit < total,
    distribution: await ratingDistribution(env, id),
    mine,
  });
}

async function writeReview({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 8 * 1024);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ApiError("INVALID_RATING", "评分必须是 1–5 的整数", 400);
  }
  const text = String(body.body ?? "").trim().slice(0, 1200);
  const row = await getPluginRow(env, id);
  if (!row || row.status !== "published") throw new ApiError("NOT_FOUND", "插件不存在", 404);
  const install = await installFor(env, session.user.id, id);
  if (!install) throw new ApiError("NOT_INSTALLED", "只有安装过这个插件才能评价", 403);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO plugin_reviews (plugin_id, user_id, rating, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'visible', ?, ?)
     ON CONFLICT (plugin_id, user_id) DO UPDATE SET
       rating = excluded.rating, body = excluded.body, updated_at = excluded.updated_at`,
  )
    .bind(id, session.user.id, rating, text, now, now)
    .run();
  await recomputePluginCounters(env, id);
  return ok({ ok: true, rating, body: text });
}

async function deleteReview({ env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  await env.DB.prepare("DELETE FROM plugin_reviews WHERE plugin_id = ? AND user_id = ?")
    .bind(id, session.user.id)
    .run();
  await recomputePluginCounters(env, id);
  return ok({ ok: true });
}

/**
 * 运行时安全事件上报（2.0）。
 *
 * 与用户举报分开：这里由沙箱宿主在检测到「插件把 frame 导航出去」时调用。
 * 只记录到审核队列，不自动下架 —— 单条客户端上报不足以判定恶意，
 * 但管理员必须能看到「这个插件在真实用户机器上尝试逃逸过」。
 */
async function reportSecurityEvent({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 4 * 1024);
  if (String(body.event || "") !== "sandbox:navigation") {
    throw new ApiError("INVALID_EVENT", "未知的安全事件", 400);
  }
  const row = await getPluginRow(env, id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);

  // 同一插件同一小时只记一条，避免一个循环重试把审核队列刷满
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = await env.DB.prepare(
    `SELECT id FROM plugin_reports
      WHERE plugin_id = ? AND reason = 'malware' AND detail LIKE 'sandbox:%' AND created_at > ?
      LIMIT 1`,
  )
    .bind(id, hourAgo)
    .first();
  if (recent) return ok({ ok: true, recorded: false });

  const detail = `sandbox:navigation · ${String(body.detail ?? "").trim().slice(0, 400) || "插件尝试导航出沙箱"}`;
  await env.DB.prepare(
    `INSERT INTO plugin_reports (id, plugin_id, user_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, 'malware', ?, 'open', ?)`,
  )
    .bind(`prp-${randomToken(10)}`, id, session.user.id, detail, Date.now())
    .run();
  await env.DB.prepare("UPDATE plugins SET report_count = report_count + 1 WHERE id = ?").bind(id).run();
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.security_event",
    pluginId: id,
    detail: { event: "sandbox:navigation" },
  });
  return ok({ ok: true, recorded: true });
}

async function reportPlugin({ request, env, session, id }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 8 * 1024);
  const reason = String(body.reason || "");
  if (!["malware", "privacy", "misleading", "broken", "license", "other"].includes(reason)) {
    throw new ApiError("INVALID_REASON", "举报原因不合法", 400);
  }
  const detail = String(body.detail ?? "").trim().slice(0, 1200);
  const row = await getPluginRow(env, id);
  if (!row || row.status !== "published") throw new ApiError("NOT_FOUND", "插件不存在", 404);

  const recent = await env.DB.prepare(
    "SELECT id FROM plugin_reports WHERE plugin_id = ? AND user_id = ? AND created_at > ? AND status = 'open'",
  )
    .bind(id, session.user.id, Date.now() - DAY_MS)
    .first();
  if (recent) throw new ApiError("REPORT_DUPLICATED", "你已经举报过这个插件，管理员正在处理", 409);

  await env.DB.prepare(
    `INSERT INTO plugin_reports (id, plugin_id, user_id, reason, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(`prp-${randomToken(10)}`, id, session.user.id, reason, detail, Date.now())
    .run();
  await env.DB.prepare("UPDATE plugins SET report_count = report_count + 1 WHERE id = ?").bind(id).run();
  await audit(env, { actorId: session.user.id, action: "plugin.report", pluginId: id, detail: { reason } });
  return ok({ ok: true });
}

/* ============================================================
   管理员：审核 / 下架 / 举报 / 审计
   ============================================================ */

async function handleAdmin({ request, env, parts, method, session, viewer }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  // 路由形态：
  //   /api/plugins/admin/queue|audit|reports|users/...   → 固定段
  //   /api/plugins/admin/:pluginId/review|takedown|...   → 插件段
  const section = parts[1] || "";
  const adminAction = parts[2] || "";
  const action = section;

  if (method === "GET" && action === "queue") {
    await requireStaff(env, session);
    const status = String(parts[2] || "pending");
    // 队列看「版本」而不是「插件」：已发布插件提交的新版本同样需要审核。
    const rows = await env.DB.prepare(
      `SELECT v.*, p.developer_id AS developer_id
         FROM plugin_versions v
         JOIN plugins p ON p.id = v.plugin_id
        WHERE v.status = ? AND p.status != 'blocked'
        ORDER BY v.created_at ASC LIMIT 60`,
    )
      .bind(status)
      .all();
    const items = [];
    for (const version of rows.results ?? []) {
      const pluginRow = await getPluginRow(env, version.plugin_id);
      if (!pluginRow) continue;
      items.push({
        plugin: mapPluginCard(pluginRow, { version }),
        version: mapVersion(version),
        developer: {
          id: pluginRow.developer_id,
          name: pluginRow.author_display_name,
          avatarUrl: pluginRow.author_avatar_asset_id
            ? `/api/community/media/${pluginRow.author_avatar_asset_id}`
            : null,
        },
        moderationNote: pluginRow.moderation_note ?? "",
      });
    }
    return ok({ items, status });
  }

  if (method === "GET" && action === "audit") {
    await requireStaff(env, session);
    const pluginId = String(parts[2] || "") || null;
    const rows = await env.DB.prepare(
      `SELECT a.*, u.github_username AS actor_username
         FROM plugin_audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        ${pluginId ? "WHERE a.plugin_id = ?" : ""}
        ORDER BY a.created_at DESC LIMIT 80`,
    )
      .bind(...(pluginId ? [pluginId] : []))
      .all();
    return ok({
      items: (rows.results ?? []).map((row) => ({
        id: row.id,
        action: row.action,
        pluginId: row.plugin_id,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_username || "管理员" } : null,
        detail: safeParse(row.detail_json, {}),
        createdAt: Number(row.created_at),
      })),
    });
  }

  if (method === "GET" && action === "reports") {
    await requireStaff(env, session);
    const rows = await env.DB.prepare(
      `SELECT r.*, p.name AS plugin_name, u.github_username AS reporter
         FROM plugin_reports r
         LEFT JOIN plugins p ON p.id = r.plugin_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 60`,
    ).all();
    return ok({
      items: (rows.results ?? []).map((row) => ({
        id: row.id,
        pluginId: row.plugin_id,
        pluginName: row.plugin_name,
        reporter: row.reporter,
        reason: row.reason,
        detail: row.detail,
        createdAt: Number(row.created_at),
      })),
    });
  }

  if (method === "POST" && action === "reports" && parts[2]) {
    await requireStaff(env, session);
    const body = await readJson(request, 8 * 1024);
    const resolution = body.status === "dismissed" ? "dismissed" : "resolved";
    // 路由是 /api/admin/reports/:id → parts[2] 才是报告 ID（旧代码绑成了 parts[3]，
    // 结果是 undefined，D1 会报类型错误或者更新 0 行，而界面仍显示成功）。
    await env.DB.prepare(
      "UPDATE plugin_reports SET status = ?, resolution_note = ?, resolved_at = ?, resolved_by = ? WHERE id = ?",
    )
      .bind(resolution, String(body.note ?? "").slice(0, 600), Date.now(), session.user.id, parts[2])
      .run();
    await audit(env, {
      actorId: session.user.id,
      action: "plugin.report.resolve",
      detail: { reportId: parts[2], status: resolution },
    });
    return ok({ ok: true });
  }

  /* 开发者限制：复用社区资料上的 restriction，不另建黑名单 */
  if (method === "POST" && action === "users" && parts[2] && parts[3] === "restriction") {
    await requireAdmin(env, session);
    const body = await readJson(request, 8 * 1024);
    const restriction = ["none", "limited", "blocked"].includes(String(body.restriction))
      ? String(body.restriction)
      : "blocked";
    const reason = String(body.reason ?? "").trim().slice(0, 300);
    const profile = await env.DB.prepare("SELECT user_id FROM community_profiles WHERE user_id = ?")
      .bind(parts[2])
      .first();
    if (!profile) {
      throw new ApiError("NO_PROFILE", "该账号还没有社区资料，请先在社区审核中心处理", 409);
    }
    await env.DB.prepare(
      "UPDATE community_profiles SET restriction = ?, restriction_reason = ?, updated_at = ? WHERE user_id = ?",
    )
      .bind(restriction, reason || null, Date.now(), parts[2])
      .run();
    await audit(env, {
      actorId: session.user.id,
      action: "plugin.developer.restrict",
      targetUserId: parts[2],
      detail: { restriction, reason },
    });
    return ok({ ok: true, restriction });
  }

  const pluginId = section ? decodeURIComponent(section) : "";
  if (!pluginId) throw new ApiError("NOT_FOUND", "接口不存在", 404);
  const row = await getPluginRow(env, pluginId);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);

  if (method === "POST" && adminAction === "review") {
    await requireStaff(env, session);
    const body = await readJson(request, 8 * 1024);
    const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : "";
    if (!decision) throw new ApiError("INVALID_DECISION", "审核结论必须是 approve 或 reject", 400);
    const note = String(body.note ?? "").trim().slice(0, 600);
    if (decision === "reject" && !note) throw new ApiError("NOTE_REQUIRED", "拒绝时必须写明原因", 400);

    const requestedVersion = String(body.version || "").trim();
    const version = requestedVersion
      ? await env.DB.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?")
          .bind(pluginId, requestedVersion)
          .first()
      : await env.DB.prepare(
          "SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1",
        )
          .bind(pluginId)
          .first();
    if (!version) throw new ApiError("NO_VERSION", "这个插件还没有上传版本", 409);
    if (version.status === "approved") throw new ApiError("ALREADY_APPROVED", "该版本已经通过审核", 409);

    const now = Date.now();
    if (decision === "approve") {
      if (row.developer_id === session.user.id) {
        throw new ApiError("SELF_REVIEW", "不能审核自己发布的插件", 403);
      }
      const previous = await latestApprovedVersion(env, pluginId);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE plugin_versions SET status = 'superseded' WHERE plugin_id = ? AND status = 'approved'",
        ).bind(pluginId),
        env.DB.prepare(
          "UPDATE plugin_versions SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?, published_at = ? WHERE id = ?",
        ).bind(note || null, session.user.id, now, now, version.id),
        env.DB.prepare(
          `UPDATE plugins SET status = 'published', latest_version = ?, latest_manifest_json = ?,
             permissions_json = ?, compatibility_json = ?, moderation_note = NULL,
             published_at = COALESCE(published_at, ?), updated_at = ?
           WHERE id = ?`,
        ).bind(
          version.version,
          version.manifest_json,
          JSON.stringify(safeParse(version.manifest_json, {}).permissions ?? []),
          JSON.stringify(safeParse(version.manifest_json, {}).compatibility ?? {}),
          now,
          now,
          pluginId,
        ),
      ]);
      await audit(env, {
        actorId: session.user.id,
        action: "plugin.review.approve",
        pluginId,
        detail: { version: version.version, previous: previous?.version ?? null },
      });
      return ok({ ok: true, status: "published", version: version.version });
    }

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE plugin_versions SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
      ).bind(note, session.user.id, now, version.id),
      env.DB.prepare("UPDATE plugins SET status = 'rejected', moderation_note = ?, updated_at = ? WHERE id = ?")
        .bind(note, now, pluginId),
    ]);
    await audit(env, {
      actorId: session.user.id,
      action: "plugin.review.reject",
      pluginId,
      detail: { version: version.version, note },
    });
    return ok({ ok: true, status: "rejected" });
  }

  if (method === "POST" && adminAction === "takedown") {
    await requireStaff(env, session);
    if (!viewer.admin) throw new ApiError("FORBIDDEN", "紧急下架需要管理员权限", 403);
    const body = await readJson(request, 8 * 1024);
    const reason = String(body.reason ?? "").trim().slice(0, 600);
    if (!reason) throw new ApiError("REASON_REQUIRED", "下架必须写明原因", 400);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE plugins SET status = 'blocked', moderation_note = ?, updated_at = ? WHERE id = ?")
        .bind(reason, now, pluginId),
      env.DB.prepare("UPDATE plugin_installations SET enabled = 0, status = 'blocked', updated_at = ? WHERE plugin_id = ?")
        .bind(now, pluginId),
    ]);
    await audit(env, {
      actorId: session.user.id,
      action: "plugin.takedown",
      pluginId,
      detail: { reason },
    });
    return ok({ ok: true, status: "blocked" });
  }

  if (method === "POST" && adminAction === "restore") {
    await requireAdmin(env, session);
    await env.DB.prepare("UPDATE plugins SET status = 'published', moderation_note = NULL, updated_at = ? WHERE id = ?")
      .bind(Date.now(), pluginId)
      .run();
    await audit(env, { actorId: session.user.id, action: "plugin.restore", pluginId });
    return ok({ ok: true, status: "published" });
  }

  if (method === "POST" && adminAction === "feature") {
    await requireAdmin(env, session);
    const body = await readJson(request, 4 * 1024);
    const featured = body.featured !== false;
    await env.DB.prepare("UPDATE plugins SET featured_at = ?, featured_by = ?, updated_at = ? WHERE id = ?")
      .bind(featured ? Date.now() : null, featured ? session.user.id : null, Date.now(), pluginId)
      .run();
    await audit(env, {
      actorId: session.user.id,
      action: featured ? "plugin.feature" : "plugin.unfeature",
      pluginId,
    });
    return ok({ ok: true, featured });
  }

  throw new ApiError("NOT_FOUND", "接口不存在", 404);
}

/* ============================================================
   网络代理
   ============================================================ */

const NET_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const NET_HEADER_ALLOW = new Set(["accept", "content-type", "authorization", "x-api-key"]);

async function handleNetworkProxy({ request, env, session }) {
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
  const body = await readJson(request, 32 * 1024);
  const pluginId = String(body.pluginId || "");
  const rawUrl = String(body.url || "");
  const method = String(body.method || "GET").toUpperCase();

  const install = await installFor(env, session.user.id, pluginId);
  if (!install || !install.enabled) throw new ApiError("NOT_INSTALLED", "插件未安装或已禁用", 403);
  const row = await getPluginRow(env, pluginId);
  if (!row || row.status !== "published") throw new ApiError("PLUGIN_BLOCKED", "插件不可用", 403);

  const version = await env.DB.prepare("SELECT manifest_json FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(pluginId, install.version)
    .first();
  const manifest = safeParse(version?.manifest_json, null);
  const granted = await permissionsFor(env, session.user.id, pluginId);
  if (!granted.includes("network.fetch")) {
    throw new ApiError("PERMISSION_DENIED", "插件没有 network.fetch 授权", 403);
  }
  if (!manifest?.permissions?.includes("network.fetch")) {
    throw new ApiError("PERMISSION_NOT_DECLARED", "清单中没有声明 network.fetch", 403);
  }
  if (!NET_METHODS.has(method)) throw new ApiError("METHOD_NOT_ALLOWED", "不支持的请求方法", 405);

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new ApiError("INVALID_URL", "URL 不合法", 400);
  }
  if (target.protocol !== "https:") throw new ApiError("INVALID_URL", "只允许 https 请求", 400);
  if (target.username || target.password) throw new ApiError("INVALID_URL", "URL 不能包含凭据", 400);
  if (target.port && target.port !== "443") throw new ApiError("INVALID_URL", "只允许标准 443 端口", 400);

  const host = target.hostname.toLowerCase();
  if (!matchesHost(host, manifest.networkDomains ?? [])) {
    throw new ApiError("DOMAIN_NOT_ALLOWED", `域名 ${host} 不在插件声明的白名单中`, 403);
  }
  if (isPrivateHost(host)) throw new ApiError("DOMAIN_NOT_ALLOWED", "不允许访问内网地址", 403);

  const headers = new Headers();
  const input = body.headers && typeof body.headers === "object" ? body.headers : {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key).toLowerCase();
    if (!NET_HEADER_ALLOW.has(name)) continue;
    const text = String(value ?? "");
    if (text.length > 2048) throw new ApiError("INVALID_HEADER", "请求头过长", 400);
    headers.set(name, text);
  }
  headers.set("accept", headers.get("accept") || "application/json");
  const payload = method === "GET" || method === "HEAD" ? undefined : String(body.body ?? "").slice(0, 16 * 1024);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLUGIN_LIMITS.rpcTimeoutMs);
  try {
    const response = await fetch(target.toString(), {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: controller.signal,
      cf: { cacheTtl: 0 },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError("REDIRECT_BLOCKED", "外部服务返回了跳转，已阻止跟随", 502);
    }
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > 256 * 1024;
    const bytes = truncated ? buffer.slice(0, 256 * 1024) : buffer;
    const text = new TextDecoder().decode(bytes);
    await audit(env, {
      actorId: session.user.id,
      action: "plugin.network.fetch",
      pluginId,
      detail: { host, status: response.status, bytes: bytes.byteLength },
    });
    return ok({
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      text,
      truncated,
      bytes: bytes.byteLength,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("NETWORK_ERROR", "外部请求失败或超时", 502);
  } finally {
    clearTimeout(timer);
  }
}

function matchesHost(host, list) {
  return (Array.isArray(list) ? list : []).some((entry) => {
    const rule = String(entry).toLowerCase();
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === rule;
  });
}

function isPrivateHost(host) {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host === "[::1]" || host.includes(":")) return true;
  return false;
}
