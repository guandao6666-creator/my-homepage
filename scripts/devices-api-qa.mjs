#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Guandao OS · 设备管理 API QA（scripts/devices-api-qa.mjs）
//
// 目的：补齐任务书要求的 `npm run qa:devices`，在**完全本地隔离**环境里验证
// 「设备管理 / 会话管理 / 撤销」的 HTTP 行为，不依赖生产账号、不读取远程 D1/R2。
//
// 前置（由 scripts/qa-local-run.mjs devices 负责）：
//   1. 本地 D1 已迁移并写入 scripts/seed-qa-local.mjs 的固定夹具；
//   2. `wrangler dev --local` 已在 BASE（默认 http://127.0.0.1:8794）就绪。
//
// 覆盖：
//   - /api/devices 总览契约（_currentDeviceId_、同账号设备、无跨账号泄漏）
//   - /api/devices/current、/:deviceId 详情、/sessions、/activity
//   - POST /api/devices/heartbeat（含缺少 Origin 的 CSRF 拒绝）
//   - 未登录 401、跨账号设备 404
//   - 撤销其他会话 → 该会话 401 SESSION_REVOKED
//   - 撤销其他设备 → 该设备所有会话失效、总览计数变化、不能撤销当前设备
//
// 说明：脚本会在中途重新写入一次本地 QA 夹具（仅本地 D1），用于同时验证
// 「会话撤销」和「设备撤销」两条路径互不干扰。
// ---------------------------------------------------------------------------

import { QA_TOKENS, seedQaFixtures } from "./seed-qa-local.mjs";

const BASE = (process.env.BASE || process.env.QA_BASE || "http://127.0.0.1:8794").replace(/\/+$/, "");
const ORIGIN = process.env.QA_ORIGIN || BASE;
const ADMIN_DEVICE = "qa-dev-admin";
const LAPTOP_DEVICE = "qa-dev-laptop";
const PHONE_DEVICE = "qa-dev-phone";
const OTHER_DEVICE = "qa-dev-other";
const LAPTOP_SESSION = "qa-sess-dev";
const PHONE_SESSION = "qa-sess-phone";

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(token, path, { method = "GET", body, origin = true } = {}) {
  const headers = {};
  if (token) headers.Cookie = `gauth_sid=${token}`;
  if (origin && method !== "GET" && method !== "HEAD") headers.Origin = ORIGIN;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const dataOf = (result) => result.json?.data ?? null;
const codeOf = (result) => result.json?.error?.code ?? null;
const describe = (result) => `${result.status} ${codeOf(result) ?? ""}`.trim();

async function main() {
  console.log(`[devices-qa] 目标：${BASE}（本地隔离 Worker）`);

  /* ------------------------- 1. 健康与总览 ------------------------- */
  const health = await api(null, "/api/health");
  check("健康检查可用", health.status === 200, describe(health));

  const overview = await api(QA_TOKENS.dev, "/api/devices");
  const overviewData = dataOf(overview);
  check("设备总览返回 200", overview.status === 200, describe(overview));
  check("当前设备为 qa-dev-laptop", overviewData?.currentDeviceId === LAPTOP_DEVICE);
  const deviceIds = (overviewData?.devices ?? []).map((device) => device.id);
  check("同账号两台设备均可见", deviceIds.includes(LAPTOP_DEVICE) && deviceIds.includes(PHONE_DEVICE), deviceIds.join(","));
  check("不泄漏其他账号设备", !deviceIds.includes(OTHER_DEVICE) && !deviceIds.includes(ADMIN_DEVICE), deviceIds.join(","));
  check("activeDeviceCount 为 2 且 activeSessionCount ≥ 2", overviewData?.overview?.deviceCount === 2 && (overviewData?.overview?.activeSessionCount ?? 0) >= 2, JSON.stringify(overviewData?.overview ?? null));
  check("账号信息与夹具一致", overviewData?.account?.githubUsername === "qa-plugin-dev", String(overviewData?.account?.githubUsername));

  /* --------------------- 2. 当前设备 / 详情 ----------------------- */
  const current = await api(QA_TOKENS.dev, "/api/devices/current");
  check("当前设备详情返回 200", current.status === 200, describe(current));
  check("当前设备详情 device.id 正确", dataOf(current)?.device?.id === LAPTOP_DEVICE, String(dataOf(current)?.device?.id));
  check("当前设备详情包含会话列表", Array.isArray(dataOf(current)?.sessions) && dataOf(current).sessions.length >= 1);

  const phoneDetail = await api(QA_TOKENS.dev, `/api/devices/${PHONE_DEVICE}`);
  check("同账号设备详情返回 200", phoneDetail.status === 200, describe(phoneDetail));
  check("同账号设备详情 id 正确", dataOf(phoneDetail)?.device?.id === PHONE_DEVICE);
  check("设备详情包含活动数组", Array.isArray(dataOf(phoneDetail)?.activity), typeof dataOf(phoneDetail)?.activity);

  const crossAccount = await api(QA_TOKENS.dev, `/api/devices/${OTHER_DEVICE}`);
  check("跨账号读取设备返回 404 NOT_FOUND", crossAccount.status === 404 && codeOf(crossAccount) === "NOT_FOUND", describe(crossAccount));

  /* ------------------- 3. 会话列表 / 活动 / 心跳 ------------------ */
  const sessions = await api(QA_TOKENS.dev, "/api/devices/sessions");
  const sessionIds = (dataOf(sessions)?.sessions ?? []).map((session) => session.id);
  check("会话列表返回 200", sessions.status === 200, describe(sessions));
  check("会话列表包含 laptop 与 phone 两条会话", sessionIds.includes(LAPTOP_SESSION) && sessionIds.includes(PHONE_SESSION), sessionIds.join(","));
  const currentSession = (dataOf(sessions)?.sessions ?? []).find((session) => session.id === LAPTOP_SESSION);
  check("当前会话被标记为 current", currentSession?.current === true, JSON.stringify(currentSession ?? null));

  const activity = await api(QA_TOKENS.dev, "/api/devices/activity");
  check("账号活动返回 200 且为数组", activity.status === 200 && Array.isArray(dataOf(activity)?.activity), describe(activity));

  const heartbeat = await api(QA_TOKENS.dev, "/api/devices/heartbeat", { method: "POST", body: { visible: true } });
  const heartbeatData = dataOf(heartbeat);
  check("心跳返回 200", heartbeat.status === 200, describe(heartbeat));
  check("心跳包含 serverTime / presence / pendingSync", typeof heartbeatData?.serverTime === "number" && typeof heartbeatData?.presence === "string" && Array.isArray(heartbeatData?.pendingSync), JSON.stringify(heartbeatData ?? null));

  const heartbeatNoOrigin = await api(QA_TOKENS.dev, "/api/devices/heartbeat", { method: "POST", body: { visible: true }, origin: false });
  check("心跳缺少 Origin 被 CSRF 拒绝（403）", heartbeatNoOrigin.status === 403 && codeOf(heartbeatNoOrigin) === "CSRF_REJECTED", describe(heartbeatNoOrigin));

  const anonymous = await api(null, "/api/devices");
  check("未登录访问设备中心返回 401 UNAUTHENTICATED", anonymous.status === 401 && codeOf(anonymous) === "UNAUTHENTICATED", describe(anonymous));

  /* ------------------------- 4. 会话撤销 --------------------------- */
  const revokeSelf = await api(QA_TOKENS.dev, `/api/devices/sessions/${LAPTOP_SESSION}/revoke`, { method: "POST" });
  check("撤销当前会话被拒（400 CANNOT_REVOKE_CURRENT_SESSION）", revokeSelf.status === 400 && codeOf(revokeSelf) === "CANNOT_REVOKE_CURRENT_SESSION", describe(revokeSelf));

  const revokePhoneSession = await api(QA_TOKENS.dev, `/api/devices/sessions/${PHONE_SESSION}/revoke`, { method: "POST" });
  check("撤销其他会话成功", revokePhoneSession.status === 200 && dataOf(revokePhoneSession)?.revoked === true, describe(revokePhoneSession));

  const phoneAfterSessionRevoke = await api(QA_TOKENS.phone, "/api/devices");
  check("被撤销会话再访问返回 401 SESSION_REVOKED", phoneAfterSessionRevoke.status === 401 && codeOf(phoneAfterSessionRevoke) === "SESSION_REVOKED", describe(phoneAfterSessionRevoke));

  /* -------------------- 5. 重新种入夹具后撤设备 -------------------- */
  console.log("[devices-qa] 重新写入本地 QA 夹具，验证设备撤销路径 …");
  seedQaFixtures();

  const phoneRestored = await api(QA_TOKENS.phone, "/api/devices");
  check("重新种入后手机会话恢复", phoneRestored.status === 200, describe(phoneRestored));

  const revokePhoneDevice = await api(QA_TOKENS.dev, `/api/devices/${PHONE_DEVICE}/revoke`, { method: "POST" });
  const revokedSessions = dataOf(revokePhoneDevice)?.revokedSessions;
  check("撤销其他设备成功且连带撤销会话", revokePhoneDevice.status === 200 && dataOf(revokePhoneDevice)?.revoked === true && Number(revokedSessions) >= 1, describe(revokePhoneDevice));

  const phoneAfterDeviceRevoke = await api(QA_TOKENS.phone, "/api/devices");
  check("被撤销设备的会话再访问返回 401", phoneAfterDeviceRevoke.status === 401 && ["SESSION_REVOKED", "DEVICE_REVOKED"].includes(codeOf(phoneAfterDeviceRevoke)), describe(phoneAfterDeviceRevoke));

  const overviewAfter = await api(QA_TOKENS.dev, "/api/devices");
  const afterOverview = dataOf(overviewAfter)?.overview;
  check("设备撤销后总览计数变化（1 active / 1 revoked）", afterOverview?.deviceCount === 1 && afterOverview?.revokedCount === 1, JSON.stringify(afterOverview ?? null));

  const revokeSelfDevice = await api(QA_TOKENS.dev, `/api/devices/${LAPTOP_DEVICE}/revoke`, { method: "POST" });
  check("撤销当前设备被拒（400 CANNOT_REVOKE_CURRENT）", revokeSelfDevice.status === 400 && codeOf(revokeSelfDevice) === "CANNOT_REVOKE_CURRENT", describe(revokeSelfDevice));

  const laptopStillWorks = await api(QA_TOKENS.dev, "/api/devices/current");
  check("当前设备在测试结束后仍可用", laptopStillWorks.status === 200, describe(laptopStillWorks));

  console.log(`\n[devices-qa] ${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    console.log(`[devices-qa] 失败项：\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("[devices-qa] 全部通过");
}

main().catch((error) => {
  console.error("[devices-qa] 运行失败：", error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});