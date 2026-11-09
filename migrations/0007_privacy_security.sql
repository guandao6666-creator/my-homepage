-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0007_privacy_security.sql
--
-- Privacy & Security Center：安全事件、隐私设置、数据导出、删除任务、
-- 账号注销重新验证与审计。全部为增量，不重建已有表。
-- ---------------------------------------------------------------------------

-- 注销状态：none → pending → completed。不改 users.status（active/disabled）。
ALTER TABLE users ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'none'
  CHECK (deletion_state IN ('none', 'pending', 'completed'));

-- OAuth state 复用：区分普通登录与注销前的重新验证。
ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'auth'
  CHECK (purpose IN ('auth', 'delete'));

-- 统一安全事件。user_id 可为 NULL：账号删除后保留最小化审计，
-- 只记录事件类型与时间，不保留任何内容。
CREATE TABLE IF NOT EXISTS security_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'successful_login', 'failed_login', 'new_device_registered',
                  'session_created', 'session_revoked', 'suspicious_access_blocked',
                  'data_export_started', 'data_export_completed',
                  'data_deletion_started', 'data_deletion_completed',
                  'account_deletion_started', 'account_deletion_completed',
                  'privacy_settings_changed', 'local_data_cleared'
                )),
  device_id     TEXT,
  result        TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failure', 'blocked')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_events_user
  ON security_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_type
  ON security_events (user_id, event_type, created_at DESC);

-- 隐私设置：云端同步 / 主动上传允许的类型。
CREATE TABLE IF NOT EXISTS privacy_settings (
  user_id          TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  cloud_sync       INTEGER NOT NULL DEFAULT 1 CHECK (cloud_sync IN (0, 1)),
  allow_notes      INTEGER NOT NULL DEFAULT 1 CHECK (allow_notes IN (0, 1)),
  allow_tasks      INTEGER NOT NULL DEFAULT 1 CHECK (allow_tasks IN (0, 1)),
  allow_calendar   INTEGER NOT NULL DEFAULT 1 CHECK (allow_calendar IN (0, 1)),
  allow_desktop    INTEGER NOT NULL DEFAULT 1 CHECK (allow_desktop IN (0, 1)),
  allow_workspace  INTEGER NOT NULL DEFAULT 1 CHECK (allow_workspace IN (0, 1)),
  updated_at       INTEGER NOT NULL
);

-- 数据导出：先写 manifest 与结构化数据，文件按批次复制到独立前缀。
CREATE TABLE IF NOT EXISTS data_exports (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  export_type     TEXT NOT NULL DEFAULT 'full' CHECK (export_type IN ('full', 'metadata', 'content')),
  status          TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('queued', 'collecting', 'uploading', 'verifying', 'completed', 'failed', 'expired')),
  scopes_json     TEXT NOT NULL CHECK (json_valid(scopes_json)),
  object_prefix   TEXT NOT NULL,
  data_key        TEXT,
  manifest_key    TEXT,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  expires_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_data_exports_user
  ON data_exports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  export_id        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage            TEXT NOT NULL DEFAULT 'collecting',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  processed_items  INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0,
  checkpoint_json  TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  error_message    TEXT,
  started_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_data_export_jobs_export
  ON data_export_jobs (user_id, export_id, started_at DESC);

-- 数据 / 账号删除任务：按阶段执行，可重试。
CREATE TABLE IF NOT EXISTS data_deletion_jobs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  deletion_type    TEXT NOT NULL CHECK (deletion_type IN ('files', 'backups', 'content', 'account')),
  status           TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  current_stage    TEXT NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  processed_items  INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0,
  checkpoint_json  TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  error_code       TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_data_deletion_jobs_user
  ON data_deletion_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_deletion_jobs_status
  ON data_deletion_jobs (status, updated_at);

-- 注销前的重新验证票据：只保存哈希，10 分钟有效。
CREATE TABLE IF NOT EXISTS reauth_tickets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL DEFAULT 'delete',
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reauth_tickets_expiry
  ON reauth_tickets (expires_at);

-- 账号删除的最小化审计：不含邮箱、用户名、内容或令牌。
CREATE TABLE IF NOT EXISTS account_deletion_audit (
  id            TEXT PRIMARY KEY,
  user_ref_hash TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  completed_at  INTEGER,
  stages_json   TEXT CHECK (stages_json IS NULL OR json_valid(stages_json)),
  result        TEXT NOT NULL DEFAULT 'pending'
);
