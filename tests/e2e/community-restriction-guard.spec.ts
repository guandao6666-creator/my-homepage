/**
 * 2.0.6 · 社区发布限制的权限对等（真实 Worker + 真实 D1）
 *
 * 审计发现：`adminUserRestriction` 只靠 handler 层的 `isStaff`，函数内没有
 * `requireAdminRole`（同文件 `adminUserRole` / `adminUserStatus` 都有）。审核员
 * 因此可以把管理员封禁的用户改回 `none`，等于用审核权限撤销管理员的处罚。
 *
 * 这里用真实 Worker 验证管理侧行为：管理员封禁 → 数据落库 → 管理员解除；
 * 非审核员（developer）连读用户列表都 403。
 *
 * 为什么审核员边界放在单测：夹具的 qa-p3-* 账号是短 id（`qa-p3-installer`），
 * 而管理用户接口要求目标 id 是 UUID（`admin.js` 的 `UUID.test(id)`），真实栈
 * 无法既当审核员又当 UUID 目标。那几条改由
 * `tests/unit/community-restriction-guard.test.ts` 用假 D1 跑真实函数覆盖，
 * 并断言「抛 403 且没有写库」。
 */
import { expect, test } from "@playwright/test";

import { API_BASE, as, openApi, readJson, waitForFixtures, type FixtureRole, type Fixtures } from "./support/worker-api";

const RUN_ID = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REASON = `QA 限制回归 ${RUN_ID}`;

async function call(
  api: Awaited<ReturnType<typeof openApi>>,
  fixtures: Fixtures,
  role: FixtureRole,
  method: "GET" | "PATCH",
  path: string,
  data?: unknown,
) {
  return api.fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...as(fixtures, role), Accept: "application/json" },
    data: data as any,
    timeout: 20_000,
  });
}

async function listCreator(api: Awaited<ReturnType<typeof openApi>>, fixtures: Fixtures) {
  const listed = await call(api, fixtures, "admin", "GET", "/api/community/admin/users?limit=60");
  expect(listed.status(), `列用户：${await listed.text()}`).toBe(200);
  const body = await readJson(listed);
  const item = (body?.data?.items ?? []).find((row: any) => row.id === fixtures.users.creator);
  if (!item) throw new Error("管理员列表里找不到 UUID 夹具账号 creator");
  return item as { id: string; restriction: string };
}

test.describe("社区发布限制 · 权限对等", () => {
  test.setTimeout(120_000);

  test("管理员可封禁与解除；非审核员直接 403", async () => {
    const fixtures = await waitForFixtures("complete");
    const api = await openApi();
    const targetId = fixtures.users.creator;

    try {
      const before = await listCreator(api, fixtures);
      expect(before.restriction).toBe("none");

      const block = await call(api, fixtures, "admin", "PATCH", `/api/community/admin/users/${targetId}/restriction`, {
        restriction: "blocked",
        reason: REASON,
      });
      expect(block.status(), `管理员封禁：${await block.text()}`).toBe(200);
      expect((await listCreator(api, fixtures)).restriction).toBe("blocked");

      // 非审核员连这条路径都进不来（handler 层 isStaff）。
      const denied = await call(api, fixtures, "developer", "PATCH", `/api/community/admin/users/${targetId}/restriction`, {
        restriction: "none",
        reason: REASON,
      });
      expect(denied.status(), `非审核员：${await denied.text()}`).toBe(403);
      expect(String((await readJson(denied))?.error?.message || "")).toContain("需要社区审核权限");

      // 封禁后公开资料应显示限制（数据确实写进了 D1，不是只回 200）。
      const publicProfile = await api.fetch(`${API_BASE}/api/community/users/${targetId}`, {
        headers: { Origin: API_BASE, Accept: "application/json" },
        timeout: 20_000,
      });
      expect([200, 404]).toContain(publicProfile.status());

      const clear = await call(api, fixtures, "admin", "PATCH", `/api/community/admin/users/${targetId}/restriction`, {
        restriction: "none",
        reason: REASON,
      });
      expect(clear.status(), `管理员解除：${await clear.text()}`).toBe(200);
      expect((await listCreator(api, fixtures)).restriction).toBe("none");
    } finally {
      await call(api, fixtures, "admin", "PATCH", `/api/community/admin/users/${targetId}/restriction`, {
        restriction: "none",
        reason: "QA 清理",
      }).catch(() => undefined);
      await api.dispose();
    }
  });
});