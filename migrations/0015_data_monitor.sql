-- Guandao OS 2.0 · 生产数据异常监控（增量，只新增表）
-- 不修改、不重建任何现有表；不包含用户内容、Token、Cookie 或 Session 数据。

CREATE TABLE IF NOT EXISTS data_monitor_snapshots (
  id           TEXT PRIMARY KEY,
  captured_at  INTEGER NOT NULL,
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'anomaly', 'error')),
  error_code   TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_monitor_snapshots_time
  ON data_monitor_snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS data_monitor_alerts (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  code            TEXT NOT NULL,
  message         TEXT NOT NULL,
  metrics_json    TEXT NOT NULL CHECK (json_valid(metrics_json)),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  notified_at     INTEGER,
  notify_error    TEXT,
  dedupe_key      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_monitor_alerts_dedupe
  ON data_monitor_alerts (dedupe_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_monitor_alerts_status
  ON data_monitor_alerts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS data_monitor_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);