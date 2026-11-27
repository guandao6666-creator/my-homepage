/**
 * 2.0.11 · 同步增量拉取的游标分页（真实 Worker + 真实 D1）
 *
 * 为什么必须走真实栈：单测（tests/unit/sync-cursor.test.ts）已经证明 SQL 元组比较不丢行，
 * 但协议层是否把 nextCursor 透出、客户端带 cursor 时是否被接受，只有真实 Worker 能回答。
 * 用例 1 顺序 push 三条 notes，再用 limit=2 翻页，断言两页并集正好三条、无重复；
 * 用例 2 断言格式错误的 cursor 得到 400 INVALID_CURSOR（而不是静默当 since 用）。
 *
 * 前置：e2e-server 的 POST /__e2e/reset-sync 清掉 qa 账号的同步台账，保证从空表开始。
 */
import { expect, test } from "@playwright/test";

import { expectError, okData, type ApiActor } from "./support/device-flow";
import {
  newSyncDevice,
  resetSyncFixtures,
  syncPull,
  syncPush,
  type SyncEntity,
  type SyncPush,
} from "./support/sync-flow";
import { waitForFixtures, type Fixtures } from "./support/worker-api";

type SyncPullPage = {
  domain: string;
  serverTime: number;
  changes: SyncEntity[];
  hasMore: boolean;
  nextCursor: string | null;
};

let fixtures: Fixtures;
let actor: ApiActor;

const RUN_ID = `sync-cursor-${Date.now()}`;
const IDS = [`${RUN_ID}-a`, `${RUN_ID}-b`, `${RUN_ID}-c`];

test.describe("2.0.11 · 同步游标分页", () => {
  test.beforeAll(async ({ browser }) => {
    fixtures = await waitForFixtures("complete");
    actor = await newSyncDevice(browser, fixtures, "installer");
    const reset = await resetSyncFixtures(actor, fixtures.adminUrl);
    expect(reset.ok, "同步台账应当被清理").toBe(true);
  });

  test.afterAll(async () => {
    await actor?.context.close();
  });

  test("limit=2 翻两页取全三条：nextCursor 透出且不重不漏", async () => {
    for (const id of IDS) {
      const pushed = okData<SyncPush>(
        await syncPush(actor, "notes", [{ id, baseRevision: 0, updatedAt: Date.now(), payload: { title: id, body: "cursor", tags: [] } }]),
        200,
        `推送 ${id}`,
      );
      expect(pushed.applied.length, `${id} 应当写入`).toBe(1);
    }

    const first = okData<SyncPullPage>(await syncPull(actor, "notes", { limit: 2 }), 200, "第一页");
    expect(first.changes).toHaveLength(2);
    expect(typeof first.nextCursor, "第一页应当带回 nextCursor").toBe("string");
    expect(first.nextCursor!.includes(":")).toBe(true);

    const second = okData<SyncPullPage>(
      await syncPull(actor, "notes", { limit: 2, cursor: first.nextCursor! }),
      200,
      "第二页",
    );
    const seen = [...first.changes, ...second.changes].map((change) => change.id);
    expect(new Set(seen).size, "两页之间不应重复").toBe(seen.length);
    for (const id of IDS) expect(seen, `三条都应当被取到（${id}）`).toContain(id);
    expect(seen).toHaveLength(IDS.length);
  });

  test("格式错误的 cursor 返回 400 INVALID_CURSOR", async () => {
    const bad = expectError(await syncPull(actor, "notes", { cursor: "not-a-cursor" }), 400, "INVALID_CURSOR", "非法游标");
    expect(bad.code).toBe("INVALID_CURSOR");
  });
});