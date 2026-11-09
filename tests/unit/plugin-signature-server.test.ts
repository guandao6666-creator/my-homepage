import { describe, expect, it } from "vitest";

import {
  base64urlEncode,
  buildSignatureEnvelope,
  bundleDigests,
  keyIdForPublicKey,
  signEd25519,
  signaturePayloadBytes,
} from "../../shared/plugin-signature.js";
import { resolveSignature, signatureOfVersionRow, trustOfVersionRow } from "../../worker/api/plugins/signature.js";

/**
 * 服务端验签门禁（worker/api/plugins/signature.js）单元测试。
 *
 * 为什么单独一个文件：共享模块（shared/plugin-signature.js）只证明「数学和格式对」，
 * 这里证明**服务端的决策**对——公钥是否存在、是否属于该发布者、是否被撤销。
 * D1 用最小的假 env 代替：只实现 getKeyRow 用到的 prepare/bind/first。
 */

const PUBLISHER_ID = "user_publisher01";
const PLUGIN_ID = "com.example.hello";
const VERSION = "1.0.0";

type KeyPair = { privateKey: CryptoKey; publicKey: string; keyId: string };

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
  };
}

function fakeEnv(row: Record<string, unknown> | null) {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return { first: async () => row };
          },
        };
      },
    },
  } as unknown as { DB: any };
}

async function makeSignedBundle(keyPair: KeyPair, publisherId = PUBLISHER_ID) {
  const manifest = {
    id: PLUGIN_ID,
    name: "示例插件",
    version: VERSION,
    type: "application",
    description: "签名测试",
    entry: "index.html",
    permissions: [],
  };
  const files = [{ path: "index.html", encoding: "utf8", content: "<h1>hello</h1>" }];
  const digests = await bundleDigests({ manifest }, files);
  const envelope = buildSignatureEnvelope({
    keyId: keyPair.keyId,
    publisherId,
    pluginId: PLUGIN_ID,
    version: VERSION,
    filesDigest: digests.filesDigest,
    manifestDigest: digests.manifestDigest,
  });
  const sig = await signEd25519(keyPair.privateKey, signaturePayloadBytes(envelope));
  const bundle = {
    format: "guandao-plugin",
    formatVersion: 1,
    manifest,
    files,
    filesDigest: digests.filesDigest,
  };
  return { bundle, signature: { ...envelope, sig: base64urlEncode(sig) } };
}

const PLUGIN = { id: PLUGIN_ID, developer_id: PUBLISHER_ID };

describe("服务端验签门禁", () => {
  it("公钥存在且归属发布者时验签通过", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: PUBLISHER_ID,
      public_key: keyPair.publicKey,
      algorithm: "ed25519",
      status: "active",
    });
    const result = await resolveSignature(env, { bundle, signature, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("verified");
    expect(result.keyId).toBe(keyPair.keyId);
    expect(result.envelope).not.toBeNull();
  });

  it("没有签名时返回 unsigned，而不是 invalid", async () => {
    const keyPair = await makeKeyPair();
    const { bundle } = await makeSignedBundle(keyPair);
    const result = await resolveSignature(fakeEnv(null), { bundle, signature: null, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("unsigned");
    expect(result.code).toBe("SIG_MISSING");
  });

  it("未登记的公钥直接拒绝", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const result = await resolveSignature(fakeEnv(null), { bundle, signature, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("invalid");
    expect(result.code).toBe("SIG_KEY_UNKNOWN");
  });

  it("公钥属于别的账号时拒绝（防止拿别人的公钥签名）", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: "user_someone_else",
      public_key: keyPair.publicKey,
      status: "active",
    });
    const result = await resolveSignature(env, { bundle, signature, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("invalid");
    expect(result.code).toBe("SIG_IDENTITY_MISMATCH");
  });

  it("已撤销公钥即使签名成立也拒绝", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: PUBLISHER_ID,
      public_key: keyPair.publicKey,
      status: "revoked",
    });
    const result = await resolveSignature(env, { bundle, signature, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("invalid");
    expect(result.code).toBe("SIG_KEY_REVOKED");
  });

  it("包内容被替换后签名对不上", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const tampered = { ...bundle, files: [{ path: "index.html", encoding: "utf8", content: "<h1>tampered</h1>" }] };
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: PUBLISHER_ID,
      public_key: keyPair.publicKey,
      status: "active",
    });
    const result = await resolveSignature(env, {
      bundle: tampered,
      signature,
      plugin: PLUGIN,
      version: VERSION,
    });
    expect(result.status).toBe("invalid");
    expect(result.code).toBe("SIG_DIGEST_MISMATCH");
  });

  it("签名属于另一个版本时拒绝（防版本冒用）", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: PUBLISHER_ID,
      public_key: keyPair.publicKey,
      status: "active",
    });
    const result = await resolveSignature(env, { bundle, signature, plugin: PLUGIN, version: "2.0.0" });
    expect(result.status).toBe("invalid");
    expect(result.code).toBe("SIG_IDENTITY_MISMATCH");
  });

  it("签名结构损坏时给出明确错误码", async () => {
    const keyPair = await makeKeyPair();
    const { bundle, signature } = await makeSignedBundle(keyPair);
    const broken = { ...signature, sig: "not-base64url!!" };
    const env = fakeEnv({
      key_id: keyPair.keyId,
      user_id: PUBLISHER_ID,
      public_key: keyPair.publicKey,
      status: "active",
    });
    const result = await resolveSignature(env, { bundle, signature: broken, plugin: PLUGIN, version: VERSION });
    expect(result.status).toBe("invalid");
    expect(result.code.startsWith("SIG_")).toBe(true);
  });
});

describe("签名列 → 响应结构", () => {
  it("unsigned 版本不返回签名内容", () => {
    expect(signatureOfVersionRow({ signature_status: "unsigned", signature_json: null })).toBeNull();
    expect(trustOfVersionRow({ signature_status: "unsigned" })).toEqual({
      status: "unsigned",
      keyId: null,
      signedAt: null,
    });
  });

  it("已签名版本还原出信封与信任状态", () => {
    const envelope = { keyId: "ggk_abc", sig: "xyz" };
    expect(signatureOfVersionRow({ signature_status: "verified", signature_json: JSON.stringify(envelope) })).toEqual(
      envelope,
    );
    expect(trustOfVersionRow({ signature_status: "verified", signature_key_id: "ggk_abc", signed_at: 1 })).toEqual({
      status: "verified",
      keyId: "ggk_abc",
      signedAt: 1,
    });
  });

  it("signature_json 损坏时按无签名处理，不抛异常", () => {
    expect(signatureOfVersionRow({ signature_status: "verified", signature_json: "{not json" })).toBeNull();
  });
});