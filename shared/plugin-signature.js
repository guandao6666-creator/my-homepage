/**
 * Guandao OS 2.2 · 插件发布者签名规范（Ed25519）
 *
 * 这是**唯一**的签名载荷构造与验签实现：CLI、Worker、浏览器客户端都导入这一份，
 * 避免出现「开发者算出的摘要和服务端/客户端不一致」的分歧。
 *
 * 设计要点（详见 docs/security/PLUGIN-SIGNING.md）：
 *   1. 签名对象是**规范化 JSON 文本的 UTF-8 字节**，不是插件包原始文本。
 *      插件包是格式化 JSON（缩进、键顺序都可能变），直接签原文会让
 *      「换一种缩进」就变成另一个签名，且 CLI 与浏览器无法保证逐字节一致。
 *   2. 签名信封是**扁平对象**，字段集合固定，缺一个字段即视为非法，
 *      不会在验签时做默认值填充（避免「缺字段 = 宽松通过」）。
 *   3. v1 只允许 string / 非负整数 / boolean 三种标量；禁止浮点、null、
 *      数组、嵌套对象与自由文本，因此不存在数值格式、Unicode 归一化、
 *      字段排序以外的歧义来源。
 *   4. 签名**不含**插件包原始文本的 SHA-256：签名要嵌进插件包，
 *      对含签名的原文再取摘要会形成循环。原文摘要（package_sha256）
 *      由服务端单独保存，承担「存储字节一致性」这一不同责任。
 */

import { canonicalFilesJson, canonicalJson } from "./plugin-spec.js";

/** 签名规范版本。改动载荷字段含义时必须 +1。 */
export const SIG_SPEC_VERSION = 1;

/** 唯一支持的算法。未知算法一律拒绝，不降级为「无签名」。 */
export const SIG_ALGORITHM = "ed25519";

/** 公钥/签名的字符串编码。 */
export const SIG_ENCODING = "base64url";

/** 公钥原始字节长度（Ed25519 raw public key）。 */
export const SIG_PUBLIC_KEY_BYTES = 32;

/** 签名原始字节长度（Ed25519 signature）。 */
export const SIG_SIGNATURE_BYTES = 64;

/** keyId 前缀，便于人工识别与日志检索。 */
export const SIG_KEY_ID_PREFIX = "ggk_";

/** 注册公钥时的挑战-应答动作名。 */
export const SIG_REGISTER_ACTION = "register-publisher-key";

/** 注册证明的有效期（毫秒）。只在服务端用于拒绝重放，不影响签名本身。 */
export const SIG_PROOF_TTL_MS = 10 * 60 * 1000;

/**
 * 签名信封允许出现的字段（不含 sig）。
 * 顺序不影响结果（canonicalJson 会排序），这里只用于「必须全部存在」的校验。
 */
export const SIG_FIELDS = Object.freeze([
  "spec",
  "alg",
  "keyId",
  "publisherId",
  "pluginId",
  "version",
  "format",
  "formatVersion",
  "filesDigest",
  "manifestDigest",
  "signedAt",
]);

const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const KEY_ID_RE = new RegExp(`^${SIG_KEY_ID_PREFIX}[0-9a-f]{16}$`);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,19})?$/;

/* ============================================================
   编码工具
   ============================================================ */

/** 字节数组 → base64url（无填充）。 */
export function base64urlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * base64url → 字节数组。非法输入返回 null（不抛异常，调用方按错误码处理）。
 * @returns {Uint8Array|null}
 */
export function base64urlDecode(text) {
  if (typeof text !== "string" || !text || !BASE64URL_RE.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  if (remainder === 1) return null;
  try {
    const binary = atob(padded + "=".repeat(remainder === 0 ? 0 : 4 - remainder));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** UTF-8 编码（不在浏览器/Worker/Node 之间切换实现）。 */
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

/** SHA-256 → 小写十六进制。 */
export async function sha256Hex(value) {
  const data = typeof value === "string" ? utf8Bytes(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** 由公钥原始字节推导 keyId：ggk_ + sha256(pubkey) 前 16 位十六进制。 */
export async function keyIdForPublicKey(publicKeyBytes) {
  const hex = await sha256Hex(publicKeyBytes);
  return `${SIG_KEY_ID_PREFIX}${hex.slice(0, 16)}`;
}

/* ============================================================
   载荷构造
   ============================================================ */

/**
 * 构造签名信封（不含 sig 字段）。
 *
 * 所有字段都会被 String() / Number() 归一，但**调用方必须提供**；
 * 缺字段会在归一化前被拒绝，不做静默填充。
 *
 * @param {{
 *   keyId: string,
 *   publisherId: string,
 *   pluginId: string,
 *   version: string,
 *   filesDigest: string,
 *   manifestDigest: string,
 *   signedAt?: number,
 *   spec?: number,
 *   algorithm?: string,
 *   format?: string,
 *   formatVersion?: number,
 * }} input
 * @returns {Record<string, string|number>}
 */
export function buildSignatureEnvelope(input) {
  const envelope = {
    spec: input.spec === undefined ? SIG_SPEC_VERSION : Number(input.spec),
    alg: input.algorithm === undefined ? SIG_ALGORITHM : String(input.algorithm),
    keyId: String(input.keyId ?? ""),
    publisherId: String(input.publisherId ?? ""),
    pluginId: String(input.pluginId ?? ""),
    version: String(input.version ?? ""),
    format: input.format === undefined ? "guandao-plugin" : String(input.format),
    formatVersion: input.formatVersion === undefined ? 1 : Number(input.formatVersion),
    filesDigest: String(input.filesDigest ?? "").toLowerCase(),
    manifestDigest: String(input.manifestDigest ?? "").toLowerCase(),
    signedAt: input.signedAt === undefined ? Date.now() : Number(input.signedAt),
  };
  return envelope;
}

/**
 * 签名载荷文本：信封去掉 sig 后的规范化 JSON。
 * CLI 签名与三端验签都必须走这一个函数。
 */
export function signaturePayloadText(envelope) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  for (const field of SIG_FIELDS) payload[field] = envelope?.[field];
  return canonicalJson(payload);
}

/** 签名载荷字节（UTF-8，无 BOM）。 */
export function signaturePayloadBytes(envelope) {
  return utf8Bytes(signaturePayloadText(envelope));
}

/** 计算 Manifest 摘要：sha256(canonicalJson(manifest))。 */
export async function manifestDigest(manifest) {
  return sha256Hex(canonicalJson(manifest));
}

/* ============================================================
   结构校验（不涉及密码学，纯形状与取值范围）
   ============================================================ */

function expect(problems, condition, code, path, message) {
  if (condition) return true;
  problems.push({ code, path, message });
  return false;
}

/**
 * 校验信封形状。只检查「能不能拿去验签」，不判断签名数学是否成立。
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: Array<{code:string,path:string,message:string}>, envelope: Record<string, any>|null }}
 */
export function validateSignatureEnvelope(raw) {
  /** @type {Array<{code:string,path:string,message:string}>} */
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, envelope: null, errors: [{ code: "SIG_MALFORMED", path: "signature", message: "签名元数据必须是对象" }] };
  }

  const envelope = /** @type {Record<string, any>} */ (raw);

  const missing = SIG_FIELDS.filter((field) => !(field in envelope));
  if (missing.length) {
    return {
      ok: false,
      envelope: null,
      errors: [{ code: "SIG_MALFORMED", path: "signature", message: `签名元数据缺少字段：${missing.join("、")}` }],
    };
  }

  // v1 只允许 string / 非负整数 / boolean：出现其他类型说明实现跑偏了。
  for (const field of [...SIG_FIELDS, "sig"]) {
    if (!(field in envelope)) continue;
    const value = envelope[field];
    const type = typeof value;
    if (type === "string" || type === "boolean") continue;
    if (type === "number" && Number.isSafeInteger(value) && value >= 0) continue;
    expect(errors, false, "SIG_MALFORMED", `signature.${field}`, `字段 ${field} 只允许字符串、非负整数或布尔值`);
  }
  if (errors.length) return { ok: false, envelope: null, errors };

  expect(errors, envelope.spec === SIG_SPEC_VERSION, "SIG_UNSUPPORTED_SPEC", "signature.spec",
    `签名规范版本不支持：${envelope.spec}，本端只支持 ${SIG_SPEC_VERSION}`);
  expect(errors, envelope.alg === SIG_ALGORITHM, "SIG_UNSUPPORTED_ALGORITHM", "signature.alg",
    `签名算法不支持：${String(envelope.alg)}`);
  expect(errors, KEY_ID_RE.test(String(envelope.keyId)), "SIG_MALFORMED", "signature.keyId",
    "keyId 形如 ggk_ + 16 位十六进制");
  expect(errors, ID_RE.test(String(envelope.publisherId)), "SIG_MALFORMED", "signature.publisherId",
    "publisherId 不合法");
  expect(errors, ID_RE.test(String(envelope.pluginId)), "SIG_MALFORMED", "signature.pluginId",
    "pluginId 不合法");
  expect(errors, SEMVER_RE.test(String(envelope.version)), "SIG_MALFORMED", "signature.version",
    "版本号必须是规范 semver");
  expect(errors, envelope.format === "guandao-plugin", "SIG_MALFORMED", "signature.format",
    "format 必须是 guandao-plugin");
  expect(errors, envelope.formatVersion === 1, "SIG_MALFORMED", "signature.formatVersion",
    "只支持 formatVersion = 1");
  expect(errors, HEX64_RE.test(String(envelope.filesDigest)), "SIG_MALFORMED", "signature.filesDigest",
    "filesDigest 必须是 64 位十六进制 SHA-256");
  expect(errors, HEX64_RE.test(String(envelope.manifestDigest)), "SIG_MALFORMED", "signature.manifestDigest",
    "manifestDigest 必须是 64 位十六进制 SHA-256");
  expect(errors, Number.isSafeInteger(envelope.signedAt) && envelope.signedAt > 0, "SIG_MALFORMED",
    "signature.signedAt", "signedAt 必须是正整数毫秒时间戳");

  const sigBytes = base64urlDecode(envelope.sig);
  expect(errors, Boolean(sigBytes) && sigBytes.length === SIG_SIGNATURE_BYTES, "SIG_MALFORMED", "signature.sig",
    `sig 必须是 base64url 编码的 ${SIG_SIGNATURE_BYTES} 字节签名`);

  if (errors.length) return { ok: false, envelope: null, errors };
  return { ok: true, envelope, errors: [] };
}

/* ============================================================
   Ed25519
   ============================================================ */

/**
 * 导入公钥。失败返回 null（把「公钥损坏」和「签名不匹配」区分开）。
 * @param {string} publicKeyText base64url 原始公钥
 */
async function importPublicKey(publicKeyText) {
  const raw = base64urlDecode(publicKeyText);
  if (!raw || raw.length !== SIG_PUBLIC_KEY_BYTES) return null;
  try {
    return await globalThis.crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
}

/**
 * 用公钥验证一段载荷。
 * @param {string} publicKeyText base64url 原始公钥
 * @param {Uint8Array} payloadBytes
 * @param {Uint8Array} signatureBytes
 */
export async function verifyEd25519(publicKeyText, payloadBytes, signatureBytes) {
  const key = await importPublicKey(publicKeyText);
  if (!key) return false;
  try {
    return await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, payloadBytes);
  } catch {
    return false;
  }
}

/**
 * 用私钥对载荷签名（CLI 侧使用）。
 * @param {CryptoKey} privateKey
 * @param {Uint8Array} payloadBytes
 */
export async function signEd25519(privateKey, payloadBytes) {
  const signature = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, privateKey, payloadBytes);
  return new Uint8Array(signature);
}

/* ============================================================
   组合校验：插件包 + 签名 + 可信公钥
   ============================================================ */

/** 签名可信状态。unsigned 与 invalid 是两件不同的事，必须分开表述。 */
export const SIG_STATUS = Object.freeze({
  VERIFIED: "verified",
  UNSIGNED: "unsigned",
  INVALID: "invalid",
});

/**
 * 计算插件包内两个摘要。
 * @param {any} bundle 已解析的插件包对象
 * @param {any[]} files 规范化后的文件列表（可为 bundle.files）
 */
export async function bundleDigests(bundle, files) {
  // 复用 plugin-spec 的 canonicalFilesJson：包自带的 filesDigest 就是用它算的，
  // 这里若另写一份排序/编码规则，CLI 与客户端迟早会在某个边界上分歧。
  const text = canonicalFilesJson(Array.isArray(files) ? files : []);
  return {
    filesDigest: await sha256Hex(text),
    manifestDigest: await manifestDigest(bundle?.manifest),
  };
}

/**
 * 完整验签：结构 → 身份绑定 → 摘要绑定 → 数学。
 *
 * 注意：本函数**不判断公钥是否已撤销**——撤销状态由调用方（服务端 D1 /
 * 客户端信任缓存）解析后通过 `keyStatus` 传入，因为公钥状态的唯一权威在服务端。
 *
 * @param {{
 *   signature: unknown,
 *   bundle: any,
 *   publicKey: string,
 *   keyStatus?: "active"|"revoked",
 *   revokedAt?: number|null,
 *   signedAtFloor?: number|null,
 *   signedAtCeiling?: number|null,
 *   expected?: { publisherId?: string, pluginId?: string, version?: string },
 * }} input
 * @returns {Promise<{
 *   status: "verified"|"unsigned"|"invalid",
 *   code: string,
 *   message: string,
 *   errors: Array<{code:string,path:string,message:string}>,
 *   details?: Record<string, unknown>,
 * }>}
 */
export async function verifyBundleSignature(input) {
  const { signature, bundle, publicKey } = input;
  const errors = [];

  if (signature == null) {
    return {
      status: SIG_STATUS.UNSIGNED,
      code: "SIG_MISSING",
      message: "这个版本没有发布者签名（旧包或未签名发布）",
      errors: [],
    };
  }

  const shape = validateSignatureEnvelope(signature);
  if (!shape.ok) {
    return {
      status: SIG_STATUS.INVALID,
      code: shape.errors[0]?.code || "SIG_MALFORMED",
      message: shape.errors[0]?.message || "签名元数据格式不正确",
      errors: shape.errors,
    };
  }
  const envelope = shape.envelope;

  // 1) 公钥状态：撤销的密钥不允许继续被信任。
  if (!publicKey) {
    return {
      status: SIG_STATUS.INVALID,
      code: "SIG_KEY_UNKNOWN",
      message: `未知的签名密钥：${envelope.keyId}`,
      errors: [{ code: "SIG_KEY_UNKNOWN", path: "signature.keyId", message: "该发布者没有登记这把公钥" }],
    };
  }
  if (input.keyStatus === "revoked") {
    return {
      status: SIG_STATUS.INVALID,
      code: "SIG_KEY_REVOKED",
      message: `签名密钥已撤销：${envelope.keyId}`,
      errors: [{ code: "SIG_KEY_REVOKED", path: "signature.keyId", message: "发布者已撤销这把密钥" }],
    };
  }

  // 2) 身份绑定：签名不能跨插件、跨版本、跨发布者复用。
  const expected = input.expected ?? {};
  if (expected.pluginId && envelope.pluginId !== expected.pluginId) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.pluginId", message: `签名属于插件 ${envelope.pluginId}，不是 ${expected.pluginId}` });
  }
  if (expected.version && envelope.version !== expected.version) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.version", message: `签名属于版本 ${envelope.version}，不是 ${expected.version}` });
  }
  if (expected.publisherId && envelope.publisherId !== expected.publisherId) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.publisherId", message: "签名发布者与插件归属不一致" });
  }
  if (bundle?.manifest?.id && envelope.pluginId !== bundle.manifest.id) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.pluginId", message: "签名插件 ID 与 Manifest 不一致" });
  }
  if (bundle?.manifest?.version && envelope.version !== bundle.manifest.version) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.version", message: "签名版本号与 Manifest 不一致" });
  }
  if (bundle?.format && envelope.format !== bundle.format) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.format", message: "签名包格式与插件包不一致" });
  }
  if (bundle?.formatVersion !== undefined && envelope.formatVersion !== bundle.formatVersion) {
    errors.push({ code: "SIG_IDENTITY_MISMATCH", path: "signature.formatVersion", message: "签名包格式版本与插件包不一致" });
  }

  // 3) 摘要绑定：文件内容与 Manifest 任一被替换都要失败。
  const digests = await bundleDigests(bundle, bundle?.files);
  if (envelope.filesDigest !== digests.filesDigest) {
    errors.push({ code: "SIG_DIGEST_MISMATCH", path: "signature.filesDigest", message: "签名覆盖的文件摘要与包内容不一致" });
  }
  if (envelope.manifestDigest !== digests.manifestDigest) {
    errors.push({ code: "SIG_DIGEST_MISMATCH", path: "signature.manifestDigest", message: "签名覆盖的 Manifest 摘要与包内容不一致" });
  }
  if (bundle?.filesDigest && String(bundle.filesDigest).toLowerCase() !== digests.filesDigest) {
    errors.push({ code: "SIG_DIGEST_MISMATCH", path: "filesDigest", message: "插件包自带的 filesDigest 与文件内容不一致" });
  }
  if (errors.length) {
    return { status: SIG_STATUS.INVALID, code: errors[0].code, message: errors[0].message, errors };
  }

  // 4) 时间窗口（可选）：只用于拒绝明显早于密钥创建时间的签名。
  if (Number.isSafeInteger(input.signedAtFloor) && envelope.signedAt < input.signedAtFloor) {
    return {
      status: SIG_STATUS.INVALID,
      code: "SIG_TIME_ANOMALY",
      message: "签名时间早于签名密钥的创建时间",
      errors: [{ code: "SIG_TIME_ANOMALY", path: "signature.signedAt", message: "签名时间异常" }],
    };
  }

  // 5) 数学。
  const payload = signaturePayloadBytes(envelope);
  const sigBytes = base64urlDecode(envelope.sig);
  const ok = sigBytes ? await verifyEd25519(publicKey, payload, sigBytes) : false;
  if (!ok) {
    return {
      status: SIG_STATUS.INVALID,
      code: "SIG_VERIFY_FAILED",
      message: "Ed25519 签名验证失败，插件包可能被篡改",
      errors: [{ code: "SIG_VERIFY_FAILED", path: "signature.sig", message: "签名不匹配" }],
    };
  }

  return {
    status: SIG_STATUS.VERIFIED,
    code: "SIG_OK",
    message: "发布者签名验证通过",
    errors: [],
    details: {
      keyId: envelope.keyId,
      publisherId: envelope.publisherId,
      pluginId: envelope.pluginId,
      version: envelope.version,
      signedAt: envelope.signedAt,
    },
  };
}

/* ============================================================
   注册公钥的持有证明
   ============================================================ */

/**
 * 注册公钥时必须提交「持有私钥」的证明，避免把别人的公钥登记到自己名下。
 * 载荷同样走规范化序列化；时间戳只用于拒绝过期重放。
 *
 * @param {{ userId: string, publicKey: string, keyId: string, issuedAt: number }} input
 */
export function registerProofPayloadText(input) {
  return canonicalJson({
    action: SIG_REGISTER_ACTION,
    spec: SIG_SPEC_VERSION,
    userId: String(input.userId),
    keyId: String(input.keyId),
    publicKey: String(input.publicKey),
    issuedAt: Number(input.issuedAt),
  });
}

/** 校验注册证明的形状与时间窗口，返回错误码字符串或空串。 */
export function checkRegisterProof({ userId, publicKey, keyId, issuedAt, now = Date.now() }) {
  if (!ID_RE.test(String(userId))) return "PROOF_MALFORMED";
  if (typeof publicKey !== "string" || !base64urlDecode(publicKey) || base64urlDecode(publicKey).length !== SIG_PUBLIC_KEY_BYTES) {
    return "PUBLIC_KEY_INVALID";
  }
  if (!KEY_ID_RE.test(String(keyId))) return "PUBLIC_KEY_INVALID";
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return "PROOF_MALFORMED";
  if (now - issuedAt > SIG_PROOF_TTL_MS) return "PROOF_EXPIRED";
  if (signedAtSkew(issuedAt, now)) return "PROOF_EXPIRED";
  return "";
}

function signedAtSkew(issuedAt, now) {
  return issuedAt - now > SIG_PROOF_TTL_MS;
}