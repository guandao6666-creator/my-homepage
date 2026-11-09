/**
 * Guandao Devices · D1 访问层
 *
 * 所有 SQL 都带 user_id 绑定参数：设备 ID 来自 URL 时，也必须同时匹配当前用户，
 * 否则统一按「不存在」处理，避免通过 ID 枚举他人设备（IDOR）。
 */

const DEVICE_COLUMNS = `d.id, d.user_id, d.name, d.platform, d.device_type, d.browser_name,
  d.os_name, d.last_seen_at, d.last_active_at, d.last_sync_at, d.revoked_at,
  d.trusted_at, d.status, d.created_at`;

export async function listDeviceRows(env, userId, now = Date.now()) {
  const rows = await env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS},
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_id = d.id AND s.user_id = d.user_id) AS session_count,
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_id = d.id AND s.user_id = d.user_id
                AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_session_count
       FROM devices d
      WHERE d.user_id = ?
      ORDER BY (d.revoked_at IS NOT NULL) ASC,
               COALESCE(d.last_seen_at, d.created_at) DESC`,
  )
    .bind(now, userId)
    .all();

  return rows.results || [];
}

export async function getDeviceRow(env, userId, deviceId, now = Date.now()) {
  return env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS},
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_id = d.id AND s.user_id = d.user_id) AS session_count,
            (SELECT COUNT(*) FROM sessions s
              WHERE s.device_id = d.id AND s.user_id = d.user_id
                AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_session_count
       FROM devices d
      WHERE d.id = ? AND d.user_id = ?`,
  )
    .bind(now, deviceId, userId)
    .first();
}

export async function listSyncRows(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT device_id, domain, mode, last_attempt_at, last_sync_at, last_result,
            pending_up, pending_down, conflicts, message, sync_requested_at, updated_at
       FROM device_sync_state
      WHERE user_id = ?`,
  )
    .bind(userId)
    .all();
  return rows.results || [];
}

export async function listSessionRows(env, userId, { deviceId = null, now = Date.now() } = {}) {
  const sql = `SELECT s.id, s.device_id, s.created_at, s.last_used_at, s.expires_at, s.revoked_at,
                      d.name AS device_name, d.device_type, d.browser_name, d.os_name
                 FROM sessions s
            LEFT JOIN devices d ON d.id = s.device_id AND d.user_id = s.user_id
                WHERE s.user_id = ?${deviceId ? " AND s.device_id = ?" : ""}
                ORDER BY s.created_at DESC
                LIMIT 100`;
  const statement = env.DB.prepare(sql);
  const bound = deviceId ? statement.bind(userId, deviceId) : statement.bind(userId);
  const rows = await bound.all();
  return rows.results || [];
}

export function publicSession(row, currentSessionId, now = Date.now()) {
  const revoked = Boolean(row.revoked_at);
  const expired = Number(row.expires_at) <= now;
  return {
    id: row.id,
    deviceId: row.device_id || null,
    deviceName: row.device_name || null,
    createdAt: Number(row.created_at || 0),
    lastUsedAt: Number(row.last_used_at || 0),
    expiresAt: Number(row.expires_at || 0),
    status: revoked ? "revoked" : expired ? "expired" : "active",
    current: row.id === currentSessionId,
  };
}

export async function revokeDevice(env, { userId, deviceId, now = Date.now() }) {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`,
    ).bind(now, userId, deviceId),
    env.DB.prepare(
      `UPDATE devices SET revoked_at = ?, status = 'revoked'
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(now, deviceId, userId),
  ]);
  return Number(results?.[0]?.meta?.changes ?? 0);
}

export async function revokeSessionById(env, { userId, sessionId, now = Date.now() }) {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, sessionId, userId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function revokeSessionsExcept(env, { userId, keepSessionId, now = Date.now() }) {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
  )
    .bind(now, userId, keepSessionId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function revokeAllSessions(env, { userId, now = Date.now() }) {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(now, userId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function markDeviceSeen(env, { deviceId, userId, visible, force = false, now = Date.now() }) {
  if (force) {
    const result = await env.DB.prepare(
      `UPDATE devices
          SET last_seen_at = ?,
              last_active_at = CASE WHEN ? = 1 THEN ? ELSE COALESCE(last_active_at, ?) END
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
      .bind(now, visible ? 1 : 0, now, now, deviceId, userId)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  const result = await env.DB.prepare(
    `UPDATE devices
        SET last_seen_at = ?,
            last_active_at = CASE WHEN ? = 1 THEN ? ELSE COALESCE(last_active_at, ?) END
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        AND (last_seen_at IS NULL OR last_seen_at < ?)`,
  )
    .bind(now, visible ? 1 : 0, now, now, deviceId, userId, now - 60_000)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function touchDeviceSync(env, { deviceId, userId, lastSyncAt, now = Date.now() }) {
  await env.DB.prepare(
    "UPDATE devices SET last_sync_at = ? WHERE id = ? AND user_id = ? AND (last_sync_at IS NULL OR last_sync_at < ?)",
  )
    .bind(lastSyncAt, deviceId, userId, lastSyncAt)
    .run();
}

export async function writeSyncState(
  env,
  {
    deviceId,
    userId,
    domain,
    mode,
    result,
    pendingUp,
    pendingDown,
    conflicts,
    message,
    now = Date.now(),
  },
) {
  const success = result === "success";
  await env.DB.prepare(
    `INSERT INTO device_sync_state
       (device_id, user_id, domain, mode, last_attempt_at, last_sync_at, last_result,
        pending_up, pending_down, conflicts, message, sync_requested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (device_id, domain) DO UPDATE SET
       user_id = excluded.user_id,
       mode = excluded.mode,
       last_attempt_at = excluded.last_attempt_at,
       last_sync_at = CASE WHEN excluded.last_result = 'success'
                           THEN excluded.last_attempt_at
                           ELSE device_sync_state.last_sync_at END,
       last_result = excluded.last_result,
       pending_up = excluded.pending_up,
       pending_down = excluded.pending_down,
       conflicts = excluded.conflicts,
       message = excluded.message,
       sync_requested_at = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(
      deviceId,
      userId,
      domain,
      mode,
      now,
      success ? now : null,
      result,
      pendingUp,
      pendingDown,
      conflicts,
      message ? String(message).slice(0, 160) : null,
      now,
    )
    .run();

  return success;
}

export async function queueSyncRequest(env, { deviceId, userId, domain, now = Date.now() }) {
  await env.DB.prepare(
    `INSERT INTO device_sync_state
       (device_id, user_id, domain, mode, pending_up, pending_down, conflicts,
        sync_requested_at, updated_at)
     VALUES (?, ?, ?, 'cloud', 0, 0, 0, ?, ?)
     ON CONFLICT (device_id, domain) DO UPDATE SET
       sync_requested_at = excluded.sync_requested_at,
       updated_at = excluded.updated_at`,
  )
    .bind(deviceId, userId, domain, now, now)
    .run();
}

export async function pendingSyncRequests(env, { deviceId, userId }) {
  const rows = await env.DB.prepare(
    `SELECT domain, sync_requested_at FROM device_sync_state
      WHERE device_id = ? AND user_id = ? AND sync_requested_at IS NOT NULL`,
  )
    .bind(deviceId, userId)
    .all();
  return rows.results || [];
}

export async function listActivity(env, userId, { deviceId = null, limit = 50 } = {}) {
  const sql = `SELECT a.id, a.device_id, a.event_type, a.metadata_json, a.created_at,
                      d.name AS device_name
                 FROM device_activity a
            LEFT JOIN devices d ON d.id = a.device_id AND d.user_id = a.user_id
                WHERE a.user_id = ?${deviceId ? " AND a.device_id = ?" : ""}
                ORDER BY a.created_at DESC
                LIMIT ?`;
  const statement = env.DB.prepare(sql);
  const bound = deviceId
    ? statement.bind(userId, deviceId, limit)
    : statement.bind(userId, limit);
  const rows = await bound.all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name || null,
    eventType: row.event_type,
    createdAt: Number(row.created_at || 0),
    metadata: parseMeta(row.metadata_json),
  }));
}

function parseMeta(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // 白名单字段，防御早期或异常写入把敏感内容带出来。
    const allowed = ["name", "type", "browser", "os", "domain", "from", "to", "sessions", "count", "reason"];
    const out = {};
    for (const key of allowed) {
      if (parsed[key] === undefined) continue;
      const value = parsed[key];
      out[key] = typeof value === "string" ? value.slice(0, 80) : value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export async function driveStats(env, userId) {
  const [filesRow, eventRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM files WHERE user_id = ? AND status = 'ready'`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      "SELECT MAX(created_at) AS last_at FROM file_events WHERE user_id = ?",
    )
      .bind(userId)
      .first(),
  ]);

  return {
    fileCount: Number(filesRow?.files || 0),
    usedBytes: Number(filesRow?.bytes || 0),
    lastActivityAt: eventRow?.last_at ? Number(eventRow.last_at) : null,
  };
}
