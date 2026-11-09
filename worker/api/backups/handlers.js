/**
 * /api/backups/* 业务处理。
 *
 * 安全边界：
 *   - user_id 只从 Session 读取；
 *   - 备份 ID 必须同时匹配 user_id，否则 404；
 *   - Object Key 全部由服务端生成；
 *   - 备份对象与实时文件对象完全分离；
 *   - 恢复前必须有同一用户、1 小时内完成的保护性备份。
 */

import { ApiError, json, ok } from "../http.js";
import { assertSameOrigin, readJson } from "../guards.js";
import { authConfig } from "../auth/config.js";
import { inspectSession } from "../auth/session.js";
import {
  BACKUP_SCHEMA,
  backupKeys,
  buildManifest,
  collectDrive,
  copyFileToBackup,
  createZipStream,
  deleteBackupPrefix,
  loadData,
  loadManifest,
  readJsonObjectVerified,
  verifyFileObject,
  writeJsonObject,
} from "./archive.js";
import { hashStream, sha256Hex } from "./crypto.js";
import { getPrivacySettings } from "../privacy/store.js";
import {
  MAX_BACKUPS_PER_USER,
  MAX_BACKUP_BYTES,
  MAX_SNAPSHOT_BYTES,
  countBackups,
  createBackup,
  createJob,
  createRestore,
  findRestoreByIdempotency,
  getBackup,
  getJob,
  getLatestJob,
  getRestore,
  getSettings,
  hasActiveBackup,
  insertBackupItem,
  listAutoUsers,
  listBackupItems,
  listBackups,
  listExpiredAutoBackups,
  listRestoreFiles,
  listRestores,
  mapBackup,
  mapJob,
  markAutoRun,
  markBackupDeleted,
  parseJson,
  purgeBackupRows,
  saveSettings,
  storageStats,
  updateBackup,
  updateJob,
  updateRestore,
  upsertRestoreFile,
} from "./store.js";

const PREFIX = "/api/backups";
const LOCAL_DOMAINS = new Set(["notes", "tasks", "calendar", "desktop", "workspace"]);
const ALL_DOMAINS = new Set([...LOCAL_DOMAINS, "drive"]);
const RESTORE_MODES = new Set(["copy", "merge", "replace"]);
const COPY_BATCH = 5;
const TIME_BUDGET_MS = 18_000;

export async function handleBackupsRequest({ request, env, url, path }) {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const rest = path.slice(PREFIX.length).replace(/^\/+/, "");
  const segments = rest ? rest.split("/") : [];
  const method = request.method;

  const inspected = await inspectSession(env, request);
  if (inspected.state !== "active") {
    throw new ApiError(
      inspected.state === "revoked" || inspected.state === "device_revoked"
        ? "SESSION_REVOKED"
        : "UNAUTHENTICATED",
      inspected.state === "expired" ? "登录已过期，请重新登录" : "请先登录",
      401,
    );
  }

  const userId = inspected.user.id;
  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(request, authConfig(env, request).origin);
  }

  /* ------------------------------ 集合 ------------------------------ */
  if (segments.length === 0) {
    if (method === "GET") return listHandler(env, userId, url);
    if (method === "POST") return createHandler(env, request, userId);
    return null;
  }

  /* ------------------------------ 静态子路径 ------------------------ */
  if (segments[0] === "settings") {
    if (segments.length === 1 && method === "GET") {
      return ok({ settings: await getSettings(env, userId), cron: cronInfo(env) });
    }
    if (segments.length === 1 && method === "PUT") return settingsHandler(env, request, userId);
  }

  if (segments[0] === "storage" && segments.length === 1 && method === "GET") {
    return ok({ storage: await storageStats(env, userId) });
  }

  if (segments[0] === "restores") {
    if (segments.length === 1 && method === "GET") {
      return ok({ restores: await listRestores(env, userId, Number(url.searchParams.get("limit") || 20)) });
    }
    if (segments.length === 3 && method === "POST" && segments[2] === "run") {
      const restore = await getRestore(env, userId, segments[1]);
      if (!restore) throw new ApiError("NOT_FOUND", "恢复任务不存在", 404);
      return ok(await runRestore(env, userId, restore));
    }
    if (segments.length === 3 && method === "POST" && segments[2] === "ack") {
      return restoreAckHandler(env, request, userId, segments[1]);
    }
  }

  /* ------------------------------ 单备份 ---------------------------- */
  const backupId = segments[0];
  const backup = await getBackup(env, userId, backupId);
  if (!backup) throw new ApiError("NOT_FOUND", "备份不存在", 404);

  if (segments.length === 1) {
    if (method === "GET") return detailHandler(env, userId, backup);
    if (method === "PATCH") return renameHandler(env, request, userId, backup);
    if (method === "DELETE") return deleteHandler(env, request, userId, backup);
  }

  if (segments.length === 2) {
    const action = segments[1];
    if (action === "progress" && method === "GET") {
      const job = await getLatestJob(env, userId, backup.id);
      return ok({ backup: mapBackup(backup), job: mapJob(job) });
    }
    if (action === "run" && method === "POST") {
      return ok(await runBackup(env, userId, backup));
    }
    if (action === "verify" && method === "POST") {
      return ok(await verifyHandler(env, userId, backup));
    }
    if (action === "download" && method === "GET") {
      return downloadHandler(env, userId, backup, url);
    }
    if (action === "export" && method === "GET") {
      return exportHandler(env, userId, backup, url);
    }
  }

  if (segments.length === 3 && segments[1] === "restore") {
    if (segments[2] === "preview" && method === "POST") {
      return previewHandler(env, request, userId, backup);
    }
  }

  if (segments.length === 2 && segments[1] === "restore" && method === "POST") {
    return restoreHandler(env, request, userId, backup);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 列表 / 详情                                                         */
/* ------------------------------------------------------------------ */

async function listHandler(env, userId, url) {
  const result = await listBackups(env, userId, {
    limit: Number(url.searchParams.get("limit") || 20),
    offset: Number(url.searchParams.get("offset") || 0),
    type: url.searchParams.get("type"),
    status: url.searchParams.get("status"),
    failed: url.searchParams.get("failed"),
    scope: url.searchParams.get("scope"),
    q: url.searchParams.get("q"),
    sort: url.searchParams.get("sort"),
  });

  const [settings, storage] = await Promise.all([
    getSettings(env, userId),
    storageStats(env, userId),
  ]);

  return ok({
    ...result,
    settings,
    storage,
    cron: cronInfo(env),
  });
}

async function detailHandler(env, userId, backup) {
  const [job, items] = await Promise.all([
    getLatestJob(env, userId, backup.id),
    listBackupItems(env, userId, backup.id, "file"),
  ]);

  return ok({
    backup: mapBackup(backup),
    job: mapJob(job),
    files: items.map((item) => ({
      id: item.entityId,
      sizeBytes: item.sizeBytes,
      checksum: item.checksum,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

async function createHandler(env, request, userId) {
  const body = await readJson(request, MAX_SNAPSHOT_BYTES + 64 * 1024);
  const name = sanitizeName(body?.name) || defaultName(body?.type);
  const domains = normalizeDomains(body?.domains);
  const type = body?.type === "protective" ? "protective" : "manual";

  if (!domains.length) throw new ApiError("NO_DOMAINS", "请至少选择一个备份范围", 400);

  // 隐私设置是真实的服务端约束：关闭的类型不允许上传到云端备份。
  const privacy = await getPrivacySettings(env, userId);
  const localSelected = domains.filter((domain) => LOCAL_DOMAINS.has(domain));
  if (!privacy.cloudSync && localSelected.length) {
    throw new ApiError(
      "CLOUD_SYNC_DISABLED",
      "隐私设置已关闭本地数据上传；可只备份 Cloud Drive，或先在隐私中心开启。",
      403,
    );
  }
  const blocked = localSelected.filter((domain) => privacy[domain] === false);
  if (blocked.length) {
    throw new ApiError(
      "DOMAIN_UPLOAD_DISABLED",
      `隐私设置禁止上传：${blocked.join(" / ")}。请在隐私中心调整后再备份。`,
      403,
    );
  }

  const snapshot = body?.snapshot;
  for (const domain of domains) {
    if (!LOCAL_DOMAINS.has(domain)) continue;
    if (!snapshot?.[domain]) {
      throw new ApiError(
        "SNAPSHOT_REQUIRED",
        `缺少 ${domain} 的本地快照。浏览器本地数据必须由当前设备上传，服务端无法读取。`,
        400,
      );
    }
  }

  if ((await countBackups(env, userId)) >= MAX_BACKUPS_PER_USER) {
    throw new ApiError("BACKUP_LIMIT", `备份数量已达上限（${MAX_BACKUPS_PER_USER}），请先删除旧备份`, 409);
  }

  /*
   * 1.9：账号级存储上限。备份、云盘文件、回收站一起算，
   * 避免「文件配额 5 GiB + 60 份备份」把实际 R2 用量放大到几十倍。
   * 这里只做入口拦截；单份备份的准确体积在 manifest 生成后用 MAX_BACKUP_BYTES 复核。
   */
  const stats = await storageStats(env, userId);
  const accountUsed =
    stats.backups.bytes + stats.liveFiles.bytes + stats.trashFiles.bytes;
  if (accountUsed >= MAX_BACKUP_BYTES * 4) {
    throw new ApiError(
      "ACCOUNT_STORAGE_FULL",
      "云端存储空间已接近上限，请删除旧备份或清理云端文件后再试",
      507,
    );
  }

  const active = await hasActiveBackup(env, userId);
  if (active) {
    throw new ApiError("BACKUP_IN_PROGRESS", "已有备份任务正在执行，请等待完成或重试该任务", 409);
  }

  const id = crypto.randomUUID();
  const keys = backupKeys(userId, id);
  const snapshotAt = Date.now();
  const drive = await collectDrive(env, userId);

  const data = {
    schemaVersion: BACKUP_SCHEMA,
    backupId: id,
    userId,
    createdAt: snapshotAt,
    snapshotAt,
    scope: domains.length === ALL_DOMAINS.size ? "full" : "partial",
    domains: buildDomains(snapshot, domains, drive),
    source: {
      dataOrigin: "mixed",
      note: "本地域由设备上传快照，drive 由服务端在 snapshotAt 读取；两者在同一次请求内完成边界记录。",
    },
  };

  const dataMeta = await writeJsonObject(env, keys.data, data);

  await createBackup(env, {
    id,
    userId,
    name,
    type,
    scope: data.scope,
    domains,
    snapshotAt,
    manifestKey: keys.manifest,
  });
  await updateBackup(env, userId, id, { dataKey: dataMeta.key, stats: { dataSize: dataMeta.size } });

  const jobId = await createJob(env, {
    id: crypto.randomUUID(),
    userId,
    backupId: id,
    type: "backup",
    total: domains.includes("drive") ? drive.files.length : 0,
    stage: "collecting",
  });

  const created = await getBackup(env, userId, id);
  const job = await getJob(env, userId, jobId);
  return ok(
    {
      backup: mapBackup(created),
      job: mapJob(job),
      totals: {
        files: drive.files.length,
        fileBytes: drive.files.reduce((sum, file) => sum + file.sizeBytes, 0),
        dataBytes: dataMeta.size,
      },
    },
    { status: 201 },
  );
}

function buildDomains(snapshot, domains, drive) {
  const out = {};

  if (domains.includes("notes")) {
    out.notes = { present: true, data: sanitizeLocal(snapshot.notes) };
  }
  if (domains.includes("tasks")) {
    out.tasks = { present: true, data: sanitizeLocal(snapshot.tasks) };
  }
  if (domains.includes("calendar")) {
    out.calendar = { present: true, data: sanitizeLocal(snapshot.calendar) };
  }
  if (domains.includes("desktop")) {
    out.desktop = { present: true, keys: sanitizeKeys(snapshot.desktop) };
  }
  if (domains.includes("workspace")) {
    out.workspace = { present: true, keys: sanitizeKeys(snapshot.workspace) };
  }

  out.drive = domains.includes("drive")
    ? {
        present: true,
        files: drive.files.map(({ liveKey, ...rest }) => rest),
        folders: drive.folders,
      }
    : { present: false, files: [], folders: [] };
  return out;
}

function sanitizeLocal(value) {
  if (!value || typeof value !== "object") {
    throw new ApiError("INVALID_SNAPSHOT", "本地快照格式不正确", 400);
  }
  return value;
}

function sanitizeKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_SNAPSHOT", "桌面 / 工作空间快照格式不正确", 400);
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (!/^guandao\.[a-z0-9._]+$/i.test(key)) continue;
    out[key] = val;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 执行备份                                                            */
/* ------------------------------------------------------------------ */

async function runBackup(env, userId, backupRow, options = {}) {
  const copyLimit = options.batch ?? COPY_BATCH;
  const budget = options.budget ?? TIME_BUDGET_MS;
  if (backupRow.status === "completed") {
    return { done: true, backup: mapBackup(backupRow), job: null };
  }
  if (backupRow.status === "cancelled") {
    throw new ApiError("BACKUP_CANCELLED", "备份已取消", 409);
  }

  const started = Date.now();
  const data = await loadData(env, backupRow);
  if (!data) {
    await failBackup(env, userId, backupRow, "DATA_OBJECT_MISSING", "备份数据对象不存在，请重新创建备份");
    throw new ApiError("DATA_MISSING", "备份数据对象不存在", 409);
  }

  let job = await getLatestJob(env, userId, backupRow.id, "backup");
  if (!job || job.status !== "running") {
    job = {
      id: await createJob(env, {
        id: crypto.randomUUID(),
        userId,
        backupId: backupRow.id,
        type: "backup",
        total: data.domains?.drive?.files?.length ?? 0,
        stage: backupRow.status === "verifying" ? "verifying" : "uploading",
      }),
    };
    job = await getJob(env, userId, job.id);
  }

  // 失败重试：只重置状态，不删除已经复制好的对象（按 backup_items 断点续传）。
  if (backupRow.status === "failed") {
    await updateBackup(env, userId, backupRow.id, { status: "collecting", errorMessage: null });
  }

  const files = data.domains?.drive?.files ?? [];
  const keys = backupKeys(userId, backupRow.id);

  /* ---------------- 复制阶段 ---------------- */
  if (backupRow.status !== "verifying") {
    await updateBackup(env, userId, backupRow.id, { status: "uploading" }).catch(() => undefined);
    await updateJob(env, userId, job.id, { stage: "uploading", total: files.length });

    const existing = await listBackupItems(env, userId, backupRow.id, "file");
    const done = new Set(existing.map((item) => item.entityId));
    let processed = done.size;
    let copiedThisRun = 0;

    for (const file of files) {
      if (done.has(file.id)) continue;
      if (copiedThisRun >= copyLimit || Date.now() - started > budget) break;

      const result = await copyFileToBackup(env, { userId, backupId: backupRow.id, file });
      if (!result.ok) {
        await failBackup(env, userId, backupRow, "FILE_COPY_FAILED", result.error);
        throw new ApiError("FILE_COPY_FAILED", `文件复制失败：${result.error}`, 502);
      }

      await insertBackupItem(env, userId, backupRow.id, {
        entityType: "file",
        entityId: file.id,
        objectKey: result.objectKey,
        sizeBytes: result.sizeBytes,
        checksum: result.sha256,
        meta: { name: file.name, mimeType: file.mimeType },
      });

      done.add(file.id);
      processed += 1;
      copiedThisRun += 1;

      await updateJob(env, userId, job.id, {
        processed,
        total: files.length,
        progress: files.length ? Math.round((processed / files.length) * 70) : 20,
      });
    }

    if (done.size < files.length) {
      return {
        done: false,
        backup: mapBackup(await getBackup(env, userId, backupRow.id)),
        job: mapJob(await getJob(env, userId, job.id)),
      };
    }

    // 所有文件已复制 → 生成 manifest
    await buildAndStoreManifest(env, userId, backupRow, data, keys, files, job);
    backupRow = await getBackup(env, userId, backupRow.id);
  }

  /* ---------------- 校验阶段 ---------------- */
  const result = await verifyBackup(env, userId, backupRow, job, started, budget);

  return {
    done: result.done,
    backup: mapBackup(await getBackup(env, userId, backupRow.id)),
    job: mapJob(await getJob(env, userId, job.id)),
    verify: result,
  };
}

async function buildAndStoreManifest(env, userId, backupRow, data, keys, files, job) {
  const items = await listBackupItems(env, userId, backupRow.id, "file");
  const byId = new Map(items.map((item) => [item.entityId, item]));
  const missing = files.filter((file) => !byId.has(file.id));
  if (missing.length) {
    await failBackup(env, userId, backupRow, "MANIFEST_INCOMPLETE", `有 ${missing.length} 个文件缺少备份条目`);
    throw new ApiError("MANIFEST_INCOMPLETE", "备份文件清单不完整", 409);
  }

  const dataObject = await env.FILES.get(keys.data);
  if (!dataObject) {
    await failBackup(env, userId, backupRow, "DATA_OBJECT_MISSING", "data.json 不存在");
    throw new ApiError("DATA_MISSING", "备份数据对象不存在", 409);
  }
  const dataDigest = await hashStream(dataObject.body);

  const fileEntries = files.map((file) => {
    const item = byId.get(file.id);
    return {
      ...file,
      sizeBytes: item.sizeBytes,
      sha256: item.checksum,
      objectKey: item.objectKey,
    };
  });

  const manifest = buildManifest({
    backup: backupRow,
    data,
    fileEntries,
    dataMeta: { key: keys.data, size: dataDigest.size, sha256: dataDigest.sha256 },
    createdAt: Date.now(),
  });

  const manifestMeta = await writeJsonObject(env, keys.manifest, manifest);

  const totalBytes = manifest.totalBytes;
  /*
   * 1.9 安全修复：MAX_BACKUP_BYTES（512 MiB）之前只是声明并展示给前端，
   * 从来没有真正比较过。结果是「备份数量 ≤ 60」成为唯一约束，
   * 一个账号可以用 60 份大备份把 R2 用量放大到配额之外。
   * 单次备份超限时直接失败并清理，不写入 size_bytes。
   */
  if (totalBytes > MAX_BACKUP_BYTES) {
    await failBackup(
      env,
      userId,
      backupRow,
      "BACKUP_TOO_LARGE",
      `单次备份 ${Math.round(totalBytes / 1024 / 1024)} MiB 超过上限 ${Math.round(MAX_BACKUP_BYTES / 1024 / 1024)} MiB`,
    );
    throw new ApiError(
      "BACKUP_TOO_LARGE",
      `单次备份不能超过 ${Math.round(MAX_BACKUP_BYTES / 1024 / 1024)} MiB，请减少备份范围`,
      413,
    );
  }

  await updateBackup(env, userId, backupRow.id, {
    status: "verifying",
    manifestKey: keys.manifest,
    checksum: manifestMeta.sha256,
    sizeBytes: totalBytes,
    fileCount: files.length,
    itemCount: manifest.itemCount,
  });

  await updateJob(env, userId, job.id, {
    stage: "verifying",
    progress: 75,
    checkpoint: { verifyIndex: 0, manifestChecksum: manifestMeta.sha256 },
  });
}

async function verifyBackup(env, userId, backupRow, job, started, budget = TIME_BUDGET_MS) {
  const manifest = await loadManifest(env, backupRow);
  if (!manifest) {
    await failBackup(env, userId, backupRow, "MANIFEST_MISSING", "manifest.json 不存在");
    throw new ApiError("MANIFEST_MISSING", "备份清单不存在", 409);
  }

  // 每次校验先验证 data.json（体积通常很小）。
  const dataCheck = await verifyFileObject(env, manifest.dataObjectKey, {
    sizeBytes: manifest.dataSize,
    sha256: manifest.dataChecksum,
  });
  if (!dataCheck.ok) {
    await failBackup(env, userId, backupRow, "DATA_CHECKSUM_FAILED", `data.json 校验失败：${dataCheck.error}`);
    throw new ApiError("VERIFY_FAILED", "备份数据校验失败", 409);
  }

  const checkpoint = parseJson(job.checkpoint_json, {}) || {};
  let index = Number(checkpoint.verifyIndex || 0);
  const files = manifest.files || [];

  while (index < files.length) {
    if (Date.now() - started > budget) break;
    const file = files[index];
    const check = await verifyFileObject(env, file.objectKey, {
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    });
    if (!check.ok) {
      await failBackup(env, userId, backupRow, "FILE_CHECKSUM_FAILED", `文件 ${file.id} 校验失败：${check.error}`);
      throw new ApiError("VERIFY_FAILED", "备份文件校验失败", 409);
    }
    index += 1;

    await updateJob(env, userId, job.id, {
      stage: "verifying",
      processed: index,
      total: files.length,
      progress: files.length ? 75 + Math.round((index / files.length) * 24) : 99,
      checkpoint: { ...checkpoint, verifyIndex: index },
    });
  }

  if (index < files.length) {
    return { done: false, verified: index, total: files.length };
  }

  const now = Date.now();
  await updateBackup(env, userId, backupRow.id, {
    status: "completed",
    completedAt: now,
    verifiedAt: now,
    checksum: backupRow.checksum_sha256 || checkpoint.manifestChecksum,
  });
  await updateJob(env, userId, job.id, {
    status: "completed",
    stage: "completed",
    progress: 100,
    total: files.length,
    processed: files.length,
    completedAt: now,
  });

  return { done: true, verified: files.length, total: files.length };
}

async function failBackup(env, userId, backupRow, code, message) {
  await updateBackup(env, userId, backupRow.id, {
    status: "failed",
    errorMessage: String(message).slice(0, 300),
  });
  const job = await getLatestJob(env, userId, backupRow.id, "backup");
  if (job) {
    await updateJob(env, userId, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: code,
      errorMessage: String(message).slice(0, 300),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 手动校验                                                            */
/* ------------------------------------------------------------------ */

async function verifyHandler(env, userId, backupRow) {
  if (backupRow.status !== "completed" && backupRow.status !== "failed") {
    throw new ApiError("NOT_READY", "备份尚未完成，无法单独校验", 409);
  }

  const started = Date.now();
  const data = await loadData(env, backupRow);
  const manifest = await loadManifest(env, backupRow);
  if (!data || !manifest) throw new ApiError("MANIFEST_MISSING", "备份清单缺失", 409);

  let job = await getLatestJob(env, userId, backupRow.id, "verify");
  if (!job || job.status !== "running") {
    const jobId = await createJob(env, {
      id: crypto.randomUUID(),
      userId,
      backupId: backupRow.id,
      type: "verify",
      total: manifest.files?.length ?? 0,
      stage: "verifying",
    });
    job = await getJob(env, userId, jobId);
  }

  const checkpoint = parseJson(job.checkpoint_json, {}) || {};
  let index = Number(checkpoint.verifyIndex || 0);

  const dataCheck = await verifyFileObject(env, manifest.dataObjectKey, {
    sizeBytes: manifest.dataSize,
    sha256: manifest.dataChecksum,
  });
  if (!dataCheck.ok) {
    await updateBackup(env, userId, backupRow.id, {
      verifiedAt: null,
      errorMessage: "data.json 校验失败，备份已失效",
    });
    await updateJob(env, userId, job.id, { status: "failed", errorCode: "DATA_CHECKSUM_FAILED", errorMessage: dataCheck.error });
    throw new ApiError("VERIFY_FAILED", "备份数据校验失败", 409);
  }

  const files = manifest.files || [];
  while (index < files.length) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const check = await verifyFileObject(env, files[index].objectKey, {
      sizeBytes: files[index].sizeBytes,
      sha256: files[index].sha256,
    });
    if (!check.ok) {
      await updateBackup(env, userId, backupRow.id, {
        verifiedAt: null,
        errorMessage: `文件 ${files[index].id} 校验失败，备份已失效`,
      });
      await updateJob(env, userId, job.id, {
        status: "failed",
        errorCode: "FILE_CHECKSUM_FAILED",
        errorMessage: `${files[index].id}: ${check.error}`,
      });
      throw new ApiError("VERIFY_FAILED", "备份文件校验失败", 409);
    }
    index += 1;
    await updateJob(env, userId, job.id, {
      processed: index,
      total: files.length,
      progress: files.length ? Math.round((index / files.length) * 100) : 100,
      checkpoint: { verifyIndex: index },
    });
  }

  const complete = index >= files.length;
  if (complete) {
    await updateBackup(env, userId, backupRow.id, { verifiedAt: Date.now(), errorMessage: null });
    await updateJob(env, userId, job.id, { status: "completed", stage: "completed", progress: 100, completedAt: Date.now() });
  }

  return {
    complete,
    verifiedFiles: index,
    totalFiles: files.length,
    checksum: manifest.dataChecksum,
    job: mapJob(await getJob(env, userId, job.id)),
  };
}

/* ------------------------------------------------------------------ */
/* 重命名 / 删除 / 下载                                                */
/* ------------------------------------------------------------------ */

async function renameHandler(env, request, userId, backupRow) {
  const body = await readJson(request, 4096);
  const name = sanitizeName(body?.name);
  if (!name) throw new ApiError("INVALID_NAME", "备份名称需为 1–60 个可见字符", 400);
  await updateBackup(env, userId, backupRow.id, { backupName: name });
  return ok({ backup: mapBackup(await getBackup(env, userId, backupRow.id)) });
}

async function deleteHandler(env, request, userId, backupRow) {
  const body = await readJson(request, 4096);
  if (body?.confirm !== "DELETE") {
    throw new ApiError("CONFIRM_REQUIRED", "请输入 DELETE 以确认删除这个恢复点", 400);
  }
  if (backupRow.status === "collecting" || backupRow.status === "uploading" || backupRow.status === "verifying") {
    throw new ApiError("BACKUP_RUNNING", "备份正在执行，不能删除", 409);
  }

  const keys = backupKeys(userId, backupRow.id);
  await deleteBackupPrefix(env, keys.prefix);
  await markBackupDeleted(env, userId, backupRow.id);
  await purgeBackupRows(env, userId, backupRow.id);

  return ok({
    deleted: true,
    note: "只删除了历史备份对象，实时文件、笔记与任务不受影响。",
  });
}

async function downloadHandler(env, userId, backupRow, url) {
  if (backupRow.status !== "completed") throw new ApiError("NOT_READY", "备份尚未完成", 409);

  const format = url.searchParams.get("format") === "zip" ? "zip" : "json";

  // 2.0：先按库里的 SHA-256 校验原始字节，再决定是否给用户下载。
  const manifestCheck = await readJsonObjectVerified(
    env,
    backupRow.manifest_object_key,
    backupRow.checksum_sha256,
  );
  if (!manifestCheck.ok) {
    throw new ApiError(
      "BACKUP_CORRUPTED",
      manifestCheck.reason === "MISSING_OBJECT"
        ? "备份清单对象已丢失，无法下载"
        : "备份清单校验失败（内容与记录的 SHA-256 不一致），这份备份可能已损坏",
      409,
    );
  }
  const manifest = manifestCheck.value;
  const data = await loadData(env, backupRow);
  if (!manifest || !data) throw new ApiError("BACKUP_BROKEN", "备份内容缺失", 409);

  // 数据对象只有 JSON 下载会完整读进内存，因此在这里做一次真实校验；
  // ZIP 是流式输出，完整校验会在写出响应头之后才能完成，改为在 checksums.txt 里给出摘要。
  if (format === "json") {
    const dataCheck = await readJsonObjectVerified(env, manifest.dataObjectKey, manifest.dataChecksum);
    if (!dataCheck.ok) {
      throw new ApiError(
        "BACKUP_CORRUPTED",
        dataCheck.reason === "MISSING_OBJECT"
          ? "备份数据对象已丢失，无法下载"
          : "备份数据校验失败（内容与记录的 SHA-256 不一致），这份备份可能已损坏",
        409,
      );
    }
  }

  const utfName = (backupRow.backup_name || "guandao-backup").replace(/[^\w\u4e00-\u9fa5.-]+/g, "-");
  const asciiName = `guandao-backup-${backupRow.id.slice(0, 8)}`;

  if (format === "json") {
    const body = JSON.stringify(
      {
        manifest,
        data,
        checksum: { algorithm: "sha256", manifest: backupRow.checksum_sha256, data: manifest.dataChecksum },
      },
      null,
      2,
    );
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${asciiName}.json"; filename*=UTF-8''${encodeURIComponent(utfName)}.json`,
        "cache-control": "no-store",
      },
    });
  }

  const entries = [
    {
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    },
    {
      name: "data.json",
      open: async () => (await env.FILES.get(manifest.dataObjectKey)).body,
    },
    ...(manifest.files || []).map((file) => ({
      name: `files/${file.id}-${String(file.name || "file").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")}`,
      open: async () => (await env.FILES.get(file.objectKey)).body,
    })),
    {
      name: "checksums.txt",
      bytes: new TextEncoder().encode(
        [
          `manifest_sha256=${backupRow.checksum_sha256}`,
          `data_sha256=${manifest.dataChecksum}`,
          ...(manifest.files || []).map((file) => `${file.id}=${file.sha256}`),
          "",
        ].join("\n"),
      ),
    },
  ];

  return new Response(createZipStream(entries), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(utfName)}.zip`,
      "cache-control": "no-store",
    },
  });
}

async function exportHandler(env, userId, backupRow, url) {
  if (backupRow.status !== "completed") throw new ApiError("NOT_READY", "备份尚未完成", 409);
  const domain = url.searchParams.get("domain");
  const data = await loadData(env, backupRow);
  if (!data) throw new ApiError("BACKUP_BROKEN", "备份内容缺失", 409);

  if (domain) {
    if (!ALL_DOMAINS.has(domain)) throw new ApiError("INVALID_DOMAIN", "数据类型不合法", 400);
    const value = data.domains?.[domain];
    if (!value || value.present === false) {
      throw new ApiError("DOMAIN_NOT_IN_BACKUP", "该备份不包含这项数据", 404);
    }
    return json(
      {
        schemaVersion: BACKUP_SCHEMA,
        backupId: backupRow.id,
        domain,
        exportedAt: Date.now(),
        data: value,
      },
      {
        headers: {
          "content-disposition": `attachment; filename="${backupRow.id}-${domain}.json"`,
        },
      },
    );
  }

  return downloadHandler(env, userId, backupRow, url);
}

/* ------------------------------------------------------------------ */
/* 恢复预览                                                            */
/* ------------------------------------------------------------------ */

async function previewHandler(env, request, userId, backupRow) {
  requireRestorable(backupRow);
  await assertBackupIntegrity(env, backupRow);
  const body = await readJson(request, 64 * 1024);
  const domains = normalizeDomains(body?.domains, backupRow);
  const mode = RESTORE_MODES.has(body?.mode) ? body.mode : "copy";
  const data = await loadData(env, backupRow);
  const manifest = await loadManifest(env, backupRow);
  if (!data || !manifest) throw new ApiError("BACKUP_BROKEN", "备份内容缺失", 409);

  const driveStats = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM files WHERE user_id = ? AND status = 'ready' AND deleted_at IS NULL",
  )
    .bind(userId)
    .first();

  const items = domains.map((domain) => {
    const value = data.domains?.[domain];
    let backupCount = 0;
    if (domain === "drive") backupCount = value?.files?.length ?? 0;
    else if (domain === "notes") backupCount = value?.data?.notes?.length ?? 0;
    else if (domain === "tasks") backupCount = value?.data?.tasks?.length ?? 0;
    else if (domain === "calendar") backupCount = value?.data?.events?.length ?? 0;
    else backupCount = Object.keys(value?.keys || {}).length;
    return {
      domain,
      available: Boolean(value && value.present !== false),
      backupCount,
      currentCount: domain === "drive" ? Number(driveStats?.total || 0) : null,
      modeLimited: (domain === "desktop" || domain === "workspace") && mode !== "replace",
    };
  });

  const warnings = [];
  if (mode === "replace") warnings.push("Replace 会先备份当前数据，再把选中类型替换为备份内容。未选中的类型不受影响。");
  if (mode === "merge") {
    warnings.push(
      "Merge 只补缺失内容，不覆盖现有数据：云盘文件按 SHA-256 跳过已存在的内容；笔记 / 任务 / 日程同名同 ID 时保留较新的一侧。",
    );
  }
  if (mode === "copy") warnings.push("Copy 会生成新的记录 ID，不影响当前数据。");
  if (domains.includes("desktop") || domains.includes("workspace")) {
    warnings.push("桌面与工作空间只能整体替换，不能按单条记录合并。");
  }
  warnings.push("恢复前必须创建保护性备份；保护性备份不完整时服务端拒绝恢复。");

  return ok({
    backup: mapBackup(backupRow),
    mode,
    domains: items,
    totals: {
      backupBytes: Number(backupRow.size_bytes || 0),
      fileCount: Number(backupRow.file_count || 0),
      localPayloadBytes: estimateLocalBytes(data, domains),
    },
    requirements: {
      protectiveBackup: true,
      confirm: true,
      note: "保护性备份必须属于同一账号、状态 completed，且在 1 小时内创建。",
    },
    warnings,
  });
}

/* ------------------------------------------------------------------ */
/* 执行恢复                                                            */
/* ------------------------------------------------------------------ */

async function restoreHandler(env, request, userId, backupRow) {
  requireRestorable(backupRow);
  await assertBackupIntegrity(env, backupRow);
  const body = await readJson(request, 128 * 1024);
  const domains = normalizeDomains(body?.domains, backupRow);
  const mode = RESTORE_MODES.has(body?.mode) ? body.mode : null;
  if (!mode) throw new ApiError("INVALID_MODE", "恢复模式不合法", 400);
  if (body?.confirm !== true) throw new ApiError("CONFIRM_REQUIRED", "恢复前必须明确确认", 400);

  const protective = body?.protectiveBackupId
    ? await getBackup(env, userId, String(body.protectiveBackupId))
    : null;
  if (!protective || protective.status !== "completed" || !protective.verified_at) {
    throw new ApiError("PROTECTIVE_BACKUP_REQUIRED", "请先创建并完成一次保护性备份", 409);
  }
  if (Date.now() - Number(protective.created_at) > 60 * 60 * 1000) {
    throw new ApiError("PROTECTIVE_BACKUP_STALE", "保护性备份已超过 1 小时，请重新创建", 409);
  }
  if (protective.id === backupRow.id) {
    throw new ApiError("PROTECTIVE_BACKUP_REQUIRED", "保护性备份不能是待恢复的同一个备份", 409);
  }
  const protectiveDomains = parseJson(protective.domains_json, []);
  const missingProtection = domains.filter((domain) => !protectiveDomains.includes(domain));
  if (missingProtection.length) {
    throw new ApiError(
      "PROTECTIVE_BACKUP_INCOMPLETE",
      `保护性备份未覆盖：${missingProtection.join(" / ")}`,
      409,
    );
  }

  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 80) : null;
  const existing = await findRestoreByIdempotency(env, userId, idempotencyKey);
  if (existing) {
    const restore = await getRestore(env, userId, existing.id);
    return ok(await restoreResult(env, userId, restore));
  }

  const restoreId = crypto.randomUUID();
  await createRestore(env, {
    id: restoreId,
    userId,
    backupId: backupRow.id,
    mode,
    domains,
    protectiveBackupId: protective.id,
    idempotencyKey,
  });

  const data = await loadData(env, backupRow);
  if (!data) throw new ApiError("BACKUP_BROKEN", "备份内容缺失", 409);

  const plan = buildRestorePlan(restoreId, domains, data);
  const jobId = crypto.randomUUID();
  await createJob(env, {
    id: jobId,
    userId,
    backupId: restoreId,
    type: "restore",
    total: plan.files.length,
    stage: "restoring_files",
  });
  await updateJob(env, userId, jobId, { checkpoint: { plan } });

  const restore = await getRestore(env, userId, restoreId);
  return ok(await runRestore(env, userId, restore));
}

function buildRestorePlan(restoreId, domains, data) {
  const folders = [];
  const folderMap = {};
  if (domains.includes("drive")) {
    for (const folder of data.domains?.drive?.folders ?? []) {
      folderMap[folder.id] = crypto.randomUUID();
      folders.push({ ...folder, newId: folderMap[folder.id] });
    }
  }

  const files = [];
  if (domains.includes("drive")) {
    for (const file of data.domains?.drive?.files ?? []) {
      files.push({
        ...file,
        newId: crypto.randomUUID(),
        newParentId: file.parentId ? folderMap[file.parentId] || null : null,
      });
    }
  }

  return {
    restoreId,
    domains,
    folders,
    folderMap,
    files,
    metadataApplied: false,
  };
}

function buildLocalPayload(data, domains) {
  const out = {};
  for (const domain of domains) {
    if (!LOCAL_DOMAINS.has(domain)) continue;
    const value = data.domains?.[domain];
    if (value?.present === false) continue;
    out[domain] = domain === "desktop" || domain === "workspace" ? value.keys : value.data;
  }
  return out;
}

async function runRestore(env, userId, restoreRow) {
  if (!restoreRow) throw new ApiError("NOT_FOUND", "恢复任务不存在", 404);
  if (restoreRow.status === "completed" || restoreRow.status === "awaiting_client") {
    return restoreResult(env, userId, restoreRow);
  }

  const job = await getLatestJob(env, userId, restoreRow.id, "restore");
  if (!job) throw new ApiError("RESTORE_JOB_MISSING", "恢复任务状态丢失", 409);
  const checkpoint = parseJson(job.checkpoint_json, {});
  const plan = checkpoint?.plan;
  if (!plan) throw new ApiError("RESTORE_PLAN_MISSING", "恢复计划缺失", 409);

  const backupRow = await getBackup(env, userId, restoreRow.backup_id);
  if (!backupRow) throw new ApiError("NOT_FOUND", "备份不存在", 404);

  const started = Date.now();
  const items = await listRestoreFiles(env, userId, restoreRow.id);
  const done = new Set(items.filter((item) => item.status === "verified" || item.status === "copied").map((item) => item.file_id));

  for (const file of plan.files) {
    if (done.has(file.id)) continue;
    if (done.size >= plan.files.length) break;
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (done.size > 0 && done.size % COPY_BATCH === 0 && Date.now() - started > TIME_BUDGET_MS / 2) break;

    const sourceKey = `users/${userId}/backups/${restoreRow.backup_id}/files/${file.id}`;
    const liveKey = `users/${userId}/files/${file.newId}`;
    const object = await env.FILES.get(sourceKey);
    if (!object) {
      await upsertRestoreFile(env, {
        userId,
        restoreId: restoreRow.id,
        fileId: file.id,
        newFileId: file.newId,
        status: "failed",
        error: "BACKUP_OBJECT_MISSING",
      });
      await updateRestore(env, userId, restoreRow.id, {
        status: "failed",
        errorMessage: `备份文件缺失：${file.id}`,
      });
      throw new ApiError("BACKUP_BROKEN", "备份文件缺失，恢复已中止", 409);
    }

    const [hashBranch, writeBranch] = object.body.tee();
    const hashPromise = hashStream(hashBranch);
    await env.FILES.put(liveKey, writeBranch, { httpMetadata: { contentType: file.mimeType } });
    const digest = await hashPromise;

    if (digest.size !== Number(file.sizeBytes) || (file.sha256 && digest.sha256 !== file.sha256)) {
      await env.FILES.delete(liveKey).catch(() => undefined);
      await updateRestore(env, userId, restoreRow.id, {
        status: "failed",
        errorMessage: `恢复文件校验失败：${file.id}`,
      });
      throw new ApiError("RESTORE_VERIFY_FAILED", "恢复文件校验失败，已中止", 409);
    }

    await upsertRestoreFile(env, {
      userId,
      restoreId: restoreRow.id,
      fileId: file.id,
      newFileId: file.newId,
      status: "verified",
    });
    done.add(file.id);

    await updateJob(env, userId, job.id, {
      processed: done.size,
      total: plan.files.length,
      progress: plan.files.length ? Math.round((done.size / plan.files.length) * 80) : 80,
    });
  }

  if (done.size < plan.files.length) {
    return restoreResult(env, userId, await getRestore(env, userId, restoreRow.id), { partial: true });
  }

  if (!plan.metadataApplied) {
    const applied = await applyRestoreMetadata(env, userId, restoreRow, plan);
    plan.metadataApplied = true;
    plan.skippedFiles = applied?.skippedFiles ?? 0;
    await updateJob(env, userId, job.id, { checkpoint: { plan }, progress: 95, stage: "applying_metadata" });
  }

  const hasLocalData = await loadData(env, backupRow);
  const localPayload = buildLocalPayload(hasLocalData ?? { domains: {} }, plan.domains);
  const hasLocal = Object.keys(localPayload).length > 0;
  const stats = {
    filesRestored: plan.files.length - (plan.skippedFiles ?? 0),
    filesSkipped: plan.skippedFiles ?? 0,
    foldersRestored: plan.folders.length,
    localDomains: Object.keys(localPayload),
    mode: restoreRow.mode,
  };

  await updateRestore(env, userId, restoreRow.id, {
    status: hasLocal ? "awaiting_client" : "completed",
    stats,
    completedAt: hasLocal ? null : Date.now(),
  });
  await updateJob(env, userId, job.id, {
    status: "completed",
    stage: hasLocal ? "awaiting_client" : "completed",
    progress: 100,
    completedAt: Date.now(),
  });

  const updated = await getRestore(env, userId, restoreRow.id);
  return restoreResult(env, userId, updated, { payload: localPayload });
}

async function applyRestoreMetadata(env, userId, restoreRow, plan) {
  const now = Date.now();

  if (restoreRow.mode === "replace" && plan.files.length + plan.folders.length > 0) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE files SET status = 'trash', deleted_at = ?, trash_group = ?, updated_at = ? WHERE user_id = ? AND status = 'ready'",
      ).bind(now, restoreRow.id, now, userId),
      env.DB.prepare(
        "UPDATE folders SET deleted_at = ?, trash_group = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL",
      ).bind(now, restoreRow.id, now, userId),
    ]);
  }

  // 2.0：Merge 不再「所有文件都复制一份」。按 SHA-256 跳过已存在的内容，
  // 只补缺失的文件；不覆盖、不重复占空间。文件夹仍按备份结构重建（空目录不算数据丢失）。
  let skippedFiles = 0;
  let mergeFiles = plan.files;
  if (restoreRow.mode === "merge" && plan.files.length) {
    const existing = await env.DB.prepare(
      "SELECT sha256 FROM files WHERE user_id = ? AND status = 'ready' AND sha256 IS NOT NULL",
    )
      .bind(userId)
      .all();
    const hashes = new Set((existing.results || []).map((row) => row.sha256));
    mergeFiles = plan.files.filter((file) => {
      const duplicate = Boolean(file.sha256) && hashes.has(file.sha256);
      if (duplicate) skippedFiles += 1;
      return !duplicate;
    });
  }

  for (let i = 0; i < plan.folders.length; i += 40) {
    const chunk = plan.folders.slice(i, i + 40);
    await env.DB.batch(
      chunk.map((folder) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO folders
             (id, user_id, parent_id, name, is_favorite, trash_group, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        ).bind(
          folder.newId,
          userId,
          folder.parentId ? plan.folderMap[folder.parentId] || null : null,
          folder.name,
          folder.isFavorite ? 1 : 0,
          folder.createdAt || now,
          folder.updatedAt || now,
        ),
      ),
    );
  }

  for (let i = 0; i < mergeFiles.length; i += 40) {
    const chunk = mergeFiles.slice(i, i + 40);
    await env.DB.batch(
      chunk.map((file) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO files
             (id, user_id, r2_key, name, mime_type, size_bytes, sha256, deleted_at, created_at,
              parent_id, display_name, extension, etag, status, is_favorite, updated_at, trash_group)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'ready', ?, ?, NULL)`,
        ).bind(
          file.newId,
          userId,
          `users/${userId}/files/${file.newId}`,
          file.name,
          file.mimeType || "application/octet-stream",
          Number(file.sizeBytes || 0),
          file.sha256 || null,
          file.createdAt || now,
          file.newParentId,
          file.name,
          file.extension || null,
          file.isFavorite ? 1 : 0,
          file.updatedAt || now,
        ),
      ),
    );
  }

  return { skippedFiles };
}

async function restoreResult(env, userId, restoreRow, extra = {}) {
  if (!restoreRow) throw new ApiError("NOT_FOUND", "恢复任务不存在", 404);
  const job = await getLatestJob(env, userId, restoreRow.id, "restore");
  const stats = parseJson(restoreRow.stats_json, null);
  let payload = extra.payload ?? null;

  if (!payload && (restoreRow.status === "completed" || restoreRow.status === "awaiting_client")) {
    const backupRow = await getBackup(env, userId, restoreRow.backup_id);
    if (backupRow) {
      const data = await loadData(env, backupRow);
      if (data) payload = buildLocalPayload(data, parseJson(restoreRow.domains_json, []));
    }
  }

  return {
    restore: {
      id: restoreRow.id,
      backupId: restoreRow.backup_id,
      mode: restoreRow.mode,
      domains: parseJson(restoreRow.domains_json, []),
      status: restoreRow.status,
      stats,
      errorMessage: restoreRow.error_message,
      createdAt: Number(restoreRow.created_at || 0),
      completedAt: restoreRow.completed_at ? Number(restoreRow.completed_at) : null,
    },
    job: mapJob(job),
    localSnapshot: payload,
    ...extra,
  };
}

async function restoreAckHandler(env, request, userId, restoreId) {
  const row = await getRestore(env, userId, restoreId);
  if (!row) throw new ApiError("NOT_FOUND", "恢复任务不存在", 404);
  const body = await readJson(request, 64 * 1024);
  const applied = body?.applied && typeof body.applied === "object" ? body.applied : {};

  const stats = { ...(parseJson(row.stats_json, null) || {}), applied, acknowledgedAt: Date.now() };
  await updateRestore(env, userId, restoreId, {
    status: "completed",
    stats,
    completedAt: Date.now(),
  });

  return ok(await restoreResult(env, userId, await getRestore(env, userId, restoreId)));
}

function requireRestorable(backupRow) {
  if (backupRow.status !== "completed" || !backupRow.verified_at) {
    throw new ApiError("BACKUP_NOT_VERIFIED", "备份未完成完整性校验，禁止恢复", 409);
  }
}

/** 恢复前重新校验 manifest 与 data.json，防止「校验后被篡改」。 */
async function assertBackupIntegrity(env, backupRow) {
  const manifestObject = await env.FILES.get(backupRow.manifest_object_key);
  if (!manifestObject) throw new ApiError("BACKUP_BROKEN", "备份清单缺失，禁止恢复", 409);

  const bytes = new Uint8Array(await manifestObject.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (backupRow.checksum_sha256 && digest !== backupRow.checksum_sha256) {
    throw new ApiError("BACKUP_TAMPERED", "备份清单校验失败（可能已被篡改），禁止恢复", 409);
  }

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("BACKUP_BROKEN", "备份清单格式损坏，禁止恢复", 409);
  }

  const dataCheck = await verifyFileObject(env, manifest.dataObjectKey, {
    sizeBytes: manifest.dataSize,
    sha256: manifest.dataChecksum,
  });
  if (!dataCheck.ok) {
    throw new ApiError("BACKUP_TAMPERED", "备份数据校验失败（可能已被篡改），禁止恢复", 409);
  }
}

function estimateLocalBytes(data, domains) {
  let total = 0;
  for (const domain of domains) {
    if (!LOCAL_DOMAINS.has(domain)) continue;
    const value = data.domains?.[domain];
    if (!value) continue;
    total += new TextEncoder().encode(JSON.stringify(domain === "desktop" || domain === "workspace" ? value.keys : value.data))
      .byteLength;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* 设置 / 自动备份                                                     */
/* ------------------------------------------------------------------ */

async function settingsHandler(env, request, userId) {
  const body = await readJson(request, 8192);
  const frequency = ["off", "daily", "weekly"].includes(body?.frequency) ? body.frequency : "off";
  const retentionDaily = clampInt(body?.retentionDaily, 1, 30, 7);
  const retentionWeekly = clampInt(body?.retentionWeekly, 1, 16, 4);
  const scope = Array.isArray(body?.scope)
    ? body.scope.filter((item) => item === "drive")
    : ["drive"];

  const settings = {
    autoEnabled: frequency !== "off" && body?.autoEnabled !== false,
    frequency,
    scope: scope.length ? scope : ["drive"],
    retentionDaily,
    retentionWeekly,
  };

  await saveSettings(env, userId, settings);
  return ok({
    settings: await getSettings(env, userId),
    cron: cronInfo(env),
    note: "自动备份由 Cloudflare Cron 触发，只覆盖服务端 Cloud Drive；本地笔记/任务/日历需在设备上手动备份。",
  });
}

function cronInfo(env) {
  const configured = env?.BACKUP_CRON_ENABLED === "true" || env?.BACKUP_CRON_ENABLED === true;
  return {
    configured,
    // 2.0 修正：触发器实际是 */15（见 wrangler.jsonc），这里不再声称「每日 18:00」
    schedule: "*/15 * * * *",
    timezone: "UTC",
    description: "每 15 分钟检查一次；按 backup_settings 的 daily / weekly 到期判断真正执行，重复触发不会重复备份",
    note: configured
      ? "Cron 已部署。自动备份只包含云端文件与元数据；浏览器本地数据必须由设备上传。"
      : "Cron 未启用：当前只能手动备份。",
  };
}

/** Cron 入口与手动触发共用。 */
export async function runScheduledBackups(env) {
  if (!(env?.BACKUP_CRON_ENABLED === "true" || env?.BACKUP_CRON_ENABLED === true)) {
    return { skipped: true, reason: "cron_disabled" };
  }

  const users = await listAutoUsers(env);
  const results = [];

  for (const row of users) {
    const userId = row.user_id;
    const settings = await getSettings(env, userId);
    if (!settings.autoEnabled || settings.frequency === "off") continue;

    const interval = settings.frequency === "weekly" ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
    if (settings.lastAutoAt && Date.now() - settings.lastAutoAt < interval) continue;

    let backupId = null;
    try {
      const activeId = await hasActiveBackup(env, userId);
      if (activeId) {
        const active = await getBackup(env, userId, activeId);
        // 只续跑自动备份；手动任务由用户自己继续，避免 Cron 改动用户操作。
        if (!active || active.backup_type !== "auto") {
          results.push({ userId, status: "skipped_active" });
          continue;
        }

        let resumed = active;
        let guard = 0;
        while (resumed.status !== "completed" && resumed.status !== "failed" && guard < 8) {
          await runBackup(env, userId, resumed, { batch: 40, budget: 60_000 });
          resumed = await getBackup(env, userId, active.id);
          guard += 1;
        }
        await markAutoRun(env, userId, {
          at: Date.now(),
          status: resumed.status,
          backupId: active.id,
        });
        if (resumed.status === "completed") await applyRetention(env, userId, settings);
        results.push({ userId, status: resumed.status, backupId: active.id, resumed: true });
        continue;
      }

      if ((await countBackups(env, userId)) >= MAX_BACKUPS_PER_USER) {
        results.push({ userId, status: "skipped_limit" });
        continue;
      }

      backupId = crypto.randomUUID();
      const keys = backupKeys(userId, backupId);
      const snapshotAt = Date.now();
      const drive = await collectDrive(env, userId);
      const data = {
        schemaVersion: BACKUP_SCHEMA,
        backupId,
        userId,
        createdAt: snapshotAt,
        snapshotAt,
        scope: "drive",
        domains: {
          drive: {
            present: true,
            files: drive.files.map(({ liveKey, ...rest }) => rest),
            folders: drive.folders,
          },
        },
        source: { dataOrigin: "server", note: "Cron 自动备份只覆盖服务端 Cloud Drive" },
      };
      const dataMeta = await writeJsonObject(env, keys.data, data);
      await createBackup(env, {
        id: backupId,
        userId,
        name: `Auto · ${new Date(snapshotAt).toISOString().slice(0, 10)}`,
        type: "auto",
        scope: "drive",
        domains: ["drive"],
        snapshotAt,
        manifestKey: keys.manifest,
      });
      await updateBackup(env, userId, backupId, { dataKey: dataMeta.key });

      let backupRow = await getBackup(env, userId, backupId);
      let guard = 0;
      while (backupRow.status !== "completed" && backupRow.status !== "failed" && guard < 8) {
        await runBackup(env, userId, backupRow, { batch: 40, budget: 60_000 });
        backupRow = await getBackup(env, userId, backupId);
        guard += 1;
      }

      await markAutoRun(env, userId, {
        at: Date.now(),
        status: backupRow.status,
        backupId,
      });

      if (backupRow.status === "completed") {
        await applyRetention(env, userId, settings);
      }
      results.push({ userId, status: backupRow.status, backupId });
    } catch (error) {
      await markAutoRun(env, userId, { at: Date.now(), status: "failed", backupId });
      results.push({ userId, status: "failed", error: String(error?.message ?? error).slice(0, 160) });
    }
  }

  return { ran: results.length, results };
}

async function applyRetention(env, userId, settings) {
  const retention = settings.frequency === "weekly" ? settings.retentionWeekly : settings.retentionDaily;
  const expired = await listExpiredAutoBackups(env, userId, retention);
  if (!expired.length) return;

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM backups
      WHERE user_id = ? AND deleted_at IS NULL AND backup_type = 'auto'
        AND status = 'completed' AND verified_at IS NOT NULL`,
  )
    .bind(userId)
    .first();

  if (Number(remaining?.total || 0) <= retention) return;

  for (const row of expired) {
    if (Number(remaining?.total || 0) <= 1) break;
    await markBackupDeleted(env, userId, row.id);
    await deleteBackupPrefix(env, `users/${userId}/backups/${row.id}`);
    await purgeBackupRows(env, userId, row.id);
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function normalizeDomains(value, backupRow = null) {
  const list = Array.isArray(value) ? value.filter((item) => ALL_DOMAINS.has(item)) : [];
  const unique = [...new Set(list)];
  if (backupRow) {
    const available = new Set(parseJson(backupRow.domains_json, []));
    for (const domain of unique) {
      if (!available.has(domain)) {
        throw new ApiError("DOMAIN_NOT_IN_BACKUP", `该备份不包含 ${domain}`, 400);
      }
    }
  }
  return unique;
}

function sanitizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 60) return null;
  return name;
}

function defaultName(type) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return type === "protective" ? `保护性备份 · ${stamp}` : `手动备份 · ${stamp}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}


