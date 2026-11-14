-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0004_devices.sql
--
-- Guandao Devices：设备注册、心跳、Session 撤销与安全审计。
-- 只做增量，不改 0001–0003 已有数据。
--
-- 设计约束：
--   * devices 已在 0001 建好（id / user_id / name / platform / app_version /
--     last_seen_at / revoked_at / created_at），这里补设备类型、浏览器、系统、
--     活跃时间、同步时间、信任状态与状态字段，不重建表。
--   * sessions 已在 0002 建好，已有 device_id / last_used_at；这里只补 revoked_at。
--     撤销用标记而不是删行，便于审计；过期清理由 purgeExpired 负责。
--   * device_id 由服务端在登录时生成并写入 Cookie，不作为认证凭证；
--     所有查询都必须带 user_id，禁止仅凭 device_id 读取。
--   * 活动日志只记录动作与计数，禁止写入 Token、Secret、笔记正文或文件内容。
-- ---------------------------------------------------------------------------

-- 设备类型。UA 无法可靠区分台式机与笔记本，默认 desktop，允许用户自行更正。
ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'desktop'
  CHECK (device_type IN ('desktop', 'laptop', 'tablet', 'mobile'));

ALTER TABLE devices ADD COLUMN browser_name TEXT;
ALTER TABLE devices ADD COLUMN os_name TEXT;

-- last_active_at：最近一次「前台心跳」；last_seen_at：最近一次任意心跳。
-- 两者分开，避免把后台标签页误判成持续在线。
ALTER TABLE devices ADD COLUMN last_active_at INTEGER;
ALTER TABLE devices ADD COLUMN last_sync_at INTEGER;

-- trust：新设备首次登录为未确认；用户在已有设备上确认后写入 trusted_at。
ALTER TABLE devices ADD COLUMN trusted_at INTEGER;

-- status 与 revoked_at 同时维护：revoked_at 给审计，status 给查询。
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'revoked'));

-- 只保留有限 UA 解析结果，用于设备卡片展示，不做指纹识别。
ALTER TABLE devices ADD COLUMN user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_user_status
  ON devices (user_id, status, last_seen_at DESC);

-- Session 撤销。NULL 表示未撤销；过期仍然以 expires_at 为准。
ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_device
  ON sessions (device_id, revoked_at, expires_at);

-- 设备活动日志：只记录事件类型与最小元数据。
CREATE TABLE IF NOT EXISTS device_activity (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id     TEXT,
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'registered', 'signed_in', 'signed_out', 'renamed',
                  'device_revoked', 'session_revoked', 'trusted',
                  'sync_success', 'sync_failed', 'sync_requested'
                )),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_activity_user
  ON device_activity (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_activity_device
  ON device_activity (user_id, device_id, created_at DESC);

-- 每台设备、每类数据的同步状态。
-- mode = 'cloud' 表示该数据真的在服务端（当前只有 drive）；
-- mode = 'local' 表示仍为浏览器本地存储，不得显示成「已同步」。
CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id         TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  domain            TEXT NOT NULL CHECK (domain IN ('notes', 'tasks', 'calendar', 'drive')),
  mode              TEXT NOT NULL DEFAULT 'local' CHECK (mode IN ('cloud', 'local')),
  last_attempt_at   INTEGER,
  last_sync_at      INTEGER,
  last_result       TEXT CHECK (last_result IS NULL OR last_result IN ('success', 'failed')),
  pending_up        INTEGER NOT NULL DEFAULT 0 CHECK (pending_up >= 0),
  pending_down      INTEGER NOT NULL DEFAULT 0 CHECK (pending_down >= 0),
  conflicts         INTEGER NOT NULL DEFAULT 0 CHECK (conflicts >= 0),
  message           TEXT,
  sync_requested_at INTEGER,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (device_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_device_sync_user
  ON device_sync_state (user_id, updated_at DESC);
