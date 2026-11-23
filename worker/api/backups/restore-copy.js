// 2.0.11：恢复阶段的「复制文件」单独成模块，只为两件事：
// 1. 复制前先按 SHA-256 判断内容是否已存在；merge 恢复不应该把重复内容写进 R2。
//    2.0.10 及以前是「先全部 put，再在元数据阶段按哈希丢弃」，被丢弃的对象留在
//    R2 里没人引用，storageStats/usage() 也统计不到，属于永久泄漏。
// 2. 复制与校验（大小、哈希）必须原子成对：写坏了要删掉刚写的对象，不能留下半份数据。
import { ApiError } from "../http.js";
import { hashStream } from "./crypto.js";
import { listRestoreFiles, updateJob, upsertRestoreFile } from "./store.js";

const COPY_BATCH = 5;
const TIME_BUDGET_MS = 18_000;

/**
 * 纯函数：把计划里的文件分成「需要复制」与「内容已存在」。
 * existingSha256 为空集合时全部复制——没有可用哈希就无从判断重复，宁可多写也不能漏数据。
 */
export function classifyRestoreFiles(files, existingSha256) {
  const copies = [];
  const skips = [];
  if (!existingSha256 || existingSha256.size === 0) {
    return { copies: files.slice(), skips };
  }
  for (const file of files) {
    if (file.sha256 && existingSha256.has(file.sha256)) skips.push(file);
    else copies.push(file);
  }
  return { copies, skips };
}

/** 当前账号下仍可用（ready）且带哈希的文件内容集合，用于 merge 去重。 */
export async function loadReadySha256(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT sha256 FROM files WHERE user_id = ? AND status = 'ready' AND sha256 IS NOT NULL",
  )
    .bind(userId)
    .all();
  return new Set((rows.results || []).map((row) => row.sha256));
}

/** 复制单个备份对象到云盘的 live key，并校验大小与哈希；失败时删除刚写入的对象。 */
export async function copyRestoreObject(env, { userId, backupId, file }) {
  const sourceKey = `users/${userId}/backups/${backupId}/files/${file.id}`;
  const liveKey = `users/${userId}/files/${file.newId}`;
  const object = await env.FILES.get(sourceKey);
  if (!object) {
    throw new ApiError("BACKUP_BROKEN", "备份文件缺失，恢复已中止", 409);
  }
  const [hashBranch, writeBranch] = object.body.tee();
  const hashPromise = hashStream(hashBranch);
  await env.FILES.put(liveKey, writeBranch, { httpMetadata: { contentType: file.mimeType } });
  const digest = await hashPromise;
  if (digest.size !== Number(file.sizeBytes) || (file.sha256 && digest.sha256 !== file.sha256)) {
    await env.FILES.delete(liveKey).catch(() => undefined);
    throw new ApiError("RESTORE_VERIFY_FAILED", "恢复文件校验失败，已中止", 409);
  }
  return { digest, liveKey };
}

/**
 * 执行恢复的文件复制阶段（可重入：已 verified/copied 的文件跳过）。
 * 返回 { done, skippedIds }；done 是已完成文件 id 集合，调用方据此判断是否继续元数据阶段。
 * skippedIds 会写回 plan，保证「元数据阶段」与「复制阶段」对哪些文件被去重判断一致。
 */
export async function runRestoreCopy(env, { userId, restoreId, backupId, jobId, mode, plan }) {
  const existing = await listRestoreFiles(env, userId, restoreId);
  const done = new Set(
    existing.filter((item) => item.status === "verified" || item.status === "copied").map((item) => item.file_id),
  );
  const skippedIds = new Set(plan.skippedIds ?? []);
  const readySha = mode === "merge" ? await loadReadySha256(env, userId) : null;
  const started = Date.now();

  for (const file of plan.files) {
    if (done.has(file.id)) continue;
    if (done.size >= plan.files.length) break;
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (done.size > 0 && done.size % COPY_BATCH === 0 && Date.now() - started > TIME_BUDGET_MS / 2) break;

    // merge 模式下内容已在云盘里的文件不读不写 R2，只登记「已用」。
    if (readySha && file.sha256 && readySha.has(file.sha256)) {
      await upsertRestoreFile(env, {
        userId,
        restoreId,
        fileId: file.id,
        newFileId: file.newId,
        status: "copied",
        error: "DUPLICATE_CONTENT",
      });
      skippedIds.add(file.id);
      done.add(file.id);
      await updateJob(env, userId, jobId, {
        processed: done.size,
        total: plan.files.length,
        progress: plan.files.length ? Math.round((done.size / plan.files.length) * 80) : 80,
      });
      continue;
    }

    let copied;
    try {
      copied = await copyRestoreObject(env, { userId, backupId, file });
    } catch (error) {
      await upsertRestoreFile(env, {
        userId,
        restoreId,
        fileId: file.id,
        newFileId: file.newId,
        status: "failed",
        error: error?.code === "BACKUP_BROKEN" ? "BACKUP_OBJECT_MISSING" : "RESTORE_VERIFY_FAILED",
      });
      await updateRestoreFailed(env, userId, restoreId, file.id, error);
      throw error;
    }

    await upsertRestoreFile(env, {
      userId,
      restoreId,
      fileId: file.id,
      newFileId: file.newId,
      status: "verified",
    });
    // 同一个备份里也可能有重复内容；把刚复制成功的内容并入集合，后续只落一份。
    if (readySha && copied.digest.sha256) readySha.add(copied.digest.sha256);
    done.add(file.id);

    await updateJob(env, userId, jobId, {
      processed: done.size,
      total: plan.files.length,
      progress: plan.files.length ? Math.round((done.size / plan.files.length) * 80) : 80,
    });
  }

  plan.skippedIds = [...skippedIds];
  return { done, skippedIds };
}

async function updateRestoreFailed(env, userId, restoreId, fileId, error) {
  const { updateRestore } = await import("./store.js");
  const message =
    error?.code === "BACKUP_BROKEN" ? `备份文件缺失：${fileId}` : `恢复文件校验失败：${fileId}`;
  await updateRestore(env, userId, restoreId, { status: "failed", errorMessage: message });
}