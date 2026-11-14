-- Guandao OS 2.0 · D1 备份运行记录（增量，只新增表）
-- 仅记录备份元数据；不记录 SQL、Token、Cookie、signed_url 或用户内容。

CREATE TABLE IF NOT EXISTS d1_backup_runs (
  run_id         TEXT PRIMARY KEY,
  database_ref   TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  status         TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  bookmark       TEXT,
  object_key     TEXT,
  manifest_key   TEXT,
  sql_bytes      INTEGER,
  sha256         TEXT,
  upload_status  TEXT,
  verify_status  TEXT,
  error_code     TEXT,
  error_message  TEXT,
  notified_at    INTEGER,
  notify_error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_d1_backup_runs_finished
  ON d1_backup_runs (finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_d1_backup_runs_status
  ON d1_backup_runs (status, finished_at DESC);