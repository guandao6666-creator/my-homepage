/**
 * Guandao OS 1.6 · 社区维护任务（Cron Trigger 调用）
 *
 * 处理所有「响应里不能等待」的清理：
 *   - R2 图片删除失败重试（community_assets.status='deleting'）
 *   - 作品删除后的内容包对象清理（community_packages.status='deleted'）
 *   - 48 小时未被作品引用的孤儿上传（草稿上传后放弃）
 *   - 过期邀请 / 过期注册意图 / 过期通知
 *
 * 所有操作都带重试计数，失败不会阻塞下一次 Cron。
 */

const MAX_DELETE_ATTEMPTS = 8;

export async function runCommunityMaintenance(env) {
  if (!env?.DB) return;
  const now = Date.now();

  // 1) 图片删除：最多 60 个 / 次
  if (env.FILES) {
    try {
      const rows = await env.DB.prepare(
        `SELECT * FROM community_assets
          WHERE status = 'deleting' AND delete_attempts < ?
          ORDER BY created_at ASC LIMIT 60`,
      )
        .bind(MAX_DELETE_ATTEMPTS)
        .all();
      for (const asset of rows.results || []) {
        try {
          await env.FILES.delete(asset.object_key);
          await env.DB.prepare(
            "UPDATE community_assets SET status = 'deleted', deleted_at = ?, last_error = NULL WHERE id = ?",
          )
            .bind(now, asset.id)
            .run();
        } catch (error) {
          await env.DB.prepare(
            "UPDATE community_assets SET delete_attempts = delete_attempts + 1, last_error = ? WHERE id = ?",
          )
            .bind(String(error?.message ?? error).slice(0, 200), asset.id)
            .run();
        }
      }
    } catch (error) {
      console.error("[community] asset cleanup failed:", error?.message ?? error);
    }

    // 2) 已删除作品的内容包对象：把当前包与所有历史版本都删掉
    try {
      const packages = await env.DB.prepare(
        `SELECT * FROM community_packages
          WHERE status = 'deleted' AND delete_attempts < ?
            AND (package_object_key <> '' OR manifest_object_key <> '')
          ORDER BY updated_at ASC LIMIT 20`,
      )
        .bind(MAX_DELETE_ATTEMPTS)
        .all();
      for (const pkg of packages.results || []) {
        try {
          const versions = await env.DB.prepare("SELECT package_object_key, manifest_object_key FROM package_versions WHERE package_id = ?")
            .bind(pkg.id)
            .all();
          const keys = new Set(
            [
              pkg.package_object_key,
              pkg.manifest_object_key,
              ...(versions.results || []).flatMap((row) => [row.package_object_key, row.manifest_object_key]),
            ].filter(Boolean),
          );
          for (const key of keys) await env.FILES.delete(key);
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE community_packages SET package_object_key = '', manifest_object_key = '', delete_attempts = delete_attempts + 1, last_error = NULL WHERE id = ?",
            ).bind(pkg.id),
            env.DB.prepare(
              "UPDATE package_versions SET package_object_key = '', manifest_object_key = '' WHERE package_id = ?",
            ).bind(pkg.id),
          ]);
        } catch (error) {
          await env.DB.prepare(
            "UPDATE community_packages SET delete_attempts = delete_attempts + 1, last_error = ? WHERE id = ?",
          )
            .bind(String(error?.message ?? error).slice(0, 200), pkg.id)
            .run();
        }
      }
    } catch (error) {
      console.error("[community] package cleanup failed:", error?.message ?? error);
    }
  }

  // 3) 孤儿上传：48 小时内没有被作品或资料引用，且不是头像 / 封面
  try {
    const cutoff = now - 48 * 3600 * 1000;
    await env.DB.prepare(
      `UPDATE community_assets
          SET status = 'deleting', post_id = NULL
        WHERE status = 'ready' AND post_id IS NULL AND created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM community_profiles p
             WHERE p.avatar_asset_id = community_assets.id OR p.cover_asset_id = community_assets.id
          )`,
    )
      .bind(cutoff)
      .run();
  } catch (error) {
    console.error("[community] orphan sweep failed:", error?.message ?? error);
  }

  // 4) 过期邀请 / 注册意图 / 旧通知
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE community_invites SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?",
      ).bind(now, now),
      env.DB.prepare("DELETE FROM community_join_intents WHERE expires_at < ?").bind(now - 7 * 86400000),
      env.DB.prepare("DELETE FROM community_notifications WHERE created_at < ? AND read_at IS NOT NULL").bind(
        now - 180 * 86400000,
      ),
      env.DB.prepare("DELETE FROM community_view_daily WHERE day < ?").bind(
        new Date(now - 400 * 86400000).toISOString().slice(0, 10),
      ),
    ]);
  } catch (error) {
    console.error("[community] retention cleanup failed:", error?.message ?? error);
  }
}

/** 供 /api/health 或管理后台显示的清理状态。 */
export async function communityMaintenanceStats(env) {
  const [assets, packages] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS pending, COALESCE(SUM(delete_attempts), 0) AS attempts FROM community_assets WHERE status = 'deleting'",
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS pending FROM community_packages WHERE status = 'deleted' AND package_object_key <> ''",
    ).first(),
  ]);
  return {
    pendingAssets: Number(assets?.pending || 0),
    assetDeleteAttempts: Number(assets?.attempts || 0),
    pendingPackages: Number(packages?.pending || 0),
  };
}
