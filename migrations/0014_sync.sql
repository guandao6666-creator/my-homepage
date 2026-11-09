-- Guandao OS 2.0 · 云同步实体表
--
-- 背景：0001 建的 sync_changes（全量变更日志）从 1.0 起就没有任何读写，
-- 属于死表；devices 的 sync-report 也只是客户端自报状态。2.0 为 Notes / Tasks /
-- Calendar 提供真正的同步接口，用「每实体一行」的模型：
--
--   - 每行是一个 (user, domain, entity) 的当前状态，带单调递增 revision；
--   - 删除用墓碑（deleted = 1）表示，不物理删除，避免另一端「复活」数据；
--   - 冲突检测用 baseRevision 乐观锁：客户端带来它上次看到的 revision，
--     与库里不一致就返回服务端版本，由客户端决定合并策略。
--
-- 旧表 sync_changes 保留不动（可能有历史数据/外部脚本引用），2.0 不再写入。

CREATE TABLE IF NOT EXISTS sync_entities (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  domain       TEXT NOT NULL CHECK (domain IN ('notes', 'tasks', 'calendar')),
  entity_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  payload_json TEXT CHECK (deleted = 1 OR (payload_json IS NOT NULL AND json_valid(payload_json))),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain, entity_id)
);

-- 拉取增量：WHERE user_id = ? AND domain = ? AND updated_at > ? ORDER BY updated_at
CREATE INDEX IF NOT EXISTS idx_sync_entities_domain_updated
  ON sync_entities (user_id, domain, updated_at);

-- 统计每个域的数量与最近更新时间（系统设置 / 诊断）
CREATE INDEX IF NOT EXISTS idx_sync_entities_user_domain
  ON sync_entities (user_id, domain, deleted);