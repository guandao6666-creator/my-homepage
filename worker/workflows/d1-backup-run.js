/**
 * Guandao OS · D1 每日备份 Workflow。
 *
 * 流程：
 *   D1 REST export (polling) → bookmark → signed_url → 下载 SQL
 *   → AES-256-GCM → R2 专用 Bucket → R2 回读 → SHA-256 校验
 *   → manifest + 状态 → 可选告警 Webhook
 *
 * 重要：
 * - 只写独立 R2 Bucket 的 daily/ 与 logs/ 前缀；
 * - 不覆盖历史对象（key 含 runId）；
 * - 不执行恢复、不删除任何对象；
 * - 不打印 Token / signed_url / SQL。
 */

import {
  BACKUP_SCHEMA_VERSION,
  STATUS_OBJECT_KEY,
  assertSqlComplete,
  buildManifest,
  buildObjectKeys,
  databaseRef,
  decryptSql,
  encryptSql,
  parseExportStart,
  parseExportStatus,
  sanitizeError,
  sha256Hex,
} from "./d1-backup-core.js";


const MAX_POLL_STEP_ATTEMPTS = 10;

async function cloudflareJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("CLOUDFLARE_API_INVALID_JSON");
  }
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`CLOUDFLARE_API_${response.status}:${sanitizeError(message)}`);
  }
  return payload;
}

function apiBase(env) {
  return env.D1_API_BASE || "https://api.cloudflare.com/client/v4";
}

function requireEnv(env) {
  if (!env?.ACCOUNT_ID) throw new Error("ACCOUNT_ID_MISSING");
  if (!env?.DATABASE_ID) throw new Error("DATABASE_ID_MISSING");
  if (!env?.D1_REST_API_TOKEN) throw new Error("D1_REST_API_TOKEN_MISSING");
  if (!env?.DB_BACKUPS) throw new Error("DB_BACKUPS_BINDING_MISSING");
  if (!env?.BACKUP_ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY_MISSING");
}

async function readStatus(env) {
  try {
    const object = await env.DB_BACKUPS.get(STATUS_OBJECT_KEY);
    if (!object) return null;
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

async function writeStatus(env, record) {
  const previous = (await readStatus(env)) || {};
  const lastRun = record;
  const status = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    databaseRef: databaseRef(env.DATABASE_NAME || "guandao-db", env.DATABASE_ID),
    updatedAt: record.finishedAt || record.startedAt,
    lastSuccessAt:
      record.status === "success" ? record.finishedAt : previous.lastSuccessAt || null,
    lastRun,
  };
  const body = JSON.stringify(status);
  await env.DB_BACKUPS.put(STATUS_OBJECT_KEY, body, {
    httpMetadata: { contentType: "application/json" },
  });
  if (record.runLogKey) {
    await env.DB_BACKUPS.put(record.runLogKey, body, {
      httpMetadata: { contentType: "application/json" },
    });
  }
  let dbStatus = "skipped";
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO d1_backup_runs
           (run_id, database_ref, started_at, finished_at, status, bookmark, object_key, manifest_key,
            sql_bytes, sha256, upload_status, verify_status, error_code, error_message, notified_at, notify_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           finished_at = excluded.finished_at,
           status = excluded.status,
           bookmark = excluded.bookmark,
           object_key = excluded.object_key,
           manifest_key = excluded.manifest_key,
           sql_bytes = excluded.sql_bytes,
           sha256 = excluded.sha256,
           upload_status = excluded.upload_status,
           verify_status = excluded.verify_status,
           error_code = excluded.error_code,
           error_message = excluded.error_message,
           notified_at = excluded.notified_at,
           notify_error = excluded.notify_error`,
      )
        .bind(
          record.runId,
          databaseRef(env.DATABASE_NAME || "guandao-db", env.DATABASE_ID),
          Date.parse(record.startedAt),
          record.finishedAt ? Date.parse(record.finishedAt) : null,
          record.status,
          record.bookmark ?? null,
          record.objectKey ?? null,
          record.manifestKey ?? null,
          record.sqlBytes ?? null,
          record.sha256 ?? null,
          record.uploadStatus ?? null,
          record.verifyStatus ?? null,
          record.errorCode ?? null,
          record.errorMessage ? sanitizeError(record.errorMessage) : null,
          record.notifiedAt ?? null,
          record.notifyError ? sanitizeError(record.notifyError) : null,
        )
        .run();
      dbStatus = "ok";
    } catch (error) {
      dbStatus = `degraded:${sanitizeError(error).slice(0, 80)}`;
    }
  }
  return dbStatus;
}

async function notifyFailure(env, record) {
  if (!env.BACKUP_ALERT_WEBHOOK) return { notifiedAt: null, notifyError: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(env.BACKUP_ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "guandao.backup.alert",
        at: record.finishedAt,
        runId: record.runId,
        code: record.errorCode || "BACKUP_FAILED",
        message: "D1 备份失败，需要人工核查；请检查备份状态接口或 R2 logs/。",
        requiresHumanReview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { notifiedAt: null, notifyError: `HTTP_${response.status}` };
    return { notifiedAt: Date.now(), notifyError: null };
  } catch (error) {
    return { notifiedAt: null, notifyError: String(error?.name ?? error).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runD1Backup({ env, event, step } = {}) {
    const runId = event?.instanceId || crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const keys = buildObjectKeys(new Date(startedAt), runId);
    const baseRecord = {
      runId,
      startedAt,
      status: "running",
      databaseRef: databaseRef(env.DATABASE_NAME || "guandao-db", env.DATABASE_ID),
      objectKey: null,
      manifestKey: null,
      runLogKey: keys.runLogKey,
      bookmark: null,
      sqlBytes: null,
      sha256: null,
      uploadStatus: null,
      verifyStatus: null,
      errorCode: null,
      errorMessage: null,
      notifiedAt: null,
      notifyError: null,
    };

    try {
      requireEnv(env);
      const start = await step.do(
        "start-d1-export",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => {
          const payload = await cloudflareJson(
            `${apiBase(env)}/accounts/${env.ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/export`,
            env.D1_REST_API_TOKEN,
            { output_format: "polling" },
          );
          return parseExportStart(payload);
        },
      );

      const downloaded = await step.do(
        "poll-download-encrypt-upload",
        {
          retries: { limit: MAX_POLL_STEP_ATTEMPTS, delay: "30 seconds", backoff: "exponential" },
          timeout: "15 minutes",
        },
        async () => {
          let bookmark = start.bookmark;
          let status = null;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const payload = await cloudflareJson(
              `${apiBase(env)}/accounts/${env.ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/export`,
              env.D1_REST_API_TOKEN,
              { output_format: "polling", current_bookmark: bookmark },
            );
            status = parseExportStatus(payload, { allowHttp: env.D1_BACKUP_ALLOW_HTTP === "1" });
            if (!status.pending) break;
            if (status.bookmark) bookmark = status.bookmark;
            if (attempt === 29) throw new Error("D1_EXPORT_NOT_READY");
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          if (!status?.signedUrl) throw new Error("SIGNED_URL_MISSING");
          const dump = await fetch(status.signedUrl);
          if (!dump.ok) throw new Error(`DUMP_DOWNLOAD_${dump.status}`);
          const plain = new Uint8Array(await dump.arrayBuffer());
          assertSqlComplete(plain);
          const encrypted = await encryptSql(plain, env.BACKUP_ENCRYPTION_KEY);
          await env.DB_BACKUPS.put(keys.sqlKey, encrypted.ciphertext, {
            httpMetadata: { contentType: "application/octet-stream" },
          });
          return {
            exportedAt: new Date().toISOString(),
            bookmark,
            plainBytes: plain.byteLength,
            ciphertextBytes: encrypted.ciphertext.byteLength,
            plainSha256: encrypted.plainSha256,
            objectSha256: encrypted.objectSha256,
            iv: encrypted.iv,
          };
        },
      );

      const verified = await step.do(
        "readback-verify-r2",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async () => {
          const object = await env.DB_BACKUPS.get(keys.sqlKey);
          if (!object) throw new Error("R2_OBJECT_MISSING");
          const bytes = new Uint8Array(await object.arrayBuffer());
          const objectSha = await sha256Hex(bytes);
          if (objectSha !== downloaded.objectSha256) throw new Error("R2_SHA256_MISMATCH");
          const decrypted = await decryptSql(bytes, env.BACKUP_ENCRYPTION_KEY, downloaded.iv);
          const plainSha = await sha256Hex(decrypted);
          if (plainSha !== downloaded.plainSha256) throw new Error("PLAINTEXT_SHA256_MISMATCH");
          assertSqlComplete(decrypted);
          return { objectSha256: objectSha, verifiedAt: new Date().toISOString() };
        },
      );

      const finishedAt = new Date().toISOString();
      const manifest = buildManifest({
        databaseName: env.DATABASE_NAME || "guandao-db",
        databaseId: env.DATABASE_ID,
        runId,
        schedule: event?.schedule?.cron ?? null,
        exportedAt: downloaded.exportedAt,
        bookmark: downloaded.bookmark,
        sqlKey: keys.sqlKey,
        manifestKey: keys.manifestKey,
        sqlBytes: downloaded.plainBytes,
        sqlSha256: downloaded.plainSha256,
        iv: downloaded.iv,
        objectBytes: downloaded.ciphertextBytes,
        objectSha256: verified.objectSha256,
        verifiedAt: verified.verifiedAt,
      });

      await step.do("write-manifest", async () => {
        await env.DB_BACKUPS.put(keys.manifestKey, `${JSON.stringify(manifest, null, 2)}\n`, {
          httpMetadata: { contentType: "application/json" },
        });
        return manifest;
      });

      const successRecord = {
        ...baseRecord,
        status: "success",
        finishedAt,
        bookmark: downloaded.bookmark,
        objectKey: keys.sqlKey,
        manifestKey: keys.manifestKey,
        sqlBytes: downloaded.plainBytes,
        sha256: downloaded.plainSha256,
        uploadStatus: "verified",
        verifyStatus: "sha256_match",
      };
      await step.do("write-success-status", async () => {
        const dbStatus = await writeStatus(env, successRecord);
        return { dbStatus };
      });
      return { runId, status: "success", objectKey: keys.sqlKey, manifestKey: keys.manifestKey };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const failedRecord = {
        ...baseRecord,
        status: "failed",
        finishedAt,
        errorCode: (() => {
          const message = String(error?.message ?? error);
          const match = message.match(/^[A-Z0-9_]+/);
          return match ? match[0] : "BACKUP_FAILED";
        })(),
        errorMessage: sanitizeError(error),
      };
      try {
        const notified = await notifyFailure(env, failedRecord);
        failedRecord.notifiedAt = notified.notifiedAt;
        failedRecord.notifyError = notified.notifyError;
        await step.do("write-failure-status", async () => {
          const dbStatus = await writeStatus(env, failedRecord);
          return { dbStatus };
        });
      } catch (statusError) {
        console.error("[d1-backup] failed to persist failure status:", sanitizeError(statusError));
      }
      throw error;
    }
  }
