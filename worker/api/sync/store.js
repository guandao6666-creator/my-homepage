/**
 * Guandao OS 2.0 · Phase 4 同步实体存储层（D1）
 *
 * 所有 SQL 都带 user_id 绑定参数；entity_id / domain 由调用方白名单校验。
 * 冲突用 baseRevision 乐观锁：库里的 revision 比客户端带来的大，就返回服务端行。
 *
 * Phase 4 增加三件事：
 *   1. 五个数据域（limits.js 的 SYNC_DOMAINS）；
 *   2. 墓碑带 deleted_at，90 天后由定时任务物理清理，避免墓碑无限积累拖慢索引；
 *   3. sync_tombstone_ledger 防复活台账：墓碑被清掉后，旧设备拿旧 baseRevision 重推
 *      仍然返回 conflict（合成 deleted 行），不会把已删除数据悄悄复活。
 */

import {
  CLEANUP_BATCH_SIZE,
  MAX_ENTITIES_PER_USER,
  MAX_TOMBSTONES_PER_USER,
  TOMBSTONE_TTL_DAYS,
  tombstoneCutoff,
} from "./limits.js";

/** 保持旧导出兼容：HTTP 层与历史脚本从 store.js 取域白名单。 */
export { SYNC_DOMAINS, isSyncDomain } from "./limits.js";

const MAX_INDEX_ROWS = 10000;
/** 单条 SQL 的绑定参数上限按 D1 的 100 保守留余量。 */
const ID_CHUNK_SIZE = 40;
/** 多行台账写入：5 列 × 15 行 = 75 个参数。 */
const LEDGER_INSERT_CHUNK = 15;
/** 多行墓碑删除：3 列 × 20 行 = 60 个参数（再加 cutoff）。 */
const TOMBSTONE_DELETE_CHUNK = 20;

/** 增量拉取（updated_at > since），按时间升序，便于客户端顺序应用 */
export async function listChanges(env, userId, domain, { since = 0, limit = 300 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, payload_json, updated_at, deleted_at
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

  const found = [];
  for (const chunk of chunkArray(list, ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT entity_id, revision, deleted, payload_json, updated_at, deleted_at
         FROM sync_entities
        WHERE user_id = ? AND domain = ? AND entity_id IN (${placeholders})`,
    )
      .bind(userId, domain, ...chunk)
      .all();
    found.push(...(rows.results || []));
  }
  return found.map(mapRow);
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
 * 统计用户的活实体数或墓碑数（配额闸门被挡下时用于确认「确实是配额问题」）。
 * 单独抽出来是因为 UPDATE / INSERT 两条分支都要用，且必须只在 changes=0 时跑一次，
 * 避免每次写入都多一次 COUNT。
 * @param {any} env
 * @param {string} userId
 * @param {"entities"|"tombstones"} scope
 */
async function countKind(env, userId, scope) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sync_entities WHERE user_id = ? AND deleted = ?",
  )
    .bind(userId, scope === "entities" ? 0 : 1)
    .first();
  return Number(row?.n) || 0;
}

/**
 * 乐观锁写入。
 * @returns {{ outcome: "applied"|"conflict"|"quota", scope?: string, current?: number, limit?: number, entity?: object }}
 */
export async function applyChange(env, userId, domain, change) {
  const id = String(change.id);
  const baseRevision = Math.max(0, Number(change.baseRevision) || 0);
  const deleted = Boolean(change.deleted);
  const updatedAt = Number(change.updatedAt) || Date.now();
  const payload = deleted ? null : JSON.stringify(change.payload ?? null);

  const current = await env.DB.prepare(
    `SELECT entity_id, revision, deleted, payload_json, updated_at, deleted_at
       FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?`,
  )
    .bind(userId, domain, id)
    .first();

  const currentRevision = Number(current?.revision) || 0;

  if (!current) {
    // 防复活：实体已被 TTL 清理，但台账仍记得最后一次删除。旧 baseRevision 重推 → 冲突。
    const ledger = await env.DB.prepare(
      `SELECT revision, deleted_at FROM sync_tombstone_ledger
        WHERE user_id = ? AND domain = ? AND entity_id = ?`,
    )
      .bind(userId, domain, id)
      .first();
    const ledgerRevision = Number(ledger?.revision) || 0;
    if (ledger && baseRevision < ledgerRevision) {
      const deletedAt = Number(ledger.deleted_at) || 0;
      return {
        outcome: "conflict",
        entity: { id, revision: ledgerRevision, deleted: true, updatedAt: deletedAt, deletedAt },
      };
    }
  } else if (currentRevision > baseRevision) {
    // 客户端基于旧版本修改 → 冲突，返回服务端版本让客户端合并
    return { outcome: "conflict", entity: mapRow(current) };
  }

  const nextRevision = Math.max(baseRevision, currentRevision) + 1;
  const nextUpdatedAt = Math.max(updatedAt, Number(current?.updated_at) || 0) + 1;
  const nextDeletedAt = deleted ? nextUpdatedAt : null;

  /*
   * 乐观锁必须落在「写」这一条 SQL 上。
   *
   * 2.0.4 之前是「SELECT 读 revision → JS 判冲突 → INSERT ... ON CONFLICT DO UPDATE」：
   * 两个并发 push 都读到同一个 revision，都判定不冲突，写入时后到者整条覆盖先到者，
   * 且两边拿到同一个 revision 号 —— 客户端以为自己同步成功，编辑永久消失且不会被
   * 后续 pull 判成冲突。D1 只保证单条语句原子，所以这里用带 `revision = ?` 条件的
   * UPDATE（或带 NOT EXISTS 的 INSERT）把「判」和「写」合成一条语句，再按 changes 判胜负。
   */
  /*
   * 配额也必须落在「写」这一条 SQL 上。
   *
   * 2.0.4 之前 push 是「userQuotaStats 预检 → 逐条 applyChange」：两个并发请求都看到
   * 「还剩 1 条额度」，各自写入成功，于是超过 5000 实体 / 2000 墓碑上限。预检保留下来
   * 做快速失败，但真正守门的是下面的条件子查询：只有当前计数仍低于上限才允许写。
   * 子查询和写语句一起执行，D1 保证单条语句原子，所以并发下最多只有一个请求抢到最后一个名额。
   */
  const currentDeleted = Number(current?.deleted) === 1;
  const addsEntity = !deleted && (!current || currentDeleted);
  const addsTombstone = deleted && (!current || !currentDeleted);
  const quotaScope = addsEntity ? "entities" : addsTombstone ? "tombstones" : null;
  const quotaLimit = addsEntity ? MAX_ENTITIES_PER_USER : addsTombstone ? MAX_TOMBSTONES_PER_USER : 0;
  const quotaGuard = quotaScope
    ? ` AND (SELECT COUNT(*) FROM sync_entities WHERE user_id = ? AND deleted = ${addsEntity ? 0 : 1}) < ?`
    : "";
  const quotaBinds = quotaScope ? [userId, quotaLimit] : [];

  if (current) {
    const updated = await env.DB.prepare(
      `UPDATE sync_entities
          SET revision = ?, deleted = ?, payload_json = ?, updated_at = ?, deleted_at = ?
        WHERE user_id = ? AND domain = ? AND entity_id = ? AND revision = ?${quotaGuard}`,
    )
      .bind(
        nextRevision,
        deleted ? 1 : 0,
        payload,
        nextUpdatedAt,
        nextDeletedAt,
        userId,
        domain,
        id,
        currentRevision,
        ...quotaBinds,
      )
      .run();

    if (Number(updated?.meta?.changes ?? 0) === 0) {
      // 配额挡下时行并没有被改（revision 仍是读到的那个），不能当冲突返回给客户端。
      if (quotaScope) {
        const blocked = await countKind(env, userId, quotaScope);
        if (blocked >= quotaLimit) {
          return { outcome: "quota", scope: quotaScope, current: blocked, limit: quotaLimit };
        }
      }
      // 读完之后被其它请求抢先写入：按冲突返回对方的最新版本，让客户端合并。
      const fresh = await env.DB.prepare(
        `SELECT entity_id, revision, deleted, payload_json, updated_at, deleted_at
           FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?`,
      )
        .bind(userId, domain, id)
        .first();
      if (fresh) return { outcome: "conflict", entity: mapRow(fresh) };
      // 极端情况：并发清理把行删了。按「不存在」重新走一遍台账判断。
      const ledger = await env.DB.prepare(
        `SELECT revision, deleted_at FROM sync_tombstone_ledger
          WHERE user_id = ? AND domain = ? AND entity_id = ?`,
      )
        .bind(userId, domain, id)
        .first();
      if (ledger && (Number(ledger.revision) || 0) > baseRevision) {
        const ledgerRevision = Number(ledger?.revision) || 0;
        const deletedAt = Number(ledger?.deleted_at) || 0;
        return {
          outcome: "conflict",
          entity: { id, revision: ledgerRevision, deleted: true, updatedAt: deletedAt, deletedAt },
        };
      }
      return {
        outcome: "conflict",
        entity: { id, revision: nextRevision, deleted: false, updatedAt: nextUpdatedAt, payload: change.payload ?? null },
      };
    }
  } else {
    // 插入同样要防并发：两个请求都读到「不存在」时，只允许一个插进去。
    // 配额闸门也放在这条 INSERT 里：新实体/新墓碑必须还有名额。
    const inserted = await env.DB.prepare(
      `INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?
        )${quotaGuard}`,
    )
      .bind(
        userId,
        domain,
        id,
        nextRevision,
        deleted ? 1 : 0,
        payload,
        nextUpdatedAt,
        nextDeletedAt,
        userId,
        domain,
        id,
        ...quotaBinds,
      )
      .run();

    if (Number(inserted?.meta?.changes ?? 0) === 0) {
      const fresh = await env.DB.prepare(
        `SELECT entity_id, revision, deleted, payload_json, updated_at, deleted_at
           FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?`,
      )
        .bind(userId, domain, id)
        .first();
      if (fresh) return { outcome: "conflict", entity: mapRow(fresh) };
      // 没插进去、也没有同 id 的行：只可能是配额闸门挡下的（例如并发抢最后一个名额）。
      if (quotaScope) {
        const blocked = await countKind(env, userId, quotaScope);
        if (blocked >= quotaLimit) {
          return { outcome: "quota", scope: quotaScope, current: blocked, limit: quotaLimit };
        }
      }
    }
  }

  if (deleted) {
    // 台账只增不减：即使墓碑之后被物理清理，也能拦住旧终端的「复活」推送。
    await env.DB.prepare(
      `INSERT INTO sync_tombstone_ledger (user_id, domain, entity_id, revision, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, domain, entity_id) DO UPDATE SET
         revision = excluded.revision,
         deleted_at = excluded.deleted_at
       WHERE excluded.revision >= sync_tombstone_ledger.revision`,
    )
      .bind(userId, domain, id, nextRevision, nextUpdatedAt)
      .run();
  }

  return {
    outcome: "applied",
    entity: {
      id,
      revision: nextRevision,
      deleted,
      updatedAt: nextUpdatedAt,
      ...(deleted ? { deletedAt: nextDeletedAt } : { payload: change.payload ?? null }),
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

/**
 * 单用户配额统计（跨全部数据域）：活实体数与墓碑数分别对照上限。
 * @returns {Promise<{ entityCount: number, tombstoneCount: number, limits: { maxEntities: number, maxTombstones: number } }>}
 */
export async function userQuotaStats(env, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS entities,
            SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS tombstones
       FROM sync_entities WHERE user_id = ?`,
  )
    .bind(userId)
    .first();

  return {
    entityCount: Number(row?.entities) || 0,
    tombstoneCount: Number(row?.tombstones) || 0,
    limits: {
      maxEntities: MAX_ENTITIES_PER_USER,
      maxTombstones: MAX_TOMBSTONES_PER_USER,
    },
  };
}

/**
 * 推送前的配额增量估算（不写库）：
 *   - 现有活实体 → 不占新增额度；墓碑被重建 → 释放一个墓碑、新增一个实体；
 *   - 库里没有的 id：删除算墓碑；新建算实体，但「会被防复活拦下」的旧 revision 推送不算。
 * @returns {Promise<{ entities: number, tombstones: number }>}
 */
export async function estimateQuotaDelta(env, userId, domain, changes) {
  const ids = [...new Set(changes.map((change) => String(change.id)))];
  const existing = new Map();
  const ledger = new Map();

  for (const chunk of chunkArray(ids, ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT entity_id, deleted FROM sync_entities
        WHERE user_id = ? AND domain = ? AND entity_id IN (${placeholders})`,
    )
      .bind(userId, domain, ...chunk)
      .all();
    for (const row of rows.results || []) existing.set(row.entity_id, row);

    const ledgerRows = await env.DB.prepare(
      `SELECT entity_id, revision FROM sync_tombstone_ledger
        WHERE user_id = ? AND domain = ? AND entity_id IN (${placeholders})`,
    )
      .bind(userId, domain, ...chunk)
      .all();
    for (const row of ledgerRows.results || []) ledger.set(row.entity_id, row);
  }

  let entities = 0;
  let tombstones = 0;
  for (const change of changes) {
    const current = existing.get(change.id);
    if (current) {
      const currentDeleted = Number(current.deleted) === 1;
      if (currentDeleted && !change.deleted) entities += 1;
      else if (!currentDeleted && change.deleted) tombstones += 1;
      continue;
    }
    if (change.deleted) {
      tombstones += 1;
      continue;
    }
    const ledgerRow = ledger.get(change.id);
    const baseRevision = Math.max(0, Number(change.baseRevision) || 0);
    if (ledgerRow && baseRevision < (Number(ledgerRow.revision) || 0)) continue;
    entities += 1;
  }

  return { entities, tombstones };
}

/**
 * 物理清理过期墓碑（分批；每次调用最多处理 batchSize 条）。
 *
 * 顺序很重要：先补齐 sync_tombstone_ledger，再删 sync_entities —— 即使进程在两步之间
 * 崩溃，最多是「台账有记录、墓碑还在」，下一轮会删掉，不会出现「墓碑没了、台账也没有」
 * 从而允许旧设备复活已删除数据。
 *
 * @param {object} env Worker env（需要 DB 绑定）
 * @param {{ now?: number, days?: number, batchSize?: number }} [options]
 * @returns {Promise<{ scanned: number, purged: number, cutoff: number }>}
 */
export async function purgeExpiredTombstones(env, options = {}) {
  const now = Number(options.now) || Date.now();
  const days = Number.isFinite(Number(options.days)) ? Math.max(0, Number(options.days)) : TOMBSTONE_TTL_DAYS;
  const batchSize = Math.min(200, Math.max(1, Number(options.batchSize) || CLEANUP_BATCH_SIZE));
  const cutoff = tombstoneCutoff(now, days);

  const rows = await env.DB.prepare(
    `SELECT user_id, domain, entity_id, revision, updated_at, deleted_at
       FROM sync_entities
      WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
      ORDER BY deleted_at ASC
      LIMIT ?`,
  )
    .bind(cutoff, batchSize)
    .all();

  const batch = rows.results || [];
  if (!batch.length) return { scanned: 0, purged: 0, cutoff };

  // 1) 先确保台账记录了这批墓碑（0014 时代的墓碑删除时还没有台账）。
  for (const chunk of chunkArray(batch, LEDGER_INSERT_CHUNK)) {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((row) => [
      row.user_id,
      row.domain,
      row.entity_id,
      Number(row.revision) || 1,
      Number(row.deleted_at) || Number(row.updated_at) || 0,
    ]);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_tombstone_ledger (user_id, domain, entity_id, revision, deleted_at)
       VALUES ${placeholders}`,
    )
      .bind(...params)
      .run();
  }

  // 2) 再按主键删除（用 OR 主键谓词，兼容 D1 与内存 SQLite 的批量参数上限）。
  let purged = 0;
  for (const chunk of chunkArray(batch, TOMBSTONE_DELETE_CHUNK)) {
    const predicates = chunk.map(() => "(user_id = ? AND domain = ? AND entity_id = ?)").join(" OR ");
    const params = [cutoff, ...chunk.flatMap((row) => [row.user_id, row.domain, row.entity_id])];
    const result = await env.DB.prepare(
      `DELETE FROM sync_entities
        WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ? AND (${predicates})`,
    )
      .bind(...params)
      .run();
    purged += Number(result?.meta?.changes) || 0;
  }

  return { scanned: batch.length, purged, cutoff };
}

/**
 * 单行实体映射：墓碑额外带 deletedAt，供客户端记录「删除时间」。
 * 活实体的响应形状与 Phase 3 保持一致（只有 payload），避免旧客户端解析变化。
 */
function mapRow(row) {
  const deleted = Number(row.deleted) === 1;
  if (deleted) {
    return {
      id: row.entity_id,
      revision: Number(row.revision) || 1,
      deleted: true,
      updatedAt: Number(row.updated_at) || 0,
      deletedAt: row.deleted_at == null ? null : Number(row.deleted_at) || null,
    };
  }

  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    id: row.entity_id,
    revision: Number(row.revision) || 1,
    deleted: false,
    updatedAt: Number(row.updated_at) || 0,
    payload,
  };
}

function chunkArray(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}
