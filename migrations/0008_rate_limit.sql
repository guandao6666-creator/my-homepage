-- Guandao OS 1.5 · 请求频率限制
--
-- 固定窗口计数器。bucket = 规则 + 身份哈希 + 窗口起点，
-- 身份只存 SHA-256 前缀，不保存 IP 原文；行在 24 小时后由 Cron 清理。
--
-- 说明：这是应用层限流，依赖 D1 写；D1 不可用时退化为单 isolate 内存计数，
-- 并在安全中心的「请求频率限制」检查里如实反映。

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'ip',
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
CREATE INDEX IF NOT EXISTS idx_rate_limits_rule ON rate_limits (rule, window_start);
