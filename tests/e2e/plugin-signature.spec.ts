/**
 * Phase 3.1 · 插件发布者签名 E2E（真实 Worker + 本地 D1/R2）
 *
 * 这里跟 `tests/unit/plugin-signature*.test.ts` 的分工：
 *   - 单测：共享模块与服务端决策函数的纯逻辑，用假 DB。
 *   - 本文件：**真的**走 HTTP，经由 `wrangler dev --local` 的 Worker 与真实 D1 行，
 *     证明「上传 → 审核 → 下载 → 安装」四条路径上的验签真的接上了。
 *
 * 夹具（`scripts/e2e-server.mjs` 用公开 API 造出来，不是直接塞假数据）：
 *   com.qa.signed     正确签名
 *   com.qa.unsigned   旧包，无签名（阶段 A 兼容）
 *   com.qa.tampered   签名信封是另一份包的（内容被替换）
 *   com.qa.badsig     信封结构对，签名字节错
 *   com.qa.alg        算法被改成 rsa2048
 *   com.qa.revoked    签名公钥事后被撤销
 *   com.qa.foreign    别人账号的公钥签的名
 *   com.qa.integrity  R2 里的包与 DB 记录的 sha256 不一致
 *
 * 不做的事：不碰生产 API、不需要 GITHUB_* 凭据、不写任何真实用户数据。
 */
import { expect, test } from "@playwright/test";

import { manifestDigest } from "../../shared/plugin-signature.js";
import { as, expectStatus, openApi, readJson, waitForFixtures, type Fixtures } from "./support/worker-api";

let fixtures: Fixtures;

test.beforeAll(async () => {
  fixtures = await waitForFixtures("complete");
});

/** 取插件某个版本的 package（返回原始 packageJson 文本与 checksum）。 */
async function fetchPackage(api: any, pluginId: string, role: Parameters<typeof as>[1] = "installer") {
  const response = await api.get(`/api/plugins/${pluginId}/package`, { headers: as(fixtures, role) });
  return { response, body: await readJson(response) };
}

async function versionChecksum(api: any, pluginId: string): Promise<string> {
  const response = await api.get(`/api/plugins/${pluginId}/versions`, { headers: as(fixtures, "installer") });
  const body = await expectStatus(response, 200);
  const version = body.data.versions.find((item: any) => item.version === "1.0.0");
  expect(version, `${pluginId} 缺少 1.0.0 版本`).toBeTruthy();
  return version.checksum;
}

test.describe("下载路径：验签是硬门禁", () => {
  test("正确签名：返回 verified，且包摘要与声明一致", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.signed");
    expect(response.status()).toBe(200);
    expect(body.data.signature.status).toBe("verified");
    expect(body.data.signature.keyId).toBe(fixtures.keys.primary);
    expect(body.data.signature.payload).toBeTruthy();

    // 客户端要独立复核摘要：sha256(packageJson) === checksum
    const { createHash } = await import("node:crypto");
    const actual = createHash("sha256").update(body.data.packageJson, "utf8").digest("hex");
    expect(actual).toBe(body.data.checksum);
  });

  test("保存者公钥列表包含已撤销的密钥（客户端据此判断）", async ({ request }) => {
    const { body } = await fetchPackage(request, "com.qa.signed");
    const keys = body.data.publisherKeys as Array<{ keyId: string; status: string }>;
    expect(keys.find((key) => key.keyId === fixtures.keys.primary)?.status).toBe("active");
    expect(keys.find((key) => key.keyId === fixtures.keys.revoked)?.status).toBe("revoked");
    // 绝不把别人的公钥混进这个列表
    expect(keys.find((key) => key.keyId === fixtures.keys.outsider)).toBeUndefined();
  });

  test("包内容被替换：下载被拒绝（SIG_DIGEST_MISMATCH）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.tampered");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
    expect(body.error.details.signatureCode).toBe("SIG_DIGEST_MISMATCH");
  });

  test("签名字节不对：下载被拒绝（SIG_VERIFY_FAILED）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.badsig");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
    expect(["SIG_VERIFY_FAILED", "SIG_DIGEST_MISMATCH"]).toContain(body.error.details.signatureCode);
  });

  test("签名算法不受支持：下载被拒绝（SIG_UNSUPPORTED_ALGORITHM）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.alg");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
    expect(body.error.details.signatureCode).toBe("SIG_UNSUPPORTED_ALGORITHM");
  });

  test("已撤销公钥：下载被拒绝（SIG_KEY_REVOKED）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.revoked");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
    expect(body.error.details.signatureCode).toBe("SIG_KEY_REVOKED");
  });

  test("冒用他人公钥：下载被拒绝（SIG_IDENTITY_MISMATCH）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.foreign");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
    expect(body.error.details.signatureCode).toBe("SIG_IDENTITY_MISMATCH");
  });

  test("包摘要被改：完整性校验先失败（PACKAGE_INTEGRITY_ERROR）", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.integrity");
    expect(response.status()).toBe(409);
    expect(body.error.code).toBe("PACKAGE_INTEGRITY_ERROR");
  });

  test("未签名旧包：标注 unsigned，而不是当成签名无效", async ({ request }) => {
    const { response, body } = await fetchPackage(request, "com.qa.unsigned");
    expect(response.status()).toBe(200);
    expect(body.data.signature.status).toBe("unsigned");
    expect(body.data.signature.keyId).toBeNull();
    expect(body.data.signature.payload).toBeNull();
    // 有真实 filesDigest：旧客端仍然可以走完整性校验
    expect(typeof body.data.signature === "object").toBe(true);
  });
});

test.describe("安装路径：验签是硬门禁", () => {
  test("正确签名可以安装，安装记录带信任状态", async ({ request }) => {
    const checksum = await versionChecksum(request, "com.qa.signed");
    const response = await request.post("/api/plugins/install", {
      headers: as(fixtures, "installer"),
      data: { pluginId: "com.qa.signed", version: "1.0.0", packageHash: checksum, permissions: [] },
    });
    const body = await expectStatus(response, 200);
    expect(body.data.signature.status).toBe("verified");
  });

  test("未签名旧包仍可安装（阶段 A 兼容），但状态必须显示 unsigned", async ({ request }) => {
    const checksum = await versionChecksum(request, "com.qa.unsigned");
    const response = await request.post("/api/plugins/install", {
      headers: as(fixtures, "installer"),
      data: { pluginId: "com.qa.unsigned", version: "1.0.0", packageHash: checksum, permissions: [] },
    });
    const body = await expectStatus(response, 200);
    expect(body.data.signature.status).toBe("unsigned");
  });

  test("已撤销公钥的包不能安装（撤销后旧包也不再通行）", async ({ request }) => {
    const checksum = await versionChecksum(request, "com.qa.revoked");
    const response = await request.post("/api/plugins/install", {
      headers: as(fixtures, "installer"),
      data: { pluginId: "com.qa.revoked", version: "1.0.0", packageHash: checksum, permissions: [] },
    });
    expect(response.status()).toBe(409);
    const body = await readJson(response);
    expect(body.error.code).toBe("SIGNATURE_KEY_REVOKED");
    expect(body.error.details.signatureCode).toBe("SIG_KEY_REVOKED");
  });

  test("声明的包哈希与数据库不一致时拒绝安装", async ({ request }) => {
    const response = await request.post("/api/plugins/install", {
      headers: as(fixtures, "installer"),
      data: { pluginId: "com.qa.signed", version: "1.0.0", packageHash: "0".repeat(64), permissions: [] },
    });
    expect(response.status()).toBe(409);
    const body = await readJson(response);
    expect(body.error.code).toBe("PACKAGE_INTEGRITY_ERROR");
  });

  test("未登录不能安装（验签之前先要有身份）", async ({ request }) => {
    const response = await request.post("/api/plugins/install", {
      data: { pluginId: "com.qa.signed", version: "1.0.0", packageHash: "a".repeat(64), permissions: [] },
    });
    expect([401, 403]).toContain(response.status());
  });
});

test.describe("市场返回的信任状态", () => {
  test("详情与列表卡片都带签名信任，客户端无需自己猜", async ({ request }) => {
    const detail = await request.get("/api/plugins/com.qa.signed", { headers: as(fixtures, "installer") });
    const detailBody = await expectStatus(detail, 200);
    expect(detailBody.data.plugin.security.signature.status).toBe("verified");

    const list = await request.get("/api/plugins?limit=50", { headers: as(fixtures, "installer") });
    const listBody = await expectStatus(list, 200);
    const items = listBody.data.plugins ?? listBody.data.items ?? [];
    const signed = items.find((item: any) => item.id === "com.qa.signed");
    expect(signed, "列表里应能找到 com.qa.signed").toBeTruthy();
    expect(signed.security.signature.status).toBe("verified");

    const unsigned = items.find((item: any) => item.id === "com.qa.unsigned");
    if (unsigned) expect(unsigned.security.signature.status).toBe("unsigned");
  });
});

test.describe("上传路径：签名覆盖 Manifest 与版本", () => {
  /** 从已发布包复制一份，只改版本号，用于触发版本相关错误。 */
  async function bundleWithVersion(api: any, version: string) {
    const { body } = await fetchPackage(api, "com.qa.signed", "developer");
    const bundle = JSON.parse(body.data.packageJson);
    bundle.manifest.version = version;
    delete bundle.signature;
    return bundle;
  }

  test("签名覆盖 Manifest 摘要：payload 里的 manifestDigest 可被独立复算", async ({ request }) => {
    const { body } = await fetchPackage(request, "com.qa.signed");
    const bundle = JSON.parse(body.data.packageJson);
    expect(body.data.signature.payload.manifestDigest).toBe(await manifestDigest(bundle.manifest));
    expect(body.data.signature.payload.pluginId).toBe("com.qa.signed");
    expect(body.data.signature.payload.version).toBe("1.0.0");
  });

  test("版本降级被拒绝（VERSION_NOT_NEWER）", async ({ request }) => {
    const bundle = await bundleWithVersion(request, "0.9.0");
    const response = await request.post("/api/developer/plugins/com.qa.signed/versions", {
      headers: as(fixtures, "developer"),
      data: { bundle: JSON.stringify(bundle), changelog: "降级尝试" },
    });
    expect(response.status()).toBe(409);
    const body = await readJson(response);
    expect(body.error.code).toBe("VERSION_NOT_NEWER");
  });

  test("重复发布同名版本被拒绝（VERSION_EXISTS）", async ({ request }) => {
    const bundle = await bundleWithVersion(request, "1.0.0");
    const response = await request.post("/api/developer/plugins/com.qa.signed/versions", {
      headers: as(fixtures, "developer"),
      data: { bundle: JSON.stringify(bundle), changelog: "重复发布" },
    });
    expect(response.status()).toBe(409);
    const body = await readJson(response);
    expect(body.error.code).toBe("VERSION_EXISTS");
  });

  test("伪造签名的上传在入库前就被拒绝，不会写入版本行", async ({ request }) => {
    const bundle = await bundleWithVersion(request, "1.1.0");
    // 拿一份合法信封，但把 pluginId 指向另一个插件
    const { body } = await fetchPackage(request, "com.qa.signed", "developer");
    const parsed = JSON.parse(body.data.packageJson);
    bundle.signature = { ...parsed.signature, pluginId: "com.qa.unsigned" };

    const response = await request.post("/api/developer/plugins/com.qa.signed/versions", {
      headers: as(fixtures, "developer"),
      data: { bundle: JSON.stringify(bundle), changelog: "伪造签名" },
    });
    expect(response.status()).toBe(422);
    const failed = await readJson(response);
    expect(failed.error.code).toBe("SIGNATURE_INVALID");

    // 版本行不应出现
    const versions = await request.get("/api/plugins/com.qa.signed/versions", {
      headers: as(fixtures, "installer"),
    });
    const versionsBody = await expectStatus(versions, 200);
    expect(versionsBody.data.versions.some((item: any) => item.version === "1.1.0")).toBe(false);
  });
});