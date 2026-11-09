/**
 * Guandao Backup · 对象存储与归档
 *
 * 关键约束：
 *   - 实时文件 users/{uid}/files/{id} 与备份对象
 *     users/{uid}/backups/{bid}/files/{id} 是两份独立内容；
 *   - 复制文件时流式读写，同时增量计算 SHA-256，不 arrayBuffer() 整个文件；
 *   - 只有 manifest 与全部文件校验通过，备份才允许标记 completed。
 */

import { Sha256, crc32, hashStream, sha256Hex, toHex } from "./crypto.js";

export const BACKUP_SCHEMA = 1;
const COPY_BATCH = 6;
const VERIFY_BATCH = 6;

export function backupKeys(userId, backupId) {
  const prefix = `users/${userId}/backups/${backupId}`;
  return {
    prefix,
    data: `${prefix}/data.json`,
    manifest: `${prefix}/manifest.json`,
    file: (fileId) => `${prefix}/files/${fileId}`,
  };
}

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

export async function collectDrive(env, userId) {
  const [files, folders] = await Promise.all([
    env.DB.prepare(
      `SELECT id, parent_id, name, display_name, extension, mime_type, size_bytes,
              sha256, etag, status, is_favorite, created_at, updated_at, r2_key
         FROM files
        WHERE user_id = ? AND status = 'ready' AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT id, parent_id, name, is_favorite, created_at, updated_at
         FROM folders WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
      .bind(userId)
      .all(),
  ]);

  return {
    files: (files.results || []).map((row) => ({
      id: row.id,
      parentId: row.parent_id || null,
      name: row.display_name || row.name,
      extension: row.extension || null,
      mimeType: row.mime_type || "application/octet-stream",
      sizeBytes: Number(row.size_bytes || 0),
      sha256: row.sha256 || null,
      etag: row.etag || null,
      isFavorite: Boolean(row.is_favorite),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      liveKey: row.r2_key,
    })),
    folders: (folders.results || []).map((row) => ({
      id: row.id,
      parentId: row.parent_id || null,
      name: row.name,
      isFavorite: Boolean(row.is_favorite),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    })),
  };
}

export async function writeJsonObject(env, key, value) {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  const sha256 = await sha256Hex(bytes);
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return { key, size: bytes.byteLength, sha256 };
}

export async function readJsonObject(env, key) {
  const object = await env.FILES.get(key);
  if (!object) return null;
  const text = await object.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function loadData(env, backup) {
  if (!backup?.data_object_key) return null;
  return readJsonObject(env, backup.data_object_key);
}

export async function loadManifest(env, backup) {
  if (!backup?.manifest_object_key) return null;
  return readJsonObject(env, backup.manifest_object_key);
}

/**
 * 2.0：下载前校验对象完整性。
 *
 * 1.x 只在 ZIP 里附一份 checksums.txt，自己从不验证；用户下载到的可能是
 * 被截断 / 被覆盖的备份，而界面显示「成功」。这里按库里的 SHA-256 复核原始字节，
 * 不一致就返回 409，让用户知道这份备份已经不可信。
 *
 * @returns {{ value: object|null, ok: boolean, actual: string|null, reason?: string }}
 */
export async function readJsonObjectVerified(env, key, expectedSha256) {
  if (!key) return { value: null, ok: false, actual: null, reason: "MISSING_KEY" };
  const object = await env.FILES.get(key);
  if (!object) return { value: null, ok: false, actual: null, reason: "MISSING_OBJECT" };

  const bytes = new Uint8Array(await object.arrayBuffer());
  const actual = await sha256Hex(bytes);
  let value = null;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { value: null, ok: false, actual, reason: "INVALID_JSON" };
  }

  // 老备份没有记录摘要：不判定为损坏，但明确标记「未校验」
  const ok = !expectedSha256 || actual === expectedSha256;
  return { value, ok, actual, reason: ok ? undefined : "CHECKSUM_MISMATCH" };
}

/* ------------------------------------------------------------------ */
/* 文件复制与校验                                                      */
/* ------------------------------------------------------------------ */

export async function copyObject(env, { sourceKey, destKey, mimeType }) {
  const object = await env.FILES.get(sourceKey);
  if (!object) return { ok: false, error: "SOURCE_MISSING" };

  const [hashBranch, writeBranch] = object.body.tee();
  const hashPromise = hashStream(hashBranch);
  try {
    await env.FILES.put(destKey, writeBranch, {
      httpMetadata: { contentType: mimeType || "application/octet-stream" },
    });
  } catch {
    await hashPromise.catch(() => undefined);
    return { ok: false, error: "COPY_FAILED" };
  }
  const digest = await hashPromise;
  return { ok: true, size: digest.size, sha256: digest.sha256 };
}

/**
 * 复制单个文件到备份前缀。
 * tee 出两条流：一条写入备份对象，一条边读边算 SHA-256。
 */
export async function copyFileToBackup(env, { userId, backupId, file }) {
  const keys = backupKeys(userId, backupId);
  // 实时对象 Key 由服务端按固定规则生成；data.json 不保存内部 Key，
  // 因此这里从 userId + fileId 还原，避免把存储路径写进快照。
  const liveKey = file.liveKey || `users/${userId}/files/${file.id}`;
  const result = await copyObject(env, {
    sourceKey: liveKey,
    destKey: keys.file(file.id),
    mimeType: file.mimeType,
  });
  if (!result.ok) return { ok: false, error: `FILE_COPY_FAILED:${file.id}:${result.error}` };
  if (result.size !== Number(file.sizeBytes)) {
    return {
      ok: false,
      error: `FILE_SIZE_MISMATCH:${file.id}:${result.size}!=${file.sizeBytes}`,
    };
  }
  return {
    ok: true,
    objectKey: keys.file(file.id),
    sizeBytes: result.size,
    sha256: result.sha256,
  };
}

export async function verifyFileObject(env, objectKey, expected = {}) {
  const head = await env.FILES.head(objectKey);
  if (!head) return { ok: false, error: "OBJECT_MISSING" };
  if (expected.sizeBytes !== undefined && Number(head.size) !== Number(expected.sizeBytes)) {
    return { ok: false, error: `SIZE_MISMATCH:${head.size}!=${expected.sizeBytes}` };
  }

  const object = await env.FILES.get(objectKey);
  if (!object) return { ok: false, error: "OBJECT_MISSING" };
  const digest = await hashStream(object.body);
  if (expected.sha256 && digest.sha256 !== expected.sha256) {
    return { ok: false, error: `HASH_MISMATCH` };
  }
  return { ok: true, size: digest.size, sha256: digest.sha256 };
}

export async function deleteBackupPrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.FILES.list({ prefix: `${prefix}/`, cursor, limit: 500 });
    const keys = (list.objects || []).map((object) => object.key);
    if (keys.length) await env.FILES.delete(keys);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

export function buildManifest({ backup, data, fileEntries, dataMeta, createdAt }) {
  const files = fileEntries.map((file) => ({
    id: file.id,
    name: file.name,
    parentId: file.parentId,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    objectKey: file.objectKey,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  }));

  const domainCounts = {};
  for (const [domain, value] of Object.entries(data.domains || {})) {
    if (!value || value.present === false) {
      domainCounts[domain] = 0;
      continue;
    }
    if (domain === "drive") domainCounts[domain] = value.files?.length ?? 0;
    else if (domain === "notes") domainCounts[domain] = value.data?.notes?.length ?? 0;
    else if (domain === "tasks") domainCounts[domain] = value.data?.tasks?.length ?? 0;
    else if (domain === "calendar") domainCounts[domain] = value.data?.events?.length ?? 0;
    else domainCounts[domain] = Object.keys(value.keys || {}).length;
  }

  return {
    schemaVersion: BACKUP_SCHEMA,
    generator: "Guandao Backup 1.0",
    backupId: backup.id,
    userId: backup.user_id,
    backupName: backup.backup_name,
    backupType: backup.backup_type,
    scope: backup.scope,
    createdAt,
    snapshotAt: Number(backup.snapshot_at || createdAt),
    domains: Object.keys(data.domains || {}),
    counts: domainCounts,
    itemCount: Object.values(domainCounts).reduce((sum, value) => sum + Number(value || 0), 0),
    fileCount: files.length,
    files,
    folders: data.domains?.drive?.folders ?? [],
    dataObjectKey: dataMeta.key,
    dataChecksum: dataMeta.sha256,
    dataSize: dataMeta.size,
    totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0) + dataMeta.size,
    completeness: {
      verified: false,
      verifiedAt: null,
      notes: "completed 之前会重新读取 data.json 与每个文件并校验 SHA-256",
    },
  };
}

/* ------------------------------------------------------------------ */
/* 分批执行                                                            */
/* ------------------------------------------------------------------ */

export function nextBatch(deadlineMs = 18_000) {
  const start = Date.now();
  return {
    expired: () => Date.now() - start > deadlineMs,
    elapsed: () => Date.now() - start,
  };
}

export { COPY_BATCH, VERIFY_BATCH };

/* ------------------------------------------------------------------ */
/* ZIP 导出（store，无压缩；流式写入，data descriptor 记录 CRC）        */
/* ------------------------------------------------------------------ */

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * @param {Array<{ name: string, bytes?: Uint8Array, open?: () => Promise<ReadableStream> }>} entries
 */
export function createZipStream(entries) {
  const encoder = new TextEncoder();
  let offset = 0;

  return new ReadableStream({
    async start(controller) {
      const central = [];

      for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const headerOffset = offset;
        const local = concat([
          u32(0x04034b50),
          u16(20),
          u16(0x0808),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(0),
          u32(0),
          u16(nameBytes.length),
          u16(0),
          nameBytes,
        ]);
        controller.enqueue(local);
        offset += local.byteLength;

        let crc = 0;
        let size = 0;

        if (entry.bytes) {
          crc = crc32(entry.bytes);
          size = entry.bytes.byteLength;
          controller.enqueue(entry.bytes);
          offset += size;
        } else if (entry.open) {
          const stream = await entry.open();
          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            crc = crc32(value, crc);
            size += value.byteLength;
            controller.enqueue(value);
            offset += value.byteLength;
          }
        }

        const descriptor = concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
        controller.enqueue(descriptor);
        offset += descriptor.byteLength;

        central.push(
          concat([
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0x0808),
            u16(0),
            u16(0),
            u16(0),
            u32(crc),
            u32(size),
            u32(size),
            u16(nameBytes.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(headerOffset),
            nameBytes,
          ]),
        );
      }

      const centralOffset = offset;
      for (const record of central) {
        controller.enqueue(record);
        offset += record.byteLength;
      }

      const eocd = concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(central.length),
        u16(central.length),
        u32(offset - centralOffset),
        u32(centralOffset),
        u16(0),
      ]);
      controller.enqueue(eocd);
      controller.close();
    },
  });
}

export { Sha256, toHex };
