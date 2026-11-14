/**
 * 生产数据异常监控核心（纯函数，便于隔离测试）。
 *
 * 只比较数量，不读取用户内容；所有告警都标记「需要人工核查」，
 * 因为合法的账号注销也会导致 users/sessions 减少。
 */

export const METRIC_TABLES = [
  "users",
  "sessions",
  "devices",
  "files",
  "backups",
  "sync_entities",
  "security_events",
  "account_deletion_audit",
  "data_deletion_jobs",
];
export const ALERT_WINDOW_MS = 6 * 3600 * 1000;
export const DROP_RATIO = 0.5;
export const DROP_MIN_BASELINE = 10;

export function sanitizeMetrics(raw) {
  const out = {};
  for (const table of METRIC_TABLES) {
    const value = Number(raw?.[table] ?? 0);
    out[table] = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  }
  return out;
}

export function evaluateDataMetrics(previous, current, options = {}) {
  const prev = sanitizeMetrics(previous);
  const curr = sanitizeMetrics(current);
  const alerts = [];
  const push = (code, severity, message) => alerts.push({ code, severity, message, dedupeKey: code });

  if (prev.users > 0 && curr.users === 0) {
    push("USERS_ZERO", "critical", `users 从 ${prev.users} 变为 0，需要人工核查`);
  } else if (curr.users < prev.users) {
    push("USERS_DROP", "warning", `users 从 ${prev.users} 降至 ${curr.users}，需要人工核查`);
  }

  if (curr.users > 0 && curr.sessions === 0 && curr.devices === 0) {
    push("SESSIONS_DEVICES_ZERO", "critical", "sessions 与 devices 同时归零，需要人工核查");
  }

  for (const table of ["files", "backups", "sync_entities"]) {
    const ratio = options.dropRatio ?? DROP_RATIO;
    if (prev[table] >= DROP_MIN_BASELINE && curr[table] < prev[table] * ratio) {
      push(`DATA_DROP_${table.toUpperCase()}`, "warning", `${table} 从 ${prev[table]} 降至 ${curr[table]}，需要人工核查`);
    }
  }

  return alerts;
}

export function shouldSuppressAlert(lastAlertAt, now = Date.now(), windowMs = ALERT_WINDOW_MS) {
  const last = Number(lastAlertAt || 0);
  if (!last) return false;
  return now - last < windowMs;
}

export function monitorErrorAlert(code, message) {
  return {
    code: "MONITOR_ERROR",
    severity: "warning",
    message: `数据监控失败（${code}）：${String(message || "").slice(0, 160)}，需要人工核查`,
    dedupeKey: "MONITOR_ERROR",
  };
}

/** Webhook 只发送计数与告警元数据，不含任何用户内容/Token。 */
export function buildWebhookPayload(alert, metrics, at = Date.now()) {
  return {
    type: "guandao.data.alert",
    at: new Date(at).toISOString(),
    severity: alert.severity,
    code: alert.code,
    message: alert.message,
    metrics: sanitizeMetrics(metrics),
    requiresHumanReview: true,
  };
}