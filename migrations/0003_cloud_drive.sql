-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0003_cloud_drive.sql
--
-- R2 存文件本体，D1 存元数据。只做增量，不改 0001/0002 已有数据。
-- 现有 files 表（0001）已包含 id/user_id/r2_key/name/mime_type/size_bytes/
-- sha256/deleted_at/created_at，这里补齐目录、状态、收藏与更新时间字段。
-- ---------------------------------------------------------------------------

ALTER TABLE files ADD COLUMN parent_id TEXT;
ALTER TABLE files ADD COLUMN display_name TEXT;
ALTER TABLE files ADD COLUMN extension TEXT;
ALTER TABLE files ADD COLUMN etag TEXT;
ALTER TABLE files ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
  CHECK (status IN ('pending', 'ready', 'trash', 'pending_delete'));
ALTER TABLE files ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
  CHECK (is_favorite IN (0, 1));
ALTER TABLE files ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN trash_group TEXT;

CREATE INDEX IF NOT EXISTS idx_files_user_parent
  ON files (user_id, parent_id, status);

CREATE INDEX IF NOT EXISTS idx_files_user_updated
  ON files (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_files_user_favorite
  ON files (user_id, is_favorite)
  WHERE is_favorite = 1;

-- 虚拟文件夹：R2 不建立物理目录，层级完全由 parent_id 表达。
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  trash_group TEXT,
  deleted_at  INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  CHECK (length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_folders_user_parent
  ON folders (user_id, parent_id, deleted_at);

-- 大文件分片上传会话（本版本预留，普通上传上限 25 MiB）。
CREATE TABLE IF NOT EXISTS multipart_uploads (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  upload_id     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  part_size     INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'aborted', 'expired')),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_multipart_user
  ON multipart_uploads (user_id, status);

-- 必要的操作日志：只记录动作与结果，不记录文件内容。
CREATE TABLE IF NOT EXISTS file_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id    TEXT,
  action     TEXT NOT NULL,
  meta       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_events_user
  ON file_events (user_id, created_at DESC);
