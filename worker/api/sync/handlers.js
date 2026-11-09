/**
 * /api/sync/* —— Guandao OS 2.0 云同步
 *
 * 端点（全部要求有效 Session；写操作校验同源）：
 *   GET  /api/sync/status              每个域的条目数、墓碑数、最后更新时间
 *   GET  /api/sync/index?domain=       全量索引（id / revision / deleted / updatedAt）
 *   GET  /api/sync/pull?domain=&since= 增量拉取（含 payload）
 *   GET  /api/sync/pull?domain=&ids=   按 id 拉取（索引 diff 之后只取需要的）
 *   POST /api/sync/push                推送变更（乐观锁 revision）
 *
 * 边界：
 *   - domain 只允许 notes / tasks / calendar；
 *   - 单次最多 100 条变更，单条 payload ≤ 128KB，整包 ≤ 768KB；
 *   - 所有写入都带 user_id，实体 id 只做格式校验，不参与鉴权判断；
 *   - 冲突不覆盖：返回服务端版本，由客户端决定合并（客户端会按 updatedAt 取新）。
 */

import { ApiError, ok, readJsonLimited } from "../http.js";
import { assertSameOrigin } from "../guards.js";
import { authConfig } from "../auth/config.js";
import { readSession } from "../auth/session.js";
import {
  applyChange,
  domainStats,
  isSyncDomain,
  listByIds,
  listChanges,
  listIndex,
  SYNC_DOMAINS,
} from "./store.js";

const PREFIX = "/api/sync";
const MAX_BATCH = 100;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 768 * 1024;

export async function handleSyncRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const segments = rest ? rest.split("/") : [];
  const method = request.method;

  const session = await readSession(env, request);
  if (!session) throw new ApiError("UNAUTHENTICATED", "请先登录", 401);
  const userId = session.user.id;

  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(request, authConfig(env, request).origin);
  }

  /* ------------------------------ 状态 ------------------------------ */
  if (segments.length === 1 && segments[0] === "status" && method === "GET") {
    const domains = [];
    for (const domain of SYNC_DOMAINS) domains.push(await domainStats(env, userId, domain));
    return ok({ domains, serverTime: Date.now() });
  }

  /* ------------------------------ 索引 ------------------------------ */
  if (segments.length === 1 && segments[0] === "index" && method === "GET") {
    const domain = requireDomain(url);
    const result = await listIndex(env, userId, domain);
    return ok({ domain, serverTime: Date.now(), ...result });
  }

  /* ------------------------------ 拉取 ------------------------------ */
  if (segments.length === 1 && segments[0] === "pull" && method === "GET") {
    const domain = requireDomain(url);
    const idsParam = url.searchParams.get("ids");
    if (idsParam) {
      const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean);
      if (ids.length > 200) throw new ApiError("TOO_MANY_IDS", "一次最多拉取 200 条", 400);
      const changes = await listByIds(env, userId, domain, ids);
      return ok({ domain, serverTime: Date.now(), changes, hasMore: false });
    }

    const since = Number(url.searchParams.get("since")) || 0;
    const limit = Number(url.searchParams.get("limit")) || 300;
    const changes = await listChanges(env, userId, domain, { since, limit });
    return ok({
      domain,
      serverTime: Date.now(),
      changes,
      hasMore: changes.length >= Math.min(500, limit),
    });
  }

  /* ------------------------------ 推送 ------------------------------ */
  if (segments.length === 1 && segments[0] === "push" && method === "POST") {
    const body = await readJsonLimited(request, MAX_BODY_BYTES);
    const domain = String(body?.domain ?? "");
    if (!isSyncDomain(domain)) throw new ApiError("UNKNOWN_DOMAIN", "不支持的数据类型", 400);

    const rawChanges = Array.isArray(body?.changes) ? body.changes : [];
    if (!rawChanges.length) throw new ApiError("EMPTY_BATCH", "没有需要同步的变更", 400);
    if (rawChanges.length > MAX_BATCH) {
      throw new ApiError("BATCH_TOO_LARGE", `单次最多推送 ${MAX_BATCH} 条变更`, 400);
    }

    const changes = rawChanges.map((change, index) => normalizeChange(change, index));

    const applied = [];
    const conflicts = [];
    for (const change of changes) {
      const result = await applyChange(env, userId, domain, change);
      if (result.outcome === "conflict") conflicts.push(result.entity);
      else applied.push(result.entity);
    }

    return ok({ domain, serverTime: Date.now(), applied, conflicts });
  }

  throw new ApiError("NOT_FOUND", "接口不存在", 404);
}

function requireDomain(url) {
  const domain = String(url.searchParams.get("domain") ?? "");
  if (!isSyncDomain(domain)) throw new ApiError("UNKNOWN_DOMAIN", "不支持的数据类型", 400);
  return domain;
}

function normalizeChange(raw, index) {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new ApiError("INVALID_CHANGE", `第 ${index + 1} 条变更的 id 不合法`, 400);
  }

  const deleted = Boolean(raw?.deleted);
  const baseRevision = Math.max(0, Number(raw?.baseRevision) || 0);
  const updatedAt = Number(raw?.updatedAt) || Date.now();
  const payload = deleted ? null : raw?.payload ?? null;

  if (!deleted) {
    if (!payload || typeof payload !== "object") {
      throw new ApiError("INVALID_CHANGE", `第 ${index + 1} 条变更缺少内容`, 400);
    }
    const size = byteLength(JSON.stringify(payload));
    if (size > MAX_PAYLOAD_BYTES) {
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        `第 ${index + 1} 条内容超过 ${Math.round(MAX_PAYLOAD_BYTES / 1024)} KB，请精简后重试`,
        400,
      );
    }
  }

  return { id, baseRevision, deleted, updatedAt, payload };
}

function byteLength(text) {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return text.length * 2;
  }
}

