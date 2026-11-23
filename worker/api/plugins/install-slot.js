// 2.0.11：安装名额的抢占必须在一条语句里完成。
// 为什么单独成模块：原来的「先 COUNT 再 INSERT」是 check-then-insert，两个并发新装
// 都能通过 40 的上限检查；而真正守门的是写语句里的条件子查询。
import { ApiError } from "../http.js";

export const MAX_INSTALLED = 40;
const PREFIX = "pins-";

function randomId() {
  return `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * 原子地占用一个安装名额：
 * 1. 条件 INSERT（COUNT < max 才插）抢新名额；
 * 2. changes=0 时判断是不是「同一插件并发/重装」——已有行直接 UPDATE，仍算占用成功；
 * 3. 两者都为 0 才是真的超限。
 * 返回 { ok: true, reinstalled } 或抛 INSTALL_LIMIT。
 */
export async function reserveInstallSlot(env, options) {
  const {
    userId,
    pluginId,
    versionText,
    packageHash,
    now = Date.now(),
    max = MAX_INSTALLED,
    source = "market",
  } = options;

  const inserted = await env.DB.prepare(
    `INSERT INTO plugin_installations
       (id, user_id, plugin_id, version, enabled, status, package_sha256, source, installed_at, updated_at)
     SELECT ?, ?, ?, ?, 1, 'installed', ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM plugin_installations WHERE user_id = ?) < ?`,
  )
    .bind(randomId(), userId, pluginId, versionText, packageHash, source, now, now, userId, max)
    .run();

  if (Number(inserted?.meta?.changes ?? 0) > 0) {
    return { ok: true, reinstalled: false };
  }

  const updated = await env.DB.prepare(
    `UPDATE plugin_installations
        SET version = ?, enabled = 1, status = 'installed', package_sha256 = ?, updated_at = ?
      WHERE user_id = ? AND plugin_id = ?`,
  )
    .bind(versionText, packageHash, now, userId, pluginId)
    .run();

  if (Number(updated?.meta?.changes ?? 0) > 0) {
    return { ok: true, reinstalled: true };
  }

  throw new ApiError("INSTALL_LIMIT", `最多同时安装 ${max} 个插件`, 409);
}