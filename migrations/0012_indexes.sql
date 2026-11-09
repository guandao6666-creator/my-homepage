-- Guandao OS 1.9 · 热点查询索引补齐
--
-- 背景：1.5–1.8 的表是在功能迭代中逐步加列的，查询语句后来加了 WHERE 条件，
-- 但索引没跟上。Cron（每 15 分钟）与列表接口因此出现全表扫描。
-- 本迁移只加索引，不改表结构、不删数据，向前兼容（可安全回滚：DROP INDEX）。
--
-- 检查过现有查询后新增：
--   1. security_events(created_at)     —— 隐私清理按时间删过期事件
--   2. data_exports(expires_at)        —— 导出包过期清理
--   3. files(user_id, status)          —— 云盘列表 / 配额统计
--   4. files(user_id, trash_group)     —— 回收站分组
--   5. sessions(revoked_at)            —— 会话有效性查询
--   6. backups(user_id, status, deleted_at) —— 备份列表与活跃任务判断
--   7. plugins(status, featured_at)    —— 插件市场首页
--   8. community_posts(status, published_at) —— 社区公开列表
--   9. plugin_audit_logs(plugin_id, created_at) —— 插件审计按时间查
--  10. device_pairings(code_hash, status) —— 配对码查找（防枚举）

CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events (created_at);
CREATE INDEX IF NOT EXISTS idx_data_exports_expires ON data_exports (expires_at);

CREATE INDEX IF NOT EXISTS idx_files_user_status ON files (user_id, status);
CREATE INDEX IF NOT EXISTS idx_files_user_trash ON files (user_id, trash_group);

CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions (revoked_at);

CREATE INDEX IF NOT EXISTS idx_backups_user_status ON backups (user_id, status, deleted_at);

CREATE INDEX IF NOT EXISTS idx_plugins_status_featured ON plugins (status, featured_at);

CREATE INDEX IF NOT EXISTS idx_community_posts_status_published ON community_posts (status, published_at);

CREATE INDEX IF NOT EXISTS idx_device_pairings_code ON device_pairings (code_hash, status);