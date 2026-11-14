/**
 * Phase 4 云同步端到端测试：双设备（双 Browser Context）同步 / 冲突 / 墓碑。
 *
 * 为什么用两个真实 Browser Context + context.request 做协议级验证：
 *   - 任务要求验证的是「同一账号两台设备」的真实隔离：Cookie、会话、deviceId 必须
 *     各自独立，数据又必须经服务端互见。两个 browser.newContext() 各注入一份
 *     seeded 会话（installer / installer2，同一账号 qa-p3-installer 的两台设备），
 *     再用 context.request 发真实 HTTP 请求，最贴近客户端 SyncProvider 的调用。
 *   - dist/ 是 Phase 4 客户端同步代码合入之前的旧构建（构建时间 2026/11/9 12:43，
 *     src/lib/sync/conflicts.ts 与 bridge.ts 的 mtime 是 13:41-13:44；在 dist 里
 *     grep 不到 syncConflicts / syncResolveConflict），页面里的 window.GOS20 尚无冲突
 *     API。重建 dist 会与并行的 UI task-3 / 其他 E2E 争用构建与端口资源，所以本文件
 *     不做 page.evaluate 的客户端断言。
 *
 * 未覆盖项（由单测或其他任务承担，报告中如实标注）：
 *   - 客户端记录冲突 / 「保留本地 / 保留云端」的本地状态机（src/lib/sync/providers.ts
 *     的 resolveSyncConflict）：tests/unit/sync-conflicts.test.ts 已直接 import 该函数覆盖
 *     local / remote / 重复调用 / 离线 / 记录缺失；此处验证的是它依赖的服务端契约。
 *   - Workspace / Preferences 应用到本地存储、设备级设置不被云端覆盖：
 *     tests/unit/sync-workspace.test.ts（applyRemoteWorkspace）、
 *     tests/unit/sync-preferences.test.ts（applyPreferencesPayload 的 deviceOnly 拒绝）。
 *   - 5000 活实体 / 2000 墓碑的 409 QUOTA_EXCEEDED：触发需要写满配额，成本高、会污染
 *     D1；改为断言 status 返回的 limits 常量与计数自洽（见用例 2、4、8）。
 *   - 页面级 UI 展示（冲突提示、同步状态灯）：等待 UI task-3 合入后由页面测试补。
 *
 * 前置依赖：scripts/e2e-server.mjs 提供本地 wrangler dev（8788）+ admin（8789）；
 * POST /__e2e/reset-sync 清理 qa 账号的 sync_entities / sync_tombstone_ledger /
 * sync_cleanup_log。用例开始与结束各调用一次，保证计数断言从 0 出发、结束后不留脏数据。
 */
import { expect, test } from "@playwright/test";

import {
  api,
  cookiesOf,
  expectError,
  okData,
  type ApiActor,
} from "./support/device-flow";
import {
  SYNC_DOMAINS,
  SYNC_LIMITS,
  entityOf,
  newSyncDevice,
  paddedPayload,
  preferencesPayload,
  resetSyncFixtures,
  syncIndex,
  syncPull,
  syncPush,
  syncStatus,
  workspacePayload,
  type SyncIndex,
  type SyncPull,
  type SyncPush,
  type SyncStatus,
} from "./support/sync-flow";
import { API_BASE, waitForFixtures, type Fixtures } from "./support/worker-api";

let fixtures: Fixtures;
/** 同一账号（qa-p3-installer）的两台设备：A = installer 会话，B = installer2 会话。 */
let a: ApiActor;
let b: ApiActor;
/** 隔离账号：验证不同 user_id 之间互不可见。 */
let outsider: ApiActor;

const WORKSPACE_ID = "ws-sync-e2e";
const PREFERENCES_ID = "preferences";
const CONFLICT_NOTE_ID = "note-sync-e2e-conflict";
const OVERSIZE_WORKSPACE_ID = "ws-sync-e2e-oversize";

/** serial 用例之间共享的 revision / updatedAt 基线（相当于两台设备各自的本地同步状态）。 */
let workspaceRevision = 0;
let workspaceUpdatedAt = 0;
let conflictNoteRevision = 0;

test.describe("Phase 4 云同步：双设备同步 / 冲突 / 墓碑", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    // 前面的 e2e-server webServer 已推进到 complete（admin 探针就绪后才进入测试）。
    fixtures = await waitForFixtures("complete");
    a = await newSyncDevice(browser, fixtures, "installer");
    b = await newSyncDevice(browser, fixtures, "installer2");

    // e2e-server 只在启动时清库；进程若被它人复用，可能残留上一轮同步数据。先清空，
    // 让下面所有配额 / 域计数断言有确定的起点（同时验证 reset-sync 真的可用）。
    const reset = await resetSyncFixtures(a, fixtures.adminUrl);
    expect(reset.ok, "POST /__e2e/reset-sync 应成功").toBe(true);

    const clean = okData<SyncStatus>(await syncStatus(a), 200, "清理后 GET /api/sync/status");
    expect(clean.quotas, "清理后配额计数应为 0").toEqual({
      entityCount: 0,
      tombstoneCount: 0,
      limits: { maxEntities: SYNC_LIMITS.maxEntities, maxTombstones: SYNC_LIMITS.maxTombstones },
    });
  });

  test.afterAll(async () => {
    if (!fixtures || !a) return;
    try {
      await resetSyncFixtures(a, fixtures.adminUrl);
      const status = okData<SyncStatus>(await syncStatus(a), 200, "清理后 GET /api/sync/status");
      for (const domain of status.domains) {
        expect(domain.count, `清理后 ${domain.domain} 域应为空`).toBe(0);
        expect(domain.tombstones, `清理后 ${domain.domain} 域不应有墓碑`).toBe(0);
      }
      expect(status.quotas.entityCount, "清理后活实体应为 0").toBe(0);
      expect(status.quotas.tombstoneCount, "清理后墓碑应为 0").toBe(0);
    } finally {
      await outsider?.context.close();
      await a.context.close();
      await b.context.close();
    }
  });

  test("1. 双设备身份：两个真实 Browser Context、Cookie 隔离、匿名 401", async ({ browser }) => {
    expect(a.context, "A/B 必须是两个不同的 Browser Context").not.toBe(b.context);

    const cookiesA = await cookiesOf(a);
    const cookiesB = await cookiesOf(b);
    expect(cookiesA.session, "A 的 gauth_sid 应来自 installer 会话").toBe(fixtures.tokens.installer);
    expect(cookiesB.session, "B 的 gauth_sid 应来自 installer2 会话").toBe(fixtures.tokens.installer2);
    expect(cookiesA.session, "两台设备的会话 token 必须不同").not.toBe(cookiesB.session);

    // 同一账号、不同设备：user.id 相同，deviceId 不同（服务端按会话判定设备）。
    // 注意 /api/auth/me 不走 {success,data} 信封，直接返回 {authenticated,user,session}。
    type MeBody = { authenticated: boolean; user: { id: string }; session: { deviceId: string } };
    const meAResult = await api(a, "GET", "/api/auth/me");
    const meBResult = await api(b, "GET", "/api/auth/me");
    expect(meAResult.status, "A GET /api/auth/me 应 200").toBe(200);
    expect(meBResult.status, "B GET /api/auth/me 应 200").toBe(200);
    const meA = meAResult.body as MeBody;
    const meB = meBResult.body as MeBody;
    expect(meA.authenticated, "A 应已登录").toBe(true);
    expect(meA.user.id, "A 是 qa-p3-installer").toBe("qa-p3-installer");
    expect(meB.user.id, "B 与 A 是同一账号").toBe("qa-p3-installer");
    expect(meA.session.deviceId, "A 是第一台设备").toBe("qa-p3-installer-device");
    expect(meB.session.deviceId, "B 是第二台设备").toBe("qa-p3-installer-device-2");

    // 空白 Context 没有 Cookie：同步接口必须 401，证明上面的 Cookie 没有跨 Context 泄漏。
    const anonymous = await browser.newContext();
    try {
      const response = await anonymous.request.fetch(new URL("/api/sync/status", API_BASE).toString(), {
        headers: { accept: "application/json" },
        failOnStatusCode: false,
      });
      expect(response.status(), "匿名访问 /api/sync/status 应 401").toBe(401);
      const body = await response.json();
      expect(body, "匿名应返回 UNAUTHENTICATED").toMatchObject({
        success: false,
        error: { code: "UNAUTHENTICATED" },
      });
    } finally {
      await anonymous.close();
    }
  });

  test("2. Workspace：A 推送 → B 索引 / 拉取（5 域 status + 配额常量）", async () => {
    const payload = workspacePayload(WORKSPACE_ID, "E2E 工作空间");
    const pushed = okData<SyncPush>(
      await syncPush(a, "workspace", [{ id: WORKSPACE_ID, baseRevision: 0, updatedAt: Date.now(), payload }]),
      200,
      "A 首次推送 workspace",
    );
    expect(pushed.domain).toBe("workspace");
    expect(pushed.applied, "首次推送应写入").toHaveLength(1);
    expect(pushed.conflicts, "首次推送不应冲突").toHaveLength(0);
    const applied = pushed.applied[0];
    expect(applied).toMatchObject({ id: WORKSPACE_ID, revision: 1, deleted: false });
    expect(applied.payload, "push 响应原样返回客户端 payload").toEqual(payload);

    // B 是另一个 Browser Context / Cookie，但同账号 → 能读到 A 推的数据。
    const index = okData<SyncIndex>(await syncIndex(b, "workspace"), 200, "B 读 workspace 索引");
    expect(index.domain).toBe("workspace");
    expect(index.truncated).toBe(false);
    const indexEntity = entityOf(index, WORKSPACE_ID);
    expect(indexEntity, "B 的索引应包含 A 推送的实体").toBeTruthy();
    expect(indexEntity).toMatchObject({
      id: WORKSPACE_ID,
      revision: 1,
      deleted: false,
      updatedAt: applied.updatedAt,
    });

    const pulled = okData<SyncPull>(await syncPull(b, "workspace", { ids: [WORKSPACE_ID] }), 200, "B 按 id 拉取");
    expect(pulled.changes, "B 应拉到 1 条变更").toHaveLength(1);
    expect(pulled.changes[0]).toMatchObject({ id: WORKSPACE_ID, revision: 1, deleted: false });
    expect(pulled.changes[0]?.payload, "B 拉到的 payload 与 A 推送一致").toEqual(payload);

    const delta = okData<SyncPull>(await syncPull(b, "workspace", { since: 0 }), 200, "B since=0 增量拉取");
    expect(delta.changes.map((change) => change.id), "since=0 应包含该实体").toContain(WORKSPACE_ID);

    const status = okData<SyncStatus>(await syncStatus(b), 200, "B 读 sync status");
    expect(status.domains.map((entry) => entry.domain), "status 固定返回 5 个域").toEqual([...SYNC_DOMAINS]);
    expect(status.quotas.limits, "配额上限常量").toEqual({
      maxEntities: SYNC_LIMITS.maxEntities,
      maxTombstones: SYNC_LIMITS.maxTombstones,
    });
    expect(status.quotas.entityCount, "账号已有 1 条活实体").toBe(1);
    expect(status.quotas.tombstoneCount).toBe(0);
    const workspaceStats = status.domains.find((entry) => entry.domain === "workspace");
    expect(workspaceStats, "workspace 域统计应反映推送").toMatchObject({
      count: 1,
      tombstones: 0,
      lastUpdated: applied.updatedAt,
    });

    workspaceRevision = applied.revision;
    workspaceUpdatedAt = applied.updatedAt;
  });

  test("3. Workspace：B 基于最新 revision 修改 → A 增量拉取（since 语义 / 索引一致）", async () => {
    const updatedPayload = workspacePayload(WORKSPACE_ID, "B 修改后的工作空间", { theme: "light" });
    const pushed = okData<SyncPush>(
      await syncPush(b, "workspace", [
        { id: WORKSPACE_ID, baseRevision: workspaceRevision, updatedAt: Date.now(), payload: updatedPayload },
      ]),
      200,
      "B 修改 workspace",
    );
    expect(pushed.applied, "基于最新 revision 的修改应写入").toHaveLength(1);
    const applied = pushed.applied[0];
    expect(applied.revision, "revision 单调递增").toBe(workspaceRevision + 1);
    expect(applied.updatedAt, "updatedAt 必须大于上一版").toBeGreaterThan(workspaceUpdatedAt);
    expect(applied.payload).toEqual(updatedPayload);

    // 设备 A 用「上一版 updatedAt」做增量：只会拿到这一条新变更。
    const incremental = okData<SyncPull>(
      await syncPull(a, "workspace", { since: workspaceUpdatedAt }),
      200,
      "A since=上一版 updatedAt 增量拉取",
    );
    expect(incremental.changes.map((change) => change.id), "增量应只含这一条变更").toEqual([WORKSPACE_ID]);
    expect(incremental.changes[0]?.revision).toBe(applied.revision);
    expect(incremental.changes[0]?.payload, "增量拉到最新 payload").toEqual(updatedPayload);
    expect(incremental.hasMore, "数据不足一页时 hasMore 为 false").toBe(false);

    // 用最新 updatedAt 再做增量：没有新变更（客户端轮询语义）。
    const quiet = okData<SyncPull>(
      await syncPull(a, "workspace", { since: applied.updatedAt }),
      200,
      "A since=最新 updatedAt",
    );
    expect(quiet.changes, "没有更新的变更时应为空").toEqual([]);
    expect(quiet.hasMore).toBe(false);

    const index = okData<SyncIndex>(await syncIndex(a, "workspace"), 200, "A 读索引");
    expect(entityOf(index, WORKSPACE_ID), "索引 revision / updatedAt 与 push 一致").toMatchObject({
      revision: applied.revision,
      updatedAt: applied.updatedAt,
    });

    const pulled = okData<SyncPull>(await syncPull(a, "workspace", { ids: [WORKSPACE_ID] }), 200, "A 按 id 拉最新版");
    expect(pulled.changes[0]?.payload).toEqual(updatedPayload);

    workspaceRevision = applied.revision;
    workspaceUpdatedAt = applied.updatedAt;
  });

  test("4. Workspace：删除写墓碑、旧终端不能复活、按墓碑 revision 重建", async () => {
    const deleted = okData<SyncPush>(
      await syncPush(a, "workspace", [
        { id: WORKSPACE_ID, baseRevision: workspaceRevision, updatedAt: Date.now(), deleted: true },
      ]),
      200,
      "A 删除 workspace",
    );
    expect(deleted.applied, "删除应产生墓碑").toHaveLength(1);
    const tombstone = deleted.applied[0];
    expect(tombstone).toMatchObject({ id: WORKSPACE_ID, revision: workspaceRevision + 1, deleted: true });
    expect(tombstone.deletedAt, "墓碑必须带 deletedAt").toBeGreaterThan(0);
    expect(tombstone.payload, "墓碑不返回 payload").toBeUndefined();

    // 设备 B 的索引 / 拉取都能看到墓碑（客户端据此删除本地实体）。
    const index = okData<SyncIndex>(await syncIndex(b, "workspace"), 200, "B 读索引（墓碑）");
    expect(entityOf(index, WORKSPACE_ID), "B 索引里的墓碑 revision 一致").toMatchObject({
      revision: tombstone.revision,
      deleted: true,
    });
    const pulled = okData<SyncPull>(await syncPull(b, "workspace", { ids: [WORKSPACE_ID] }), 200, "B 按 id 拉墓碑");
    expect(pulled.changes[0], "B 拉到墓碑").toMatchObject({
      id: WORKSPACE_ID,
      revision: tombstone.revision,
      deleted: true,
    });
    expect(pulled.changes[0]?.deletedAt, "墓碑 deletedAt 与 push 响应一致").toBe(tombstone.deletedAt);

    const status = okData<SyncStatus>(await syncStatus(b), 200, "B 读 status（墓碑计数）");
    expect(status.domains.find((entry) => entry.domain === "workspace")?.tombstones, "workspace 域墓碑数为 1").toBe(1);
    expect(status.quotas.tombstoneCount, "账号墓碑计数至少 1").toBeGreaterThanOrEqual(1);

    // 防复活：旧终端还停在删除前的 revision，推送必须冲突而不是顶掉墓碑。
    const stale = okData<SyncPush>(
      await syncPush(b, "workspace", [
        {
          id: WORKSPACE_ID,
          baseRevision: workspaceRevision - 1,
          updatedAt: Date.now(),
          payload: workspacePayload(WORKSPACE_ID, "旧终端幽灵工作空间"),
        },
      ]),
      200,
      "旧 revision 推送（应冲突）",
    );
    expect(stale.applied, "旧 revision 不能复活实体").toHaveLength(0);
    expect(stale.conflicts, "应返回 1 条冲突").toHaveLength(1);
    expect(stale.conflicts[0], "冲突快照是服务端墓碑").toMatchObject({
      id: WORKSPACE_ID,
      revision: tombstone.revision,
      deleted: true,
    });
    const afterStale = okData<SyncIndex>(await syncIndex(b, "workspace"), 200, "冲突后 B 读索引");
    expect(entityOf(afterStale, WORKSPACE_ID), "冲突后仍是墓碑").toMatchObject({
      revision: tombstone.revision,
      deleted: true,
    });

    // 重建：以墓碑 revision 为基线推新内容（客户端删除后重建同名实体的等价操作）。
    const rebuiltPayload = workspacePayload(WORKSPACE_ID, "重建的工作空间", { theme: "light" });
    const rebuilt = okData<SyncPush>(
      await syncPush(a, "workspace", [
        { id: WORKSPACE_ID, baseRevision: tombstone.revision, updatedAt: Date.now(), payload: rebuiltPayload },
      ]),
      200,
      "按墓碑 revision 重建",
    );
    expect(rebuilt.applied, "重建应写入").toHaveLength(1);
    const rebuiltEntity = rebuilt.applied[0];
    expect(rebuiltEntity.revision, "重建后 revision 继续递增").toBe(tombstone.revision + 1);
    expect(rebuiltEntity.deleted).toBe(false);

    const finalIndex = okData<SyncIndex>(await syncIndex(b, "workspace"), 200, "重建后 B 读索引");
    expect(entityOf(finalIndex, WORKSPACE_ID), "索引回到活实体").toMatchObject({
      revision: rebuiltEntity.revision,
      deleted: false,
    });
    const finalStatus = okData<SyncStatus>(await syncStatus(b), 200, "重建后 status");
    expect(finalStatus.domains.find((entry) => entry.domain === "workspace")?.tombstones, "重建后墓碑释放").toBe(0);

    workspaceRevision = rebuiltEntity.revision;
    workspaceUpdatedAt = rebuiltEntity.updatedAt;
  });

  test("5. Preferences：A 推送 → B 拉取；32KB 域限额生效（40KB 在 workspace 合法）", async () => {
    const payload = preferencesPayload();
    const pushed = okData<SyncPush>(
      await syncPush(a, "preferences", [{ id: PREFERENCES_ID, baseRevision: 0, updatedAt: Date.now(), payload }]),
      200,
      "A 推送 preferences",
    );
    expect(pushed.applied, "preferences 首次推送应写入").toHaveLength(1);
    expect(pushed.applied[0]).toMatchObject({ id: PREFERENCES_ID, revision: 1, deleted: false });
    expect(pushed.applied[0]?.payload).toEqual(payload);

    // 账号级偏好：B（同账号另一台设备）拉到的就是 A 的同步值。
    const pulled = okData<SyncPull>(await syncPull(b, "preferences", { ids: [PREFERENCES_ID] }), 200, "B 拉取 preferences");
    expect(pulled.changes).toHaveLength(1);
    expect(pulled.changes[0]?.revision).toBe(1);
    expect(pulled.changes[0]?.payload).toEqual(payload);

    // 超过 preferences 32KB 上限 → 400 PAYLOAD_TOO_LARGE。
    expectError(
      await syncPush(a, "preferences", [
        { id: "preferences-oversize", baseRevision: 0, updatedAt: Date.now(), payload: paddedPayload(33 * 1024, "prefs-oversize") },
      ]),
      400,
      "PAYLOAD_TOO_LARGE",
      "preferences 超 32KB",
    );

    // 同一个 40KB payload 在 workspace（128KB 上限）下合法：证明限额按域生效。
    const workspaceSized = paddedPayload(40 * 1024, "ws-40k");
    const okPush = okData<SyncPush>(
      await syncPush(a, "workspace", [
        { id: OVERSIZE_WORKSPACE_ID, baseRevision: 0, updatedAt: Date.now(), payload: workspaceSized },
      ]),
      200,
      "workspace 40KB payload",
    );
    expect(okPush.applied, "40KB 在 workspace 上限内应写入").toHaveLength(1);
    expect(okPush.applied[0]?.payload).toEqual(workspaceSized);
  });

  test("6. 冲突：同一 revision 并发推送 → conflicts 返回服务端版本；保留本地 / 保留云端", async () => {
    const payloadA = { v: 1, title: "A 的笔记", body: "A" };
    const first = okData<SyncPush>(
      await syncPush(a, "notes", [{ id: CONFLICT_NOTE_ID, baseRevision: 0, updatedAt: Date.now(), payload: payloadA }]),
      200,
      "A 首次推送笔记",
    );
    expect(first.applied[0]?.revision).toBe(1);
    expect(first.conflicts).toHaveLength(0);
    conflictNoteRevision = first.applied[0].revision;

    // B 也停在 revision 0 且内容不同 → 服务端不覆盖，把当前行作为冲突返回。
    const payloadB = { v: 1, title: "B 的笔记", body: "B" };
    const conflict = okData<SyncPush>(
      await syncPush(b, "notes", [{ id: CONFLICT_NOTE_ID, baseRevision: 0, updatedAt: Date.now(), payload: payloadB }]),
      200,
      "B 基于旧 revision 推送",
    );
    expect(conflict.applied, "冲突时不能写入").toHaveLength(0);
    expect(conflict.conflicts, "应返回 1 条冲突").toHaveLength(1);
    const serverRow = conflict.conflicts[0];
    expect(serverRow, "冲突快照的服务端 revision 是 1").toMatchObject({
      id: CONFLICT_NOTE_ID,
      revision: 1,
      deleted: false,
    });
    expect(serverRow?.payload, "客户端拿到的冲突快照是服务端版本").toEqual(payloadA);
    // 客户端会把 localRevision=0 / serverRevision=1 记进本地冲突列表（单测覆盖）。

    // 保留本地：客户端以服务端 revision 为基线重新推送自己的版本 → 成功，revision+1。
    const keepLocal = okData<SyncPush>(
      await syncPush(b, "notes", [
        { id: CONFLICT_NOTE_ID, baseRevision: serverRow!.revision, updatedAt: Date.now(), payload: payloadB },
      ]),
      200,
      "保留本地：按服务端 revision 重推",
    );
    expect(keepLocal.applied, "重推应成功").toHaveLength(1);
    expect(keepLocal.conflicts).toHaveLength(0);
    expect(keepLocal.applied[0]?.revision, "保留本地后 revision 递增").toBe(serverRow!.revision + 1);
    conflictNoteRevision = keepLocal.applied[0].revision;

    // A 再用旧 revision 推 → 又冲突，返回 B 的最新版本。
    const staleA = okData<SyncPush>(
      await syncPush(a, "notes", [
        { id: CONFLICT_NOTE_ID, baseRevision: 1, updatedAt: Date.now(), payload: payloadA },
      ]),
      200,
      "A 旧 revision 推送",
    );
    expect(staleA.applied).toHaveLength(0);
    expect(staleA.conflicts[0], "A 收到 B 的最新版本作为冲突快照").toMatchObject({
      id: CONFLICT_NOTE_ID,
      revision: conflictNoteRevision,
    });
    expect(staleA.conflicts[0]?.payload).toEqual(payloadB);

    // 保留云端：客户端只拉取并应用服务端版本（不写库），重复拉取幂等。
    const remote1 = okData<SyncPull>(await syncPull(a, "notes", { ids: [CONFLICT_NOTE_ID] }), 200, "A 拉取服务端版本");
    const remote2 = okData<SyncPull>(await syncPull(a, "notes", { ids: [CONFLICT_NOTE_ID] }), 200, "A 重复拉取（幂等）");
    expect(remote1.changes[0], "保留云端后本地应看到服务端版本").toMatchObject({
      id: CONFLICT_NOTE_ID,
      revision: conflictNoteRevision,
    });
    expect(remote2.changes[0]).toEqual(remote1.changes[0]);
    expect(remote1.changes[0]?.payload).toEqual(payloadB);

    // 选择远端后，本地基线更新为远端 revision，后续编辑可以正常推送。
    const afterRemote = okData<SyncPush>(
      await syncPush(a, "notes", [
        {
          id: CONFLICT_NOTE_ID,
          baseRevision: conflictNoteRevision,
          updatedAt: Date.now(),
          payload: { v: 1, title: "A 合并后的笔记", body: "merged" },
        },
      ]),
      200,
      "应用远端后继续编辑",
    );
    expect(afterRemote.applied[0]?.revision, "后续编辑 revision 继续递增").toBe(conflictNoteRevision + 1);
    conflictNoteRevision = afterRemote.applied[0].revision;
  });

  test("7. 参数边界：domain / 批次 / 实体 id / ids 上限 / 缺 Origin", async () => {
    expectError(await syncIndex(a, "bogus"), 400, "UNKNOWN_DOMAIN", "非法 domain 的索引请求");
    expectError(await syncPush(a, "bogus", []), 400, "UNKNOWN_DOMAIN", "非法 domain 的推送");
    expectError(await syncPush(a, "notes", []), 400, "EMPTY_BATCH", "空批次");
    expectError(
      await syncPush(a, "notes", [{ id: "bad id!", baseRevision: 0, updatedAt: Date.now(), payload: { v: 1 } }]),
      400,
      "INVALID_CHANGE",
      "非法实体 id（含空格/感叹号）",
    );
    expectError(
      await syncPush(a, "notes", [{ id: "no-payload", baseRevision: 0, updatedAt: Date.now() }]),
      400,
      "INVALID_CHANGE",
      "活实体缺少 payload",
    );

    const tooManyChanges = Array.from({ length: SYNC_LIMITS.maxBatch + 1 }, (_, index) => ({
      id: `batch-${index}`,
      baseRevision: 0,
      updatedAt: Date.now(),
      payload: { v: 1 },
    }));
    expectError(await syncPush(a, "notes", tooManyChanges), 400, "BATCH_TOO_LARGE", "单次超过 100 条变更");

    const tooManyIds = Array.from({ length: SYNC_LIMITS.maxPullIds + 1 }, (_, index) => `id-${index}`);
    expectError(await syncPull(a, "notes", { ids: tooManyIds }), 400, "TOO_MANY_IDS", "pull ids 超过 200");

    // 整个请求体超过 768KB：在读 body 阶段即 413，还没走到按域 payload 校验。
    expectError(
      await syncPush(a, "notes", [
        { id: "huge-body", baseRevision: 0, updatedAt: Date.now(), payload: paddedPayload(800 * 1024, "huge") },
      ]),
      413,
      "PAYLOAD_TOO_LARGE",
      "请求体超过 768KB",
    );

    // 写请求缺少 Origin（请求也不是 same-origin 导航）→ CSRF 拦截。
    expectError(
      await api(a, "POST", "/api/sync/push", {
        body: {
          domain: "notes",
          changes: [{ id: "csrf-probe", baseRevision: 0, updatedAt: Date.now(), payload: { v: 1 } }],
        },
        omitOrigin: true,
      }),
      403,
      "CSRF_REJECTED",
      "缺 Origin 的同步写请求",
    );

    // 未登录的 401 已在用例 1 用空白 Browser Context 覆盖。
  });

  test("8. 账号隔离（outsider）与配额统计自洽", async ({ browser }) => {
    outsider = await newSyncDevice(browser, fixtures, "outsider");

    const outsiderStatus = okData<SyncStatus>(await syncStatus(outsider), 200, "outsider 读 status");
    expect(outsiderStatus.quotas.entityCount, "outsider 没有同步数据").toBe(0);
    expect(outsiderStatus.quotas.tombstoneCount, "outsider 没有墓碑").toBe(0);
    const outsiderIndex = okData<SyncIndex>(await syncIndex(outsider, "workspace"), 200, "outsider 读 workspace 索引");
    expect(outsiderIndex.entities, "outsider 读不到 installer 的数据").toEqual([]);

    // outsider 推同名实体：写进自己的 user_id 分区，从未有过的实体从 revision 1 开始。
    const outsiderPush = okData<SyncPush>(
      await syncPush(outsider, "workspace", [
        {
          id: WORKSPACE_ID,
          baseRevision: 0,
          updatedAt: Date.now(),
          payload: workspacePayload(WORKSPACE_ID, "outsider 的同名工作空间"),
        },
      ]),
      200,
      "outsider 推同名实体",
    );
    expect(outsiderPush.applied[0]?.revision, "另一个账号从 revision 1 开始").toBe(1);

    // installer 的索引不受影响：同名实体按 user_id 隔离。
    const ownerIndex = okData<SyncIndex>(await syncIndex(a, "workspace"), 200, "installer 读索引（隔离验证）");
    expect(entityOf(ownerIndex, WORKSPACE_ID), "同名实体按 user_id 隔离").toMatchObject({
      revision: workspaceRevision,
      deleted: false,
    });
    expect(ownerIndex.entities.filter((entity) => entity.id === WORKSPACE_ID), "索引只返回本账号的行").toHaveLength(1);

    // 配额统计自洽：entityCount / tombstoneCount 等于各域计数之和。
    const status = okData<SyncStatus>(await syncStatus(a), 200, "installer 读 status");
    const live = status.domains.reduce((sum, entry) => sum + entry.count - entry.tombstones, 0);
    const tombstones = status.domains.reduce((sum, entry) => sum + entry.tombstones, 0);
    expect(status.quotas.entityCount, "entityCount 等于各域活实体之和").toBe(live);
    expect(status.quotas.tombstoneCount, "tombstoneCount 等于各域墓碑之和").toBe(tombstones);
    expect(status.quotas.limits, "配额上限常量").toEqual({
      maxEntities: SYNC_LIMITS.maxEntities,
      maxTombstones: SYNC_LIMITS.maxTombstones,
    });
  });
});
