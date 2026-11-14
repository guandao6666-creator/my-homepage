-- ---------------------------------------------------------------------------
-- Guandao OS 1.7 · 0010_plugins.sql
--
-- Plugin Ecosystem & Developer Platform：插件元数据、版本、安装记录、权限授权、
-- 评价、举报、审计日志、开发者资料与真实下载事件。
--
-- 约束：
--   * 只做增量变更，不重建 0001–0009 的任何表；
--   * 插件包本体放 R2，D1 只存索引、校验值与审核状态；
--   * 所有「用户相关」表都带 user_id，接口层只从 Session 取身份；
--   * 计数列是缓存，写入后统一用 COUNT(*) / SUM() 重算，不接受客户端传值；
--   * 时间统一 INTEGER 毫秒时间戳（UTC）。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 插件主体。一行代表一个「已登记的插件」，版本历史在 plugin_versions。
-- status 与 market 可见性一一对应：只有 published 会进入市场列表。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugins (
  id                    TEXT PRIMARY KEY CHECK (length(id) BETWEEN 5 AND 80),
  developer_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 48),
  description           TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 8000),
  type                  TEXT NOT NULL CHECK (type IN (
                          'application', 'widget', 'command', 'file-handler', 'theme', 'integration'
                        )),
  category              TEXT NOT NULL DEFAULT 'other' CHECK (category IN (
                          'productivity', 'system', 'entertainment', 'education',
                          'creative', 'developer', 'other'
                        )),
  license               TEXT NOT NULL DEFAULT 'MIT' CHECK (length(license) <= 40),
  icon_key              TEXT,
  icon_mime             TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                          'draft', 'pending_review', 'published', 'rejected', 'hidden', 'blocked', 'deleted'
                        )),
  latest_version        TEXT,
  latest_manifest_json  TEXT CHECK (latest_manifest_json IS NULL OR json_valid(latest_manifest_json)),
  permissions_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions_json)),
  compatibility_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(compatibility_json)),
  moderation_note       TEXT CHECK (moderation_note IS NULL OR length(moderation_note) <= 600),
  featured_at           INTEGER,
  featured_by           TEXT REFERENCES users (id) ON DELETE SET NULL,
  download_count        INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  install_count         INTEGER NOT NULL DEFAULT 0 CHECK (install_count >= 0),
  rating_sum            INTEGER NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  rating_count          INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  report_count          INTEGER NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  published_at          INTEGER,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plugins_market
  ON plugins (status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugins_category
  ON plugins (status, category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugins_developer
  ON plugins (developer_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugins_downloads
  ON plugins (status, download_count DESC);

-- 审核队列按提交时间排队；pending_review 的行数很少。
CREATE INDEX IF NOT EXISTS idx_plugins_review_queue
  ON plugins (status, updated_at ASC);

-- ---------------------------------------------------------------------------
-- 版本。每个版本对应 R2 上的一个不可变插件包对象。
-- package_key 由服务端生成，客户端永远不能指定对象路径。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_versions (
  id             TEXT PRIMARY KEY,
  plugin_id      TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  version        TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 32),
  changelog      TEXT NOT NULL DEFAULT '' CHECK (length(changelog) <= 4000),
  manifest_json  TEXT NOT NULL CHECK (json_valid(manifest_json)),
  package_key    TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK (length(package_sha256) = 64),
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                   'pending', 'approved', 'rejected', 'superseded'
                 )),
  review_note    TEXT CHECK (review_note IS NULL OR length(review_note) <= 600),
  reviewed_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL,
  published_at   INTEGER,
  UNIQUE (plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin
  ON plugin_versions (plugin_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 安装记录。一台设备一个浏览器也会有多条账号记录，因此按 (user, plugin) 唯一，
-- 具体设备信息由 existing devices 表负责，不在这里重复。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_installations (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin_id        TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  version          TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status           TEXT NOT NULL DEFAULT 'installed' CHECK (status IN (
                     'installed', 'disabled', 'blocked', 'failed'
                   )),
  package_sha256   TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'market' CHECK (source IN (
                     'market', 'official', 'dev'
                   )),
  installed_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_launched_at INTEGER,
  UNIQUE (user_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_installations_user
  ON plugin_installations (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_installations_plugin
  ON plugin_installations (plugin_id, installed_at DESC);

-- ---------------------------------------------------------------------------
-- 权限授权。默认拒绝：没有这一行就等于没有授权。
-- 主键就是 (user, plugin, permission)，重复授权不会产生第二行。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_permissions (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin_id   TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  permission  TEXT NOT NULL CHECK (length(permission) BETWEEN 3 AND 48),
  granted_via TEXT NOT NULL DEFAULT 'install' CHECK (granted_via IN (
                'install', 'update', 'manual', 'restore'
              )),
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, plugin_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_plugin_permissions_plugin
  ON plugin_permissions (plugin_id, permission);

-- ---------------------------------------------------------------------------
-- 评价：一人一插件一条，可修改；评分 1–5。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_reviews (
  plugin_id  TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1200),
  status     TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_reviews_plugin
  ON plugin_reviews (plugin_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 举报。管理员处理后保留记录，不物理删除。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_reports (
  id              TEXT PRIMARY KEY,
  plugin_id       TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN (
                    'malware', 'privacy', 'misleading', 'broken', 'license', 'other'
                  )),
  detail          TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 1200),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 600),
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolved_by     TEXT REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_reports_status
  ON plugin_reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_reports_plugin
  ON plugin_reports (plugin_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 审计日志：审核、下架、权限变更、开发者操作都写这里。
-- detail_json 禁止写入插件包内容或任何凭据。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_audit_logs (
  id             TEXT PRIMARY KEY,
  actor_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  action         TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 48),
  plugin_id      TEXT,
  target_user_id TEXT,
  detail_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_audit_created
  ON plugin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin
  ON plugin_audit_logs (plugin_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 开发者资料：对外公开的展示信息，与 users 表的私人字段严格分离。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS developer_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  bio          TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 600),
  website      TEXT NOT NULL DEFAULT '' CHECK (length(website) <= 300),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_developer_profiles_created
  ON developer_profiles (created_at DESC);

-- ---------------------------------------------------------------------------
-- 下载事件：用于「最近 30 天趋势」与去重计数，不让同一个账号刷下载量。
-- 只保留必要字段，不含 IP / UA。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_download_events (
  id         TEXT PRIMARY KEY,
  plugin_id  TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version    TEXT NOT NULL,
  day        TEXT NOT NULL CHECK (length(day) = 10),
  created_at INTEGER NOT NULL,
  UNIQUE (plugin_id, user_id, version, day)
);

CREATE INDEX IF NOT EXISTS idx_plugin_downloads_plugin
  ON plugin_download_events (plugin_id, created_at DESC);
