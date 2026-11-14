/**
 * Guandao OS 2.2 · 客户端发布者验签
 *
 * 这一层只做「本地能独立验证」的事：拿服务端公示的公钥，对已经下载到手的字节
 * 重新算摘要并验 Ed25519。它不替代 SHA-256——
 *   · 哈希回答「这个包和记录里的是不是同一个」；
 *   · 签名回答「这个包是谁发的」。
 * 两者缺一不可，任何一边失败都必须拒绝。
 *
 * 阶段 A（当前）：缺少签名 = unsigned，允许安装但必须显式标注；
 * 签名存在但验不过（含密钥已撤销）= invalid，直接拒绝，绝不静默降级。
 */

import {
  SIG_STATUS,
  bundleDigests,
  sha256Hex,
  verifyBundleSignature,
  type SignatureIssue,
} from "../../../shared/plugin-signature.js";
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type TrustStatus = "verified" | "unsigned" | "invalid";

export type PublisherKey = {
  keyId: string;
  publicKey: string;
  algorithm: string;
  status: "active" | "revoked";
  createdAt?: number | null;
  revokedAt?: number | null;
};

export type TrustSignature = {
  status: TrustStatus;
  keyId: string | null;
  signedAt: number | null;
  payload?: unknown | null;
};

export type TrustResult = {
  status: TrustStatus;
  code: string;
  message: string;
  errors: SignatureIssue[];
  keyId: string | null;
  signedAt: number | null;
};

const UNSIGNED = (message = "这个版本没有发布者签名"): TrustResult => ({
  status: "unsigned",
  code: "SIG_MISSING",
  message,
  errors: [],
  keyId: null,
  signedAt: null,
});

const INVALID = (code: string, message: string, errors: SignatureIssue[] = []): TrustResult => ({
  status: "invalid",
  code,
  message,
  errors,
  keyId: null,
  signedAt: null,
});

/**
 * 对下载到的插件包做完整验签。
 *
 * 步骤与 docs/security/PLUGIN-SIGNING.md 的「客户端 8 步」一一对应：
 * 包摘要 → 公钥 → 密钥状态 → Ed25519 → Manifest/签名一致 → ID/版本/发布者绑定。
 */
export async function verifyPackageSignature(input: {
  packageJson: string;
  checksum: string;
  pluginId: string;
  version: string;
  signature?: TrustSignature | null;
  publisherKeys?: PublisherKey[] | null;
}): Promise<TrustResult> {
  const raw = input.packageJson;
  if (typeof raw !== "string") return INVALID("PACKAGE_MALFORMED", "插件包不是文本");

  // 1) 包摘要：客户端自己算，不信任响应里的 checksum 字段以外的东西。
  const packageDigest = await sha256Hex(raw);
  if (String(input.checksum || "").toLowerCase() !== packageDigest) {
    return INVALID("PACKAGE_DIGEST_MISMATCH", "插件包摘要与下载记录不一致");
  }

  const bundle = safeJsonParse(raw) as any;
  if (!bundle || typeof bundle !== "object") return INVALID("PACKAGE_MALFORMED", "插件包不是合法 JSON");

  // 2) 文件摘要：确认包内 files 与签名覆盖的一致（防「换文件不换签名」）。
  const digests = await bundleDigests(bundle, Array.isArray(bundle.files) ? bundle.files : []);
  if (bundle.filesDigest && bundle.filesDigest !== digests.filesDigest) {
    return INVALID("FILES_DIGEST_MISMATCH", "插件包文件清单校验失败");
  }

  const signature = input.signature ?? (bundle.signature as TrustSignature | undefined) ?? null;
  if (!signature || signature.status === SIG_STATUS.UNSIGNED || signature.payload == null) {
    return UNSIGNED();
  }

  // 3) 公钥：只认服务端为这个发布者公示的 keyId，绝不接受签名自带的公钥。
  const envelope = signature.payload as { keyId?: string } | null;
  const keyId = typeof envelope?.keyId === "string" ? envelope.keyId : "";
  if (!keyId) return INVALID("SIG_MALFORMED", "签名缺少密钥 ID");
  const keys = Array.isArray(input.publisherKeys) ? input.publisherKeys : [];
  const key = keys.find((item) => item?.keyId === keyId) ?? null;
  if (!key) return INVALID("SIG_KEY_UNKNOWN", `未知的签名密钥：${keyId}`);

  // 4) 密钥状态：撤销的密钥即使签名数学成立也不能信任。
  if (key.status === "revoked") {
    return INVALID("SIG_KEY_REVOKED", `签名密钥已撤销：${keyId}`);
  }

  // 5–8) 结构、身份绑定、摘要绑定、Ed25519。
  const result = await verifyBundleSignature({
    signature: signature.payload,
    bundle,
    publicKey: key.publicKey,
    keyStatus: key.status,
    expected: {
      pluginId: input.pluginId,
      version: input.version,
    },
  });

  if (result.status === SIG_STATUS.VERIFIED) {
    return {
      status: "verified",
      code: "SIG_VERIFIED",
      message: "发布者签名已验证",
      errors: [],
      keyId,
      signedAt: signature.signedAt ?? null,
    };
  }

  return {
    status: "invalid",
    code: result.code,
    message: result.message,
    errors: result.errors ?? [],
    keyId,
    signedAt: signature.signedAt ?? null,
  };
}

/** 界面文案：必须让用户分清「已签名」和「没签名」。 */
export function trustLabel(status: TrustStatus | undefined | null): string {
  if (status === "verified") return "已签名";
  if (status === "invalid") return "签名无效";
  return "未签名";
}

export function trustDetail(status: TrustStatus | undefined | null, keyId?: string | null): string {
  if (status === "verified") return `发布者签名已验证${keyId ? `（${keyId.slice(0, 12)}…）` : ""}`;
  if (status === "invalid") return "签名校验失败，已阻止安装";
  return "旧版未签名插件，可用但无法证明发布者身份";
}

/** 从安装记录/接口数据里读信任状态，兼容没有该字段的旧记录。 */
export function trustOf(value: { signature?: TrustSignature | null } | null | undefined): TrustStatus {
  const status = value?.signature?.status;
  return status === "verified" || status === "invalid" ? status : "unsigned";
}