/**
 * 2.0.6 · `adminUserRestriction` 的权限对等（确定性单测）
 *
 * 真实 E2E 的 qa-p3-* 账号是短 id（`qa-p3-installer`），而管理用户接口要求
 * 目标 id 是 UUID（`admin.js` 里的 `UUID.test(id)`），所以用真实 Worker 只能测
 * 管理员封禁/解除。审核员的边界（解除管理员封禁、碰同级审核员、自锁）在这里用
 * 假 D1 直接跑真实函数，断言「抛错且没有写库」。
 */
import { describe, expect, it } from "vitest";

import { adminUserRestriction } from "../../worker/api/community/admin";

const TARGET = "3f6f2a1c-8d4b-4f2e-9a77-6c1d5b8e0a01";

type Run = { sql: string; binds: unknown[] };

function fakeEnv(target: Record<string, unknown>) {
  const runs: Run[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        binds: [] as unknown[],
        bind(...args: unknown[]) {
          statement.binds = args;
          return statement;
        },
        async first() {
          return sql.includes("FROM users u") ? target : null;
        },
        async run() {
          runs.push({ sql, binds: statement.binds });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return { env: { DB: db }, runs };
}

function request(body: unknown) {
  const text = JSON.stringify(body);
  return {
    headers: new Headers({ "content-length": String(Buffer.byteLength(text)) }),
    async text() {
      return text;
    },
  };
}

function profileWrites(runs: Run[]) {
  return runs.filter((run) => run.sql.includes("INSERT INTO community_profiles"));
}

const memberTarget = {
  id: TARGET,
  role: "member",
  github_username: "qa-target",
  display_name: "QA 目标",
  restriction: "blocked",
  moderator_role: null,
};

describe("社区发布限制的权限对等", () => {
  it("审核员不能把管理员封禁改回 none（403，且不写库）", async () => {
    const { env, runs } = fakeEnv(memberTarget);
    await expect(
      adminUserRestriction({
        env,
        request: request({ restriction: "none", reason: "qa" }),
        viewer: { id: "qa-p3-installer", role: "moderator" },
        id: TARGET,
      } as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(profileWrites(runs)).toHaveLength(0);
  });

  it("审核员也不能封禁别人（409/403 级别的边界）", async () => {
    const { env, runs } = fakeEnv({ ...memberTarget, restriction: "none" });
    await expect(
      adminUserRestriction({
        env,
        request: request({ restriction: "blocked", reason: "qa" }),
        viewer: { id: "qa-p3-installer", role: "moderator" },
        id: TARGET,
      } as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(profileWrites(runs)).toHaveLength(0);
  });

  it("审核员可以下调到 limited", async () => {
    const { env, runs } = fakeEnv({ ...memberTarget, restriction: "none" });
    const response = await adminUserRestriction({
      env,
      request: request({ restriction: "limited", reason: "qa" }),
      viewer: { id: "qa-p3-installer", role: "moderator" },
      id: TARGET,
    } as any);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, data: { restriction: "limited" } });
    const [write] = profileWrites(runs);
    expect(write.binds).toContain("limited");
  });

  it("审核员不能改同级审核员的限制", async () => {
    const { env, runs } = fakeEnv({ ...memberTarget, restriction: "limited", moderator_role: "moderator" });
    await expect(
      adminUserRestriction({
        env,
        request: request({ restriction: "none", reason: "qa" }),
        viewer: { id: "qa-p3-installer", role: "moderator" },
        id: TARGET,
      } as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(profileWrites(runs)).toHaveLength(0);
  });

  it("管理员可以解除封禁", async () => {
    const { env, runs } = fakeEnv(memberTarget);
    const response = await adminUserRestriction({
      env,
      request: request({ restriction: "none", reason: "qa" }),
      viewer: { id: "qa-p3-admin", role: "admin" },
      id: TARGET,
    } as any);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, data: { restriction: "none" } });
    expect(profileWrites(runs).length).toBe(1);
  });

  it("任何人都不能改自己的限制（防自锁）", async () => {
    const { env, runs } = fakeEnv({ ...memberTarget, restriction: "none" });
    await expect(
      adminUserRestriction({
        env,
        request: request({ restriction: "limited", reason: "qa" }),
        viewer: { id: TARGET, role: "admin" },
        id: TARGET,
      } as any),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    expect(profileWrites(runs)).toHaveLength(0);
  });
});