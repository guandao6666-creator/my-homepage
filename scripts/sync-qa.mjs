#!/usr/bin/env node
/**
 * Guandao OS 2.0 · 云同步 API 实测（本地 Worker + 本地 D1）
 *
 * 为什么需要它：同步是 2.0 唯一新增的「跨设备数据通道」，只靠单元测试
 * 验证不了一件事 —— 乐观锁、用户隔离、墓碑在真实 HTTP 上是否成立。
 *
 * 做法：
 *   1. 启动 `wrangler dev --local`（本地 D1 已迁移）；
 *   2. 直接往本地 D1 插入两个测试用户 + Session（不经过 GitHub OAuth）；
 *   3. 用 Cookie 调 /api/sync/*，断言：
 *      - 状态 / 索引 / 拉取；
 *      - 首次推送、基于旧 revision 的推送必须返回冲突且不覆盖；
 *      - 基于正确 revision 的更新；
 *      - 删除墓碑；
 *      - 用户 A 的数据对用户 B 不可见；
 *   4. 清理测试数据并关闭 Worker。
 *
 * 需要本机 Chrome 之外的依赖：只用 Node + wrangler（已在本项目 devDependencies）。
 * 不接触 Cloudflare 线上资源。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const PORT = Number(process.env.SYNC_QA_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "guandao-db";
const TOKEN = randomBytes(32).toString("base64url");
const TOKEN2 = randomBytes(32).toString("base64url");
const USER_A = "qa-sync-user-a";
const USER_B = "qa-sync-user-b";

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
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });
}

function seedUsers() {
  const now = Date.now();
  const expires = now + 60 * 60 * 1000;
  d1(
    `INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_A}', 'qa-sync-a@example.test', 'QA Sync A', 'active', ${now}, ${now}, 910000001, 'qa-sync-a', NULL, 'member', ${now});
     INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER_B}', 'qa-sync-b@example.test', 'QA Sync B', 'active', ${now}, ${now}, 910000002, 'qa-sync-b', NULL, 'member', ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-a', '${USER_A}', '${sha256(TOKEN)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-session-b', '${USER_B}', '${sha256(TOKEN2)}', NULL, 'sync-qa', ${expires}, ${now}, ${now});`,
  );
}

function cleanup() {
  try {
    d1(
      `DELETE FROM sync_entities WHERE user_id IN ('${USER_A}', '${USER_B}') AND user_id LIKE 'qa-%';
       DELETE FROM sessions WHERE user_id IN ('${USER_A}', '${USER_B}') AND user_id LIKE 'qa-%';
       DELETE FROM security_events WHERE user_id IN ('${USER_A}', '${USER_B}') AND user_id LIKE 'qa-%';
       DELETE FROM users WHERE id IN ('${USER_A}', '${USER_B}')
         AND id LIKE 'qa-%' AND email LIKE 'qa-%@example.test';`,
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
  console.log("[sync-qa] 准备本地 D1 测试用户…");
  seedUsers();

  console.log(`[sync-qa] 启动 wrangler dev --local（:${PORT}）…`);
  const child = spawn(process.execPath, [WRANGLER, "dev", "--local", "--port", String(PORT)], {
    stdio: "ignore",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });

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
    check(
      "三个数据域都在",
      Array.isArray(status.payload?.data?.domains) && status.payload.data.domains.length === 3,
      (status.payload?.data?.domains ?? []).map((domain) => domain.domain).join(","),
    );
    check(
      "初始条目为 0",
      (status.payload?.data?.domains ?? []).every((domain) => domain.count === 0),
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