# Guandao OS 2.0 · 系统架构

> 版本：2.0.0（The Platform Era）
> 目标：在保留 1.x 已验证能力的前提下，把「一个功能丰富的浏览器桌面」升级为
> 「有统一内核、统一应用运行环境、统一权限、统一云端与统一开发者生态的平台」。
> 本文只描述 2.0 实际落地的结构，未实现的部分在每节末尾明确标注。

---

## 1. 总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Presentation Layer                                                       │
│  Desktop Shell (index.astro)   Mobile Shell (/m/)   Widgets   Settings   │
│  Applications: 46 个内置应用 + 插件应用                                   │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │ Ctx / Sys / GOS20 API
┌───────────────────────────────┴──────────────────────────────────────────┐
│ Application Layer（2.0 新增，src/lib/core/**）                            │
│  Kernel       启动编排 / BootReport / 模式切换 / 销毁                     │
│  ServiceHost  统一生命周期（initialize/start/activate/suspend/dispose）   │
│  AppRegistry  应用状态机 + 来源 + 信任等级                                │
│  AppRuntime   launch / minimize / suspend / resume / close / uninstall    │
│  WindowManager 统一窗口 API：open/close/snap/split/restore/snapshot       │
│  PermissionManager 默认拒绝的权限判定 + 审计                              │
│  EventBus     错误隔离的事件总线                                          │
│  SettingsManager 带 Schema 的设置与持久化                                 │
│  NotificationManager 复用 1.x 通知存储的统一入口                          │
│  StorageManager 命名空间 + 版本信封 + 配额                                │
│  MigrationEngine 幂等迁移 + 备份 + 校验                                   │
│  CloudServiceManager 模式 / 会话 / 健康探测                               │
│  SyncEngine   可插拔同步（增量 / 冲突 / 离线队列）                        │
│  DeviceManager 本地设备档案（不冒充服务端设备）                            │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │ Repository / client
┌───────────────────────────────┴──────────────────────────────────────────┐
│ Domain Layer                                                             │
│  User · Device · File · Note · Task · Calendar · Plugin · Theme · Backup  │
│  （当前实现分散在 os14/*、plugins/*、community/*；2.0 未做仓储层抽象）     │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────────────┐
│ Infrastructure Layer                                                     │
│  IndexedDB(blobs/backups) · localStorage · D1 · R2 · Worker API ·         │
│  GitHub OAuth · Service Worker · Supabase（存量社交，未迁移）              │
└──────────────────────────────────────────────────────────────────────────┘
```

**边界规则（2.0 已遵守）**

| 规则 | 实现方式 |
| --- | --- |
| UI 不直接访问 D1 / R2 | 前端只调用 `/api/*`；Worker 内部才碰 Binding |
| 插件不能直接访问数据库 | 插件运行在 opaque iframe，只能走宿主 Broker；Broker 再走 `/api/*` |
| 认证由统一模块处理 | `worker/api/auth/**`；前端只读 `/api/auth/me`、`/api/auth/status` |
| 权限由统一模块执行 | `core/permissions.ts`；插件 `host.ts` 的 `METHOD_PERMISSION` 作为第二道 |
| 数据持久化统一 | `core/storage.ts`（新键）+ 1.x 旧键只读视图；IndexedDB 复用 `os14/core.ts` |

---

## 2. 启动流程

### 2.1 顺序

```
页面加载
  ├─ 内联脚本：决定 shell（desktop / tablet / mobile），避免桌面闪到手机端
  ├─ 1.x 外壳启动：主题、Dock、桌面图标、组件、窗口系统、19 个旧应用注册
  ├─ initOs14()：应用中心/主题/组件/工作空间/按需加载应用注册
  └─ installOs20()（新增，异步）
       ① config        读设置，确定 Local / Cloud
       ② storage       本地数据迁移（先备份 → 再新增键 → 校验旧键仍在）
       ③ events        云端管理器初始化、订阅关键事件
       ④ windows       绑定 WindowShell 适配器，校验窗口容器尺寸
       ⑤ apps          系统应用 Manifest → AppRegistry；窗口状态观察器
       ⑥ device        本地设备档案（不写 D1）
       ⑦ auth          仅 Cloud Mode：/api/auth/me
       ⑧ cloud         健康探测（离线 / Local Mode 时标记 skipped）
       ⑨ layout        恢复 2.0 工作空间快照（跨视口重算几何）
       ⑩ widgets       渲染已启用组件并重新堆叠
       ⑪ shell         写入版本、显示首次启动引导、广播 os20:ready
```

### 2.2 失败语义

| 情况 | 行为 |
| --- | --- |
| 任一阶段抛错 / 超时（默认 8s） | 记为 `failed`，**继续**下一个阶段；进入 `degraded` 列表 |
| 云端不可用（Cloud Mode） | 阶段失败 → 桌面照常启动；系统设置里显示降级原因 |
| 云端不可用（Local Mode） | 阶段记为 `skipped`，附带真实探测结果，不算降级 |
| 本地存储不可用（隐私模式） | storage 阶段失败；本次会话降级为内存存储，界面明确提示 |
| 迁移失败 | 不提升 schemaVersion；旧键未被修改；下次启动重试 |
| 迁移后旧键缺失 | 立刻发 `migration:data-missing` 事件并进诊断日志（不掩盖） |
| 内核整体异常 | `GOS20_READY` 仍 resolve 一份失败报告，1.x 桌面继续可用 |

### 2.3 启动报告

`Kernel.bootReport()` 返回 11 个阶段的 `{ id, label, status, durationMs, detail?, error? }`。
系统设置 → 系统 → 启动报告直接展示；E2E 断言「没有证据的 ok」不存在（每阶段必须有耗时）。

---

## 3. Core 模块设计

| 模块 | 文件 | 职责 | 关键约束 |
| --- | --- | --- | --- |
| Kernel | `core/kernel.ts` | 启动编排、阶段超时、BootReport、模式切换、销毁 | 永不因单阶段失败中止启动 |
| ServiceHost | `core/service.ts` | 拓扑启动、逆序销毁、阶段超时、失败隔离 | 依赖失败 → 下游 `skipped` 而非崩溃；环依赖标记整环失败 |
| EventBus | `core/bus.ts` | 同步派发、通配订阅、once、waitFor、环形历史 | 单订阅者抛错不打断其他 |
| Storage | `core/storage.ts` | `guandao.core.*` 命名空间、版本信封、软配额、旧键只读 | 不迁移、不改写 1.x 旧键 |
| Settings | `core/settings.ts` | Schema、默认值、类型校验、订阅、导入导出 | 每一项都必须在 `apply.ts` 有真实效果 |
| Permissions | `core/permissions.ts` | 声明 / 授予 / 撤销 / 拉黑 / 判定 / 审计 | 默认拒绝；未声明不可授予；系统主体 bypass 但记账 |
| AppRegistry | `core/registry.ts` | 注册、Manifest 校验、状态机、来源/信任、统计 | 状态迁移表之外的跳转直接拒绝 |
| AppRuntime | `core/runtime.ts` | 启动、最小化、挂起、恢复、关闭、卸载、授权 | 非系统应用启动要过权限；失败进误诊断 |
| WindowManager | `core/windows.ts` | 统一窗口 API + 布局 + 快照恢复 | Shell 抛错只记录，不影响桌面 |
| Layout | `core/layout.ts` | 纯几何：贴靠 / 分屏 / 约束 / 跨视口重算 | 无 DOM，可单测 |
| Migration | `core/migrations.ts` | 幂等步骤、备份前置、verify、journal | 备份失败直接中止 |
| Notifications | `core/notifications.ts` | 提交 / 已读 / 统计 / 勿扰 | 复用 `guandao.os.notif.v1`，不建第二份 |
| Device | `core/device.ts` | 本地设备档案、能力探测 | 不生成服务端 device_id |
| Cloud | `core/cloud.ts` | 模式、在线、会话、健康探测、待同步计数 | 探测失败 = unknown/down，绝不显示正常 |
| Sync | `core/sync.ts` | Provider 注册、增量对比、冲突判定、离线队列 | 没有 Provider 就如实显示「未接入」 |

---

## 4. 应用平台

### 4.1 Manifest

```jsonc
{
  "appId": "notes",                       // 小写字母开头，[a-z0-9.-]，≤64
  "name": "Guandao Notes",
  "version": "2.0.0",
  "description": "多文档、文件夹、Markdown 与标签",
  "icon": "di-note",                      // glyph 类名或 https/data URL
  "category": "productivity",             // 7 类之一
  "entry": "os14/apps/notes",             // 模块标识，禁止 URL / 路径穿越
  "minimumOSVersion": "2.0.0",
  "permissions": ["storage.read", "storage.write", "files.write"],
  "dependencies": [{ "appId": "helper", "optional": true }],
  "author": "Guandao Studio",
  "apiVersion": 1
}
```

校验规则（`core/manifest.ts`，纯函数，无 DOM）：

- 必填字段、ID 格式、保留 ID（系统应用才可占用）；
- entry 不允许 `http(s):` / `//` / `..` / 反斜杠 / 绝对路径；
- 权限必须在 `APP_PERMISSIONS` 白名单内，去重；
- 依赖不能指向自己、不能重复、版本必须 semver；
- `minimumOSVersion` 与当前系统比较；`apiVersion > 1` 直接拒绝；
- 校验失败返回逐条 `{ path, code, message }`，不抛异常。

### 4.2 状态机

```
registered ──install──▶ installed ──enable──▶ enabled ──launch──▶ running
      ▲                    │                   │  ▲                 │
      │                    │                   │  └──resume─────────┤
      │                    │                   │        suspended ◀─┤
      │                    │                   │        minimized ◀─┘
      └────uninstall───────┴───────disable──▶ disabled
                                              │
           任何阶段出错 ─────────────────────▶ failed（带 error）
```

- 状态只能由 `AppRegistry` 迁移，UI 不得直接改；
- **窗口 DOM 是运行状态的事实来源**：`os20/bridge.ts` 用 MutationObserver 观察 `.window[data-app]`，
  打开 → `running`，关闭 → `enabled`；
- 系统应用（`source: "system"`）与 `locked` 应用拒绝卸载；
- 状态统计用于系统设置「概览」与诊断。

### 4.3 来源与信任

| source | 含义 | 默认 trust | 卸载 |
| --- | --- | --- | --- |
| `system` | 内置系统应用 | `trusted` | 禁止 |
| `market` | 市场插件/应用 | `unverified` | 允许 |
| `community` | 社区资源（人工审核） | `reviewed` | 允许 |
| `plugin` | 插件注册的应用 | 随插件 | 随插件 |
| `sideload` | 开发者本地 | `unverified` | 允许 |

---

## 5. 窗口系统（Window System 3.0）

### 5.1 分层

```
应用 / 插件 / 工作空间 / 命令面板
        │ wm.open / wm.snap / wm.split / wm.restoreLayout
        ▼
WindowManager（错误隔离、布局策略、快照持久化）
        │ WindowShell 接口
        ▼
Desktop Shell 适配器（os20/bridge.ts: createShell）
        │ 直接调用 1.x 已验证实现
        ▼
index.astro: openApp / closeWin / minimizeWin / maximizeWin / switchSpace
```

- 应用**不再自己实现拖动缩放**；需要窗口能力时走 `GOS20.wm`。
- `WindowShell` 由 1.x 提供 7 个动作 + 几何读写 + 虚拟桌面；2.0 只做编排。

### 5.2 布局能力

| 能力 | API | 说明 |
| --- | --- | --- |
| Free | `wm.open(id, geometry?)` | 自由位置 |
| Snap | `wm.snap(id, zone)` | 10 个区域，几何由 `layout.ts` 计算 |
| Split | `wm.split(ids, direction)` | 2 / 3 屏 |
| Maximize | `wm.toggleMaximize(id)` | 复用 1.x 最大化（含还原几何） |
| Restore | `wm.restoreLayout(snapshot)` | 跨设备重算尺寸与位置 |

### 5.3 快照与跨设备恢复

```ts
type WorkspaceSnapshot = {
  schemaVersion: 2;
  at: number;
  viewport: { width: number; height: number };
  windows: Record<appId, { left; top; width; height; minimized; maximized; space; zone? }>;
};
```

`rescaleSnapshot(snapshot, targetViewport)` 规则：

1. 视口差 ≤8px：只做边界收敛；
2. 视口不同：宽高按较小比例（下限 0.35）缩放，位置按比例平移；
3. 有 `zone` 的窗口按新区间重算贴靠矩形（避免半屏窗口在小屏上变成 1px）；
4. 同位置窗口级联偏移，避免完全重叠；
5. 全部结果再次 `clampRect` 保证最小尺寸 320×240。

1.x 的 `guandao.os.state.v1` 快照由 `normalizeSnapshot` 升级，不丢字段。

---

## 6. 权限系统

### 6.1 判定顺序

```
principal.kind === "system"  → allow（via: system-bypass，写审计）
被拉黑                        → deny（via: blocked）
没有授权记录                  → deny（via: default-deny）
未声明该权限                  → deny（via: not-declared）
已声明但未授予                → deny（via: default-deny）
已授予                        → allow（via: granted）
```

### 6.2 权限清单（应用侧）

`storage.read/write`、`files.read/write`、`clipboard.read/write`、`notifications.post`、
`network.request`、`window.control`、`desktop.modify`、`theme.apply`、`cloud.sync`、
`account.read`、`plugin.manage`。

风险等级：`low` 可在安装时随安装授予；`mid` / `high` 必须逐项确认（卸载/更新时重新确认）。

### 6.3 插件侧的衔接

- 插件权限 id 保持 1.7 的命名（`files.read_selected` 等），不需要因为 2.0 改写 Manifest；
- 插件运行时仍由 `host.ts` 的 `METHOD_PERMISSION` 做第一道，`core/permissions.ts` 是应用侧与系统侧的判定点；
- 2.0 修复了 `widget.setTitle` 缺失与 `ui.setTitle` 静默成功；
- 每次拒绝都会写审计（内存 + 持久化，200 条上限），系统设置 → 隐私与安全可导出。

---

## 7. 云端架构

### 7.1 现状

| 能力 | 端点 | 状态 |
| --- | --- | --- |
| 身份 | `/api/auth/*` | GitHub OAuth + PKCE、HttpOnly Session、撤销 5 条路径 |
| 文件 | `/api/files/*` | D1 元数据 + R2 对象，服务端授权下载 |
| 设备 | `/api/devices/*` | 设备/会话/心跳/撤销/信任 |
| 配对 | `/api/pairing/*` | 6 位码 + SHA-256 + 原设备确认 |
| 接力 | `/api/continuity/*` | 10 分钟 TTL，不要求同时在线 |
| 备份 | `/api/backups/*` | 全量快照 + SHA-256 + 断点；2.0 修了 5000 条目硬顶、下载前校验摘要、Merge 语义 |
| 隐私 | `/api/privacy/*` | 导出、删除、审计、限流；2.0 修了 R2 删除失败的重试 |
| 社区 | `/api/community/*` | 作品、互动、审核 |
| 插件 | `/api/plugins/*`、`/api/developer/*` | 市场、审核、安装记录；2.0 新增运行时安全事件上报 |
| 同步 | `/api/sync/*` | **2.0 新增**：Notes / Tasks / Calendar 的实体级增量同步 |

### 7.1.1 同步协议

```
GET  /api/sync/status              每个域的条目数 / 墓碑数 / 最后更新时间
GET  /api/sync/index?domain=       全量索引（id / revision / deleted / updatedAt）
GET  /api/sync/pull?domain=&since= 增量拉取（含 payload）
GET  /api/sync/pull?domain=&ids=   按 id 拉取（索引 diff 后只取需要的）
POST /api/sync/push                推送变更（带 baseRevision 的乐观锁）
```

- 表结构：`sync_entities(user_id, domain, entity_id, revision, deleted, payload_json, updated_at)`，
  主键 `(user_id, domain, entity_id)`；删除是墓碑，不物理删除。
- 冲突：`baseRevision < 库内 revision` → 返回服务端版本，客户端把服务端版本落回本地，
  不做「最后写入者覆盖一切」。连续编辑同一实体时，服务端版本优先。
- 客户端：`src/lib/sync/providers.ts` 把三个本地存储接进 `core/sync.ts`；
  删除通过 `src/lib/sync/tombstones.ts` 传播；推送成功后清墓碑，失败保留重试。
- 触发：Cloud Mode + 已登录时启动；页面可见时每 10 分钟；网络恢复时；系统设置「立即同步」。
- 边界：单次 100 条、单条 128KB、整包 768KB；索引上限 10000 条；只同步文本数据，不同步文件内容。

### 7.2 客户端状态机

```
Local Mode ──切换──▶ Cloud Mode
    │                   │
    │ 不登录也能用       ├─ 已登录 + API ok      → 已连接
    │ 不上传数据         ├─ 已登录 + API degraded → 部分降级
    └─ 切换不清空数据   ├─ 未登录                → 提示登录
                        └─ 离线                  → 保留待同步队列
```

### 7.3 统一响应与安全边界（2.0 硬化）

- `/api/*` 统一 `{ success, data | error: { code, message }, requestId }`；
- 所有写操作校验同源（Origin，缺失时看 `Sec-Fetch-Site`）；
- 请求体统一 `readJsonLimited`：声明长度 + 实际字节双重复核；
- 初始化管理员：密钥 ≥24 字符 + 全局 10 次/小时锁；
- `/sb` 代理：只放行 `/rest|auth|storage/v1`、方法白名单、300 次/分钟、错误脱敏。

---

## 8. 统一市场与安装

### 8.1 资源类型与处理器

| 类型 | 处理器 | 复用的已验证实现 |
| --- | --- | --- |
| application | `sys.install` + Registry | 1.4 应用中心 |
| plugin | `registry.installFromMarket` | 1.7 插件注册中心 |
| theme | `applyTheme` | 1.4 主题引擎 |
| widget | `ctx.widgets.setEnabled` | 1.0–1.4 组件系统 |
| wallpaper | `api13.setWallpaper` | 1.3 壁纸引擎 |
| workspace | `applyWorkspace` | 1.4 工作空间 |
| community | `installFromServer` | 1.6 社区安装器 |

### 8.2 安装流水线（12 步）

`resolve → source → version → compat → manifest → permissions → confirm → download → verify → install → register → result`

- 每一步都有 `pending / running / ok / skipped / failed` 状态，失败即停并返回**具体**原因；
- 市场 UI 实时显示步骤；「不可安装」时按钮直接禁用并显示预检原因；
- 高风险权限弹勾选框；未确认则停在 `permissions` 步；
- 安装记录写 `guandao.core.market.installs.v1`；
- 2.0 修正了社区 `download_count` 被详情页灌水的问题（只有真实安装才 `count=1`）。

---

## 9. 数据层与迁移

### 9.1 存储键

| 命名空间 | 内容 | 规则 |
| --- | --- | --- |
| `guandao.*`（1.x） | 桌面状态、os13 配置、os14 应用/笔记/任务/日历/主题/工作空间/插件 | 2.0 **只读**，不改写 |
| `guandao.core.*`（2.0） | settings / permissions / apps / layout / onboarding / migrations / device / market | 带 `{ v, at, data }` 信封 |

### 9.2 迁移

```
初始版本判定
  ├─ 有 2.0 迁移记录 → 用记录里的 schemaVersion
  ├─ 无记录 + 有「用户内容」旧键 → 视为 1.x 用户，从 1 开始迁移
  └─ 无记录 + 无用户内容         → 全新安装，直接等于目标版本（不空跑）
```

六步迁移全部是「按需新增」，详见 `docs/MIGRATION-2.0.md`。

### 9.3 服务端迁移

新增 `0013_index_fixes.sql`：修正两个被 `IF NOT EXISTS` 静默跳过的索引名冲突，
补备份分页索引与备份任务索引。历史迁移不改写。

---

## 10. 版本与兼容策略

| 项目 | 版本 | 来源 |
| --- | --- | --- |
| 系统 | 2.0.0 | `src/lib/version.ts`（前端唯一来源） |
| Worker | 2.0.0 | `worker/api/version.js` |
| Service Worker 缓存 | `guandao-2.0.0` | `public/sw.js` |
| 插件 spec | 2.0.0 | `shared/plugin-spec.js` |
| 社区校验 | 2.0.0 | `worker/api/community/validate.js` |
| 数据导出格式 | `guandao-os/2.0` | `version.ts` |
| 插件 SDK | 1 | `shared/plugin-spec.js` |
| 应用 apiVersion | 1 | `core/manifest.ts` |

`scripts/check-version.mjs` 在 CI 里强制以上 5 处版本一致，并拒绝 `scripts/plugins-qa.mjs`
里出现旧的 1.7/1.8/1.9 断言。

**兼容承诺**：插件 SDK 1.x 在 2.x 内保持可用；应用 apiVersion 1 不变；
1.x 的本地数据键不删除、不改写。

---

## 11. 未实现 / 未验证（架构层面）

1. **Domain Layer 没有仓储抽象**：各业务模块仍直接读写自己的 localStorage 键（同步适配器是唯一收口点）。
2. **同步只覆盖三个文本域**：Notes / Tasks / Calendar；主题、组件、工作空间、文件内容不在同步范围。
3. **冲突策略是服务端优先**：不做逐字段三方合并，连续并发编辑可能丢失最后一次修改。
4. **服务端未做路由/限额的统一中间层**：仍有 7 份 `assertSameOrigin`、8 份 `readJson`（本次只修了 3 处不安全的）。
5. **移动端未接入 Core**：`/m/` 是第二套外壳，只共享数据模块，没有共享内核状态。
6. **桌面外壳仍是 17.5k 行单文件**：Core 是「包在外面」而不是「拆进去」。
7. **没有线上验证**：Preview / Production 部署未执行（见 `docs/RELEASE-2.0.md`）。