-- ---------------------------------------------------------------------------
-- Guandao OS 1.5 · 0002_account.sql
--
-- 账号与身份认证。只做增量：不改动 0001 已建的表结构和数据。
-- users 表沿用 0001 的 id / email / display_name / status / created_at / updated_at，
-- 这里补充 GitHub 身份字段与角色。
--
-- 说明：
--   * email 是 0001 阶段留下的 NOT NULL UNIQUE 字段，账号体系不使用它；
--     注册时写入 GitHub 提供的 noreply 地址（<id>+<login>@users.noreply.github.com），
--     既满足约束，也不会伪造真实邮箱。
--   * github_id 使用 GitHub 数字 ID，用户名可变，数字 ID 不变。
--   * 只允许一个管理员：partial unique index 在数据库层兜底。
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN github_id INTEGER;
ALTER TABLE users ADD COLUMN github_username TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id
  ON users (github_id)
  WHERE github_id IS NOT NULL;

-- 单管理员约束：并发初始化时数据库直接拒绝第二个 admin。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_admin
  ON users (role)
  WHERE role = 'admin';

-- Session：只保存 token 的 SHA-256，明文只存在于浏览器 Cookie。
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  device_id    TEXT,
  user_agent   TEXT,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON sessions (expires_at);

-- OAuth state：只保存 state 的哈希；PKCE verifier 短期保存，回调后标记消费。
CREATE TABLE IF NOT EXISTS oauth_states (
  id            TEXT PRIMARY KEY,
  state_hash    TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  intent        TEXT NOT NULL DEFAULT 'login' CHECK (intent IN ('login', 'setup')),
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry
  ON oauth_states (expires_at);

-- 首次管理员初始化：OAuth 通过后先拿到 GitHub 身份，再用 setup token 换取管理员。
-- 身份信息只在这里短暂停留，初始化完成即消费。
CREATE TABLE IF NOT EXISTS setup_tickets (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  github_id       INTEGER NOT NULL,
  github_username TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  consumed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_setup_tickets_expiry
  ON setup_tickets (expires_at);
