/**
 * Guandao Backup · D1 访问层
 *
 * 所有查询都绑定 user_id。备份 ID 来自 URL 时也必须同时匹配 user_id，
 * 否则统一按「不存在」处理。
 */

export const SCHEMA_VERSION = 1;
export const MAX_BACKUPS_PER_USER = 60;
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024; // 单次备份文件总量上限
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024; // 客户端快照 JSON 上限

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

export async function createBackup(env, data) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO backups
       (id, user_id, kind, r2_key, size_bytes, note_count, created_at,
        backup_name, backup_type, scope, status, schema_version, snapshot_at, domains_json)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'collecting', ?, ?, ?)`,
  )
    .bind(
      data.id,
      data.userId,
      data.type === "auto" ? "scheduled" : "manual",
      data.manifestKey,
      now,
      data.name,
      data.type,
      data.scope,
      SCHEMA_VERSION,
      data.snapshotAt ?? now,
      JSON.stringify(data.domains ?? []),
    )
    .run();
}

export async function getBackup(env, userId, backupId) {
  return env.DB.prepare(
    "SELECT * FROM backups WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(backupId, userId)
    .first();
}

export async function updateBackup(env, userId, backupId, patch) {
  const allowed = {
    status: "status",
    sizeBytes: "size_bytes",
    itemCount: "item_count",
    fileCount: "file_count",
    checksum: "checksum_sha256",
    completedAt: "completed_at",
    verifiedAt: "verified_at",
    errorMessage: "error_message",
    manifestKey: "manifest_object_key",
    dataKey: "data_object_key",
    stats: "stats_json",
    snapshotAt: "snapshot_at",
    sourceCursor: "source_cursor",
    parentBackupId: "parent_backup_id",
    backupName: "backup_name",
    domains: "domains_json",
  };

  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === "stats" || key === "domains" ? JSON.stringify(patch[key]) : patch[key]);
  }
  if (!sets.length) return;

  await env.DB.prepare(`UPDATE backups SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values, backupId, userId)
    .run();
}

export async function listBackups(env, userId, options = {}) {
  const limit = clamp(options.limit ?? 20, 1, 100);
  const offset = clamp(options.offset ?? 0, 0, 100_000);
  const where = ["user_id = ?", "deleted_at IS NULL"];
  const values = [userId];

  const type = options.type;
  if (type === "manual" || type === "auto" || type === "protective") {
    where.push("backup_type = ?");
    values.push(type);
  }
  if (options.status && /^(queued|collecting|uploading|verifying|completed|failed|cancelled)$/.test(options.status)) {
    where.push("status = ?");
    values.push(options.status);
  }
  if (options.failed === "1") {
    where.push("status = 'failed'");
  }
  if (options.scope === "full" || options.scope === "partial" || options.scope === "drive") {
    where.push("scope = ?");
    values.push(options.scope);
  }
  if (options.q) {
    where.push("backup_name LIKE ?");
    values.push(`%${String(options.q).slice(0, 40)}%`);
  }

  const sortMap = {
    created: "created_at DESC",
    oldest: "created_at ASC",
    size: "size_bytes DESC",
    name: "backup_name ASC",
  };
  const order = sortMap[options.sort] ?? sortMap.created;

  const rows = await env.DB.prepare(
    `SELECT * FROM backups WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, offset)
    .all();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM backups WHERE ${where.join(" AND ")}`,
  )
    .bind(...values)
    .first();

  return {
    backups: (rows.results || []).map(mapBackup),
    total: Number(countRow?.total || 0),
    limit,
    offset,
  };
}

export function mapBackup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.backup_name || "未命名备份",
    type: row.backup_type || "manual",
    scope: row.scope || "full",
    status: row.status || "queued",
    schemaVersion: Number(row.schema_version || 1),
    createdAt: Number(row.created_at || 0),
    snapshotAt: row.snapshot_at ? Number(row.snapshot_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    verifiedAt: row.verified_at ? Number(row.verified_at) : null,
    sizeBytes: Number(row.size_bytes || 0),
    itemCount: Number(row.item_count || 0),
    fileCount: Number(row.file_count || 0),
    checksum: row.checksum_sha256 || null,
    domains: parseJson(row.domains_json, []),
    stats: parseJson(row.stats_json, null),
    errorMessage: row.error_message || null,
    parentBackupId: row.parent_backup_id || null,
    sourceCursor: row.source_cursor ? Number(row.source_cursor) : null,
  };
}

export function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

export async function createJob(env, { id, userId, backupId, type = "backup", total = 0, stage = "queued" }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO backup_jobs
       (id, user_id, backup_id, job_type, status, stage, progress_percent,
        processed_items, total_items, started_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 0, 0, ?, ?, ?)`,
  )
    .bind(id, userId, backupId, type, stage, total, now, now)
    .run();
  return id;
}

export async function getJob(env, userId, jobId) {
  return env.DB.prepare("SELECT * FROM backup_jobs WHERE id = ? AND user_id = ?")
    .bind(jobId, userId)
    .first();
}

export async function getLatestJob(env, userId, backupId, type = "backup") {
  return env.DB.prepare(
    `SELECT * FROM backup_jobs WHERE user_id = ? AND backup_id = ? AND job_type = ?
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(userId, backupId, type)
    .first();
}

export async function updateJob(env, userId, jobId, patch) {
  const map = {
    status: "status",
    stage: "stage",
    progress: "progress_percent",
    processed: "processed_items",
    total: "total_items",
    checkpoint: "checkpoint_json",
    errorCode: "error_code",
    errorMessage: "error_message",
    retryCount: "retry_count",
    completedAt: "completed_at",
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === "checkpoint" ? JSON.stringify(patch[key]) : patch[key]);
  }
  sets.push("updated_at = ?");
  values.push(Date.now());

  await env.DB.prepare(`UPDATE backup_jobs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values, jobId, userId)
    .run();
}

export function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    backupId: row.backup_id,
    type: row.job_type,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress_percent || 0),
    processed: Number(row.processed_items || 0),
    total: Number(row.total_items || 0),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    retryCount: Number(row.retry_count || 0),
    startedAt: Number(row.started_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

/* ------------------------------------------------------------------ */
/* 条目                                                                */
/* ------------------------------------------------------------------ */

export async function replaceBackupItems(env, userId, backupId, items) {  await env.DB.prepare("DELETE FROM backup_items WHERE backup_id = ? AND user_id = ?")
    .bind(backupId, userId)
    .run();

  const now = Date.now();
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((item) =>
        env.DB.prepare(
          `INSERT INTO backup_items
             (id, user_id, backup_id, entity_type, entity_id, source_revision,
              object_key, size_bytes, checksum_sha256, meta_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          userId,
          backupId,
          item.entityType,
          String(item.entityId).slice(0, 120),
          item.sourceRevision ?? null,
          item.objectKey ?? null,
          item.sizeBytes ?? 0,
          item.checksum ?? null,
          item.meta ? JSON.stringify(item.meta).slice(0, 2000) : null,
          now,
        ),
      ),
    );
  }
}

export async function insertBackupItem(env, userId, backupId, item) {
  await env.DB.prepare(
    `INSERT INTO backup_items
       (id, user_id, backup_id, entity_type, entity_id, source_revision,
        object_key, size_bytes, checksum_sha256, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      backupId,
      item.entityType,
      String(item.entityId).slice(0, 120),
      item.sourceRevision ?? null,
      item.objectKey ?? null,
      item.sizeBytes ?? 0,
      item.checksum ?? null,
      item.meta ? JSON.stringify(item.meta).slice(0, 2000) : null,
      Date.now(),
    )
    .run();
}

export async function hasActiveBackup(env, userId) {
  const row = await env.DB.prepare(
    `SELECT b.id FROM backups b
      WHERE b.user_id = ? AND b.deleted_at IS NULL
        AND b.status IN ('queued', 'collecting', 'uploading', 'verifying')
      LIMIT 1`,
  )
    .bind(userId)
    .first();
  return row?.id || null;
}

/**
 * 列出备份条目。
 *
 * 2.0：去掉了固定 LIMIT 5000 的硬顶。原先条目超过 5000 的账号备份
 * **必然失败**（读不全 → 校验对不上），而且已经消耗了 R2 写入。
 * 现在按页读取（每页 2000，最多 MAX_BACKUP_ITEMS 条），调用方拿到的仍是完整列表。
 */
const BACKUP_ITEMS_PAGE = 2000;
const MAX_BACKUP_ITEMS = 20000;

export async function listBackupItems(env, userId, backupId, entityType = null) {
  const sql = `SELECT * FROM backup_items WHERE user_id = ? AND backup_id = ?${
    entityType ? " AND entity_type = ?" : ""
  } ORDER BY id LIMIT ? OFFSET ?`;
  const out = [];

  for (let offset = 0; offset < MAX_BACKUP_ITEMS; offset += BACKUP_ITEMS_PAGE) {
    const stmt = env.DB.prepare(sql);
    const bound = entityType
      ? stmt.bind(userId, backupId, entityType, BACKUP_ITEMS_PAGE, offset)
      : stmt.bind(userId, backupId, BACKUP_ITEMS_PAGE, offset);
    const rows = await bound.all();
    const page = rows.results || [];
    out.push(...page);
    if (page.length < BACKUP_ITEMS_PAGE) break;
  }

  return out.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sourceRevision: row.source_revision,
    objectKey: row.object_key,
    sizeBytes: Number(row.size_bytes || 0),
    checksum: row.checksum_sha256,
    meta: parseJson(row.meta_json, null),
  }));
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export async function getSettings(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM backup_settings WHERE user_id = ?")
    .bind(userId)
    .first();
  if (!row) {
    return {
      autoEnabled: false,
      frequency: "off",
      scope: ["drive"],
      retentionDaily: 7,
      retentionWeekly: 4,
      lastAutoAt: null,
      lastAutoStatus: null,
      lastAutoBackup: null,
      updatedAt: null,
    };
  }
  return {
    autoEnabled: Boolean(row.auto_enabled),
    frequency: row.frequency,
    scope: parseJson(row.scope_json, ["drive"]),
    retentionDaily: Number(row.retention_daily || 7),
    retentionWeekly: Number(row.retention_weekly || 4),
    lastAutoAt: row.last_auto_at ? Number(row.last_auto_at) : null,
    lastAutoStatus: row.last_auto_status || null,
    lastAutoBackup: row.last_auto_backup || null,
    updatedAt: Number(row.updated_at || 0),
  };
}

export async function saveSettings(env, userId, settings) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO backup_settings
       (user_id, auto_enabled, frequency, scope_json, retention_daily,
        retention_weekly, last_auto_at, last_auto_status, last_auto_backup, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       auto_enabled = excluded.auto_enabled,
       frequency = excluded.frequency,
       scope_json = excluded.scope_json,
       retention_daily = excluded.retention_daily,
       retention_weekly = excluded.retention_weekly,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      settings.autoEnabled ? 1 : 0,
      settings.frequency,
      JSON.stringify(settings.scope ?? ["drive"]),
      settings.retentionDaily,
      settings.retentionWeekly,
      settings.lastAutoAt ?? null,
      settings.lastAutoStatus ?? null,
      settings.lastAutoBackup ?? null,
      now,
    )
    .run();
}

export async function markAutoRun(env, userId, { at, status, backupId }) {
  await env.DB.prepare(
    `UPDATE backup_settings SET last_auto_at = ?, last_auto_status = ?, last_auto_backup = ?, updated_at = ?
      WHERE user_id = ?`,
  )
    .bind(at, status, backupId, at, userId)
    .run();
}

export async function listAutoUsers(env) {
  const rows = await env.DB.prepare(
    `SELECT s.user_id, s.frequency, s.last_auto_at, s.retention_daily, s.retention_weekly
       FROM backup_settings s
       JOIN users u ON u.id = s.user_id
      WHERE s.auto_enabled = 1 AND s.frequency IN ('daily', 'weekly') AND u.status = 'active'
      ORDER BY s.last_auto_at ASC
      LIMIT 25`,
  )
    .all();
  return rows.results || [];
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

export async function createRestore(env, data) {
  await env.DB.prepare(
    `INSERT INTO backup_restores
       (id, user_id, backup_id, mode, domains_json, status, protective_backup_id,
        idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
  )
    .bind(
      data.id,
      data.userId,
      data.backupId,
      data.mode,
      JSON.stringify(data.domains),
      data.protectiveBackupId ?? null,
      data.idempotencyKey ?? null,
      Date.now(),
    )
    .run();
}

export async function findRestoreByIdempotency(env, userId, key) {
  if (!key) return null;
  return env.DB.prepare(
    "SELECT * FROM backup_restores WHERE user_id = ? AND idempotency_key = ?",
  )
    .bind(userId, key)
    .first();
}

export async function getRestore(env, userId, restoreId) {
  return env.DB.prepare("SELECT * FROM backup_restores WHERE id = ? AND user_id = ?")
    .bind(restoreId, userId)
    .first();
}

export async function updateRestore(env, userId, restoreId, patch) {
  const map = {
    status: "status",
    stats: "stats_json",
    errorMessage: "error_message",
    completedAt: "completed_at",
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(key === "stats" ? JSON.stringify(patch[key]) : patch[key]);
  }
  if (!sets.length) return;
  await env.DB.prepare(`UPDATE backup_restores SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values, restoreId, userId)
    .run();
}

export async function listRestoreFiles(env, userId, restoreId) {
  const rows = await env.DB.prepare(
    "SELECT * FROM backup_restore_items WHERE user_id = ? AND restore_id = ? ORDER BY file_id",
  )
    .bind(userId, restoreId)
    .all();
  return rows.results || [];
}

export async function upsertRestoreFile(env, data) {
  await env.DB.prepare(
    `INSERT INTO backup_restore_items
       (id, user_id, restore_id, file_id, new_file_id, status, error_message, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       new_file_id = excluded.new_file_id,
       status = excluded.status,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at`,
  )
    .bind(
      `${data.restoreId}:${data.fileId}`.slice(0, 120),
      data.userId,
      data.restoreId,
      data.fileId,
      data.newFileId ?? null,
      data.status ?? "pending",
      data.error ?? null,
      Date.now(),
    )
    .run();
}

export async function listRestores(env, userId, limit = 20) {
  const rows = await env.DB.prepare(
    "SELECT * FROM backup_restores WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(userId, clamp(limit, 1, 50))
    .all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    backupId: row.backup_id,
    mode: row.mode,
    domains: parseJson(row.domains_json, []),
    status: row.status,
    protectiveBackupId: row.protective_backup_id,
    stats: parseJson(row.stats_json, null),
    errorMessage: row.error_message,
    createdAt: Number(row.created_at || 0),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
  }));
}

/* ------------------------------------------------------------------ */
/* 统计与保留                                                          */
/* ------------------------------------------------------------------ */

export async function storageStats(env, userId) {
  const [backupRow, liveRow, trashRow, readyRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(size_bytes), 0) AS bytes,
              SUM(CASE WHEN backup_type = 'auto' THEN 1 ELSE 0 END) AS auto_count,
              SUM(CASE WHEN backup_type = 'manual' THEN 1 ELSE 0 END) AS manual_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
              MAX(created_at) AS last_at
         FROM backups WHERE user_id = ? AND deleted_at IS NULL`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS total FROM files WHERE user_id = ? AND status = 'ready'",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS total FROM files WHERE user_id = ? AND status = 'trash'",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM backups WHERE user_id = ? AND deleted_at IS NULL AND status = 'completed' AND verified_at IS NOT NULL",
    )
      .bind(userId)
      .first(),
  ]);

  return {
    backups: {
      total: Number(backupRow?.total || 0),
      bytes: Number(backupRow?.bytes || 0),
      auto: Number(backupRow?.auto_count || 0),
      manual: Number(backupRow?.manual_count || 0),
      failed: Number(backupRow?.failed_count || 0),
      lastAt: backupRow?.last_at ? Number(backupRow.last_at) : null,
      verified: Number(readyRow?.total || 0),
    },
    liveFiles: {
      bytes: Number(liveRow?.bytes || 0),
      count: Number(liveRow?.total || 0),
    },
    trashFiles: {
      bytes: Number(trashRow?.bytes || 0),
      count: Number(trashRow?.total || 0),
    },
    limitBytes: MAX_BACKUP_BYTES,
    backupLimit: MAX_BACKUPS_PER_USER,
  };
}

export async function countBackups(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM backups WHERE user_id = ? AND deleted_at IS NULL",
  )
    .bind(userId)
    .first();
  return Number(row?.total || 0);
}

export async function listExpiredAutoBackups(env, userId, retention) {
  const rows = await env.DB.prepare(
    `SELECT id, manifest_object_key, data_object_key FROM backups
      WHERE user_id = ? AND deleted_at IS NULL AND backup_type = 'auto' AND status = 'completed'
      ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();
  return (rows.results || []).slice(Math.max(retention, 1));
}

export async function markBackupDeleted(env, userId, backupId) {
  await env.DB.prepare(
    "UPDATE backups SET deleted_at = ?, status = 'cancelled' WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(Date.now(), backupId, userId)
    .run();
}

export async function listBackupsForPurge(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT id FROM backups WHERE user_id = ? AND deleted_at IS NOT NULL LIMIT 20",
  )
    .bind(userId)
    .all();
  return (rows.results || []).map((row) => row.id);
}

export async function purgeBackupRows(env, userId, backupId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM backup_items WHERE user_id = ? AND backup_id = ?").bind(userId, backupId),
    env.DB.prepare("DELETE FROM backup_jobs WHERE user_id = ? AND backup_id = ?").bind(userId, backupId),
    env.DB.prepare("DELETE FROM backups WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL").bind(
      userId,
      backupId,
    ),
  ]);
}

function clamp(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.min(Math.max(Math.trunc(Number(value)), min), max);
}
