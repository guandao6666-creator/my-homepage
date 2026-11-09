/**
 * Privacy & Security · D1 访问层
 * 所有查询绑定 user_id。
 */

export async function getPrivacySettings(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM privacy_settings WHERE user_id = ?")
    .bind(userId)
    .first();
  if (!row) {
    return {
      cloudSync: true,
      notes: true,
      tasks: true,
      calendar: true,
      desktop: true,
      workspace: true,
      updatedAt: null,
    };
  }
  return {
    cloudSync: Boolean(row.cloud_sync),
    notes: Boolean(row.allow_notes),
    tasks: Boolean(row.allow_tasks),
    calendar: Boolean(row.allow_calendar),
    desktop: Boolean(row.allow_desktop),
    workspace: Boolean(row.allow_workspace),
    updatedAt: Number(row.updated_at || 0),
  };
}

export async function savePrivacySettings(env, userId, value) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO privacy_settings
       (user_id, cloud_sync, allow_notes, allow_tasks, allow_calendar, allow_desktop, allow_workspace, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       cloud_sync = excluded.cloud_sync,
       allow_notes = excluded.allow_notes,
       allow_tasks = excluded.allow_tasks,
       allow_calendar = excluded.allow_calendar,
       allow_desktop = excluded.allow_desktop,
       allow_workspace = excluded.allow_workspace,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      value.cloudSync ? 1 : 0,
      value.notes ? 1 : 0,
      value.tasks ? 1 : 0,
      value.calendar ? 1 : 0,
      value.desktop ? 1 : 0,
      value.workspace ? 1 : 0,
      now,
    )
    .run();
  return getPrivacySettings(env, userId);
}

/* ------------------------------------------------------------------ */
/* 清单与概览                                                          */
/* ------------------------------------------------------------------ */

export async function dataInventory(env, userId) {
  const [
    user,
    sessions,
    devices,
    files,
    folders,
    backups,
    events,
    cloudNotes,
    fileEvents,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT id, github_username, display_name, avatar_url, role, created_at, last_login_at, deletion_state FROM users WHERE id = ?",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active
         FROM sessions WHERE user_id = ?`,
    )
      .bind(Date.now(), userId)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM devices WHERE user_id = ?`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN status = 'trash' THEN 1 ELSE 0 END) AS trash,
              COALESCE(SUM(size_bytes), 0) AS bytes
         FROM files WHERE user_id = ?`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM folders WHERE user_id = ? AND deleted_at IS NULL")
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes,
              SUM(CASE WHEN status = 'completed' AND verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified
         FROM backups WHERE user_id = ? AND deleted_at IS NULL`,
    )
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM security_events WHERE user_id = ?")
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM notes WHERE user_id = ?")
      .bind(userId)
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM file_events WHERE user_id = ?")
      .bind(userId)
      .first(),
  ]);

  return {
    account: {
      id: user?.id,
      githubUsername: user?.github_username,
      displayName: user?.display_name,
      avatarUrl: user?.avatar_url,
      role: user?.role,
      createdAt: user?.created_at,
      lastLoginAt: user?.last_login_at,
      deletionState: user?.deletion_state || "none",
    },
    sessions: { total: Number(sessions?.total || 0), active: Number(sessions?.active || 0) },
    devices: { total: Number(devices?.total || 0), active: Number(devices?.active || 0) },
    files: {
      total: Number(files?.total || 0),
      ready: Number(files?.ready || 0),
      trash: Number(files?.trash || 0),
      bytes: Number(files?.bytes || 0),
    },
    folders: { total: Number(folders?.total || 0) },
    backups: {
      total: Number(backups?.total || 0),
      verified: Number(backups?.verified || 0),
      bytes: Number(backups?.bytes || 0),
    },
    events: { total: Number(events?.total || 0) },
    legacyCloudNotes: { total: Number(cloudNotes?.total || 0) },
    fileEvents: { total: Number(fileEvents?.total || 0) },
  };
}

export async function listSecurityEvents(env, userId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
  const offset = Math.min(Math.max(Number(options.offset || 0), 0), 10_000);
  const where = ["user_id = ?"];
  const values = [userId];

  if (options.type) {
    where.push("event_type = ?");
    values.push(String(options.type));
  }
  if (options.from) {
    where.push("created_at >= ?");
    values.push(Number(options.from));
  }
  if (options.to) {
    where.push("created_at <= ?");
    values.push(Number(options.to));
  }
  if (options.result) {
    where.push("result = ?");
    values.push(String(options.result));
  }

  const rows = await env.DB.prepare(
    `SELECT id, event_type, device_id, result, metadata_json, created_at
       FROM security_events WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, offset)
    .all();

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM security_events WHERE ${where.join(" AND ")}`,
  )
    .bind(...values)
    .first();

  return {
    events: (rows.results || []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      deviceId: row.device_id,
      result: row.result,
      metadata: parse(row.metadata_json, null),
      createdAt: Number(row.created_at || 0),
    })),
    total: Number(count?.total || 0),
    limit,
    offset,
  };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export async function createExport(env, data) {
  await env.DB.prepare(
    `INSERT INTO data_exports
       (id, user_id, export_type, status, scopes_json, object_prefix, created_at)
     VALUES (?, ?, ?, 'collecting', ?, ?, ?)`,
  )
    .bind(
      data.id,
      data.userId,
      data.exportType,
      JSON.stringify(data.scopes),
      data.prefix,
      Date.now(),
    )
    .run();
}

export async function updateExport(env, userId, exportId, patch) {
  const map = {
    status: "status",
    sizeBytes: "size_bytes",
    fileCount: "file_count",
    checksum: "checksum_sha256",
    dataKey: "data_key",
    manifestKey: "manifest_key",
    errorMessage: "error_message",
    completedAt: "completed_at",
    expiresAt: "expires_at",
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key]);
  }
  if (!sets.length) return;
  await env.DB.prepare(`UPDATE data_exports SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values, exportId, userId)
    .run();
}

export async function getExport(env, userId, exportId) {
  return env.DB.prepare("SELECT * FROM data_exports WHERE id = ? AND user_id = ?")
    .bind(exportId, userId)
    .first();
}

export async function listExports(env, userId, limit = 20) {
  const rows = await env.DB.prepare(
    "SELECT * FROM data_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all();
  return (rows.results || []).map(mapExport);
}

export function mapExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.export_type,
    status: row.status,
    scopes: parse(row.scopes_json, []),
    sizeBytes: Number(row.size_bytes || 0),
    fileCount: Number(row.file_count || 0),
    checksum: row.checksum_sha256,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at || 0),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
  };
}

export async function createExportJob(env, { id, userId, exportId, total }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO data_export_jobs
       (id, user_id, export_id, status, stage, progress_percent, processed_items,
        total_items, started_at, updated_at)
     VALUES (?, ?, ?, 'running', 'collecting', 0, 0, ?, ?, ?)`,
  )
    .bind(id, userId, exportId, total, now, now)
    .run();
}

export async function getLatestExportJob(env, userId, exportId) {
  return env.DB.prepare(
    `SELECT * FROM data_export_jobs WHERE user_id = ? AND export_id = ?
      ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(userId, exportId)
    .first();
}

export async function updateExportJob(env, userId, jobId, patch) {
  const map = {
    status: "status",
    stage: "stage",
    progress: "progress_percent",
    processed: "processed_items",
    total: "total_items",
    checkpoint: "checkpoint_json",
    errorMessage: "error_message",
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
  await env.DB.prepare(
    `UPDATE data_export_jobs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values, jobId, userId)
    .run();
}

export function mapExportJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    exportId: row.export_id,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress_percent || 0),
    processed: Number(row.processed_items || 0),
    total: Number(row.total_items || 0),
    errorMessage: row.error_message,
    startedAt: Number(row.started_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export async function activeExport(env, userId) {
  const row = await env.DB.prepare(
    `SELECT id FROM data_exports WHERE user_id = ?
      AND status IN ('queued', 'collecting', 'uploading', 'verifying') LIMIT 1`,
  )
    .bind(userId)
    .first();
  return row?.id || null;
}

/* ------------------------------------------------------------------ */
/* 删除任务                                                            */
/* ------------------------------------------------------------------ */

export async function createDeletionJob(env, data) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO data_deletion_jobs
       (id, user_id, deletion_type, status, current_stage, progress_percent,
        processed_items, total_items, checkpoint_json, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, 0, 0, ?, ?, ?, ?)`,
  )
    .bind(
      data.id,
      data.userId,
      data.type,
      data.stage,
      data.total,
      JSON.stringify(data.checkpoint ?? {}),
      now,
      now,
    )
    .run();
}

export async function getDeletionJob(env, userId, jobId) {
  return env.DB.prepare("SELECT * FROM data_deletion_jobs WHERE id = ? AND user_id = ?")
    .bind(jobId, userId)
    .first();
}

export async function updateDeletionJob(env, userId, jobId, patch) {
  const map = {
    status: "status",
    stage: "current_stage",
    progress: "progress_percent",
    processed: "processed_items",
    total: "total_items",
    checkpoint: "checkpoint_json",
    errorCode: "error_code",
    errorMessage: "error_message",
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
  await env.DB.prepare(
    `UPDATE data_deletion_jobs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values, jobId, userId)
    .run();
}

export function mapDeletionJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.deletion_type,
    status: row.status,
    stage: row.current_stage,
    progress: Number(row.progress_percent || 0),
    processed: Number(row.processed_items || 0),
    total: Number(row.total_items || 0),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
  };
}

export async function activeDeletion(env, userId) {
  return env.DB.prepare(
    `SELECT * FROM data_deletion_jobs WHERE user_id = ?
      AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first();
}

export async function listDeletions(env, userId, limit = 10) {
  const rows = await env.DB.prepare(
    "SELECT * FROM data_deletion_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(userId, Math.min(Math.max(limit, 1), 30))
    .all();
  return (rows.results || []).map(mapDeletionJob);
}

/* ------------------------------------------------------------------ */
/* 注销                                                                */
/* ------------------------------------------------------------------ */

export async function markUserPendingDeletion(env, userId) {
  await env.DB.prepare("UPDATE users SET deletion_state = 'pending' WHERE id = ?")
    .bind(userId)
    .run();
}

export async function createDeletionAudit(env, userId, stages) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO account_deletion_audit (id, user_ref_hash, requested_at, stages_json, result)
     VALUES (?, ?, ?, ?, 'pending')`,
  )
    .bind(id, await hashRef(userId), Date.now(), JSON.stringify(stages))
    .run();
  return id;
}

export async function completeDeletionAudit(env, id, stages) {
  await env.DB.prepare(
    "UPDATE account_deletion_audit SET completed_at = ?, stages_json = ?, result = 'completed' WHERE id = ?",
  )
    .bind(Date.now(), JSON.stringify(stages), id)
    .run();
}

async function hashRef(value) {
  const data = new TextEncoder().encode(`guandao-deletion|${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
