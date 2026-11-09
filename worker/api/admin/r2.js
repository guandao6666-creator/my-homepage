/**
 * /api/admin/r2-audit —— R2 只读巡检。
 *
 * 目的：回答「D1 里引用的对象是否真的在 R2」「R2 里有没有没人引用的对象」。
 * 约束：
 *   - 仅管理员可调用（users.role='admin'，与社区/插件后台同一套判定）；
 *   - 只读：不删除、不移动、不修改 D1；
 *   - 报告绝不输出完整 Object Key，只给 SHA-256 前缀、大小与上传时间。
 *
 * 注意：孤儿候选只是「当前没有数据库引用」，不等于可以删除；
 * 备份清单、导出包、社区待审资源都可能在业务上仍需要保留。
 */

import { ApiError, ok } from "../http.js";
import { requireSession } from "../guards.js";
import { effectiveRole } from "../community/common.js";

const MAX_OBJECTS = 20_000;
const PAGE_SIZE = 1_000;

const REF_QUERIES = [
  {
    source: "file",
    sql: "SELECT r2_key AS key FROM files WHERE r2_key IS NOT NULL AND r2_key <> ''",
  },
  {
    source: "backup",
    sql: `SELECT r2_key AS key FROM backups WHERE r2_key IS NOT NULL AND r2_key <> ''
          UNION ALL SELECT manifest_object_key FROM backups WHERE manifest_object_key IS NOT NULL AND manifest_object_key <> ''
          UNION ALL SELECT data_object_key FROM backups WHERE data_object_key IS NOT NULL AND data_object_key <> ''`,
  },
  {
    source: "backup_item",
    sql: "SELECT object_key AS key FROM backup_items WHERE object_key IS NOT NULL AND object_key <> ''",
  },
  {
    source: "community_asset",
    sql: "SELECT object_key AS key FROM community_assets WHERE object_key IS NOT NULL AND object_key <> ''",
  },
  {
    source: "community_package",
    sql: `SELECT manifest_object_key AS key FROM community_packages WHERE manifest_object_key IS NOT NULL AND manifest_object_key <> ''
          UNION ALL SELECT package_object_key FROM community_packages WHERE package_object_key IS NOT NULL AND package_object_key <> ''`,
  },
  {
    source: "plugin_version",
    sql: "SELECT package_key AS key FROM plugin_versions WHERE package_key IS NOT NULL AND package_key <> ''",
  },
  {
    source: "data_export",
    sql: `SELECT data_key AS key FROM data_exports WHERE data_key IS NOT NULL AND data_key <> ''
          UNION ALL SELECT manifest_key FROM data_exports WHERE manifest_key IS NOT NULL AND manifest_key <> ''`,
  },
];

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 脱敏标识：SHA-256 前 12 位，不可逆推 Object Key。 */
async function maskKey(key) {
  return (await sha256Hex(String(key))).slice(0, 12);
}

async function listBucket(bucket) {
  const keys = new Set();
  const objects = [];
  let cursor;
  let pages = 0;
  let truncated = false;

  do {
    const page = await bucket.list({ limit: PAGE_SIZE, cursor });
    pages += 1;
    for (const object of page.objects ?? []) {
      keys.add(object.key);
      objects.push({ key: object.key, size: Number(object.size ?? 0), uploaded: object.uploaded ?? null });
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (keys.size >= MAX_OBJECTS) {
      truncated = Boolean(page.truncated);
      break;
    }
  } while (cursor);

  return { keys, objects, pages, truncated };
}

export async function auditR2(env) {
  const startedAt = Date.now();
  const report = {
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    r2: { listSupported: true, objects: 0, pages: 0, truncated: false },
    database: { refs: 0, unique: 0, bySource: {} },
    matched: 0,
    missing: { count: 0, samples: [] },
    orphans: { count: 0, samples: [] },
    limitations: [],
    errors: [],
  };

  if (!env?.FILES || typeof env.FILES.list !== "function") {
    report.r2.listSupported = false;
    report.limitations.push("当前 R2 Binding 不支持 list()，无法枚举桶对象；只返回数据库引用统计。");
  }

  /** @type {Map<string, string[]>} key -> sources */
  const refs = new Map();
  for (const query of REF_QUERIES) {
    try {
      const result = await env.DB.prepare(query.sql).all();
      const rows = result.results ?? [];
      report.database.bySource[query.source] = rows.length;
      report.database.refs += rows.length;
      for (const row of rows) {
        const key = row.key;
        if (!key) continue;
        const sources = refs.get(key) ?? [];
        sources.push(query.source);
        refs.set(key, sources);
      }
    } catch (error) {
      report.errors.push({ source: query.source, message: String(error?.message ?? error).slice(0, 200) });
    }
  }
  report.database.unique = refs.size;

  if (report.r2.listSupported) {
    try {
      const listed = await listBucket(env.FILES);
      report.r2.objects = listed.objects.length;
      report.r2.pages = listed.pages;
      report.r2.truncated = listed.truncated;
      if (listed.truncated) {
        report.limitations.push(`对象数超过 ${MAX_OBJECTS}，本轮只扫描了前 ${MAX_OBJECTS} 个；孤儿结论不完整。`);
      }

      for (const key of refs.keys()) {
        if (listed.keys.has(key)) report.matched += 1;
      }
      const missingKeys = [...refs.keys()].filter((key) => !listed.keys.has(key));
      report.missing.count = missingKeys.length;
      for (const key of missingKeys.slice(0, 20)) {
        report.missing.samples.push({ ref: await maskKey(key), sources: refs.get(key) });
      }

      const orphanObjects = listed.objects.filter((object) => !refs.has(object.key));
      report.orphans.count = orphanObjects.length;
      for (const object of orphanObjects.slice(0, 20)) {
        report.orphans.samples.push({
          ref: await maskKey(object.key),
          size: object.size,
          uploaded: object.uploaded,
        });
      }
    } catch (error) {
      report.errors.push({ source: "r2.list", message: String(error?.message ?? error).slice(0, 200) });
      report.limitations.push("R2 枚举失败，未产生孤儿结论。");
    }
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}

export async function handleAdminRequest({ request, env, path }) {
  if (path !== "/api/admin/r2-audit") return null;
  if (request.method !== "GET") {
    throw new ApiError("METHOD_NOT_ALLOWED", "该接口只支持 GET", 405);
  }

  const session = await requireSession(env, request, { message: "请先登录 Guandao Account" });
  const role = await effectiveRole(env, session.user.id, session.user);
  if (role !== "admin") {
    throw new ApiError("FORBIDDEN", "需要管理员权限", 403);
  }

  return ok(await auditR2(env));
}