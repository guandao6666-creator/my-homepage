/**
 * Guandao OS 1.7 · 开发者中心接口（/api/developer/*）
 *
 * 开发者只能操作自己名下的插件：所有查询都带 developer_id = Session.user.id，
 * 客户端提交的任何 developer_id 都会被忽略。
 */

import { ApiError, ok } from "../http.js";
import { randomToken } from "../auth/crypto.js";
import {
  assertSameOrigin,
  assertPublishingAllowed,
  audit,
  ensureDeveloperProfile,
  readJson,
  requireSession,
  sessionOrNull,
  viewerContext,
} from "./common.js";
import {
  LICENSES,
  PLUGIN_CATEGORIES,
  PLUGIN_LIMITS,
  PLUGIN_TYPE_META,
  OS_VERSION,
  SDK_VERSION,
  compareSemver,
  isPluginId,
  isSemver,
} from "./spec.js";
import { inspectBundle } from "./spec.js";
import {
  getAnyPluginRaw,
  getOwnedPlugin,
  getVersionRow,
  listDeveloperPlugins,
  latestApprovedVersion,
  mapVersion,
  recomputePluginCounters,
  safeParse,
} from "./store.js";
import {
  listKeysForUser,
  registerPublisherKey,
  resolveSignature,
  revokePublisherKey,
  storeVersionSignature,
} from "./signature.js";

const PREFIX = "/api/developer";

export async function handleDeveloperRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  if (!env?.DB) throw new ApiError("SERVICE_UNAVAILABLE", "插件数据库尚未配置", 503);

  const method = request.method;
  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const parts = rest ? rest.split("/") : [];
  const session = await sessionOrNull(env, request);
  const viewer = await viewerContext(env, session);

  if (method !== "GET" && method !== "HEAD") assertSameOrigin(request, env);

  /* 公开信息：开发者主页可以匿名访问 */
  if (parts[0] === "creators" && parts[1] && method === "GET") {
    return developerPublicPage({ env, userId: decodeURIComponent(parts[1]) });
  }

  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);

  if (parts.length === 1 && parts[0] === "profile") {
    if (method === "GET") return developerProfile({ env, session });
    if (method === "PATCH") return updateProfile({ request, env, session });
  }

  if (parts.length === 1 && parts[0] === "plugins") {
    if (method === "GET") {
      const items = await listDeveloperPlugins(env, session.user.id);
      return ok({
        items,
        limits: {
          maxPlugins: 20,
          bundleBytes: PLUGIN_LIMITS.bundleBytes,
          files: PLUGIN_LIMITS.files,
          installed: PLUGIN_LIMITS.installedPlugins,
        },
        viewer,
      });
    }
    if (method === "POST") return createPlugin({ request, env, session });
  }

  if (parts.length === 2 && parts[0] === "plugins" && method === "PATCH") {
    return updatePlugin({ request, env, session, id: decodeURIComponent(parts[1]) });
  }
  if (parts.length === 2 && parts[0] === "plugins" && method === "DELETE") {
    return deleteDraft({ env, session, id: decodeURIComponent(parts[1]) });
  }
  if (parts.length === 3 && parts[0] === "plugins" && parts[2] === "versions" && method === "POST") {
    return uploadVersion({ request, env, session, id: decodeURIComponent(parts[1]) });
  }
  if (parts.length === 3 && parts[0] === "plugins" && parts[2] === "submit" && method === "POST") {
    return submitForReview({ env, session, id: decodeURIComponent(parts[1]) });
  }
  if (parts.length === 3 && parts[0] === "plugins" && parts[2] === "withdraw" && method === "POST") {
    return withdraw({ env, session, id: decodeURIComponent(parts[1]) });
  }

  /* 发布者签名密钥：只管理公钥，私钥永不经过服务端 */
  if (parts.length === 1 && parts[0] === "keys") {
    if (method === "GET") {
      const keys = await listKeysForUser(env, session.user.id);
      return ok({ keys, algorithm: "ed25519", keyIdPrefix: "ggk_" });
    }
    if (method === "POST") return registerKey({ request, env, session });
  }
  if (parts.length === 3 && parts[0] === "keys" && parts[2] === "revoke" && method === "POST") {
    return revokeKey({ request, env, session, keyId: decodeURIComponent(parts[1]) });
  }

  throw new ApiError("NOT_FOUND", "接口不存在", 404);
}

/* ============================================================
   发布者签名密钥
   ============================================================ */

/**
 * 登记公钥。
 *
 * 私钥永远只存在于发布者本机：请求体里只有 publicKey + 一个用私钥签出来的
 * 「持有证明」（proof）。服务端验完证明就丢掉 proof，D1 里只有公钥。
 */
async function registerKey({ request, env, session }) {
  const body = (await readJson(request, 16 * 1024)) ?? {};
  const key = await registerPublisherKey(env, {
    userId: session.user.id,
    publicKey: body.publicKey,
    keyId: body.keyId,
    issuedAt: body.issuedAt,
    proof: body.proof,
    label: body.label,
  });
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.key_register",
    detail: { keyId: key.keyId, algorithm: key.algorithm },
  });
  return ok({ key });
}

async function revokeKey({ request, env, session, keyId }) {
  const body = (await readJson(request, 4 * 1024).catch(() => ({}))) ?? {};
  const key = await revokePublisherKey(env, { userId: session.user.id, keyId, reason: body.reason });
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.key_revoke",
    detail: { keyId: key.keyId },
  });
  return ok({ key });
}

/* ============================================================
   资料
   ============================================================ */

async function developerStats(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
       SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending,
       COALESCE(SUM(download_count), 0) AS downloads,
       COALESCE(SUM(install_count), 0) AS installs,
       COALESCE(SUM(rating_count), 0) AS ratings
     FROM plugins WHERE developer_id = ? AND status != 'deleted'`,
  )
    .bind(userId)
    .first();
  return {
    total: Number(row?.total || 0),
    published: Number(row?.published || 0),
    pending: Number(row?.pending || 0),
    downloads: Number(row?.downloads || 0),
    installs: Number(row?.installs || 0),
    ratings: Number(row?.ratings || 0),
  };
}

async function developerProfile({ env, session }) {
  const profile = await ensureDeveloperProfile(env, session.user.id);
  return ok({
    profile: {
      id: profile.user_id,
      displayName: profile.display_name,
      bio: profile.bio,
      website: profile.website,
      createdAt: Number(profile.created_at),
      updatedAt: Number(profile.updated_at),
    },
    stats: await developerStats(env, session.user.id),
    osVersion: OS_VERSION,
    sdkVersion: SDK_VERSION,
    limits: {
      maxPlugins: 20,
      types: PLUGIN_TYPE_META,
      categories: PLUGIN_CATEGORIES,
      licenses: LICENSES,
    },
  });
}

async function updateProfile({ request, env, session }) {
  const body = await readJson(request, 8 * 1024);
  const displayName = String(body.displayName ?? "").trim().slice(0, 40);
  if (displayName.length < 1) throw new ApiError("INVALID_NAME", "展示名称不能为空", 400);
  const bio = String(body.bio ?? "").trim().slice(0, 600);
  const website = String(body.website ?? "").trim().slice(0, 300);
  if (website) {
    try {
      if (new URL(website).protocol !== "https:") throw new Error("https");
    } catch {
      throw new ApiError("INVALID_WEBSITE", "主页地址必须是完整的 https URL", 400);
    }
  }
  await ensureDeveloperProfile(env, session.user.id);
  await env.DB.prepare(
    "UPDATE developer_profiles SET display_name = ?, bio = ?, website = ?, updated_at = ? WHERE user_id = ?",
  )
    .bind(displayName, bio, website, Date.now(), session.user.id)
    .run();
  return ok({ ok: true, profile: { displayName, bio, website } });
}

async function developerPublicPage({ env, userId }) {
  const profile = await env.DB.prepare(
    `SELECT dp.*, cp.avatar_asset_id AS avatar_asset_id
       FROM developer_profiles dp
       LEFT JOIN community_profiles cp ON cp.user_id = dp.user_id
      WHERE dp.user_id = ?`,
  )
    .bind(userId)
    .first();
  if (!profile) throw new ApiError("NOT_FOUND", "开发者不存在", 404);
  const rows = await env.DB.prepare(
    `SELECT id, name, description, type, category, download_count, install_count, rating_sum, rating_count
       FROM plugins WHERE developer_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 50`,
  )
    .bind(userId)
    .all();
  return ok({
    developer: {
      id: profile.user_id,
      name: profile.display_name,
      bio: profile.bio,
      website: profile.website,
      avatarUrl: profile.avatar_asset_id ? `/api/community/media/${profile.avatar_asset_id}` : null,
      joinedAt: Number(profile.created_at),
    },
    plugins: (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      category: row.category,
      downloads: Number(row.download_count),
      installs: Number(row.install_count),
      rating: {
        average: Number(row.rating_count) ? Math.round((Number(row.rating_sum) / Number(row.rating_count)) * 10) / 10 : 0,
        count: Number(row.rating_count),
      },
    })),
  });
}

/* ============================================================
   插件草稿
   ============================================================ */

async function createPlugin({ request, env, session }) {
  const body = await readJson(request, 16 * 1024);
  const id = String(body.id ?? "").trim();
  if (!isPluginId(id)) throw new ApiError("INVALID_ID", "插件 ID 必须是反向域名，例如 com.example.tool", 400);
  const existing = await getAnyPluginRaw(env, id);
  if (existing) throw new ApiError("ID_TAKEN", "这个插件 ID 已被占用，请换一个", 409);

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM plugins WHERE developer_id = ? AND status != 'deleted'")
    .bind(session.user.id)
    .first();
  if (Number(count?.n || 0) >= 20) throw new ApiError("PLUGIN_LIMIT", "最多创建 20 个插件", 409);

  const name = String(body.name ?? "").trim().slice(0, 48);
  if (name.length < 2) throw new ApiError("INVALID_NAME", "名称至少 2 个字符", 400);
  const type = String(body.type ?? "");
  if (!PLUGIN_TYPE_META[type]) throw new ApiError("INVALID_TYPE", "插件类型不合法", 400);
  const category = String(body.category ?? "other");
  if (!PLUGIN_CATEGORIES.includes(category)) throw new ApiError("INVALID_CATEGORY", "分类不合法", 400);
  const description = String(body.description ?? "").trim().slice(0, 2000);
  const license = String(body.license ?? "MIT");
  if (!LICENSES.includes(license)) throw new ApiError("INVALID_LICENSE", "许可证不合法", 400);

  await ensureDeveloperProfile(env, session.user.id);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO plugins
       (id, developer_id, name, description, type, category, license, status,
        download_count, install_count, rating_sum, rating_count, report_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, 0, 0, 0, 0, ?, ?)`,
  )
    .bind(id, session.user.id, name, description, type, category, license, now, now)
    .run();
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.create",
    pluginId: id,
    detail: { type, category },
  });
  return ok({ plugin: { id, name, type, category, status: "draft", description, license } });
}

async function updatePlugin({ request, env, session, id }) {
  const row = await getOwnedPlugin(env, id, session.user.id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (row.status === "blocked") throw new ApiError("PLUGIN_BLOCKED", "插件已被下架，不能编辑", 409);

  const body = await readJson(request, 16 * 1024);
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 48);
    if (name.length < 2) throw new ApiError("INVALID_NAME", "名称至少 2 个字符", 400);
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, 2000);
  if (body.category !== undefined) {
    if (!PLUGIN_CATEGORIES.includes(String(body.category))) {
      throw new ApiError("INVALID_CATEGORY", "分类不合法", 400);
    }
    patch.category = String(body.category);
  }
  if (body.license !== undefined) {
    if (!LICENSES.includes(String(body.license))) throw new ApiError("INVALID_LICENSE", "许可证不合法", 400);
    patch.license = String(body.license);
  }
  if (!Object.keys(patch).length) throw new ApiError("NO_CHANGES", "没有需要保存的字段", 400);

  const keys = Object.keys(patch);
  await env.DB.prepare(
    `UPDATE plugins SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  )
    .bind(...keys.map((key) => patch[key]), Date.now(), id)
    .run();
  return ok({ ok: true, plugin: { ...patch, id } });
}

async function deleteDraft({ env, session, id }) {
  const row = await getOwnedPlugin(env, id, session.user.id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (row.status === "published" || row.status === "blocked") {
    throw new ApiError("CANNOT_DELETE", "已发布或被下架的插件不能删除，请先联系管理员", 409);
  }
  const approved = await latestApprovedVersion(env, id);
  if (approved) throw new ApiError("CANNOT_DELETE", "这个插件有已审核版本，只能下架不能删除", 409);
  await env.DB.prepare("UPDATE plugins SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(Date.now(), Date.now(), id)
    .run();
  await audit(env, { actorId: session.user.id, action: "plugin.delete_draft", pluginId: id });
  return ok({ ok: true });
}

/* ============================================================
   版本上传
   ============================================================ */

async function uploadVersion({ request, env, session, id }) {
  const row = await getOwnedPlugin(env, id, session.user.id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (row.status === "blocked") throw new ApiError("PLUGIN_BLOCKED", "插件已被下架，不能上传新版本", 409);
  if (!env.FILES) throw new ApiError("SERVICE_UNAVAILABLE", "R2 存储尚未配置", 503);

  const body = await readJson(request, 6 * 1024 * 1024);
  const raw = typeof body.bundle === "string" ? body.bundle : "";
  if (!raw) throw new ApiError("BUNDLE_REQUIRED", "缺少插件包", 400);
  if (new TextEncoder().encode(raw).byteLength > PLUGIN_LIMITS.bundleBytes) {
    throw new ApiError("BUNDLE_TOO_LARGE", `插件包不能超过 ${Math.round(PLUGIN_LIMITS.bundleBytes / 1024 / 1024)} MB`, 413);
  }

  const inspected = await inspectBundle(raw, { expectedId: id, expectedType: row.type });
  if (!inspected.ok) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "BUNDLE_INVALID",
          message: "插件包没有通过校验",
          issues: inspected.errors.slice(0, 20),
        },
      }),
      { status: 422, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const manifest = inspected.manifest;

  /**
   * 发布者签名（阶段 A：可选）。
   *   - 没有签名 → unsigned，允许上传，但市场与安装界面必须标注信任状态；
   *   - 有签名但验不过 → invalid，直接拒绝，绝不「降级成无签名继续装」。
   * 签名既可以放在 body.signature，也可以直接嵌在插件包顶层（CLI 默认内嵌）。
   */
  const signatureInput = body.signature ?? inspected.bundle?.signature ?? null;
  const verification = await resolveSignature(env, {
    bundle: inspected.bundle,
    signature: signatureInput,
    plugin: { id, developer_id: row.developer_id },
    version: manifest.version,
  });
  if (verification.status === "invalid") {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "SIGNATURE_INVALID",
          message: verification.message || "插件签名没有通过验证",
          signatureCode: verification.code,
          issues: (verification.errors ?? []).slice(0, 20),
        },
      }),
      { status: 422, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const existing = await getVersionRow(env, id);
  if (existing) {
    if (existing.version === manifest.version) {
      throw new ApiError("VERSION_EXISTS", `版本 ${manifest.version} 已上传过，请修改版本号`, 409);
    }
    if (compareSemver(manifest.version, existing.version) <= 0) {
      throw new ApiError("VERSION_NOT_NEWER", `新版本必须高于 ${existing.version}`, 409);
    }
  }

  const changelog = String(body.changelog ?? manifest.changelog ?? "").trim().slice(0, 4000);
  const packageKey = `plugins/${id}/${manifest.version}/package.json`;

  await env.FILES.put(packageKey, raw, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      pluginId: id,
      version: manifest.version,
      sha256: inspected.packageDigest,
      filesDigest: inspected.filesDigest,
    },
  });

  // 图标：从同一份插件包里取出，存成独立对象，市场列表不必下载整包。
  let iconKey = row.icon_key ?? null;
  let iconMime = row.icon_mime ?? null;
  if (manifest.icon) {
    const file = inspected.files.find((item) => item.path.toLowerCase() === manifest.icon.toLowerCase());
    if (file) {
      const bytes = fileBytes(file);
      if (bytes.byteLength <= 256 * 1024) {
        const ext = manifest.icon.split(".").pop().toLowerCase();
        iconKey = `plugins/${id}/icon.${ext}`;
        iconMime = iconMimeFor(ext);
        await env.FILES.put(iconKey, bytes, {
          httpMetadata: { contentType: iconMime },
          customMetadata: { pluginId: id, version: manifest.version },
        });
      }
    }
  }

  const now = Date.now();
  const versionId = `pv-${randomToken(10)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO plugin_versions
         (id, plugin_id, version, changelog, manifest_json, package_key, package_sha256,
          size_bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      versionId,
      id,
      manifest.version,
      changelog,
      JSON.stringify(manifest),
      packageKey,
      inspected.packageDigest,
      new TextEncoder().encode(raw).byteLength,
      now,
    ),
    env.DB.prepare(
      `UPDATE plugins SET latest_version = ?, latest_manifest_json = ?, permissions_json = ?,
         compatibility_json = ?, icon_key = ?, icon_mime = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      manifest.version,
      JSON.stringify(manifest),
      JSON.stringify(manifest.permissions ?? []),
      JSON.stringify(manifest.compatibility ?? {}),
      iconKey,
      iconMime,
      now,
      id,
    ),
  ]);

  await storeVersionSignature(env, { versionId, verification });

  await audit(env, {
    actorId: session.user.id,
    action: "plugin.version_upload",
    pluginId: id,
    detail: {
      version: manifest.version,
      sizeBytes: new TextEncoder().encode(raw).byteLength,
      permissions: manifest.permissions,
      filesDigest: inspected.filesDigest,
      signatureStatus: verification.status,
      signatureKeyId: verification.keyId ?? null,
    },
  });

  return ok({
    version: {
      id: versionId,
      version: manifest.version,
      status: "pending",
      sizeBytes: new TextEncoder().encode(raw).byteLength,
      checksum: inspected.packageDigest,
      filesDigest: inspected.filesDigest,
      permissions: manifest.permissions,
      warnings: inspected.warnings,
      signature: {
        status: verification.status,
        keyId: verification.keyId ?? null,
        signedAt: verification.signedAt ?? null,
        code: verification.code ?? null,
      },
    },
    pluginStatus: row.status,
  });
}

function fileBytes(file) {
  if (file.encoding === "base64") {
    const binary = atob(String(file.content).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(String(file.content));
}

function iconMimeFor(ext) {
  return { svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] ?? "image/png";
}

/* ============================================================
   提交 / 撤回
   ============================================================ */

async function submitForReview({ env, session, id }) {
  const row = await getOwnedPlugin(env, id, session.user.id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  if (row.status === "blocked") throw new ApiError("PLUGIN_BLOCKED", "插件已被下架", 409);
  if (row.status === "pending_review") throw new ApiError("ALREADY_PENDING", "这个插件已经在审核队列里", 409);
  await assertPublishingAllowed(env, session.user.id);

  const version = await getVersionRow(env, id);
  if (!version) throw new ApiError("NO_VERSION", "请先上传一个插件包", 409);
  if (version.status === "approved") throw new ApiError("NOTHING_TO_SUBMIT", "当前版本已经审核通过", 409);

  const now = Date.now();
  const nextStatus = row.status === "published" ? "published" : "pending_review";
  await env.DB.batch([
    env.DB.prepare("UPDATE plugin_versions SET status = 'pending', review_note = NULL WHERE id = ?").bind(version.id),
    env.DB.prepare("UPDATE plugins SET status = ?, moderation_note = NULL, updated_at = ? WHERE id = ?")
      .bind(nextStatus, now, id),
  ]);
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.submit",
    pluginId: id,
    detail: { version: version.version, pluginStatus: nextStatus },
  });
  return ok({ ok: true, status: nextStatus, version: version.version });
}

async function withdraw({ env, session, id }) {
  const row = await getOwnedPlugin(env, id, session.user.id);
  if (!row) throw new ApiError("NOT_FOUND", "插件不存在", 404);
  const version = await getVersionRow(env, id);
  if (!version || version.status !== "pending") {
    throw new ApiError("NOTHING_TO_WITHDRAW", "当前没有待审核的版本", 409);
  }
  const nextStatus = row.status === "published" ? "published" : "draft";
  await env.DB.batch([
    env.DB.prepare("UPDATE plugin_versions SET status = 'rejected', review_note = '作者撤回' WHERE id = ?").bind(version.id),
    env.DB.prepare("UPDATE plugins SET status = ?, updated_at = ? WHERE id = ?").bind(nextStatus, Date.now(), id),
  ]);
  await audit(env, {
    actorId: session.user.id,
    action: "plugin.withdraw",
    pluginId: id,
    detail: { version: version.version },
  });
  return ok({ ok: true, status: nextStatus });
}
