/**
 * Guandao OS 1.7 · 服务端插件规范适配
 *
 * 真正的规则只有一份（/shared/plugin-spec.js），这里补上 Worker 才能做的
 * 异步校验：SHA-256 摘要、包完整性、Manifest 与包的一致性。
 */

import { sha256Hex } from "../auth/crypto.js";
import {
  canonicalFilesJson,
  validateBundle,
  validateManifest,
  canonicalJson,
} from "../../../shared/plugin-spec.js";

export * from "../../../shared/plugin-spec.js";

/**
 * 校验插件包并计算两个摘要：
 *   filesDigest   文件清单摘要（客户端安装时会再算一次）
 *   packageDigest 原始文本摘要（R2 对象校验 / 安装记录比对）
 *
 * @param {string} raw
 * @param {{ expectedId?: string, expectedType?: string, requireFilesDigest?: boolean }} [options]
 */
export async function inspectBundle(raw, options = {}) {
  const result = validateBundle(raw, options);
  if (!result.ok) {
    return { ...result, filesDigest: "", packageDigest: "" };
  }

  const filesJson = canonicalFilesJson(result.files);
  const filesDigest = await sha256Hex(filesJson);
  const packageDigest = await sha256Hex(raw);

  const errors = [...result.errors];
  if (options.requireFilesDigest !== false) {
    if (!result.declaredFilesDigest) {
      errors.push({
        path: "filesDigest",
        message: "插件包缺少 filesDigest，无法校验文件完整性",
        code: "FILES_DIGEST_MISSING",
      });
    } else if (result.declaredFilesDigest !== filesDigest) {
      errors.push({
        path: "filesDigest",
        message: "filesDigest 与实际文件内容不一致，插件包可能被篡改",
        code: "FILES_DIGEST_MISMATCH",
      });
    }
  }

  return {
    ...result,
    ok: errors.length === 0,
    errors,
    filesDigest,
    packageDigest,
  };
}

export function inspectManifest(raw, options = {}) {
  return validateManifest(raw, options);
}

/** 权限变化：用于更新与审核，禁止静默扩大。 */
export function permissionDelta(previousManifest, nextManifest) {
  const before = new Set(previousManifest?.permissions ?? []);
  const after = new Set(nextManifest?.permissions ?? []);
  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
  };
}

/** Manifest 是否等价（用于判断上传的版本是否真的变了） */
export function manifestsEqual(a, b) {
  if (!a || !b) return false;
  return canonicalJson(a) === canonicalJson(b);
}

export function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 只保留对象里允许出现的键，防止把客户端字段直接写进 DB。 */
export function pickKeys(source, keys) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}
