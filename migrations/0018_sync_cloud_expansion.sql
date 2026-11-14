-- Guandao OS 2.0 · Phase 4 云同步扩展（5 数据域 + 墓碑 TTL + 清理台账）
--
-- 背景：0014 的 sync_entities 只有 notes / tasks / calendar 三个域，且删除墓碑永不清理。
-- Phase 4 需要 workspace / preferences 两个设置类数据域，并给墓碑加 90 天保留期：
--
--   1. 重建 sync_entities：domain CHECK 放宽到 5 个域，新增 deleted_at（墓碑删除时间，
--      活实体为 NULL）。SQLite 不支持修改 CHECK 约束，只能「改名保留 + 新建 + 复制」。
--      旧表重命名为 sync_entities_legacy_v1 保留（不 DROP，便于回滚/审计；
--      check-migrations 也禁止迁移里出现 DROP TABLE）。
--   2. 旧索引随表改名仍挂在 legacy 表上，先 DROP 旧名字，再在新表上按原定义重建。
--      历史墓碑没有删除时间，用 updated_at 回填 deleted_at（删除时代码把写入时间戳
--      作为 updated_at，语义一致）。
--   3. sync_tombstone_ledger：墓碑清理后仍保留「最后删除 revision + deleted_at」的台账，
--      防止离线设备拿旧 baseRevision 把已删除实体复活；这是防复活的关键表。
--   4. sync_cleanup_log：每次定时清理写一行（成功/失败都记），只保留最近 200 条。
--
-- 回滚方式：应用侧回退代码后，把 sync_entities_legacy_v1 改名回 sync_entities 并重建
-- 0014 的两个索引即可；本迁移不删除任何用户数据，也不自动回滚。

ALTER TABLE sync_entities RENAME TO sync_entities_legacy_v1;

DROP INDEX IF EXISTS idx_sync_entities_domain_updated;
DROP INDEX IF EXISTS idx_sync_entities_user_domain;

CREATE TABLE sync_entities (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  domain       TEXT NOT NULL CHECK (domain IN ('notes', 'tasks', 'calendar', 'workspace', 'preferences')),
  entity_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  payload_json TEXT CHECK (deleted = 1 OR (payload_json IS NOT NULL AND json_valid(payload_json))),
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  PRIMARY KEY (user_id, domain, entity_id)
);

INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
SELECT user_id, domain, entity_id, revision, deleted, payload_json, updated_at,
       CASE WHEN deleted = 1 THEN updated_at ELSE NULL END
  FROM sync_entities_legacy_v1;

-- 拉取增量：WHERE user_id = ? AND domain = ? AND updated_at > ? ORDER BY updated_at
CREATE INDEX IF NOT EXISTS idx_sync_entities_domain_updated
  ON sync_entities (user_id, domain, updated_at);

-- 统计每个域的数量与最近更新时间（系统设置 / 诊断）
CREATE INDEX IF NOT EXISTS idx_sync_entities_user_domain
  ON sync_entities (user_id, domain, deleted);

-- 墓碑 TTL 清理：WHERE deleted = 1 AND deleted_at < cutoff ORDER BY deleted_at
CREATE INDEX IF NOT EXISTS idx_sync_entities_deleted_at
  ON sync_entities (deleted, deleted_at);

CREATE TABLE IF NOT EXISTS sync_tombstone_ledger (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  domain     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain, entity_id)
);

-- 台账按删除时间做诊断/审计查询（清理后仍保留，用于拦截旧 revision 复活）
CREATE INDEX IF NOT EXISTS idx_sync_tombstone_ledger_deleted_at
  ON sync_tombstone_ledger (deleted_at);

CREATE TABLE IF NOT EXISTS sync_cleanup_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at  INTEGER NOT NULL,
  cutoff  INTEGER NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  purged  INTEGER NOT NULL DEFAULT 0,
  status  TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  detail  TEXT
);

-- 只保留最近 200 条清理记录；按 ran_at 查询最近的清理历史
CREATE INDEX IF NOT EXISTS idx_sync_cleanup_log_ran_at
  ON sync_cleanup_log (ran_at);
