/**
 * 「最后一名管理员」护栏。
 *
 * 背景：2.0 的一次数据事故中，唯一的管理员账号被删除，users 表归零，
 * countAdmins() 变成 0；同时 INITIAL_ADMIN_SETUP_TOKEN 未配置，
 * /api/auth/github 在进入 OAuth 之前就以 setup_disabled 失败关闭，
 * 站点彻底无法登录，只能靠 D1 时间点恢复才救回来。
 *
 * 判定规则（只认「活跃」管理员）：
 * - 目标账号必须是 role=admin 且 status=active；
 * - 且不存在第二个 role=admin 且 status=active 的账号。
 *
 * 已禁用的管理员不计入：它无法登录，不能接替站点管理。
 * 查询失败时异常向上抛，由调用方失败关闭（宁可拒绝注销，也不删掉最后一个管理员）。
 */
export async function isLastActiveAdmin(db, userId) {
  const self = await db
    .prepare("SELECT role, status FROM users WHERE id = ?")
    .bind(userId)
    .first();

  if (!self || self.role !== "admin" || self.status !== "active") return false;

  const other = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
    )
    .bind(userId)
    .first();

  return Number(other?.total ?? 0) === 0;
}
