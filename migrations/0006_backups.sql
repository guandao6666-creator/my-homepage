-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0006_backups.sql
--
-- Guandao Backup Center：云端备份、完整性校验、恢复与自动备份设置。
--
-- 约定：
--   * 0001 已建 backups 表（id/user_id/kind/r2_key/size_bytes/note_count/
--     expires_at/created_at），这里只做增量扩展，不重建、不丢数据。
--   * kind 仍保持 'manual' | 'scheduled' 两值以兼容旧约束；
--     更细的类型放在新增的 backup_type（manual/auto/protective）。
--   * 所有表都带 user_id，所有查询必须绑定 user_id。
--   * 备份对象与实时对象分离：users/{uid}/files/{id} 与
--     users/{uid}/backups/{backupId}/files/{id} 是两份独立内容。
-- ---------------------------------------------------------------------------

ALTER TABLE backups ADD COLUMN backup_name TEXT;
ALTER TABLE backups ADD COLUMN backup_type TEXT NOT NULL DEFAULT 'manual'
  CHECK (backup_type IN ('manual', 'auto', 'protective'));
ALTER TABLE backups ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'
  CHECK (scope IN ('full', 'partial', 'drive'));
ALTER TABLE backups ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'collecting', 'uploading', 'verifying', 'completed', 'failed', 'cancelled'));
ALTER TABLE backups ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE backups ADD COLUMN snapshot_at INTEGER;
ALTER TABLE backups ADD COLUMN completed_at INTEGER;
ALTER TABLE backups ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backups ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backups ADD COLUMN checksum_sha256 TEXT;
ALTER TABLE backups ADD COLUMN manifest_object_key TEXT;
ALTER TABLE backups ADD COLUMN data_object_key TEXT;
ALTER TABLE backups ADD COLUMN source_cursor INTEGER;
ALTER TABLE backups ADD COLUMN parent_backup_id TEXT;
ALTER TABLE backups ADD COLUMN error_message TEXT;
ALTER TABLE backups ADD COLUMN domains_json TEXT;
ALTER TABLE backups ADD COLUMN stats_json TEXT;
ALTER TABLE backups ADD COLUMN verified_at INTEGER;
ALTER TABLE backups ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_backups_user_created
  ON backups (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_backups_user_status
  ON backups (user_id, status, created_at DESC);

-- 备份任务：一个备份可以有多次执行（重试 / 校验 / 恢复各自独立）。
CREATE TABLE IF NOT EXISTS backup_jobs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  backup_id        TEXT,
  job_type         TEXT NOT NULL CHECK (job_type IN ('backup', 'verify', 'restore')),
  status           TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage            TEXT NOT NULL DEFAULT 'queued',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  processed_items  INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0,
  checkpoint_json  TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  retry_count      INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  started_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_backup
  ON backup_jobs (user_id, backup_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_status
  ON backup_jobs (status, updated_at);

-- 备份条目：文件与结构化记录都登记，便于按记录恢复与审计。
CREATE TABLE IF NOT EXISTS backup_items (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  backup_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL CHECK (entity_type IN (
                    'note', 'note_folder', 'task', 'event', 'desktop', 'workspace', 'file', 'folder'
                  )),
  entity_id       TEXT NOT NULL,
  source_revision INTEGER,
  object_key      TEXT,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  meta_json       TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_items_backup
  ON backup_items (user_id, backup_id, entity_type);

CREATE INDEX IF NOT EXISTS idx_backup_items_entity
  ON backup_items (user_id, backup_id, entity_id);

-- 备份设置：每用户一行。自动备份只覆盖服务端数据（Cloud Drive）；
-- 本地 Notes/Tasks/Calendar 必须在设备上由客户端上传快照。
CREATE TABLE IF NOT EXISTS backup_settings (
  user_id          TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  auto_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (auto_enabled IN (0, 1)),
  frequency        TEXT NOT NULL DEFAULT 'off' CHECK (frequency IN ('off', 'daily', 'weekly')),
  scope_json       TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  retention_daily  INTEGER NOT NULL DEFAULT 7 CHECK (retention_daily BETWEEN 1 AND 30),
  retention_weekly INTEGER NOT NULL DEFAULT 4 CHECK (retention_weekly BETWEEN 1 AND 16),
  last_auto_at     INTEGER,
  last_auto_status TEXT,
  last_auto_backup TEXT,
  updated_at       INTEGER NOT NULL
);

-- 恢复记录：支持幂等键，防止刷新 / 重试重复生成数据。
CREATE TABLE IF NOT EXISTS backup_restores (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  backup_id             TEXT NOT NULL,
  mode                  TEXT NOT NULL CHECK (mode IN ('copy', 'merge', 'replace')),
  domains_json          TEXT NOT NULL CHECK (json_valid(domains_json)),
  status                TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'awaiting_client', 'completed', 'failed', 'cancelled')),
  protective_backup_id  TEXT,
  idempotency_key       TEXT,
  stats_json            TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),
  error_message         TEXT,
  created_at            INTEGER NOT NULL,
  completed_at          INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_restores_idem
  ON backup_restores (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_backup_restores_user
  ON backup_restores (user_id, created_at DESC);

-- 恢复任务的文件复制进度（重试与断点续传）。
CREATE TABLE IF NOT EXISTS backup_restore_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  restore_id    TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  new_file_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'copied', 'verified', 'failed')),
  error_message TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_restore_items
  ON backup_restore_items (user_id, restore_id, status);
