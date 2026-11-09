/**
 * /api/admin/data-monitor · 生产数据异常监控。
 *
 * - Cron 每 15 分钟调用 runDataMonitor（只读统计 + 最小化告警记录）；
 * - 管理员可查看快照/告警并确认（ack）；
 * - 告警只包含数量，不含用户内容、Cookie、Token；
 * - 可选 DATA_ALERT_WEBHOOK 通知，未配置时只写数据库，不伪造送达。
 */

import { ApiError, ok } from "../http.js";
import { assertSameOriginFor, requireSession } from "../guards.js";
import { effectiveRole } from "../community/common.js";
import { logSecurityEvent } from "../privacy/events.js";
import {
  buildBackupAlert,
  evaluateBackupStatus,
  STATUS_OBJECT_KEY,
} from "../../workflows/d1-backup-core.js";
import {
  buildWebhookPayload,
  evaluateDataMetrics,
  METRIC_TABLES,
  monitorErrorAlert,
  sanitizeMetrics,
  shouldSuppressAlert,
} from "./monitor-core.js";

const STATE_BASELINE = "monitor.baseline";
const STATE_LAST_RUN = "monitor.lastRun";
const STATE_FAILURES = "monitor.failures";
const MAX_SNAPSHOTS = 50;
const MAX_ALERTS = 50;

export async function collectMetrics(env) {
  const selects = METRIC_TABLES.map(
    (table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`,
  ).join(", ");
  const row = await env.DB.prepare(`SELECT ${selects}`).first();
  return sanitizeMetrics(row);
}

async function readState(env, key) {
  const row = await env.DB.prepare("SELECT value FROM data_monitor_state WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}

async function writeState(env, key, value, now) {
  await env.DB.prepare(
    `INSERT INTO data_monitor_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();
}

async function insertSnapshot(env, metrics, status, errorCode = null, now = Date.now()) {
  await env.DB.prepare(
    "INSERT INTO data_monitor_snapshots (id, captured_at, metrics_json, status, error_code) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), now, JSON.stringify(metrics), status, errorCode)
    .run();
}

async function notifyWebhook(env, alert, metrics, now) {
  const url = env.DATA_ALERT_WEBHOOK;
  if (!url) return { notifiedAt: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(alert, metrics, now)),
      signal: controller.signal,
    });
    if (!response.ok) return { notifiedAt: null, error: `HTTP_${response.status}` };
    return { notifiedAt: now, error: null };
  } catch (error) {
    return { notifiedAt: null, error: String(error?.name ?? error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function recordAlert(env, alert, metrics, now) {
  const last = await env.DB.prepare(
    `SELECT created_at FROM data_monitor_alerts
      WHERE dedupe_key = ? AND status IN ('open', 'acknowledged')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(alert.dedupeKey)
    .first();
  if (shouldSuppressAlert(last?.created_at, now)) return { suppressed: true };

  const id = crypto.randomUUID();
  const notified = await notifyWebhook(env, alert, metrics, now);
  await env.DB.prepare(
    `INSERT INTO data_monitor_alerts
       (id, created_at, updated_at, severity, code, message, metrics_json, status, notified_at, notify_error, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(
      id,
      now,
      now,
      alert.severity,
      alert.code,
      alert.message.slice(0, 500),
      JSON.stringify(sanitizeMetrics(metrics)),
      notified.notifiedAt,
      notified.error,
      alert.dedupeKey,
    )
    .run();
  await logSecurityEvent(env, {
    eventType: "data_monitor_alert",
    result: "failure",
    metadata: { code: alert.code, severity: alert.severity },
  });
  return { suppressed: false, id, notified: Boolean(notified.notifiedAt), notifyError: notified.error };
}

async function resolveRecovered(env, metrics, now) {
  if (metrics.users <= 0) return 0;
  const result = await env.DB.prepare(
    `UPDATE data_monitor_alerts SET status = 'resolved', updated_at = ?
      WHERE code IN ('USERS_ZERO', 'SESSIONS_DEVICES_ZERO') AND status IN ('open', 'acknowledged')`,
  )
    .bind(now)
    .run();
  return Number(result?.meta?.changes ?? 0);
}

/**
 * Cron 入口：所有异常都被捕获，绝不影响 Worker 正常请求。
 * @param {{ DB?: D1Database, DATA_ALERT_WEBHOOK?: string }} env
 */
export async function runDataMonitor(env) {
  const now = Date.now();
  if (!env?.DB) return { ok: false, error: "DB_MISSING" };
  const fail = async (code, error) => {
    let failures = 1;
    try {
      const previous = Number((await readState(env, STATE_FAILURES)) || 0);
      failures = Number.isFinite(previous) ? previous + 1 : 1;
      await writeState(env, STATE_FAILURES, String(failures), now);
    } catch {
      /* state 写入失败时仍尽量记录告警 */
    }
    await insertSnapshot(env, {}, "error", code, now).catch(() => undefined);
    await recordAlert(
      env,
      monitorErrorAlert(code, `${error?.message ?? error}（连续失败 ${failures} 次）`),
      {},
      now,
    ).catch(() => undefined);
    return { ok: false, error: code, failures };
  };

  let metrics;
  try {
    metrics = await collectMetrics(env);
  } catch (error) {
    return fail("MONITOR_QUERY_FAILED", error);
  }

  let baselineRaw = null;
  try {
    baselineRaw = await readState(env, STATE_BASELINE);
  } catch (error) {
    return fail("MONITOR_STATE_FAILED", error);
  }
  let previous = metrics;
  if (baselineRaw) {
    try {
      previous = sanitizeMetrics(JSON.parse(baselineRaw));
    } catch {
      previous = metrics;
    }
  }

  const alerts = evaluateDataMetrics(previous, metrics);
  const status = alerts.length ? "anomaly" : "ok";
  try {
    await insertSnapshot(env, metrics, status, null, now);
    const recorded = [];
    for (const alert of alerts) {
      recorded.push({ code: alert.code, ...(await recordAlert(env, alert, metrics, now)) });
    }
    const resolved = await resolveRecovered(env, metrics, now);
    await writeState(env, STATE_BASELINE, JSON.stringify(metrics), now);
    await writeState(env, STATE_LAST_RUN, String(now), now);
    await writeState(env, STATE_FAILURES, "0", now);
    return { ok: true, metrics, alerts: recorded, resolved };
  } catch (error) {
    return fail("MONITOR_WRITE_FAILED", error);
  }
}

/**
 * 备份状态监控：读取独立 R2 的 logs/backup-status.json。
 * - 无绑定、无对象、JSON 损坏 → unknown
 * - 最近失败 → failed
 * - 成功记录超过 26 小时 → stale
 * 绝不把 unknown 当作 healthy。
 */
export async function runBackupMonitor(env) {
  const now = Date.now();
  let status = null;
  let readError = null;
  if (!env?.DB_BACKUPS) {
    readError = "DB_BACKUPS_BINDING_MISSING";
  } else {
    try {
      const object = await env.DB_BACKUPS.get(STATUS_OBJECT_KEY);
      if (object) status = JSON.parse(await object.text());
      else readError = "STATUS_OBJECT_MISSING";
    } catch (error) {
      readError = `STATUS_READ_FAILED:${String(error?.name ?? error).slice(0, 40)}`;
    }
  }
  const health = evaluateBackupStatus(status, now);
  const effective = readError && health.state === "healthy"
    ? { ...health, state: "unknown", reason: readError }
    : health;

  if (effective.state === "healthy") {
    try {
      await env.DB.prepare(
        "UPDATE data_monitor_alerts SET status = 'resolved', updated_at = ? WHERE code LIKE 'BACKUP_%' AND status IN ('open', 'acknowledged')",
      )
        .bind(now)
        .run();
    } catch {
      /* 表不存在时不影响备份监控结果 */
    }
    return { ok: true, state: "healthy", lastSuccessAt: effective.lastSuccessAt };
  }

  const alert = buildBackupAlert(effective, now);
  alert.dedupeKey = alert.code;
  try {
    await insertSnapshot(env, { backupState: effective.state }, "anomaly", alert.code, now);
    const alertEnv = env.DATA_ALERT_WEBHOOK || env.BACKUP_ALERT_WEBHOOK
      ? { ...env, DATA_ALERT_WEBHOOK: env.DATA_ALERT_WEBHOOK || env.BACKUP_ALERT_WEBHOOK }
      : env;
    const recorded = await recordAlert(alertEnv, alert, { backupState: effective.state }, now).catch(() => null);
    return { ok: true, state: effective.state, reason: effective.reason, recorded };
  } catch (error) {
    return { ok: false, state: effective.state, reason: effective.reason, error: String(error?.message ?? error).slice(0, 120) };
  }
}

async function requireAdmin(env, request) {
  const session = await requireSession(env, request, { message: "请先登录 Guandao Account" });
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin") throw new ApiError("FORBIDDEN", "需要管理员权限", 403);
  return session;
}

function mapAlert(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    severity: row.severity,
    code: row.code,
    message: row.message,
    metrics: JSON.parse(row.metrics_json || "{}"),
    status: row.status,
    acknowledgedAt: row.acknowledged_at ? Number(row.acknowledged_at) : null,
    acknowledgedBy: row.acknowledged_by,
    notifiedAt: row.notified_at ? Number(row.notified_at) : null,
    notifyError: row.notify_error,
  };
}

export async function handleAdminMonitorRequest({ request, env, path }) {
  const base = "/api/admin/data-monitor";
  if (path !== base && !path.startsWith(`${base}/`)) return null;

  if (request.method === "GET" && path === base) {
    await requireAdmin(env, request);
    const snapshots = await env.DB.prepare(
      "SELECT id, captured_at, metrics_json, status, error_code FROM data_monitor_snapshots ORDER BY captured_at DESC LIMIT ?",
    )
      .bind(MAX_SNAPSHOTS)
      .all();
    const alerts = await env.DB.prepare(
      `SELECT * FROM data_monitor_alerts ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(MAX_ALERTS)
      .all();
    const state = await env.DB.prepare("SELECT key, value, updated_at FROM data_monitor_state").all();
    return ok({
      metrics: METRIC_TABLES,
      snapshots: (snapshots.results ?? []).map((row) => ({
        id: row.id,
        capturedAt: Number(row.captured_at),
        metrics: JSON.parse(row.metrics_json || "{}"),
        status: row.status,
        errorCode: row.error_code,
      })),
      alerts: (alerts.results ?? []).map(mapAlert),
      state: (state.results ?? []).map((row) => ({ key: row.key, value: row.value, updatedAt: Number(row.updated_at) })),
      notificationConfigured: Boolean(env.DATA_ALERT_WEBHOOK),
    });
  }

  const match = path.match(/^\/api\/admin\/data-monitor\/alerts\/([0-9a-f-]{36})\/ack$/);
  if (match && request.method === "POST") {
    const session = await requireAdmin(env, request);
    assertSameOriginFor(request, env);
    const now = Date.now();
    const result = await env.DB.prepare(
      "UPDATE data_monitor_alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND status = 'open'",
    )
      .bind(now, session.user.id, now, match[1])
      .run();
    if (Number(result?.meta?.changes ?? 0) !== 1) {
      throw new ApiError("NOT_FOUND", "告警不存在或已确认", 404);
    }
    await logSecurityEvent(env, {
      userId: session.user.id,
      eventType: "data_monitor_acknowledged",
      metadata: { alertId: match[1] },
    });
    return ok({ acknowledged: true, id: match[1], acknowledgedAt: now });
  }

  throw new ApiError("METHOD_NOT_ALLOWED", "该接口不支持这个请求方法", 405);
}