/**
 * /api/continuity/*、/api/clipboard/*、/api/push/status
 *
 * 所有接口都要求有效 Session，并用 Session 里的 deviceId 校验归属。
 * 客户端提交的 user_id 一律忽略；targetDeviceId 必须属于当前账号。
 */

import { ApiError, ok } from "../http.js";
import { authConfig } from "../auth/config.js";
import { inspectSession } from "../auth/session.js";
import { requireActiveSession } from "../guards.js";
import { assertSameOrigin, readJson } from "../community/common.js";
import {
  CLIPBOARD_TTL_MS,
  DEFAULT_TTL_MS,
  ITEM_TYPES,
  MAX_CLIPBOARD_CHARS,
  MAX_PAYLOAD_BYTES,
  cancelItem,
  claimItem,
  createClipboard,
  createItem,
  deleteClipboard,
  deviceBelongsTo,
  getItem,
  listClipboard,
  listContexts,
  listHistory,
  listInbox,
  mapClipboard,
  mapItem,
  markItem,
  purgeExpired,
  saveContext,
} from "./store.js";

const PREFIX = "/api/continuity";
const CLIPBOARD = "/api/clipboard";

export async function handleContinuityRequest({ request, env, url, path }) {
  /* ------------------------------ 推送状态 -------------------------- */
  if (path === "/api/push/status" && request.method === "GET") {
    const session = await activeSession(env, request);
    if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录 Guandao Account", 401);
    const configured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    return ok({
      enabled: false,
      configured,
      delivery: "in-app",
      reason: configured
        ? "VAPID 密钥已存在，但 1.8 未部署推送发送服务；接力内容在设备上线后由应用内轮询发现。"
        : "未配置 VAPID 密钥，Web Push 未启用；接力内容在设备上线后由应用内轮询发现。",
    });
  }

  /* ------------------------------ 剪贴板 ---------------------------- */
  if (path === CLIPBOARD || path.startsWith(`${CLIPBOARD}/`)) {
    const session = await requireActiveSession(env, request);
    if (request.method !== "GET" && request.method !== "HEAD") assertSameOrigin(request, env);
    const rest = path.slice(CLIPBOARD.length).replace(/^\/+/, "");
    const parts = rest ? rest.split("/") : [];

    if (parts.length === 0 && request.method === "GET") {
      await purgeExpired(env);
      const rows = await listClipboard(env, {
        userId: session.user.id,
        deviceId: session.session.deviceId,
      });
      return ok({
        items: rows.map((row) => mapClipboard(row, { currentDeviceId: session.session.deviceId })),
        ttl: CLIPBOARD_TTL_MS,
        enabled: true,
      });
    }

    if (parts.length === 1 && parts[0] === "send" && request.method === "POST") {
      const body = await readJson(request, 12 * 1024);
      const content = String(body.content ?? "").replace(/\u0000/g, "");
      if (!content.trim()) throw new ApiError("EMPTY_CONTENT", "剪贴板内容不能为空", 400);
      if (content.length > MAX_CLIPBOARD_CHARS) {
        throw new ApiError("CONTENT_TOO_LONG", `最多 ${MAX_CLIPBOARD_CHARS} 个字符`, 413);
      }
      let targetDeviceId = body.targetDeviceId ? String(body.targetDeviceId) : null;
      if (targetDeviceId === session.session.deviceId) targetDeviceId = null;
      if (targetDeviceId) {
        const target = await deviceBelongsTo(env, session.user.id, targetDeviceId);
        if (!target) throw new ApiError("TARGET_NOT_FOUND", "目标设备不属于当前账号", 404);
      }
      const id = await createClipboard(env, {
        userId: session.user.id,
        sourceDeviceId: session.session.deviceId,
        targetDeviceId,
        content,
      });
      return ok({ id, ttl: CLIPBOARD_TTL_MS }, { status: 201 });
    }

    if (parts.length === 1 && request.method === "DELETE") {
      const deleted = await deleteClipboard(env, { id: parts[0], userId: session.user.id });
      if (!deleted) throw new ApiError("NOT_FOUND", "这条剪贴板记录不存在", 404);
      return ok({ deleted: true });
    }

    return null;
  }

  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const session = await requireActiveSession(env, request);
  if (request.method !== "GET" && request.method !== "HEAD") assertSameOrigin(request, env);

  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const parts = rest ? rest.split("/") : [];
  const deviceId = session.session.deviceId;
  if (!deviceId) throw new ApiError("NO_DEVICE", "当前会话没有绑定设备，请重新登录", 409);
  const userId = session.user.id;

  /* ------------------------------ 发送 ------------------------------ */
  if (parts.length === 1 && parts[0] === "send" && request.method === "POST") {
    const body = await readJson(request, 48 * 1024);
    const itemType = String(body.itemType || "");
    if (!ITEM_TYPES.has(itemType)) throw new ApiError("INVALID_TYPE", "不支持的接力内容类型", 400);
    if (body.payload !== undefined && (typeof body.payload !== "object" || body.payload === null)) {
      throw new ApiError("INVALID_PAYLOAD", "接力内容格式不正确", 400);
    }
    const payload = body.payload ?? {};
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw new ApiError("INVALID_PAYLOAD", "接力内容无法序列化", 400);
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
      throw new ApiError("PAYLOAD_TOO_LARGE", "接力内容超过 32 KB，请精简后再发送", 413);
    }

    const targetDeviceId = body.targetDeviceId ? String(body.targetDeviceId) : null;
    if (targetDeviceId === deviceId) {
      throw new ApiError("SELF_TARGET", "这是当前设备，换一台设备试试", 400);
    }
    let targetName = null;
    if (targetDeviceId) {
      const target = await deviceBelongsTo(env, userId, targetDeviceId);
      if (!target) throw new ApiError("TARGET_NOT_FOUND", "目标设备不属于当前账号", 404);
      targetName = target.name;
    }

    const title = String(body.title ?? "").trim().slice(0, 120) || defaultTitle(itemType);
    const resourceId = body.resourceId ? String(body.resourceId).slice(0, 160) : null;
    const id = await createItem(env, {
      userId,
      sourceDeviceId: deviceId,
      targetDeviceId,
      itemType,
      title,
      resourceId,
      payload,
      ttlMs: Number(body.ttlMs) || DEFAULT_TTL_MS,
    });

    return ok(
      {
        id,
        title,
        itemType,
        targetDeviceId,
        targetName,
        ttl: DEFAULT_TTL_MS,
      },
      { status: 201 },
    );
  }

  /* ------------------------------ 收件箱 / 历史 --------------------- */
  if (parts.length === 1 && parts[0] === "inbox" && request.method === "GET") {
    await purgeExpired(env);
    const rows = await listInbox(env, { userId, deviceId });
    return ok({
      items: rows.map((row) => mapItem(row, { currentDeviceId: deviceId })),
      currentDeviceId: deviceId,
      serverTime: Date.now(),
    });
  }

  if (parts.length === 1 && parts[0] === "history" && request.method === "GET") {
    await purgeExpired(env);
    const rows = await listHistory(env, { userId });
    return ok({
      items: rows.map((row) => mapItem(row, { currentDeviceId: deviceId })),
      currentDeviceId: deviceId,
    });
  }

  /* ------------------------------ 上下文 ---------------------------- */
  if (parts.length === 1 && parts[0] === "context") {
    if (request.method === "GET") {
      const rows = await listContexts(env, { userId });
      return ok({
        items: rows.map((row) => ({
          deviceId: row.device_id,
          deviceName: row.device_name,
          deviceType: row.device_type,
          appId: row.app_id,
          resourceId: row.resource_id,
          resourceTitle: row.resource_title,
          workspaceId: row.workspace_id,
          scroll: Number(row.scroll) || 0,
          updatedAt: Number(row.updated_at),
          lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
          current: row.device_id === deviceId,
        })),
        currentDeviceId: deviceId,
      });
    }
    if (request.method === "PUT" || request.method === "POST") {
      const body = await readJson(request, 4 * 1024);
      const appId = String(body.appId ?? "").trim();
      if (!/^[a-z0-9][a-z0-9:_-]{0,47}$/i.test(appId)) {
        throw new ApiError("INVALID_APP", "应用标识不合法", 400);
      }
      await saveContext(env, {
        userId,
        deviceId,
        appId,
        resourceId: body.resourceId ? String(body.resourceId).slice(0, 160) : null,
        resourceTitle: String(body.resourceTitle ?? "").slice(0, 160),
        workspaceId: body.workspaceId ? String(body.workspaceId).slice(0, 64) : null,
        scroll: Number(body.scroll) || 0,
      });
      return ok({ saved: true });
    }
  }

  /* ------------------------------ 单条操作 -------------------------- */
  if (parts.length === 2 && ["open", "complete", "cancel"].includes(parts[1])) {
    const id = parts[0];
    const action = parts[1];

    if (action === "cancel" && request.method === "POST") {
      try {
        const done = await cancelItem(env, { id, userId });
        if (!done) throw new ApiError("NOT_FOUND", "接力内容不存在", 404);
        return ok({ cancelled: true });
      } catch (error) {
        if (error?.code === "NOT_CANCELLABLE") {
          throw new ApiError("NOT_CANCELLABLE", "这条接力已经开始处理，不能取消", 409);
        }
        throw error;
      }
    }

    if (request.method !== "POST") return null;

    if (action === "open") {
      try {
        const item = await claimItem(env, { id, userId, deviceId });
        if (!item) throw new ApiError("NOT_FOUND", "接力内容不存在", 404);
        await markItem(env, { id, userId, deviceId, status: "opened" });
        // Phase 3.3 审计修复：原来用「更新前」的行拼响应，openedAt 永远是 null。
        // 重新读一次，保证响应里的 opened_at 与数据库一致。
        const opened = await getItem(env, { id, userId });
        return ok({ item: mapItem(opened ?? { ...item, status: "opened" }, { currentDeviceId: deviceId }) });
      } catch (error) {
        if (error?.code === "NOT_TARGET") throw new ApiError("NOT_TARGET", "这条内容不是发给当前设备的", 403);
        if (error?.code === "EXPIRED") throw new ApiError("EXPIRED", "这条接力内容已过期", 410);
        throw error;
      }
    }

    if (action === "complete") {
      try {
        const done = await markItem(env, { id, userId, deviceId, status: "completed" });
        if (!done) throw new ApiError("NOT_FOUND", "接力内容不存在", 404);
        return ok({ completed: true });
      } catch (error) {
        if (error?.code === "NOT_TARGET") throw new ApiError("NOT_TARGET", "这条内容不是发给当前设备的", 403);
        if (error?.code === "EXPIRED") throw new ApiError("EXPIRED", "这条接力内容已过期", 410);
        throw error;
      }
    }
  }

  return null;
}

async function activeSession(env, request) {
  const inspected = await inspectSession(env, request);
  return inspected.state === "active" ? inspected : null;
}

function defaultTitle(itemType) {
  return {
    note: "一篇笔记",
    task: "一个任务",
    event: "一个日程",
    file: "一个云端文件",
    link: "一个链接",
    workspace: "一个工作空间",
    reading: "阅读位置",
    app: "当前内容",
  }[itemType] ?? "接力内容";
}
