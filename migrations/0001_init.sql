-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0001_init.sql
--
-- 基础数据模型，供后续「账号 / 笔记同步 / 文件存储 / 多设备协同」使用。
-- 本阶段只建表，不提供任何对外读写接口：没有身份认证之前，任何数据路由都
-- 无法判断 user_id 归属，属于越权风险。
--
-- 约定：
--   * 主键统一使用应用侧生成的 UUIDv4（TEXT），便于离线创建后再同步；
--   * 所有业务表都带 user_id，且声明 ON DELETE CASCADE，任何查询必须带
--     `WHERE user_id = ?`，由服务端从会话解析，绝不接受客户端传入；
--   * 时间统一为 INTEGER 毫秒时间戳（UTC），与 JavaScript Date.now() 对齐；
--   * 删除采用软删除（deleted_at），便于多端同步与恢复；
--   * 迁移只做增量：禁止修改已应用过的迁移文件，禁止 DROP 现有数据。
-- ---------------------------------------------------------------------------

-- 用户。密码/口令哈希不放在这里，下一阶段由认证模块单独建表，避免与本表耦合。
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  CHECK (length(email) BETWEEN 3 AND 254)
);

-- 设备。用于多端同步时区分来源，并支持单设备吊销。
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  platform     TEXT,
  app_version  TEXT,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  CHECK (length(name) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_seen
  ON devices (user_id, last_seen_at DESC);

-- 笔记。revision 用于乐观并发控制，避免两台设备互相覆盖。
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'plain')),
  revision   INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  CHECK (length(title) <= 200)
);

-- 列表接口的主要查询路径：某用户未删除的笔记，按更新时间倒序。
CREATE INDEX IF NOT EXISTS idx_notes_user_updated
  ON notes (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- 文件元数据。二进制存 R2，r2_key 由服务端生成，不接受客户端指定路径。
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256     TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  CHECK (length(name) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS idx_files_user_created
  ON files (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- 变更日志（同步游标）。seq 单调递增，客户端用 `since=seq` 拉增量。
CREATE TABLE IF NOT EXISTS sync_changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'file', 'device')),
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload     TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_user_seq
  ON sync_changes (user_id, seq DESC);

CREATE INDEX IF NOT EXISTS idx_sync_changes_entity
  ON sync_changes (user_id, entity_type, entity_id, seq DESC);

-- 备份快照。实际归档文件在 R2，这里只存索引与保留期。
CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'scheduled')),
  r2_key     TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  note_count INTEGER NOT NULL DEFAULT 0 CHECK (note_count >= 0),
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_backups_user_created
  ON backups (user_id, created_at DESC);
