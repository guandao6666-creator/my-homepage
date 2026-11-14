#!/usr/bin/env node
/**
 * Guandao OS 2.0 · 云同步 API 实测（本地 Worker + 本地 D1）
 *
 * 为什么需要它：同步是 2.0 唯一新增的「跨设备数据通道」，只靠单元测试
 * 验证不了一件事 —— 乐观锁、用户隔离、墓碑在真实 HTTP 上是否成立。
 *
 * 做法：
 *   1. 应用本地 D1 迁移，启动 `wrangler dev --local --test-scheduled`；
 *   2. 直接往本地 D1 插入测试用户 + Session（不经过 GitHub OAuth）；
 *   3. 用 Cookie 调 /api/sync/*，断言：
 *      - 状态 / 索引 / 拉取（含 Phase 4 的 workspace / preferences 两个新域）；
 *      - 首次推送、基于旧 revision 的推送必须返回冲突且不覆盖；
 *      - 基于正确 revision 的更新、删除墓碑（含 deletedAt）；
 *      - 用户 A 的数据对用户 B 不可见；
 *      - 配额：预置满额的账号推送新实体返回 409 QUOTA_EXCEEDED；
 *      - 墓碑 TTL：预置过期/未过期墓碑，触发 /__scheduled 后过期墓碑被物理清理，
 *        台账保留、未过期墓碑保留、旧 baseRevision 重推被防复活逻辑拦下；
 *        再触发一次必须幂等（清理日志 purged=0）。
 *   4. 清理测试数据并关闭 Worker。
 *
 * 需要本机 Chrome 之外的依赖：只用 Node + wrangler（已在本项目 devDependencies）。
 * 不接触 Cloudflare 线上资源。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
// wrangler 在部分 Windows / CI 环境需要可写的 TEMP；统一指向仓库内临时目录，避免污染系统 TEMP。
const TMPDIR = join(process.cwd(), ".wrangler", "tmpdir");
mkdirSync(TMPDIR, { recursive: true });
const WRANGLER_ENV = {
  ...process.env,
  TEMP: TMPDIR,
  TMP: TMPDIR,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};

const PORT = Number(process.env.SYNC_QA_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "guandao-db";
const TOKEN = randomBytes(32).toString("base64url");
const TOKEN2 = randomBytes(32).toString("base64url");
const TOKEN3 = randomBytes(32).toString("base64url");
const TOKEN4 = randomBytes(32).toString("base64url");
const USER_A = "qa-sync-user-a";
const USER_B = "qa-sync-user-b";
const USER_C = "qa-sync-user-c";
const USER_D = "qa-sync-user-d";
const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTA_FIXTURE_ROWS = 5000;

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

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function d1(sql) {
  execFileSync(process.execPath, [WRANGLER, "d1", "execute", DB, "--local", "--command", sql], {
    stdio: "ignore",
    env: WRANGLER_ENV,
  });
}

/** 执行一条只读 SQL 并以数组返回结果行（用于清理台账/日志断言）。 */
function d1Rows(sql) {
  const stdout = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DB, "--local", "--json", "--command", sql],
    { encoding: "utf8", env: WRANGLER_ENV, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

/** 本地 D1 迁移：CI 里前面已经跑过，这里是本地直接 `npm run qa:sync` 时的自包含兜底。 */
function applyMigrations() {
  try {
    execFileSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", DB, "--local"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      env: WRANGLER_ENV,
    });
  } catch (error) {
    throw new Error(`本地 D1 迁移应用失败：${String(error?.stderr || error?.message || error).trim()}`);
  }
}

function seedUsers() {
  const now = Date.now();
  const expires = now + 60 * 60 * 1000;
  // 同一本地库可能保留上一轮失败运行的残留数据：先清掉 qa-sync 前缀的同步数据。
  d1(
    `DELETE FROM sync_entities WHERE user_id LIKE 'qa-sync-%';
     DELETE FROM sync_tombstone_ledger WHERE user_id LIKE 'qa-sync-%';
     DELETE FROM users WHERE id IN ('${USER_A}', '${USER_B}', '${USER_C}', '${USER_D}')
       AND id LIKE 'qa-sync-%';
     DELETE FROM sessions WHERE user_id LIKE 'qa-sync-%',
     DELETE FROM security_events WHERE user_id LIKE 'qa-sync-%';`.replace(
      "DELETE FROM sessions WHERE user_id LIKE 'qa-sync-%',",
      "DELETE FROM sessions WHERE user_id LIKE 'qa-sync-%';",
    ),
  );
  d1(
    `INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_A}', 'qa-sync-a@example.test', 'QA Sync A', 'active', ${now}, ${now}, 910000001, 'qa-sync-a', NULL, 'member', ${now});
     INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_B}', 'qa-sync-b@example.test', 'QA Sync B', 'active', ${now}, ${now}, 910000002, 'qa-sync-b', NULL, 'member', ${now});
     INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_C}', 'qa-sync-c@example.test', 'QA Sync C', 'active', ${now}, ${now}, 910000003, 'qa-sync-c', NULL, 'member', ${now});
     INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_D}', 'qa-sync-d@example.test', 'QA Sync D', 'active', ${now}, ${now}, 910000004, 'qa-sync-d', NULL, 'member', ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-a', '${USER_A}', '${sha256(TOKEN)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-b', '${USER_B}', '${sha256(TOKEN2)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-c', '${USER_C}', '${sha256(TOKEN3)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-d', '${USER_D}', '${sha256(TOKEN4)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});`,
  );

  // 配额用例：C 预置满额（5000 条活实体），用递归 CTE 一条 SQL 完成，避免 5000 次 CLI 往返。
  d1(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${QUOTA_FIXTURE_ROWS})
     INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
     SELECT '${USER_C}', 'notes', 'quota-' || n, 1, 0, '{"title":"quota ' || n || '"}', 1000 + n, NULL FROM seq;`,
  );

  // 墓碑 TTL 用例：D 预置一条过期（91 天前）和一条未过期（10 天前）墓碑。
  const expiredAt = now - 91 * DAY_MS;
  const freshAt = now - 10 * DAY_MS;
  d1(
    `INSERT OR REPLACE INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
     VALUES ('${USER_D}', 'notes', 'tomb-expired', 5, 1, NULL, ${expiredAt}, ${expiredAt});
     INSERT OR REPLACE INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
     VALUES ('${USER_D}', 'notes', 'tomb-fresh', 4, 1, NULL, ${freshAt}, ${freshAt});`,
  );
}

function cleanup() {
  try {
    d1(
      `DELETE FROM sync_entities WHERE user_id LIKE 'qa-sync-%';
       DELETE FROM sync_tombstone_ledger WHERE user_id LIKE 'qa-sync-%';
       DELETE FROM sessions WHERE user_id LIKE 'qa-sync-%';
       DELETE FROM security_events WHERE user_id LIKE 'qa-sync-%';
       DELETE FROM users WHERE id LIKE 'qa-sync-%' AND email LIKE 'qa-sync-%@example.test';`,
    );
  } catch (error) {
    console.warn("[sync-qa] 清理失败（本地数据，可手动删除）：", error?.message ?? error);
  }
}

async function api(path, { method = "GET", body, token = TOKEN } = {}) {
  const headers = { accept: "application/json", cookie: `gauth_sid=${token}`, origin: BASE };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function waitForWorker(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { headers: { accept: "application/json" } });
      if (response.status === 200 || response.status === 503) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(1000);
  }
  return false;
}

/** 轮询直到 probe 返回真值（返回该值），超时返回 null。 */
async function waitFor(probe, { timeoutMs = 30_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* 继续重试 */
    }
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** 触发一次 Cron（wrangler dev --test-scheduled 提供）；用 15 分钟 cron 避开 19:00 的 Workflow 分支。 */
async function triggerScheduled() {
  const cron = encodeURIComponent("*/15 * * * *");
  const response = await fetch(`${BASE}/__scheduled?cron=${cron}`);
  return { status: response.status, text: await response.text().catch(() => "") };
}

const note = (id, title, updatedAt) => ({
  id,
  title,
  body: `# ${title}`,
  folder: "inbox",
  tags: ["qa"],
  pinned: false,
  createdAt: updatedAt,
  updatedAt,
});

async function main() {
  console.log("[sync-qa] 应用本地 D1 迁移…");
  applyMigrations();

  console.log("[sync-qa] 准备本地 D1 测试用户…");
  seedUsers();

  console.log(`[sync-qa] 启动 wrangler dev --local --test-scheduled（:${PORT}）…`);
  const child = spawn(
    process.execPath,
    [WRANGLER, "dev", "--local", "--port", String(PORT), "--test-scheduled"],
    {
      stdio: "ignore",
      env: WRANGLER_ENV,
    },
  );

  const stop = () => {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* 已退出 */
    }
  };

  try {
    const ready = await waitForWorker();
    if (!ready) throw new Error("Worker 未在 90 秒内就绪");
    console.log("[sync-qa] Worker 就绪，开始断言");

    /* 1. 空状态 */
    const status = await api("/api/sync/status");
    check("状态接口 200", status.status === 200, `HTTP ${status.status}`);
    const domains = status.payload?.data?.domains ?? [];
    check(
      "五个数据域都在",
      domains.length === 5 &&
        ["notes", "tasks", "calendar", "workspace", "preferences"].every((id) =>
          domains.some((domain) => domain.domain === id),
        ),
      domains.map((domain) => domain.domain).join(","),
    );
    check(
      "初始条目为 0",
      domains.every((domain) => domain.count === 0),
    );
    const quotas = status.payload?.data?.quotas ?? {};
    check(
      "状态接口返回配额",
      quotas.entityCount === 0 &&
        quotas.tombstoneCount === 0 &&
        quotas.limits?.maxEntities === 5000 &&
        quotas.limits?.maxTombstones === 2000,
      JSON.stringify(quotas),
    );

    /* 2. 首次推送 */
    const now = Date.now();
    const push1 = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "notes", changes: [{ id: "n1", baseRevision: 0, updatedAt: now, payload: note("n1", "第一条", now) }] },
    });
    check("首次推送 200", push1.status === 200, `HTTP ${push1.status}`);
    check("首次推送 applied=1", push1.payload?.data?.applied?.length === 1);
    check("首次推送 revision=1", push1.payload?.data?.applied?.[0]?.revision === 1);

    /* 3. 索引与拉取 */
    const index = await api("/api/sync/index?domain=notes");
    check("索引包含 n1", index.payload?.data?.entities?.[0]?.id === "n1");
    const pull = await api("/api/sync/pull?domain=notes&ids=n1");
    check("按 id 拉取到内容", pull.payload?.data?.changes?.[0]?.payload?.title === "第一条");

    /* 4. 旧 revision 推送必须冲突且不覆盖 */
    const pushStale = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "notes",
        changes: [{ id: "n1", baseRevision: 0, updatedAt: now + 10, payload: note("n1", "并发覆盖", now + 10) }],
      },
    });
    check("旧 revision 被拒绝", pushStale.payload?.data?.applied?.length === 0);
    check("冲突返回服务端版本", pushStale.payload?.data?.conflicts?.[0]?.payload?.title === "第一条");
    const afterStale = await api("/api/sync/pull?domain=notes&ids=n1");
    check(
      "冲突没有覆盖服务端数据",
      afterStale.payload?.data?.changes?.[0]?.payload?.title === "第一条",
    );

    /* 5. 正确 revision 更新 */
    const push2 = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "notes",
        changes: [{ id: "n1", baseRevision: 1, updatedAt: now + 20, payload: note("n1", "已更新", now + 20) }],
      },
    });
    check("正确 revision 更新成功", push2.payload?.data?.applied?.[0]?.revision === 2);
    check("更新后的内容", push2.payload?.data?.applied?.[0]?.payload?.title === "已更新");

    /* 6. 墓碑 */
    const pushDelete = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "notes", changes: [{ id: "n1", baseRevision: 2, deleted: true, updatedAt: now + 30 }] },
    });
    check("删除写入墓碑", pushDelete.payload?.data?.applied?.[0]?.deleted === true);
    check(
      "删除墓碑带 deletedAt",
      typeof pushDelete.payload?.data?.applied?.[0]?.deletedAt === "number",
    );
    const afterDelete = await api("/api/sync/pull?domain=notes&ids=n1");
    check("墓碑在拉取中可见", afterDelete.payload?.data?.changes?.[0]?.deleted === true);

    /* 7. 增量拉取 */
    const incremental = await api(`/api/sync/pull?domain=notes&since=${now + 25}`);
    check("增量拉取只返回新变更", incremental.payload?.data?.changes?.length === 1);

    /* 8. 用户隔离 */
    const otherIndex = await api("/api/sync/index?domain=notes", { token: TOKEN2 });
    check("另一个账号看不到这些数据", (otherIndex.payload?.data?.entities ?? []).length === 0);

    /* 9. 未登录与非法域 */
    const anon = await fetch(`${BASE}/api/sync/index?domain=notes`, { headers: { accept: "application/json" } });
    check("未登录返回 401", anon.status === 401, `HTTP ${anon.status}`);
    const badDomain = await api("/api/sync/index?domain=passwords");
    check("非法数据域返回 400", badDomain.status === 400, `HTTP ${badDomain.status}`);
    const badBatch = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "notes", changes: [{ id: "x".repeat(200), payload: {} }] },
    });
    check("非法 id 返回 400", badBatch.status === 400, `HTTP ${badBatch.status}`);

    /* 10. Phase 4：workspace / preferences 两个新域 */
    const now2 = Date.now();
    const pushWorkspace = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "workspace",
        changes: [
          {
            id: "w1",
            baseRevision: 0,
            updatedAt: now2,
            payload: { title: "工作台布局", widgets: ["notes", "tasks"], updatedAt: now2 },
          },
        ],
      },
    });
    check(
      "workspace 首次推送成功",
      pushWorkspace.status === 200 && pushWorkspace.payload?.data?.applied?.[0]?.revision === 1,
      `HTTP ${pushWorkspace.status}`,
    );
    const workspaceIndex = await api("/api/sync/index?domain=workspace");
    check("workspace 索引包含 w1", workspaceIndex.payload?.data?.entities?.[0]?.id === "w1");
    const workspacePull = await api("/api/sync/pull?domain=workspace&ids=w1");
    check(
      "workspace 拉取到内容",
      workspacePull.payload?.data?.changes?.[0]?.payload?.title === "工作台布局",
    );
    const pushWorkspaceDelete = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "workspace", changes: [{ id: "w1", baseRevision: 1, deleted: true, updatedAt: now2 + 10 }] },
    });
    check(
      "workspace 删除墓碑带 deletedAt",
      pushWorkspaceDelete.payload?.data?.applied?.[0]?.deleted === true &&
        typeof pushWorkspaceDelete.payload?.data?.applied?.[0]?.deletedAt === "number",
    );

    // workspace 上限 128KB：100KB 内容必须能推；同样内容在 preferences（32KB）必须 400。
    const bigPayload = { blob: "x".repeat(100 * 1024) };
    const pushBigWorkspace = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "workspace",
        changes: [{ id: "w2", baseRevision: 0, updatedAt: now2 + 20, payload: bigPayload }],
      },
    });
    check(
      "workspace 100KB 内容可推送",
      pushBigWorkspace.status === 200 && pushBigWorkspace.payload?.data?.applied?.[0]?.revision === 1,
      `HTTP ${pushBigWorkspace.status}`,
    );

    const pushPreferences = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "preferences",
        changes: [{ id: "p1", baseRevision: 0, updatedAt: now2 + 30, payload: { theme: "dark", density: "compact" } }],
      },
    });
    check(
      "preferences 首次推送成功",
      pushPreferences.status === 200 && pushPreferences.payload?.data?.applied?.[0]?.revision === 1,
      `HTTP ${pushPreferences.status}`,
    );
    const preferencesPull = await api("/api/sync/pull?domain=preferences&ids=p1");
    check(
      "preferences 拉取到内容",
      preferencesPull.payload?.data?.changes?.[0]?.payload?.theme === "dark",
    );
    const pushPreferencesTooLarge = await api("/api/sync/push", {
      method: "POST",
      body: {
        domain: "preferences",
        changes: [{ id: "p2", baseRevision: 0, updatedAt: now2 + 40, payload: { blob: "x".repeat(40 * 1024) } }],
      },
    });
    check(
      "preferences 超过 32KB 返回 400",
      pushPreferencesTooLarge.status === 400 &&
        pushPreferencesTooLarge.payload?.error?.code === "PAYLOAD_TOO_LARGE",
      `HTTP ${pushPreferencesTooLarge.status}`,
    );
    const pushUnknownDomain = await api("/api/sync/push", {
      method: "POST",
      body: { domain: "passwords", changes: [{ id: "x1", baseRevision: 0, updatedAt: now2, payload: {} }] },
    });
    check(
      "推送未知数据域返回 400",
      pushUnknownDomain.status === 400 && pushUnknownDomain.payload?.error?.code === "UNKNOWN_DOMAIN",
      `HTTP ${pushUnknownDomain.status}`,
    );

    /* 11. Phase 4：配额（C 预置 5000 条活实体） */
    const quotaPush = await api("/api/sync/push", {
      method: "POST",
      token: TOKEN3,
      body: {
        domain: "notes",
        changes: [{ id: "quota-new", baseRevision: 0, updatedAt: now2 + 50, payload: note("quota-new", "超额", now2 + 50) }],
      },
    });
    check(
      "实体配额超限返回 409",
      quotaPush.status === 409 && quotaPush.payload?.error?.code === "QUOTA_EXCEEDED",
      `HTTP ${quotaPush.status}`,
    );
    check("配额错误指明 entities 范围", quotaPush.payload?.error?.details?.scope === "entities");
    const quotaStatus = await api("/api/sync/status", { token: TOKEN3 });
    check(
      "配额统计包含 5000 条活实体",
      quotaStatus.payload?.data?.quotas?.entityCount === QUOTA_FIXTURE_ROWS,
      JSON.stringify(quotaStatus.payload?.data?.quotas),
    );

    /* 12. Phase 4：墓碑 TTL 清理 + 防复活（D 预置过期/未过期墓碑） */
    const beforeCleanup = await api("/api/sync/pull?domain=notes&ids=tomb-expired,tomb-fresh", {
      token: TOKEN4,
    });
    check("清理前两个墓碑都在", (beforeCleanup.payload?.data?.changes ?? []).length === 2);
    const logIdBefore = Number(
      d1Rows("SELECT COALESCE(MAX(id), 0) AS id FROM sync_cleanup_log")[0]?.id,
    ) || 0;

    const trigger1 = await triggerScheduled();
    check("__scheduled 触发清理返回 200", trigger1.status === 200, `HTTP ${trigger1.status}`);
    const cleaned = await waitFor(
      async () => {
        const response = await api("/api/sync/pull?domain=notes&ids=tomb-expired", { token: TOKEN4 });
        return (response.payload?.data?.changes ?? []).length === 0;
      },
      { timeoutMs: 45_000 },
    );
    check("过期墓碑被定时清理", cleaned === true);
    const afterCleanup = await api("/api/sync/pull?domain=notes&ids=tomb-expired,tomb-fresh", {
      token: TOKEN4,
    });
    check(
      "未过期墓碑保留",
      (afterCleanup.payload?.data?.changes ?? []).length === 1 &&
        afterCleanup.payload?.data?.changes?.[0]?.id === "tomb-fresh",
    );
    const ledgerRows = d1Rows(
      `SELECT entity_id, revision FROM sync_tombstone_ledger
        WHERE user_id = '${USER_D}' AND entity_id = 'tomb-expired'`,
    );
    check(
      "清理后台账保留（防复活依据）",
      ledgerRows.length === 1 && Number(ledgerRows[0].revision) === 5,
      JSON.stringify(ledgerRows),
    );

    const firstLogRows = await waitFor(
      async () => {
        const rows = d1Rows("SELECT id, status, scanned, purged FROM sync_cleanup_log ORDER BY id DESC LIMIT 1");
        if (!rows.length) return null;
        const row = rows[0];
        if (Number(row.id) <= logIdBefore) return null;
        if (row.status !== "ok" || Number(row.purged) < 1) return null;
        return rows;
      },
      { timeoutMs: 30_000, intervalMs: 1000 },
    );
    check("清理日志记录本次清理", Boolean(firstLogRows), JSON.stringify(firstLogRows ?? []));
    const firstLogId = Number(firstLogRows?.[0]?.id) || 0;

    const resurrect = await api("/api/sync/push", {
      method: "POST",
      token: TOKEN4,
      body: {
        domain: "notes",
        changes: [
          { id: "tomb-expired", baseRevision: 0, updatedAt: now2 + 60, payload: note("tomb-expired", "复活", now2 + 60) },
        ],
      },
    });
    check(
      "旧 baseRevision 重推被拒（防复活）",
      resurrect.payload?.data?.applied?.length === 0 &&
        resurrect.payload?.data?.conflicts?.[0]?.deleted === true &&
        resurrect.payload?.data?.conflicts?.[0]?.revision === 5,
      JSON.stringify(resurrect.payload?.data?.conflicts),
    );
    const recreate = await api("/api/sync/push", {
      method: "POST",
      token: TOKEN4,
      body: {
        domain: "notes",
        changes: [
          { id: "tomb-expired", baseRevision: 5, updatedAt: now2 + 70, payload: note("tomb-expired", "重建", now2 + 70) },
        ],
      },
    });
    check(
      "基于台账 revision 可显式重建",
      recreate.payload?.data?.applied?.[0]?.revision === 6,
      JSON.stringify(recreate.payload?.data?.applied),
    );

    const trigger2 = await triggerScheduled();
    check("第二次触发清理返回 200", trigger2.status === 200, `HTTP ${trigger2.status}`);
    const idempotent = await waitFor(
      async () => {
        const rows = d1Rows("SELECT id, purged, status FROM sync_cleanup_log ORDER BY id DESC LIMIT 1");
        if (!rows.length) return null;
        const row = rows[0];
        return Number(row.id) > firstLogId && row.status === "ok" && Number(row.purged) === 0;
      },
      { timeoutMs: 45_000, intervalMs: 1500 },
    );
    check("重复清理幂等（purged=0）", idempotent === true);
    const freshStillThere = await api("/api/sync/pull?domain=notes&ids=tomb-fresh", { token: TOKEN4 });
    check(
      "清理后未过期墓碑仍在",
      (freshStillThere.payload?.data?.changes ?? []).length === 1,
    );
  } finally {
    stop();
    cleanup();
  }

  console.log("");
  if (failures) {
    console.error(`[sync-qa] ${results.length} 项中 ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log(`[sync-qa] 全部 ${results.length} 项通过`);
  }
}

main().catch((error) => {
  console.error("[sync-qa] 失败：", error?.message ?? error);
  process.exitCode = 1;
});
