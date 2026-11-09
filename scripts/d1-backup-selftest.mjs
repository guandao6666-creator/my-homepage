#!/usr/bin/env node
/**
 * D1 备份 Workflow Mock 测试。
 *
 * 这不是生产验证：
 * - 不调用 Cloudflare REST API；
 * - 不写 R2 / D1；
 * - 用 Mock fetch + Mock R2 执行与 Worker 相同的 runD1Backup 流程。
 *
 * 覆盖：
 * 发起导出 / bookmark / 轮询重试 / 下载 / 加密 / 上传 / 回读 SHA /
 * manifest / 失败状态 / Webhook 失败 / 密钥缺失 / 状态健康判断。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { runD1Backup } from "../worker/workflows/d1-backup-run.js";
import {
  STALE_MS,
  buildBackupAlert,
  evaluateBackupStatus,
  sanitizeError,
} from "../worker/workflows/d1-backup-core.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

const SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users (id) ON DELETE CASCADE);
CREATE INDEX idx_sessions_user ON sessions (user_id);
INSERT INTO users (id, email) VALUES ('u1', 'a@example.test');
INSERT INTO sessions (id, user_id) VALUES ('s1', 'u1');
`;
const KEY = randomBytes(32).toString("base64");

class MockR2 {
  constructor() {
    this.objects = new Map();
    this.failPutOnce = false;
    this.failSqlPut = false;
    this.corruptSqlRead = false;
  }
  async put(key, value) {
    if ((this.failPutOnce || this.failSqlPut) && key.endsWith(".sql.enc")) {
      this.failPutOnce = false;
      throw new Error("R2_PUT_FAILED");
    }
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    let out = bytes;
    if (this.corruptSqlRead && key.endsWith(".sql.enc")) {
      out = new Uint8Array(bytes);
      out[0] ^= 0xff;
    }
    return {
      async arrayBuffer() {
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      },
      async text() {
        return new TextDecoder().decode(out);
      },
    };
  }
  status() {
    const bytes = this.objects.get("logs/backup-status.json");
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  }
}

function makeStep() {
  const calls = [];
  const step = {
    async do(name, optionsOrFn, maybeFn) {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      const options = typeof optionsOrFn === "function" ? {} : optionsOrFn || {};
      const limit = Number(options.retries?.limit ?? 0);
      calls.push(name);
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fn();
        } catch (error) {
          if (attempt >= limit) throw error;
        }
      }
    },
  };
  return { step, calls };
}

function baseEnv(overrides = {}) {
  const r2 = new MockR2();
  return {
    env: {
      ACCOUNT_ID: "account-test",
      DATABASE_ID: "database-test",
      D1_REST_API_TOKEN: "token-test",
      BACKUP_ENCRYPTION_KEY: KEY,
      DB_BACKUPS: r2,
      BACKUP_ALERT_WEBHOOK: "https://hooks.example.test/backup",
      ...overrides,
    },
    r2,
  };
}

function installFetch({ statusMissingOnce = false, downloadStatus = 200, webhookStatus = 200 } = {}) {
  const state = { start: 0, poll: 0, download: 0, webhook: 0, statusMissingOnce };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/export")) {
      const body = JSON.parse(init.body || "{}");
      if (!body.current_bookmark) {
        assert.equal(body.output_format, "polling");
        state.start += 1;
        return new Response(JSON.stringify({ success: true, result: { at_bookmark: "bookmark-test" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(body.output_format, "polling");
      state.poll += 1;
      if (statusMissingOnce && state.poll === 1) {
        return new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { signed_url: "https://download.example.test/db.sql", filename: "guandao-db.sql" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.hostname === "download.example.test") {
      state.download += 1;
      return new Response(downloadStatus === 200 ? SQL : "download failed", {
        status: downloadStatus,
        headers: { "content-type": "text/plain" },
      });
    }
    if (u.hostname === "hooks.example.test") {
      state.webhook += 1;
      return new Response("", { status: webhookStatus });
    }
    throw new Error(`UNEXPECTED_FETCH:${u.hostname}`);
  };
  return { state, restore: () => { globalThis.fetch = original; } };
}

await check("1. 成功：发起导出 → bookmark → 下载 → 加密 → R2 → 回读 SHA → manifest", async () => {
  const { env, r2 } = baseEnv();
  const { step, calls } = makeStep();
  const fetchMock = installFetch();
  try {
    const result = await runD1Backup({
      env,
      event: { instanceId: "run-success", schedule: { cron: "0 19 * * *" } },
      step,
    });
    assert.equal(result.status, "success");
    const status = r2.status();
    assert.equal(status.lastRun.status, "success");
    assert.equal(status.lastRun.runId, "run-success");
    assert.equal(status.lastSuccessAt, status.lastRun.finishedAt);
    assert.match(status.lastRun.objectKey, /daily\/\d{4}\/\d{2}\/\d{2}\/run-success\.sql\.enc/);
    const manifest = JSON.parse(new TextDecoder().decode(r2.objects.get(status.lastRun.manifestKey)));
    assert.equal(manifest.verify.status, "sha256_match");
    assert.equal(manifest.bookmark, "bookmark-test");
    assert.equal(manifest.sql.sha256.length, 64);
    assert.equal(manifest.database.ref.startsWith("guandao-db/"), true);
    assert.equal(JSON.stringify(manifest).includes("token-test"), false);
    assert.equal(calls.includes("readback-verify-r2"), true);
    assert.equal(fetchMock.state.download, 1);
  } finally {
    fetchMock.restore();
  }
});

await check("2. 导出未就绪时 step 重试，第二次成功", async () => {
  const { env } = baseEnv();
  const { step } = makeStep();
  const fetchMock = installFetch({ statusMissingOnce: true });
  try {
    const result = await runD1Backup({ env, event: { instanceId: "run-retry" }, step });
    assert.equal(result.status, "success");
    assert.equal(fetchMock.state.poll, 2);
  } finally {
    fetchMock.restore();
  }
});

await check("3. 缺少 bookmark 时失败，并写入失败状态", async () => {
  const { env, r2 } = baseEnv();
  const { step } = makeStep();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    await assert.rejects(() => runD1Backup({ env, event: { instanceId: "run-no-bookmark" }, step }), /EXPORT_BOOKMARK_MISSING/);
    const status = r2.status();
    assert.equal(status.lastRun.status, "failed");
    assert.equal(status.lastRun.errorCode, "EXPORT_BOOKMARK_MISSING");
  } finally {
    globalThis.fetch = original;
  }
});

await check("4. 下载失败时失败，并写入失败状态", async () => {
  const { env, r2 } = baseEnv();
  const { step } = makeStep();
  const fetchMock = installFetch({ downloadStatus: 500 });
  try {
    await assert.rejects(() => runD1Backup({ env, event: { instanceId: "run-download-fail" }, step }), /DUMP_DOWNLOAD_500/);
    assert.equal(r2.status().lastRun.status, "failed");
    assert.equal(r2.status().lastRun.errorCode, "DUMP_DOWNLOAD_500");
  } finally {
    fetchMock.restore();
  }
});

await check("5. R2 上传失败时失败，并留下失败状态", async () => {
  const { env, r2 } = baseEnv();
  r2.failSqlPut = true;
  const { step } = makeStep();
  const fetchMock = installFetch();
  try {
    await assert.rejects(() => runD1Backup({ env, event: { instanceId: "run-r2-fail" }, step }), /R2_PUT_FAILED/);
    assert.equal(r2.status().lastRun.status, "failed");
  } finally {
    fetchMock.restore();
  }
});

await check("6. R2 回读 SHA-256 不一致时拒绝成功", async () => {
  const { env, r2 } = baseEnv();
  r2.corruptSqlRead = true;
  const { step } = makeStep();
  const fetchMock = installFetch();
  try {
    await assert.rejects(() => runD1Backup({ env, event: { instanceId: "run-sha-fail" }, step }), /R2_SHA256_MISMATCH/);
    assert.equal(r2.status().lastRun.status, "failed");
    assert.equal(r2.status().lastRun.errorCode, "R2_SHA256_MISMATCH");
  } finally {
    fetchMock.restore();
  }
});

await check("7. 告警 Webhook 失败不伪造送达，状态保留 notifyError", async () => {
  const { env, r2 } = baseEnv();
  const { step } = makeStep();
  const fetchMock = installFetch({ downloadStatus: 500, webhookStatus: 503 });
  try {
    await assert.rejects(() => runD1Backup({ env, event: { instanceId: "run-webhook-fail" }, step }), /DUMP_DOWNLOAD_500/);
    const status = r2.status();
    assert.equal(status.lastRun.notifiedAt, null);
    assert.match(status.lastRun.notifyError, /HTTP_503/);
  } finally {
    fetchMock.restore();
  }
});

await check("8. 缺少加密密钥时失败，并记录失败状态", async () => {
  const { env, r2 } = baseEnv({ BACKUP_ENCRYPTION_KEY: "" });
  const { step } = makeStep();
  const fetchMock = installFetch();
  try {
    await assert.rejects(
      () => runD1Backup({ env, event: { instanceId: "run-no-key" }, step }),
      /ENCRYPTION_KEY_MISSING/,
    );
    assert.equal(r2.status().lastRun.status, "failed");
    assert.equal(r2.status().lastRun.errorCode, "ENCRYPTION_KEY_MISSING");
  } finally {
    fetchMock.restore();
  }
});

await check("9. 状态判断：healthy / stale / failed / unknown", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const healthy = evaluateBackupStatus(
    { lastSuccessAt: new Date(now - 3600_000).toISOString(), lastRun: { status: "success" } },
    now,
  );
  assert.equal(healthy.state, "healthy");
  const stale = evaluateBackupStatus(
    { lastSuccessAt: new Date(now - STALE_MS - 1).toISOString(), lastRun: { status: "success" } },
    now,
  );
  assert.equal(stale.state, "stale");
  const failed = evaluateBackupStatus(
    { lastSuccessAt: null, lastRun: { status: "failed", errorCode: "X" } },
    now,
  );
  assert.equal(failed.state, "failed");
  assert.equal(evaluateBackupStatus(null, now).state, "unknown");
  assert.equal(evaluateBackupStatus({ lastSuccessAt: null, lastRun: null }, now).state, "unknown");
});

await check("10. 告警内容只含失败类型/时间/runId，不含敏感数据", () => {
  const alert = buildBackupAlert({ state: "failed", reason: "X", lastSuccessAt: null, lastRun: { runId: "r1" } });
  assert.equal(alert.code, "BACKUP_FAILED");
  assert.equal(alert.requiresHumanReview, undefined);
  const text = JSON.stringify(alert);
  assert.equal(text.includes("token"), false);
  assert.equal(text.includes("signed"), false);
  assert.equal(text.includes("SQL"), false);
  assert.equal(sanitizeError("Bearer abc123 token=xyz").includes("abc123"), false);
});

await check("11. 超过 26 小时触发 BACKUP_STALE critical 告警", () => {
  const stale = buildBackupAlert({
    state: "stale",
    lastSuccessAt: "2026-11-05T00:00:00.000Z",
    lastRun: { runId: "old-run" },
  });
  assert.equal(stale.code, "BACKUP_STALE");
  assert.equal(stale.severity, "critical");
  assert.match(stale.message, /26 小时/);
  const unknown = buildBackupAlert({ state: "unknown", lastSuccessAt: null, lastRun: null });
  assert.equal(unknown.code, "BACKUP_STATUS_UNKNOWN");
  assert.equal(unknown.severity, "warning");
});

const failed = results.filter((item) => !item.pass).length;
console.log(`\n[d1-backup] ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);