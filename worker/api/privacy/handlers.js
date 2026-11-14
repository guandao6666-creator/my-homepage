/**
 * /api/privacy/* 与 /api/security/*。
 *
 * 所有路由都要求有效 Session；user_id 只从 Session 获取。
 * 导出、删除、注销都是可重入任务：每一步重新校验归属，失败可重试。
 */

import { ApiError, ok, json } from "../http.js";
import { assertSameOrigin, readJson } from "../guards.js";
import { authConfig } from "../auth/config.js";
import { inspectSession } from "../auth/session.js";
import { REAUTH_COOKIE, clearSessionCookie, getCookie } from "../auth/cookies.js";
import { consumeReauthTicket, getReauthTicket } from "../auth/store.js";
import { handleDevicesRequest } from "../devices/handlers.js";
import {
  createZipStream,
  deleteBackupPrefix,
  readJsonObject,
  writeJsonObject,
} from "../backups/archive.js";
import { hashStream, sha256Hex } from "../backups/crypto.js";
import { publicRateLimitRules, rateLimitStats } from "../ratelimit.js";
import { logSecurityEvent, pruneSecurityEvents } from "./events.js";
import {
  activeDeletion,
  activeExport,
  completeDeletionAudit,
  createDeletionAudit,
  createDeletionJob,
  createExport,
  createExportJob,
  dataInventory,
  getDeletionJob,
  getExport,
  getLatestExportJob,
  getPrivacySettings,
  listDeletions,
  listExports,
  listSecurityEvents,
  mapDeletionJob,
  mapExport,
  mapExportJob,
  markUserPendingDeletion,
  parse,
  savePrivacySettings,
  updateDeletionJob,
  updateExport,
  updateExportJob,
} from "./store.js";

const PREFIX_PRIVACY = "/api/privacy";
const PREFIX_SECURITY = "/api/security";
const EXPORT_TTL_MS = 7 * 24 * 3600 * 1000;
const TIME_BUDGET_MS = 18_000;

export async function handlePrivacyRequest({ request, env, url, path }) {
  if (
    path !== PREFIX_PRIVACY &&
    !path.startsWith(`${PREFIX_PRIVACY}/`) &&
    path !== PREFIX_SECURITY &&
    !path.startsWith(`${PREFIX_SECURITY}/`)
  ) {
    return null;
  }

  const isSecurity = path === PREFIX_SECURITY || path.startsWith(`${PREFIX_SECURITY}/`);
  const base = isSecurity ? PREFIX_SECURITY : PREFIX_PRIVACY;
  const rest = path.slice(base.length).replace(/^\/+/, "");
  const segments = rest ? rest.split("/") : [];
  const method = request.method;

  const inspected = await inspectSession(env, request);
  if (inspected.state !== "active" && inspected.state !== "pending_deletion") {
    throw new ApiError("UNAUTHENTICATED", "请先登录", 401);
  }

  const userId = inspected.user.id;
  const user = inspected.user;
  const pending = inspected.state === "pending_deletion";

  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(request, authConfig(env, request).origin);
  }

  /* ------------------------------ 安全中心 ------------------------------ */
  if (isSecurity) {
    if (segments.length === 1 && segments[0] === "activity" && method === "GET") {
      const result = await listSecurityEvents(env, userId, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        type: url.searchParams.get("type"),
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        result: url.searchParams.get("result"),
      });
      return ok(result);
    }

    if (segments.length === 1 && segments[0] === "overview" && method === "GET") {
      return overviewHandler(env, request, user, userId);
    }

    if (segments.length === 1 && segments[0] === "sessions" && method === "GET") {
      return handleDevicesRequest({ request, env, url, path: "/api/devices/sessions" });
    }

    if (segments.length === 3 && segments[0] === "sessions" && segments[2] === "revoke" && method === "POST") {
      return handleDevicesRequest({
        request,
        env,
        url,
        path: `/api/devices/sessions/${encodeURIComponent(segments[1])}/revoke`,
      });
    }

    return null;
  }

  /* ------------------------------ 隐私接口 ------------------------------ */
  if (segments.length === 1 && segments[0] === "overview" && method === "GET") {
    return overviewHandler(env, request, user, userId);
  }

  if (segments.length === 1 && segments[0] === "data-inventory" && method === "GET") {
    if (pending) throw new ApiError("ACCOUNT_PENDING_DELETION", "账号正在删除中", 409);
    return ok({ inventory: await dataInventory(env, userId) });
  }

  if (segments.length === 1 && segments[0] === "settings") {
    if (pending) throw new ApiError("ACCOUNT_PENDING_DELETION", "账号正在删除中", 409);
    if (method === "GET") {
      return ok({ settings: await getPrivacySettings(env, userId) });
    }
    if (method === "PUT") return settingsHandler(env, request, userId);
  }

  if (segments.length === 1 && segments[0] === "exports" && method === "GET") {
    return ok({ exports: await listExports(env, userId, Number(url.searchParams.get("limit") || 20)) });
  }

  if (segments.length === 1 && segments[0] === "export" && method === "POST") {
    if (pending) throw new ApiError("ACCOUNT_PENDING_DELETION", "账号正在删除中", 409);
    return createExportHandler(env, request, userId);
  }

  if (segments[0] === "export" && segments.length >= 2) {
    const exportRow = await getExport(env, userId, segments[1]);
    if (!exportRow) throw new ApiError("NOT_FOUND", "导出任务不存在", 404);

    if (segments.length === 2 && method === "GET") {
      const job = await getLatestExportJob(env, userId, exportRow.id);
      return ok({ export: mapExport(exportRow), job: mapExportJob(job) });
    }
    if (segments.length === 3 && segments[2] === "run" && method === "POST") {
      return ok(await runExport(env, userId, exportRow));
    }
    if (segments.length === 3 && segments[2] === "download" && method === "GET") {
      return downloadExport(env, userId, exportRow, url);
    }
  }

  if (segments.length === 1 && segments[0] === "delete-data" && method === "POST") {
    if (pending) throw new ApiError("ACCOUNT_PENDING_DELETION", "账号正在删除中", 409);
    return createDeleteDataHandler(env, request, userId);
  }

  if (segments[0] === "deletion" && segments.length >= 2) {
    const job = await getDeletionJob(env, userId, segments[1]);
    if (!job) throw new ApiError("NOT_FOUND", "删除任务不存在", 404);
    if (segments.length === 2 && method === "GET") {
      return ok({ job: mapDeletionJob(job) });
    }
    if (segments.length === 3 && segments[2] === "run" && method === "POST") {
      if (job.deletion_type === "account") {
        const result = await runAccountDeletion(
          env,
          request,
          user,
          userId,
          job,
          authConfig(env, request),
        );
        return result instanceof Response ? result : ok(result);
      }
      return ok(await runDeletion(env, request, user, userId, job));
    }
  }

  if (segments.length === 1 && segments[0] === "deletion" && method === "GET") {
    return ok({ jobs: await listDeletions(env, userId) });
  }

  if (segments.length === 1 && segments[0] === "delete-account" && method === "POST") {
    return deleteAccountHandler(env, request, user, userId);
  }

  if (segments.length === 1 && segments[0] === "local-clear" && method === "POST") {
    await logSecurityEvent(env, {
      userId,
      eventType: "local_data_cleared",
      metadata: { reason: "user_requested" },
    });
    return ok({ logged: true, note: "本地清除在设备上完成；云端数据不受影响。" });
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 概览与安全检查                                                      */
/* ------------------------------------------------------------------ */

async function overviewHandler(env, request, user, userId) {
  const inventory = await dataInventory(env, userId);
  const settings = await getPrivacySettings(env, userId);
  const origin = authConfig(env, request).origin;

  const [sessionRows, deviceRows, backupRow, events, throttle, r2] = await Promise.all([
    env.DB.prepare(
      `SELECT id, device_id, created_at, last_used_at, expires_at, revoked_at
         FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, trusted_at, revoked_at FROM devices WHERE user_id = ? LIMIT 200`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, status, size_bytes, created_at, verified_at, error_message
         FROM backups WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(userId)
      .first(),
    listSecurityEvents(env, userId, { limit: 8 }),
    rateLimitStats(env).catch(() => null),
    probeR2Privacy(env, userId),
  ]);

  const sessions = sessionRows.results || [];
  const devices = deviceRows.results || [];
  const activeSessions = sessions.filter(
    (row) => !row.revoked_at && Number(row.expires_at) > Date.now(),
  );
  const unbound = activeSessions.filter((row) => !row.device_id).length;
  const activeDevices = devices.filter((row) => !row.revoked_at);
  const untrusted = activeDevices.filter((row) => !row.trusted_at).length;

  const probes = await Promise.all([
    probeUnauth(origin, "/api/files?limit=1"),
    probeUnauth(origin, "/api/backups?limit=1"),
  ]);
  const probesKnown = probes.every((probe) => probe.reachable);
  const apiProtected = probesKnown && probes.every((probe) => probe.status === 401);

  const checks = [];

  const oauthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const appOrigin = Boolean(env.APP_ORIGIN);
  checks.push({
    id: "account_auth",
    label: "账号认证配置",
    weight: 20,
    status: oauthConfigured && appOrigin && user.github_id ? "protected" : "not_configured",
    detail: oauthConfigured
      ? user.github_id
        ? "GitHub OAuth 已配置，当前账号已绑定 GitHub 身份"
        : "OAuth 已配置，但当前账号缺少 GitHub 身份"
      : "缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET",
  });

  checks.push({
    id: "session_management",
    label: "Session 管理",
    weight: 15,
    status: activeSessions.length > 0 && unbound === 0 ? "protected" : "attention",
    detail:
      activeSessions.length === 0
        ? "没有有效 Session"
        : unbound > 0
          ? `${unbound} 个 Session 未绑定设备`
          : `${activeSessions.length} 个有效 Session，全部绑定设备`,
  });

  checks.push({
    id: "device_access",
    label: "设备访问",
    weight: 10,
    status: untrusted === 0 ? "protected" : "attention",
    detail:
      activeDevices.length === 0
        ? "没有注册设备"
        : untrusted > 0
          ? `${untrusted} 台设备尚未确认`
          : `${activeDevices.length} 台设备均已确认`,
  });

  checks.push({
    id: "api_permissions",
    label: "API 权限检查",
    weight: 20,
    status: !probesKnown ? "unknown" : apiProtected ? "protected" : "failed",
    detail: !probesKnown
      ? "无法从应用侧完成未登录探测（本地或网络受限），未标记为安全"
      : apiProtected
        ? "未携带 Session 访问 /api/files 与 /api/backups 均返回 401"
        : "检测到未登录请求没有返回 401，请立即排查",
    evidence: probes.map((probe) => `${probe.path}:${probe.reachable ? probe.status : "unreachable"}`),
  });

  const backupStatus = backupRow
    ? backupRow.status === "completed" && backupRow.verified_at
      ? Date.now() - Number(backupRow.created_at) <= 7 * 24 * 3600 * 1000
        ? "protected"
        : "attention"
      : "attention"
    : "attention";
  checks.push({
    id: "backup_integrity",
    label: "备份完整性",
    weight: 15,
    status: backupStatus,
    detail: backupRow
      ? backupRow.status === "completed" && backupRow.verified_at
        ? `最近备份已完成并校验（${new Date(Number(backupRow.created_at)).toISOString().slice(0, 10)}）`
        : `最近备份状态：${backupRow.status}${backupRow.error_message ? `（${backupRow.error_message}）` : ""}`
      : "还没有完成过备份",
  });

  checks.push({
    id: "r2_private",
    label: "R2 私有存储",
    weight: 10,
    status: r2.status,
    detail: r2.detail,
    evidence: r2.evidence,
  });

  checks.push({
    id: "request_throttling",
    label: "请求频率限制",
    weight: 10,
    status: throttle ? "protected" : "unknown",
    detail: throttle
      ? `已启用 ${publicRateLimitRules().rules.length} 条敏感接口规则与全局 ${publicRateLimitRules().global.limit} 次/分钟上限；过去 24 小时拦截 ${throttle.blocked24h} 次（${throttle.hits} 次计入窗口）`
      : "无法读取限流计数表，未标记为安全",
    evidence: throttle
      ? [`windows=${throttle.buckets}`, `blocked24h=${throttle.blocked24h}`]
      : ["rate_limit_table=unavailable"],
  });

  const cronEnabled = env.BACKUP_CRON_ENABLED === "true" || env.BACKUP_CRON_ENABLED === true;
  checks.push({
    id: "secret_config",
    label: "Secret 配置",
    weight: 10,
    status: oauthConfigured && appOrigin ? "protected" : "attention",
    detail: `GITHUB_CLIENT_ID=${Boolean(env.GITHUB_CLIENT_ID)} · GITHUB_CLIENT_SECRET=${Boolean(
      env.GITHUB_CLIENT_SECRET,
    )} · APP_ORIGIN=${appOrigin} · BACKUP_CRON=${cronEnabled}（只返回布尔值）`,
  });

  const included = checks.filter((check) => check.status !== "unknown");
  const weightTotal = included.reduce((sum, check) => sum + check.weight, 0);
  const weightProtected = included
    .filter((check) => check.status === "protected")
    .reduce((sum, check) => sum + check.weight, 0);
  const score = weightTotal ? Math.round((weightProtected / weightTotal) * 100) : null;

  return ok({
    checkedAt: Date.now(),
    account: {
      id: user.id,
      githubUsername: user.github_username,
      displayName: user.display_name || user.github_username,
      avatarUrl: user.avatar_url,
      role: user.role,
      createdAt: Number(user.created_at || 0),
      lastLoginAt: user.last_login_at ? Number(user.last_login_at) : null,
      authProvider: "github",
      deletionState: user.deletion_state || "none",
    },
    score: {
      value: score,
      evaluatedWeight: weightTotal,
      totalWeight: checks.reduce((sum, check) => sum + check.weight, 0),
      rules:
        "仅对状态已知的检查计分：Protected 得满分，Attention / Not Configured / Check Failed 得 0；Unknown 不计入分母。权重见每项检查。",
    },
    checks,
    counts: {
      activeSessions: activeSessions.length,
      totalSessions: sessions.length,
      activeDevices: activeDevices.length,
      untrustedDevices: untrusted,
    },
    backup: backupRow
      ? {
          id: backupRow.id,
          status: backupRow.status,
          sizeBytes: Number(backupRow.size_bytes || 0),
          createdAt: Number(backupRow.created_at || 0),
          verifiedAt: backupRow.verified_at ? Number(backupRow.verified_at) : null,
        }
      : null,
    inventory,
    settings,
    rateLimits: {
      ...publicRateLimitRules(),
      blocked24h: throttle?.blocked24h ?? null,
      windows: throttle?.buckets ?? null,
      hits24h: throttle?.hits ?? null,
    },
    recentEvents: events.events,
  });
}

/**
 * R2 公网可读性探测。
 *
 * Bucket 级公网策略无法从应用侧读取，所以不默认标记为 Protected：
 * 只有配置了 R2_PUBLIC_BASE_URL 并且真的探测到 403/404 时才算 Protected；
 * 若探测到 200，说明对象可以被匿名读取，直接判为 Check Failed。
 */
async function probeR2Privacy(env, userId) {
  if (!env.FILES) {
    return { status: "not_configured", detail: "缺少 FILES 绑定" };
  }

  const base = String(env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    return {
      status: "unknown",
      detail:
        "未配置 R2_PUBLIC_BASE_URL，应用侧无法探测 Bucket 公网策略；文件目前只通过鉴权 API 提供，但这一项不标记为 Protected",
      evidence: ["probe=not_configured", "app_access=session_required"],
    };
  }

  let key = null;
  try {
    const row = await env.DB.prepare(
      "SELECT r2_key FROM files WHERE user_id = ? AND status = 'ready' LIMIT 1",
    )
      .bind(userId)
      .first();
    key = row?.r2_key || null;
  } catch {
    key = null;
  }
  if (!key) {
    return {
      status: "unknown",
      detail: "没有可用于公网探测的文件对象，无法判定 Bucket 策略",
      evidence: ["probe=no_object"],
    };
  }

  try {
    const response = await fetch(`${base}/${key}`, { method: "HEAD", redirect: "manual" });
    if (response.status === 200 || response.status === 206) {
      return {
        status: "failed",
        detail: "备份/实时对象可以通过公网地址匿名读取，请立即关闭 R2 公共访问",
        evidence: [`probe=${response.status}`],
      };
    }
    if (response.status === 403 || response.status === 404) {
      return {
        status: "protected",
        detail: "公网探测被拒绝（403/404），对象只能通过鉴权 API 读取",
        evidence: [`probe=${response.status}`],
      };
    }
    return {
      status: "unknown",
      detail: `公网探测返回 ${response.status}，无法判定`,
      evidence: [`probe=${response.status}`],
    };
  } catch {
    return {
      status: "unknown",
      detail: "公网探测失败（DNS 或网络不可达），无法判定",
      evidence: ["probe=error"],
    };
  }
}

async function probeUnauth(origin, path) {
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2500),
    });
    return { reachable: true, status: response.status, path };
  } catch {
    return { reachable: false, status: null, path };
  }
}

async function settingsHandler(env, request, userId) {
  const body = await readJson(request, 8192);
  const current = await getPrivacySettings(env, userId);
  const next = {
    cloudSync: body?.cloudSync === undefined ? current.cloudSync : Boolean(body.cloudSync),
    notes: body?.notes === undefined ? current.notes : Boolean(body.notes),
    tasks: body?.tasks === undefined ? current.tasks : Boolean(body.tasks),
    calendar: body?.calendar === undefined ? current.calendar : Boolean(body.calendar),
    desktop: body?.desktop === undefined ? current.desktop : Boolean(body.desktop),
    workspace: body?.workspace === undefined ? current.workspace : Boolean(body.workspace),
  };
  const saved = await savePrivacySettings(env, userId, next);
  await logSecurityEvent(env, {
    userId,
    eventType: "privacy_settings_changed",
    metadata: { settings: saved },
  });
  return ok({
    settings: saved,
    note: "关闭某一类型后，该类型不会上传到云端备份；本地数据保留，云端历史不会被自动删除。",
  });
}

/* ------------------------------------------------------------------ */
/* 数据导出                                                            */
/* ------------------------------------------------------------------ */

async function createExportHandler(env, request, userId) {
  const body = await readJson(request, 10 * 1024 * 1024);
  const includeFiles = body?.includeFiles !== false;
  const localSnapshot = body?.localSnapshot ?? null;
  if (localSnapshot && JSON.stringify(localSnapshot).length > 8 * 1024 * 1024) {
    throw new ApiError("SNAPSHOT_TOO_LARGE", "本地快照超过 8 MB", 413);
  }

  if (await activeExport(env, userId)) {
    throw new ApiError("EXPORT_IN_PROGRESS", "已有导出任务正在执行", 409);
  }

  const id = crypto.randomUUID();
  const prefix = `users/${userId}/exports/${id}`;
  const data = await buildExportData(env, userId, { exportId: id, localSnapshot });
  const dataMeta = await writeJsonObject(env, `${prefix}/data.json`, data);

  const files = includeFiles ? data.files : [];
  await createExport(env, {
    id,
    userId,
    exportType: includeFiles ? "full" : "metadata",
    scopes: ["account", "content", "files", "activity", "security"],
    prefix,
  });
  await updateExport(env, userId, id, { dataKey: dataMeta.key });
  await createExportJob(env, {
    id: crypto.randomUUID(),
    userId,
    exportId: id,
    total: files.length,
  });

  await logSecurityEvent(env, {
    userId,
    eventType: "data_export_started",
    metadata: { exportId: id, format: includeFiles ? "full" : "metadata" },
  });

  const exportRow = await getExport(env, userId, id);
  const job = await getLatestExportJob(env, userId, id);
  return ok(
    {
      export: mapExport(exportRow),
      job: mapExportJob(job),
      totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) },
    },
    { status: 201 },
  );
}

async function buildExportData(env, userId, { exportId, localSnapshot }) {
  const [user, devices, sessions, backups, files, folders, events, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT id, github_username, display_name, avatar_url, role, created_at, last_login_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT id, name, device_type, browser_name, os_name, created_at, last_seen_at,
              last_active_at, last_sync_at, revoked_at, trusted_at
         FROM devices WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, device_id, created_at, last_used_at, expires_at, revoked_at
         FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, backup_name, backup_type, scope, status, created_at, completed_at,
              size_bytes, item_count, file_count, checksum_sha256, verified_at
         FROM backups WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, parent_id, name, display_name, mime_type, size_bytes, sha256, etag,
              is_favorite, status, created_at, updated_at
         FROM files WHERE user_id = ? ORDER BY created_at ASC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      "SELECT id, parent_id, name, is_favorite, created_at, updated_at FROM folders WHERE user_id = ? AND deleted_at IS NULL",
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, event_type, device_id, result, metadata_json, created_at
         FROM security_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`,
    )
      .bind(userId)
      .all(),
    getPrivacySettings(env, userId),
  ]);

  return {
    schemaVersion: 1,
    exportId,
    userId,
    createdAt: Date.now(),
    generator: "Guandao Privacy Center 1.0",
    account: user
      ? {
          id: user.id,
          githubUsername: user.github_username,
          displayName: user.display_name,
          avatarUrl: user.avatar_url,
          role: user.role,
          createdAt: Number(user.created_at || 0),
          lastLoginAt: user.last_login_at ? Number(user.last_login_at) : null,
          authProvider: "github",
        }
      : null,
    devices: (devices.results || []).map((row) => ({
      id: row.id,
      name: row.name,
      type: row.device_type,
      browser: row.browser_name,
      os: row.os_name,
      createdAt: Number(row.created_at || 0),
      lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
      lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null,
      lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
      trusted: Boolean(row.trusted_at),
    })),
    sessions: (sessions.results || []).map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      createdAt: Number(row.created_at || 0),
      lastUsedAt: Number(row.last_used_at || 0),
      expiresAt: Number(row.expires_at || 0),
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    })),
    backups: (backups.results || []).map((row) => ({
      id: row.id,
      name: row.backup_name,
      type: row.backup_type,
      scope: row.scope,
      status: row.status,
      createdAt: Number(row.created_at || 0),
      completedAt: row.completed_at ? Number(row.completed_at) : null,
      sizeBytes: Number(row.size_bytes || 0),
      itemCount: Number(row.item_count || 0),
      fileCount: Number(row.file_count || 0),
      checksum: row.checksum_sha256,
      verifiedAt: row.verified_at ? Number(row.verified_at) : null,
    })),
    files: (files.results || []).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.display_name || row.name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes || 0),
      sha256: row.sha256,
      etag: row.etag,
      isFavorite: Boolean(row.is_favorite),
      status: row.status,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    })),
    folders: (folders.results || []).map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      isFavorite: Boolean(row.is_favorite),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    })),
    securityEvents: (events.results || []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      deviceId: row.device_id,
      result: row.result,
      metadata: parse(row.metadata_json, null),
      createdAt: Number(row.created_at || 0),
    })),
    privacySettings: settings,
    local: localSnapshot,
    limitations: [
      "Notes / Tasks / Calendar 是浏览器本地数据，只有本设备上传快照后才会出现在导出包中。",
      "导出不包含 Session Token、OAuth Secret、Token Hash 或任何凭证。",
    ],
  };
}

async function runExport(env, userId, exportRow) {
  if (exportRow.status === "completed") {
    return { done: true, export: mapExport(exportRow), job: null };
  }
  if (exportRow.status === "failed") {
    throw new ApiError("EXPORT_FAILED", exportRow.error_message || "导出任务失败", 409);
  }

  const started = Date.now();
  const job = await getLatestExportJob(env, userId, exportRow.id);
  if (!job) throw new ApiError("EXPORT_JOB_MISSING", "导出任务状态丢失", 409);

  const checkpoint = parse(job.checkpoint_json, null) || {
    index: 0,
    results: [],
    total: Number(job.total_items || 0),
  };
  const data = await readJsonObject(env, exportRow.data_key);
  if (!data) {
    await updateExport(env, userId, exportRow.id, { status: "failed", errorMessage: "data.json 缺失" });
    throw new ApiError("EXPORT_DATA_MISSING", "导出数据缺失", 409);
  }

  const allFiles = data.files || [];
  const prefix = exportRow.object_prefix;

  while (checkpoint.index < allFiles.length) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const file = allFiles[checkpoint.index];
    if (file.status !== "ready") {
      checkpoint.index += 1;
      continue;
    }
    const dest = `${prefix}/files/${file.id}`;
    const copied = await copyObjectSafe(env, {
      sourceKey: `users/${userId}/files/${file.id}`,
      destKey: dest,
      mimeType: file.mimeType,
    });
    if (!copied.ok) {
      await updateExport(env, userId, exportRow.id, {
        status: "failed",
        errorMessage: `文件复制失败：${file.id}`,
      });
      await updateExportJob(env, userId, job.id, {
        status: "failed",
        errorMessage: copied.error,
      });
      throw new ApiError("EXPORT_COPY_FAILED", "导出文件复制失败", 502);
    }
    checkpoint.results.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: copied.size,
      sha256: copied.sha256,
      objectKey: dest,
    });
    checkpoint.index += 1;

    await updateExportJob(env, userId, job.id, {
      processed: checkpoint.index,
      total: allFiles.length,
      progress: allFiles.length ? Math.round((checkpoint.index / allFiles.length) * 80) : 80,
      checkpoint,
    });
  }

  if (checkpoint.index < allFiles.length) {
    return {
      done: false,
      export: mapExport(await getExport(env, userId, exportRow.id)),
      job: mapExportJob(await getLatestExportJob(env, userId, exportRow.id)),
    };
  }

  // 完成：写 manifest，计算 data.json 校验值。
  const dataObject = await env.FILES.get(exportRow.data_key);
  if (!dataObject) throw new ApiError("EXPORT_DATA_MISSING", "导出数据缺失", 409);
  const dataDigest = await hashStream(dataObject.body);

  const manifest = {
    schemaVersion: 1,
    exportId: exportRow.id,
    userId,
    exportType: exportRow.export_type,
    createdAt: Number(exportRow.created_at || Date.now()),
    completedAt: Date.now(),
    dataKey: exportRow.data_key,
    dataChecksum: dataDigest.sha256,
    dataSize: dataDigest.size,
    files: checkpoint.results,
    totals: {
      fileCount: checkpoint.results.length,
      fileBytes: checkpoint.results.reduce((sum, file) => sum + file.sizeBytes, 0),
      totalBytes: dataDigest.size + checkpoint.results.reduce((sum, file) => sum + file.sizeBytes, 0),
    },
  };
  const manifestMeta = await writeJsonObject(env, `${prefix}/manifest.json`, manifest);
  const now = Date.now();

  await updateExport(env, userId, exportRow.id, {
    status: "completed",
    manifestKey: manifestMeta.key,
    sizeBytes: manifest.totals.totalBytes,
    fileCount: checkpoint.results.length,
    checksum: manifestMeta.sha256,
    completedAt: now,
    expiresAt: now + EXPORT_TTL_MS,
  });
  await updateExportJob(env, userId, job.id, {
    status: "completed",
    stage: "completed",
    progress: 100,
    completedAt: now,
  });
  await logSecurityEvent(env, {
    userId,
    eventType: "data_export_completed",
    metadata: { exportId: exportRow.id, count: checkpoint.results.length },
  });

  return {
    done: true,
    export: mapExport(await getExport(env, userId, exportRow.id)),
    job: mapExportJob(await getLatestExportJob(env, userId, exportRow.id)),
  };
}

async function copyObjectSafe(env, options) {
  try {
    const object = await env.FILES.get(options.sourceKey);
    if (!object) return { ok: false, error: "SOURCE_MISSING" };
    const [hashBranch, writeBranch] = object.body.tee();
    const hashPromise = hashStream(hashBranch);
    await env.FILES.put(options.destKey, writeBranch, {
      httpMetadata: { contentType: options.mimeType || "application/octet-stream" },
    });
    const digest = await hashPromise;
    return { ok: true, size: digest.size, sha256: digest.sha256 };
  } catch {
    return { ok: false, error: "COPY_FAILED" };
  }
}

async function downloadExport(env, userId, exportRow, url) {
  if (exportRow.status !== "completed") throw new ApiError("NOT_READY", "导出尚未完成", 409);
  if (exportRow.expires_at && Number(exportRow.expires_at) < Date.now()) {
    throw new ApiError("EXPORT_EXPIRED", "导出已过期，请重新创建", 410);
  }

  const manifest = await readJsonObject(env, exportRow.manifest_key);
  const data = await readJsonObject(env, exportRow.data_key);
  if (!manifest || !data) throw new ApiError("EXPORT_BROKEN", "导出内容缺失", 409);

  const ascii = `guandao-export-${exportRow.id.slice(0, 8)}`;

  if (url.searchParams.get("format") !== "zip") {
    const body = JSON.stringify({ manifest, data, checksum: manifest.dataChecksum }, null, 2);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${ascii}.json"`,
        "cache-control": "no-store",
      },
    });
  }

  const entries = [
    { name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: "data.json", open: async () => (await env.FILES.get(exportRow.data_key)).body },
    ...(manifest.files || []).map((file) => ({
      name: `files/${file.id}-${String(file.name || "file").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")}`,
      open: async () => (await env.FILES.get(file.objectKey)).body,
    })),
    {
      name: "checksums.txt",
      bytes: new TextEncoder().encode(
        [
          `data_sha256=${manifest.dataChecksum}`,
          ...(manifest.files || []).map((file) => `${file.id}=${file.sha256}`),
          "",
        ].join("\n"),
      ),
    },
  ];

  return new Response(createZipStream(entries), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${ascii}.zip"`,
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ */
/* 数据删除                                                            */
/* ------------------------------------------------------------------ */

async function createDeleteDataHandler(env, request, userId) {
  const body = await readJson(request, 8192);
  if (body?.confirm !== "DELETE") {
    throw new ApiError("CONFIRM_REQUIRED", "请输入 DELETE 以确认删除", 400);
  }
  const targets = Array.isArray(body?.targets)
    ? body.targets.filter((item) => ["files", "backups", "exports"].includes(item))
    : [];
  if (!targets.length) throw new ApiError("NO_TARGETS", "请选择要删除的数据类型", 400);

  if (await activeDeletion(env, userId)) {
    throw new ApiError("DELETION_IN_PROGRESS", "已有删除任务正在执行", 409);
  }

  const activeBackup = await env.DB.prepare(
    `SELECT id FROM backups WHERE user_id = ? AND deleted_at IS NULL
      AND status IN ('collecting', 'uploading', 'verifying') LIMIT 1`,
  )
    .bind(userId)
    .first();
  if (activeBackup) throw new ApiError("BACKUP_RUNNING", "备份正在执行，暂不能删除云端数据", 409);

  const jobId = crypto.randomUUID();
  const type = targets.length === 1 ? targets[0] : "content";
  await createDeletionJob(env, {
    id: jobId,
    userId,
    type,
    stage: "files",
    total: 0,
    checkpoint: { targets, filesDone: 0, backupsDone: 0, exportsDone: 0 },
  });
  await logSecurityEvent(env, {
    userId,
    eventType: "data_deletion_started",
    metadata: { jobId, targets },
  });

  const job = await getDeletionJob(env, userId, jobId);
  return ok(await runDeletion(env, request, { id: userId }, userId, job));
}

async function runDeletion(env, request, user, userId, job) {
  if (job.deletion_type === "account") {
    throw new ApiError("ACCOUNT_JOB", "账号注销任务不能走数据删除流程", 409);
  }
  if (job.status === "completed" || job.status === "failed") {
    return { job: mapDeletionJob(job) };
  }

  const started = Date.now();
  const checkpoint = parse(job.checkpoint_json, null) || {
    targets: ["files"],
    filesDone: 0,
    backupsDone: 0,
    exportsDone: 0,
  };
  const targets = checkpoint.targets || [];
  let stage = job.current_stage || "files";
  let progress = Number(job.progress_percent || 0);
  let processed = Number(job.processed_items || 0);

  try {
    if (stage === "files") {
      if (targets.includes("files")) {
        const rows = await env.DB.prepare(
          "SELECT id, r2_key FROM files WHERE user_id = ? LIMIT 30",
        )
          .bind(userId)
          .all();
        const files = rows.results || [];

        for (const file of files) {
          if (Date.now() - started > TIME_BUDGET_MS) break;
          try {
            await env.FILES.delete(file.r2_key);
          } catch {
            await env.DB.prepare(
              "UPDATE files SET status = 'pending_delete' WHERE id = ? AND user_id = ?",
            )
              .bind(file.id, userId)
              .run();
            throw new ApiError("R2_DELETE_FAILED", "R2 文件删除失败，已保留待清理状态", 502);
          }
          await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?")
            .bind(file.id, userId)
            .run();
          checkpoint.filesDone += 1;
          processed += 1;
        }

        if (files.length) {
          await updateDeletionJob(env, userId, job.id, {
            stage: "files",
            progress: Math.min(40, 10 + checkpoint.filesDone * 5),
            processed,
            checkpoint,
          });
          return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
        }

        // 文件夹元数据随后清理（不影响 R2）。
        await env.DB.prepare("DELETE FROM folders WHERE user_id = ?").bind(userId).run();
      }
      stage = "backups";
      progress = 45;
      await updateDeletionJob(env, userId, job.id, { stage, progress, checkpoint });
    }

    if (stage === "backups") {
      if (targets.includes("backups")) {
        const rows = await env.DB.prepare(
          "SELECT id FROM backups WHERE user_id = ? AND deleted_at IS NULL LIMIT 8",
        )
          .bind(userId)
          .all();
        const backups = rows.results || [];

        for (const backup of backups) {
          if (Date.now() - started > TIME_BUDGET_MS) break;
          await deleteBackupPrefix(env, `users/${userId}/backups/${backup.id}`);
          await env.DB.batch([
            env.DB.prepare("DELETE FROM backup_items WHERE user_id = ? AND backup_id = ?").bind(
              userId,
              backup.id,
            ),
            env.DB.prepare("DELETE FROM backup_jobs WHERE user_id = ? AND backup_id = ?").bind(
              userId,
              backup.id,
            ),
            env.DB.prepare("DELETE FROM backups WHERE user_id = ? AND id = ?").bind(userId, backup.id),
          ]);
          checkpoint.backupsDone += 1;
          processed += 1;
        }

        if (backups.length) {
          await updateDeletionJob(env, userId, job.id, {
            stage: "backups",
            progress: Math.min(75, 45 + checkpoint.backupsDone * 4),
            processed,
            checkpoint,
          });
          return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
        }
      }
      stage = "exports";
      progress = 80;
      await updateDeletionJob(env, userId, job.id, { stage, progress, checkpoint });
    }

    if (stage === "exports") {
      if (targets.includes("exports")) {
        const rows = await env.DB.prepare(
          "SELECT id, object_prefix FROM data_exports WHERE user_id = ? LIMIT 10",
        )
          .bind(userId)
          .all();
        const exports = rows.results || [];
        for (const item of exports) {
          await deleteBackupPrefix(env, item.object_prefix);
          await env.DB.batch([
            env.DB.prepare("DELETE FROM data_export_jobs WHERE user_id = ? AND export_id = ?").bind(
              userId,
              item.id,
            ),
            env.DB.prepare("DELETE FROM data_exports WHERE user_id = ? AND id = ?").bind(userId, item.id),
          ]);
        }
        if (exports.length) {
          return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
        }
      }
      stage = "completed";
    }

    const now = Date.now();
    await updateDeletionJob(env, userId, job.id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      processed,
      completedAt: now,
      checkpoint,
    });
    await logSecurityEvent(env, {
      userId,
      eventType: "data_deletion_completed",
      metadata: { jobId: job.id, targets, count: processed },
    });
    return { done: true, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError("DELETE_FAILED", "删除失败", 500);
    await updateDeletionJob(env, userId, job.id, {
      status: "failed",
      errorCode: apiError.code,
      errorMessage: apiError.message,
      checkpoint,
    });
    throw apiError;
  }
}

/* ------------------------------------------------------------------ */
/* 账号注销                                                            */
/* ------------------------------------------------------------------ */

async function deleteAccountHandler(env, request, user, userId) {
  // 2.0 数据事故后的纵深防御：会话用户与目标 userId 必须一致。
  if (!user?.id || user.id !== userId) {
    throw new ApiError("FORBIDDEN", "身份不匹配，拒绝注销", 403);
  }
  const body = await readJson(request, 8192);
  if (body?.confirm !== "DELETE MY ACCOUNT") {
    throw new ApiError("CONFIRM_REQUIRED", "请输入 DELETE MY ACCOUNT 以确认注销", 400);
  }
  if (body?.acknowledgeBackups !== true) {
    throw new ApiError("ACK_REQUIRED", "必须确认历史备份也会被删除", 400);
  }

  const config = authConfig(env, request);
  const ticketToken = getCookie(request, REAUTH_COOKIE);
  if (!ticketToken) throw new ApiError("REAUTH_REQUIRED", "请先通过 GitHub 重新验证身份", 403);
  const ticket = await getReauthTicket(env, ticketToken);
  if (!ticket || ticket.user_id !== userId) {
    throw new ApiError("REAUTH_REQUIRED", "重新验证已过期，请重新验证", 403);
  }
  await consumeReauthTicket(env, ticket.id);

  if (await activeDeletion(env, userId)) {
    throw new ApiError("DELETION_IN_PROGRESS", "已有删除任务正在执行", 409);
  }
  if (await activeExport(env, userId)) {
    throw new ApiError("EXPORT_RUNNING", "导出任务正在执行，请等待完成", 409);
  }
  const activeBackup = await env.DB.prepare(
    `SELECT id FROM backups WHERE user_id = ? AND deleted_at IS NULL
      AND status IN ('collecting', 'uploading', 'verifying') LIMIT 1`,
  )
    .bind(userId)
    .first();
  if (activeBackup) throw new ApiError("BACKUP_RUNNING", "备份正在执行，请等待完成", 409);

  await markUserPendingDeletion(env, userId);
  const auditId = await createDeletionAudit(env, userId, ["pending", "files", "backups", "account"]);

  const jobId = crypto.randomUUID();
  await createDeletionJob(env, {
    id: jobId,
    userId,
    type: "account",
    stage: "files",
    total: 0,
    checkpoint: { account: true, auditId, filesDone: 0, backupsDone: 0, exportsDone: 0 },
  });
  await logSecurityEvent(env, {
    userId,
    eventType: "account_deletion_started",
    metadata: { jobId, reason: "user_requested" },
  });

  const job = await getDeletionJob(env, userId, jobId);
  const result = await runAccountDeletion(env, request, user, userId, job, config);
  return result instanceof Response ? result : ok(result);
}

async function runAccountDeletion(env, request, user, userId, job, config) {
  if (job.status === "completed") throw new ApiError("ACCOUNT_DELETED", "账号已删除", 410);
  if (job.status === "failed") {
    throw new ApiError("DELETION_FAILED", job.error_message || "删除任务失败", 409);
  }

  const started = Date.now();
  const checkpoint = parse(job.checkpoint_json, null) || { account: true };
  let stage = job.current_stage || "files";
  let processed = Number(job.processed_items || 0);

  try {
    if (stage === "files") {
      const rows = await env.DB.prepare("SELECT id, r2_key FROM files WHERE user_id = ? LIMIT 40")
        .bind(userId)
        .all();
      const files = rows.results || [];
      for (const file of files) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        try {
          await env.FILES.delete(file.r2_key);
        } catch {
          await env.DB.prepare(
            "UPDATE files SET status = 'pending_delete' WHERE id = ? AND user_id = ?",
          )
            .bind(file.id, userId)
            .run();
          throw new ApiError("R2_DELETE_FAILED", "R2 文件删除失败，账号仍处于待删除", 502);
        }
        await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").bind(file.id, userId).run();
        processed += 1;
      }
      if (files.length) {
        await updateDeletionJob(env, userId, job.id, {
          stage: "files",
          progress: Math.min(35, 5 + processed * 3),
          processed,
          checkpoint,
        });
        return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
      }
      await env.DB.prepare("DELETE FROM folders WHERE user_id = ?").bind(userId).run();
      stage = "backups";
      await updateDeletionJob(env, userId, job.id, { stage, progress: 40, processed, checkpoint });
    }

    if (stage === "backups") {
      const rows = await env.DB.prepare("SELECT id FROM backups WHERE user_id = ? LIMIT 10")
        .bind(userId)
        .all();
      const backups = rows.results || [];
      for (const backup of backups) {
        await deleteBackupPrefix(env, `users/${userId}/backups/${backup.id}`);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM backup_items WHERE user_id = ? AND backup_id = ?").bind(
            userId,
            backup.id,
          ),
          env.DB.prepare("DELETE FROM backup_jobs WHERE user_id = ? AND backup_id = ?").bind(
            userId,
            backup.id,
          ),
          env.DB.prepare("DELETE FROM backups WHERE user_id = ? AND id = ?").bind(userId, backup.id),
        ]);
        processed += 1;
      }
      if (backups.length) {
        await updateDeletionJob(env, userId, job.id, {
          stage: "backups",
          progress: Math.min(70, 40 + processed * 2),
          processed,
          checkpoint,
        });
        return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
      }
      stage = "exports";
      await updateDeletionJob(env, userId, job.id, { stage, progress: 75, processed, checkpoint });
    }

    if (stage === "exports") {
      const rows = await env.DB.prepare(
        "SELECT id, object_prefix FROM data_exports WHERE user_id = ? LIMIT 10",
      )
        .bind(userId)
        .all();
      const exports = rows.results || [];
      for (const item of exports) {
        await deleteBackupPrefix(env, item.object_prefix);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM data_export_jobs WHERE user_id = ? AND export_id = ?").bind(
            userId,
            item.id,
          ),
          env.DB.prepare("DELETE FROM data_exports WHERE user_id = ? AND id = ?").bind(userId, item.id),
        ]);
      }
      if (exports.length) {
        return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
      }
      stage = "account";
    }

    // 账号阶段：清理剩余 R2 前缀，保留最小化审计，然后删除 users 行。
    //
    // 2.0：这里原先对 5 个前缀全部 `.catch(() => undefined)` —— R2 抖动一下就会
    // 留下孤儿对象，而且删完 users 行之后再也无法重试。现在改成：
    //   - 逐个前缀记录失败；
    //   - 失败就带着 checkpoint 返回（下次轮询继续重试，最多 5 次）；
    //   - 5 次仍失败才继续删账号，并写一条明确的安全事件，不假装清理干净。
    stage = "account";
    const r2Prefixes = [
      `users/${userId}/files`,
      `users/${userId}/backups`,
      `users/${userId}/exports`,
      // 1.6：社区头像、封面、预览、壁纸与内容包全部位于该前缀下
      `users/${userId}/community`,
    ];
    const r2Failures = [];
    for (const prefix of r2Prefixes) {
      try {
        await deleteBackupPrefix(env, prefix);
      } catch {
        r2Failures.push(prefix);
      }
    }
    if (r2Failures.length) {
      const attempts = Number(checkpoint.r2Attempts || 0) + 1;
      if (attempts < 5) {
        await logSecurityEvent(env, {
          userId,
          eventType: "account_deletion_r2_retry",
          metadata: { prefixes: r2Failures, attempt: attempts },
        });
        await updateDeletionJob(env, userId, job.id, {
          stage,
          progress: 90,
          processed,
          checkpoint: { ...checkpoint, r2Failures, r2Attempts: attempts },
        });
        return { done: false, job: mapDeletionJob(await getDeletionJob(env, userId, job.id)) };
      }
      // 重试耗尽：明确记录哪些前缀没删掉，再做最小化删除
      await logSecurityEvent(env, {
        userId,
        eventType: "account_deletion_r2_incomplete",
        metadata: { prefixes: r2Failures, attempts },
      });
    }

    // 2.0 数据事故后的纵深防御：
    // - 没有删除审计就不允许删 users（保证可追溯）；
    // - 只删除 deletion_state='pending' 的账号，且必须恰好影响 1 行；
    // - 审计在 users 删除成功后才标记完成，失败时保持 pending。
    if (!checkpoint.auditId) {
      throw new ApiError("AUDIT_REQUIRED", "删除审计缺失，已中止账号删除", 500);
    }
    await logSecurityEvent(env, {
      userId,
      eventType: "account_deletion_completed",
      metadata: { reason: "user_requested", count: processed },
    });
    const deleted = await env.DB.prepare(
      "DELETE FROM users WHERE id = ? AND deletion_state = 'pending'",
    )
      .bind(userId)
      .run();
    if (Number(deleted?.meta?.changes ?? 0) !== 1) {
      throw new ApiError("ACCOUNT_DELETE_CONFLICT", "账号状态已变化，未删除任何账号", 409);
    }
    await completeDeletionAudit(env, checkpoint.auditId, ["files", "backups", "account"]);

    const response = ok({
      accountDeleted: true,
      note: "账号、Session、设备、文件与历史备份已删除；仅保留不含个人内容的删除审计。",
    });
    response.headers.append("set-cookie", clearSessionCookie(config.origin));
    response.headers.append(
      "set-cookie",
      `${REAUTH_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax${
        config.origin.startsWith("https://") ? "; Secure" : ""
      }`,
    );
    return response;
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError("ACCOUNT_DELETE_FAILED", "注销失败", 500);
    await updateDeletionJob(env, userId, job.id, {
      status: "failed",
      errorCode: apiError.code,
      errorMessage: apiError.message,
      checkpoint,
    });
    await logSecurityEvent(env, {
      userId,
      eventType: "account_deletion_failed",
      result: "failure",
      metadata: { code: apiError.code, stage },
    });
    throw apiError;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/* 工具：JSON 读取与同源校验统一走 guards.js（2.0） */

export { pruneSecurityEvents };

/** Cron 清理：过期导出包与超期安全日志。 */
export async function runPrivacyCleanup(env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT id, object_prefix FROM data_exports WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 20",
  )
    .bind(now)
    .all();

  for (const item of rows.results || []) {
    await deleteBackupPrefix(env, item.object_prefix).catch(() => undefined);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM data_export_jobs WHERE export_id = ?").bind(item.id),
      env.DB.prepare("DELETE FROM data_exports WHERE id = ?").bind(item.id),
    ]);
  }

  await env.DB.prepare("DELETE FROM security_events WHERE created_at < ?")
    .bind(now - 180 * 24 * 3600 * 1000)
    .run();

  // 限流窗口行只保留 24 小时，避免 rate_limits 无限增长。
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(now - 24 * 3600 * 1000)
    .run();

  return { expiredExports: (rows.results || []).length };
}

/**
 * Cron 续跑：把「已经没有人轮询」的删除 / 注销任务继续执行完。
 *
 * 这一步是账号注销能真正落地的关键：用户关掉页面后，前端不会再发
 * /run 请求；如果只依赖浏览器，账号会永远停在 pending_deletion。
 * 这里只接管 90 秒内没有任何更新的任务，避免和用户正在进行的操作抢写。
 */
export async function runDeletionMaintenance(env) {
  const now = Date.now();
  const stale = now - 90_000;

  const rows = await env.DB.prepare(
    `SELECT id, user_id, deletion_type FROM data_deletion_jobs
      WHERE status IN ('running', 'queued') AND updated_at < ?
      ORDER BY created_at ASC LIMIT 3`,
  )
    .bind(stale)
    .all();

  const results = [];
  for (const row of rows.results || []) {
    const deadline = Date.now() + 20_000;
    try {
      let job = await getDeletionJob(env, row.user_id, row.id);
      if (!job) continue;

      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
        .bind(row.user_id)
        .first();

      if (job.deletion_type === "account" && !user) {
        // 用户行已删除但任务没来得及收尾：直接补完成状态，不再重复执行删除。
        await updateDeletionJob(env, row.user_id, job.id, {
          status: "completed",
          stage: "account",
          progress: 100,
          completedAt: Date.now(),
        });
        results.push({ id: job.id, status: "completed", note: "user_row_already_deleted" });
        continue;
      }

      let finished = false;
      let status = job.status;
      // 单次 /run 只推进一个阶段就返回 done:false；这里在同一 Cron 内连续推进，
      // 避免「一个阶段等 15 分钟」把注销拖成几小时。
      for (let round = 0; round < 6; round += 1) {
        const outcome =
          job.deletion_type === "account"
            ? await runAccountDeletion(env, null, user, row.user_id, job, {
                origin: env.APP_ORIGIN || "https://guandao.xin",
              })
            : await runDeletion(env, null, user, row.user_id, job);

        finished = outcome instanceof Response || outcome?.done === true;
        if (finished) {
          status = "completed";
          break;
        }

        status = outcome?.job?.status ?? "running";
        if (status === "completed" || status === "failed") {
          finished = status === "completed";
          break;
        }
        if (Date.now() > deadline) break;

        const next = await getDeletionJob(env, row.user_id, job.id);
        if (!next) {
          // 账号阶段删掉 users 行后，任务行会随外键级联消失。
          finished = true;
          status = "completed";
          break;
        }
        job = next;
      }

      results.push({ id: job.id, type: job.deletion_type, done: finished, status });
    } catch (error) {
      console.error(`[privacy] resume deletion ${row.id} failed:`, error?.message ?? error);
      results.push({ id: row.id, status: "error", errorCode: error?.code ?? "RESUME_FAILED" });
    }
  }

  return { resumed: results.length, results };
}
