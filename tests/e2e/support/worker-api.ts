/**
 * Phase 3 · 真实 Worker E2E 辅助。
 *
 * `scripts/e2e-server.mjs` 在后台启动 `wrangler dev --local`（本地 D1/R2）并生成 QA 夹具，
 * 把结果写进 `.wrangler/e2e-fixtures.json`。这里的职责：
 *   1. 等夹具就绪（分 stage，设备/OAuth 只等账号，插件签名等全量）；
 *   2. 读夹具拿 QA 账号的 session token；
 *   3. 提供 `openApi()` 与带 Cookie 的请求封装。
 *
 * 注意：夹具里的 token 只存在于本机 `.wrangler/`（已被 .gitignore 覆盖），
 * 对应账号全部是 `qa-p3-*` 本地 D1 行，不涉及任何真实用户。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
export const FIXTURE_FILE = path.join(ROOT, ".wrangler", "e2e-fixtures.json");
export const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${process.env.E2E_API_PORT || 8788}`;

export type FixtureRole = "developer" | "installer" | "installer2" | "admin" | "outsider" | "crowded";

export type ExpiredPairingFixture = {
  /** 6 位码与 token 都已过期的 pending 配对。 */
  pending: { id: string; code: string; token: string };
  /** 新设备已认领、旧设备未批准且已过期的 claimed 配对。 */
  claimed: { id: string; token: string; claimSecret: string };
};

export type Fixtures = {
  baseUrl: string;
  /** 仅本地 e2e-server 提供的夹具管理端点（127.0.0.1:PORT+1），生产不存在。 */
  adminUrl?: string;
  generatedAt: number;
  stage: "booting" | "accounts" | "complete";
  tokens: Record<FixtureRole, string>;
  users: Record<string, string>;
  expiredPairing: ExpiredPairingFixture;
  plugins: Record<string, { id: string; version: string }>;
  keys: Record<string, string>;
};

function tryRead(): Fixtures | null {
  try {
    const text = fs.readFileSync(FIXTURE_FILE, "utf8");
    const parsed = JSON.parse(text) as Fixtures;
    return parsed && typeof parsed.stage === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 等夹具到指定阶段。
 * `accounts` 在 Worker 就绪、账号/Session/设备写入之后立刻发布；
 * `complete` 要等插件夹具全部生成（含 Ed25519 签名与审核）。
 */
export async function waitForFixtures(
  stage: "accounts" | "complete",
  { timeoutMs = 240_000, pollMs = 500 } = {},
): Promise<Fixtures> {
  const deadline = Date.now() + timeoutMs;
  let lastStage = "none";
  while (Date.now() < deadline) {
    const fixtures = tryRead();
    if (fixtures) {
      lastStage = fixtures.stage;
      const ready =
        stage === "accounts"
          ? fixtures.stage === "accounts" || fixtures.stage === "complete"
          : fixtures.stage === "complete";
      if (ready) return fixtures;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`等待 E2E 夹具超时（目标 stage=${stage}，最后看到 stage=${lastStage}）：${FIXTURE_FILE}`);
}

/** 独立于浏览器 context 的 API 客户端（不做 Cookie 共享）。 */
export function openApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: API_BASE, timeout: 20_000 });
}

/**
 * 夹具 token → 请求头。服务端只认 `gauth_sid` Cookie。
 *
 * 写接口（安装、上传、配对确认…）会走 `assertSameOrigin`，而 Playwright 的
 * `request` 不带浏览器自动加上的 Origin，所以这里显式补上——不是绕过校验，
 * 是补齐浏览器本来就会发的头。
 */
export function as(fixtures: Fixtures, role: FixtureRole): { Cookie: string; Origin: string } {
  const token = fixtures.tokens[role];
  if (!token) throw new Error(`夹具里没有 ${role} 的 token`);
  return { Cookie: `gauth_sid=${token}`, Origin: API_BASE };
}

/** 解析 `{success,data}` 信封；失败时把整个响应体带进错误信息。 */
export async function readJson<T = any>(response: { status(): number; text(): Promise<string> }): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`响应不是 JSON（${response.status()}）：${text.slice(0, 300)}`);
  }
}

/** 记录安全事件的接口在测试里不该产生噪音，这里只做静默调用。 */
export async function expectStatus(
  response: { status(): number; text(): Promise<string> },
  expected: number,
): Promise<any> {
  const body = await readJson(response);
  if (response.status() !== expected) {
    throw new Error(`期望 HTTP ${expected}，实际 ${response.status()}：${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}