/** /api/files/* 业务处理。所有分支都要求有效 Session。 */

import { ApiError, ok } from "../http.js";
import { assertSameOrigin, readJson } from "../guards.js";
import { chunkIds, placeholdersFor } from "../sql.js";
import { authConfig } from "../auth/config.js";
import { readSession } from "../auth/session.js";
import {
  ancestorsOf,
  deleteFileRow,
  folderTree,
  getFile,
  getFolder,
  insertFolder,
  insertPendingFile,
  listFiles,
  listFolders,
  logEvent,
  mapFile,
  mapFolder,
  markFileReady,
  restoreFile,
  softDeleteFile,
  trashFiles,
  trashFolders,
  updateFile,
  updateFolder,
  usage,
} from "./store.js";
import {
  MAX_FILE_BYTES,
  contentDisposition,
  detectMime,
  extensionOf,
  isInlineSafe,
  quotaBytes,
  sanitizeName,
} from "./util.js";

const PREFIX = "/api/files";

/**
 * D1 单条语句最多 100 个绑定参数（分块实现见 ../sql.js，与 sync/store.js 共用）。
 *
 * 递归删除会把整棵子树展开成 `IN (?, ?, …)`，参数数 = 节点数 + 其它条件参数；
 * 超过 100 时 D1 直接报 SQL 错误 → 500，而且用户没有办法绕开（只能一个个删子目录）。
 * 这里按 40 个 id 一块执行，给 userId / 时间戳等参数留足余量。
 */

export async function handleFilesRequest({ request, env, url, path }) {
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

  /* ------------------------------ 列表 ------------------------------ */
  if (segments.length === 0 && method === "GET") {
    return listHandler(env, userId, url);
  }

  if (segments.length === 1 && segments[0] === "quota" && method === "GET") {
    return quotaHandler(env, userId);
  }

  if (segments.length === 2 && segments[0] === "trash" && segments[1] === "empty" && method === "POST") {
    return emptyTrash(env, userId);
  }

  if (segments.length === 1 && segments[0] === "recent" && method === "GET") {
    const items = await listFiles(env, userId, { sort: "updated", limit: 24 });
    return ok({ items });
  }

  if (segments.length === 1 && segments[0] === "favorites" && method === "GET") {
    const [items, folders] = await Promise.all([
      listFiles(env, userId, { favorite: true, sort: "updated", limit: 100 }),
      listFolders(env, userId),
    ]);
    return ok({ items, folders: folders.filter((folder) => folder.isFavorite) });
  }

  /* ------------------------------ 文件夹 ---------------------------- */
  if (segments[0] === "folders") {
    if (segments.length === 1 && method === "GET") {
      const folders = await listFolders(env, userId, {});
      return ok({ folders });
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(request);
      const name = sanitizeName(body?.name);
      if (!name) throw new ApiError("INVALID_NAME", "文件夹名称不合法", 400);
      const parentId = normalizeParent(body?.parentId);
      if (parentId) await requireFolder(env, userId, parentId);
      const id = crypto.randomUUID();
      await insertFolder(env, { id, userId, parentId, name });
      return ok({ folder: mapFolder(await getFolder(env, userId, id)) }, { status: 201 });
    }
    if (segments.length === 3) {
      const folder = await getFolder(env, userId, segments[1]);
      if (!folder) throw new ApiError("NOT_FOUND", "文件夹不存在", 404);
      if (segments[2] === "restore" && method === "POST") {
        return restoreFolderHandler(env, userId, folder);
      }
      if (segments[2] === "permanent" && method === "DELETE") {
        return permanentFolderHandler(env, userId, folder);
      }
    }
    if (segments.length === 2) {
      const folder = await requireFolder(env, userId, segments[1]);
      if (method === "PATCH") {
        const body = await readJson(request);
        const patch = {};
        if (body?.name !== undefined) {
          const name = sanitizeName(body.name);
          if (!name) throw new ApiError("INVALID_NAME", "文件夹名称不合法", 400);
          patch.name = name;
        }
        if (body?.parentId !== undefined) {
          const parentId = normalizeParent(body.parentId);
          if (parentId) {
            await requireFolder(env, userId, parentId);
            const ancestors = await ancestorsOf(env, userId, parentId);
            if (ancestors.includes(folder.id)) {
              throw new ApiError("INVALID_MOVE", "不能把文件夹移动到自身或其子目录", 400);
            }
          }
          patch.parentId = parentId;
        }
        if (body?.isFavorite !== undefined) patch.isFavorite = Boolean(body.isFavorite);
        await updateFolder(env, userId, folder.id, patch);
        return ok({ folder: mapFolder(await getFolder(env, userId, folder.id)) });
      }
      if (method === "DELETE") {
        return deleteFolderHandler(env, userId, folder, url);
      }
    }
    return null;
  }

  /* ------------------------------ 上传 ------------------------------ */
  if (segments.length === 1 && segments[0] === "upload" && method === "POST") {
    return uploadHandler(env, userId, request, url);
  }

  /* --------------------------- 单文件操作 --------------------------- */
  if (segments.length === 1) {
    const file = await getFile(env, userId, segments[0]);
    if (!file) throw new ApiError("NOT_FOUND", "文件不存在", 404);

    if (method === "GET") {
      if (file.status !== "ready") throw new ApiError("NOT_FOUND", "文件不存在", 404);
      return ok({ file: mapFile(file) });
    }
    if (method === "PATCH") {
      if (file.status !== "ready") throw new ApiError("FILE_NOT_READY", "文件当前不可编辑", 409);
      const body = await readJson(request);
      const patch = {};
      if (body?.displayName !== undefined) {
        const name = sanitizeName(body.displayName);
        if (!name) throw new ApiError("INVALID_NAME", "文件名不合法", 400);
        patch.displayName = name;
      }
      if (body?.parentId !== undefined) {
        const parentId = normalizeParent(body.parentId);
        if (parentId) await requireFolder(env, userId, parentId);
        patch.parentId = parentId;
      }
      if (body?.isFavorite !== undefined) patch.isFavorite = Boolean(body.isFavorite);
      await updateFile(env, userId, file.id, patch);
      return ok({ file: mapFile(await getFile(env, userId, file.id)) });
    }
    if (method === "DELETE") {
      if (file.status === "trash") return ok({ trashed: true });
      await softDeleteFile(env, userId, file.id);
      await logEvent(env, userId, "trash", file.id);
      return ok({ trashed: true });
    }
    throw new ApiError("METHOD_NOT_ALLOWED", "该接口不支持此方法", 405);
  }

  if (segments.length === 2) {
    const [id, action] = segments;
    const file = await getFile(env, userId, id);
    if (!file) throw new ApiError("NOT_FOUND", "文件不存在", 404);

    // HEAD 与 GET 共用元数据逻辑，但 body 必须为空（2.0.9）
    if (action === "content" && (method === "GET" || method === "HEAD")) {
      return contentHandler(env, request, file, false, method === "HEAD");
    }
    if (action === "download" && (method === "GET" || method === "HEAD")) {
      return contentHandler(env, request, file, true, method === "HEAD");
    }
    if (action === "restore" && method === "POST") {
      if (file.status !== "trash") throw new ApiError("NOT_TRASHED", "文件不在回收站", 409);
      const parentId = await restoreFile(env, userId, file.id);
      await logEvent(env, userId, "restore", file.id);
      return ok({ restored: true, parentId });
    }
    if (action === "permanent" && method === "DELETE") {
      return permanentDeleteHandler(env, userId, file);
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

/**
 * 回收 `pending_delete` 行（2.0.10）。
 *
 * R2 删除失败时 permanentDeleteHandler 会把行标成 pending_delete 再抛 502；修复前
 * 这个状态没有任何读取或重试分支，行与对象会永久留在 R2 里（回收站看不见、
 * quota 也不统计，用户无法自助清理）。这里在每次列云盘时顺手重试有限条数：
 * R2 删除成功才删行，失败就保留给下一次，不阻塞列表请求。
 */
export async function retryPendingDeletes(env, userId, limit = 20) {
  const rows = await env.DB.prepare(
    "SELECT id, r2_key FROM files WHERE user_id = ? AND status = 'pending_delete' ORDER BY updated_at ASC LIMIT ?",
  )
    .bind(userId, limit)
    .all();
  const items = (rows.results || []).filter((row) => row?.id);
  if (!items.length) return 0;

  const keys = items.map((row) => row.r2_key).filter(Boolean);
  try {
    if (keys.length) await env.FILES.delete(keys);
  } catch (error) {
    console.error("[files] pending_delete retry failed:", error?.message ?? error);
    return 0;
  }

  let removed = 0;
  for (const chunk of chunkIds(items.map((row) => row.id))) {
    await env.DB.prepare(
      `DELETE FROM files WHERE user_id = ? AND status = 'pending_delete' AND id IN (${placeholdersFor(chunk)})`,
    )
      .bind(userId, ...chunk)
      .run();
    removed += chunk.length;
  }
  return removed;
}

async function listHandler(env, userId, url) {
  const view = url.searchParams.get("view") || "folder";
  const search = (url.searchParams.get("search") || "").trim().slice(0, 80);
  const sort = url.searchParams.get("sort") || "updated";
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const limit = Number(url.searchParams.get("limit") || 60);
  const offset = Number(url.searchParams.get("offset") || 0);

  // 顺手清理删除失败的行；失败不影响列表本身
  await retryPendingDeletes(env, userId).catch(() => undefined);

  if (view === "trash") {
    const [rows, folders] = await Promise.all([trashFiles(env, userId), trashFolders(env, userId)]);
    return ok({
      view,
      items: rows.map(mapFile),
      folders: folders.map(mapFolder),
      limit,
      offset,
    });
  }

  if (view === "favorites") {
    const [items, folders] = await Promise.all([
      listFiles(env, userId, { favorite: true, sort, dir, limit, offset }),
      listFolders(env, userId),
    ]);
    return ok({ view, items, folders: folders.filter((folder) => folder.isFavorite) });
  }

  if (view === "recent") {
    const items = await listFiles(env, userId, { sort: "updated", dir: "desc", limit: 30 });
    return ok({ view, items, folders: [] });
  }

  const category = ["image", "document", "audio", "video", "other"].includes(view) ? view : undefined;
  const folderId = normalizeParent(url.searchParams.get("folderId"));
  if (folderId) await requireFolder(env, userId, folderId);

  const items = await listFiles(env, userId, {
    parentId: search || category ? undefined : folderId,
    category,
    search,
    sort,
    dir,
    limit,
    offset,
  });

  const folders = search || category ? [] : await listFolders(env, userId, { parentId: folderId });

  return ok({ view, items, folders, limit, offset });
}

async function quotaHandler(env, userId) {
  const stats = await usage(env, userId);
  const limit = quotaBytes(env);
  return ok({
    limitBytes: limit,
    usedBytes: stats.usedBytes,
    remainingBytes: Math.max(limit - stats.usedBytes, 0),
    files: stats.files,
    images: stats.images,
    documents: stats.documents,
    audio: stats.audio,
    video: stats.video,
    trashBytes: stats.trashBytes,
    trashCount: stats.trashCount,
  });
}

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

async function uploadHandler(env, userId, request, url) {
  const name = sanitizeName(url.searchParams.get("name"));
  if (!name) throw new ApiError("INVALID_NAME", "文件名不合法", 400);

  const parentId = normalizeParent(url.searchParams.get("parentId"));
  if (parentId) await requireFolder(env, userId, parentId);

  const size = Number(request.headers.get("content-length") || 0);
  if (!size || !Number.isFinite(size)) throw new ApiError("LENGTH_REQUIRED", "缺少文件大小", 411);
  if (size > MAX_FILE_BYTES) {
    throw new ApiError("FILE_TOO_LARGE", `单个文件不能超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`, 413);
  }

  const stats = await usage(env, userId);
  const limit = quotaBytes(env);
  if (stats.usedBytes + size > limit) {
    throw new ApiError("QUOTA_EXCEEDED", "云端空间不足", 507);
  }

  if (!request.body) throw new ApiError("EMPTY_BODY", "没有收到文件内容", 400);

  const [probe, body] = request.body.tee();
  const reader = probe.getReader();
  const first = await reader.read();
  await reader.cancel().catch(() => undefined);
  const head = first.value ? first.value.slice(0, 32) : new Uint8Array();

  const declared = request.headers.get("content-type") || "application/octet-stream";
  const detected = detectMime(head, name, declared);
  if (detected.rejected || !detected.mime) {
    throw new ApiError("UNSUPPORTED_TYPE", "文件内容与类型不匹配，已拒绝上传", 415);
  }

  const id = crypto.randomUUID();
  const objectKey = `users/${userId}/files/${id}`;

  await insertPendingFile(env, {
    id,
    userId,
    parentId,
    objectKey,
    name,
    extension: extensionOf(name),
    mimeType: detected.mime,
    size,
  });

  /*
   * 占位之后再查一次实际占用（细节见 assertReservedFileQuota）。
   * 超限时先删占位再返回 507 —— 此时还没写 R2，失败不会留下孤儿对象。
   */
  await assertReservedFileQuota(env, userId, id, limit);

  try {
    const object = await env.FILES.put(objectKey, body, {
      httpMetadata: { contentType: detected.mime },
    });
    await markFileReady(env, id, { etag: object?.etag || null, size: Number(object?.size || size) });
    await logEvent(env, userId, "upload", id, { size, mime: detected.mime });
  } catch (error) {
    console.error("[files] r2 put failed:", error?.message ?? error);
    await deleteFileRow(env, userId, id).catch(() => undefined);
    throw new ApiError("UPLOAD_FAILED", "文件写入 R2 失败，请重试", 502);
  }

  const file = await getFile(env, userId, id);
  return ok({ file: mapFile(file) }, { status: 201 });
}

/**
 * 上传配额的最后一道闸门：pending 行已经写入，复核「合计占用是否超限」。
 *
 * 为什么不在预检处一次算完：预检（usage + size）与写入之间有等待，两个并发上传会同时
 * 通过预检、一起越界。D1 没有事务，所以先把 pending 行占位（usage() 把 pending 计入），
 * 再求和判定：后到的请求一定能看到先到的 pending 行 —— 并发时只可能「都保守拒绝」或
 * 「排队通过」，不会一起越界。超限时删除自己的占位再抛 507，此时还没写 R2，不留孤儿对象。
 *
 * @param {any} env
 * @param {string} userId
 * @param {string} id 本次上传的 pending 文件 id
 * @param {number} limit 配额字节数
 * @returns {Promise<number>} 复核时的已用字节数
 */
export async function assertReservedFileQuota(env, userId, id, limit) {
  const reserved = await usage(env, userId);
  if (reserved.usedBytes > limit) {
    await deleteFileRow(env, userId, id).catch(() => undefined);
    throw new ApiError("QUOTA_EXCEEDED", "云端空间不足", 507);
  }
  return reserved.usedBytes;
}

/* ------------------------------------------------------------------ */
/* 内容 / 下载                                                         */
/* ------------------------------------------------------------------ */

/**
 * 2.0.9：只解析单区间 Range，才判得了「起点越过文件末尾」。
 *
 * R2 的 `get(key, { range: headers })` 遇到不可满足的区间不会抛错，而是回整包 200，
 * 客户端拿到 200 + 完整内容，会误以为续传成功。RFC 7233 要求 416 + `Content-Range: bytes *\/size`。
 * 多区间/畸形头按 RFC 允许忽略（退回 200），不在这里拆包。
 */
export function parseByteRange(header, total) {
  if (!header || !Number.isFinite(total) || total <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= total) return { unsatisfiable: true };
  if (end < start) return null;
  return { start, end: Math.min(end, total - 1) };
}

export async function contentHandler(env, request, file, forceDownload, headOnly = false) {
  if (file.status !== "ready") throw new ApiError("NOT_FOUND", "文件不存在", 404);

  const rangeHeader = request.headers.get("range");
  const total = Number(file.size_bytes || 0);
  const planned = parseByteRange(rangeHeader, total);

  const inline = !forceDownload && isInlineSafe(file.mime_type);
  const headers = new Headers({
    "content-type": file.mime_type || "application/octet-stream",
    "content-disposition": contentDisposition(file.display_name || file.name, inline),
    "cache-control": "private, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  });
  const etag = file.etag;
  if (etag) headers.set("etag", etag);

  // 起点越界：不读 R2，直接 416，否则客户端会把整包 200 当成续传成功
  if (planned && planned.unsatisfiable) {
    headers.set("content-range", `bytes */${total}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }

  const object = await env.FILES.get(file.r2_key, rangeHeader ? { range: request.headers } : undefined);
  if (!object) throw new ApiError("NOT_FOUND", "文件内容不存在", 404);

  if (object.httpEtag) headers.set("etag", object.httpEtag);

  let status = 200;
  let length = Number(object.size || total);
  if (rangeHeader && object.range) {
    status = 206;
    const offset = Number(object.range.offset || 0);
    const partLength = Number(object.range.length || length);
    headers.set("content-range", `bytes ${offset}-${offset + partLength - 1}/${object.size}`);
    length = partLength;
  }
  headers.set("content-length", String(length));

  // HEAD 只回元数据：body 必须是 null，否则运行时会把整段内容也读出来
  return new Response(headOnly ? null : object.body, { status, headers });
}

/* ------------------------------------------------------------------ */
/* 删除 / 恢复                                                         */
/* ------------------------------------------------------------------ */

async function permanentDeleteHandler(env, userId, file) {
  if (file.status !== "trash") throw new ApiError("NOT_TRASHED", "请先将文件移入回收站", 409);

  try {
    await env.FILES.delete(file.r2_key);
  } catch (error) {
    console.error("[files] r2 delete failed:", error?.message ?? error);
    await env.DB.prepare("UPDATE files SET status = 'pending_delete' WHERE id = ? AND user_id = ?")
      .bind(file.id, userId)
      .run();
    throw new ApiError("DELETE_FAILED", "R2 删除失败，已保留重试状态", 502);
  }

  await deleteFileRow(env, userId, file.id);
  await logEvent(env, userId, "permanent_delete", file.id);
  return ok({ deleted: true });
}

async function deleteFolderHandler(env, userId, folder, url) {
  const recursive = url.searchParams.get("recursive") === "1";
  const tree = await folderTree(env, userId, folder.id);
  const chunks = chunkIds(tree);

  let fileCount = 0;
  for (const chunk of chunks) {
    const fileCountRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM files WHERE user_id = ? AND parent_id IN (${placeholdersFor(chunk)}) AND status = 'ready'`,
    )
      .bind(userId, ...chunk)
      .first();
    fileCount += Number(fileCountRow?.total || 0);
  }
  const childFolders = tree.length - 1;

  if (!recursive && (fileCount > 0 || childFolders > 0)) {
    throw new ApiError(
      "FOLDER_NOT_EMPTY",
      `文件夹不为空（${fileCount} 个文件、${childFolders} 个子文件夹），请确认递归删除`,
      409,
    );
  }

  const now = Date.now();
  await env.DB.batch(
    chunks.map((chunk) =>
      env.DB.prepare(
        `UPDATE folders SET deleted_at = ?, trash_group = ? WHERE user_id = ? AND id IN (${placeholdersFor(chunk)})`,
      ).bind(now, folder.id, userId, ...chunk),
    ),
  );

  await env.DB.batch(
    chunks.map((chunk) =>
      env.DB.prepare(
        `UPDATE files SET status = 'trash', deleted_at = ?, trash_group = ?, updated_at = ?
          WHERE user_id = ? AND parent_id IN (${placeholdersFor(chunk)}) AND status = 'ready'`,
      ).bind(now, folder.id, now, userId, ...chunk),
    ),
  );

  await logEvent(env, userId, "trash_folder", folder.id, { files: fileCount, folders: childFolders });
  return ok({ trashed: true, files: fileCount, folders: childFolders });
}

async function restoreFolderHandler(env, userId, folder) {
  if (!folder.deleted_at) throw new ApiError("NOT_TRASHED", "文件夹不在回收站", 409);

  let parentId = folder.parent_id;
  if (parentId) {
    const parent = await getFolder(env, userId, parentId);
    if (!parent || parent.deleted_at) parentId = null;
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE folders
          SET deleted_at = NULL, trash_group = NULL,
              parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END
        WHERE user_id = ? AND (id = ? OR trash_group = ?)`,
    ).bind(folder.id, parentId, userId, folder.id, folder.id),
    env.DB.prepare(
      `UPDATE files SET status = 'ready', deleted_at = NULL, trash_group = NULL, updated_at = ?
        WHERE user_id = ? AND trash_group = ?`,
    ).bind(now, userId, folder.id),
  ]);

  await logEvent(env, userId, "restore_folder", folder.id);
  return ok({ restored: true, parentId });
}

async function permanentFolderHandler(env, userId, folder) {
  if (!folder.deleted_at) throw new ApiError("NOT_TRASHED", "请先将文件夹移入回收站", 409);

  const tree = await folderTree(env, userId, folder.id);
  const chunks = chunkIds(tree);

  // 分块查文件：整棵大目录同样会超过 D1 的 100 绑定参数上限
  const files = [];
  for (const chunk of chunks) {
    const rows = await env.DB.prepare(
      `SELECT id, r2_key FROM files WHERE user_id = ? AND parent_id IN (${placeholdersFor(chunk)})`,
    )
      .bind(userId, ...chunk)
      .all();
    files.push(...(rows.results || []));
  }
  const keys = files.map((row) => row.r2_key).filter(Boolean);

  for (let i = 0; i < keys.length; i += 500) {
    try {
      await env.FILES.delete(keys.slice(i, i + 500));
    } catch (error) {
      console.error("[files] folder delete r2 failed:", error?.message ?? error);
      await env.DB.batch(
        chunks.map((chunk) =>
          env.DB.prepare(
            `UPDATE files SET status = 'pending_delete' WHERE user_id = ? AND parent_id IN (${placeholdersFor(chunk)})`,
          ).bind(userId, ...chunk),
        ),
      );
      throw new ApiError("DELETE_FAILED", "R2 删除失败，已保留重试状态", 502);
    }
  }

  await env.DB.batch(
    chunks.flatMap((chunk) => [
      env.DB.prepare(`DELETE FROM files WHERE user_id = ? AND parent_id IN (${placeholdersFor(chunk)})`).bind(
        userId,
        ...chunk,
      ),
      env.DB.prepare(`DELETE FROM folders WHERE user_id = ? AND id IN (${placeholdersFor(chunk)})`).bind(
        userId,
        ...chunk,
      ),
    ]),
  );

  await logEvent(env, userId, "permanent_delete_folder", folder.id, { files: files.length });
  return ok({ deleted: true, files: files.length });
}

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

function normalizeParent(value) {
  if (!value || value === "root" || value === "null") return null;
  return String(value);
}

async function requireFolder(env, userId, id) {
  const folder = await getFolder(env, userId, id);
  if (!folder || folder.deleted_at) throw new ApiError("FOLDER_NOT_FOUND", "文件夹不存在", 404);
  return folder;
}

/**
 * 读取 JSON 请求体统一走 guards.js（1 MB 上限，声明长度 + 实际字节双校验）。
 */

/* 空回收站：删除 R2 对象后再删 D1 记录，失败时保留可重试状态。 */
export async function emptyTrash(env, userId) {
  const rows = await trashFiles(env, userId);
  const keys = rows.filter((row) => row.r2_key).map((row) => row.r2_key);

  for (let i = 0; i < keys.length; i += 500) {
    try {
      await env.FILES.delete(keys.slice(i, i + 500));
    } catch (error) {
      console.error("[files] empty trash r2 delete failed:", error?.message ?? error);
      throw new ApiError("DELETE_FAILED", "部分文件删除失败，请重试", 502);
    }
  }

  await env.DB.prepare("DELETE FROM files WHERE user_id = ? AND status = 'trash'").bind(userId).run();
  await env.DB.prepare("DELETE FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL").bind(userId).run();
  await logEvent(env, userId, "empty_trash", null, { files: keys.length });
  return ok({ deleted: keys.length });
}
