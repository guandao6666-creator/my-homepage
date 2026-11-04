/** 云盘 D1 访问层。所有查询都绑定当前 Session 的 user_id。 */

const SORTS = {
  name: "COALESCE(display_name, name)",
  size: "size_bytes",
  type: "mime_type",
  created: "created_at",
  updated: "updated_at",
};

export function mapFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name || row.name,
    originalName: row.name,
    mimeType: row.mime_type,
    extension: row.extension || "",
    sizeBytes: Number(row.size_bytes || 0),
    parentId: row.parent_id || null,
    category: categoryFromMime(row.mime_type),
    isFavorite: Boolean(row.is_favorite),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  };
}

export function mapFolder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    isFavorite: Boolean(row.is_favorite),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function categoryFromMime(mime) {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf" || type.startsWith("text/")) return "document";
  return "other";
}

export async function listFiles(env, userId, options = {}) {
  const {
    status = "ready",
    parentId,
    category,
    search,
    favorite,
    sort = "updated",
    dir = "desc",
    limit = 60,
    offset = 0,
  } = options;

  const where = ["user_id = ?", "status = ?"];
  const binds = [userId, status];

  if (parentId === null) where.push("parent_id IS NULL");
  else if (parentId) {
    where.push("parent_id = ?");
    binds.push(parentId);
  }

  if (category === "image") where.push("mime_type LIKE 'image/%'");
  else if (category === "audio") where.push("mime_type LIKE 'audio/%'");
  else if (category === "video") where.push("mime_type LIKE 'video/%'");
  else if (category === "document") where.push("(mime_type = 'application/pdf' OR mime_type LIKE 'text/%')");
  else if (category === "other")
    where.push("NOT (mime_type LIKE 'image/%' OR mime_type LIKE 'audio/%' OR mime_type LIKE 'video/%' OR mime_type = 'application/pdf' OR mime_type LIKE 'text/%')");

  if (search) {
    where.push("(COALESCE(display_name, name) LIKE ? OR name LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like);
  }
  if (favorite) where.push("is_favorite = 1");

  const column = SORTS[sort] || SORTS.updated;
  const direction = dir === "asc" ? "ASC" : "DESC";
  const safeLimit = Math.min(Math.max(Number(limit) || 60, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const rows = await env.DB.prepare(
    `SELECT * FROM files WHERE ${where.join(" AND ")}
     ORDER BY ${column} ${direction}, created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...binds, safeLimit, safeOffset)
    .all();

  return (rows.results || []).map(mapFile);
}

export async function listFolders(env, userId, { parentId, includeDeleted = false } = {}) {
  const where = ["user_id = ?"];
  const binds = [userId];
  if (!includeDeleted) where.push("deleted_at IS NULL");
  if (parentId === null) where.push("parent_id IS NULL");
  else if (parentId) {
    where.push("parent_id = ?");
    binds.push(parentId);
  }

  const rows = await env.DB.prepare(
    `SELECT * FROM folders WHERE ${where.join(" AND ")} ORDER BY name ASC`,
  )
    .bind(...binds)
    .all();
  return (rows.results || []).map(mapFolder);
}

export async function getFile(env, userId, id) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").bind(id, userId).first();
}

export async function getFolder(env, userId, id) {
  return env.DB.prepare("SELECT * FROM folders WHERE id = ? AND user_id = ?").bind(id, userId).first();
}

export async function insertPendingFile(env, data) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO files (id, user_id, parent_id, r2_key, name, display_name, extension,
                        mime_type, size_bytes, status, is_favorite, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL)`,
  )
    .bind(
      data.id,
      data.userId,
      data.parentId,
      data.objectKey,
      data.name,
      data.name,
      data.extension,
      data.mimeType,
      data.size,
      now,
      now,
    )
    .run();
}

export async function markFileReady(env, id, { etag, size }) {
  await env.DB.prepare(
    "UPDATE files SET status = 'ready', etag = ?, size_bytes = ?, updated_at = ? WHERE id = ?",
  )
    .bind(etag || null, size, Date.now(), id)
    .run();
}

export async function deleteFileRow(env, userId, id) {
  await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

export async function updateFile(env, userId, id, patch) {
  const fields = [];
  const binds = [];
  if (patch.displayName !== undefined) {
    fields.push("display_name = ?");
    binds.push(patch.displayName);
  }
  if (patch.parentId !== undefined) {
    fields.push("parent_id = ?");
    binds.push(patch.parentId);
  }
  if (patch.isFavorite !== undefined) {
    fields.push("is_favorite = ?");
    binds.push(patch.isFavorite ? 1 : 0);
  }
  if (!fields.length) return;
  fields.push("updated_at = ?");
  binds.push(Date.now(), id, userId);
  await env.DB.prepare(`UPDATE files SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds)
    .run();
}

export async function softDeleteFile(env, userId, id) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE files SET status = 'trash', deleted_at = ?, trash_group = id, updated_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(now, now, id, userId)
    .run();
}

export async function restoreFile(env, userId, id) {
  const file = await getFile(env, userId, id);
  if (!file) return null;
  let parentId = file.parent_id;
  if (parentId) {
    const parent = await getFolder(env, userId, parentId);
    if (!parent || parent.deleted_at) parentId = null;
  }
  await env.DB.prepare(
    "UPDATE files SET status = 'ready', deleted_at = NULL, trash_group = NULL, parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(parentId, Date.now(), id, userId)
    .run();
  return parentId;
}

export async function insertFolder(env, { id, userId, parentId, name }) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO folders (id, user_id, parent_id, name, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  )
    .bind(id, userId, parentId, name, now, now)
    .run();
}

export async function updateFolder(env, userId, id, patch) {
  const fields = [];
  const binds = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    binds.push(patch.name);
  }
  if (patch.parentId !== undefined) {
    fields.push("parent_id = ?");
    binds.push(patch.parentId);
  }
  if (patch.isFavorite !== undefined) {
    fields.push("is_favorite = ?");
    binds.push(patch.isFavorite ? 1 : 0);
  }
  if (!fields.length) return;
  fields.push("updated_at = ?");
  binds.push(Date.now(), id, userId);
  await env.DB.prepare(`UPDATE folders SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds)
    .run();
}

/** 返回该文件夹自身及全部后代文件夹 id。 */
export async function folderTree(env, userId, folderId) {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM folders WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.user_id = ?
     ) SELECT id FROM tree`,
  )
    .bind(folderId, userId, userId)
    .all();
  return (rows.results || []).map((row) => row.id);
}

/** 从某文件夹向上回溯，判断 target 是否为其祖先（防止把文件夹拖进自己）。 */
export async function ancestorsOf(env, userId, folderId) {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id) AS (
       SELECT id, parent_id FROM folders WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT f.id, f.parent_id FROM folders f JOIN up u ON f.id = u.parent_id WHERE f.user_id = ?
     ) SELECT id FROM up`,
  )
    .bind(folderId, userId, userId)
    .all();
  return (rows.results || []).map((row) => row.id);
}

export async function usage(env, userId) {
  const total = await env.DB.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used
       FROM files WHERE user_id = ? AND status IN ('ready', 'trash', 'pending')`,
  )
    .bind(userId)
    .first();

  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN mime_type LIKE 'image/%' THEN 1 ELSE 0 END) AS images,
       SUM(CASE WHEN mime_type LIKE 'audio/%' THEN 1 ELSE 0 END) AS audio,
       SUM(CASE WHEN mime_type LIKE 'video/%' THEN 1 ELSE 0 END) AS video,
       SUM(CASE WHEN mime_type = 'application/pdf' OR mime_type LIKE 'text/%' THEN 1 ELSE 0 END) AS documents,
       COUNT(*) AS files
     FROM files WHERE user_id = ? AND status = 'ready'`,
  )
    .bind(userId)
    .first();

  const trash = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS count FROM files WHERE user_id = ? AND status = 'trash'",
  )
    .bind(userId)
    .first();

  return {
    usedBytes: Number(total?.used || 0),
    files: Number(counts?.files || 0),
    images: Number(counts?.images || 0),
    documents: Number(counts?.documents || 0),
    audio: Number(counts?.audio || 0),
    video: Number(counts?.video || 0),
    trashBytes: Number(trash?.bytes || 0),
    trashCount: Number(trash?.count || 0),
  };
}

export async function logEvent(env, userId, action, fileId = null, meta = null) {
  try {
    await env.DB.prepare(
      "INSERT INTO file_events (id, user_id, file_id, action, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), userId, fileId, action, meta ? JSON.stringify(meta).slice(0, 500) : null, Date.now())
      .run();
  } catch (error) {
    console.error("[files] audit log failed:", error?.message ?? error);
  }
}

export async function trashFiles(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT * FROM files WHERE user_id = ? AND status = 'trash' ORDER BY deleted_at DESC",
  )
    .bind(userId)
    .all();
  return rows.results || [];
}

export async function trashFolders(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
  )
    .bind(userId)
    .all();
  return rows.results || [];
}
