-- ---------------------------------------------------------------------------
-- Guandao OS 2.2 · 0017_plugin_signatures.sql
--
-- 第三方插件发布者签名（Ed25519）所需的持久化。
--
-- 只做增量变更，不动 0001–0016 的任何既有列语义：
--   * publisher_keys 只存**公钥**与状态。私钥永远不进 D1、不进 R2、不进日志；
--     服务端从头到尾没有能力生成或持有发布者私钥。
--   * plugin_versions 增加签名相关列。旧行默认 signature_status = 'unsigned'，
--     即「没有签名」，与「签名无效」是两种不同的状态，不能合并。
--   * 唯一键：同一把公钥只能登记给一个账号（idx_publisher_keys_public），
--     避免两个人共用一把密钥互相顶替。
--
-- 回滚方式：本文件只新增表与列，不做 DROP。如需回退到 2.1，
-- 保留这些列即可（旧代码不读取它们），不需要改表结构。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 发布者公钥登记表。
--   key_id      = "ggk_" + sha256(publicKey) 前 16 位十六进制，由公钥唯一决定
--   user_id     = 公钥归属的发布者账号（= 插件 developer_id 的同一个 users.id）
--   status      = active / revoked；已撤销的密钥必须立即失去验证效力
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publisher_keys (
  key_id         TEXT PRIMARY KEY CHECK (length(key_id) = 20 AND key_id LIKE 'ggk\_%' ESCAPE '\'),
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL CHECK (length(public_key) BETWEEN 40 AND 64),
  algorithm      TEXT NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  label          TEXT CHECK (label IS NULL OR length(label) <= 60),
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoke_reason  TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  last_used_at   INTEGER
);

-- 一个账号列出自己的密钥；一个账号最多 10 把（业务侧校验，这里只建索引）
CREATE INDEX IF NOT EXISTS idx_publisher_keys_user ON publisher_keys (user_id, status);

-- 同一把公钥不允许登记到两个账号：否则 A 可以用 B 的公钥冒充 B 的签名
CREATE UNIQUE INDEX IF NOT EXISTS idx_publisher_keys_public ON publisher_keys (public_key);

-- ---------------------------------------------------------------------------
-- plugin_versions 增加签名列。
--   signature_json    完整签名信封（含 sig），原样保存，供下载/复核
--   signature_status  verified / unsigned / invalid —— 只允许在服务端写入
--   signature_key_id  指向 publisher_keys；SET NULL 保留历史版本的可读性
-- ---------------------------------------------------------------------------
ALTER TABLE plugin_versions ADD COLUMN signature_json TEXT;
ALTER TABLE plugin_versions ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'unsigned';
ALTER TABLE plugin_versions ADD COLUMN signature_key_id TEXT;
ALTER TABLE plugin_versions ADD COLUMN signed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_plugin_versions_signature ON plugin_versions (signature_key_id);
CREATE INDEX IF NOT EXISTS idx_plugin_versions_sig_status ON plugin_versions (signature_status);