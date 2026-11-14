-- ---------------------------------------------------------------------------
-- Guandao OS 1.6 · 0009_community.sql
--
-- Community & Sharing：多用户社区资料、作品、内容包版本、互动、关注、
-- 通知、举报、审核审计、社区设置、邀请注册与 R2 资源索引。
--
-- 全部为增量变更：不重建、不覆盖 0001–0008 已存在的任何表。
--
-- 关键约束：
--   * 所有社区内容表都带 author_id / user_id，接口层只使用 Session 中的
--     user_id，绝不接受客户端传入身份；
--   * 角色：管理员仍是 users.role='admin'（数据库唯一约束保证只有一个），
--     审核员单独放在 community_roles，普通用户为 member；
--   * 点赞 / 收藏 / 关注 / 举报使用数据库唯一约束，服务端无法制造重复数据；
--   * 计数列只是查询缓存，写入后统一用 COUNT(*) 重算，避免并发漂移；
--   * 时间统一为 INTEGER 毫秒时间戳（UTC）。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 社区全局设置（单行）。默认关闭注册：管理员显式开启后社区才可加入。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  registration_mode       TEXT NOT NULL DEFAULT 'closed'
                            CHECK (registration_mode IN ('closed', 'invite', 'open')),
  require_review          INTEGER NOT NULL DEFAULT 1 CHECK (require_review IN (0, 1)),
  member_login            INTEGER NOT NULL DEFAULT 1 CHECK (member_login IN (0, 1)),
  allow_publishing        INTEGER NOT NULL DEFAULT 1 CHECK (allow_publishing IN (0, 1)),
  max_posts_per_day       INTEGER NOT NULL DEFAULT 5 CHECK (max_posts_per_day BETWEEN 1 AND 100),
  max_comments_per_day    INTEGER NOT NULL DEFAULT 60 CHECK (max_comments_per_day BETWEEN 1 AND 500),
  max_packages_per_user   INTEGER NOT NULL DEFAULT 40 CHECK (max_packages_per_user BETWEEN 1 AND 500),
  max_user_storage_bytes  INTEGER NOT NULL DEFAULT 52428800 CHECK (max_user_storage_bytes > 0),
  max_upload_bytes        INTEGER NOT NULL DEFAULT 8388608 CHECK (max_upload_bytes > 0),
  community_name          TEXT NOT NULL DEFAULT 'Guandao Community',
  announcement            TEXT NOT NULL DEFAULT '',
  updated_at              INTEGER NOT NULL,
  updated_by              TEXT REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO community_settings (id, updated_at)
SELECT 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM community_settings WHERE id = 1);

-- ---------------------------------------------------------------------------
-- 社区资料。公开资料与私人账号数据严格分离：
-- users 表里的 email / github 数字 ID / Session 永远不会出现在社区接口。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name       TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  bio                TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 600),
  creator_title      TEXT NOT NULL DEFAULT '' CHECK (length(creator_title) <= 40),
  avatar_asset_id    TEXT,
  cover_asset_id     TEXT,
  visibility         TEXT NOT NULL DEFAULT 'public'
                       CHECK (visibility IN ('public', 'private')),
  restriction        TEXT NOT NULL DEFAULT 'none'
                       CHECK (restriction IN ('none', 'limited', 'blocked')),
  restriction_reason TEXT CHECK (restriction_reason IS NULL OR length(restriction_reason) <= 300),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_profiles_visibility
  ON community_profiles (visibility, created_at DESC);

-- 审核员角色。管理员仍由 users.role='admin' 表示，二者合并为有效角色。
CREATE TABLE IF NOT EXISTS community_roles (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('moderator')),
  granted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 邀请注册：只保存邀请码的 SHA-256，明文只在创建时返回一次。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_invites (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 500),
  used_count  INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at  INTEGER,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_invites_created
  ON community_invites (created_at DESC);

-- OAuth 注册意图：按 OAuth state 哈希关联，回调时一次性消费。
-- 不把邀请码明文写进 Cookie 或 URL 日志。
CREATE TABLE IF NOT EXISTS community_join_intents (
  state_hash  TEXT PRIMARY KEY,
  invite_id   TEXT REFERENCES community_invites (id) ON DELETE SET NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('open', 'invite')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_community_join_intents_expiry
  ON community_join_intents (expires_at);

-- ---------------------------------------------------------------------------
-- R2 资源索引。object_key 完全由服务端生成，客户端永远不能指定路径。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_assets (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id          TEXT,
  parent_asset_id  TEXT,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'avatar', 'cover', 'cover_thumb', 'preview', 'preview_thumb',
                     'wallpaper', 'wallpaper_thumb'
                   )),
  object_key       TEXT NOT NULL UNIQUE,
  mime_type        TEXT NOT NULL CHECK (mime_type IN (
                     'image/jpeg', 'image/png', 'image/webp', 'image/gif'
                   )),
  size_bytes       INTEGER NOT NULL CHECK (size_bytes > 0),
  width            INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
  height           INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ready'
                     CHECK (status IN ('ready', 'deleting', 'deleted')),
  delete_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_community_assets_owner
  ON community_assets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_assets_post
  ON community_assets (post_id, kind, sort_order);

CREATE INDEX IF NOT EXISTS idx_community_assets_cleanup
  ON community_assets (status, delete_attempts, created_at);

-- ---------------------------------------------------------------------------
-- 作品（帖子）。status 是唯一可见性来源，计数用于列表查询，写后重算。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_posts (
  id                    TEXT PRIMARY KEY,
  author_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_type             TEXT NOT NULL CHECK (post_type IN (
                          'theme', 'widget', 'workspace', 'wallpaper', 'tutorial'
                        )),
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  description           TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 8000),
  category              TEXT NOT NULL DEFAULT 'other' CHECK (length(category) <= 32),
  tags_json             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  cover_asset_id        TEXT,
  cover_thumb_asset_id  TEXT,
  license               TEXT NOT NULL DEFAULT 'CC-BY-4.0',
  license_note          TEXT NOT NULL DEFAULT '' CHECK (length(license_note) <= 600),
  rights_confirmed      INTEGER NOT NULL DEFAULT 0 CHECK (rights_confirmed IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                          'draft', 'pending_review', 'published', 'hidden', 'rejected', 'deleted'
                        )),
  visibility            TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  version               TEXT NOT NULL DEFAULT '1.0.0',
  compatibility_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(compatibility_json)),
  draft_manifest_json   TEXT CHECK (draft_manifest_json IS NULL OR json_valid(draft_manifest_json)),
  package_id            TEXT,
  featured_at           INTEGER,
  featured_by           TEXT REFERENCES users (id) ON DELETE SET NULL,
  moderation_note       TEXT CHECK (moderation_note IS NULL OR length(moderation_note) <= 600),
  like_count            INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  favorite_count        INTEGER NOT NULL DEFAULT 0 CHECK (favorite_count >= 0),
  comment_count         INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  download_count        INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  view_count            INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  published_at          INTEGER,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_community_posts_published
  ON community_posts (status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_type
  ON community_posts (status, post_type, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_author
  ON community_posts (author_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_featured
  ON community_posts (status, featured_at DESC)
  WHERE featured_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_posts_category
  ON community_posts (status, category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_posts_package
  ON community_posts (package_id)
  WHERE package_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 内容包与版本。更新作品只追加新版本，历史版本永远保留。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_packages (
  id                   TEXT PRIMARY KEY,
  author_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id              TEXT NOT NULL UNIQUE REFERENCES community_posts (id) ON DELETE CASCADE,
  package_type         TEXT NOT NULL CHECK (package_type IN (
                         'theme', 'widget', 'workspace', 'wallpaper-collection', 'tutorial'
                       )),
  package_id           TEXT NOT NULL UNIQUE CHECK (length(package_id) BETWEEN 3 AND 80),
  version              TEXT NOT NULL,
  compatibility_json   TEXT NOT NULL CHECK (json_valid(compatibility_json)),
  manifest_object_key  TEXT NOT NULL,
  package_object_key   TEXT NOT NULL,
  checksum_sha256      TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  license              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  size_bytes           INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  delete_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS package_versions (
  id                  TEXT PRIMARY KEY,
  package_id          TEXT NOT NULL REFERENCES community_packages (id) ON DELETE CASCADE,
  version             TEXT NOT NULL,
  changelog           TEXT NOT NULL DEFAULT '' CHECK (length(changelog) <= 2000),
  manifest_object_key TEXT NOT NULL,
  package_object_key  TEXT NOT NULL,
  checksum_sha256     TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  compatibility_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(compatibility_json)),
  size_bytes          INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_at          INTEGER NOT NULL,
  published_at        INTEGER,
  UNIQUE (package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_package_versions_package
  ON package_versions (package_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 互动：数据库唯一约束保证同用户同作品只有一条有效记录。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_likes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_community_likes_post
  ON community_likes (post_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_favorites (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  collection TEXT NOT NULL DEFAULT 'default' CHECK (length(collection) BETWEEN 1 AND 32),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_community_favorites_user
  ON community_favorites (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_favorites_post
  ON community_favorites (post_id);

-- 两层评论：parent_id 为空是一级评论；回复的 parent_id 指向一级评论。
CREATE TABLE IF NOT EXISTS community_comments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES community_comments (id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '' CHECK (status = 'deleted' OR length(content) BETWEEN 1 AND 1000),
  status     TEXT NOT NULL DEFAULT 'visible'
               CHECK (status IN ('visible', 'hidden', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_comments_post
  ON community_comments (post_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_comments_parent
  ON community_comments (parent_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_community_comments_user
  ON community_comments (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_follows (
  follower_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_community_follows_following
  ON community_follows (following_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 举报与审核。同一用户对同一目标只保留一条举报记录。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'profile')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN (
                 'copyright', 'malicious', 'inappropriate', 'spam',
                 'impersonation', 'harassment', 'other'
               )),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  resolution   TEXT CHECK (resolution IS NULL OR length(resolution) <= 600),
  reviewer_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  UNIQUE (reporter_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_community_reports_status
  ON community_reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_reports_target
  ON community_reports (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_audit_logs (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK (length(action) BETWEEN 2 AND 64),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'profile', 'user', 'settings', 'invite', 'report')),
  target_id   TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_audit_created
  ON community_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_audit_actor
  ON community_audit_logs (actor_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 通知。payload_json 只存展示所需的摘要，不存 Session、IP 或私密内容。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN (
                'comment', 'reply', 'post_review', 'post_update', 'follow', 'like', 'moderation'
              )),
  actor_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  post_id     TEXT REFERENCES community_posts (id) ON DELETE CASCADE,
  comment_id  TEXT REFERENCES community_comments (id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_notifications_user
  ON community_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_community_notifications_unread
  ON community_notifications (user_id, read_at, created_at DESC);

-- ---------------------------------------------------------------------------
-- 浏览统计：只按「作品 + 日期」聚合，不记录用户、IP、设备或精确位置。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_view_daily (
  post_id TEXT NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  day     TEXT NOT NULL CHECK (length(day) = 10),
  views   INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (post_id, day)
);

CREATE INDEX IF NOT EXISTS idx_community_view_daily_day
  ON community_view_daily (day, views DESC);
