-- Guandao OS 2.0 · 最后一名管理员保护（库级）
--
-- 背景：2026-11-18 线上 users 表两次归零，管理员账号消失后 countAdmins()=0，
-- 而 INITIAL_ADMIN_SETUP_TOKEN 未配置，/api/auth/github 在进入 OAuth 前就以
-- setup_disabled 失败关闭，站点彻底无法登录。
--
-- 应用层已在 worker/api/privacy/handlers.js 加了 409 护栏，但那只能挡住走接口的
-- 注销；脚本、控制台 SQL、导入覆盖都绕得过去。这里用触发器兜底：
--   - 删除最后一名活跃管理员 → ABORT
--   - 把最后一名活跃管理员降级 / 禁用 → ABORT
--
-- 判定与 last-admin.js 保持一致：只把 role='admin' 且 status='active' 视为可接替者。
-- 需要腾出管理员位置时，先把另一名成员提升为 admin，再操作原账号。

CREATE TRIGGER IF NOT EXISTS trg_users_last_admin_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin'
 AND (SELECT COUNT(*) FROM users
       WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN_DELETE_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_last_admin_update
BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'admin'
 AND (NEW.role <> 'admin' OR NEW.status <> 'active')
 AND (SELECT COUNT(*) FROM users
       WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN_DEMOTE_BLOCKED');
END;
