/**
 * Guandao OS 2.0 · Phase 4 云同步限额常量与纯函数
 *
 * 为什么单独成文件：域白名单 / payload 上限 / 配额 / 墓碑 TTL 同时被存储层、
 * HTTP 层、Cron 维护和单元测试引用。放在纯函数模块里，测试就不需要为了一个
 * 常量去 mock D1；发布前也能用 `node --check` 单独校验。
 */

/** 五个可同步数据域。顺序即 /api/sync/status 的返回顺序（旧三个在前，客户端按需取）。 */
export const SYNC_DOMAINS = Object.freeze(["notes", "tasks", "calendar", "workspace", "preferences"]);

/** 单条 payload 上限（按 JSON 序列化后的字节数）。notes / tasks / calendar 沿用 128KB。 */
export const DEFAULT_PAYLOAD_LIMIT = 128 * 1024;

/** 按域覆盖的 payload 上限：workspace 存页面布局等结构性数据，preferences 只是设置项。 */
export const DOMAIN_PAYLOAD_LIMITS = Object.freeze({
  workspace: 128 * 1024,
  preferences: 32 * 1024,
});

/** 单用户配额：活实体最多 5000 条，墓碑最多 2000 条（墓碑过期清理后会腾出空间）。 */
export const MAX_ENTITIES_PER_USER = 5000;
export const MAX_TOMBSTONES_PER_USER = 2000;

/** 墓碑保留 90 天；清理按批执行，单次 Cron 最多处理 2000 条，避免长事务拖慢数据库。 */
export const TOMBSTONE_TTL_DAYS = 90;
export const TOMBSTONE_TTL_MS = TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
export const CLEANUP_BATCH_SIZE = 200;
export const CLEANUP_MAX_PER_RUN = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {unknown} value @returns {boolean} */
export function isSyncDomain(value) {
  return SYNC_DOMAINS.includes(value);
}

/**
 * 某个数据域允许的单条 payload 字节数；未单独配置的域用默认值。
 * @param {string} domain
 * @returns {number}
 */
export function domainPayloadLimit(domain) {
  return DOMAIN_PAYLOAD_LIMITS[domain] ?? DEFAULT_PAYLOAD_LIMIT;
}

/**
 * 墓碑是否已过保留期（严格大于 TTL 才算过期，和 SQL 的 deleted_at < now - TTL 一致）。
 * @param {number} deletedAt 删除时间戳（毫秒）
 * @param {number} [now]
 * @returns {boolean}
 */
export function isTombstoneExpired(deletedAt, now = Date.now()) {
  const at = Number(deletedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > TOMBSTONE_TTL_MS;
}

/**
 * 墓碑过期截止点：deleted_at < cutoff 的墓碑可以清理。
 * @param {number} [now]
 * @param {number} [days]
 * @returns {number}
 */
export function tombstoneCutoff(now = Date.now(), days = TOMBSTONE_TTL_DAYS) {
  const safeDays = Number.isFinite(Number(days)) ? Math.max(0, Number(days)) : TOMBSTONE_TTL_DAYS;
  return Number(now) - safeDays * DAY_MS;
}
