/**
 * QA 测试数据清理护栏（Guandao OS 2.0 · 生产数据事故调查）。
 *
 * 设计目标：即使清理脚本被误改、参数传错、或匹配条件过宽，
 * 也绝不允许删除真实账号。所有删除都必须同时满足：
 *   1. 有本次运行的测试上下文标记（marker + runId）；
 *   2. user_id 以 qa- 开头；
 *   3. email 以 qa-*@example.test 结尾；
 *   4. 删除前重新读取的账号，id / email / github_username / created_at 全部匹配；
 *   5. 目标行数恰好为 1；关联资源数量不超过上限；
 *   6. 删除后实际影响行数必须等于预期，否则抛错中止（不退化、不扩大条件）。
 *
 * 只提供「构造带条件的 SQL」与「校验」两类纯函数；执行器仍由各脚本注入。
 */

export class QaCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = "QaCleanupError";
  }
}

const QA_ID = /^qa-[a-z0-9][a-z0-9-]{1,78}$/i;
const QA_EMAIL = /^qa-[a-z0-9][a-z0-9-]{1,78}@example\.test$/i;
const SAFE_LITERAL = /^[a-z0-9@._+-]+$/i;

const CHILD_TABLES = new Set([
  "sync_entities",
  "sessions",
  "devices",
  "files",
  "folders",
  "backup_restore_items",
  "backup_restores",
  "backup_items",
  "backup_jobs",
  "backups",
  "security_events",
  "privacy_settings",
  "data_export_jobs",
  "data_exports",
  "data_deletion_jobs",
]);

function assertSafeLiteral(value, label) {
  if (typeof value !== "string" || !SAFE_LITERAL.test(value)) {
    throw new QaCleanupError(`${label} 含有不允许的字符，拒绝拼接 SQL`);
  }
}

/**
 * 删除前重新读取账号并校验身份。
 *
 * @param {object} input
 * @param {boolean} input.enabled 本次是否处于测试清理上下文
 * @param {string} input.marker 测试上下文的固定标识（例如 "prod-e2e"）
 * @param {string} input.expectedMarker
 * @param {string} input.runId 本次运行 ID
 * @param {string} input.expectedRunId
 * @param {string} input.userId
 * @param {string} input.email
 * @param {string} input.expectedUserId
 * @param {string} input.expectedEmail
 * @param {Array<object>} input.rows 重新读取到的 users 行
 * @param {string} input.expectedUsername 例如 "qa-e2e"
 * @param {number} [input.createdAfter] 允许的最早创建时间（毫秒）
 */
export function assertQaCleanupTarget(input) {
  if (input?.enabled !== true) {
    throw new QaCleanupError("缺少测试清理上下文，拒绝删除");
  }
  if (input.marker !== input.expectedMarker || input.runId !== input.expectedRunId) {
    throw new QaCleanupError("测试清理上下文不匹配，拒绝删除");
  }
  if (!QA_ID.test(input.userId || "")) {
    throw new QaCleanupError(`目标 user_id 不是 qa- 前缀：${String(input.userId).slice(0, 60)}`);
  }
  if (!QA_EMAIL.test(input.email || "")) {
    throw new QaCleanupError(`目标 email 不是 qa-*@example.test：${String(input.email).slice(0, 80)}`);
  }
  if (input.userId !== input.expectedUserId || input.email !== input.expectedEmail) {
    throw new QaCleanupError("目标 id/email 与本次运行创建的不一致，拒绝删除");
  }
  if (!Array.isArray(input.rows) || input.rows.length !== 1) {
    throw new QaCleanupError(`目标账号匹配到 ${Array.isArray(input.rows) ? input.rows.length : "未知"} 行，预期 1 行；中止`);
  }

  const row = input.rows[0];
  if (row.id !== input.userId || row.email !== input.email) {
    throw new QaCleanupError("重新读取的账号身份与目标不一致，拒绝删除");
  }
  if (row.github_username !== input.expectedUsername) {
    throw new QaCleanupError(`账号 github_username 不是 ${input.expectedUsername}，拒绝删除`);
  }
  if (typeof input.createdAfter === "number" && Number(row.created_at) < input.createdAfter) {
    throw new QaCleanupError("账号创建时间早于本次运行，拒绝删除");
  }
  return row;
}

/** 关联资源数量上限；异常时中止，绝不扩大条件。 */
export function assertCleanupResourceCounts(counts, max = 1000) {
  if (!counts || typeof counts !== "object") throw new QaCleanupError("缺少关联资源计数");
  for (const [name, value] of Object.entries(counts)) {
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) {
      throw new QaCleanupError(`关联资源 ${name} 计数非法`);
    }
    if (count > max) {
      throw new QaCleanupError(`关联资源 ${name} 数量 ${count} 超过上限 ${max}，中止清理`);
    }
  }
}

/** 删除后校验实际影响行数；不一致立即抛错。 */
export function assertDeleteCount(actual, expected = 1, label = "users") {
  const value = Number(actual);
  if (!Number.isFinite(value) || value !== expected) {
    throw new QaCleanupError(`${label} 删除行数 ${actual} ≠ 预期 ${expected}，中止`);
  }
}

/** users 行删除：同时约束 id、email、测试前缀、测试邮箱。 */
export function buildQaUserDeleteSql({ userId, email }) {
  assertSafeLiteral(userId, "userId");
  assertSafeLiteral(email, "email");
  return `DELETE FROM users WHERE id = '${userId}' AND email = '${email}' AND id LIKE 'qa-%' AND email LIKE 'qa-%@example.test'`;
}

/** 子表删除：必须同时约束 user_id 与测试前缀。 */
export function buildQaChildDeleteSql(table, userId) {
  if (!CHILD_TABLES.has(table)) throw new QaCleanupError(`不允许清理表 ${table}`);
  assertSafeLiteral(userId, "userId");
  return `DELETE FROM ${table} WHERE user_id = '${userId}' AND user_id LIKE 'qa-%'`;
}

export function isQaUserId(value) {
  return QA_ID.test(String(value || ""));
}

export function isQaEmail(value) {
  return QA_EMAIL.test(String(value || ""));
}