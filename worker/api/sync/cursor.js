/**
 * 增量同步游标。
 *
 * 为什么不用裸 `since` 时间戳：`updated_at` 是毫秒整数，同一毫秒内的多条变更排序只能靠
 * `entity_id`，而 `updated_at > since` 在分页边界会把「与上一页最后一条同毫秒」的其余记录
 * 永久跳过（外部客户端按 limit 分页时真会丢数据）。游标把 (updated_at, entity_id) 二元组
 * 一起带上，查询用 SQL 元组比较，分页既不会遗漏也不会重复。
 *
 * 游标是新增参数/字段，不改既有 `since` 语义：老客户端继续用 since，只是没有这个保证。
 */
const CURSOR_ID_MAX_LENGTH = 128;

/** 把一行同步台账映射成游标字符串；字段不合法时返回 null（调用方据此不带 nextCursor）。 */
export function formatSyncCursor(row) {
  const updatedAt = Number(row?.updated_at);
  const entityId = typeof row?.entity_id === "string" ? row.entity_id : "";
  if (!Number.isInteger(updatedAt) || updatedAt < 0 || !entityId || entityId.length > CURSOR_ID_MAX_LENGTH) {
    return null;
  }
  return `${updatedAt}:${entityId}`;
}

/** 解析客户端回传的游标；格式不对返回 null，由调用方决定忽略还是报 400。 */
export function parseSyncCursor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const splitAt = text.indexOf(":");
  if (splitAt <= 0 || splitAt === text.length - 1) return null;
  const updatedAt = Number(text.slice(0, splitAt));
  const entityId = text.slice(splitAt + 1);
  if (!Number.isInteger(updatedAt) || updatedAt < 0) return null;
  if (!entityId || entityId.length > CURSOR_ID_MAX_LENGTH) return null;
  return { updatedAt, entityId };
}