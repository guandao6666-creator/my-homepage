/**
 * D1 备份 Workflow 核心（纯函数，可在 Worker 与 Node 测试中复用）。
 *
 * 这里不包含任何 Cloudflare 资源创建逻辑；只负责：
 * - D1 REST API 响应校验
 * - R2 对象 key / manifest 生成
 * - AES-256-GCM 加密与 SHA-256
 * - 备份状态健康判断
 *
 * 安全：不记录 token、signed_url、SQL 内容或用户数据。
 */

export const BACKUP_SCHEMA_VERSION = 1;
export const STATUS_OBJECT_KEY = "logs/backup-status.json";
export const STALE_MS = 26 * 3600 * 1000;
export const MAX_SQL_BYTES = 100 * 1024 * 1024;
export const ENCRYPTION_ALGORITHM = "AES-256-GCM";

export function databaseRef(name, id) {
  const suffix = String(id || "").replace(/[^a-f0-9]/gi, "").slice(0, 8) || "unknown";
  return `${name || "guandao-db"}/${suffix}`;
}

export function dateParts(date = new Date()) {
  const iso = new Date(date).toISOString();
  return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10), iso };
}

export function buildObjectKeys(date = new Date(), runId = crypto.randomUUID()) {
  const { year, month, day } = dateParts(date);
  const base = `daily/${year}/${month}/${day}/${runId}`;
  return {
    sqlKey: `${base}.sql.enc`,
    manifestKey: `${base}.manifest.json`,
    statusKey: `${base}.status.json`,
    runLogKey: `logs/runs/${runId}.json`,
  };
}

export function sha256Hex(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

export function bytesToBase64(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function aesKey(rawBase64) {
  if (!rawBase64) throw new Error("ENCRYPTION_KEY_MISSING");
  const raw = base64ToBytes(rawBase64);
  if (raw.byteLength !== 32) throw new Error("ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 加密 SQL；返回密文、iv、明文与密文的 SHA-256。 */
export async function encryptSql(plainBytes, keyBase64) {
  const key = await aesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes),
  );
  return {
    ciphertext,
    iv: bytesToBase64(iv),
    plainSha256: await sha256Hex(plainBytes),
    objectSha256: await sha256Hex(ciphertext),
  };
}

export async function decryptSql(ciphertext, keyBase64, ivBase64) {
  const key = await aesKey(keyBase64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivBase64) },
    key,
    ciphertext,
  );
  return new Uint8Array(plain);
}

export function assertSqlComplete(bytes) {
  if (!bytes || bytes.byteLength < 100) throw new Error("SQL_TOO_SMALL");
  if (bytes.byteLength > MAX_SQL_BYTES) throw new Error("SQL_TOO_LARGE");
  const text = new TextDecoder().decode(bytes);
  if (text.includes("\u0000")) throw new Error("SQL_HAS_NUL");
  if (!/CREATE\s+TABLE/i.test(text)) throw new Error("SQL_NO_CREATE_TABLE");
  return true;
}

export function parseExportStart(payload) {
  const result = payload?.result ?? payload;
  if (!payload?.success && payload?.success !== undefined) {
    throw new Error(`D1_EXPORT_START_FAILED:${sanitizeError(payload?.errors?.[0]?.message || "unknown")}`);
  }
  const bookmark = result?.at_bookmark || result?.bookmark;
  if (!bookmark || typeof bookmark !== "string") throw new Error("EXPORT_BOOKMARK_MISSING");
  return { bookmark, filename: typeof result?.filename === "string" ? result.filename : null };
}

export function parseExportStatus(payload, options = {}) {
  const envelope = payload?.result ?? payload;
  if (!payload?.success && payload?.success !== undefined) {
    throw new Error(`D1_EXPORT_STATUS_FAILED:${sanitizeError(payload?.errors?.[0]?.message || "unknown")}`);
  }
  const status = typeof envelope?.status === "string" ? envelope.status.toLowerCase() : "";
  // Cloudflare 完成态形如：
  // { result: { status: "complete", result: { signed_url, filename } } }
  const result = envelope?.result && typeof envelope.result === "object" ? envelope.result : envelope;
  const signedUrl = result?.signed_url;
  if (!signedUrl || typeof signedUrl !== "string") {
    if (["active", "pending", "processing", "queued", "running"].includes(status)) {
      return {
        pending: true,
        status,
        bookmark: typeof envelope?.at_bookmark === "string"
          ? envelope.at_bookmark
          : typeof envelope?.bookmark === "string" ? envelope.bookmark : null,
        filename: typeof result?.filename === "string" ? result.filename : null,
      };
    }
    throw new Error("SIGNED_URL_MISSING");
  }
  let parsed;
  try {
    parsed = new URL(signedUrl);
  } catch {
    throw new Error("SIGNED_URL_INVALID");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(options.allowHttp === true && parsed.protocol === "http:" && loopback)) {
    throw new Error("SIGNED_URL_NOT_HTTPS");
  }
  return {
    pending: false,
    status: status || "complete",
    signedUrl,
    bookmark: typeof envelope?.at_bookmark === "string" ? envelope.at_bookmark : null,
    filename: typeof result?.filename === "string" ? result.filename : null,
  };
}

export function sanitizeError(error) {
  const raw = String(error?.message ?? error ?? "unknown");
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|signed_url|authorization)=?[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 240);
}

export function buildManifest(input) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    database: {
      name: input.databaseName || "guandao-db",
      ref: databaseRef(input.databaseName, input.databaseId),
    },
    workflow: {
      runId: input.runId,
      schedule: input.schedule ?? null,
    },
    exportedAt: input.exportedAt,
    bookmark: input.bookmark,
    r2: {
      sqlKey: input.sqlKey,
      manifestKey: input.manifestKey,
    },
    sql: {
      bytes: input.sqlBytes,
      sha256: input.sqlSha256,
      encryption: {
        algorithm: ENCRYPTION_ALGORITHM,
        iv: input.iv,
      },
    },
    object: {
      bytes: input.objectBytes,
      sha256: input.objectSha256,
    },
    upload: { status: "put_ok" },
    verify: { status: "sha256_match", verifiedAt: input.verifiedAt },
  };
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error("MANIFEST_SCHEMA_UNSUPPORTED");
  for (const key of ["runId", "exportedAt", "bookmark", "sqlKey", "manifestKey"]) {
    if (!manifest?.[key] && !manifest?.workflow?.[key] && !manifest?.r2?.[key]) {
      throw new Error(`MANIFEST_MISSING_${key.toUpperCase()}`);
    }
  }
  if (!manifest.sql?.sha256 || manifest.sql.sha256.length !== 64) throw new Error("MANIFEST_SHA_INVALID");
  if (!manifest.sql?.encryption?.iv) throw new Error("MANIFEST_IV_MISSING");
  if (manifest.verify?.status !== "sha256_match") throw new Error("MANIFEST_NOT_VERIFIED");
  return true;
}

/**
 * 备份状态健康判断。
 * - 没有状态 / 无法解析 → unknown
 * - 最近一次失败 → failed
 * - 最近成功超过 26 小时 → stale
 * - 其余 → healthy
 */
export function evaluateBackupStatus(status, now = Date.now(), staleMs = STALE_MS) {
  if (!status || typeof status !== "object") {
    return { state: "unknown", reason: "NO_STATUS", lastSuccessAt: null, lastRun: null };
  }
  const lastRun = status.lastRun || null;
  const lastSuccessAt = status.lastSuccessAt || null;
  if (lastRun?.status === "failed") {
    return { state: "failed", reason: lastRun.errorCode || "BACKUP_FAILED", lastSuccessAt, lastRun };
  }
  if (!lastSuccessAt) {
    return { state: "unknown", reason: "NO_SUCCESSFUL_BACKUP", lastSuccessAt: null, lastRun };
  }
  const successMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(successMs)) {
    return { state: "unknown", reason: "INVALID_LAST_SUCCESS", lastSuccessAt, lastRun };
  }
  const ageMs = Math.max(0, now - successMs);
  if (ageMs > staleMs) {
    return {
      state: "stale",
      reason: "BACKUP_OLDER_THAN_26H",
      lastSuccessAt,
      lastRun,
      ageMs,
      staleMs,
    };
  }
  return { state: "healthy", reason: "OK", lastSuccessAt, lastRun, ageMs };
}

export function buildBackupAlert(health, at = Date.now()) {
  const base = {
    at: new Date(at).toISOString(),
    lastSuccessAt: health?.lastSuccessAt ?? null,
    runId: health?.lastRun?.runId ?? null,
  };
  if (health?.state === "stale") {
    return {
      ...base,
      code: "BACKUP_STALE",
      severity: "critical",
      message: `最近一次成功备份已超过 26 小时（${health.lastSuccessAt}），需要人工核查`,
    };
  }
  if (health?.state === "failed") {
    return {
      ...base,
      code: "BACKUP_FAILED",
      severity: "critical",
      message: `最近一次备份失败（${health.reason}），需要人工核查`,
    };
  }
  return {
    ...base,
    code: "BACKUP_STATUS_UNKNOWN",
    severity: "warning",
    message: "无法读取有效的备份状态，按 unknown 处理，不能视为健康",
  };
}

export function statusRecordKey() {
  return STATUS_OBJECT_KEY;
}