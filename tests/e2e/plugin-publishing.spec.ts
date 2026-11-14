/**
 * Phase 5 · 完整发布链 E2E（worker project，真实 8788 Worker）。
 *
 * 覆盖：开发者草稿 → 登记 Ed25519 密钥 → 签名上传 → submit → 未登录/普通用户审核被拒 →
 * admin approve → 市场可见且签名 verified → 下载并本地复算 SHA-256 → 安装成功 → 安装记录 →
 * 紧急下架（admin takedown）→ 下架后下载/安装 409。
 *
 * 约定：
 * - 只使用独立 Browser Context（developer / installer / admin），全部通过 context.request 打真实 Worker。
 * - 每轮唯一插件 id，避免与共享 fixture 插件冲突。
 * - 用 .wrangler/qa-run.lock 目录互斥，避免与其它 E2E 进程并发 reset/e2e-server。
 * - 结束时清理：卸载、吊销本轮密钥、admin 下架测试插件（现有 API 没有插件删除端点）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";

import { canonicalFilesJson } from "../../shared/plugin-spec.js";
import {
  base64urlEncode,
  buildSignatureEnvelope,
  bundleDigests,
  keyIdForPublicKey,
  registerProofPayloadText,
  signEd25519,
  signaturePayloadBytes,
} from "../../shared/plugin-signature.js";
import {
  API_BASE,
  ROOT,
  as,
  expectStatus,
  openApi,
  readJson,
  waitForFixtures,
  type Fixtures,
} from "./support/worker-api";

const LOCK_DIR = path.join(ROOT, ".wrangler", "qa-run.lock");
const LOCK_RETRY_MS = 15_000;
const LOCK_TIMEOUT_MS = 40 * 60_000;
const SEEDED_ADMIN_TOKEN = "qa-plugin-admin-token-1234567890";

const runSuffix = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const PLUGIN_ID = `com.qa.p5.run${runSuffix}`;
const PLUGIN_NAME = `P5 E2E 发布链 ${runSuffix}`;
const VERSION = "1.0.0";
const PERMISSIONS = ["window.open"];

const sha256 = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildBundle() {
  const manifest = {
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: VERSION,
    description: "Phase 5 完整发布链 E2E 插件包。",
    author: { name: "P5 E2E Developer", url: "https://guandao.xin" },
    type: "application",
    entry: "index.html",
    icon: "icon.svg",
    screenshots: [],
    category: "developer",
    license: "MIT",
    homepage: "https://guandao.xin",
    repository: "",
    changelog: `E2E ${VERSION}`,
    compatibility: { minimumOSVersion: "2.0.0", sdkVersion: 1 },
    permissions: PERMISSIONS,
    networkDomains: [],
    dependencies: [],
    contributes: {},
  };
  const files = [
    { path: "index.html", encoding: "utf8" as const, content: "<!doctype html><html><body><h1>P5 E2E</h1></body></html>" },
    { path: "icon.svg", encoding: "utf8" as const, content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#6f8cff"/></svg>' },
  ];
  const filesDigest = sha256(canonicalFilesJson(files));
  return { text: JSON.stringify({ format: "guandao-plugin", formatVersion: 1, manifest, files, filesDigest }), manifest, filesDigest };
}

async function acquireLock() {
  const startedAt = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: false });
      fs.writeFileSync(path.join(LOCK_DIR, "owner.txt"), `${process.pid} ${new Date().toISOString()} ${PLUGIN_ID}\n`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) throw new Error(`等待 .wrangler/qa-run.lock 超过 40 分钟：${LOCK_DIR}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* 尽力释放 */
  }
}

async function serverHealthy(api: APIRequestContext) {
  try {
    const response = await api.get("/api/health");
    return response.status() === 200;
  } catch {
    return false;
  }
}

/** Playwright webServer 通常已拉起 8788；若未就绪则按团队约定后台启动 scripts/e2e-server.mjs。 */
async function ensureServer(api: APIRequestContext) {
  if (await serverHealthy(api)) return;
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["scripts/e2e-server.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TEMP: path.join(ROOT, ".wrangler", "tmpdir"), TMP: path.join(ROOT, ".wrangler", "tmpdir") },
  }).unref();
  const readyUrl = `http://127.0.0.1:8789/__e2e/ready`;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(1_000);
  }
  throw new Error("e2e-server 未能在 240 秒内就绪（8789 /__e2e/ready）");
}

async function viewerWith(headers: Record<string, string>) {
  const api = await openApi();
  try {
    const response = await api.get("/api/plugins/meta", { headers });
    const body = await readJson<{ data?: { viewer?: { admin?: boolean; id?: string | null } } }>(response);
    return body.data?.viewer ?? null;
  } finally {
    await api.dispose();
  }
}

/** fixtures 的 admin 会话可能被同库的 qa-local seed 覆盖；此时回退到 seed 的 admin 会话。 */
async function adminHeaders(fixtures: Fixtures) {
  const fromFixture = as(fixtures, "admin");
  const fixtureViewer = await viewerWith(fromFixture);
  if (fixtureViewer?.admin === true) return fromFixture;
  const seeded = { Cookie: `gauth_sid=${SEEDED_ADMIN_TOKEN}`, Origin: API_BASE };
  const seededViewer = await viewerWith(seeded);
  if (seededViewer?.admin === true) return seeded;
  throw new Error("本地没有可用的 admin 会话：fixtures admin 与 seed admin 都失效");
}

test.describe.configure({ mode: "serial", timeout: 45 * 60_000 });

test.describe("Phase 5 · 插件完整发布链（API 级 E2E）", () => {
  let fixtures: Fixtures;
  let admin: Record<string, string>;
  let developer: BrowserContext;
  let installer: BrowserContext;
  let adminContext: BrowserContext;
  let anonContext: BrowserContext;
  let keyPair: { privateKey: CryptoKey; publicKey: string; keyId: string; issuedAt: number; proof: string } | null = null;
  let installed = false;
  let approved = false;

  test.beforeAll(async ({ browser }) => {
    await acquireLock();
    const probe = await openApi();
    try {
      await ensureServer(probe);
      fixtures = await waitForFixtures("complete");
      admin = await adminHeaders(fixtures);
    } finally {
      await probe.dispose();
    }

    developer = await browser.newContext();
    installer = await browser.newContext();
    adminContext = await browser.newContext();
    anonContext = await browser.newContext();
    await developer.addCookies([{ name: "gauth_sid", value: fixtures.tokens.developer, url: API_BASE }]);
    await installer.addCookies([{ name: "gauth_sid", value: fixtures.tokens.installer, url: API_BASE }]);

    // 清理此前失败运行遗留的本 E2E 密钥，避免撞上 MAX_ACTIVE_KEYS。
    const devHeaders = as(fixtures, "developer");
    const listed = await developer.request.get("/api/developer/keys", { headers: devHeaders });
    const body = await readJson<{ data?: { keys?: Array<{ keyId?: string; label?: string; status?: string }> } }>(listed);
    for (const key of body.data?.keys ?? []) {
      if (key.status === "active" && key.keyId && String(key.label || "").startsWith(`p5-e2e-`)) {
        await developer.request.post(`/api/developer/keys/${key.keyId}/revoke`, {
          headers: devHeaders,
          data: { reason: "P5 E2E 遗留密钥清理" },
        });
      }
    }
  });

  test.afterAll(async () => {
    try {
      if (developer && fixtures) {
        const installerHeaders = as(fixtures, "installer");
        if (installed) {
          await installer.request.delete(`/api/plugins/${PLUGIN_ID}/install`, { headers: installerHeaders }).catch(() => null);
        }
        if (keyPair) {
          await developer.request
            .post(`/api/developer/keys/${keyPair.keyId}/revoke`, { headers: as(fixtures, "developer"), data: { reason: "P5 E2E 清理" } })
            .catch(() => null);
        }
      }
      if (adminContext && admin && approved) {
        await adminContext.request
          .post(`/api/plugins/admin/${PLUGIN_ID}/takedown`, { headers: admin, data: { reason: "P5 E2E 清理" } })
          .catch(() => null);
      }
      if (developer && fixtures && !approved) {
        // 发布链失败时插件仍是 draft，可直接删除草稿，避免本地累积测试插件。
        await developer.request
          .delete(`/api/developer/plugins/${PLUGIN_ID}`, { headers: as(fixtures, "developer") })
          .catch(() => null);
      }
      await Promise.allSettled([developer?.close(), installer?.close(), adminContext?.close(), anonContext?.close()]);
    } finally {
      releaseLock();
    }
  });

  test("发布、验签、下载、安装、下架后 409 全链路", async () => {
    const devHeaders = as(fixtures, "developer");
    const installerHeaders = as(fixtures, "installer");
    const anonHeaders = { Origin: API_BASE };

    // [1] 环境与开发者身份
    const health = await developer.request.get("/api/health");
    expectStatus(health, 200);
    const profile = await developer.request.get("/api/developer/profile", { headers: devHeaders });
    const profileBody = await readJson<{ data?: { profile?: { id?: string } } }>(profile);
    const developerId = profileBody.data?.profile?.id;
    expect(developerId).toBeTruthy();

    // [2] 草稿插件
    const created = await developer.request.post("/api/developer/plugins", {
      headers: devHeaders,
      data: { id: PLUGIN_ID, name: PLUGIN_NAME, type: "application", category: "developer", license: "MIT", description: "P5 E2E 发布链" },
    });
    expectStatus(created, 200);
    const createdBody = await readJson<{ data?: { plugin?: { id?: string; status?: string } } }>(created);
    expect(createdBody.data?.plugin?.id).toBe(PLUGIN_ID);
    expect(createdBody.data?.plugin?.status).toBe("draft");

    // [3] Ed25519 密钥登记 + 签名上传
    const subtle = crypto.webcrypto.subtle;
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
    const rawPublicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    const publicKey = base64urlEncode(rawPublicKey);
    const keyId = await keyIdForPublicKey(rawPublicKey);
    const issuedAt = Date.now();
    const proof = base64urlEncode(
      new Uint8Array(
        await subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          new TextEncoder().encode(registerProofPayloadText({ userId: developerId!, publicKey, keyId, issuedAt })),
        ),
      ),
    );
    keyPair = { privateKey: pair.privateKey, publicKey, keyId, issuedAt, proof };
    const keyResponse = await developer.request.post("/api/developer/keys", {
      headers: devHeaders,
      data: { publicKey, keyId, issuedAt, proof, label: `p5-e2e-${runSuffix}` },
    });
    expectStatus(keyResponse, 200);
    const keyBody = await readJson<{ data?: { key?: { keyId?: string; status?: string } } }>(keyResponse);
    expect(keyBody.data?.key?.keyId).toBe(keyId);
    expect(keyBody.data?.key?.status).toBe("active");

    const bundle = buildBundle();
    const digests = await bundleDigests(JSON.parse(bundle.text), JSON.parse(bundle.text).files);
    const envelope = buildSignatureEnvelope({
      keyId,
      publisherId: developerId!,
      pluginId: PLUGIN_ID,
      version: VERSION,
      filesDigest: digests.filesDigest,
      manifestDigest: digests.manifestDigest,
      signedAt: Date.now(),
    });
    const signatureBytes = await signEd25519(pair.privateKey, signaturePayloadBytes(envelope));
    const signature = { ...envelope, sig: base64urlEncode(signatureBytes) };

    const upload = await developer.request.post(`/api/developer/plugins/${PLUGIN_ID}/versions`, {
      headers: devHeaders,
      data: { bundle: bundle.text, changelog: `E2E ${VERSION}`, signature },
    });
    expectStatus(upload, 200);
    const uploadBody = await readJson<{
      data?: { version?: { version?: string; checksum?: string; signature?: { status?: string; keyId?: string } } };
    }>(upload);
    expect(uploadBody.data?.version?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(uploadBody.data?.version?.signature?.status).toBe("verified");
    expect(uploadBody.data?.version?.signature?.keyId).toBe(keyId);

    // [4] 提交审核；匿名 401、普通用户 403
    const submit = await developer.request.post(`/api/developer/plugins/${PLUGIN_ID}/submit`, { headers: devHeaders, data: {} });
    expectStatus(submit, 200);
    const submitBody = await readJson<{ data?: { status?: string } }>(submit);
    expect(submitBody.data?.status).toBe("pending_review");

    const anonReview = await anonContext.request.post(`/api/plugins/admin/${PLUGIN_ID}/review`, {
      headers: anonHeaders,
      data: { decision: "approve", version: VERSION },
    });
    expectStatus(anonReview, 401);
    const memberReview = await installer.request.post(`/api/plugins/admin/${PLUGIN_ID}/review`, {
      headers: installerHeaders,
      data: { decision: "approve", version: VERSION },
    });
    expectStatus(memberReview, 403);

    // [5] admin 审核通过 → 市场可见且签名 verified
    const approve = await adminContext.request.post(`/api/plugins/admin/${PLUGIN_ID}/review`, {
      headers: admin,
      data: { decision: "approve", version: VERSION },
    });
    expectStatus(approve, 200);
    const approveBody = await readJson<{ data?: { status?: string; version?: string } }>(approve);
    expect(approveBody.data?.status).toBe("published");
    approved = true;

    const market = await installer.request.get(`/api/plugins?q=${encodeURIComponent(PLUGIN_NAME)}`, { headers: installerHeaders });
    expectStatus(market, 200);
    const marketBody = await readJson<{
      data?: { items?: Array<{ id?: string; security?: { audited?: boolean; signature?: { status?: string; keyId?: string } } }> };
    }>(market);
    const listedPlugin = (marketBody.data?.items ?? []).find((item) => item.id === PLUGIN_ID);
    expect(listedPlugin).toBeTruthy();
    expect(listedPlugin?.security?.audited).toBe(true);
    expect(listedPlugin?.security?.signature?.status).toBe("verified");
    expect(listedPlugin?.security?.signature?.keyId).toBe(keyId);

    const detail = await installer.request.get(`/api/plugins/${PLUGIN_ID}`, { headers: installerHeaders });
    expectStatus(detail, 200);
    const detailBody = await readJson<{
      data?: { plugin?: { security?: { signature?: { status?: string } } }; installation?: unknown };
    }>(detail);
    expect(detailBody.data?.plugin?.security?.signature?.status).toBe("verified");
    expect(detailBody.data?.installation).toBeFalsy();

    // [6] 匿名下载 401；登录下载并本地复算 SHA-256
    const anonPackage = await anonContext.request.get(`/api/plugins/${PLUGIN_ID}/package?version=${VERSION}`, { headers: anonHeaders });
    expectStatus(anonPackage, 401);
    const packageResponse = await installer.request.get(`/api/plugins/${PLUGIN_ID}/package?version=${VERSION}`, { headers: installerHeaders });
    expectStatus(packageResponse, 200);
    const packageBody = await readJson<{
      data?: { checksum?: string; packageJson?: string; signature?: { status?: string }; publisherKeys?: Array<{ keyId?: string; status?: string }> };
    }>(packageResponse);
    const packageJson = packageBody.data?.packageJson ?? "";
    expect(packageJson.length).toBeGreaterThan(0);
    expect(sha256(packageJson)).toBe(packageBody.data?.checksum);
    expect(packageBody.data?.signature?.status).toBe("verified");
    expect((packageBody.data?.publisherKeys ?? []).some((key) => key.keyId === keyId && key.status === "active")).toBe(true);

    // [7] 安装成功 + 安装记录
    const install = await installer.request.post("/api/plugins/install", {
      headers: installerHeaders,
      data: { pluginId: PLUGIN_ID, version: VERSION, packageHash: packageBody.data?.checksum, permissions: PERMISSIONS },
    });
    expectStatus(install, 200);
    const installBody = await readJson<{ data?: { installation?: { version?: string }; signature?: { status?: string } } }>(install);
    expect(installBody.data?.installation?.version).toBe(VERSION);
    expect(installBody.data?.signature?.status).toBe("verified");
    installed = true;

    const installedList = await installer.request.get("/api/plugins/installed", { headers: installerHeaders });
    expectStatus(installedList, 200);
    const installedBody = await readJson<{
      data?: { items?: Array<{ id?: string; version?: string; granted?: string[]; security?: { signature?: { status?: string } }; installation?: { version?: string } }> };
    }>(installedList);
    const installedItem = (installedBody.data?.items ?? []).find((item) => item.id === PLUGIN_ID);
    expect(installedItem).toBeTruthy();
    expect(installedItem?.installation?.version).toBe(VERSION);
    expect(installedItem?.granted).toEqual(PERMISSIONS);
    expect(installedItem?.security?.signature?.status).toBe("verified");

    // [8] 紧急下架（admin takedown）→ 下载/安装 409
    const takedown = await adminContext.request.post(`/api/plugins/admin/${PLUGIN_ID}/takedown`, {
      headers: admin,
      data: { reason: "P5 E2E 下架验证" },
    });
    expectStatus(takedown, 200);
    const takedownBody = await readJson<{ data?: { status?: string } }>(takedown);
    expect(takedownBody.data?.status).toBe("blocked");

    const blockedDownload = await installer.request.get(`/api/plugins/${PLUGIN_ID}/package?version=${VERSION}`, { headers: installerHeaders });
    expectStatus(blockedDownload, 409);
    const blockedDownloadBody = await readJson<{ error?: { code?: string } }>(blockedDownload);
    expect(blockedDownloadBody.error?.code).toBe("NOT_PUBLISHED");

    const blockedInstall = await installer.request.post("/api/plugins/install", {
      headers: installerHeaders,
      data: { pluginId: PLUGIN_ID, version: VERSION, packageHash: packageBody.data?.checksum, permissions: PERMISSIONS },
    });
    expectStatus(blockedInstall, 409);
    const blockedInstallBody = await readJson<{ error?: { code?: string } }>(blockedInstall);
    expect(blockedInstallBody.error?.code).toBe("PLUGIN_BLOCKED");
  });
});
