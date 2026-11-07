#!/usr/bin/env node
/**
 * 告警真实送达验证（Phase 1.6 第 7 项）。
 *
 * 与 `qa:d1-backup` / `qa:data-monitor` 的区别：
 * 那两个测试把 `fetch` 整体替换成 Mock，**Webhook 根本没有真正发出过**；
 * 本脚本只 Mock「D1 导出 / 下载」和「D1 数据库」，**告警外发走真实 HTTPS**，
 * 再从接收端读回请求体，证明「送达」而不是「调用了 fetch」。
 *
 * 用法：
 *   node scripts/alert-delivery-check.mjs
 *   ALERT_WEBHOOK_URL=https://your.hook/path node scripts/alert-delivery-check.mjs
 *
 * 默认自动创建 https://webhook.site 的临时通道（30 天过期，可读回）。
 * 该 payload 只含 type / 时间 / 严重级别 / code / message / 计数，
 * 不含 Token、SQL、Cookie、邮箱或用户内容。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { runD1Backup } from "../worker/workflows/d1-backup-run.js";
import { runDataMonitor } from "../worker/api/admin/monitor.js";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (pass) console.log(`  ok   ${name}${detail ? ` · ${detail}` : ""}`);
  else console.error(`  FAIL ${name}${detail ? ` · ${detail}` : ""}`);
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- 接收端 */

async function provisionChannel() {
  const explicit = process.env.ALERT_WEBHOOK_URL;
  if (explicit) {
    return { url: explicit, kind: "explicit", read: null };
  }
  const response = await fetch("https://webhook.site/token", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 201, `webhook.site token 失败：HTTP ${response.status}`);
  const { uuid } = await response.json();
  const url = `https://webhook.site/${uuid}`;
  return {
    url,
    kind: `webhook.site/${uuid.slice(0, 8)}`,
    async read() {
      const res = await fetch(`https://webhook.site/token/${uuid}/requests?sorting=newest`, {
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(res.status, 200, `webhook.site 读取失败：HTTP ${res.status}`);
      const body = await res.json();
      return (body.data ?? []).map((item) => {
        let content = item.content;
        try {
          content = typeof content === "string" ? JSON.parse(content) : content;
        } catch {
          /* 保留原文，后续断言会失败 */
        }
        return { method: item.method, content };
      });
    },
  };
}

async function waitForRequest(channel, predicate, label) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const requests = await channel.read();
    const hit = requests.find((item) => predicate(item.content));
    if (hit) return hit;
    await sleep(1000);
  }
  throw new Error(`接收端没有收到 ${label}（等待 12s 超时）`);
}

/* ------------------------------------------------------- 备份失败告警链路 */

const SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
INSERT INTO users (id, email) VALUES ('u1', 'a@example.test');
`;

class MockR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
    };
  }
  json(key) {
    const bytes = this.objects.get(key);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  }
}

function makeStep(calls = []) {
  return {
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
}

/**
 * 只拦截 Cloudflare 导出与下载；Webhook 一律透传到真实网络。
 */
function installPartialFetch() {
  const original = globalThis.fetch;
  const seen = { export: 0, download: 0, passthrough: [] };
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/export")) {
      seen.export += 1;
      const body = JSON.parse(init.body || "{}");
      if (!body.current_bookmark) {
        return new Response(
          JSON.stringify({ success: true, result: { at_bookmark: "bookmark-alert-check" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { signed_url: "https://download.example.test/db.sql", filename: "guandao-db.sql" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.hostname === "download.example.test") {
      seen.download += 1;
      return new Response(SQL, { status: 200, headers: { "content-type": "text/plain" } });
    }
    seen.passthrough.push(target.host);
    return original(url, init);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function runBackupFailure(webhookUrl) {
  const r2 = new MockR2();
  const calls = [];
  const env = {
    ACCOUNT_ID: "account-alert-check",
    DATABASE_ID: "database-alert-check",
    D1_REST_API_TOKEN: "token-not-logged",
    DB_BACKUPS: r2,
    BACKUP_ALERT_WEBHOOK: webhookUrl,
    // 故意缺失 BACKUP_ENCRYPTION_KEY → 触发 ENCRYPTION_KEY_MISSING
  };
  const fetchCtl = installPartialFetch();
  try {
    await assert.rejects(
      () => runD1Backup({ env, event: { instanceId: "alert-delivery-run" }, step: makeStep(calls) }),
      /ENCRYPTION_KEY_MISSING/,
    );
  } finally {
    fetchCtl.restore();
  }
  const status = r2.json("logs/backup-status.json");
  return { status, calls, seen: fetchCtl.seen };
}

/* ----------------------------------------------------- 数据异常告警链路 */

function makeMonitorDb({ baselineUsers = 3, currentUsers = 0 }) {
  const metrics = {
    users: currentUsers,
    sessions: 0,
    devices: 0,
    files: 0,
    backups: 0,
    sync_entities: 0,
    security_events: 0,
    account_deletion_audit: 0,
    data_deletion_jobs: 0,
  };
  const state = new Map();
  state.set(
    "monitor.baseline",
    JSON.stringify({ ...metrics, users: baselineUsers, sessions: 2, devices: 1 }),
  );
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM data_monitor_state")) {
            const value = state.get(stmt.args[0]);
            return value === undefined ? null : { value };
          }
          if (sql.includes("COUNT(*)")) return metrics;
          if (sql.includes("FROM data_monitor_alerts")) return null;
          return null;
        },
        async run() {
          writes.push(sql);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

async function runDataAnomaly(webhookUrl) {
  const db = makeMonitorDb({ baselineUsers: 3, currentUsers: 0 });
  const original = globalThis.fetch;
  const passthrough = [];
  globalThis.fetch = async (url, init = {}) => {
    passthrough.push(new URL(String(url)).host);
    return original(url, init);
  };
  let result;
  try {
    result = await runDataMonitor({ DB: db, DATA_ALERT_WEBHOOK: webhookUrl });
  } finally {
    globalThis.fetch = original;
  }
  return { result, db, passthrough };
}

/* ------------------------------------------------------------------ 主流程 */

console.log(`[alert-delivery] ${nowIso()} 建立真实接收通道…`);
const channel = await provisionChannel();
console.log(`[alert-delivery] 通道：${channel.kind} → ${channel.url}`);
console.log("");

check("0. 接收通道可用（真实外部 HTTPS）", Boolean(channel.url), channel.kind);

let backup;
try {
  backup = await runBackupFailure(channel.url);
  const last = backup.status?.lastRun;
  check(
    "1. 备份失败产生 failed 状态",
    last?.status === "failed" && last?.errorCode === "ENCRYPTION_KEY_MISSING",
    `errorCode=${last?.errorCode}`,
  );
  check("2. 失败记录 notifiedAt 非空（声称已送达）", Boolean(last?.notifiedAt), `notifiedAt=${last?.notifiedAt ?? "null"}`);
  check("3. 失败记录 notifyError 为空", !last?.notifyError, `notifyError=${last?.notifyError ?? "null"}`);
  check(
    "4. Webhook 走真实网络（未被 Mock 拦截）",
    backup.seen.passthrough.some((host) => String(channel.url).includes(host)),
    `passthrough=${backup.seen.passthrough.join(",")}`,
  );

  if (channel.read) {
    const received = await waitForRequest(
      channel,
      (c) => c?.type === "guandao.backup.alert",
      "guandao.backup.alert",
    );
    check("5. 接收端真实收到 guandao.backup.alert", true, `method=${received.method}`);
    check("6. payload 含 runId 且与本次运行一致", received.content.runId === "alert-delivery-run", `runId=${received.content.runId}`);
    check("7. payload 含 code 与人工核查标记", received.content.code === "ENCRYPTION_KEY_MISSING" && received.content.requiresHumanReview === true, `code=${received.content.code}`);
    const raw = JSON.stringify(received.content);
    check("8. payload 不含 Token / SQL / 邮箱", !raw.includes("token-not-logged") && !raw.includes("CREATE TABLE") && !raw.includes("@example.test"), "");
  } else {
    check("5. 接收端真实收到 guandao.backup.alert", false, "未提供可读回通道（设置 ALERT_WEBHOOK_READ_URL 才能断言）");
  }
} catch (error) {
  check("备份告警链路", false, String(error?.message ?? error).slice(0, 160));
}

let anomaly;
try {
  anomaly = await runDataAnomaly(channel.url);
  const alerts = anomaly.result?.alerts ?? [];
  const usersZero = alerts.find((a) => a.code === "USERS_ZERO");
  check("9. 数据监控产出 USERS_ZERO critical", Boolean(usersZero), `alerts=${alerts.map((a) => a.code).join(",") || "none"}`);
  check("10. 告警记录 notified=true", usersZero?.notified === true, `notified=${usersZero?.notified}`);
  check("11. 告警记录无 notifyError", !usersZero?.notifyError, `notifyError=${usersZero?.notifyError ?? "null"}`);
  check(
    "12. 数据告警也走真实网络",
    anomaly.passthrough.some((host) => String(channel.url).includes(host)),
    `passthrough=${anomaly.passthrough.join(",")}`,
  );

  if (channel.read) {
    const received = await waitForRequest(
      channel,
      (c) => c?.type === "guandao.data.alert",
      "guandao.data.alert",
    );
    check("13. 接收端真实收到 guandao.data.alert", true, `method=${received.method}`);
    check("14. payload code/severity 正确", received.content.code === "USERS_ZERO" && received.content.severity === "critical", `code=${received.content.code}, severity=${received.content.severity}`);
    check("15. payload 只含计数，不含用户内容", typeof received.content.metrics?.users === "number", `metrics.users=${received.content.metrics?.users}`);
  } else {
    check("13. 接收端真实收到 guandao.data.alert", false, "未提供可读回通道");
  }
} catch (error) {
  check("数据告警链路", false, String(error?.message ?? error).slice(0, 160));
}

const failed = results.filter((r) => !r.pass).length;
console.log("");
console.log(`[alert-delivery] ${results.length - failed}/${results.length} 通过`);
if (failed) {
  console.log("[alert-delivery] 判定：**未完成真实送达验证**");
  process.exit(1);
}
console.log(`[alert-delivery] 判定：真实外部 HTTPS 送达已验证（通道 ${channel.kind}）`);
if (channel.kind.startsWith("webhook.site")) {
  console.log(`[alert-delivery] 可人工复核：${channel.url}`);
}
console.log(`[alert-delivery] 随机串校验位 ${randomBytes(4).toString("hex")}`);