/**
 * Guandao OS 1.6 · 社区写入接口
 *
 * 所有写操作都在这里统一做四件事：
 *   1. 从 Session 解析身份，绝不相信客户端传入的 author_id / user_id；
 *   2. 校验内容包结构、图片真实类型、R2 配额与每日发布配额；
 *   3. 先写 R2 再写 D1（D1 batch 具有事务性），失败时清理孤儿对象；
 *   4. 计数写入后统一用 COUNT(*) 重算，避免重复点赞 / 并发漂移。
 */

import { ApiError, ok } from "../http.js";
import { sha256Hex } from "../auth/crypto.js";
import {
  assertCommentAllowed,
  assertCommentQuota,
  assertDailyPostQuota,
  assertPackageQuota,
  assertPublishingAllowed,
  assertStorageQuota,
  audit,
  ensureProfile,
  loadPost,
  notify,
  pageParams,
  readForm,
  readJson,
  viewerContext,
} from "./common.js";
import {
  CATEGORIES,
  LICENSE_IDS,
  LIMITS,
  PACKAGE_TYPE_BY_POST,
  POST_TYPES,
  WALLPAPER_CATEGORIES,
  assertImage,
  byteLength,
  canonicalJson,
  checkCompatibility,
  cleanText,
  compareSemver,
  objectPrefix,
  packageObjectKey,
  sanitizeTag,
  validateManifest,
} from "./validate.js";
import {
  creatorStats,
  getCreatorRow,
  getSettings,
  listFavorites,
  listFavoriteCollections,
  listNotifications,
  listPosts,
  mapAsset,
  mapPost,
  recomputePostCounters,
  unreadNotificationCount,
  userUsage,
} from "./store.js";

const UUID = /^[0-9a-f-]{36}$/;

/* ============================================================
   小工具
   ============================================================ */

function bad(message, code = "INVALID_INPUT") {
  throw new ApiError(code, message, 400);
}

function normalizeCategory(type, value) {
  const category = String(value ?? "").trim().slice(0, 32);
  if (!CATEGORIES[type]) bad("作品类型不合法");
  if (!category) return CATEGORIES[type][CATEGORIES[type].length - 1];
  if (!CATEGORIES[type].includes(category)) bad("分类不在允许范围内");
  return category;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > LIMITS.tags) bad(`标签最多 ${LIMITS.tags} 个`);
  const out = [];
  for (const item of value) {
    const tag = sanitizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function normalizeLicense(body) {
  const license = String(body?.license ?? "");
  if (!LICENSE_IDS.includes(license)) bad("请选择支持的许可证");
  const note = cleanText(body?.licenseNote ?? "", LIMITS.licenseNote);
  if (license === "CUSTOM" && note.length < 10) bad("自定义许可证需要至少 10 个字符的授权说明");
  return { license, note };
}

async function resolveAsset(env, userId, id, kinds, { postId = null } = {}) {
  const value = id ? String(id) : "";
  if (!value) return null;
  if (!UUID.test(value)) bad("图片资源 ID 不合法");
  const row = await env.DB.prepare("SELECT * FROM community_assets WHERE id = ? AND user_id = ? AND status = 'ready'")
    .bind(value, userId)
    .first();
  if (!row || !kinds.includes(row.kind)) bad("图片资源不存在或类型不符");
  if (row.post_id && row.post_id !== postId) bad("该图片已属于其他作品");
  return row;
}

async function resolvePreviewPairs(env, userId, pairs, kind, thumbKind, max, postId = null) {
  if (!Array.isArray(pairs)) return [];
  if (pairs.length > max) bad(`最多上传 ${max} 张图片`);
  const out = [];
  for (const pair of pairs) {
    const id = typeof pair === "string" ? pair : pair?.id;
    const thumbId = typeof pair === "string" ? null : pair?.thumbId;
    const asset = await resolveAsset(env, userId, id, [kind], { postId });
    if (!asset) continue;
    let thumb = null;
    if (thumbId) {
      thumb = await env.DB.prepare(
        "SELECT * FROM community_assets WHERE id = ? AND user_id = ? AND status = 'ready' AND kind = ?",
      )
        .bind(String(thumbId), userId, thumbKind)
        .first();
    }
    out.push({ asset, thumb });
  }
  return out;
}

function assetUpdateStatements(env, pairs, postId, startingOrder = 0) {
  return pairs.map(({ asset }, index) =>
    env.DB.prepare(
      `UPDATE community_assets
          SET post_id = ?, sort_order = ?, status = 'ready'
        WHERE id = ? AND user_id = ? AND (post_id IS NULL OR post_id = ?)`,
    ).bind(postId, startingOrder + index, asset.id, asset.user_id, postId),
  );
}

/* ============================================================
   R2 内容包写入
   ============================================================ */

async function putPackageObjects(env, { userId, postId, manifest, canonical, checksum }) {
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置，暂时不能发布内容包", 503);
  const packageKey = packageObjectKey(userId, postId, manifest.version, "package");
  const manifestKey = packageObjectKey(userId, postId, manifest.version, "manifest");
  const metadata = {
    schemaVersion: 1,
    packageId: manifest.packageId,
    type: manifest.type,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    license: manifest.license,
    compatibility: manifest.compatibility,
    checksumSha256: checksum,
    publishedAt: new Date().toISOString(),
  };
  const manifestText = canonicalJson(metadata);
  await env.FILES.put(packageKey, canonical, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { checksum },
  });
  await env.FILES.put(manifestKey, manifestText, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return { packageKey, manifestKey, sizeBytes: byteLength(canonical) };
}

async function cleanupObjects(env, keys) {
  if (!env.FILES) return;
  for (const key of keys) {
    try {
      await env.FILES.delete(key);
    } catch {
      /* 清理失败不影响主流程，孤儿对象由维护任务处理 */
    }
  }
}

async function assertPackageIdAvailable(env, packageId, postId) {
  const row = await env.DB.prepare("SELECT post_id FROM community_packages WHERE package_id = ?").bind(packageId).first();
  if (row && row.post_id !== postId) {
    throw new ApiError("PACKAGE_ID_TAKEN", "这个 packageId 已被其他作品使用，请修改后重试", 409);
  }
}

/**
 * 发布 / 更新内容包。作品行必须已经存在（D1 外键约束）。
 * 首次发布创建 package + version；已存在时只追加更高版本，历史版本保留。
 */
async function writePackageVersion(env, { userId, postId, manifest, canonical, checksum, changelog, publishAt }) {
  const existing = await env.DB.prepare("SELECT * FROM community_packages WHERE post_id = ? AND status = 'active'")
    .bind(postId)
    .first();
  const { packageKey, manifestKey, sizeBytes } = await putPackageObjects(env, {
    userId,
    postId,
    manifest,
    canonical,
    checksum,
  });
  const now = Date.now();
  const compatibilityJson = JSON.stringify(manifest.compatibility);

  try {
    if (!existing) {
      await assertPackageIdAvailable(env, manifest.packageId, postId);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO community_packages
             (id, author_id, post_id, package_type, package_id, version, compatibility_json,
              manifest_object_key, package_object_key, checksum_sha256, license, status, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), userId, postId, PACKAGE_TYPE_BY_POST[manifest.type], manifest.packageId,
          manifest.version, compatibilityJson, manifestKey, packageKey, checksum, manifest.license, sizeBytes, now, now,
        ),
        env.DB.prepare(
          `INSERT INTO package_versions
             (id, package_id, version, changelog, manifest_object_key, package_object_key,
              checksum_sha256, compatibility_json, size_bytes, created_at, published_at)
           VALUES (?, (SELECT id FROM community_packages WHERE post_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), postId, manifest.version, changelog, manifestKey, packageKey,
          checksum, compatibilityJson, sizeBytes, now, publishAt,
        ),
        env.DB.prepare(
          `UPDATE community_posts
              SET version = ?, compatibility_json = ?, package_id = ?, updated_at = ?
            WHERE id = ?`,
        ).bind(manifest.version, compatibilityJson, manifest.packageId, now, postId),
      ]);
      return { version: manifest.version, checksum, sizeBytes, keys: [packageKey, manifestKey] };
    }

    if (manifest.packageId !== existing.package_id) {
      throw new ApiError("PACKAGE_ID_MISMATCH", "更新作品时 packageId 必须保持不变", 409);
    }
    if (compareSemver(manifest.version, existing.version) <= 0) {
      throw new ApiError("VERSION_NOT_INCREASED", `新版本号必须高于当前版本 ${existing.version}`, 409);
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO package_versions
           (id, package_id, version, changelog, manifest_object_key, package_object_key,
            checksum_sha256, compatibility_json, size_bytes, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), existing.id, manifest.version, changelog, manifestKey, packageKey,
        checksum, compatibilityJson, sizeBytes, now, publishAt,
      ),
      env.DB.prepare(
        `UPDATE community_packages
            SET version = ?, compatibility_json = ?, manifest_object_key = ?, package_object_key = ?,
                checksum_sha256 = ?, size_bytes = ?, license = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(
        manifest.version, compatibilityJson, manifestKey, packageKey, checksum, sizeBytes,
        manifest.license, now, existing.id,
      ),
      env.DB.prepare(
        `UPDATE community_posts
            SET version = ?, compatibility_json = ?, package_id = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(manifest.version, compatibilityJson, manifest.packageId, now, postId),
    ]);
    return { version: manifest.version, checksum, sizeBytes, keys: [packageKey, manifestKey] };
  } catch (error) {
    await cleanupObjects(env, [packageKey, manifestKey]);
    throw error;
  }
}

/** 从已有 package 的 R2 对象读取 manifest，用于「撤回后原版本重新发布」。 */
async function readExistingManifest(env, postId) {
  const pkg = await env.DB.prepare("SELECT * FROM community_packages WHERE post_id = ? AND status = 'active'")
    .bind(postId)
    .first();
  if (!pkg || !env.FILES) return null;
  const object = await env.FILES.get(pkg.package_object_key);
  if (!object) return null;
  const canonical = await object.text();
  const validated = validateManifest(JSON.parse(canonical), pkg.package_type === "wallpaper-collection" ? "wallpaper" : pkg.package_type);
  return { ...validated, packageRow: pkg };
}

/* ============================================================
   POST /api/community/uploads
   ============================================================ */

const IMAGE_KINDS = ["avatar", "cover", "preview", "wallpaper"];

export async function createUpload({ env, request, viewer }) {
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置", 503);
  const settings = await getSettings(env);
  const maxBytes = Number(settings?.max_upload_bytes || 8 * 1024 * 1024);
  const form = await readForm(request, Math.min(maxBytes + 3 * 1024 * 1024, 24 * 1024 * 1024));

  const kind = String(form.get("kind") || "");
  if (!IMAGE_KINDS.includes(kind)) bad("上传类型不合法");
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function" || file.size <= 0) {
    bad("请选择要上传的图片");
  }
  if (file.size > maxBytes) {
    throw new ApiError("FILE_TOO_LARGE", `单张图片不能超过 ${(maxBytes / 1024 / 1024).toFixed(1)} MB`, 413);
  }

  const postId = String(form.get("postId") || "");
  let post = null;
  if (postId) {
    if (!UUID.test(postId)) bad("作品 ID 不合法");
    post = await env.DB.prepare("SELECT id, author_id, status FROM community_posts WHERE id = ?").bind(postId).first();
    if (!post || post.author_id !== viewer.id || post.status === "deleted") {
      throw new ApiError("NOT_FOUND", "作品不存在", 404);
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = assertImage(bytes, kind);

  let thumbBytes = null;
  let thumbInfo = null;
  const thumbFile = form.get("thumb");
  if (
    thumbFile &&
    typeof thumbFile !== "string" &&
    typeof thumbFile.arrayBuffer === "function" &&
    thumbFile.size > 0 &&
    thumbFile.size <= 2 * 1024 * 1024
  ) {
    try {
      thumbBytes = new Uint8Array(await thumbFile.arrayBuffer());
      thumbInfo = assertImage(thumbBytes, `${kind}_thumb`);
    } catch {
      thumbBytes = null;
      thumbInfo = null;
    }
  }

  await assertStorageQuota(
    env,
    viewer.id,
    Number(settings.max_user_storage_bytes),
    bytes.byteLength + (thumbBytes?.byteLength || 0),
  );

  const assetId = crypto.randomUUID();
  const key = `users/${viewer.id}/community/${objectPrefix(kind)}/${assetId}.${info.ext}`;
  const thumbKind = `${kind}_thumb`;
  const thumbId = thumbBytes ? crypto.randomUUID() : null;
  const thumbKey = thumbBytes ? `users/${viewer.id}/community/${objectPrefix(thumbKind)}/${thumbId}.${thumbInfo.ext}` : null;
  const now = Date.now();
  const order = Number(form.get("order")) || 0;

  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=0" },
    customMetadata: { owner: viewer.id },
  });
  if (thumbKey && thumbBytes) {
    await env.FILES.put(thumbKey, thumbBytes, {
      httpMetadata: { contentType: thumbInfo.mime, cacheControl: "private, max-age=0" },
      customMetadata: { owner: viewer.id },
    });
  }

  try {
    const statements = [
      env.DB.prepare(
        `INSERT INTO community_assets
           (id, user_id, post_id, parent_asset_id, kind, object_key, mime_type, size_bytes,
            width, height, sort_order, status, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
      ).bind(
        assetId, viewer.id, post?.id || null, kind, key, info.mime, bytes.byteLength,
        info.width, info.height, order, now,
      ),
    ];
    if (thumbId && thumbKey && thumbInfo) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO community_assets
             (id, user_id, post_id, parent_asset_id, kind, object_key, mime_type, size_bytes,
              width, height, sort_order, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
        ).bind(
          thumbId, viewer.id, post?.id || null, assetId, thumbKind, thumbKey, thumbInfo.mime,
          thumbBytes.byteLength, thumbInfo.width, thumbInfo.height, order, now,
        ),
      );
    }
    await env.DB.batch(statements);
  } catch (error) {
    await cleanupObjects(env, [key, thumbKey].filter(Boolean));
    throw error;
  }

  const assetRow = await env.DB.prepare("SELECT * FROM community_assets WHERE id = ?").bind(assetId).first();
  const thumbRow = thumbId
    ? await env.DB.prepare("SELECT * FROM community_assets WHERE id = ?").bind(thumbId).first()
    : null;
  return ok({ asset: mapAsset(assetRow), thumb: mapAsset(thumbRow) }, { status: 201 });
}

/* ============================================================
   POST /api/community/posts
   ============================================================ */

export async function createPost({ env, request, viewer }) {
  const settings = await assertPublishingAllowed(env, viewer.id);
  await ensureProfile(env, viewer.user);
  const body = await readJson(request, 320 * 1024);

  const type = String(body?.type ?? "");
  if (!POST_TYPES.includes(type)) bad("请选择合法的发布类型");
  if (type === "wallpaper" && !WALLPAPER_CATEGORIES.length) bad("壁纸分类尚未配置");
  const publish = Boolean(body?.publish);

  await assertDailyPostQuota(env, viewer.id, Number(settings.max_posts_per_day));
  await assertPackageQuota(env, viewer.id, Number(settings.max_packages_per_user));

  const title = cleanText(body.title, LIMITS.title, { required: true, allowNewline: false });
  if (title.length < 2) bad("作品名称至少 2 个字符");
  const description = cleanText(body.description ?? "", LIMITS.description);
  const category = normalizeCategory(type, body.category);
  const tags = normalizeTags(body.tags);
  const { license, note: licenseNote } = normalizeLicense(body);
  const visibility = body.visibility === "unlisted" ? "unlisted" : "public";
  const rightsConfirmed = Boolean(body.rightsConfirmed);
  const cover = await resolveAsset(env, viewer.id, body.coverAssetId, ["cover"]);
  const coverThumb = body.coverThumbAssetId
    ? await env.DB.prepare(
        "SELECT * FROM community_assets WHERE id = ? AND user_id = ? AND status = 'ready' AND kind = 'cover_thumb'",
      )
        .bind(String(body.coverThumbAssetId), viewer.id)
        .first()
    : null;
  const previews = await resolvePreviewPairs(env, viewer.id, body.previews, "preview", "preview_thumb", LIMITS.previews);
  const wallpapers = await resolvePreviewPairs(
    env, viewer.id, body.wallpapers, "wallpaper", "wallpaper_thumb", LIMITS.wallpaperItems,
  );

  if (type === "wallpaper" && wallpapers.length === 0) bad("壁纸作品至少需要上传一张壁纸");
  if (publish && !rightsConfirmed) bad("发布前必须确认你拥有相关作品的分享权利");

  let manifest = null;
  let canonical = null;
  if (body.manifest != null) {
    const validated = validateManifest(body.manifest, type);
    manifest = validated.manifest;
    canonical = validated.canonical;
    if (type === "wallpaper") {
      if (!manifest.configuration.items.length) {
        manifest.configuration.items = wallpapers.map(() => ({ caption: "" }));
        canonical = canonicalJson(manifest);
      }
      if (manifest.configuration.items.length !== wallpapers.length) {
        bad("壁纸条目数量与上传图片数量不一致");
      }
    }
  }
  if (publish && !manifest) bad("请先上传或生成内容包，再发布作品");
  if (publish && manifest) {
    const compat = checkCompatibility(manifest.compatibility);
    if (!compat.ok) throw new ApiError("INCOMPATIBLE", compat.reason, 409);
  }

  const postId = crypto.randomUUID();
  const now = Date.now();
  const status = publish
    ? settings.require_review && viewer.role !== "admin"
      ? "pending_review"
      : "published"
    : "draft";
  if (publish && !cover && previews.length === 0 && wallpapers.length === 0) {
    bad("发布前至少上传一张封面或预览图");
  }

  let packageWritten = false;
  const writtenKeys = [];
  const nowMs = Date.now();

  try {
    // 第一步：先建立作品行（草稿态），再在同一数据库里挂载图片资源。
    const statements = [
      env.DB.prepare(
        `INSERT INTO community_posts
           (id, author_id, post_type, title, description, category, tags_json, cover_asset_id, cover_thumb_asset_id,
            license, license_note, rights_confirmed, status, visibility, version, compatibility_json, draft_manifest_json,
            package_id, like_count, favorite_count, comment_count, download_count, view_count, created_at, updated_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, '1.0.0', '{}', ?, NULL, 0, 0, 0, 0, 0, ?, ?, NULL)`,
      ).bind(
        postId, viewer.id, type, title, description, category, JSON.stringify(tags),
        cover?.id || null, coverThumb?.id || null, license, licenseNote, rightsConfirmed ? 1 : 0,
        visibility, !publish && canonical ? canonical : null, nowMs, nowMs,
      ),
      ...assetUpdateStatements(env, previews, postId, 0),
      ...assetUpdateStatements(env, wallpapers, postId, 0),
    ];
    if (cover) {
      statements.push(
        env.DB.prepare(
          "UPDATE community_assets SET post_id = ? WHERE id = ? AND user_id = ? AND (post_id IS NULL OR post_id = ?)",
        ).bind(postId, cover.id, viewer.id, postId),
      );
    }
    if (coverThumb) {
      statements.push(
        env.DB.prepare(
          "UPDATE community_assets SET post_id = ? WHERE id = ? AND user_id = ? AND (post_id IS NULL OR post_id = ?)",
        ).bind(postId, coverThumb.id, viewer.id, postId),
      );
    }
    const results = await env.DB.batch(statements);
    if (Number(results?.[0]?.meta?.changes ?? 0) !== 1) {
      throw new ApiError("WRITE_FAILED", "作品写入失败", 500);
    }
    for (const result of results.slice(1)) {
      if (Number(result?.meta?.changes ?? 0) === 0) {
        throw new ApiError("ASSET_CONFLICT", "有图片资源已被其他作品占用，请重新上传", 409);
      }
    }

    // 第二步：发布时把内容包写入 R2，并追加 package / version。
    if (publish && manifest && canonical) {
      const checksum = await sha256Hex(canonical);
      const written = await writePackageVersion(env, {
        userId: viewer.id,
        postId,
        manifest,
        canonical,
        checksum,
        changelog: cleanText(body.changelog ?? "首次发布", 1000) || "首次发布",
        publishAt: status === "published" ? now : null,
      });
      writtenKeys.push(...(written?.keys ?? []));
      packageWritten = true;
      await env.DB.prepare(
        `UPDATE community_posts
            SET status = ?, rights_confirmed = 1, draft_manifest_json = NULL, updated_at = ?,
                published_at = CASE WHEN ? = 'published' THEN ? ELSE NULL END
          WHERE id = ?`,
      )
        .bind(status, now, status, now, postId)
        .run();
    }
  } catch (error) {
    await cleanupObjects(env, writtenKeys);
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE community_assets SET status = 'deleting', post_id = NULL WHERE post_id = ?").bind(postId),
        env.DB.prepare("DELETE FROM package_versions WHERE package_id IN (SELECT id FROM community_packages WHERE post_id = ?)").bind(postId),
        env.DB.prepare("DELETE FROM community_packages WHERE post_id = ?").bind(postId),
        env.DB.prepare("DELETE FROM community_posts WHERE id = ?").bind(postId),
      ]);
    } catch {
      /* 回滚失败留给维护任务 */
    }
    throw error;
  }

  const row = await env.DB.prepare("SELECT * FROM community_posts WHERE id = ?").bind(postId).first();
  const authorRow = await env.DB.prepare(
    `SELECT u.github_username, u.role, pr.display_name, pr.avatar_asset_id, pr.creator_title,
            cr.role AS moderator_role
       FROM users u LEFT JOIN community_profiles pr ON pr.user_id = u.id
       LEFT JOIN community_roles cr ON cr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(viewer.id)
    .first();
  const hydrated = {
    ...row,
    author_username: authorRow?.github_username,
    author_user_role: authorRow?.role,
    author_moderator_role: authorRow?.moderator_role,
    author_display_name: authorRow?.display_name,
    author_avatar_asset_id: authorRow?.avatar_asset_id,
    author_creator_title: authorRow?.creator_title,
    viewer_liked: 0,
    viewer_favorited: 0,
    viewer_following: 0,
    report_count: 0,
  };
  return ok(
    {
      post: mapPost(hydrated, { includeModeration: true }),
      status,
      packageWritten,
      message:
        status === "pending_review"
          ? "已提交审核，管理员通过后会在社区公开"
          : status === "published"
            ? "已发布到 Guandao Community"
            : "草稿已保存",
    },
    { status: 201 },
  );
}

/* ============================================================
   PATCH / DELETE / publish / withdraw / versions
   ============================================================ */

export async function patchPost({ env, request, viewer, id }) {
  const { row, isOwner } = await loadPost(env, id, viewer);
  if (!isOwner) throw new ApiError("FORBIDDEN", "只能修改自己的作品", 403);
  if (row.status === "deleted") throw new ApiError("NOT_FOUND", "作品不存在", 404);
  const settings = await getSettings(env);
  const body = await readJson(request, 320 * 1024);

  const updates = [];
  const binds = [];
  let sensitiveChange = false;

  if (body.title !== undefined) {
    const title = cleanText(body.title, LIMITS.title, { required: true, allowNewline: false });
    if (title.length < 2) bad("作品名称至少 2 个字符");
    updates.push("title = ?");
    binds.push(title);
    sensitiveChange = true;
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    binds.push(cleanText(body.description, LIMITS.description));
    sensitiveChange = true;
  }
  if (body.category !== undefined) {
    updates.push("category = ?");
    binds.push(normalizeCategory(row.post_type, body.category));
  }
  if (body.tags !== undefined) {
    updates.push("tags_json = ?");
    binds.push(JSON.stringify(normalizeTags(body.tags)));
  }
  if (body.license !== undefined || body.licenseNote !== undefined) {
    const { license, note } = normalizeLicense(body);
    updates.push("license = ?", "license_note = ?");
    binds.push(license, note);
    sensitiveChange = true;
  }
  if (body.visibility !== undefined) {
    updates.push("visibility = ?");
    binds.push(body.visibility === "unlisted" ? "unlisted" : "public");
  }
  if (body.rightsConfirmed !== undefined) {
    updates.push("rights_confirmed = ?");
    binds.push(body.rightsConfirmed ? 1 : 0);
  }
  if (body.manifest !== undefined && ["draft", "rejected", "pending_review"].includes(row.status)) {
    if (body.manifest == null) {
      updates.push("draft_manifest_json = NULL");
    } else {
      const validated = validateManifest(body.manifest, row.post_type);
      updates.push("draft_manifest_json = ?");
      binds.push(validated.canonical);
      sensitiveChange = true;
    }
  }

  const replacePreviews = body.previews !== undefined;
  const replaceWallpapers = body.wallpapers !== undefined;
  const replaceCover = body.coverAssetId !== undefined;
  let cover = null;
  let coverThumb = null;
  let previews = [];
  let wallpapers = [];

  if (replaceCover) {
    cover = body.coverAssetId ? await resolveAsset(env, viewer.id, body.coverAssetId, ["cover"], { postId: id }) : null;
    coverThumb = body.coverThumbAssetId
      ? await env.DB.prepare(
          "SELECT * FROM community_assets WHERE id = ? AND user_id = ? AND status = 'ready' AND kind = 'cover_thumb'",
        )
          .bind(String(body.coverThumbAssetId), viewer.id)
          .first()
      : null;
    updates.push("cover_asset_id = ?", "cover_thumb_asset_id = ?");
    binds.push(cover?.id || null, coverThumb?.id || null);
    sensitiveChange = true;
  }
  if (replacePreviews) {
    previews = await resolvePreviewPairs(env, viewer.id, body.previews, "preview", "preview_thumb", LIMITS.previews, id);
    sensitiveChange = true;
  }
  if (replaceWallpapers) {
    wallpapers = await resolvePreviewPairs(
      env, viewer.id, body.wallpapers, "wallpaper", "wallpaper_thumb", LIMITS.wallpaperItems, id,
    );
    sensitiveChange = true;
  }

  if (!updates.length && !replacePreviews && !replaceWallpapers && !replaceCover) {
    return ok({ unchanged: true, post: (await loadPost(env, id, viewer)).post });
  }

  const willReview =
    row.status === "published" &&
    sensitiveChange &&
    Boolean(settings?.require_review) &&
    viewer.role !== "admin";
  if (willReview) {
    updates.push("status = ?");
    binds.push("pending_review");
  }
  updates.push("updated_at = ?");
  binds.push(Date.now());

  const statements = [
    env.DB.prepare(`UPDATE community_posts SET ${updates.join(", ")} WHERE id = ? AND author_id = ?`).bind(
      ...binds,
      id,
      viewer.id,
    ),
  ];

  if (replaceCover) {
    const keep = [cover?.id, coverThumb?.id].filter(Boolean);
    if (cover) {
      statements.push(
        env.DB.prepare(
          "UPDATE community_assets SET post_id = ? WHERE id = ? AND user_id = ? AND (post_id IS NULL OR post_id = ?)",
        ).bind(id, cover.id, viewer.id, id),
      );
    }
    if (coverThumb) {
      statements.push(
        env.DB.prepare(
          "UPDATE community_assets SET post_id = ? WHERE id = ? AND user_id = ? AND (post_id IS NULL OR post_id = ?)",
        ).bind(id, coverThumb.id, viewer.id, id),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE community_assets SET status = 'deleting', post_id = NULL
          WHERE post_id = ? AND user_id = ? AND status = 'ready'
            AND kind IN ('cover', 'cover_thumb')
            ${keep.length ? `AND id NOT IN (${keep.map(() => "?").join(", ")})` : ""}`,
      ).bind(id, viewer.id, ...keep),
    );
  }

  if (replacePreviews) {
    const keep = [];
    for (const pair of previews) {
      keep.push(pair.asset.id);
      if (pair.thumb) keep.push(pair.thumb.id);
    }
    statements.push(...assetUpdateStatements(env, previews, id, 0));
    statements.push(
      env.DB.prepare(
        `UPDATE community_assets SET status = 'deleting', post_id = NULL
          WHERE post_id = ? AND user_id = ? AND status = 'ready'
            AND kind IN ('preview', 'preview_thumb')
            ${keep.length ? `AND id NOT IN (${keep.map(() => "?").join(", ")})` : ""}`,
      ).bind(id, viewer.id, ...keep),
    );
  }

  if (replaceWallpapers) {
    const keep = [];
    for (const pair of wallpapers) {
      keep.push(pair.asset.id);
      if (pair.thumb) keep.push(pair.thumb.id);
    }
    statements.push(...assetUpdateStatements(env, wallpapers, id, 0));
    statements.push(
      env.DB.prepare(
        `UPDATE community_assets SET status = 'deleting', post_id = NULL
          WHERE post_id = ? AND user_id = ? AND status = 'ready'
            AND kind IN ('wallpaper', 'wallpaper_thumb')
            ${keep.length ? `AND id NOT IN (${keep.map(() => "?").join(", ")})` : ""}`,
      ).bind(id, viewer.id, ...keep),
    );
  }

  await env.DB.batch(statements);
  const updated = await loadPost(env, id, viewer);
  return ok({
    post: updated.post,
    message: willReview ? "已提交修改审核，通过后会重新公开" : "作品信息已更新",
  });
}

export async function deletePost({ env, viewer, id }) {
  const { row, isOwner } = await loadPost(env, id, viewer);
  if (!isOwner && viewer.role !== "admin") throw new ApiError("FORBIDDEN", "只能删除自己的作品", 403);
  if (row.status === "deleted") return ok({ deleted: true });

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE community_posts SET status = 'deleted', deleted_at = ?, updated_at = ?, featured_at = NULL WHERE id = ?",
    ).bind(Date.now(), Date.now(), id),
    env.DB.prepare("UPDATE community_packages SET status = 'deleted', updated_at = ? WHERE post_id = ?").bind(Date.now(), id),
    env.DB.prepare(
      "UPDATE community_assets SET status = 'deleting', post_id = NULL WHERE post_id = ? AND status = 'ready'",
    ).bind(id),
  ]);
  await audit(env, {
    actorId: viewer.id,
    action: isOwner ? "post.delete_own" : "post.delete_admin",
    targetType: "post",
    targetId: id,
    detail: { title: row.title, status: row.status },
  });
  return ok({ deleted: true });
}

export async function publishPost({ env, request, viewer, id }) {
  const settings = await assertPublishingAllowed(env, viewer.id);
  const { row, isOwner } = await loadPost(env, id, viewer);
  if (!isOwner) throw new ApiError("FORBIDDEN", "只能发布自己的作品", 403);
  if (row.status === "published") return ok({ post: (await loadPost(env, id, viewer)).post, message: "作品已经发布" });
  const body = await readJson(request, 320 * 1024);

  let manifest = null;
  let canonical = null;
  if (body?.manifest != null) {
    const validated = validateManifest(body.manifest, row.post_type);
    manifest = validated.manifest;
    canonical = validated.canonical;
  } else if (row.draft_manifest_json) {
    const validated = validateManifest(JSON.parse(row.draft_manifest_json), row.post_type);
    manifest = validated.manifest;
    canonical = validated.canonical;
  } else {
    const existing = await readExistingManifest(env, id);
    if (existing) {
      manifest = existing.manifest;
      canonical = existing.canonical;
    }
  }
  if (!manifest || !canonical) bad("请先上传或生成内容包，再发布作品");
  if (!row.rights_confirmed && !body?.rightsConfirmed) bad("发布前必须确认你拥有相关作品的分享权利");
  const compat = checkCompatibility(manifest.compatibility);
  if (!compat.ok) throw new ApiError("INCOMPATIBLE", compat.reason, 409);

  const status = settings.require_review && viewer.role !== "admin" ? "pending_review" : "published";
  const now = Date.now();
  const checksum = await sha256Hex(canonical);
  const existingPkg = await env.DB.prepare(
    "SELECT * FROM community_packages WHERE post_id = ? AND status = 'active'",
  )
    .bind(id)
    .first();
  let wroteNewVersion = false;

  if (existingPkg) {
    const comparison = compareSemver(manifest.version, existingPkg.version);
    if (comparison < 0) {
      throw new ApiError("VERSION_NOT_INCREASED", `版本号不能低于当前版本 ${existingPkg.version}`, 409);
    }
    if (comparison === 0) {
      if (checksum !== existingPkg.checksum_sha256) {
        throw new ApiError("VERSION_CONFLICT", "相同版本号的内容与原版本不一致，请提升版本号", 409);
      }
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE community_posts
              SET status = ?, rights_confirmed = 1, draft_manifest_json = NULL, moderation_note = NULL, updated_at = ?,
                  published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
            WHERE id = ? AND author_id = ?`,
        ).bind(status, now, status, now, id, viewer.id),
        env.DB.prepare(
          "UPDATE package_versions SET published_at = COALESCE(published_at, ?) WHERE package_id = ? AND version = ?",
        ).bind(status === "published" ? now : null, existingPkg.id, manifest.version),
      ]);
    } else {
      await writePackageVersion(env, {
        userId: viewer.id,
        postId: id,
        manifest,
        canonical,
        checksum,
        changelog: cleanText(body?.changelog ?? "版本更新", 1000) || "版本更新",
        publishAt: status === "published" ? now : null,
      });
      wroteNewVersion = true;
      await env.DB.prepare(
        `UPDATE community_posts
            SET status = ?, rights_confirmed = 1, draft_manifest_json = NULL, moderation_note = NULL, updated_at = ?,
                published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
          WHERE id = ? AND author_id = ?`,
      )
        .bind(status, now, status, now, id, viewer.id)
        .run();
    }
  } else {
    await writePackageVersion(env, {
      userId: viewer.id,
      postId: id,
      manifest,
      canonical,
      checksum,
      changelog: cleanText(body?.changelog ?? "首次发布", 1000) || "首次发布",
      publishAt: status === "published" ? now : null,
    });
    wroteNewVersion = true;
    await env.DB.prepare(
      `UPDATE community_posts
          SET status = ?, rights_confirmed = 1, draft_manifest_json = NULL, moderation_note = NULL, updated_at = ?,
              published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
        WHERE id = ? AND author_id = ?`,
    )
      .bind(status, now, status, now, id, viewer.id)
      .run();
  }

  await notify(env, {
    userId: viewer.id,
    type: "post_review",
    payload: { title: row.title, status, message: status === "pending_review" ? "作品已提交审核" : "作品已发布" },
  });
  const updated = await loadPost(env, id, viewer);
  return ok({
    post: updated.post,
    version: manifest.version,
    wroteNewVersion,
    message: status === "pending_review" ? "已提交审核，通过后会在社区公开" : "已发布到 Guandao Community",
  });
}

export async function withdrawPost({ env, viewer, id }) {
  const { row, isOwner } = await loadPost(env, id, viewer);
  if (!isOwner) throw new ApiError("FORBIDDEN", "只能撤回自己的作品", 403);
  if (!["published", "pending_review"].includes(row.status)) bad("当前状态不能撤回");
  await env.DB.prepare(
    "UPDATE community_posts SET status = 'draft', featured_at = NULL, updated_at = ? WHERE id = ? AND author_id = ?",
  )
    .bind(Date.now(), id, viewer.id)
    .run();
  await audit(env, {
    actorId: viewer.id,
    action: "post.withdraw",
    targetType: "post",
    targetId: id,
    detail: { from: row.status },
  });
  return ok({ post: (await loadPost(env, id, viewer)).post, message: "作品已撤回为草稿" });
}

export async function createVersion({ env, request, viewer, id }) {
  const settings = await assertPublishingAllowed(env, viewer.id);
  const { row } = await loadPost(env, id, viewer);
  if (row.author_id !== viewer.id) throw new ApiError("FORBIDDEN", "只能更新自己的作品", 403);
  if (!["published", "pending_review", "draft", "rejected"].includes(row.status)) bad("当前状态不能发布新版本");
  const body = await readJson(request, 320 * 1024);
  if (!body?.manifest) bad("缺少新版本内容包");
  if (!row.rights_confirmed && !body.rightsConfirmed) bad("请先确认作品授权");
  const validated = validateManifest(body.manifest, row.post_type);
  const compat = checkCompatibility(validated.manifest.compatibility);
  if (!compat.ok) throw new ApiError("INCOMPATIBLE", compat.reason, 409);
  const changelog = cleanText(body.changelog, 2000);
  if (changelog.length < 2) bad("请填写本版本的更新说明");

  const existing = await env.DB.prepare("SELECT * FROM community_packages WHERE post_id = ? AND status = 'active'")
    .bind(id)
    .first();
  if (!existing) bad("该作品还没有内容包，请先发布首版");
  if (validated.manifest.packageId !== existing.package_id) {
    throw new ApiError("PACKAGE_ID_MISMATCH", "更新作品时 packageId 必须保持不变", 409);
  }
  if (compareSemver(validated.manifest.version, existing.version) <= 0) {
    throw new ApiError("VERSION_NOT_INCREASED", `新版本号必须高于当前版本 ${existing.version}`, 409);
  }

  const status = settings.require_review && viewer.role !== "admin" ? "pending_review" : "published";
  const now = Date.now();
  const checksum = await sha256Hex(validated.canonical);
  await writePackageVersion(env, {
    userId: viewer.id,
    postId: id,
    manifest: validated.manifest,
    canonical: validated.canonical,
    checksum,
    changelog,
    publishAt: status === "published" ? now : null,
  });
  await env.DB.prepare(
    `UPDATE community_posts
        SET status = ?, rights_confirmed = 1, version = ?, compatibility_json = ?, package_id = ?,
            moderation_note = NULL, updated_at = ?,
            published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END
      WHERE id = ? AND author_id = ?`,
  )
    .bind(
      status,
      validated.manifest.version,
      JSON.stringify(validated.manifest.compatibility),
      validated.manifest.packageId,
      now,
      status,
      now,
      id,
      viewer.id,
    )
    .run();

  if (status === "published") {
    await notifyFollowersOfUpdate(env, viewer.id, id, row.title, validated.manifest.version);
  }
  await notify(env, {
    userId: viewer.id,
    type: "post_review",
    payload: {
      title: row.title,
      status,
      version: validated.manifest.version,
      message: status === "pending_review" ? "新版本已提交审核" : "新版本已发布",
    },
  });

  return ok({
    post: (await loadPost(env, id, viewer)).post,
    version: validated.manifest.version,
    message: status === "pending_review" ? "新版本已提交审核" : "新版本已发布",
  });
}

export async function notifyFollowersOfUpdate(env, authorId, postId, title, version) {
  const followers = await env.DB.prepare("SELECT follower_id FROM community_follows WHERE following_id = ? LIMIT 200")
    .bind(authorId)
    .all();
  for (const row of followers.results || []) {
    await notify(env, {
      userId: row.follower_id,
      type: "post_update",
      actorId: authorId,
      postId,
      payload: { title, version },
    });
  }
}

/* ============================================================
   浏览 / 点赞 / 收藏
   ============================================================ */

export async function viewPost({ env, session, id }) {
  const viewer = await viewerContext(env, session);
  const { post } = await loadPost(env, id, viewer);
  if (post.status !== "published") return ok({ viewCount: post.viewCount, counted: false });
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("UPDATE community_posts SET view_count = view_count + 1 WHERE id = ?").bind(id),
    env.DB.prepare(
      `INSERT INTO community_view_daily (post_id, day, views) VALUES (?, ?, 1)
       ON CONFLICT (post_id, day) DO UPDATE SET views = views + 1`,
    ).bind(id, day),
  ]);
  return ok({ viewCount: post.viewCount + 1, counted: true });
}

export async function likePost({ env, session, viewer, id }) {
  const { post } = await loadPost(env, id, viewer);
  if (post.status !== "published") bad("只有已发布的作品可以点赞");
  if (post.author.id === viewer.id) bad("不能给自己的作品点赞");
  await env.DB.prepare(
    "INSERT INTO community_likes (id, user_id, post_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, post_id) DO NOTHING",
  )
    .bind(crypto.randomUUID(), viewer.id, id, Date.now())
    .run();
  await recomputePostCounters(env, id);
  const row = await env.DB.prepare("SELECT like_count FROM community_posts WHERE id = ?").bind(id).first();
  return ok({ liked: true, likeCount: Number(row?.like_count || 0) });
}

export async function unlikePost({ env, session, viewer, id }) {
  const { post } = await loadPost(env, id, viewer);
  await env.DB.prepare("DELETE FROM community_likes WHERE user_id = ? AND post_id = ?").bind(viewer.id, id).run();
  await recomputePostCounters(env, id);
  const row = await env.DB.prepare("SELECT like_count FROM community_posts WHERE id = ?").bind(id).first();
  return ok({ liked: false, likeCount: Number(row?.like_count || 0), postId: post.id });
}

export async function favoritePost({ env, request, session, viewer, id }) {
  const { post } = await loadPost(env, id, viewer);
  if (post.status !== "published") bad("只有已发布的作品可以收藏");
  const body = await readJson(request, 8 * 1024).catch(() => ({}));
  const collection = cleanText(body?.collection ?? "default", 32, { allowNewline: false }) || "default";
  await env.DB.prepare(
    `INSERT INTO community_favorites (id, user_id, post_id, collection, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, post_id) DO UPDATE SET collection = excluded.collection`,
  )
    .bind(crypto.randomUUID(), viewer.id, id, collection, Date.now())
    .run();
  await recomputePostCounters(env, id);
  const row = await env.DB.prepare("SELECT favorite_count FROM community_posts WHERE id = ?").bind(id).first();
  return ok({ favorited: true, favoriteCount: Number(row?.favorite_count || 0), collection });
}

export async function unfavoritePost({ env, session, viewer, id }) {
  await loadPost(env, id, viewer);
  await env.DB.prepare("DELETE FROM community_favorites WHERE user_id = ? AND post_id = ?").bind(viewer.id, id).run();
  await recomputePostCounters(env, id);
  const row = await env.DB.prepare("SELECT favorite_count FROM community_posts WHERE id = ?").bind(id).first();
  return ok({ favorited: false, favoriteCount: Number(row?.favorite_count || 0) });
}

/* ============================================================
   评论
   ============================================================ */

const COMMENT_BLOCKLIST = [
  "加微信", "加vx", "免费领取", "日赚", "博彩", "赌场", "代开发票", "办证",
  "刷单", "返利", "私聊出售", "vx：", "vx:",
];

function filterComment(raw) {
  let text = cleanText(raw, 1000);
  if (!text) bad("评论不能为空");
  text = text.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
  if (/(.)\1{11,}/.test(text)) bad("评论包含过多重复字符", "COMMENT_SPAM");
  const links = text.match(/https?:\/\//gi) || [];
  if (links.length > 2) bad("评论中最多允许 2 个链接", "COMMENT_SPAM");
  const lower = text.toLowerCase();
  if (COMMENT_BLOCKLIST.some((word) => lower.includes(word))) {
    bad("评论包含疑似垃圾广告内容", "COMMENT_BLOCKED");
  }
  return text;
}

export async function createComment({ env, request, session, viewer, id }) {
  await assertCommentAllowed(env, viewer.id);
  const settings = await getSettings(env);
  const { post } = await loadPost(env, id, viewer);
  if (post.status !== "published") bad("只有已发布的作品可以评论");
  await assertCommentQuota(env, viewer.id, Number(settings.max_comments_per_day));

  const body = await readJson(request, 16 * 1024);
  const content = filterComment(body?.content);
  const parentId = body?.parentId ? String(body.parentId) : null;
  let parent = null;
  if (parentId) {
    if (!UUID.test(parentId)) bad("回复目标不合法");
    parent = await env.DB.prepare("SELECT * FROM community_comments WHERE id = ? AND post_id = ? AND status = 'visible'")
      .bind(parentId, id)
      .first();
    if (!parent) bad("要回复的评论不存在");
    if (parent.parent_id) bad("第一版只支持两层评论，请回复一级评论");
  }

  const commentId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_comments (id, user_id, post_id, parent_id, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'visible', ?, ?)`,
  )
    .bind(commentId, viewer.id, id, parentId, content, now, now)
    .run();
  await recomputePostCounters(env, id);

  const profile = await ensureProfile(env, session.user);
  const targetAuthor = parent ? parent.user_id : post.author.id;
  if (targetAuthor !== viewer.id) {
    await notify(env, {
      userId: targetAuthor,
      type: parent ? "reply" : "comment",
      actorId: viewer.id,
      postId: id,
      commentId,
      payload: { postTitle: post.title, excerpt: content.slice(0, 120) },
    });
  }
  if (parent && post.author.id !== targetAuthor && post.author.id !== viewer.id) {
    await notify(env, {
      userId: post.author.id,
      type: "comment",
      actorId: viewer.id,
      postId: id,
      commentId,
      payload: { postTitle: post.title, excerpt: content.slice(0, 120) },
    });
  }

  const countRow = await env.DB.prepare("SELECT comment_count FROM community_posts WHERE id = ?").bind(id).first();
  return ok(
    {
      comment: {
        id: commentId,
        postId: id,
        parentId,
        content,
        status: "visible",
        canDelete: true,
        author: {
          id: viewer.id,
          displayName: profile.display_name,
          avatarUrl: profile.avatar_asset_id ? `/api/community/media/${profile.avatar_asset_id}` : null,
          role: viewer.role,
        },
        createdAt: now,
        updatedAt: now,
        replies: [],
      },
      commentCount: Number(countRow?.comment_count || 0),
    },
    { status: 201 },
  );
}

export async function deleteComment({ env, viewer, id }) {
  const row = await env.DB.prepare("SELECT * FROM community_comments WHERE id = ?").bind(id).first();
  if (!row) throw new ApiError("NOT_FOUND", "评论不存在", 404);
  const isAuthor = row.user_id === viewer.id;
  if (!isAuthor && !viewer.staff) throw new ApiError("FORBIDDEN", "只能删除自己的评论", 403);
  if (row.status === "deleted") return ok({ deleted: true });
  await env.DB.prepare("UPDATE community_comments SET status = 'deleted', content = '', updated_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run();
  await recomputePostCounters(env, row.post_id);
  if (!isAuthor) {
    await audit(env, {
      actorId: viewer.id,
      action: "comment.hide_by_staff",
      targetType: "comment",
      targetId: id,
      detail: { postId: row.post_id, authorId: row.user_id },
    });
  }
  const countRow = await env.DB.prepare("SELECT comment_count FROM community_posts WHERE id = ?").bind(row.post_id).first();
  return ok({ deleted: true, commentCount: Number(countRow?.comment_count || 0) });
}

/* ============================================================
   举报 / 关注
   ============================================================ */

const REPORT_REASONS = ["copyright", "malicious", "inappropriate", "spam", "impersonation", "harassment", "other"];

export async function createReport({ env, request, viewer, fixedTarget = null }) {
  const body = await readJson(request, 16 * 1024);
  const targetType = fixedTarget?.type ?? String(body?.targetType ?? "");
  const targetId = fixedTarget?.id ?? String(body?.targetId ?? "");
  if (!["post", "comment", "profile"].includes(targetType)) bad("举报对象不合法");
  if (!UUID.test(targetId)) bad("举报对象不合法");
  const reason = String(body?.reason ?? "");
  if (!REPORT_REASONS.includes(reason)) bad("请选择举报原因");
  const description = cleanText(body?.description ?? "", 1000);
  if (reason === "other" && description.length < 4) bad("请补充说明举报原因");

  if (targetType === "post") {
    const { post } = await loadPost(env, targetId, viewer);
    if (post.author.id === viewer.id) bad("不能举报自己的作品");
  } else if (targetType === "comment") {
    const comment = await env.DB.prepare(
      "SELECT c.*, p.status AS post_status FROM community_comments c JOIN community_posts p ON p.id = c.post_id WHERE c.id = ?",
    )
      .bind(targetId)
      .first();
    if (!comment || comment.status === "deleted" || comment.post_status !== "published") {
      throw new ApiError("NOT_FOUND", "评论不存在", 404);
    }
    if (comment.user_id === viewer.id) bad("不能举报自己的评论");
  } else {
    const target = await getCreatorRow(env, targetId);
    if (!target || target.status !== "active") throw new ApiError("NOT_FOUND", "用户不存在", 404);
    if (target.id === viewer.id) bad("不能举报自己");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO community_reports
         (id, reporter_id, target_type, target_id, reason, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(crypto.randomUUID(), viewer.id, targetType, targetId, reason, description, Date.now())
      .run();
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE")) {
      throw new ApiError("ALREADY_REPORTED", "你已经举报过这个对象，管理员会尽快处理", 409);
    }
    throw error;
  }
  return ok({ reported: true, message: "举报已提交，管理员会尽快处理" }, { status: 201 });
}

export async function followCreator({ env, session, viewer, targetId }) {
  if (!UUID.test(targetId)) throw new ApiError("NOT_FOUND", "创作者不存在", 404);
  if (targetId === viewer.id) bad("不能关注自己");
  const target = await getCreatorRow(env, targetId);
  if (!target || target.status !== "active") throw new ApiError("NOT_FOUND", "创作者不存在", 404);
  const targetUser = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
  const profile = targetUser ? await ensureProfile(env, targetUser) : null;
  if (profile?.visibility === "private") bad("该创作者将主页设为私密，暂不能关注");
  const inserted = await env.DB.prepare(
    "INSERT INTO community_follows (follower_id, following_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(viewer.id, targetId, Date.now())
    .run();
  if (Number(inserted.meta?.changes ?? 0) === 1) {
    await notify(env, {
      userId: targetId,
      type: "follow",
      actorId: viewer.id,
      payload: { displayName: viewer.user?.display_name || "一位创作者" },
    });
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM community_follows WHERE following_id = ?").bind(targetId).first();
  return ok({ following: true, followerCount: Number(count?.total || 0) });
}

export async function unfollowCreator({ env, viewer, targetId }) {
  await env.DB.prepare("DELETE FROM community_follows WHERE follower_id = ? AND following_id = ?")
    .bind(viewer.id, targetId)
    .run();
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM community_follows WHERE following_id = ?").bind(targetId).first();
  return ok({ following: false, followerCount: Number(count?.total || 0) });
}

/* ============================================================
   我的
   ============================================================ */

export async function myCreations({ env, viewer, url }) {
  const page = pageParams(url);
  const status = String(url.searchParams.get("status") || "all");
  const type = String(url.searchParams.get("type") || "");
  const sort = String(url.searchParams.get("sort") || "updated");
  const allowedStatuses = ["draft", "pending_review", "published", "hidden", "rejected"];
  const statuses = status === "all" ? allowedStatuses : [allowedStatuses.includes(status) ? status : "draft"];

  const result = await listPosts(env, {
    viewerId: viewer.id,
    authorId: viewer.id,
    statuses,
    type: POST_TYPES.includes(type) ? type : null,
    sort: ["updated", "newest", "popular", "downloads", "likes"].includes(sort) ? sort : "updated",
    publicOnly: false,
    limit: page.limit,
    offset: page.offset,
  });

  const ids = result.items.map((item) => item.id);
  let extra = new Map();
  if (ids.length) {
    const rows = await env.DB.prepare(
      `SELECT id, moderation_note, rights_confirmed FROM community_posts WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .all();
    extra = new Map((rows.results || []).map((row) => [row.id, row]));
  }
  const items = result.items.map((item) => ({
    ...item,
    moderationNote: extra.get(item.id)?.moderation_note || "",
    rightsConfirmed: Boolean(extra.get(item.id)?.rights_confirmed),
  }));

  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS total FROM community_posts WHERE author_id = ? AND status <> 'deleted' GROUP BY status",
  )
    .bind(viewer.id)
    .all();
  const byStatus = {};
  for (const row of counts.results || []) byStatus[row.status] = Number(row.total);

  return ok({
    items,
    total: result.total,
    byStatus,
    page: page.page,
    limit: page.limit,
    hasMore: page.offset + items.length < result.total,
  });
}

export async function myFavorites({ env, viewer, url }) {
  const page = pageParams(url);
  const collection = String(url.searchParams.get("collection") || "").slice(0, 32) || null;
  const items = await listFavorites(env, viewer.id, { collection, limit: page.limit, offset: page.offset });
  return ok({ items, collections: await listFavoriteCollections(env, viewer.id), page: page.page, limit: page.limit });
}

export async function myFavoriteCollections({ env, viewer }) {
  return ok({ collections: await listFavoriteCollections(env, viewer.id) });
}

export async function myProfileGet({ env, session, viewer }) {
  const profile = await ensureProfile(env, session.user);
  const stats = await creatorStats(env, viewer.id);
  const usage = await userUsage(env, viewer.id);
  return ok({
    profile: {
      id: viewer.id,
      displayName: profile.display_name,
      bio: profile.bio || "",
      creatorTitle: profile.creator_title || "",
      avatarUrl: profile.avatar_asset_id ? `/api/community/media/${profile.avatar_asset_id}` : null,
      coverUrl: profile.cover_asset_id ? `/api/community/media/${profile.cover_asset_id}` : null,
      visibility: profile.visibility,
      restriction: profile.restriction || "none",
      createdAt: Number(profile.created_at),
      role: viewer.role,
    },
    stats,
    usage,
  });
}

export async function myProfilePatch({ env, request, session, viewer }) {
  const body = await readJson(request, 32 * 1024);
  const profile = await ensureProfile(env, session.user);
  const updates = [];
  const binds = [];

  if (body.displayName !== undefined) {
    const displayName = cleanText(body.displayName, 40, { required: true, allowNewline: false });
    updates.push("display_name = ?");
    binds.push(displayName);
    await env.DB.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
      .bind(displayName, Date.now(), viewer.id)
      .run();
  }
  if (body.bio !== undefined) {
    updates.push("bio = ?");
    binds.push(cleanText(body.bio, 600));
  }
  if (body.creatorTitle !== undefined) {
    updates.push("creator_title = ?");
    binds.push(cleanText(body.creatorTitle, 40, { allowNewline: false }));
  }
  if (body.visibility !== undefined) {
    if (!["public", "private"].includes(body.visibility)) bad("公开范围不合法");
    updates.push("visibility = ?");
    binds.push(body.visibility);
  }
  if (body.avatarAssetId !== undefined) {
    const asset = body.avatarAssetId ? await resolveAsset(env, viewer.id, body.avatarAssetId, ["avatar"]) : null;
    updates.push("avatar_asset_id = ?");
    binds.push(asset?.id || null);
  }
  if (body.coverAssetId !== undefined) {
    const asset = body.coverAssetId ? await resolveAsset(env, viewer.id, body.coverAssetId, ["cover"]) : null;
    updates.push("cover_asset_id = ?");
    binds.push(asset?.id || null);
  }
  if (!updates.length) return ok({ profile: null, unchanged: true });
  updates.push("updated_at = ?");
  binds.push(Date.now());
  await env.DB.prepare(`UPDATE community_profiles SET ${updates.join(", ")} WHERE user_id = ?`)
    .bind(...binds, viewer.id)
    .run();
  const updated = await env.DB.prepare("SELECT * FROM community_profiles WHERE user_id = ?").bind(viewer.id).first();
  return ok({
    profile: {
      id: viewer.id,
      displayName: updated.display_name,
      bio: updated.bio || "",
      creatorTitle: updated.creator_title || "",
      avatarUrl: updated.avatar_asset_id ? `/api/community/media/${updated.avatar_asset_id}` : null,
      coverUrl: updated.cover_asset_id ? `/api/community/media/${updated.cover_asset_id}` : null,
      visibility: updated.visibility,
    },
    message: "创作者资料已更新",
  });
}

export async function myNotifications({ env, viewer, url }) {
  const page = pageParams(url, { defaultLimit: 30, maxLimit: 60 });
  const items = await listNotifications(env, viewer.id, { limit: page.limit, offset: page.offset });
  return ok({
    items,
    unread: await unreadNotificationCount(env, viewer.id),
    page: page.page,
    limit: page.limit,
  });
}

export async function markNotifications({ env, request, viewer }) {
  const body = await readJson(request, 16 * 1024).catch(() => ({}));
  const now = Date.now();
  if (body?.all) {
    await env.DB.prepare("UPDATE community_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
      .bind(now, viewer.id)
      .run();
  } else if (Array.isArray(body?.ids) && body.ids.length) {
    const ids = body.ids.filter((id) => UUID.test(String(id))).slice(0, 100);
    if (!ids.length) return ok({ unread: await unreadNotificationCount(env, viewer.id) });
    await env.DB.prepare(
      `UPDATE community_notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(now, viewer.id, ...ids)
      .run();
  }
  return ok({ unread: await unreadNotificationCount(env, viewer.id) });
}

export async function myUsage({ env, viewer }) {
  const settings = await getSettings(env);
  return ok({
    usage: await userUsage(env, viewer.id),
    limits: {
      maxUserStorageBytes: Number(settings?.max_user_storage_bytes || 0),
      maxPackagesPerUser: Number(settings?.max_packages_per_user || 0),
      maxPostsPerDay: Number(settings?.max_posts_per_day || 0),
      maxCommentsPerDay: Number(settings?.max_comments_per_day || 0),
      maxUploadBytes: Number(settings?.max_upload_bytes || 0),
    },
  });
}

export async function listFollowingFeed({ env, viewer, url }) {
  const page = pageParams(url);
  const result = await listPosts(env, {
    viewerId: viewer.id,
    followingOf: viewer.id,
    sort: "latest",
    limit: page.limit,
    offset: page.offset,
  });
  return ok({
    ...result,
    page: page.page,
    limit: page.limit,
    hasMore: page.offset + result.items.length < result.total,
  });
}
