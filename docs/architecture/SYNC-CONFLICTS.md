# 同步冲突可视化与解决（Phase 4.3）

> 状态：本地与 CI 已验证（`Accepted (Local/CI)`）；生产未部署/未验证。
> 范围：在现有 Revision 乐观锁之上增加「用户可见的冲突记录 + 明确选择」，**不推翻**服务端优先的既有策略，也不关闭乐观锁。

## 1. 背景：现有冲突如何处理

`POST /api/sync/push` 逐条比较 `baseRevision` 与云端 `revision`：落后即返回 `conflicts`，服务端不覆盖；客户端 `providers.ts` 收到冲突后把**服务端版本落回本地**、更新本地 revision，并把冲突计数写入 `DomainStatus.conflicts`。此前用户只能在状态里看到一个数字，无法知道是哪条数据、也无法保留本地版本。

Phase 4 保留上述数据一致性策略，另外：

1. 冲突发生时把**必要元数据**记录到本地冲突中心（不上传云端）；
2. System Center 的云端设置展示「最近同步冲突」，提供「保留本地 / 保留云端」；
3. 解决方案仍然通过同一个 `push` 接口与乐观锁完成，不引入静默强覆盖。

## 2. 冲突如何产生

| 场景 | 判定 | 结果 |
| --- | --- | --- |
| 设备 A、B 都基于 revision 3 修改同一实体，A 先推送 | B 推送时 `baseRevision=3 < 云端 revision=4` | 服务端返回 `conflicts`，B 本地应用云端版本并记录冲突 |
| 一端删除、一端修改 | 客户端 `decide` 修改优先；推送删除方遇新 revision | 同上，记录冲突 |
| 墓碑已被清理，旧设备拿旧 `baseRevision` 重推 | 服务端 `sync_tombstone_ledger` 拦截 | 返回合成 `deleted` 冲突，客户端删除本地，**不复活** |
| 冲突尚未解决时云端又变化 | 解决「保留本地」时以最新 serverRevision 为 base 重推 | 若再次冲突返回 `{ ok:false, reason:"changed" }`，记录保持 open 并刷新 serverRevision，要求重新确认 |

## 3. 本地冲突记录模型

存储键 `guandao.core.sync.conflicts.v1`（localStorage，经 Kernel storage 封装，可注入测试存储）。

```ts
type SyncConflict = {
  id: string;                 // `${domain}:${entityId}`，可直接回传解决接口
  domain: "notes" | "tasks" | "calendar" | "workspace" | "preferences";
  entityId: string;
  localRevision: number;
  serverRevision: number;
  localUpdatedAt: number;
  serverUpdatedAt: number;
  detectedAt: number;
  state: "open" | "resolved";
  resolvedAt?: number;
  resolvedBy?: "local" | "remote";
  localSnapshot?: string;     // 受控、脱敏、≤4KB
  serverSnapshot?: string;    // 受控、脱敏、≤4KB
};
```

保留策略：

- 最多 **50 条**，按 `${domain}:${entityId}` 去重（同一实体只保留最近一次）；
- 保留 **7 天**（TTL），过期在读写时惰性清理；
- 快照 ≤4KB/边，且只保存必要字段；笔记/任务正文不整体复制，敏感字段（token、cookie、密码类键）脱敏；
- 仅存本地，不上传云端；不写诊断日志、不把私人内容复制到系统通知。

导出：`listConflicts({ includeResolved?, limit? })`、`getConflict`、`recordConflict`、`markConflictResolved`、`clearConflicts`、`conflictStats`。

## 4. 解决流程

### 4.1 保留本地（local）

1. 读取当前本地实体（`readWorkspaceSyncItem` / adapter 的本地读取），以冲突记录里的 **serverRevision 作为 `baseRevision`**，`updatedAt = now` 重新推送。
2. 成功 → 本地 revision 更新、冲突标记 `resolvedBy:"local"`、UI 刷新。
3. 若期间云端又变化 → `{ ok:false, reason:"changed" }`，服务端 revision 写入记录、状态保持 open；UI 提示「同步版本已再次变化，请重新确认」。
4. 只提交这一条实体；不得覆盖同域其他实体；乐观锁始终生效。

### 4.2 保留云端（remote）

1. `GET /api/sync/pull?domain=&ids=<entityId>` 取云端实体；
2. 应用到本地（workspace 走 Layout 重算；preferences 走 SettingsManager；notes/tasks/calendar 走既有 adapter）；
3. 写入云端 revision，`markConflictResolved(server)`；
4. 再次调用返回 noop（幂等）。

### 4.3 边界

- 冲突不存在或已解决 → noop，不报错；
- 离线/不支持/异常 → `{ ok:false, reason:"offline"|"unsupported"|"error" }`，记录保留；
- 解决操作不触发整域全量同步，不影响其他域。

## 5. UI（System Center → 云端设置）

- 「数据同步」组内新增配额 KPI：同步实体数 / 5000、删除墓碑数 / 2000（来自 `GET /api/sync/status` 的 `quotas`；失败静默显示「配额信息暂不可用」）。
- 其后新增「最近同步冲突」组：
  - 待处理数量 chip（有冲突 `is-warn`，否则 `is-ok`）、已解决数量 chip；
  - 最多 5 条列表：域标签、截断实体 id（title 保留完整 id）、检测时间、`本地 revision N / 云端 revision M`；
  - 每条两个按钮：`data-conflict-id` + `data-conflict-choice="local|remote"`，aria-label；操作期间禁用按钮；
  - 「清理已解决」仅在有已解决记录时出现；
  - 空态「暂无同步冲突」；
  - 说明文案：最多 50 条、保留 7 天、只存必要元数据与受控快照、不上传云端，并解释两种选择的含义。
- 解析结果后只刷新云端面板（保留滚动位置），不调用 `syncNow` 触发其他域；`changed` / `noop` / 离线都有明确提示。
- 纯函数（`conflictViewItems`、`quotaText`、`conflictResolveNotice` 等）可单测，DOM 组装不进入 node 单测。

## 6. 测试证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 单测 | `tests/unit/sync-conflicts.test.ts`（记录上限/去重/TTL/脱敏/解决 local-remote-幂等-再次冲突-offline-unsupported） | 12 通过 |
| 单测 | `tests/unit/systemcenter-sync.test.ts`（冲突视图/配额文案/提示文案） | 25 通过 |
| 协议 | `scripts/sync-qa.mjs`（旧 revision 冲突不覆盖、正确 revision 更新、防复活冲突） | 45/45 通过 |
| 双设备 E2E | `tests/e2e/sync.spec.ts`（两个独立 Browser Context，真实 Worker + 本地 D1） | **8/8 通过，连续 3 次全绿（20.3–20.5s）** |

E2E 冲突链路（协议级）：A 推送 rev1（payloadA）→ B 以 `baseRevision=0` 推 payloadB → `applied` 为空、`conflicts` 返回服务端实体（rev1/payloadA）；B 以服务端 revision 重推（等价「保留本地」）→ rev2、无冲突；A 以旧 revision 推 → `conflicts` 返回 rev2/payloadB；A 连续两次 `pull?ids=` 结果完全一致（等价「保留云端」的可重复应用）；再以 rev2 为基线推合并版本 → rev3。客户端冲突记录/`resolveSyncConflict` 状态机（local/remote/幂等 noop/再次冲突 `changed`/离线/记录缺失）由 `tests/unit/sync-conflicts.test.ts` 覆盖；页面级面板由 `tests/unit/systemcenter-sync.test.ts` 的纯函数覆盖，E2E 未做页面级断言。

## 7. 已知限制

- 解决「保留本地」只重推当前实体；若该实体依赖的其他实体也有冲突，需要逐条处理。
- 冲突快照是受控摘要，不是完整内容；用户查看详情时看到的是 id/时间/revision 与关键字段，而不是完整正文。
- 7 天/50 条是本地上限，不做跨设备同步；不同设备可能看到不同冲突列表。
- 冲突 UI 仅在 System Center 云端设置中提供，不做系统级通知弹窗（避免把私人内容推送到通知）。

## 8. 变更文件

- `src/lib/sync/conflicts.ts`（新增）
- `src/lib/sync/providers.ts`（`recordConflict`、`syncConflicts`、`resolveSyncConflict`、5 域注册）
- `src/lib/os20/bridge.ts`（`GOS20.syncConflicts` / `GOS20.syncResolveConflict` / `syncNow(domain)`）
- `src/lib/os20/apps/systemcenter.ts`（云端设置冲突面板 + 配额）
- 测试：`tests/unit/sync-conflicts.test.ts`、`tests/unit/systemcenter-sync.test.ts`、`tests/e2e/sync.spec.ts`
