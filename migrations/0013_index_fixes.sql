-- Guandao OS 2.0 · 索引修正与备份分页支持
--
-- 背景（2.0 审计发现）：
--   1. 0006 与 0001 都建了 idx_backups_user_created；
--      0012 又想建 idx_backups_user_status（0006 已存在同名），
--      因为用了 IF NOT EXISTS，后加的列定义被静默跳过 —— 线上缺少预期索引。
--   2. backups 列表查询是 (user_id, deleted_at, created_at) 组合，
--      现有索引都不完全覆盖。
--   3. 2.0 去掉了 listBackupItems 的 LIMIT 5000 硬顶，改为分页读取，
--      需要 (user_id, backup_id, entity_type, id) 的稳定排序索引。
--
-- 本次迁移只做「新增 + 重命名」，不删列、不删数据：
--   - 用新名字建正确的索引（IF NOT EXISTS 保证可重复执行）；
--   - 旧名字的索引保留（可能有别的查询在用），只新增更精确的版本；
--   - 回滚：DROP INDEX 新建的三条即可，旧结构不受影响。

CREATE INDEX IF NOT EXISTS idx_backups_user_created_active
  ON backups (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_backups_user_status_deleted
  ON backups (user_id, status, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_items_backup_entity
  ON backup_items (user_id, backup_id, entity_type, id);

-- 备份任务按用户 + 状态查找（hasActiveBackup / 续跑）
CREATE INDEX IF NOT EXISTS idx_backup_jobs_user_status
  ON backup_jobs (user_id, status, started_at DESC);