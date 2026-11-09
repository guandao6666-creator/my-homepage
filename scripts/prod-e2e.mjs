#!/usr/bin/env node
/**
 * Guandao OS 2.0 · 生产端到端验证（真实 Worker + 真实 D1 + 真实 R2 + 真实 Chrome）
 *
 * 为什么需要它：单元测试、E2E、同步联调都跑在本地；「线上到底能不能用」只有
 * 在 production 上真跑一遍才算数。本脚本：
 *
 *   1. 在线上 D1 建一个临时测试账号 + Session（不碰现有用户）；
 *   2. 用真实 HTTP 走完：登录态、云盘上传/下载/回收站、云同步（推送/索引/冲突）、
 *      备份创建/校验/下载/恢复、隐私审计、社区与插件公开接口；
 *   3. 用真实 Chrome 带 Cookie 打开 https://guandao.xin，验证客户端能拉到服务端笔记、
 *      系统设置显示已登录与真实配额；
 *   4. 另开无登录上下文验证 PWA 离线首访；
 *   5. 清理测试账号、数据与 R2 对象，并核对线上计数回到基线。
 *
 * 安全边界：
 *   - 只创建 qa-e2e-* 用户，所有查询带该 user_id；
 *   - Token 只在内存里，不写日志；
 *   - 结束时删除测试用户与对象；可用 E2E_KEEP=1 保留现场。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import {
  assertCleanupResourceCounts,
  assertDeleteCount,
  assertQaCleanupTarget,
  buildQaChildDeleteSql,
  buildQaUserDeleteSql,
} from "./lib/qa-cleanup.mjs";

const BASE = process.env.E2E_BASE || "https://guandao.xin";
const DB = "guandao-db";
const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const KEEP = process.env.E2E_KEEP === "1";

const stamp = Date.now().toString(36);
const USER_ID = `qa-e2e-${stamp}`;
const EMAIL = `${USER_ID}@example.test`;
const TOKEN = randomBytes(32).toString("base64url");
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const SESSION_ID = `qa-e2e-session-${stamp}`;
let SEEDED_AT = 0;

const results = [];
let failures = 0;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (pass) console.log(`  ok   ${name}${detail ? ` · ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  }
}

function d1(sql) {
  return execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DB, "--remote", "--command", sql],
    { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
}

function d1Json(sql) {
  const raw = d1(sql);
  const start = raw.indexOf("[");
  if (start < 0) throw new Error(`D1 输出无法解析：${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start))[0]?.results ?? [];
}

/** QA 清理审计事件：只写事件类型，不含用户内容/Token。 */
function logQaEvent(eventType) {
  try {
    d1(
      `INSERT INTO security_events (id, user_id, event_type, device_id, result, metadata_json, created_at)
       VALUES ('${randomUUID()}', NULL, '${eventType}', NULL, 'success', NULL, ${Date.now()});`,
    );
  } catch {
    /* 审计失败不阻塞清理 */
  }
}

function r2Delete(key) {
  try {
    spawnSync(
      process.execPath,
      [WRANGLER, "r2", "object", "delete", "guandao-files", key],
      { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
  } catch {
    /* 对象可能已经被接口删除 */
  }
}

async function api(path, { method = "GET", body, raw = false } = {}) {
  const headers = {
    accept: "application/json",
    cookie: `gauth_sid=${TOKEN}`,
    origin: BASE,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function seed() {
  const now = Date.now();
  SEEDED_AT = now;
  // github_id 必须是数字（D1 列是 INTEGER，带字母会直接 SQL 语法错误）
  const githubId = Number(`90${String(now).slice(-8)}`);
  d1(
    `INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_ID}', '${EMAIL}', 'QA E2E', 'active', ${now}, ${now}, ${githubId}, 'qa-e2e', NULL, 'member', ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('${SESSION_ID}', '${USER_ID}', '${TOKEN_HASH}', NULL, 'prod-e2e', ${now + 2 * 3600_000}, ${now}, ${now});`,
  );
}

/**
 * 驱动备份执行。
 *
 * 认证/联调时发现：`POST /api/backups` 只创建任务（status=collecting），
 * 真正执行要调用 `POST /api/backups/:id/run`（前端也是这么循环的）。
 * 这里按「run → 查状态」循环，直到 completed / failed。
 */
async function driveBackup(id, timeoutMs = 120_000) {
  const started = Date.now();
  let last = "unknown";
  while (Date.now() - started < timeoutMs) {
    const run = await api(`/api/backups/${id}/run`, { method: "POST", body: {} });
    if (run.status !== 200) {
      throw new Error(`备份执行失败：HTTP ${run.status} ${run.payload?.error?.code ?? ""}`);
    }
    const { payload } = await api(`/api/backups/${id}`);
    last = payload?.data?.backup?.status ?? last;
    if (last === "completed") return last;
    if (last === "failed") throw new Error(`备份失败：${payload?.data?.backup?.errorMessage || "未知"}`);
    await sleep(1200);
  }
  throw new Error(`备份超时（最后状态 ${last}）`);
}

async function cleanup() {
  if (KEEP) {
    console.log(`[e2e] E2E_KEEP=1，保留测试账号 ${USER_ID}`);
    return;
  }
  // 安全护栏（2.0 Phase 1 + 生产数据事故调查）：
  // 只允许清理 qa-e2e-* 测试账号；删除前必须重新读取并核对身份，
  // 任何不匹配、数量异常或资源超限都中止，绝不扩大条件。
  if (!USER_ID.startsWith("qa-e2e-") || !EMAIL.endsWith("@example.test")) {
    throw new Error(`清理中止：${USER_ID} 不是 qa-e2e-* 测试账号`);
  }
  console.log("[e2e] 清理测试数据…");
  logQaEvent("qa_cleanup_started");

  const targetRows = d1Json(
    `SELECT id, email, github_username, created_at FROM users WHERE id = '${USER_ID}'`,
  );
  const qaUserCount = Number(
    d1Json(
      `SELECT COUNT(*) AS n FROM users
        WHERE id LIKE 'qa-e2e-%' AND email LIKE 'qa-e2e-%@example.test'`,
    )[0]?.n ?? 0,
  );
  if (qaUserCount > 1) {
    throw new Error(`清理中止：匹配到 ${qaUserCount} 个 qa-e2e 账号，预期最多 1 个`);
  }

  let validated = null;
  if (targetRows.length === 1) {
    validated = assertQaCleanupTarget({
      enabled: true,
      marker: "prod-e2e",
      expectedMarker: "prod-e2e",
      runId: SESSION_ID,
      expectedRunId: SESSION_ID,
      userId: USER_ID,
      email: EMAIL,
      expectedUserId: USER_ID,
      expectedEmail: EMAIL,
      rows: targetRows,
      expectedUsername: "qa-e2e",
      createdAfter: SEEDED_AT - 5000,
    });
  } else if (targetRows.length > 1) {
    throw new Error(`清理中止：账号 ${USER_ID} 匹配到 ${targetRows.length} 行`);
  } else {
    console.warn("[e2e] 目标账号已不存在，跳过 users 删除（子表仍按 qa- 前缀清理）");
  }

  const resourceCounts = d1Json(
    `SELECT
       (SELECT COUNT(*) FROM files WHERE user_id = '${USER_ID}') AS files,
       (SELECT COUNT(*) FROM backups WHERE user_id = '${USER_ID}') AS backups,
       (SELECT COUNT(*) FROM sessions WHERE user_id = '${USER_ID}') AS sessions,
       (SELECT COUNT(*) FROM devices WHERE user_id = '${USER_ID}') AS devices,
       (SELECT COUNT(*) FROM security_events WHERE user_id = '${USER_ID}') AS events`,
  )[0];
  assertCleanupResourceCounts(resourceCounts, 1000);
  try {
    // 1. 通过接口删除备份（会清 R2 前缀）与云盘文件
    const list = await api("/api/backups?limit=100");
    const backups = list.payload?.data?.items ?? list.payload?.data?.backups ?? [];
    for (const item of backups) {
      await api(`/api/backups/${item.id}`, { method: "DELETE", body: { confirm: "DELETE" } });
    }
    const files = await api("/api/files?limit=100");
    const fileList = files.payload?.data?.files ?? files.payload?.data?.items ?? [];
    for (const file of fileList) {
      await api(`/api/files/${file.id}`, { method: "DELETE" });
    }
    await api("/api/files/trash/empty", { method: "POST", body: {} });
  } catch (error) {
    console.warn("[e2e] 接口清理部分失败：", error?.message ?? error);
  }

  // 2. 兜底：从 D1 取出仍存在的 R2 键并删除
  try {
    const keys = d1Json(
      `SELECT r2_key AS key FROM files WHERE user_id = '${USER_ID}'
       UNION ALL SELECT manifest_object_key FROM backups WHERE user_id = '${USER_ID}'
       UNION ALL SELECT data_object_key FROM backups WHERE user_id = '${USER_ID}'
       UNION ALL SELECT object_key FROM backup_items WHERE user_id = '${USER_ID}'`,
    );
    for (const row of keys) if (row.key) r2Delete(row.key);
  } catch (error) {
    console.warn("[e2e] R2 兜底清理失败：", error?.message ?? error);
  }

  // 3. 删除测试账号的数据库行：每条 SQL 都带 qa- 前缀条件，
  //    users 另带 email 条件；users 只在身份复核通过后删除。
  const statements = [
    buildQaChildDeleteSql("sync_entities", USER_ID),
    buildQaChildDeleteSql("sessions", USER_ID),
    buildQaChildDeleteSql("devices", USER_ID),
    buildQaChildDeleteSql("files", USER_ID),
    buildQaChildDeleteSql("folders", USER_ID),
    `DELETE FROM backup_restore_items WHERE restore_id IN (
       SELECT id FROM backup_restores WHERE user_id = '${USER_ID}' AND user_id LIKE 'qa-%'
     )`,
    buildQaChildDeleteSql("backup_restores", USER_ID),
    buildQaChildDeleteSql("backup_items", USER_ID),
    buildQaChildDeleteSql("backup_jobs", USER_ID),
    buildQaChildDeleteSql("backups", USER_ID),
    buildQaChildDeleteSql("security_events", USER_ID),
    buildQaChildDeleteSql("privacy_settings", USER_ID),
    buildQaChildDeleteSql("data_export_jobs", USER_ID),
    buildQaChildDeleteSql("data_exports", USER_ID),
    buildQaChildDeleteSql("data_deletion_jobs", USER_ID),
  ];
  console.log(`[e2e] 清理 ${statements.length} 张子表；users=${validated ? 1 : 0}`);
  for (const sql of statements) {
    d1(`${sql};`);
  }
  if (validated) {
    d1(`${buildQaUserDeleteSql({ userId: USER_ID, email: EMAIL })};`);
  }

  // 4. 删除后复核：目标 users 行必须为 0；不改用更宽的条件重试。
  const remaining = Number(
    d1Json(`SELECT COUNT(*) AS n FROM users WHERE id = '${USER_ID}'`)[0]?.n ?? 0,
  );
  assertDeleteCount(remaining, 0, "users");
  logQaEvent("qa_cleanup_completed");
}

async function main() {
  console.log(`[e2e] 目标：${BASE}`);
  console.log(`[e2e] 临时账号：${USER_ID}`);
  seed();

  let browser;
  try {
    /* ---------- 1. 认证 ---------- */
    const me = await api("/api/auth/me");
    const meUser = me.payload?.user ?? me.payload?.data?.user ?? null;
    check("测试 Session 有效", me.status === 200 && meUser?.id === USER_ID, `HTTP ${me.status}`);

    const devices = await api("/api/auth/devices");
    check("Session 列表可读", devices.status === 200, `HTTP ${devices.status}`);

    /* ---------- 2. 云盘 ---------- */
    const quota0 = await api("/api/files/quota");
    check("云盘配额可读", quota0.status === 200 && typeof quota0.payload?.data?.limitBytes === "number");

    const content = `Guandao OS 2.0 E2E ${stamp}\n时间：${new Date().toISOString()}\n`;
    const uploadUrl = `${BASE}/api/files/upload?name=${encodeURIComponent(`e2e-${stamp}.txt`)}`;
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        cookie: `gauth_sid=${TOKEN}`,
        origin: BASE,
        "content-type": "text/plain; charset=utf-8",
      },
      body: content,
    });
    const uploaded = await uploadResponse.json().catch(() => null);
    const fileId = uploaded?.data?.file?.id;
    check("文件上传成功", uploadResponse.status === 201 && Boolean(fileId), `HTTP ${uploadResponse.status}`);

    const listed = await api("/api/files?limit=20");
    const names = (listed.payload?.data?.files ?? listed.payload?.data?.items ?? []).map((file) => file.name);
    check("文件列表包含新文件", names.includes(`e2e-${stamp}.txt`), names.join(","));

    const contentResponse = await api(`/api/files/${fileId}/content`, { raw: true });
    const roundTrip = await contentResponse.text();
    check("文件内容原样读回", contentResponse.status === 200 && roundTrip === content, `${roundTrip.length} 字节`);

    const download = await api(`/api/files/${fileId}/download`, { raw: true });
    check(
      "下载带附件头",
      download.status === 200 && (download.headers.get("content-disposition") || "").includes("attachment"),
    );

    /* ---------- 3. 云同步 ---------- */
    const noteId = `qa-note-${stamp}`;
    const push = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "notes",
        changes: [
          {
            id: noteId,
            baseRevision: 0,
            updatedAt: Date.now(),
            payload: { title: "生产 E2E 笔记", body: "# 生产 E2E\n内容", folder: "inbox", tags: ["e2e"], pinned: false, createdAt: Date.now(), updatedAt: Date.now() },
          },
        ],
      },
    });
    check("同步推送成功", push.status === 200 && push.payload?.data?.applied?.length === 1);

    const index = await api("/api/sync/index?domain=notes");
    check("同步索引包含笔记", (index.payload?.data?.entities ?? []).some((entity) => entity.id === noteId));

    const stale = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "notes", changes: [{ id: noteId, baseRevision: 0, updatedAt: Date.now(), payload: { title: "覆盖尝试" } }] },
    });
    check("旧 revision 被拒绝（不覆盖）", (stale.payload?.data?.applied?.length ?? 0) === 0 && (stale.payload?.data?.conflicts?.length ?? 0) === 1);

    const pull = await api(`/api/sync/pull?domain=notes&ids=${noteId}`);
    check("同步拉取内容正确", pull.payload?.data?.changes?.[0]?.payload?.title === "生产 E2E 笔记");

    /* ---------- 4. 备份 ---------- */
    // 顺序很重要：两个备份都必须在删除文件之前创建，否则备份是空的，
    // 恢复也就没有东西可恢复（第一次跑就是这么失败的）。
    const protective = await api("/api/backups", {
      method: "POST",
      body: { name: `e2e-protective-${stamp}`, domains: ["drive"], type: "protective" },
    });
    const protectiveId = protective.payload?.data?.backup?.id;
    check("保护性备份已创建", [200, 201, 202].includes(protective.status), `HTTP ${protective.status}`);
    await driveBackup(protectiveId);
    const verifyA = await api(`/api/backups/${protectiveId}/verify`, { method: "POST", body: {} });
    check("保护性备份校验通过", verifyA.status === 200, `HTTP ${verifyA.status}`);

    const manual = await api("/api/backups", {
      method: "POST",
      body: { name: `e2e-manual-${stamp}`, domains: ["drive"], type: "manual" },
    });
    const manualId = manual.payload?.data?.backup?.id;
    check("手动备份已创建", Boolean(manualId), `HTTP ${manual.status}`);
    await driveBackup(manualId);

    const verifyB = await api(`/api/backups/${manualId}/verify`, { method: "POST", body: {} });
    check("手动备份校验通过", verifyB.status === 200);

    const jsonDownload = await api(`/api/backups/${manualId}/download?format=json`, { raw: true });
    const archive = await jsonDownload.json().catch(() => null);
    check(
      "备份 JSON 下载且含校验信息",
      jsonDownload.status === 200 && archive?.checksum?.algorithm === "sha256" && Boolean(archive?.manifest),
      `HTTP ${jsonDownload.status}`,
    );

    // 删除文件 + 清空回收站，制造真正的「需要恢复」场景
    await api(`/api/files/${fileId}`, { method: "DELETE" });
    await api("/api/files/trash/empty", { method: "POST", body: {} });
    const afterTrash = await api("/api/files?limit=20");
    check(
      "回收站清空后文件不可见",
      !(afterTrash.payload?.data?.files ?? afterTrash.payload?.data?.items ?? []).some((file) => file.id === fileId),
    );

    const restore = await api(`/api/backups/${manualId}/restore`, {
      method: "POST",
      body: { domains: ["drive"], mode: "copy", confirm: true, protectiveBackupId: protectiveId, idempotencyKey: `e2e-${stamp}` },
    });
    check("恢复任务已启动", restore.status === 200, `HTTP ${restore.status} · ${restore.payload?.error?.code ?? ""}`);
    const restoreStatus = restore.payload?.data?.restore?.status;
    const restoredFiles = restore.payload?.data?.restore?.stats?.filesRestored ?? 0;
    check("恢复完成并复制了文件", restoreStatus === "completed" && restoredFiles >= 1, `status=${restoreStatus} files=${restoredFiles}`);

    const afterRestore = await api("/api/files?limit=50");
    const restored = (afterRestore.payload?.data?.files ?? afterRestore.payload?.data?.items ?? []).find(
      (file) => file.name === `e2e-${stamp}.txt`,
    );
    check("恢复后文件重新出现", Boolean(restored));
    if (restored) {
      const restoredContent = await api(`/api/files/${restored.id}/content`, { raw: true });
      check("恢复后的文件内容一致", (await restoredContent.text()) === content);
    }

    /* ---------- 5. 备份下载防篡改（损坏对象） ---------- */
    // 不篡改生产对象；只验证路由对不存在的备份返回 404
    const missing = await api("/api/backups/does-not-exist/download?format=json", { raw: true });
    check("不存在的备份返回 404", missing.status === 404, `HTTP ${missing.status}`);

    /* ---------- 6. 隐私 / 社区 / 插件公开接口 ---------- */
    // 注意：安全事件在 /api/security/activity，/api/privacy 下是 overview / exports 等
    const audit = await api("/api/privacy/overview");
    check("隐私概览可读", audit.status === 200, `HTTP ${audit.status}`);
    const securityEvents = await api("/api/security/activity?limit=10");
    check("安全事件可读", securityEvents.status === 200, `HTTP ${securityEvents.status}`);
    const community = await api("/api/community/feed?limit=5");
    check("社区列表公开可读", community.status === 200, `HTTP ${community.status}`);
    const plugins = await api("/api/plugins?limit=5");
    check("插件市场公开可读", plugins.status === 200, `HTTP ${plugins.status}`);

    /* ---------- 7. 浏览器端到端（带登录 Cookie） ---------- */
    browser = await chromium.launch({ channel: "chrome" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: "gauth_sid", value: TOKEN, domain: "guandao.xin", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    await context.addInitScript(() => {
      const settings = { v: 2, at: Date.now(), data: { "system.mode": "cloud" } };
      localStorage.setItem("guandao.core.settings.v1", JSON.stringify(settings));
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 160)));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.GOS20_READY), null, { timeout: 45000 });
    await page.evaluate(() => window.GOS20_READY);
    const onboarding = page.locator(".os20-onb");
    if (await onboarding.count()) {
      await onboarding.locator("[data-onb-skip]").click();
      await page.waitForTimeout(400);
    }
    const boot = await page.evaluate(() => window.GOS20_READY);
    check("带登录态启动内核", boot?.stages?.length === 11, `${boot?.stages?.length} 阶段`);

    // 客户端应把服务端笔记同步下来
    let pulled = false;
    for (let i = 0; i < 30 && !pulled; i += 1) {
      await sleep(700);
      pulled = await page.evaluate((id) => {
        try {
          const raw = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}");
          return Array.isArray(raw.notes) && raw.notes.some((note) => note.id === id);
        } catch {
          return false;
        }
      }, noteId);
    }
    check("客户端从生产环境拉到同步笔记", pulled);

    // 同步是异步的：等 3 个域都进入 ok，而不是启动后立刻断言
    let syncState = [];
    for (let i = 0; i < 25; i += 1) {
      syncState = await page.evaluate(() => window.GOS20?.sync?.domains?.().map((item) => `${item.id}:${item.state}`) ?? []);
      if (syncState.length === 3 && syncState.every((item) => item.endsWith(":ok"))) break;
      await sleep(800);
    }
    check("三个同步域状态为 ok", syncState.length === 3 && syncState.every((item) => item.endsWith(":ok")), syncState.join(",") || "无已注册数据域");

    await page.evaluate(() => window.GOS14.ctx.openApp("systemcenter"));
    await page.waitForSelector('.window[data-app="systemcenter"] .g14-nav[data-tab="cloud"]', { timeout: 20000 });
    await page.locator('.window[data-app="systemcenter"] .g14-nav[data-tab="cloud"]').click();
    // 云端状态来自异步探测：最多等 20 秒，必要时点一次「重新检查」
    let cloudText = "";
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(800);
      cloudText = await page.locator('.window[data-app="systemcenter"]').innerText();
      if (/QA E2E|已登录/.test(cloudText)) break;
      if (i === 6) {
        await page.locator('.window[data-app="systemcenter"] [data-cloud-refresh]').click().catch(() => undefined);
      }
    }
    check("系统设置识别已登录账号", /QA E2E|已登录/.test(cloudText), cloudText.slice(0, 60).replace(/\s+/g, " "));

    // 配额是异步加载的（/api/files/quota），不能在账号出现后立刻断言
    const quotaPattern = /[\d.]+\s*(B|KB|MB|GB)\s*\/\s*[\d.]+\s*(B|KB|MB|GB)/;
    let quotaMatch = cloudText.match(quotaPattern);
    for (let i = 0; i < 15 && !quotaMatch; i += 1) {
      await page.waitForTimeout(600);
      cloudText = await page.locator('.window[data-app="systemcenter"]').innerText();
      quotaMatch = cloudText.match(quotaPattern);
    }
    check("系统设置显示真实云盘用量", Boolean(quotaMatch), quotaMatch?.[0] ?? "未匹配");
    await page.screenshot({ path: ".shots/prod-e2e-cloud.png" });
    check("浏览器无未捕获错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    await context.close();

    /* ---------- 8. PWA 离线 ---------- */
    const offlineContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const offlinePage = await offlineContext.newPage();
    await offlinePage.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => undefined);
    await offlinePage.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
    const swReady = await offlinePage
      .evaluate(async () => {
        if (!("serviceWorker" in navigator)) return "unsupported";
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return registration && navigator.serviceWorker.controller ? "active" : "no-controller";
      })
      .catch(() => "error");
    check("Service Worker 已激活并接管页面", swReady === "active", swReady);
    await offlineContext.setOffline(true);
    const offlineReload = await offlinePage.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    const offlineBody = await offlinePage.evaluate(() => ({
      os: Boolean(document.getElementById("os")),
      title: document.title,
    })).catch(() => ({ os: false, title: "" }));
    check("断网刷新仍能打开桌面", Boolean(offlineReload) && offlineBody.os, `title=${offlineBody.title}`);
    await offlineContext.close();
  } catch (error) {
    console.error("[e2e] 执行异常：", error?.stack ?? error);
    failures += 1;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await cleanup();

    // 清理后核对线上数据回到基线
    try {
      const row = d1Json(
        `SELECT COUNT(*) AS users FROM users WHERE id LIKE 'qa-e2e-%';
         SELECT COUNT(*) AS sessions FROM sessions WHERE id LIKE 'qa-e2e-%';
         SELECT COUNT(*) AS files FROM files WHERE user_id LIKE 'qa-e2e-%';
         SELECT COUNT(*) AS backups FROM backups WHERE user_id LIKE 'qa-e2e-%';`,
      );
      const counts = row.reduce((acc, item) => ({ ...acc, ...item }), {});
      check("清理后无残留测试数据", Object.values(counts).every((value) => Number(value) === 0), JSON.stringify(counts));
    } catch (error) {
      console.warn("[e2e] 残留检查失败：", error?.message ?? error);
    }
  }

  console.log("");
  if (failures) {
    console.error(`[e2e] ${results.length} 项中 ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log(`[e2e] 全部 ${results.length} 项通过（生产环境）`);
  }
}

main().catch((error) => {
  console.error("[e2e] 失败：", error?.message ?? error);
  process.exitCode = 1;
});