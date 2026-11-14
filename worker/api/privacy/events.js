/**
 * 统一安全事件日志。
 *
 * 只允许白名单 event_type 与白名单 metadata 键；
 * 绝不写入 token、secret、笔记正文、文件内容或精确位置。
 */

export const SECURITY_EVENT_TYPES = new Set([
  "successful_login",
  "failed_login",
  "new_device_registered",
  "session_created",
  "session_revoked",
  "suspicious_access_blocked",
  "data_export_started",
  "data_export_completed",
  "data_deletion_started",
  "data_deletion_completed",
  "account_deletion_started",
  "account_deletion_completed",
  "account_deletion_failed",
  "account_deletion_r2_retry",
  "account_deletion_r2_incomplete",
  "data_monitor_alert",
  "data_monitor_acknowledged",
  "data_backup_completed",
  "data_backup_failed",
  "qa_cleanup_started",
  "qa_cleanup_completed",
  "admin_sensitive_action",
  "privacy_settings_changed",
  "local_data_cleared",
]);

const SAFE_META_KEYS = new Set([
  "browser",
  "os",
  "deviceType",
  "reason",
  "count",
  "targets",
  "format",
  "exportId",
  "jobId",
  "stage",
  "settings",
  "code",
  "errorCode",
  "severity",
  "alertId",
  "runId",
  "table",
  "backupId",
  "sha256Prefix",
]);

export function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_META_KEYS.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 120);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 10).map((item) => String(item).slice(0, 40));
    else if (value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => typeof v === "boolean" || typeof v === "number")
          .slice(0, 12),
      );
    }
  }
  return Object.keys(out).length ? out : null;
}

export async function logSecurityEvent(
  env,
  { userId = null, eventType, deviceId = null, result = "success", metadata = null },
) {
  if (!SECURITY_EVENT_TYPES.has(eventType)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO security_events
         (id, user_id, event_type, device_id, result, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        eventType,
        deviceId,
        result,
        metadata ? JSON.stringify(safeMetadata(metadata)).slice(0, 1500) : null,
        Date.now(),
      )
      .run();
  } catch (error) {
    console.error("[security] event insert failed:", error?.message ?? error);
  }
}

/** 只保留 180 天，避免安全日志无限增长。 */
export async function pruneSecurityEvents(env, userId) {
  await env.DB.prepare(
    "DELETE FROM security_events WHERE user_id = ? AND created_at < ?",
  )
    .bind(userId, Date.now() - 180 * 24 * 3600 * 1000)
    .run();
}
