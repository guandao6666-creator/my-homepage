/**
 * 跨设备接力 / 上下文 / 剪贴板 · 数据访问层
 *
 * 设计边界：
 *   * 接力是「内容快照 + 一次性投递」，不是第二套同步引擎；
 *   * 目标设备必须属于同一账号；target_device_id 为 NULL 时任一设备可领取；
 *   * 领取动作会写 delivered_at，发送端看到的「已送达」来自这里；
 *   * 剪贴板只存用户主动提交的纯文本，24 小时过期，可随时删除；
 *   * 上下文只存语义化状态，绝不存窗口坐标。
 */

import { randomToken } from "../auth/crypto.js";

export const ITEM_TYPES = new Set([
  "note",
  "task",
  "event",
  "file",
  "link",
  "workspace",
  "reading",
  "app",
]);

export const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
export const MIN_TTL_MS = 60 * 60 * 1000;
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const MAX_CLIPBOARD_CHARS = 4000;
export const CLIPBOARD_TTL_MS = 24 * 60 * 60 * 1000;

export async function purgeExpired(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE continuity_items SET status = 'expired' WHERE status IN ('pending','delivered','opened') AND expires_at <= ?",
    ).bind(now),
    env.DB.prepare("DELETE FROM clipboard_items WHERE expires_at <= ? OR deleted_at IS NOT NULL").bind(now),
  ]);
}

export async function deviceBelongsTo(env, userId, deviceId) {
  if (!deviceId) return null;
  const row = await env.DB.prepare(
    "SELECT id, name, device_type, browser_name, os_name, last_seen_at, last_active_at FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND status = 'active'",
  )
    .bind(deviceId, userId)
    .first();
  return row ?? null;
}

export async function createItem(env, { userId, sourceDeviceId, targetDeviceId, itemType, title, resourceId, payload, ttlMs }) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
  await env.DB.prepare(
    `INSERT INTO continuity_items
       (id, user_id, source_device_id, target_device_id, item_type, title, resource_id,
        payload_json, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      userId,
      sourceDeviceId,
      targetDeviceId || null,
      itemType,
      title,
      resourceId || null,
      JSON.stringify(payload ?? {}),
      now,
      now + ttl,
    )
    .run();
  return id;
}

function selectBase() {
  return `SELECT i.*, sd.name AS source_name, sd.device_type AS source_type,
                 td.name AS target_name, td.device_type AS target_type
            FROM continuity_items i
            LEFT JOIN devices sd ON sd.id = i.source_device_id AND sd.user_id = i.user_id
            LEFT JOIN devices td ON td.id = i.target_device_id AND td.user_id = i.user_id`;
}

export async function listInbox(env, { userId, deviceId, now = Date.now() }) {
  await env.DB.prepare(
    `UPDATE continuity_items
        SET status = 'delivered', target_device_id = ?, delivered_at = COALESCE(delivered_at, ?)
      WHERE user_id = ? AND status = 'pending'
        AND (target_device_id IS NULL OR target_device_id = ?)
        AND expires_at > ?`,
  )
    .bind(deviceId, now, userId, deviceId, now)
    .run();

  const rows = await env.DB.prepare(
    `${selectBase()}
      WHERE i.user_id = ? AND i.status IN ('delivered','opened')
        AND (i.target_device_id = ? OR i.target_device_id IS NULL)
        AND i.expires_at > ?
      ORDER BY i.created_at DESC LIMIT 50`,
  )
    .bind(userId, deviceId, now)
    .all();
  return rows.results ?? [];
}

export async function listHistory(env, { userId, limit = 60 }) {
  const rows = await env.DB.prepare(
    `${selectBase()} WHERE i.user_id = ? ORDER BY i.created_at DESC LIMIT ?`,
  )
    .bind(userId, Math.min(100, Math.max(10, limit)))
    .all();
  return rows.results ?? [];
}

export async function getItem(env, { id, userId }) {
  return env.DB.prepare(`${selectBase()} WHERE i.id = ? AND i.user_id = ?`)
    .bind(id, userId)
    .first();
}

export async function claimItem(env, { id, userId, deviceId, now = Date.now() }) {
  const item = await getItem(env, { id, userId });
  if (!item) return null;
  if (item.target_device_id && item.target_device_id !== deviceId) {
    const error = new Error("NOT_TARGET");
    error.code = "NOT_TARGET";
    throw error;
  }
  if (["cancelled", "expired"].includes(item.status) || Number(item.expires_at) <= now) {
    const error = new Error("EXPIRED");
    error.code = "EXPIRED";
    throw error;
  }
  if (!item.target_device_id) {
    await env.DB.prepare(
      "UPDATE continuity_items SET target_device_id = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND target_device_id IS NULL",
    )
      .bind(deviceId, now, id)
      .run();
  }
  return item;
}

export async function markItem(env, { id, userId, deviceId, status, now = Date.now() }) {
  const item = await claimItem(env, { id, userId, deviceId, now });
  if (!item) return null;
  const column = status === "opened" ? "opened_at" : status === "completed" ? "completed_at" : "cancelled_at";
  await env.DB.prepare(
    `UPDATE continuity_items SET status = ?, ${column} = ? WHERE id = ? AND user_id = ?`,
  )
    .bind(status, now, id, userId)
    .run();
  return true;
}

export async function cancelItem(env, { id, userId, now = Date.now() }) {
  const row = await env.DB.prepare(
    "SELECT id, status FROM continuity_items WHERE id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .first();
  if (!row) return null;
  if (!["pending", "delivered"].includes(row.status)) {
    const error = new Error("NOT_CANCELLABLE");
    error.code = "NOT_CANCELLABLE";
    throw error;
  }
  await env.DB.prepare(
    "UPDATE continuity_items SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(now, id, userId)
    .run();
  return true;
}

export function mapItem(row, { currentDeviceId } = {}) {
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json || "{}");
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    itemType: row.item_type,
    title: row.title || "",
    resourceId: row.resource_id || null,
    payload,
    status: row.status,
    sourceDeviceId: row.source_device_id,
    sourceName: row.source_name || "另一台设备",
    sourceType: row.source_type || "desktop",
    targetDeviceId: row.target_device_id || null,
    targetName: row.target_name || "任一设备",
    targetType: row.target_type || null,
    outgoing: Boolean(currentDeviceId && row.source_device_id === currentDeviceId),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
    openedAt: row.opened_at ? Number(row.opened_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    cancelledAt: row.cancelled_at ? Number(row.cancelled_at) : null,
  };
}

/* ------------------------------ 上下文 ------------------------------ */

export async function saveContext(env, { userId, deviceId, appId, resourceId, resourceTitle, workspaceId, scroll }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO device_contexts
       (device_id, user_id, app_id, resource_id, resource_title, workspace_id, scroll, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET
       app_id = excluded.app_id,
       resource_id = excluded.resource_id,
       resource_title = excluded.resource_title,
       workspace_id = excluded.workspace_id,
       scroll = excluded.scroll,
       updated_at = excluded.updated_at
     WHERE device_contexts.user_id = excluded.user_id`,
  )
    .bind(deviceId, userId, appId, resourceId || null, resourceTitle || "", workspaceId || null, Number(scroll) || 0, now)
    .run();
}

export async function listContexts(env, { userId }) {
  const rows = await env.DB.prepare(
    `SELECT c.*, d.name AS device_name, d.device_type, d.last_seen_at
       FROM device_contexts c
       JOIN devices d ON d.id = c.device_id AND d.user_id = c.user_id
      WHERE c.user_id = ? AND d.revoked_at IS NULL
      ORDER BY c.updated_at DESC LIMIT 12`,
  )
    .bind(userId)
    .all();
  return rows.results ?? [];
}

/* ------------------------------ 剪贴板 ------------------------------ */

export async function createClipboard(env, { userId, sourceDeviceId, targetDeviceId, content }) {
  const now = Date.now();
  // 每人最多保留 50 条，超出后删除最旧的，避免变成无限历史。
  await env.DB.prepare(
    `DELETE FROM clipboard_items WHERE id IN (
       SELECT id FROM clipboard_items WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 50
     )`,
  )
    .bind(userId)
    .run();

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO clipboard_items (id, user_id, source_device_id, target_device_id, content, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, sourceDeviceId, targetDeviceId || null, content, now, now + CLIPBOARD_TTL_MS)
    .run();
  return id;
}

export async function listClipboard(env, { userId, deviceId, now = Date.now() }) {
  const rows = await env.DB.prepare(
    `SELECT c.*, d.name AS source_name FROM clipboard_items c
       LEFT JOIN devices d ON d.id = c.source_device_id AND d.user_id = c.user_id
      WHERE c.user_id = ? AND c.deleted_at IS NULL AND c.expires_at > ?
        AND (c.target_device_id IS NULL OR c.target_device_id = ?)
      ORDER BY c.created_at DESC LIMIT 30`,
  )
    .bind(userId, now, deviceId)
    .all();
  return rows.results ?? [];
}

export async function deleteClipboard(env, { id, userId, now = Date.now() }) {
  const result = await env.DB.prepare(
    "UPDATE clipboard_items SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(now, id, userId)
    .run();
  return Boolean(result.meta?.changes);
}

export function mapClipboard(row, { currentDeviceId } = {}) {
  return {
    id: row.id,
    content: row.content,
    sourceDeviceId: row.source_device_id,
    sourceName: row.source_name || "另一台设备",
    targetDeviceId: row.target_device_id || null,
    outgoing: Boolean(currentDeviceId && row.source_device_id === currentDeviceId),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

export function newId() {
  return randomToken(12);
}
