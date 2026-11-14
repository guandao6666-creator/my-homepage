# Preferences 云同步（Phase 4.2）

> 状态：本地与 CI 已验证（`Accepted (Local/CI)`）；生产未部署/未验证。
> 范围：在现有 Cloud Sync 之上新增 `preferences` 数据域，只同步**显式白名单**内的用户级界面偏好，复用 `sync_entities`、Revision 乐观锁与冲突机制。

## 1. 原则

1. **白名单优先**：只有登记在 `SYNC_PREFERENCE_KEYS` 里的设置项才会上传；未登记的新设置默认不同步。
2. **只同步用户级**：主题、外观、Dock、时钟、通知、更新通道等「跟着人走」的偏好。
3. **设备级保持本地**：运行模式、诊断保留期、设备名、屏幕参数、输入设备、本地缓存与权限永不上传、永不被远端覆盖。
4. **非法值拒绝**：类型/枚举/范围不符的值不写入，返回 rejected 明细，不静默 clamp 到别的值。
5. **通过既有 Settings Manager 生效**：远端值应用后走现有 `applySettings`/`settings:change` 链路，不另建设置系统。

## 2. 同步白名单（13 项）

| 设置键 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appearance.mode` | select `dark` / `light` | `dark` | 主题模式 |
| `appearance.material` | select `glass` / `frost` / `solid` | `glass` | 材质 |
| `appearance.radius` | select `soft` / `round` / `sharp` | `soft` | 圆角风格 |
| `appearance.accent` | `auto` 或 `#rrggbb` | `auto` | 强调色 |
| `appearance.animations` | boolean | `true` | 界面动画 |
| `desktop.iconLabels` | boolean | `true` | 桌面图标文字 |
| `desktop.clockSeconds` | boolean | `false` | 时钟显示秒 |
| `desktop.dock.autohide` | boolean | `false` | Dock 自动隐藏 |
| `desktop.dock.position` | select `bottom` / `left` / `right` | `bottom` | Dock 位置 |
| `desktop.widgets.opacity` | number 30–100（步长 5） | `70` | 组件透明度 |
| `notifications.dnd` | boolean | `false` | 勿扰模式 |
| `notifications.volume` | number 0–100（步长 5） | `60` | 通知音量 |
| `system.updateChannel` | select `stable` / `preview` | `stable` | 更新通道 |

**明确排除**（`DEVICE_ONLY_SETTINGS`）：

- `system.mode`（local / cloud）——设备级运行模式，云同步会形成自举循环与跨设备意外切换；
- `system.diagnosticsRetention`——本地诊断存储策略；
- 设备名、设备类型、屏幕/分辨率、输入设备、本地缓存与存储配置、设备权限、Session/Token/密钥；
- 任何未在 `SETTINGS_SCHEMA` 登记或未加入白名单的键。

## 3. Payload

实体固定为单条：`domain = "preferences"`、`entity_id = "preferences"`。payload 只包含白名单键：

```jsonc
{
  "v": 1,
  "values": {
    "appearance.mode": "light",
    "desktop.dock.position": "left",
    "desktop.clockSeconds": true
  },
  "updatedAt": 1790000000000
}
```

- 序列化上限 **32 KB**（`MAX_PREFERENCES_PAYLOAD_BYTES`）；实际只会是几百字节。
- `validatePreferencesPayload`：`v` 必须为 1；未知键、原型污染键、非对象值、超限都返回明确错误。
- 值在应用前还要过 Settings Schema 的 `coerce`（select 严格枚举、number 夹取范围、accent 必须 `auto`/`#rrggbb`）；被拒绝的值写回 `rejected` 列表，不写入本地。

## 4. 推送与拉取流程

1. `readLocalPreferences(settings)` 从 SettingsManager 读出 13 项值；`preferencesHash` 与上次同步快照比较，无变化则不产生变更。
2. 推送 `{ entity_id:"preferences", baseRevision, updatedAt: preferencesUpdatedAt(), payload }`。
3. 冲突（`baseRevision < 服务端 revision`）：服务端返回服务端实体；客户端保持「服务端版本落回本地」的既有策略——`applyPreferencesPayload` 应用到本地、更新 revision，同时记录冲突供用户选择「保留本地/保留云端」（见 [SYNC-CONFLICTS.md](SYNC-CONFLICTS.md)）。
4. 拉取：应用远端 payload → `settings.update(values)` → 既有 `settings:change` 生效（主题、Dock、时钟等立即刷新）→ `markPreferencesSynced` 记录最后同步值快照与服务器更新时间。

**首次同步**：本地 `updatedAt = 0`（云端优先），避免一台新设备的默认值把云端用户偏好覆盖掉；同步成功后以服务器 `updatedAt` 记 `guandao.core.sync.preferences.last`。

## 5. 重置与删除语义

Preferences 没有墓碑：不存在「删除偏好」这一用户动作；恢复默认值等价于把默认值作为一次普通更新同步到其他设备。若需要设备保持例外，应把该项拆为设备级设置，而不是在同步层做特例。

## 6. 旧客户端兼容

- 旧客户端不认识 `preferences` 域时忽略即可，`notes/tasks/calendar` 通信不受影响。
- 服务端 `SYNC_DOMAINS` 扩展后，旧客户端只请求自己认识的域。
- 新设置项若未加入白名单，永不外发；未来加白名单属于显式产品决策，需同步更新本文档。

## 7. 测试证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 单测 | `tests/unit/sync-preferences.test.ts`（白名单、未知键、非法值、32KB、设备级排除） | 7 通过 |
| 单测 | `tests/unit/systemcenter-sync.test.ts`（配额/冲突纯函数） | 25 通过 |
| 协议 | `scripts/sync-qa.mjs`（preferences 40KB → 400、workspace 100KB → 200） | 45/45 通过 |
| 双设备 E2E | `tests/e2e/sync.spec.ts`（两个独立 Browser Context，真实 Worker + 本地 D1） | **8/8 通过，连续 3 次全绿（20.3–20.5s）** |

E2E 覆盖（协议级）：A 推送 preferences 实体 → B 拉取到相同 payload；preferences 33KB → `400 PAYLOAD_TOO_LARGE`，同一 40KB payload 在 workspace 域成功（证明限额按域生效）；乐观锁冲突与解决在冲突用例中验证。页面级应用（`applyPreferencesPayload` → SettingsManager）、设备级设置不被覆盖（`system.mode`/`diagnosticsRetention` 被排除）、非法值/未知键拒绝由 `tests/unit/sync-preferences.test.ts` 覆盖；E2E 未做页面级断言。

## 8. 已知限制

- 白名单之外的新设置默认不同步，需要人工评估后显式加入。
- Preferences 单实体单条，不做字段级 revision；并发修改由实体 revision 裁决，冲突通过 UI 交给用户选择。
- 主题等应用的即时性依赖 SettingsManager 的 `settings:change` 广播；若某个设置没有接入该广播，需要先在设置系统修复，而不是在同步层补丁。

## 9. 变更文件

- `src/lib/sync/preferences.ts`（新增）
- `src/lib/sync/providers.ts`（preferences provider、冲突记录、解决冲突）
- `src/lib/os20/bridge.ts`（暴露 `syncConflicts` / `syncResolveConflict` / `syncNow`）
- `src/lib/os20/apps/systemcenter.ts`（冲突面板、配额显示）
- `worker/api/sync/{limits,store,handlers}.js`、`migrations/0018_sync_cloud_expansion.sql`
- 测试：`tests/unit/sync-preferences.test.ts`、`tests/unit/systemcenter-sync.test.ts`、`scripts/sync-qa.mjs`、`tests/e2e/sync.spec.ts`
