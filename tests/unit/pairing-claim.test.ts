/**
 * 2.0.4 · 并发领取配对 Session 的状态机（确定性证据）
 *
 * E2E 的并发请求在本机很难稳定撞进「两个请求都读到 confirmed」的窗口，
 * 所以这里用假 D1 把交错直接摆出来：两个请求都读到同一行 confirmed，
 * 但只有一个能把状态 UPDATE 成 completed（meta.changes = 1），另一个必须
 * 拿到 alreadyDelivered 而不是第二条 Session。
 *
 * 负向对照：把 worker/api/pairing/handlers.js 回滚到 2.0.3，第二个用例会因为
 * 「losing request 仍然 INSERT sessions」而失败（假 D1 在该路径上直接抛错）。
 */
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../worker/api/auth/crypto.js";
import { handlePairingRequest } from "../../worker/api/pairing/handlers.js";

const PAIRING_ID = "2f1cbb4e-6a1e-4a1a-9c76-2f4a3f1f9b11";
const CLAIM_SECRET = "claim-secret-2.0.4";
const USER_ID = "u-qa-1";
const TARGET_DEVICE = "qa-target-device";
const ORIGIN = "http://127.0.0.1:8788";

interface Statement {
  bind(...args: unknown[]): Statement;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
  all(): Promise<{ results: unknown[]; success: boolean }>;
}

interface FakeDb {
  prepare(sql: string): Statement;
}

function fakeEnv({ updateChanges, throwOnSessionInsert = false }: { updateChanges: number; throwOnSessionInsert?: boolean }) {
  const counts = { sessions: 0, completedUpdates: 0 };
  let secretHash = "";

  const db: FakeDb = {
    prepare(sql) {
      const statement: Statement = {
        bind() {
          return statement;
        },
        async first() {
          if (/FROM device_pairings WHERE id = \?/.test(sql)) {
            return {
              id: PAIRING_ID,
              user_id: USER_ID,
              source_device_id: "qa-source-device",
              target_device_id: TARGET_DEVICE,
              token_hash: "t",
              code_hash: "c",
              claim_secret_hash: secretHash,
              status: "confirmed",
              expires_at: Date.now() + 5 * 60_000,
              created_at: Date.now() - 60_000,
              target_name: "QA 新设备",
              target_type: "mobile",
              target_browser: "Chrome",
              target_os: "Android",
              target_user_agent: "e2e-fixtures",
            };
          }
          if (/FROM users WHERE id = \?/.test(sql)) {
            return { display_name: "QA 安装者", github_username: null, avatar_url: null };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO sessions/.test(sql)) {
            counts.sessions += 1;
            if (throwOnSessionInsert) throw new Error("落败的领取请求不应创建 Session");
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE device_pairings SET status = 'completed'/.test(sql)) {
            counts.completedUpdates += 1;
            return { success: true, meta: { changes: updateChanges } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          return { results: [], success: true };
        },
      };
      return statement;
    },
  };

  return {
    env: { DB: db },
    counts,
    setSecretHash: (hash: string) => {
      secretHash = hash;
    },
  };
}

async function claim(env: { DB: FakeDb }) {
  const request = new Request(`${ORIGIN}/api/pairing/claim/${PAIRING_ID}?secret=${CLAIM_SECRET}`, { method: "GET" });
  const url = new URL(request.url);
  const response = await handlePairingRequest({ request, env, url, path: url.pathname });
  if (!response) throw new Error("配对领取接口没有返回响应");
  const body = (await response.json()) as { data: { paired?: boolean; alreadyDelivered?: boolean } };
  return { response, body };
}

describe("设备配对 · 并发领取只签发一个 Session（2.0.4）", () => {
  it("抢到状态转换的请求获得 Session，并且在状态更新之后才写入", async () => {
    const harness = fakeEnv({ updateChanges: 1 });
    harness.setSecretHash(await sha256Hex(CLAIM_SECRET));

    const { response, body } = await claim(harness.env);

    expect(response.status).toBe(200);
    expect(body.data.paired).toBe(true);
    expect(body.data.alreadyDelivered).toBeUndefined();
    expect(harness.counts.sessions).toBe(1);
    expect(harness.counts.completedUpdates).toBe(1);
    expect(response.headers.get("set-cookie") ?? "").toContain("gauth_sid=");
  });

  it("没抢到状态转换的请求返回 alreadyDelivered，绝不创建第二条 Session", async () => {
    const harness = fakeEnv({ updateChanges: 0, throwOnSessionInsert: true });
    harness.setSecretHash(await sha256Hex(CLAIM_SECRET));

    const { response, body } = await claim(harness.env);

    expect(response.status).toBe(200);
    expect(body.data.alreadyDelivered).toBe(true);
    expect(harness.counts.sessions).toBe(0);
    expect(harness.counts.completedUpdates).toBe(1);
  });
});