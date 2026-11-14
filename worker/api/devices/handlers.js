/**
 * /api/devices/* 业务处理。
 *
 * 统一规则：
 *   - 每个分支都要求有效 Session，user_id 只从 Session 取，绝不接受客户端传入；
 *   - 设备 ID 来自 URL 时，必须同时匹配 user_id，否则返回 404；
 *   - 所有写操作校验同源，防 CSRF；
 *   - 任何响应都不包含 token、token_hash、client secret 或内部凭证。
 */

import { ApiError, ok } from "../http.js";
import { assertSameOrigin, readJsonLimited, sessionFailure } from "../guards.js";
import { authConfig } from "../auth/config.js";
import { inspectSession } from "../auth/session.js";
import { clearSessionCookie } from "../auth/cookies.js";
import { logSecurityEvent } from "../privacy/events.js";
import {
  ALERT_WINDOW_MS,
  DEVICE_TYPES,
  ONLINE_WINDOW_MS,
  SYNC_STALE_MS,
  derivePresence,
  logActivity,
  publicDevice,
} from "./model.js";
import {
  driveStats,
  getDeviceRow,
  listActivity,
  listDeviceRows,
  listSessionRows,
  listSyncRows,
  markDeviceSeen,
  pendingSyncRequests,
  publicSession,
  queueSyncRequest,
  revokeAllSessions,
  revokeDevice,
  revokeSessionById,
  revokeSessionsExcept,
  touchDeviceSync,
  writeSyncState,
} from "./store.js";

const PREFIX = "/api/devices";
const CLOUD_DOMAINS = new Set(["drive"]);
const LOCAL_DOMAINS = new Set(["notes", "tasks", "calendar"]);

export async function handleDevicesRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const segments = rest ? rest.split("/") : [];
  const method = request.method;

  const inspected = await inspectSession(env, request);
  if (!inspected.session) {
    throw sessionFailure(inspected.state);
  }

  const userId = inspected.user.id;
  const sessionId = inspected.session.id;
  const currentDeviceId = inspected.session.deviceId;

  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(request, authConfig(env, request).origin);
  }

  /* ------------------------------ 集合 ------------------------------ */
  if (segments.length === 0 && method === "GET") {
    return overviewHandler(env, { userId, sessionId, currentDeviceId, user: inspected.user });
  }

  if (segments.length === 1) {
    switch (segments[0]) {
      case "register":
        if (method === "POST") {
          return registerHandler(env, request, { userId, sessionId, deviceId: currentDeviceId });
        }
        break;
      case "current":
        if (method === "GET") return currentHandler(env, { userId, sessionId, deviceId: currentDeviceId });
        break;
      case "heartbeat":
        if (method === "POST") return heartbeatHandler(env, request, { userId, deviceId: currentDeviceId });
        break;
      case "revoke-others":
        if (method === "POST") return revokeOthersHandler(env, { userId, sessionId });
        break;
      case "revoke-all":
        if (method === "POST") return revokeAllHandler(env, request, { userId, sessionId });
        break;
      case "sync-report":
        if (method === "POST") return syncReportHandler(env, request, { userId, deviceId: currentDeviceId });
        break;
      case "activity":
        if (method === "GET") return activityHandler(env, url, { userId, deviceId: null });
        break;
      case "sessions":
        if (method === "GET") {
          const rows = await listSessionRows(env, userId, { now: Date.now() });
          return ok({
            sessions: rows.map((row) => publicSession(row, sessionId)),
            currentDeviceId,
          });
        }
        break;
      default:
        break;
    }
  }

  /* --------------------------- 会话级撤销 --------------------------- */
  if (segments.length === 3 && segments[0] === "sessions" && segments[2] === "revoke") {
    if (method === "POST") {
      return revokeSessionHandler(env, { userId, sessionId, targetSessionId: segments[1] });
    }
  }

  /* --------------------------- 单设备操作 --------------------------- */
  if (segments.length >= 1) {
    const deviceId = segments[0];
    const device = await getDeviceRow(env, userId, deviceId);
    if (!device) throw new ApiError("NOT_FOUND", "设备不存在", 404);

    if (segments.length === 1) {
      if (method === "GET") return deviceDetailHandler(env, { userId, sessionId, currentDeviceId, device });
      if (method === "PATCH") return renameHandler(env, request, { userId, device, currentDeviceId });
    }

    if (segments.length === 2) {
      const action = segments[1];
      if (action === "sessions" && method === "GET") {
        return ok({
          sessions: await buildSessions(env, userId, device.id, sessionId),
          deviceId: device.id,
          currentDeviceId,
        });
      }
      if (action === "revoke" && method === "POST") {
        return revokeDeviceHandler(env, { userId, device, currentDeviceId, sessionId });
      }
      if (action === "trust" && method === "POST") {
        return trustHandler(env, { userId, device, currentDeviceId });
      }
      if (action === "sync-request" && method === "POST") {
        return syncRequestHandler(env, request, { userId, device, currentDeviceId });
      }
      if (action === "activity" && method === "GET") {
        return activityHandler(env, url, { userId, deviceId: device.id });
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

async function overviewHandler(env, { userId, sessionId, currentDeviceId, user }) {
  const now = Date.now();
  const [rows, syncRows, sessions, drive] = await Promise.all([
    listDeviceRows(env, userId, now),
    listSyncRows(env, userId),
    listSessionRows(env, userId, { now }),
    driveStats(env, userId),
  ]);

  const syncByDevice = new Map();
  for (const row of syncRows) {
    const list = syncByDevice.get(row.device_id) ?? [];
    list.push(row);
    syncByDevice.set(row.device_id, list);
  }

  const devices = rows.map((row) =>
    publicDevice(row, {
      currentDeviceId,
      now,
      syncRows: syncByDevice.get(row.id) ?? [],
    }),
  );

  const activeDevices = devices.filter((device) => device.status === "active");
  const activeSessions = sessions.filter(
    (session) => !session.revoked_at && Number(session.expires_at) > now,
  );

  const lastActivityAt = devices.reduce((max, device) => {
    const value = device.lastActiveAt || device.lastSeenAt || device.createdAt || 0;
    return value > max ? value : max;
  }, 0);

  const alerts = devices
    .filter(
      (device) =>
        !device.trusted &&
        device.status === "active" &&
        !device.isCurrent &&
        device.createdAt > now - ALERT_WINDOW_MS,
    )
    .map((device) => ({
      deviceId: device.id,
      name: device.name,
      type: device.type,
      browser: device.browser,
      os: device.os,
      createdAt: device.createdAt,
    }));

  return ok({
    currentDeviceId,
    account: {
      displayName: user?.display_name || user?.github_username || "Guandao",
      githubUsername: user?.github_username || null,
      avatarUrl: user?.avatar_url || null,
      role: user?.role || "member",
    },
    overview: {
      deviceCount: activeDevices.length,
      revokedCount: devices.length - activeDevices.length,
      activeDeviceCount: devices.filter((device) => device.presence === "active").length,
      signedInDeviceCount: activeDevices.filter((device) => device.activeSessionCount > 0).length,
      activeSessionCount: activeSessions.length,
      lastActivityAt: lastActivityAt || null,
      onlineWindowMinutes: ONLINE_WINDOW_MS / 60_000,
      staleSyncMs: SYNC_STALE_MS,
    },
    drive: {
      fileCount: drive.fileCount,
      usedBytes: drive.usedBytes,
      lastActivityAt: drive.lastActivityAt,
      cloudSynced: true,
    },
    devices,
    alerts,
  });
}

async function currentHandler(env, { userId, sessionId, deviceId }) {
  if (!deviceId) throw new ApiError("DEVICE_NOT_REGISTERED", "当前会话尚未登记设备", 409);

  const device = await getDeviceRow(env, userId, deviceId);
  if (!device) throw new ApiError("DEVICE_NOT_REGISTERED", "设备记录不存在，请重新登录", 409);
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "该设备已被撤销", 401);

  const [syncRows, sessions] = await Promise.all([
    listSyncRows(env, userId),
    listSessionRows(env, userId, { deviceId, now: Date.now() }),
  ]);

  return ok({
    device: publicDevice(device, {
      currentDeviceId: deviceId,
      syncRows: syncRows.filter((row) => row.device_id === deviceId),
    }),
    sessions: sessions.map((row) => publicSession(row, sessionId)),
  });
}

async function deviceDetailHandler(env, { userId, sessionId, currentDeviceId, device }) {
  const now = Date.now();
  const [syncRows, sessions, activity] = await Promise.all([
    listSyncRows(env, userId),
    listSessionRows(env, userId, { deviceId: device.id, now }),
    listActivity(env, userId, { deviceId: device.id, limit: 30 }),
  ]);

  return ok({
    device: publicDevice(device, {
      currentDeviceId,
      now,
      syncRows: syncRows.filter((row) => row.device_id === device.id),
    }),
    sessions: sessions.map((row) => publicSession(row, sessionId, now)),
    activity,
  });
}

async function activityHandler(env, url, { userId, deviceId }) {
  const limit = clamp(Number(url.searchParams.get("limit") || 50), 1, 100);
  const activity = await listActivity(env, userId, { deviceId, limit });
  return ok({ activity, scope: deviceId ? "device" : "account" });
}

/* ------------------------------------------------------------------ */
/* 注册 / 心跳                                                         */
/* ------------------------------------------------------------------ */

async function registerHandler(env, request, { userId, sessionId, deviceId }) {
  if (!deviceId) throw new ApiError("DEVICE_NOT_REGISTERED", "登录会话缺少设备标识", 409);

  const device = await getDeviceRow(env, userId, deviceId);
  if (!device) throw new ApiError("DEVICE_NOT_REGISTERED", "设备记录不存在，请重新登录", 409);
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "该设备已被撤销", 401);

  const body = await readJson(request, true);
  const visible = body?.visible !== false;
  await markDeviceSeen(env, { deviceId, userId, visible, force: false });

  const [syncRows, sessions] = await Promise.all([
    listSyncRows(env, userId),
    listSessionRows(env, userId, { deviceId }),
  ]);

  return ok({
    registered: true,
    device: publicDevice(device, {
      currentDeviceId: deviceId,
      syncRows: syncRows.filter((row) => row.device_id === deviceId),
    }),
    sessions: sessions.map((row) => publicSession(row, sessionId)),
  });
}

async function heartbeatHandler(env, request, { userId, deviceId }) {
  if (!deviceId) throw new ApiError("DEVICE_NOT_REGISTERED", "登录会话缺少设备标识", 409);

  const body = await readJson(request, true);
  const visible = body?.visible !== false;
  const now = Date.now();

  const device = await getDeviceRow(env, userId, deviceId, now);
  if (!device) throw new ApiError("DEVICE_NOT_REGISTERED", "设备记录不存在，请重新登录", 409);
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "该设备已被撤销", 401);

  const wrote = await markDeviceSeen(env, { deviceId, userId, visible, now });
  const pending = await pendingSyncRequests(env, { deviceId, userId });

  const lastSeenAt = wrote ? now : Number(device.last_seen_at || now);

  return ok({
    serverTime: now,
    wrote,
    presence: derivePresence({ ...device, last_seen_at: lastSeenAt }, now),
    lastSeenAt,
    pendingSync: pending.map((row) => row.domain),
    onlineWindowMinutes: ONLINE_WINDOW_MS / 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* 重命名 / 信任                                                       */
/* ------------------------------------------------------------------ */

async function renameHandler(env, request, { userId, device, currentDeviceId }) {
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "已撤销的设备不能改名", 409);

  const body = await readJson(request);
  const patch = {};

  if (body?.name !== undefined) {
    const name = sanitizeName(body.name);
    if (!name) throw new ApiError("INVALID_NAME", "设备名称需为 1–64 个可见字符", 400);
    patch.name = name;
  }

  if (body?.type !== undefined) {
    const type = String(body.type);
    if (!DEVICE_TYPES.includes(type)) {
      throw new ApiError("INVALID_DEVICE_TYPE", "设备类型不合法", 400);
    }
    patch.type = type;
  }

  if (!Object.keys(patch).length) {
    throw new ApiError("NOTHING_TO_UPDATE", "没有需要修改的字段", 400);
  }

  const sets = [];
  const values = [];
  if (patch.name) {
    sets.push("name = ?");
    values.push(patch.name);
  }
  if (patch.type) {
    sets.push("device_type = ?");
    values.push(patch.type);
  }

  await env.DB.prepare(
    `UPDATE devices SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(...values, device.id, userId)
    .run();

  await logActivity(env, {
    userId,
    deviceId: device.id,
    eventType: "renamed",
    metadata: patch.name ? { from: device.name, to: patch.name } : { to: patch.type },
  });

  const updated = await getDeviceRow(env, userId, device.id);
  return ok({
    device: publicDevice(updated, { currentDeviceId }),
  });
}

async function trustHandler(env, { userId, device, currentDeviceId }) {
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "已撤销的设备不能确认", 409);
  if (device.id === currentDeviceId) {
    // 当前设备本来就在使用中，确认动作没有意义，但也无需报错。
    return ok({ trusted: true, alreadyCurrent: true });
  }

  if (!device.trusted_at) {
    await env.DB.prepare(
      "UPDATE devices SET trusted_at = ? WHERE id = ? AND user_id = ? AND trusted_at IS NULL",
    )
      .bind(Date.now(), device.id, userId)
      .run();
    await logActivity(env, {
      userId,
      deviceId: device.id,
      eventType: "trusted",
      metadata: { name: device.name },
    });
  }

  return ok({ trusted: true });
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

async function syncReportHandler(env, request, { userId, deviceId }) {
  if (!deviceId) throw new ApiError("DEVICE_NOT_REGISTERED", "登录会话缺少设备标识", 409);

  const body = await readJson(request);
  const domain = String(body?.domain || "");
  if (!CLOUD_DOMAINS.has(domain)) {
    if (LOCAL_DOMAINS.has(domain)) {
      throw new ApiError(
        "SYNC_NOT_AVAILABLE",
        "该数据类型目前仍保存在浏览器本地，尚未接入云同步",
        409,
      );
    }
    throw new ApiError("INVALID_DOMAIN", "同步数据类型不合法", 400);
  }

  const result = body?.result === "failed" ? "failed" : "success";
  const pendingUp = clamp(Number(body?.pendingUp || 0), 0, 99_999);
  const pendingDown = clamp(Number(body?.pendingDown || 0), 0, 99_999);
  const conflicts = clamp(Number(body?.conflicts || 0), 0, 99_999);
  const message = typeof body?.message === "string" ? body.message.slice(0, 120) : null;

  const now = Date.now();
  await writeSyncState(env, {
    deviceId,
    userId,
    domain,
    mode: "cloud",
    result,
    pendingUp,
    pendingDown,
    conflicts,
    message,
    now,
  });
  if (result === "success") {
    await touchDeviceSync(env, { deviceId, userId, lastSyncAt: now, now });
  }

  await logActivity(env, {
    userId,
    deviceId,
    eventType: result === "success" ? "sync_success" : "sync_failed",
    metadata: { domain, pendingUp, pendingDown, conflicts },
  });

  return ok({ recorded: true, domain, result, at: now });
}

async function syncRequestHandler(env, request, { userId, device, currentDeviceId }) {
  if (device.revoked_at) throw new ApiError("DEVICE_REVOKED", "已撤销的设备不能同步", 409);
  if (device.id === currentDeviceId) {
    throw new ApiError("ALREADY_CURRENT", "当前设备请直接执行同步", 400);
  }

  const body = await readJson(request, true);
  const domain = String(body?.domain || "drive");
  if (LOCAL_DOMAINS.has(domain)) {
    throw new ApiError("SYNC_NOT_AVAILABLE", "该数据类型尚未接入云同步", 409);
  }
  if (!CLOUD_DOMAINS.has(domain)) {
    throw new ApiError("INVALID_DOMAIN", "同步数据类型不合法", 400);
  }

  await queueSyncRequest(env, { deviceId: device.id, userId, domain, now: Date.now() });
  await logActivity(env, {
    userId,
    deviceId: device.id,
    eventType: "sync_requested",
    metadata: { domain, name: device.name },
  });

  return ok({
    queued: true,
    domain,
    note: "已记录同步请求。该设备下次上线并打开 Guandao Devices 时会检查更新，无法远程唤醒离线设备。",
  });
}

/* ------------------------------------------------------------------ */
/* 撤销                                                                */
/* ------------------------------------------------------------------ */

async function revokeDeviceHandler(env, { userId, device, currentDeviceId, sessionId }) {
  if (device.id === currentDeviceId) {
    throw new ApiError(
      "CANNOT_REVOKE_CURRENT",
      "不能在设备管理中心撤销当前设备，请使用「退出登录」",
      400,
    );
  }

  if (device.revoked_at) {
    return ok({ revoked: true, alreadyRevoked: true, revokedSessions: 0 });
  }

  const revokedSessions = await revokeDevice(env, { userId, deviceId: device.id });
  await logActivity(env, {
    userId,
    deviceId: device.id,
    eventType: "device_revoked",
    metadata: { name: device.name, sessions: revokedSessions, by: sessionId },
  });

  await logSecurityEvent(env, {
    userId,
    eventType: "session_revoked",
    deviceId: device.id,
    metadata: { reason: "device_revoked", count: revokedSessions },
  });

  return ok({
    revoked: true,
    deviceId: device.id,
    revokedSessions,
    note: "该设备的所有有效会话已失效；设备重新联网后下一次请求会收到 401。",
  });
}

async function revokeSessionHandler(env, { userId, sessionId, targetSessionId }) {
  if (!targetSessionId) throw new ApiError("NOT_FOUND", "会话不存在", 404);
  if (targetSessionId === sessionId) {
    throw new ApiError(
      "CANNOT_REVOKE_CURRENT_SESSION",
      "当前会话不能在这里撤销，请使用「退出登录」",
      400,
    );
  }

  const row = await env.DB.prepare(
    "SELECT id, device_id, revoked_at FROM sessions WHERE id = ? AND user_id = ?",
  )
    .bind(targetSessionId, userId)
    .first();
  if (!row) throw new ApiError("NOT_FOUND", "会话不存在", 404);

  if (row.revoked_at) return ok({ revoked: true, alreadyRevoked: true });

  const changed = await revokeSessionById(env, { userId, sessionId: targetSessionId });
  await logActivity(env, {
    userId,
    deviceId: row.device_id,
    eventType: "session_revoked",
    metadata: { count: changed, by: sessionId },
  });

  return ok({ revoked: changed > 0, sessionId: targetSessionId });
}

async function revokeOthersHandler(env, { userId, sessionId }) {
  const now = Date.now();
  const revoked = await revokeSessionsExcept(env, { userId, keepSessionId: sessionId, now });
  await logActivity(env, {
    userId,
    deviceId: null,
    eventType: "session_revoked",
    metadata: { count: revoked },
  });
  await logSecurityEvent(env, {
    userId,
    eventType: "session_revoked",
    metadata: { reason: "revoke_others", count: revoked },
  });
  return ok({
    revoked,
    keptCurrent: true,
    note: "其他设备上的登录已失效；它们下一次请求时会收到 401 并跳回登录界面。",
  });
}

async function revokeAllHandler(env, request, { userId, sessionId }) {
  const body = await readJson(request);
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toUpperCase() : "";
  if (confirm !== "REVOKE ALL") {
    throw new ApiError("CONFIRM_REQUIRED", "请输入 REVOKE ALL 以确认退出全部设备", 400);
  }

  const keepCurrent = body?.keepCurrent === true;
  const now = Date.now();

  const revoked = keepCurrent
    ? await revokeSessionsExcept(env, { userId, keepSessionId: sessionId, now })
    : await revokeAllSessions(env, { userId, now });

  await logActivity(env, {
    userId,
    deviceId: null,
    eventType: "session_revoked",
    metadata: { count: revoked, reason: keepCurrent ? "revoke_all_keep_current" : "revoke_all" },
  });

  await logSecurityEvent(env, {
    userId,
    eventType: "session_revoked",
    metadata: { reason: keepCurrent ? "revoke_all_keep_current" : "revoke_all", count: revoked },
  });

  const response = ok({
    revoked,
    keptCurrent: keepCurrent,
    loggedOut: !keepCurrent,
  });

  if (!keepCurrent) {
    response.headers.append(
      "set-cookie",
      clearSessionCookie(authConfig(env, request).origin),
    );
  }

  return response;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function buildSessions(env, userId, deviceId, currentSessionId) {
  return listSessionRows(env, userId, { deviceId }).then((rows) =>
    rows.map((row) => publicSession(row, currentSessionId)),
  );
}

function sanitizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 64) return null;
  return name;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 读取 JSON 请求体（可选）。
 * 2.0：可选 body 也要复核实际字节数，只信 content-length 会被 chunked 绕过。
 */
async function readJson(request, optional = false) {
  const hasBody = request.headers.has("content-length") || request.headers.has("transfer-encoding");
  if (optional && !hasBody) return null;
  const value = await readJsonLimited(request, 8192);
  if (optional && value && typeof value === "object" && Object.keys(value).length === 0) return null;
  return value;
}
