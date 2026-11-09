-- ---------------------------------------------------------------------------
-- Guandao OS 1.8 · 0011_continuity.sql
--
-- Seamless Experience：设备配对、跨设备接力、跨设备纯文本剪贴板、设备上下文。
--
-- 约束：
--   * 只做增量变更，不改 0001–0010；
--   * 所有表都带 user_id，接口层只从 Session 取身份；
--   * 配对码 / 配对 token 只存哈希，原始值只在创建响应里返回一次；
--   * 接力 payload 是用户主动发送的内容快照，限制体积；
--   * 剪贴板只接受用户显式提交的纯文本，不记录 IP / UA；
--   * 时间统一 INTEGER 毫秒时间戳（UTC）。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 设备配对会话。
--
-- 状态机：
--   pending   二维码 / 配对码已生成，等待新设备提交
--   claimed   新设备已提交，等待已在账号内的设备确认
--   confirmed 旧设备已确认，等待新设备领取 Session
--   completed 新设备已拿到独立 Session
--   cancelled / expired
--
-- token_hash 对应二维码里的短期凭证；code_hash 对应 6 位数字配对码。
-- claim_secret_hash 给提交配对的新设备轮询用，旧设备永远看不到它。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_pairings (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_device_id   TEXT NOT NULL,
  target_device_id   TEXT,
  token_hash         TEXT NOT NULL UNIQUE,
  code_hash          TEXT NOT NULL,
  claim_secret_hash  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'claimed', 'confirmed', 'completed', 'cancelled', 'expired'
                     )),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  target_name        TEXT,
  target_type        TEXT CHECK (target_type IS NULL OR target_type IN (
                       'desktop', 'laptop', 'tablet', 'mobile'
                     )),
  target_browser     TEXT,
  target_os          TEXT,
  target_user_agent  TEXT,
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  claimed_at         INTEGER,
  confirmed_at       INTEGER,
  completed_at       INTEGER,
  cancelled_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pairings_user_status
  ON device_pairings (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pairings_code
  ON device_pairings (code_hash, status, expires_at DESC);

-- ---------------------------------------------------------------------------
-- 接力任务。
--
-- target_device_id 为 NULL 表示「任一设备可领取」，第一个拉取收件箱的设备
-- 会把 target_device_id 落成自己，避免同一份内容被多台设备重复消费。
--
-- payload_json 是内容快照，不是同步引擎：目标设备打开后可以选择保存到本地。
-- 不写入窗口绝对坐标，工作空间只保存语义化配置。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS continuity_items (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL,
  target_device_id TEXT,
  item_type        TEXT NOT NULL CHECK (item_type IN (
                     'note', 'task', 'event', 'file', 'link', 'workspace', 'reading', 'app'
                   )),
  title            TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 160),
  resource_id      TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 160),
  payload_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'delivered', 'opened', 'completed', 'cancelled', 'expired'
                   )),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  delivered_at     INTEGER,
  opened_at        INTEGER,
  completed_at     INTEGER,
  cancelled_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_continuity_inbox
  ON continuity_items (user_id, target_device_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_continuity_source
  ON continuity_items (user_id, source_device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_continuity_expiry
  ON continuity_items (status, expires_at);

-- ---------------------------------------------------------------------------
-- 设备上下文：只保存语义化状态（当前应用 / 内容 ID / 工作空间 / 阅读位置）。
-- 绝不保存窗口绝对坐标，跨分辨率恢复时由目标设备自行排布。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_contexts (
  device_id      TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL CHECK (length(app_id) BETWEEN 1 AND 48),
  resource_id    TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 160),
  resource_title TEXT NOT NULL DEFAULT '' CHECK (length(resource_title) <= 160),
  workspace_id   TEXT CHECK (workspace_id IS NULL OR length(workspace_id) <= 64),
  scroll         REAL NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_contexts_user
  ON device_contexts (user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 跨设备纯文本剪贴板。
--
-- 只在用户点击 Send 时写入；没有后台监听，没有自动采集。
-- 默认 24 小时过期，用户可删除；服务端不记录来源 IP。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clipboard_items (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL,
  target_device_id TEXT,
  content          TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_clipboard_user
  ON clipboard_items (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clipboard_expiry
  ON clipboard_items (expires_at);
