/**
 * Guandao OS 2.0 · 同步实体存储层（D1）
 *
 * 所有 SQL 都带 user_id 绑定参数；entity_id / domain 由调用方白名单校验。
 * 冲突用 baseRevision 乐观锁：库里的 revision 比客户端带来的大，就返回服务端行。
 */

export const SYNC_DOMAINS = ["notes", "tasks", "calendar"];

const MAX_INDEX_ROWS = 10000;

export function isSyncDomain(value) {
  return SYNC_DOMAINS.includes(value);
}

/** 增量拉取（updated_at > since），按时间升序，便于客户端顺序应用 */
export async function listChanges(env, userId, domain, { since = 0, limit = 300 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, payload_json, updated_at
       FROM sync_entities
      WHERE user_id = ? AND domain = ? AND updated_at > ?
      ORDER BY updated_at ASC, entity_id ASC
      LIMIT ?`,
  )
    .bind(userId, domain, Number(since) || 0, Math.min(500, Math.max(1, Number(limit) || 300)))
    .all();

  return (rows.results || []).map(mapRow);
}

/** 按 id 批量取实体（客户端按索引 diff 后只拉需要的） */
export async function listByIds(env, userId, domain, ids) {
  const list = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))].slice(0, 200);
  if (!list.length) return [];
  const placeholders = list.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, payload_json, updated_at
       FROM sync_entities
      WHERE user_id = ? AND domain = ? AND entity_id IN (${placeholders})`,
  )
    .bind(userId, domain, ...list)
    .all();
  return (rows.results || []).map(mapRow);
}

/** 全量索引（只含 id / revision / deleted / updatedAt，不含 payload） */
export async function listIndex(env, userId, domain) {
  const rows = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, updated_at
       FROM sync_entities
      WHERE user_id = ? AND domain = ?
      ORDER BY updated_at DESC
      LIMIT ?`,
  )
    .bind(userId, domain, MAX_INDEX_ROWS + 1)
    .all();

  const list = rows.results || [];
  return {
    entities: list.slice(0, MAX_INDEX_ROWS).map((row) => ({
      id: row.entity_id,
      revision: Number(row.revision) || 1,
      deleted: Number(row.deleted) === 1,
      updatedAt: Number(row.updated_at) || 0,
    })),
    truncated: list.length > MAX_INDEX_ROWS,
  };
}

/**
 * 乐观锁写入。
 * @returns {{ outcome: "applied"|"conflict", entity: object }}
 */
export async function applyChange(env, userId, domain, change) {
  const id = String(change.id);
  const baseRevision = Math.max(0, Number(change.baseRevision) || 0);
  const deleted = Boolean(change.deleted);
  const updatedAt = Number(change.updatedAt) || Date.now();
  const payload = deleted ? null : JSON.stringify(change.payload ?? null);

  const current = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, payload_json, updated_at
       FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?`,
  )
    .bind(userId, domain, id)
    .first();

  const currentRevision = Number(current?.revision) || 0;
  // 客户端基于旧版本修改 → 冲突，返回服务端版本让客户端合并
  if (current && currentRevision > baseRevision) {
    return { outcome: "conflict", entity: mapRow(current) };
  }

  const nextRevision = Math.max(baseRevision, currentRevision) + 1;
  const nextUpdatedAt = Math.max(updatedAt, Number(current?.updated_at) || 0) + 1;

  await env.DB.prepare(
    `INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
       revision = excluded.revision,
       deleted = excluded.deleted,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
  )
    .bind(userId, domain, id, nextRevision, deleted ? 1 : 0, payload, nextUpdatedAt)
    .run();

  return {
    outcome: "applied",
    entity: {
      id,
      revision: nextRevision,
      deleted,
      updatedAt: nextUpdatedAt,
      ...(deleted ? {} : { payload: change.payload ?? null }),
    },
  };
}

/** 每个域的条目数与最后更新时间 */
export async function domainStats(env, userId, domain) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS tombstones,
            MAX(updated_at) AS last_updated
       FROM sync_entities WHERE user_id = ? AND domain = ?`,
  )
    .bind(userId, domain)
    .first();

  return {
    domain,
    count: Number(row?.total) || 0,
    tombstones: Number(row?.tombstones) || 0,
    lastUpdated: Number(row?.last_updated) || null,
  };
}

function mapRow(row) {
  const deleted = Number(row.deleted) === 1;
  let payload = null;
  if (!deleted && row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    id: row.entity_id,
    revision: Number(row.revision) || 1,
    deleted,
    updatedAt: Number(row.updated_at) || 0,
    ...(deleted ? {} : { payload }),
  };
}