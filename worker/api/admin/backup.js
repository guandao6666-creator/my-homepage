/**
 * /api/admin/backup-status · 管理员只读查看 D1 备份状态。
 *
 * 数据来源：
 * - 独立 R2 的 logs/backup-status.json（Workflow 每次运行写入）
 * - D1 d1_backup_runs（可选，表不存在时 degraded）
 *
 * 不返回 Token、signed_url、SQL 内容或用户数据。
 */

import { ApiError, ok } from "../http.js";
import { requireSession } from "../guards.js";
import { effectiveRole } from "../community/common.js";
import { STATUS_OBJECT_KEY, evaluateBackupStatus } from "../../workflows/d1-backup-core.js";

async function requireAdmin(env, request) {
  const session = await requireSession(env, request, { message: "请先登录 Guandao Account" });
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin") throw new ApiError("FORBIDDEN", "需要管理员权限", 403);
  return session;
}

export async function handleAdminBackupRequest({ request, env, path }) {
  if (path !== "/api/admin/backup-status") return null;
  if (request.method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "该接口只支持 GET", 405);
  await requireAdmin(env, request);

  let status = null;
  let statusError = null;
  if (!env.DB_BACKUPS) {
    statusError = "DB_BACKUPS_BINDING_MISSING";
  } else {
    try {
      const object = await env.DB_BACKUPS.get(STATUS_OBJECT_KEY);
      status = object ? JSON.parse(await object.text()) : null;
      if (!status) statusError = "STATUS_OBJECT_MISSING";
    } catch (error) {
      statusError = `STATUS_READ_FAILED:${String(error?.name ?? error).slice(0, 40)}`;
    }
  }

  const health = evaluateBackupStatus(status);
  let runs = null;
  let runsError = null;
  if (env.DB) {
    try {
      const result = await env.DB.prepare(
        `SELECT run_id, database_ref, started_at, finished_at, status, bookmark, object_key, manifest_key,
                sql_bytes, sha256, upload_status, verify_status, error_code, error_message, notified_at, notify_error
           FROM d1_backup_runs ORDER BY started_at DESC LIMIT 20`,
      ).all();
      runs = result.results ?? [];
    } catch (error) {
      runsError = String(error?.message ?? error).slice(0, 120);
    }
  }

  return ok({
    status: status ? { ...status, lastRun: status.lastRun ?? null } : null,
    health,
    statusError,
    runs,
    runsError,
    notificationConfigured: Boolean(env.BACKUP_ALERT_WEBHOOK),
  });
}