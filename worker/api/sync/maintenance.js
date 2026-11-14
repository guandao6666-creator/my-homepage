/**
 * Guandao OS 2.0 · Phase 4 同步墓碑定时维护
 *
 * 每 15 分钟的 Cron 调一次：
 *   - 把超过 TTL（90 天）的墓碑物理清理掉，控制 sync_entities 体积；
 *   - 清理前先把「最后删除 revision / deleted_at」写进 sync_tombstone_ledger，
 *     保证旧设备拿旧 baseRevision 重推仍然被防复活逻辑拦下；
 *   - 每次运行写一行 sync_cleanup_log（成功/失败都写），日志只保留最近 200 条。
 *
 * 设计约束：
 *   - 这里绝不能把异常抛给 Worker 的 scheduled（其他任务还在同一 Cron 里跑），
 *     所有错误都在内部捕获并记日志；
 *   - 单次最多清理 CLEANUP_MAX_PER_RUN 条，避免长事务拖慢线上读写；
 *   - 返回 summary 供日志/调试，不依赖返回值做业务判断。
 */

import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_MAX_PER_RUN,
  TOMBSTONE_TTL_DAYS,
} from "./limits.js";
import { purgeExpiredTombstones } from "./store.js";

/** 清理日志只保留最近这么多条（Phase 3 的隐私清理日志同理，避免日志表无限增长）。 */
const CLEANUP_LOG_LIMIT = 200;

/**
 * 运行一次墓碑清理。
 * @param {object} env Worker env（需要 DB 绑定）
 * @param {{ now?: number }} [options] now 便于测试注入固定时钟
 * @returns {Promise<{
 *   status: "ok" | "error",
 *   scanned: number,
 *   purged: number,
 *   cutoff: number,
 *   detail: string,
 *   durationMs: number,
 * }>}
 */
export async function runSyncTombstoneMaintenance(env, options = {}) {
  const startedAt = Date.now();
  const now = Number(options.now) || startedAt;
  let cutoff = now - TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let purged = 0;
  let status = "ok";
  let detail = "";

  try {
    let remaining = CLEANUP_MAX_PER_RUN;
    while (remaining > 0) {
      const batchSize = Math.min(CLEANUP_BATCH_SIZE, remaining);
      const result = await purgeExpiredTombstones(env, {
        now,
        days: TOMBSTONE_TTL_DAYS,
        batchSize,
      });
      cutoff = result.cutoff;
      scanned += result.scanned;
      purged += result.purged;
      remaining -= Math.max(result.scanned, result.purged);
      // 这一批没取满，说明过期墓碑已经清完，提前结束。
      if (result.scanned < batchSize) break;
    }
    detail = `purged ${purged} of ${scanned} expired tombstones`;
  } catch (error) {
    status = "error";
    detail = String(error?.message ?? error).slice(0, 500);
    console.error("[sync] tombstone maintenance failed:", detail);
  }

  const durationMs = Date.now() - startedAt;
  try {
    await recordCleanupLog(env, { now, cutoff, scanned, purged, status, detail });
  } catch (error) {
    // 日志写失败不能影响下一次 Cron，也不能让 scheduled 任务变成未处理的 rejection。
    console.error("[sync] cleanup log write failed:", error?.message ?? error);
  }

  return { status, scanned, purged, cutoff, detail, durationMs };
}

/**
 * 写清理日志并裁剪历史（按自增 id 保留最新 CLEANUP_LOG_LIMIT 条）。
 * @param {object} env
 * @param {{ now: number, cutoff: number, scanned: number, purged: number, status: string, detail: string }} entry
 */
async function recordCleanupLog(env, entry) {
  await env.DB.prepare(
    `INSERT INTO sync_cleanup_log (ran_at, cutoff, scanned, purged, status, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(entry.now, entry.cutoff, entry.scanned, entry.purged, entry.status, entry.detail || null)
    .run();

  await env.DB.prepare(
    `DELETE FROM sync_cleanup_log
      WHERE id NOT IN (SELECT id FROM sync_cleanup_log ORDER BY id DESC LIMIT ?)`,
  )
    .bind(CLEANUP_LOG_LIMIT)
    .run();
}
