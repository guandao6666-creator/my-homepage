# Workspace 云同步（Phase 4.1）

> 状态：本地与 CI 已验证（`Accepted (Local/CI)`）；生产部署与生产验证仍被 Phase 1.6 门禁阻塞，本文不构成生产验证结论。
> 范围：在现有 Cloud Sync（Notes / Tasks / Calendar）之上新增 `workspace` 数据域，复用 `sync_entities`、Revision 乐观锁与墓碑机制，**不重写同步引擎**。

## 1. 目标与边界

让同一账号的多台设备恢复同一个「工作空间」：名称、主题、壁纸、组件位置、Dock、快捷方式、打开的窗口及其几何。

同步的是**语义快照**，不是本地存储原样拷贝：

| 同步 | 不同步 |
| --- | --- |
| 工作空间 id、名称、创建/更新时间 | 设备唯一 id、设备名、分辨率 |
| `theme`、`wall`、`widgets`（组件 id + 位置/尺寸/启用） | 运行中的 Promise / 计时器 / DOM 临时状态 |
| `dock`、`shortcuts`、`openApps`、`dnd` | 动画、拖拽中间态 |
| `windows`（应用 id、标签页空间、几何） | 认证 Cookie、Session、本地缓存 |
| `viewport`（仅用于跨端重算几何） | 不可移植的像素坐标（写入时是坐标，应用时按视口重算） |

- 只同步 `preset: false` 的**自定义**工作空间；`daily / study / work / entertainment` 是产品内置默认值，每台设备本来就有，不占云配额。
- 删除工作空间仍走原有 `workspaces.ts` 语义（直接从 `guandao.os14.ws.v1` 列表移除），同步侧用「已知 id 追踪」在下一轮合成删除项。
- 不修改 Window Manager、Layout Manager 或桌面视觉。

## 2. 数据模型

云端实体：`domain = "workspace"`、`entity_id = workspaceId`、`payload = WorkspacePayload`。一个工作空间一个实体。

```jsonc
{
  "v": 1,
  "workspace": {
    "id": "ws-a1b2c3d4",
    "name": "写作",
    "preset": false,
    "theme": "dark",
    "wall": "aurora",
    "widgets": { "clock": { "x": 0, "y": 0, "size": "m", "enabled": true } },
    "dock": ["notes", "tasks", "calendar"],
    "shortcuts": ["settings", "market"],
    "windows": {
      "notes": { "left": 120, "top": 80, "width": 720, "height": 520,
                 "minimized": false, "maximized": false, "space": 0 }
    },
    "openApps": ["notes"],
    "dnd": false,
    "createdAt": 1790000000000,
    "updatedAt": 1790000000000
  },
  "viewport": { "width": 1440, "height": 900 },
  "capturedAt": 1790000000000
}
```

校验（`validateWorkspacePayload`，客户端与服务端各自校验，服务端另有 128KB 上限）：

| 字段 | 约束 |
| --- | --- |
| `v` | 必须为 `1`；其他版本明确报错，不静默降级 |
| `workspace.preset` | 必须为 `false`；预设空间不得进入同步 |
| `workspace.id` | `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`，≤128 字符 |
| `name` | ≤64 字符，空名回落为「未命名工作空间」 |
| `widgets` | ≤64 项，键 `/^[a-z0-9][a-z0-9-]*$/` |
| `windows` | ≤24 项，几何为有限数字 |
| 各数组 | ≤48 项 |
| 序列化字节 | ≤128 KB（`MAX_WORKSPACE_PAYLOAD_BYTES`） |
| `viewport` | `{ width, height }` 正整数；旧数据可为 `null` |

任一校验失败都会返回明确错误（`WorkspaceValidation` 的 `{ ok:false, error }`），**不截断、不静默丢弃**。

## 3. 本地读取与落盘

- 存储键与桌面共用 `guandao.os14.ws.v1`；同步模块兼容两种落盘形态：os14 写入的裸 JSON，以及 `StorageManager` 信封 `{ v, at, data }`。
- 读取优先 `kernel.storage.legacyStr / activeStore`，最后回退 `localStorage`；写入遵循同一顺序。
- 只读取 `preset === false` 的条目；`current`、内置预设不参与同步。

## 4. 窗口几何：语义快照 + 视口重算

跨设备不能直接搬 `left/top/width/height`，否则小屏设备上的窗口会越界。

1. 推送时记录 `capture()` 得到的当前 `viewport`。
2. 应用远端快照时：
   - `normalizeSnapshot({ windows, viewport }, 当前视口)`——旧数据（1.x 或缺失 viewport）只要窗口有宽高就接受；
   - `rescaleSnapshot(snapshot, 当前视口, { cascade:false })`——视口差异在 ±8px 内只做边界收敛；否则等比缩放（比例夹在 `[0.35, 1]`），有 `zone` 时按吸附区域重新 `snapRect`；
   - 结果写回本地 `windows`，再由 `applyWorkspace` 交给既有 `restoreWindows` 恢复。
3. 该逻辑与 2.0 WindowManager 的布局恢复共用 `src/lib/core/layout.ts`，没有第二套几何算法。

## 5. 删除、墓碑与防复活

- 同步侧维护 `guandao.core.sync.workspaces.known.v1`（已知 id → `updatedAt/deletedAt`）。
- 某 id 从本地列表消失且此前已知 → 下一轮 `collectWorkspaceSyncItems` 合成 `deleted: true` 项，服务端写成墓碑（`deleted = 1`、`deleted_at = updated_at`），其他设备拉取后备遗忘。
- 用同一 id 重建：已知记录被 `deletedAt` 撤销，重新作为正常实体推送（服务端 revision 增大），不会被当成「复活已删实体」。
- 90 天后墓碑被清理，但 `sync_tombstone_ledger` 保留最后删除 revision；离线设备拿旧 `baseRevision` 重推会收到 `deleted` 冲突，客户端据此删本地并提示，而不是复活。详见 [SYNC-RETENTION.md](../operations/SYNC-RETENTION.md)。

## 6. 服务端交互

复用现有 `worker/api/sync/**`：

| 接口 | 用途 |
| --- | --- |
| `GET /api/sync/index?domain=workspace` | 拉远端索引（id / revision / deleted / updatedAt） |
| `GET /api/sync/pull?domain=workspace&ids=...` | 按 id 取 payload（≤200 个 id） |
| `GET /api/sync/pull?domain=workspace&since=...` | 增量拉取（按 `updated_at`） |
| `POST /api/sync/push` | 推送 `{ domain:"workspace", changes:[{ id, baseRevision, updatedAt, deleted, payload }] }` |

- 冲突语义：`baseRevision` 落后于云端 revision → 服务端返回 `conflicts`，**不覆盖**；客户端把服务端版本落回本地并记录一条冲突（见 [SYNC-CONFLICTS.md](SYNC-CONFLICTS.md)）。
- 限额：单条 payload 128 KB；单用户活实体 5000、墓碑 2000；超限 `409 QUOTA_EXCEEDED`（`details.scope`），不静默删数据。
- 写接口要求同源 + 活跃 Session；未登录 401。

## 7. 旧客户端与兼容

- 旧客户端的 `SYNC_DOMAINS` 只有三域时，不会请求 `workspace`；服务端返回的域列表里多出 `workspace` 会被忽略，三域行为不变。
- 新增域不改变 `notes/tasks/calendar` 的协议与上限。
- 迁移 0018 只重建 `sync_entities` 并复制数据，旧表保留为 `sync_entities_legacy_v1`，可回滚。

## 8. 测试证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 单测 | `tests/unit/sync-workspace.test.ts` | 10 通过 |
| 协议/隔离 | `scripts/sync-qa.mjs`（含 workspace 推送、未知域、配额、墓碑清理、防复活） | 45/45 通过 |
| 双设备 E2E | `tests/e2e/sync.spec.ts`（两个独立 Browser Context，真实 Worker + 本地 D1） | **8/8 通过，连续 3 次全绿（20.3–20.5s）** |

E2E 覆盖（协议级；两个 Context 分别注入同一账号两台设备的真实 Session，`/api/auth/me` 的 `deviceId` 不同）：A 创建/修改工作空间并推送（rev1→rev2）→ B index/pull 校验语义快照与 revision；增量 `since` 只返回变化实体；A 删除 → B 拉取墓碑（`deletedAt>0`、无 payload）；B 用删除前旧 `baseRevision` 推活 payload → 服务端返回墓碑冲突（防复活）；以墓碑 revision 重推则重建成功、墓碑计数归零；不同账号同名实体互不影响。页面级 `GOS20` 应用（`applyRemoteWorkspace` 写入本地存储）由 `tests/unit/sync-workspace.test.ts` 覆盖，本轮 E2E 未做页面级断言（详见最终报告“未覆盖项”）。

## 9. 已知限制

- 只同步自定义工作空间；内置预设不跨端同步。
- 动画、拖拽中间态、运行中应用状态不同步（任务书明确排除）。
- 像素坐标仅作为「捕获时视口下的语义」，跨端必须经 Layout Manager 重算；极端超小/超大视口下采用 `0.35~1` 的缩放夹取，视觉上可能与原设备略有差异。
- 本地工作空间删除依赖 known-id 追踪发现，最多延迟一个同步周期；删除后立即在其他设备出现依赖下一次同步。

## 10. 变更文件

- `src/lib/sync/workspace.ts`（新增）
- `src/lib/sync/providers.ts`（新增 workspace provider、冲突记录）
- `src/lib/os14/workspaces.ts`（`viewport` 字段、捕获/应用时几何重算）
- `src/lib/os20/bridge.ts`（暴露 `syncNow(domain)`、冲突查询/解决）
- `worker/api/sync/{limits,store,handlers}.js`、`worker/index.js`、`migrations/0018_sync_cloud_expansion.sql`
- 测试：`tests/unit/sync-workspace.test.ts`、`scripts/sync-qa.mjs`、`tests/e2e/sync.spec.ts`
