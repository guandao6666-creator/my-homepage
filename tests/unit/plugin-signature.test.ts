import { describe, expect, it } from "vitest";

import {
  SIG_ALGORITHM,
  SIG_STATUS,
  SIG_SPEC_VERSION,
  base64urlDecode,
  base64urlEncode,
  buildSignatureEnvelope,
  bundleDigests,
  checkRegisterProof,
  keyIdForPublicKey,
  registerProofPayloadText,
  sha256Hex,
  signEd25519,
  signaturePayloadBytes,
  signaturePayloadText,
  validateSignatureEnvelope,
  verifyBundleSignature,
  verifyEd25519,
} from "../../shared/plugin-signature.js";
import { canonicalJson } from "../../shared/plugin-spec.js";

/**
 * 插件发布者签名（Ed25519）单元测试。
 *
 * 覆盖任务要求的 10 个签名场景：正确签名、错误签名、篡改包、篡改 Manifest、
 * 密钥 ID 不匹配、已撤销公钥、无签名旧包、签名算法不支持、版本降级、重复发布。
 *
 * 注意：这里只验证**纯逻辑**。D1 里公钥的登记、撤销与「服务端真的会用这把公钥」
 * 属于集成/E2E 层，不在本文件里假装验证。
 */

const PUBLISHER_ID = "user_publisher01";
const SIGNED_AT = 1_760_000_000_000;

type Bundle = {
  format: string;
  formatVersion: number;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; encoding: string; content: string }>;
  filesDigest: string;
};

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "com.example.hello",
    name: "示例插件",
    version: "1.0.0",
    type: "app",
    description: "签名测试用插件",
    entry: "index.html",
    permissions: [],
    ...overrides,
  };
}

async function makeBundle(manifestOverrides: Record<string, unknown> = {}): Promise<Bundle> {
  const files = [{ path: "index.html", encoding: "utf8", content: "<h1>hello</h1>" }];
  const { filesDigest } = await bundleDigests({ manifest: makeManifest(manifestOverrides) }, files);
  return {
    format: "guandao-plugin",
    formatVersion: 1,
    manifest: makeManifest(manifestOverrides),
    files,
    filesDigest,
  };
}

type KeyPair = { privateKey: CryptoKey; publicKey: string; keyId: string; raw: Uint8Array };

async function makeKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: base64urlEncode(raw),
    keyId: await keyIdForPublicKey(raw),
    raw,
  };
}

/** 按 CLI 的流程造一个签名信封：算摘要 → 构造载荷 → 签名 → 回填 sig。 */
async function signBundle(
  keyPair: KeyPair,
  bundle: Bundle,
  overrides: Record<string, string | number> = {},
): Promise<Record<string, string | number>> {
  const digests = await bundleDigests(bundle, bundle.files);
  const envelope = buildSignatureEnvelope({
    keyId: keyPair.keyId,
    publisherId: PUBLISHER_ID,
    pluginId: String(bundle.manifest.id),
    version: String(bundle.manifest.version),
    filesDigest: digests.filesDigest,
    manifestDigest: digests.manifestDigest,
    signedAt: SIGNED_AT,
    ...overrides,
  });
  const signature = await signEd25519(keyPair.privateKey, signaturePayloadBytes(envelope));
  return { ...envelope, sig: base64urlEncode(signature) };
}

async function verify(
  signature: unknown,
  bundle: Bundle,
  keyPair: KeyPair | null,
  extra: Record<string, unknown> = {},
) {
  return verifyBundleSignature({
    signature,
    bundle,
    publicKey: keyPair ? keyPair.publicKey : "",
    expected: {
      publisherId: PUBLISHER_ID,
      pluginId: String(bundle.manifest.id),
      version: String(bundle.manifest.version),
    },
    ...extra,
  });
}

describe("签名载荷的规范性", () => {
  it("载荷只由固定字段组成，且与属性书写顺序无关", () => {
    const a = buildSignatureEnvelope({
      keyId: "ggk_0123456789abcdef",
      publisherId: PUBLISHER_ID,
      pluginId: "com.example.hello",
      version: "1.0.0",
      filesDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      signedAt: SIGNED_AT,
    });
    const shuffled = Object.fromEntries(Object.entries(a).reverse());

    expect(signaturePayloadText(a)).toBe(signaturePayloadText(shuffled));
    expect(signaturePayloadText(a)).toBe(canonicalJson(a));
  });

  it("信封里混入额外字段不会改变被签内容", () => {
    const envelope = buildSignatureEnvelope({
      keyId: "ggk_0123456789abcdef",
      publisherId: PUBLISHER_ID,
      pluginId: "com.example.hello",
      version: "1.0.0",
      filesDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      signedAt: SIGNED_AT,
    });
    const polluted = { ...envelope, note: "攻击者塞进来的字段", extra: { nested: true } };

    expect(signaturePayloadText(polluted)).toBe(signaturePayloadText(envelope));
  });

  it("载荷是 UTF-8 字节，且可以稳定地参与 Ed25519", () => {
    const envelope = buildSignatureEnvelope({
      keyId: "ggk_0123456789abcdef",
      publisherId: PUBLISHER_ID,
      pluginId: "com.example.hello",
      version: "1.0.0",
      filesDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      signedAt: SIGNED_AT,
    });
    const bytes = signaturePayloadBytes(envelope);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes)).toBe(signaturePayloadText(envelope));
  });
});

describe("编码工具", () => {
  it("base64url 往返相等，且不含 + / =", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 63, 62]);
    const text = base64urlEncode(bytes);

    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(base64urlDecode(text) as Uint8Array)).toEqual(Array.from(bytes));
  });

  it("非法 base64url 返回 null 而不是抛异常", () => {
    expect(base64urlDecode("")).toBeNull();
    expect(base64urlDecode("abc+def")).toBeNull();
    expect(base64urlDecode("a")).toBeNull();
    expect(base64urlDecode(null as unknown as string)).toBeNull();
  });

  it("keyId 由公钥派生，同钥同 ID、异钥异 ID", async () => {
    const a = await makeKeyPair();
    const b = await makeKeyPair();

    expect(a.keyId).toMatch(/^ggk_[0-9a-f]{16}$/);
    expect(await keyIdForPublicKey(a.raw)).toBe(a.keyId);
    expect(b.keyId).not.toBe(a.keyId);
  });

  it("sha256Hex 对字符串和字节给出一致结果", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(await sha256Hex("abc"));
  });
});

describe("信封结构校验", () => {
  const base = () => ({
    spec: SIG_SPEC_VERSION,
    alg: SIG_ALGORITHM,
    keyId: "ggk_0123456789abcdef",
    publisherId: PUBLISHER_ID,
    pluginId: "com.example.hello",
    version: "1.0.0",
    format: "guandao-plugin",
    formatVersion: 1,
    filesDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    signedAt: SIGNED_AT,
    sig: "A".repeat(86),
  });

  it("结构完整的信封通过校验", () => {
    expect(validateSignatureEnvelope(base()).ok).toBe(true);
  });

  it.each([
    ["spec", 2, "SIG_UNSUPPORTED_SPEC"],
    ["alg", "rsa-sha256", "SIG_UNSUPPORTED_ALGORITHM"],
    ["keyId", "0123456789abcdef", "SIG_MALFORMED"],
    ["version", "1.0", "SIG_MALFORMED"],
    ["format", "npm-package", "SIG_MALFORMED"],
    ["formatVersion", 2, "SIG_MALFORMED"],
    ["filesDigest", "a".repeat(63), "SIG_MALFORMED"],
    ["signedAt", 0, "SIG_MALFORMED"],
    ["sig", "not base64url!", "SIG_MALFORMED"],
  ])("字段 %s=%s 被拒绝（%s）", (field, value, code) => {
    const result = validateSignatureEnvelope({ ...base(), [field]: value });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(code);
    expect(result.errors[0].path).toBe(`signature.${field}`);
  });

  it("缺字段直接判非法，不做默认值填充", () => {
    const raw = base();
    delete (raw as Record<string, unknown>).manifestDigest;

    const result = validateSignatureEnvelope(raw);

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("SIG_MALFORMED");
    expect(result.errors[0].message).toContain("manifestDigest");
  });

  it("非对象输入被判非法", () => {
    for (const value of [null, undefined, "sig", 42, []]) {
      expect(validateSignatureEnvelope(value).ok).toBe(false);
    }
  });
});

describe("Ed25519 基本运算", () => {
  it("正确签名可验证，改动一个字节即失败", async () => {
    const keyPair = await makeKeyPair();
    const payload = new TextEncoder().encode("hello 管道");
    const signature = await signEd25519(keyPair.privateKey, payload);

    expect(signature.length).toBe(64);
    expect(await verifyEd25519(keyPair.publicKey, payload, signature)).toBe(true);

    const tamperedPayload = new TextEncoder().encode("hello 管道!");
    expect(await verifyEd25519(keyPair.publicKey, tamperedPayload, signature)).toBe(false);

    const tamperedSig = new Uint8Array(signature);
    tamperedSig[0] ^= 0x01;
    expect(await verifyEd25519(keyPair.publicKey, payload, tamperedSig)).toBe(false);
  });

  it("公钥损坏时返回 false，不抛异常", async () => {
    const keyPair = await makeKeyPair();
    const payload = new TextEncoder().encode("x");
    const signature = await signEd25519(keyPair.privateKey, payload);

    expect(await verifyEd25519("", payload, signature)).toBe(false);
    expect(await verifyEd25519("!!!", payload, signature)).toBe(false);
    expect(await verifyEd25519(base64urlEncode(new Uint8Array(16)), payload, signature)).toBe(false);
  });
});

describe("插件包验签：10 个任务要求场景", () => {
  it("1. 正确签名 → verified", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);

    const result = await verify(signature, bundle, keyPair);

    expect(result.status).toBe(SIG_STATUS.VERIFIED);
    expect(result.code).toBe("SIG_OK");
    expect(result.details?.keyId).toBe(keyPair.keyId);
  });

  it("2. 错误签名（换一把私钥签）→ invalid", async () => {
    const signer = await makeKeyPair();
    const other = await makeKeyPair();
    const bundle = await makeBundle();
    // 用 other 的私钥签，但信封声明的是 signer 的 keyId
    const signature = await signBundle(other, bundle, { keyId: signer.keyId });

    const result = await verify(signature, bundle, signer);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_VERIFY_FAILED");
  });

  it("3. 篡改包内容 → invalid（SIG_DIGEST_MISMATCH）", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);
    const tampered: Bundle = {
      ...bundle,
      files: [{ path: "index.html", encoding: "utf8", content: "<script>alert(1)</script>" }],
    };

    const result = await verify(signature, tampered, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_DIGEST_MISMATCH");
    expect(result.errors.some((e) => e.path === "signature.filesDigest")).toBe(true);
  });

  it("4. 篡改 Manifest → invalid（SIG_DIGEST_MISMATCH）", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);
    const tampered: Bundle = {
      ...bundle,
      manifest: { ...bundle.manifest, permissions: ["network"] },
    };

    const result = await verify(signature, tampered, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    // 权限变了 → Manifest 摘要失配；插件 ID/版本未变，因此不会先撞身份校验
    expect(result.code).toBe("SIG_DIGEST_MISMATCH");
    expect(result.errors.some((e) => e.path === "signature.manifestDigest")).toBe(true);
  });

  it("5. 密钥 ID 对不上 → 查不到公钥则 SIG_KEY_UNKNOWN，查到别的公钥则验签失败", async () => {
    const keyPair = await makeKeyPair();
    const other = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);

    const unknown = await verify(signature, bundle, null);
    expect(unknown.status).toBe(SIG_STATUS.INVALID);
    expect(unknown.code).toBe("SIG_KEY_UNKNOWN");

    // 服务端按 keyId 取到了另一把公钥（登记错/被替换）
    const swapped = await verifyBundleSignature({
      signature,
      bundle,
      publicKey: other.publicKey,
      expected: { publisherId: PUBLISHER_ID },
    });
    expect(swapped.status).toBe(SIG_STATUS.INVALID);
    expect(swapped.code).toBe("SIG_VERIFY_FAILED");
  });

  it("6. 已撤销公钥 → invalid（SIG_KEY_REVOKED）", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);

    const result = await verify(signature, bundle, keyPair, { keyStatus: "revoked" });

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_KEY_REVOKED");
  });

  it("7. 无签名旧包 → unsigned（不是 invalid，也不是 verified）", async () => {
    const bundle = await makeBundle();
    const keyPair = await makeKeyPair();

    const nullResult = await verify(null, bundle, keyPair);
    const undefinedResult = await verify(undefined, bundle, keyPair);

    expect(nullResult.status).toBe(SIG_STATUS.UNSIGNED);
    expect(nullResult.code).toBe("SIG_MISSING");
    expect(nullResult.errors).toEqual([]);
    expect(undefinedResult.status).toBe(SIG_STATUS.UNSIGNED);
  });

  it("8. 不支持的签名算法 / 规范版本 → invalid", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();

    const badAlg = await signBundle(keyPair, bundle, { algorithm: "rsa-sha256" });
    const badSpec = await signBundle(keyPair, bundle, { spec: 2 });

    const algResult = await verify(badAlg, bundle, keyPair);
    expect(algResult.status).toBe(SIG_STATUS.INVALID);
    expect(algResult.code).toBe("SIG_UNSUPPORTED_ALGORITHM");

    const specResult = await verify(badSpec, bundle, keyPair);
    expect(specResult.status).toBe(SIG_STATUS.INVALID);
    expect(specResult.code).toBe("SIG_UNSUPPORTED_SPEC");
  });

  it("9. 版本降级：用旧版本签名冒充新版本，或把旧包降级安装 → invalid", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    // 签名本身是 1.0.0 的
    const signature = await signBundle(keyPair, bundle);

    // (a) 声称要装 1.0.1 —— 与签名里的版本不符
    const asNewer = await verifyBundleSignature({
      signature,
      bundle: { ...bundle, manifest: { ...bundle.manifest, version: "1.0.1" } },
      publicKey: keyPair.publicKey,
      expected: { publisherId: PUBLISHER_ID, pluginId: "com.example.hello", version: "1.0.1" },
    });
    expect(asNewer.status).toBe(SIG_STATUS.INVALID);
    expect(asNewer.code).toBe("SIG_IDENTITY_MISMATCH");

    // (b) 用 1.0.1 的签名包去满足 1.0.0 的安装请求
    const newer = await makeBundle({ version: "1.0.1" });
    const newerSig = await signBundle(keyPair, newer);
    const downgraded = await verifyBundleSignature({
      signature: newerSig,
      bundle: newer,
      publicKey: keyPair.publicKey,
      expected: { publisherId: PUBLISHER_ID, pluginId: "com.example.hello", version: "1.0.0" },
    });
    expect(downgraded.status).toBe(SIG_STATUS.INVALID);
    expect(downgraded.code).toBe("SIG_IDENTITY_MISMATCH");
  });

  it("10. 重复发布：把 A 插件的签名挪到 B 插件 → invalid", async () => {
    const keyPair = await makeKeyPair();
    const bundleA = await makeBundle();
    const signatureA = await signBundle(keyPair, bundleA);
    const bundleB = await makeBundle({ id: "com.example.world" });

    const result = await verify(signatureA, bundleB, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_IDENTITY_MISMATCH");
    expect(result.errors.some((e) => e.path === "signature.pluginId")).toBe(true);
  });
});

describe("身份绑定与摘要绑定的补充边界", () => {
  it("签名发布者与插件归属不一致 → invalid", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle, { publisherId: "user_attacker" });

    const result = await verify(signature, bundle, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_IDENTITY_MISMATCH");
  });

  it("包自带的 filesDigest 被改掉 → invalid", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);

    const result = await verify(signature, { ...bundle, filesDigest: "f".repeat(64) }, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_DIGEST_MISMATCH");
  });

  it("签名时间早于密钥创建时间 → SIG_TIME_ANOMALY", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);

    const result = await verify(signature, bundle, keyPair, { signedAtFloor: SIGNED_AT + 1 });

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_TIME_ANOMALY");
  });

  it("文件顺序被打乱不影响验签（按 path 排序后取摘要）", async () => {
    const keyPair = await makeKeyPair();
    const files = [
      { path: "b.js", encoding: "utf8", content: "b" },
      { path: "a.js", encoding: "utf8", content: "a" },
    ];
    const { filesDigest } = await bundleDigests({ manifest: makeManifest() }, files);
    const bundle: Bundle = {
      format: "guandao-plugin",
      formatVersion: 1,
      manifest: makeManifest(),
      files: [files[1], files[0]],
      filesDigest,
    };
    const signature = await signBundle(keyPair, bundle);

    expect((await verify(signature, bundle, keyPair)).status).toBe(SIG_STATUS.VERIFIED);
  });

  it("缺 sig 字段 → invalid（不是 unsigned）", async () => {
    const keyPair = await makeKeyPair();
    const bundle = await makeBundle();
    const signature = await signBundle(keyPair, bundle);
    delete (signature as Record<string, unknown>).sig;

    const result = await verify(signature, bundle, keyPair);

    expect(result.status).toBe(SIG_STATUS.INVALID);
    expect(result.code).toBe("SIG_MALFORMED");
  });
});

describe("发布者公钥登记证明", () => {
  it("形状正确且在有效期内 → 通过", async () => {
    const keyPair = await makeKeyPair();
    const issuedAt = Date.now();

    const code = checkRegisterProof({
      userId: PUBLISHER_ID,
      publicKey: keyPair.publicKey,
      keyId: keyPair.keyId,
      issuedAt,
      now: issuedAt + 1000,
    });

    expect(code).toBe("");
    expect(registerProofPayloadText({ userId: PUBLISHER_ID, publicKey: keyPair.publicKey, keyId: keyPair.keyId, issuedAt })).toBe(
      canonicalJson({
        action: "register-publisher-key",
        spec: SIG_SPEC_VERSION,
        userId: PUBLISHER_ID,
        keyId: keyPair.keyId,
        publicKey: keyPair.publicKey,
        issuedAt,
      }),
    );
  });

  it("超过有效期 → PROOF_EXPIRED", async () => {
    const keyPair = await makeKeyPair();
    const issuedAt = 1_700_000_000_000;

    expect(
      checkRegisterProof({
        userId: PUBLISHER_ID,
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        issuedAt,
        now: issuedAt + 10 * 60 * 1000 + 1,
      }),
    ).toBe("PROOF_EXPIRED");
  });

  it("时间戳来自未来 → PROOF_EXPIRED（防重放）", async () => {
    const keyPair = await makeKeyPair();
    const now = 1_700_000_000_000;

    expect(
      checkRegisterProof({
        userId: PUBLISHER_ID,
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        issuedAt: now + 10 * 60 * 1000 + 1,
        now,
      }),
    ).toBe("PROOF_EXPIRED");
  });

  it("公钥/ keyId 不合法 → PUBLIC_KEY_INVALID", async () => {
    const keyPair = await makeKeyPair();
    const now = Date.now();

    expect(
      checkRegisterProof({ userId: PUBLISHER_ID, publicKey: "short", keyId: keyPair.keyId, issuedAt: now, now }),
    ).toBe("PUBLIC_KEY_INVALID");
    expect(
      checkRegisterProof({ userId: PUBLISHER_ID, publicKey: keyPair.publicKey, keyId: "ggk_zz", issuedAt: now, now }),
    ).toBe("PUBLIC_KEY_INVALID");
  });
});