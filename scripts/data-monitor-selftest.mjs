#!/usr/bin/env node
/**
 * 数据监控规则自测（纯函数，不连接 D1）。
 *
 * 覆盖：
 *   1. users 正常增长/不变不告警；
 *   2. users 下降产生告警；
 *   3. users 归零产生 critical；
 *   4. sessions/devices 同时归零产生 critical；
 *   5. 重要数据表明显下降产生告警；
 *   6. 6 小时内重复告警被抑制；
 *   7. 监控任务失败产生告警；
 *   8. 指标只保留白名单数值，Webhook 不含敏感字段。
 */

import assert from "node:assert/strict";
import {
  ALERT_WINDOW_MS,
  buildWebhookPayload,
  evaluateDataMetrics,
  monitorErrorAlert,
  sanitizeMetrics,
  shouldSuppressAlert,
} from "../worker/api/admin/monitor-core.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

const base = { users: 3, sessions: 5, devices: 4, files: 20, backups: 12, sync_entities: 30 };

check("1. users 正常增长不产生删除告警", () => {
  const alerts = evaluateDataMetrics(base, { ...base, users: 4 });
  assert.equal(alerts.filter((a) => a.code.startsWith("USERS")).length, 0);
});

check("2. users 意外减少产生告警", () => {
  const alerts = evaluateDataMetrics(base, { ...base, users: 1 });
  assert.equal(alerts.some((a) => a.code === "USERS_DROP" && a.severity === "warning"), true);
});

check("3. users 归零产生高优先级告警", () => {
  const alerts = evaluateDataMetrics(base, { ...base, users: 0 });
  assert.equal(alerts.some((a) => a.code === "USERS_ZERO" && a.severity === "critical"), true);
});

check("4. sessions 与 devices 同时归零产生 critical", () => {
  const alerts = evaluateDataMetrics(base, { ...base, sessions: 0, devices: 0 });
  assert.equal(alerts.some((a) => a.code === "SESSIONS_DEVICES_ZERO" && a.severity === "critical"), true);
});

check("5. 重要数据表明显下降产生告警", () => {
  const alerts = evaluateDataMetrics(base, { ...base, files: 2, backups: 2 });
  assert.equal(alerts.some((a) => a.code === "DATA_DROP_FILES"), true);
  assert.equal(alerts.some((a) => a.code === "DATA_DROP_BACKUPS"), true);
});

check("6. 6 小时内重复告警被抑制", () => {
  const now = Date.now();
  assert.equal(shouldSuppressAlert(now - 1000, now), true);
  assert.equal(shouldSuppressAlert(now - ALERT_WINDOW_MS - 1, now), false);
  assert.equal(shouldSuppressAlert(null, now), false);
});

check("7. 监控任务失败产生告警", () => {
  const alert = monitorErrorAlert("D1_TIMEOUT", "query timeout");
  assert.equal(alert.code, "MONITOR_ERROR");
  assert.equal(alert.severity, "warning");
  assert.match(alert.message, /需要人工核查/);
});

check("8. 指标白名单与 Webhook 不含敏感字段", () => {
  const metrics = sanitizeMetrics({
    users: 1,
    sessions: 3,
    devices: 3,
    files: 0,
    backups: 0,
    sync_entities: 0,
    token: "secret",
    cookie: "gauth_sid=abc",
    email: "user@example.com",
  });
  assert.deepEqual(Object.keys(metrics).sort(), ["account_deletion_audit", "backups", "data_deletion_jobs", "devices", "files", "security_events", "sessions", "sync_entities", "users"]);
  const payload = buildWebhookPayload(monitorErrorAlert("X", "y"), metrics, 1793889343133);
  assert.equal(payload.type, "guandao.data.alert");
  assert.equal(payload.requiresHumanReview, true);
  const text = JSON.stringify(payload);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("gauth_sid"), false);
  assert.equal(text.includes("user@example.com"), false);
});

check("9. Session 正常过期但不归零不触发账号删除告警", () => {
  const alerts = evaluateDataMetrics(base, { ...base, sessions: 0 });
  assert.equal(alerts.some((a) => a.code === "SESSIONS_DEVICES_ZERO"), false);
  assert.equal(alerts.some((a) => a.code === "USERS_ZERO"), false);
});

const failed = results.filter((item) => !item.pass).length;
console.log(`\n[data-monitor] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);