# Guandao OS 2.0 · 发布说明与交付报告

**版本**：2.0.0
**代号**：The Platform Era（平台时代）
**一句话**：Your Digital World. One Unified Platform. / 你的数字世界，现在是一整套平台。
**日期**：2026-11-05
**状态**：**已部署到 Cloudflare 生产（https://guandao.xin），线上验证通过**
**当前版本**：`a05bedf8-a5ff-4839-a9eb-03ab090b943f`（2026-11-06 17:35，publishable key）

> 本报告按任务书 §22 的 18 项交付物组织。凡是未完成或未验证的，都会在对应位置明确写出，
> 不把「本地通过」写成「线上正常」。

---

## 1. 2.0 架构审计报告

完整审计见根目录 **`GUANDAO_2_0_AUDIT.md`**（11 节，含 46 个功能项的状态矩阵、18 条安全隐患、
技术债清单、风险登记册），区域明细见：

| 报告 | 覆盖 | 行数 |
| --- | --- | --- |
| `audit/part-A-cloud.md` | Worker / D1 / R2 / Session / 备份 / 隐私 | 271 |
| `audit/part-B-community-market.md` | 社区 / 市场 / 安装链 / 数据真实性 | 307 |
| `audit/part-C-plugins-sdk.md` | 沙箱 / 权限 / SDK / CLI / 供应链 | 371 |
| `audit/part-D-mobile-quality.md` | 三模式 / PWA / 接力 / 诊断 / 测试 / 部署 | 276 |

审计核心结论：

- 1.9 的功能是真实的，本地基线 `tsc 0 error / vitest 39/39 / playwright 14/14 / build 通过`；
- 但它不是平台：能力锁在 17,503 行的 `index.astro` 与 3,348 行的 `community.ts`；
- 最严重的是「界面说谎」（诊断的同步恒绿、版本号 1.6/1.8/1.9 三份真相、Cron 描述错误）；
- 两个高危安全问题（初始化密钥可爆破、普通成员无法注销）已在 2.0 修复。

---

## 2. 2.0 系统架构图

```
┌───────────────────────────────────────────────────────────────────────┐
│ Presentation                                                          │
│  Desktop Shell（index.astro 保留）  Mobile Shell（/m/）  46 个内置应用  │
└──────────────────────────────▲────────────────────────────────────────┘
                               │ ctx / sys / GOS20
┌──────────────────────────────┴────────────────────────────────────────┐
│ Application Layer（新增 src/lib/core，18 个文件）                       │
│  Kernel ─ BootReport ─ ServiceHost ─ EventBus                          │
│  AppRegistry ─ AppRuntime ─ WindowManager ─ Layout                     │
│  PermissionManager ─ Settings ─ Notifications ─ Storage ─ Migrations    │
│  CloudServiceManager ─ SyncEngine ─ DeviceManager                      │
└──────────────────────────────▲────────────────────────────────────────┘
┌──────────────────────────────┴────────────────────────────────────────┐
│ 平台应用（新增 src/lib/os20 + src/lib/market）                         │
│  System Center（8 类设置）  首次启动引导（7 步）  更新中心  统一市场     │
└──────────────────────────────▲────────────────────────────────────────┘
┌──────────────────────────────┴────────────────────────────────────────┐
│ Infrastructure：D1 · R2 · Worker API · GitHub OAuth · IndexedDB · SW    │
└───────────────────────────────────────────────────────────────────────┘
```

详细分层、模块职责、启动时序、状态机见 `docs/ARCHITECTURE-2.0.md`。

---

## 3. Core 模块设计

| 模块 | 文件 | 一句话职责 | 关键保证 |
| --- | --- | --- | --- |
| Kernel | `core/kernel.ts` | 11 阶段启动编排 | 单阶段失败不阻止桌面；BootReport 留证 |
| ServiceHost | `core/service.ts` | 统一生命周期 | 拓扑启动、逆序销毁、阶段超时、环依赖识别 |
| EventBus | `core/bus.ts` | 错误隔离事件总线 | 单订阅者抛错不打断其他 |
| Storage | `core/storage.ts` | 命名空间 + 版本信封 | 不改写 1.x 旧键；配额拒绝写 |
| Settings | `core/settings.ts` | Schema 化设置 | 非法值拒绝；每一项都有真实效果 |
| Permissions | `core/permissions.ts` | 默认拒绝的权限判定 | 未声明不可授予；审计可导出 |
| AppRegistry | `core/registry.ts` | 应用状态机 | 迁移表外的跳转拒绝；系统应用禁卸载 |
| AppRuntime | `core/runtime.ts` | 应用生命周期 | 非系统应用启动要过权限 |
| WindowManager | `core/windows.ts` | 统一窗口 API | Shell 抛错只记录 |
| Layout | `core/layout.ts` | 纯几何布局 | 跨视口重算，可单测 |
| Migrations | `core/migrations.ts` | 幂等迁移 | 备份失败即中止 |
| Notifications | `core/notifications.ts` | 统一通知入口 | 复用 1.x 存储，勿扰真实生效 |
| Device | `core/device.ts` | 本地设备档案 | 不生成服务端 device_id |
| Cloud | `core/cloud.ts` | 模式/会话/健康 | 探测失败显示 unknown/down |
| Sync | `core/sync.ts` | 可插拔同步 | 无 Provider 时显示「未接入」 |

公开入口：`src/lib/core/index.ts`（`core@1` 契约）。

---

## 4. 应用运行环境说明

- **Manifest**：14 个字段 + 保留 ID / entry 路径 / 权限白名单 / 依赖 / semver / apiVersion 校验；
  46 个内置应用的 Manifest 在 `src/lib/os20/manifests.ts`。
- **状态机**：`registered → installed → enabled → running ⇄ minimized / suspended`，
  `disabled` / `failed` 为分支；状态迁移表在 `core/registry.ts`。
- **运行状态的事实来源**：窗口 DOM。`os20/bridge.ts` 用 MutationObserver 把「窗口出现/消失」
  映射到 `running` / `enabled`，UI 无法伪造（E2E 断言：打开 notes → running，关闭 → enabled）。
- **按需加载**：沿用 1.9 的 `load()` 机制，内核不预加载应用。
- **来源与信任**：system / market / community / plugin / sideload，系统应用 `locked`。
- **错误隔离**：应用初始化抛错 → 崩溃卡片（可重试/关闭/看诊断），不影响桌面。

---

## 5. 窗口系统说明

- 统一 API：`GOS20.wm`（`open/close/focus/minimize/restore/toggleMaximize/snap/split/moveToSpace/snapshot/restoreLayout/stats`）。
- 布局：Free / Snap（10 区域）/ Split（2 或 3 屏）/ Maximize / Restore。
- 快照：`guandao.core.layout.v2`，`{ schemaVersion: 2, viewport, windows }`；
  跨设备恢复时按视口比例缩放、贴靠窗口按 zone 重算、级联去重叠、最小尺寸兜底。
- 适配器：`os20/bridge.ts:createShell` 直接调用 1.x 的 `openApp/closeWin/minimizeWin/toggleMaximize/switchSpace`，
  **没有第二套拖动/缩放实现**。
- 性能：高频拖动与缩放仍是 1.x 的实现（已验证）；2.0 只增加一次 `getBoundingClientRect` 级别的视图口查询与快照写入（关闭窗口时防抖 300ms）。

---

## 6. 权限系统说明

- 默认拒绝（`via: default-deny`）；系统主体 `system-bypass` 但不跳过审计。
- 13 项应用权限，风险分级 low/mid/high；low 可随安装授予，mid/high 必须逐项确认。
- 声明 ≠ 授予：`grant` 会过滤掉未声明的权限，防止「偷偷提权」。
- 拉黑（`block`）后所有调用拒绝（`via: blocked`）。
- 审计：拒绝立即落盘、允许每 20 条落盘，最多 200 条；系统设置 → 隐私与安全可查看/导出 JSON。
- 插件侧仍由 `host.ts` 的 `METHOD_PERMISSION` 做第一道，2.0 补齐 `widget.setTitle`、
  修正 `ui.setTitle` 静默成功。

---

## 7. 云端架构说明

| 能力 | 状态 |
| --- | --- |
| GitHub OAuth + PKCE、HttpOnly Session、5 条撤销路径 | 已有，未改 |
| 云盘（D1 元数据 + R2 对象，服务端授权下载） | 已有，未改 |
| 设备 / 会话 / 心跳 / 配对 / 接力 | 已有，未改 |
| 备份（SHA-256、断点、历史版本） | 已有；2.0 修了 5000 条目硬顶、Cron 描述错误、下载前摘要校验、Merge 语义 |
| 隐私（导出 / 删除 / 审计 / 限流） | 已有；2.0 修了普通成员注销与 R2 删除重试 |
| 云同步（Notes/Tasks/Calendar） | **2.0 新增并已验证**：`/api/sync/*` + `src/lib/sync/**`，实体级增量、乐观锁、墓碑传播（API 20/20、浏览器双设备 8/8） |
| 统一响应 / 错误码 / 幂等 | `/api/*` 已有统一信封；本次未做路由层重构 |

安全硬化（本次实际修改）：初始化密钥最小长度 + 全局锁、`/sb` 代理白名单/限流/脱敏、
3 处 body 上限改为双重复核、插件更新兼容性重校验、插件逃逸事件上报、跨标签页撤销、
换设备恢复插件不再静默继承敏感权限、`/api/health` 纳入限流、注销 R2 清理可重试、
备份下载校验 SHA-256。

---

## 8. 社区与插件整合说明

- **社区**：保留既有 D1 + R2 实现与人工审核；2.0 修了 `download_count` 被详情页灌水的问题
  （只有真实安装才计数），并把服务端版本校验从 1.6.0 修正到 2.0.0。
- **插件**：保留 1.7 的沙箱与注册中心；2.0 在更新路径补了 `minimumOSVersion` / `sdkVersion` 检查，
  补齐 `widget.setTitle`，修正 `ui.setTitle` 在组件模式下的静默成功。
- **整合入口**：`src/lib/market/hub.ts` 把 7 类资源聚合到一个市场；安装统一走
  `UnifiedInstaller` 的 12 步流水线，**处理器仍是各自已验证的实现**，没有重写。
- 未做：社区资源安装的「逐项权限同意」（当前只展示）、社区/插件评价与审核 UI 的后端对齐。

---

## 9. 开发者平台说明

| 项目 | 状态 |
| --- | --- |
| Application / Widget / Plugin Manifest | 应用侧新增 2.0 Schema；插件侧沿用 1.7 |
| SDK | `public/sandbox/sdk.js`（1 个 SDK major），本次未改接口，只修了宿主侧缺失方法 |
| API Versioning | 应用 `apiVersion: 1`；插件 `sdkVersion: 1`；系统 2.x 内保持兼容 |
| Developer Center | 沿用 1.7（草稿 / 上传 / 审核 / 统计），未改 |
| Developer CLI | **新增 `test` 子命令**（静态自检 6 项）；`package` 明确为 `build` 的别名；`dev` 明确警告「全权限、非生产语义」；`--help` 增加退出码与说明 |
| 文档 | `docs/ARCHITECTURE-2.0.md`；插件文档仍是 1.7 的 `docs/PLUGINS-1.7.md`（未重写） |
| 未做 | SDK 的 `.d.ts`、错误码枚举、SDK 表面 codegen、签名链 |

---

## 10. 数据迁移报告

详见 `docs/MIGRATION-2.0.md`。要点：

- 六步本地迁移，**只新增 `guandao.core.*` 键**，不改写任何 1.x 键；
- 迁移前把全部旧键原始字符串写入 IndexedDB `pre-2.0-*` 快照；备份失败即中止；
- 全新安装不跑迁移（版本判定基于「用户内容」而非「是否存在旧键」）；
- 老用户升级后直接标记引导完成，不强制重新初始化；
- D1 新增 `0013_index_fixes.sql`，本机已应用成功；线上未执行。

验证：迁移引擎单测 5 项 + 浏览器实测（旧键完整、布局保留、设置继承）+ E2E 设置持久化。

---

## 11. 自动化测试报告（本机实跑）

```
npm test
  check:version      → 一致：2.0.0（package.json / version.ts / worker / sw.js / plugin-spec / community）
  check:migrations   → 通过：14 个迁移文件，105 个索引定义（2 条历史重复警告）
  typecheck          → 0 error
  vitest             → 115 passed（6 个文件）
npm run build        → 29 个页面，2.43s，CSP 12 个哈希
npm run check:csp    → 校验通过：12 个哈希与 30 个 HTML 一致
npx playwright test  → 24 passed（44.1s，Phase 1 后）
node scripts/sync-qa.mjs        → 20/20（本地 Worker + D1，HTTP 语义）
node scripts/sync-client-qa.mjs → 8/8（真实 Chrome，两台「设备」）
npm run qa:prod                 → 35/35（生产环境，临时账号，跑完清理）
```

| 测试 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/unit/core.test.ts` | 23 | 事件总线错误隔离、生命周期拓扑/超时/环依赖、存储信封/配额/旧键、设置校验/持久化/导入导出 |
| `tests/unit/platform.test.ts` | 44 | Manifest 校验、权限默认拒绝/防提权/拉黑/审计、应用状态机、布局几何/跨设备重算、同步冲突、迁移引擎、通知勿扰、云端探测 |
| `tests/unit/sync.test.ts` | 9 | 同步墓碑：记录/去重/按域隔离/清理/信封兼容/损坏 JSON 容错 |
| `tests/unit/quality.test.ts` + `perf` + `net` | 39 | 1.9 既有质量层（未回归） |
| `tests/e2e/os20.spec.ts` | 7 | 内核 11 阶段、七步引导与持久化、窗口→状态映射、System Center 落盘、权限拒绝入审计、市场预检、更新中心诚实显示 |
| `tests/e2e/desktop.spec.ts` | 8 | 既有桌面路径（已适配首次引导） |
| `tests/e2e/mobile.spec.ts` + `sandbox.spec.ts` | 6 | 移动端与插件沙箱（未回归） |
| `scripts/sync-qa.mjs` | 20 | 索引/拉取/首次推送/旧 revision 冲突/墓碑/增量/用户隔离/401/非法域 |
| `scripts/sync-client-qa.mjs` | 8 | 内核启动、三个域注册、真实推送、状态 ok、系统设置显示、第二台设备拉取、内容一致、无重复 |
| `scripts/prod-e2e.mjs` | 35 | **生产环境**：会话、云盘上传/下载、同步冲突、备份/校验/下载/恢复、隐私、社区/插件、登录态内核与同步、System Center 配额、PWA 离线、清理 |
| **合计** | **202** | |

未在 CI 覆盖：所有需要真实 Session / 双设备 / 真机 Chrome 的 QA 脚本
（`devices-qa`、`community-qa`、`plugins-qa`、`continuity-qa`、`backups-qa` 等）。
`sync-qa` 可在 CI 运行（自带 wrangler dev），`sync-client-qa` 需要 Chrome，保留为发布前手工验证。

新增 CI 门禁：`check:migrations`、`check:csp`（与 dist 比对）、API smoke job
（wrangler dev --local + `/api/health` 版本 / 未登录 401 / 未知接口 404 / 代理白名单）。

---

## 12. 安全审计报告

### 12.1 本次修复（带验证方式）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 初始化密钥可分布式爆破 | 密钥 ≥24 字符才可用；全局 10 次/小时锁 | 代码审查；本地无法完整模拟多 IP，列为未跑验证 |
| 2 | 普通成员无法注销账号 | 去掉 `role === "admin"` 限制 | 代码审查（需要 GitHub OAuth 的真实双账号才能端到端验证） |
| 3 | `/sb` 是开放中继 | 前缀白名单 + 方法白名单 + 300/min + 错误脱敏 | CI API smoke 断言 `/sb/anything` → 404 |
| 4 | body 上限可被 chunked 绕过 | 3 处改用 `readJsonLimited` | 代码审查 |
| 5 | 插件更新不查兼容性 | 更新路径补 `minimumOSVersion` / `sdkVersion` | `plugins-qa.mjs` 已更新版本断言（未执行） |
| 6 | 插件名 HTML 注入 | 窗口标题与 Dock 选择器 `escapeHtml` | E2E 渲染无报错 |
| 7 | SDK/Broker 漂移 | 补 `widget.setTitle`；`ui.setTitle` 组件模式明确 `UNSUPPORTED` | 代码审查 |
| 8 | 备份 >5000 条目必失败 | 分页读取（2000/页，上限 20000） | 本地 D1 迁移 + 代码审查 |
| 9 | 诊断同步恒绿 | 改为读取真实同步域 | E2E 与代码审查 |
| 10 | 注销时 R2 删除失败被吞 | 前缀级重试（最多 5 轮）+ 失败审计 | 代码审查 |
| 11 | 插件逃逸不上报服务端 | `POST /api/plugins/:id/security` 写入审核队列（1 条/小时去重） | 代码审查（需要已发布插件 + 真实逃逸才能端到端） |
| 12 | 跨标签页撤销不生效 | 监听 `storage`，销毁本页插件运行时 | 代码审查 |
| 13 | 换设备静默继承敏感权限 | 恢复后保持禁用 + 「待确认权限」，必须重新保存授权 | 代码审查 |
| 14 | `/api/health` 匿名不限流 | 纳入限流 120 次/分钟 | CI API smoke 会连续请求 health，仍需通过 |
| 15 | 备份下载不校验摘要 | 下载前复核 manifest/data SHA-256 → 409 | 代码审查 |
| 16 | 备份 Merge 语义名不副实 | 云盘按 SHA-256 跳过重复内容并在结果里报告；文案与实现对齐 | 代码审查 |
| 17 | 插件总存储无上限 | 所有插件共享 2MB 预算（`STORAGE_QUOTA_GLOBAL`） | 代码审查 |
| 18 | 卸载主题插件残留主题 | 卸载时清理自定义主题，正在使用则退回内置主题 | 代码审查 |

### 12.2 仍然存在的风险（未修，已列入 `GUANDAO_2_0_AUDIT.md` §5）

- 插件供应链只有哈希没有签名（checksum 由同一服务端下发）；
- 插件自我导航外泄数据一旦出网无法回滚，独立沙箱域未做；
- `.env` 明文保存 Supabase 凭据（未被 git 跟踪，但建议轮换并移到 Cloudflare Secrets）；
- 同步冲突采用「服务端优先」，不做逐字段三方合并。

### 12.3 未发现（本次复核）

SQL 注入、IDOR、路径穿越、沙箱逃逸、`postMessage` 来源误用、开放重定向、`/sb` SSRF。

---

## 13. 性能测试报告

### 13.1 2.0 新增开销（本机实测，1440×900，本地静态服务器）

| 指标 | 数值 |
| --- | --- |
| DOMContentLoaded | 130 ms |
| load | 166 ms |
| 从导航到 `GOS20_READY` | 220 ms |
| 内核 11 个阶段总耗时 | **43–54 ms**（多次测量；其中云端探测 40–47ms，其余 7ms） |
| 各阶段（一次实测） | config 2 / storage 1 / events 0 / windows 1 / apps 0 / device 0 / auth 0（skipped）/ cloud 47 / layout 0 / widgets 2 / shell 1 |

结论：内核自身开销约 7ms（不含网络探测），没有引入可感知的启动回归。

### 13.2 1.9 基线（`docs/perf-measurements.json`）

冷启动 LCP 348ms；性能实验室测的是 Navigation / Resource / Paint / LCP / CLS / INP 与
`performance.memory`，没有伪造硬件温度/频率。2.0 未改动性能实验室。

未做：节流网络下的移动档位测量、多窗口压力测试、长时间会话内存曲线。

---

## 14. 修改文件清单

### 14.1 新增（54 个）

**Core（18）**
`src/lib/core/types.ts` `bus.ts` `service.ts` `storage.ts` `migrations.ts` `manifest.ts`
`permissions.ts` `settings.ts` `registry.ts` `runtime.ts` `layout.ts` `windows.ts`
`notifications.ts` `cloud.ts` `sync.ts` `device.ts` `kernel.ts` `index.ts`

**平台层（12）**
`src/lib/os20/manifests.ts` `migrations.ts` `apply.ts` `bridge.ts`
`src/lib/os20/apps/onboarding.ts` `systemcenter.ts` `updatecenter.ts` `market.ts`
`src/lib/market/install.ts` `hub.ts`
`src/styles/os20.css`
`migrations/0013_index_fixes.sql`

**云同步（5）**
`worker/api/sync/handlers.js` `worker/api/sync/store.js`
`src/lib/sync/providers.ts` `src/lib/sync/tombstones.ts`
`migrations/0014_sync.sql`

**测试与工程（7）**
`tests/unit/core.test.ts` `tests/unit/platform.test.ts` `tests/unit/sync.test.ts`
`tests/e2e/os20.spec.ts` `scripts/check-migrations.mjs`
`scripts/sync-qa.mjs`、`scripts/sync-client-qa.mjs`（两者计入工程）

**文档（11）**
`GUANDAO_2_0_AUDIT.md`、`docs/ARCHITECTURE-2.0.md`、`docs/MIGRATION-2.0.md`、`docs/RELEASE-2.0.md`、
`docs/SDK-1.md`、`docs/API-2.0.md`、`docs/ACCEPTANCE-2.0.md`、
`audit/part-A-cloud.md`、`part-B-community-market.md`、`part-C-plugins-sdk.md`、`part-D-mobile-quality.md`

**SDK 类型声明（1）**
`public/sandbox/sdk.d.ts`

### 14.2 修改（主要 30 项）

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| 版本 | `package.json`、`package-lock.json`、`src/lib/version.ts`、`worker/api/version.js`、`public/sw.js`、`shared/plugin-spec.js`、`worker/api/community/validate.js` | 统一 2.0.0；新增 `BUILD_INFO` 与 `RELEASES` |
| 桌面外壳 | `src/pages/index.astro` | 引入 os20.css；启动进度接内核事件；`shellOps`；时钟秒；版本徽标 2.0；两处 `escapeHtml` |
| 集成 | `src/lib/os14/index.ts`、`os14/catalog.ts`、`os14/core.ts` | 注册 3 个 2.0 应用；调用 `installOs20`；`ctx.shellOps` 类型；3 个新应用条目 |
| 安全 | `worker/index.js`、`worker/api/auth/{handlers,config}.js`、`files/handlers.js`、`devices/handlers.js`、`privacy/handlers.js`、`plugins/handlers.js`、`ratelimit.js`、`router.js` | `/sb` 白名单与限流、注销修复、初始化锁、body 上限、R2 删除重试、逃逸上报、health 限流 |
| 云 | `worker/api/backups/{handlers,store,archive}.js`、`migrations/README.md` | Cron 描述、分页读取、下载摘要校验、Merge 语义、迁移文档 |
| 同步客户端 | `src/lib/os14/apps/notes.ts`、`os14/tasks-store.ts`、`os14/apps/calendar.ts`、`os14/tasks.ts` | `updatedAt`、墓碑记录、`applySync`、同步后即时重绘 |
| 插件 | `src/lib/plugins/{host,registry,store,ui-kit,manager}.ts` | `widget.setTitle`、`ui.setTitle`、更新兼容性、跨标签页撤销、换设备权限确认、逃逸上报 |
| 社区 | `src/lib/community/{api,install}.ts` | 下载计数语义 |
| 诊断 | `src/lib/quality/diagnostics.ts` | 同步行真实化、移除自回传 |
| 图标 | `src/lib/icons13.ts` | 新增 fresh / store / spark |
| 移动端 | `src/lib/mobile/app.ts`、`src/lib/shell/pwa.ts` | 版本、设备数、错误捕获、SW 更新竞态 |
| 连续 | `src/lib/continuity/app.ts` | 版本文案 |
| 工程 | `astro.config.mjs`、`scripts/{check-version,gen-csp,plugins-qa}.mjs`、`cli/guandao.mjs`、`.github/workflows/quality.yml` | 构建信息注入、版本检查扩展、CSP `--check`、CLI `test`、CI 三 job |
| 测试 | `tests/unit/perf.test.ts`、`tests/e2e/desktop.spec.ts` | 版本断言、首次引导适配 |

---

## 15. Preview 测试结果

**本地静态 Preview（`scripts/serve-dist.mjs` + 真实 Chrome）**：已执行。

| 检查 | 结果 |
| --- | --- |
| 桌面启动与内核 11 阶段 | 通过 |
| 首次启动引导七步 | 通过（截图 `.shots/os20-onboarding.png`） |
| System Center 8 类设置 | 通过（截图 `.shots/os20-systemcenter.png`） |
| 统一市场（92 项资源） | 通过（截图 `.shots/os20-market.png`） |
| 更新中心（诚实显示 404） | 通过（截图 `.shots/os20-update.png`） |
| 应用状态 ↔ 真实窗口 | 通过 |
| 权限默认拒绝 + 审计 | 通过 |
| 设置刷新后仍在 | 通过 |
| 移动端 / 沙箱回归 | 通过 |
| **云同步（真实 Worker + 本地 D1）** | 通过：`sync-qa.mjs` 20/20、`sync-client-qa.mjs` 8/8（两台「设备」） |
| 控制台错误 | 除预期的 `/api/*` 404（静态服务器无 Worker）外无错误 |

截图（仓库内 `.shots/`）：

- `os20-onboarding.png` —— 首次启动引导第 1 步
- `os20-onboarding-personalize.png` —— 第 3 步（主题 / 壁纸 / 程序坞 / 时间显示）
- `os20-systemcenter.png` —— 系统设置 · 外观（10 套主题 + 壁纸）
- `os20-systemcenter-system.png` —— 系统设置 · 系统（版本、构建信息、11 阶段启动报告）
- `os20-systemcenter-privacy.png` —— 系统设置 · 隐私与安全（权限总览）
- `os20-systemcenter-cloud.png` —— 系统设置 · 云端（模式、同步域、存储用量）
- `os20-market.png` —— 统一市场（7 类资源 + 详情）
- `os20-update.png` —— 更新中心（真实显示「检查失败 HTTP 404」而不是假的「已是最新」）

**Cloudflare Preview（独立预览环境）**：未单独创建。本项目是 Worker + Static Assets 的单环境结构，
2.0 直接发布到生产并通过线上验证（见第 16 节）；没有把「本地 Preview」当成生产结果。

**Cloudflare Preview 部署**：**未执行**。需要真实账号凭据与人工确认，本次没有可用的
Cloudflare 凭据，也没有被授权部署。

---

## 16. Production 部署结果

**已部署到 Cloudflare 生产（2026-11-05）。**

| 项 | 值 |
| --- | --- |
| 域名 | https://guandao.xin |
| Worker | `my-homepage`（Worker + Static Assets） |
| 首次发布版本 | `814d1f9a-fc55-48a9-883e-521e8fe6f3cc` |
| 修复后版本 | `8866fe13-e122-4331-8f25-bb80231aa73d` |
| **最终线上版本** | **`a05bedf8-a5ff-4839-a9eb-03ab090b943f`**（publishable key 切换，2026-11-06 17:35） |
| 部署时间 | 2026-11-05 20:34 / 20:39 / 21:49（Asia/Shanghai） |
| 迁移前备份 | `%TEMP%\guandao-d1-pre-2.0-20261105-2032.sql`（130 KB 逻辑导出） |
| D1 迁移 | `0013_index_fixes.sql`、`0014_sync.sql` 均已应用（5 + 4 条语句） |
| 上一版本（可回滚） | `fecd8355-fa4d-45d0-91b5-76d5192b5d7f`（1.9） |

### 16.1 发布前检查

```text
npm run verify → check:version 一致 / check:migrations 14 文件 105 索引
                 typecheck 0 error / vitest 115 passed
                 build 29 页 / check:csp 12 哈希与 30 个 HTML 一致
D1 导出          → 成功（130 KB）
D1 迁移          → 0013 ✅ / 0014 ✅
schema 复核      → sync_entities + 2 个索引存在
```

### 16.2 线上验证（真实请求）

| 检查 | 结果 |
| --- | --- |
| `GET /api/health` | `200`，`version=2.0.0`，`status=ok`，D1 `connected`，R2 `available`，285ms |
| `GET /api/auth/status` | `200`，`initialized=true`，`configured=true` |
| `GET /api/sync/status`（未登录） | `401`（符合预期） |
| 首页 HTML | `200`，`#mb-version = 2.0`，CSP 头存在 |
| `/m/` 移动端 | `200` |
| `/sw.js` | `200`，缓存版本 `guandao-2.0.0` |
| 浏览器内核启动 | `GOS20_READY`：`2.0.0`，11 个阶段全部成功，`degraded=[]` |
| CSP 违规 | `0`（12 个内联脚本哈希与 dist 一致，构建后部署） |
| 控制台错误 | `0` |
| 首次启动引导 | 新访客正常出现；老用户不会重复引导 |
| System Center · 云端 | 本地模式 + 未登录：同步域显示「未接入」，存储用量显示「登录后可用」 |
| 更新中心 | 当前 2.0.0，服务端 2.0.0，兼容性 46 个应用全通过，迁移显示「无需迁移（数据已是 2.0 格式）」 |
| 数据完整性 | 迁移后 `users=1 / sessions=3 / files=0 / backups=0 / sync_entities=0`，与迁移前一致 |
| 线上截图 | `.shots/prod-2.0-desktop.png`、`prod-2.0-systemcenter-cloud.png`、`prod-2.0-update.png` |

### 16.3 发布中发现并修复的问题

1. **更新中心误导性文案**：首次上线后把「全新安装无需迁移」显示成
   「未完成（下次启动会自动重试）」。修复为按 `from/to` 区分「无需迁移」与真实失败，
   二次部署（`8866fe13`），线上复核显示「无需迁移（数据已是 2.0 格式）」。
2. **首次启动引导覆盖运行模式**：生产端到端测试发现，引导默认 `mode: "local"`，
   点击「跳过引导」会把已登录的 Cloud Mode 静默切回 Local Mode，导致云同步停止、
   系统设置显示未登录。修复为：
   - 引导打开时从当前设置初始化模式/程序坞/图标标签/时钟；
   - 只有「完成引导」或用户**主动点过模式卡片**时才写入 `system.mode`；
   - 直接跳过保留原有模式。
   三次部署（`3540542e`）后复测：跳过引导后 `notes:ok,tasks:ok,calendar:ok`，
   系统设置显示已登录账号与真实配额。
3. **手机端无法阅读博客 / 使用桌面应用**：手机访问 `/` 会被自适应逻辑带到
   `/m/` 手机伴侣，而伴侣页只有笔记/任务/日历/文件，没有博客与桌面应用的入口，
   也没有返回桌面版的出口。修复分两步：
   - 手机底栏新增第 6 个入口「桌面」（`/?desktop=1`），进入后是完整桌面
     （文章/博客、全部应用、窗口系统），可在「视图 → 手机布局」切回；
   - **手机访问站点网址默认进入手机伴侣**：Worker 对 `GET /` 按
     `Sec-CH-UA-Mobile` / UA 直接 302 到 `/m/`（不再先把 497 KB 桌面主包发给手机）；
     `?desktop=1` 是显式例外。
   - 「桌面」选择只记在 `sessionStorage`（本次会话），不再写 localStorage；
     新标签页重新打开网址仍进手机伴侣，旧的 `desktop` 偏好也会被忽略。
   部署 `ce79490a`，生产 iPhone 13 实测：`/` → 302 → `/m/`、桌面主包请求 0；
   点「桌面」→ `/?desktop=1` + 28 个图标；新标签页 `/` → `/m/`；桌面浏览器 `/` 保持桌面。
   移动端 E2E 6 项（含「默认进伴侣」「旧偏好不回桌面」「桌面只在本会话生效」）。

### 16.5 生产端到端验证（`npm run qa:prod`）

用临时账号（`qa-e2e-*`，结束后连同 D1 行与 R2 对象一并清理）在**生产环境**跑通 35 项：

| 分组 | 覆盖 | 结果 |
| --- | --- | --- |
| 会话 | `/api/auth/me`、Session 列表 | 通过 |
| 云盘 | 上传 201 → 列表 → 内容原样读回 → 下载附件头 | 通过 |
| 同步 | 推送 → 索引 → 旧 revision 冲突 → 按 id 拉取 | 通过 |
| 备份 | 保护性 + 手动备份、`run`、`verify`、JSON 下载含 SHA-256 | 通过 |
| 恢复 | 删除文件 + 清空回收站 → 恢复 → 文件重现、内容一致 | 通过（`filesRestored=1`） |
| 隐私 / 安全 | `/api/privacy/overview`、`/api/security/activity` | 通过 |
| 社区 / 插件 | 公开列表 200 | 通过 |
| 浏览器 | 带 Cookie 启动内核 11 阶段、客户端拉到服务端笔记、三个同步域 ok、System Center 显示已登录 + `62 B / 5.0 GB` | 通过 |
| PWA | SW 激活接管、断网刷新仍能打开桌面 | 通过 |
| 清理 | 测试账号/数据无残留 | 通过 |

截图：`.shots/prod-e2e-cloud.png`。

### 16.6 Phase 1 · 安全与数据基线（2026-11-06）

部署：Worker **`a5161e28`**（Phase 1），**`a05bedf8`**（publishable key）。

| # | 报告项 | 状态 | 结果 |
| --- | --- | --- | --- |
| 1 | `.env` 凭据审查 | **Verified** | 仅检查变量名；`SUPABASE_DB_PASSWORD` 零引用、未进 dist，已从本地 `.env` 移除 |
| 2 | Supabase 真实依赖 | **Verified** | 仍承载存量社交：`index.astro` 23 处、`cloud.ts` 8 处；生产 `/sb` 代理存活（401） |
| 3 | 凭据轮换 | **Verified（owner-confirmed）** | publishable key 已部署验证；legacy anon/service_role 已由项目所属账号在控制台停用（2026-11-06 17:44） |
| 4 | Guards 统一 | **Verified** | `worker/api/guards.js` 单一实现；8 模块迁移 |
| 5 | 已迁移路由 | **Verified** | auth / files / devices / backups / privacy / community / plugins / sync |
| 6 | R2 巡检真实运行 | **Verified** | 管理员接口 + CLI；本地与生产均实跑 |
| 7 | 巡检对象数量 | **Verified** | 生产：D1 引用 0；R2 对象 12；匹配 0；缺失 0；孤儿候选 12（仅报告，未删除） |
| 8 | 依赖清理 | **Verified（结论修正）** | `@astrojs/markdown-remark` 是 Astro 7 配置必需；移除后 `astro check` 报错，已保留并加入白名单 |
| 9 | Astro 类型检查 | **Verified** | 246 文件，0 errors / 0 warnings / 137 hints；已进 CI |
| 10 | ESLint | **Verified** | Worker/scripts/CLI 安全规则，0 problems；已进 CI |
| 11 | 单元测试 | **Verified** | 115 passed |
| 12 | E2E | **Verified** | 24 passed（新增移动端 3 项） |
| 13 | 生产测试 | **Verified** | `qa:prod` 35/35（恢复后复跑） |
| 14 | 部署 | **Verified** | `/api/health` 200 · D1 connected · R2 available |
| 15 | 未解决 | — | 12 个 R2 孤儿待确认；137 hints；生产数据事件 **Mitigated / Pending Investigation**（见 §16.7） |

**安全探针（生产）**

| 场景 | 结果 |
| --- | --- |
| 未登录 `GET /api/admin/r2-audit` | 401 `UNAUTHENTICATED` |
| 跨源 `POST /api/sync/push` | 403 `CSRF_REJECTED` |
| 同源合法 `POST /api/sync/push` | 400 `EMPTY_BATCH`（到达业务层，未被 CSRF 拦） |
| 2 MB JSON `PATCH /api/auth/profile` | 413 `PAYLOAD_TOO_LARGE` |
| chunked 10 KB（无 content-length） | 413 `PAYLOAD_TOO_LARGE` |

**生产数据事件与恢复**

Phase 1 最终核验时发现 `users` 表为 0（原 1 个账号、3 Session、3 设备）。仓库内所有清理
SQL 均带 `qa-*` 条件；`account_deletion_audit` 与 `data_deletion_jobs` 均无记录，根因尚未定位。
已用 D1 Time Travel 恢复到 `2026-11-05T14:00:00Z`（bookmark
`00000062-00000756-0000511a-de8adea84001d106447f2c537b31a3a6`），恢复结果：
1 账号 / 3 Session / 3 设备 / 0 文件 / 0 备份。恢复前已导出当前库到
`%TEMP%\guandao-d1-before-recovery-20261106-131708.sql`；可用
bookmark `000000b4-ffffffff-0000511b-08ef306eee34571a050a63e8c6cac6b1` 撤销恢复。
已给 `scripts/prod-e2e.mjs` 加双重护栏：仅允许 `qa-e2e-*`，且删除用户时附带测试邮箱条件。

**publishable key 切换记录（2026-11-06 17:35）**

| 项 | 结果 |
| --- | --- |
| `.env` | `PUBLIC_SUPABASE_ANON_KEY` 与 `SUPABASE_ANON_KEY` 均为 `sb_publishable_*`（不记录具体值） |
| 构建 / 部署 | `npm run build` → Worker `a05bedf8-a5ff-4839-a9eb-03ab090b943f` |
| 生产验证 | `GET /sb/auth/v1/settings` **200**；首页 `/sb/rest/v1/polls`、`/votes` **200/200**；0 console error |
| 产物扫描 | 76 个 JS/HTML：0 个含旧 JWT（`eyJhbGci`）、0 个含 `sb_secret_`、27 个含 publishable |
| legacy 停用 | 2026-11-06 17:44 由项目所属账号在控制台停用（anon + service_role） |
| 停用后复测 | `/sb/auth/v1/settings` **200**；首页 `/sb/rest/v1/polls`、`/votes` **200/200**；0 console error；`/api/health` 200 |

**legacy keys 停用结果**

- 控制台操作：Settings → API Keys → **Legacy API keys** → **Deactivate legacy keys**；
- 停用后线上只依赖 publishable key；项目代码未使用 service_role，故无服务端影响；
- 说明：旧 anon key 未在仓库/文档中保留，因此没有做「旧 key 401」的服务端复测；
  以控制台状态 + 新 key 线上 200 + 页面社交请求 200 作为完成证据，标记 **Verified（owner-confirmed）**；
- 若要重新启用 legacy（不推荐），控制台同一位置可恢复。

> 本机 PAT 均无 `api_gateway_keys_read` 权限（令牌账号下可见项目为 0），因此停用动作由项目所属账号在控制台完成；完成后已复核新 key 与首页社交请求均 200。

### 16.7 生产数据事故调查（2026-11-06）

完整记录见 [`docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md`](INCIDENT-2026-11-06-ACCOUNT-DELETION.md)。

| 项 | 状态 |
| --- | --- |
| 事故 | `users=0`（原 1/3/3），已通过 D1 Time Travel 恢复 |
| 根因 | **Pending Investigation**（无直接证据） |
| 应用内注销 | **已排除**（无 `account_deletion_audit`、无注销事件） |
| Cron 删除 | **已排除**（`data_deletion_jobs=0`） |
| QA 清理 | **已排除**（全部 SQL 带 `qa-*` 条件；sync QA 仅 local） |
| 未排除 | 人工 D1 SQL/Dashboard、仓库外脚本、平台异常、凭据滥用 |
| 证据缺口 | Cloudflare Audit Logs 403；无 Worker 持久日志；D1 无 SQL 审计 |
| 防护 | `scripts/lib/qa-cleanup.mjs` + 应用内注销四重约束 |
| 测试 | 11/11 清理护栏测试；`verify` / 24 E2E / 20 同步 QA 通过 |
| 生产变更 | **无**（未部署、未执行 Time Travel、未跑 qa:prod） |

**应用内注销加固**：`session.user.id === userId`；必须有 `checkpoint.auditId`；
`DELETE FROM users` 限定 `deletion_state='pending'` 且必须恰好影响 1 行；审计在删除成功后标记完成。

**QA 清理加固**：只允许 `qa-` + `qa-*@example.test`；marker/runId 匹配；删除前重读账号并核对
id/email/github_username/created_at；目标行数必须为 1；关联资源 >1000 中止；SQL 同时约束
`id + email + LIKE qa-%`；删除后复核为 0；失败抛出，不扩大条件。

**恢复 qa:prod 的前置条件**：owner 确认无手工删除、Cloudflare Audit Logs 可读或明确接受无日志、
新护栏在本地复跑通过。当前建议暂缓。

### 16.8 生产数据安全补强（2026-11-06）

本专项只做代码、脚本、迁移与本地验证；**未部署、未应用生产迁移、未写生产数据**。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Audit Logs 权限 | **Pending Manual Action** | Wrangler OAuth 无 `audit_logs`，API 403；见 `docs/SECURITY-AUDIT-ACCESS.md` |
| D1 整库备份 | **Implemented / 本地验证** | `scripts/db-backup.mjs`：backup / verify / list / restore-check；本地 62 表 519 行、加密、篡改检测、隔离恢复通过 |
| 每日自动备份 | **未启用** | `.github/workflows/db-backup.yml`；缺 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`D1_BACKUP_KEY` |
| 数据异常监控 | **Implemented / 本地 scheduled 验证，未部署** | 迁移 `0015_data_monitor.sql` + Cron `runDataMonitor` + 管理员接口；本地 1 快照 / 0 告警 |
| 告警通知 | **未配置** | 只写 D1；`DATA_ALERT_WEBHOOK` 未设置，不伪造送达 |
| 安全事件日志 | **Implemented / 本地验证，未部署** | 新增注销失败/监控/备份/QA 清理事件；Token/Cookie/邮箱过滤 |
| 自动化测试 | **Verified（本地）** | 11 清理 + 8 备份 + 9 监控 + 11 Workflow + 4 恢复 + 6 日志 = 49/49 |
| 生产变更 | **无** | 未部署、未应用迁移、未跑 qa:prod、未写 D1/R2 |

文档：`docs/SECURITY-AUDIT-ACCESS.md`、`docs/D1-BACKUP-RECOVERY.md`、
`docs/PRODUCTION-DATA-MONITORING.md`、`docs/SECURITY-EVENT-LOGGING.md`。

### 16.9 Phase 2.1 Desktop Shell CSS 拆分（2026-11-06 实施 / 2026-11-07 复核）

| 项 | 结果 |
| --- | --- |
| 结构 | `index.astro` 内联全局 CSS 9,799 行拆为 `src/styles/desktop/` 18 个内容文件 + 入口 |
| 行数 | `index.astro` 17,566 → **7,766 行**（602,226 → 331,283 B） |
| 语义等价 | 18 文件合计 **270,945 B**，与拆分前内联块字节完全相同；`@keyframes`/`@media`/`:root` = 35/12/4 |
| 加载顺序 | 构建 `index.B_TNKWp7.css` hash/大小未变（273,238 B），仍是第 2 个 stylesheet |
| 视觉 | 19/21 逐像素完全一致；1 张通知红点（动态）；1 张单像素 Δ=3/255；147/147 boundingBox 一致 |
| 生产 UI | **已只读复测**：生产 10 个 CSS 资产与本机构建同名同字节；渲染检查 9/9 |
| 取证缺口 | 已关闭：`1440x900-dialog` 恢复复采（diff=0）；截图脚本入库 `a712d96` |
| 测试 | `verify`、24 E2E、`qa:sync` 20/20、`check:astro`、`lint`、`check:csp` 通过（2026-11-07 实跑） |
| 首屏 CSS | **476,749 B，超 200 KB → 移交 Phase 6.2**；2.1 验收口径已修订，未删样式凑数 |
| 生产 | **已随 6928916f 上线**；本阶段未部署、未改数据 |
| 结论 | **Verified**（结构 / 语义 / 视觉口径）；分支 `refactor/2.1-desktop-css-extraction` |

> **验收口径修订（2026-11-07 所有者决定）**：首屏 ≤ 200 KB 结构性不可达（仅桌面样式包即 273,238 B），
> 已移交 Phase 6.2「CSS 拆分与按需加载」，当前 476,749 B 作为 6.2 起点基线。
> 2.1 判 `Verified` 只针对本次搬迁，不代表性能目标达成。

详见 `docs/architecture/DESKTOP-CSS.md`（权威说明）、`docs/PHASE-2.1-CSS-AUDIT.md`、`docs/PHASE-2.1-CSS-REFACTOR.md`。

### 16.10 Phase 1.6 生产数据保护（2026-11-07）

| 项 | 状态 |
| --- | --- |
| D1 存储版本 | **production**（只读 API 确认；支持 Time Travel） |
| Workflow | **生产真实执行成功**（5 steps，SQL 100,976 B） |
| 每日调度 | **已启用（Worker Cron）** `0 19 * * *` |
| 独立 R2 Bucket | **已创建** `guandao-db-backups` |
| D1 REST Token | **已设置，export 可用**（完整权限未枚举） |
| 加密 / SHA-256 | **生产验证通过**（R2 回读 `sha256_match`；对象 100,992 B） |
| 隔离恢复 | **生产备份隔离验证通过**：63 表/16 迁移；`productionTouched:false` |
| 备份监控 | **已部署**（26h stale / failed / unknown） |
| 生产备份 | **成功**（R2 100,992 B；SHA match） |
| 生产变更 | **已部署 `6928916f`、创建 Bucket/Secret、应用 0015/0016** |

文档：`docs/operations/D1-BACKUP.md`、`D1-RECOVERY.md`、`D1-MONITORING.md`。
生产备份已成功；因真实告警通知渠道未配置，状态保持 **Implemented / Partially Verified**。

### 16.11 Phase 2.2 旧版应用迁移（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 已迁移 | **5 个**：`posts`（文章）/ `about`（关于）/ `rank`（排行榜）/ `calc`（计算器）/ `viewer`（图片查看器） |
| 结构 | 新增 `src/lib/legacy-apps/`：8 文件 / 470 行，含类型契约与共享上报 |
| 接入 | 复用 `registerApp` + `LegacyAppContext` 显式注入；注册点位于 `renderDock()` 之前 |
| `index.astro` | 7,765 → **6,605 行**（迁移 5 个应用 + 删除 831 行死代码；331,283 → 283,007 B） |
| 重复实现 | 排行榜上报由外壳 60s 计时器与排行榜窗口共用一份 |
| 回归 | E2E **36/36**（新增 12）；单测 **123/123**（新增 8）；`verify` 绿；`qa:sync` 20/20 |
| 未迁移 | 12 个应用仍读闭包（终端/设置 10–12 项外壳依赖；树洞·议会·社会网络共享认证） |
| 死代码 | **已删除 831 行**：`notes`/`calendar`/`files`/`music` 旧实现被 os14 覆盖；补 `openFromHash()` 保证深链 |
| 生产变更 | **无**（未部署、未改数据、未跑 `qa:prod`） |
| 结论 | **Partially Verified** |

详见 `docs/architecture/LEGACY-APPLICATIONS.md`。

### 16.12 Phase 2.3 统一 HTML 转义与 URL 校验（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 统一模块 | 新建 `src/lib/html.ts`：`escapeHtml` / `escapeAttr` / `safeUrl` / `isSafeUrl` |
| 迁移重复实现 | **6 处**：`os14/core.ts`、`mobile/ui.ts`、`quality/errors.ts`、`index.astro`、`home.astro`、`notes.astro` |
| 保留例外 | `blog/index.astro`（`<script is:inline>` 不能 import，改模块会改 CSP 哈希） |
| 新能力 | `safeUrl` 协议白名单——此前全仓库**没有任何 URL 协议校验** |
| URL 应用 | 4 处第三方入口（插件主页、开发者网站、截图、图标） |
| 测试 | 单元 **40/40**；DOM **11/11**（含对照组）；`verify` 163 单测；E2E **49/49**；`qa:sync` 20/20 |
| 未解决 | 34 处动态 URL 插值 / 22 处直接赋值未做协议校验；268 处 `innerHTML` 未逐一审计 |
| 生产变更 | **无** |
| 结论 | **Partially Verified** |

详见 `docs/architecture/HTML-SECURITY.md`。

### 16.13 Phase 2.3.1 全量 HTML 安全审计（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 扫描 | TypeScript AST：HTML sink **268**、动态 URL **42**、直接 URL 赋值 **22**，合计 333 处 |
| 动态 URL | **42 → 0**：社区封面/头像 15、插件 3、对象 URL 7、内部路径 2、常量等，按用途分别用 `safeUrl` |
| 直接赋值 | **22 处全部 Safe**：`blob:` / 内部路径 / 常量，属性赋值不经 HTML 解析 |
| 修复 | 发现 2 份上一轮正则漏掉的转义副本（`pairing/page.ts`、`admin/index.astro`） |
| 保留例外 | 1 处：`blog/index.astro` 内联副本 + 20 组一致性测试 |
| 自动化 | `npm run check:html-security` 已接入 `verify`；白名单需 reason，文件级 count 防漂移 |
| 测试 | 单元 **47**；DOM **26**；`verify` 170 单测；E2E **64**；`qa:sync` 20/20 |
| 生产变更 | **无** |
| 结论 | **Verified** |

详见 `docs/architecture/HTML-SECURITY.md` 附录。

### 16.14 Phase 2.4 事件与资源生命周期治理（2026-11-07）

| 项 | 结果 |
| --- | --- |
| Scope | 复用 `src/lib/quality/resources.ts`，未新建第二套资源管理器 |
| 修复 | **1 个真实缺陷**：`once: true` 监听器触发后计数与登记不回收 |
| 测试 | Scope 契约 **19 项**；生命周期 E2E 扩展到 **7 项计数** + 4 项功能回归 |
| 20 次开关 | listeners 5→5、timeouts 1→1、intervals 1→1、rafs 0→0、scopes 7→7、observers 4→4、objectUrls 0→0 |
| 模块迁移 | **0 个**：审计未发现泄漏，不为覆盖率强行改写现有归属 |
| Root Disposal | **不启用**：`pagehide` 与 BFCache 冲突（已论证并记录） |
| 监控盲区 | 已如实列出（Scope 内计数、无 subscription/WebSocket 独立计数） |
| 全量门禁 | `verify` 189 单测；E2E **64**；`qa:sync` 20/20 |
| 生产变更 | **无** |
| 结论 | **Verified** |

详见 `docs/architecture/EVENT-LIFECYCLE.md`。

### 16.15 Phase 2.5 社区模块拆分（批次 1，2026-11-07）

| 项 | 结果 |
| --- | --- |
| 原始规模 | `community.ts` 3,350 行 / 171,279 字节，公开导出仅 2 个 |
| 已拆出 | `community/{types,constants,ui}.ts` = **252 行**（类型 / 常量 / 纯渲染工具） |
| 入口 | `community.ts` 3,163 行，导出面 `["initCommunity","renderCommunity"]` 有测试锁定 |
| 循环依赖 | 无；共享状态未复制 |
| 测试 | 新增 **6 项**；`verify` 195 单测；E2E **64**；`qa:sync` 20/20 |
| 未完成 | `initCommunity` 内 73 个闭包函数（批次 2–4） |
| 生产变更 | **无** |
| 结论 | **Partially Verified** |

详见 `docs/architecture/COMMUNITY-ARCHITECTURE.md`。

### 16.16 Phase 3 插件供应链安全与多设备验证（2026-11-07）

**本阶段未部署生产**，以下结果全部来自本地 / 隔离环境（`wrangler dev --local` + 本地 D1/R2）。

**1. 插件发布者签名（Ed25519）**

- 新增 `shared/plugin-signature.js`（519 行）与 `.d.ts`：签名信封 + 规范化载荷。
  载荷 = 信封去 `sig` 后 `canonicalJson` 的 UTF-8 字节；v1 只允许字符串 / 非负整数 / 布尔，
  字段缺失即非法——从设计上排除了 JSON 键序、Unicode 归一化与数值格式差异。
- 新增迁移 `0017_plugin_signatures.sql`：`publisher_keys`（只存公钥，唯一约束）+ `plugin_versions` 的
  `signature_json / signature_status / signature_key_id / signed_at` 四列。只增不删。
- 服务端：上传期 `resolveSignature` 校验，非法签名 **422 且不写版本行**；下载期每次重新验签
  （`SIGNATURE_INVALID` 409）；安装期拒绝已撤销密钥与身份不匹配。
- 客户端：`src/lib/plugins/signature.ts` 独立验签，公钥只从服务端 `publisherKeys` 取；
  `registry.ts` 四条下载路径（云端恢复 / 市场安装 / 更新 / 回滚）全部接入。
- CLI：`keygen`（本地生成，私钥写 `mode 0o600` 文件）、`sign`、`keys register`；`publish --key` 自动签名。
- 市场与插件管理器：市场列表卡片、市场详情页、插件管理器「已安装」列表与详情都显示「已签名 / 未签名 / 签名无效」，
  管理器详情额外显示签署时间；同时修复了管理器 `listView()` 在「已安装」标签有记录时不渲染列表的缺陷。
- 兼容策略：阶段 A（可选签名）——无签名旧包仍可安装但标记 `unsigned`；签名无效一律拒绝，不静默降级。

**2. 沙箱隔离（实测）**

- 未改 `host.ts` / `runner.html` / `worker/index.js`，**未新增任何 `allow-*`**，双层 iframe 保持
  `sandbox="allow-scripts"`（opaque origin）。
- 新增 `tests/e2e/sandbox-worker.spec.ts`（10 项，真实 Worker + 真实 CSP）：消息通信、伪造来源、
  恶意 postMessage、未授权 Broker、读宿主存储、读 Cookie、导航逃逸销毁、权限撤销销毁、跨标签页撤销。
- `tests/e2e/sandbox.spec.ts` 由 3 项扩到 6 项（静态层契约断言 + opaque origin 行为验证）。

**3. 双浏览器设备配对 / 接力 / 剪贴板**

- 新增 `tests/e2e/device.spec.ts`（**12 项**，连续两轮全绿且中间不重启服务、不清库）与
  `tests/e2e/support/device-flow.ts`：A / A2 / B / C / outsider / crowded **六个独立 `browser.newContext()`**，
  不共享 Cookie / localStorage / IndexedDB。
- 覆盖：配对创建契约、批准语义（含同账号其他设备 `WRONG_DEVICE`）、错误码与取消、完整配对并领取独立 Session、
  **真实过去时间戳的过期拒绝**、**设备上限 `DEVICE_LIMIT`**、claim 同源校验与 `INVALID_TOKEN`、
  接力四态、接力错误码、剪贴板隔离与 4000 字符上限、撤销后全部 401。

**4. OAuth 可重复测试**

- `AUTH_TEST_MODE` 为三条件 AND：`env.AUTH_TEST_MODE === "1"` **且** 请求 origin **且** 配置 origin
  都是 loopback；查询参数无法开启；测试身份只来自固定 `qa-*` 档案；state / PKCE / Cookie 属性零改动。
- `tests/e2e/oauth.spec.ts` 14 项：回调 → Session → `/api/auth/me` → 退出，以及 state 缺失 / 不匹配 /
  过期、非法测试角色、生产 origin 拒绝。

**5. 质量门禁（本机实跑）**

| 门禁 | 结果 |
| --- | --- |
| `npm run verify` | 通过（typecheck、**12 文件 / 251 单测**、`check:html-security`、lint、build、`check:csp` 12 哈希 / 30 HTML） |
| `npx playwright test`（整包，四 project 一次运行） | **147 passed**（chromium 67 + worker 56 + firefox 12 + webkit 12，3.0m） |
| 其中 worker project | **56 passed**（真实 Worker 8788：签名 19 / 沙箱 11（含独立 Origin 两源 1）/ 设备 12 / OAuth 14） |
| 其中 firefox-worker project | **12 passed**（Firefox 157，设备配对/接力/剪贴板） |
| 其中 webkit-worker project | **12 passed**（WebKit 27.2，Safari 家族引擎，设备配对/接力/剪贴板；≠ 真机 Safari/iOS） |
| `npm run qa:sync` | **20/20** |
| `npm run qa:plugins` / `qa:continuity` | **70/70** / **45/45**（自包含运行器：本地迁移 + QA seed + `wrangler dev --local` 8794） |
| `npm run qa:pairing-ttl` | **12/12**（真实等待 10 分钟，`elapsedMs=605004`）：TTL 契约、过期轮询/确认 410、重领 404、设备快照不变 |
| `npm run qa:devices` | **31/31**（自包含运行器：本地 seed + `wrangler dev --local` 8794；设备总览/心跳/CSRF/跨账号/会话撤销/设备撤销） |
| `npm run qa:prod` | **禁止执行**（Phase 1.6 门禁） |

> CI：`.github/workflows/quality.yml` 的 E2E job 已加 `npx playwright install --with-deps firefox webkit`，四个 project（chromium / worker / firefox-worker / webkit-worker）会全部在 CI 执行；worker project 的 e2e-server 自行迁移本地 D1 并生成夹具。2026-11-09 已推送到独立分支 `ci/phase3-verify` 并通过 PR #1 触发 quality workflow（run `42564445648`）：verify / API smoke / E2E 三个 job 全部 success，E2E 实跑 **147 passed (3.8m)**，与本地一致。首次实跑暴露两个全新 checkout 问题（`backups/` 忽略规则误伤源码目录、typecheck 前缺 `astro sync`），已在 `559adf5` 修复并复跑通过；未合并、未部署。

**6. 顺带修复的真实缺陷**

1. `POST /api/pairing/claim` 缺 `assertSameOrigin` —— 任意第三方页面可替用户提交 claim。
2. `POST /api/continuity/:id/open` 响应的 `openedAt` 恒为 `null`。
3. `mapSignatureTrust` 从错误模块导入 → Worker 构建失败（`tsc` 不检查 `.js`，只有真实构建能发现）。
4. CLI `sign` 产物写到 CWD；`signBundleObject` 未回填 `filesDigest`。
5. `ApiError` 新增 `details` 参数，客户端可区分具体签名失败原因。
6. 插件管理器「已安装」标签页存在本地记录时不渲染列表（`listView()` 缺分支）——已修复。
7. `worker/api/continuity/handlers.js` 的剪贴板分支调用未导入的 `requireSession`（重构漏改，运行时 ReferenceError）——改为统一 `requireActiveSession`。
8. 撤销后 401 错误码不一致——新增 `guards.sessionFailure()` / `requireActiveSession()`，devices / continuity / clipboard / pairing 统一返回 `SESSION_REVOKED` / `DEVICE_REVOKED`。
9. `PAIRING_ATTEMPTS_EXCEEDED` 分支不可达（配对只有 pending 能被认领、认领后即置 claimed，attempts 永不累加）——删除假保护，真实防线（10 分钟 TTL + 10 次/10 分钟/IP + 源设备确认）写入注释。
10. E2E 就绪竞态：Playwright 以 `/api/health` 判定 e2e-server 就绪时，Worker 已健康但 `buildFixtures()` 仍在写本地 D1，测试与夹具写入抢锁曾致夹具生成失败、服务退出（`ECONNRESET`）。已把就绪探针改为夹具管理端口 `GET /__e2e/ready`（该端口只在夹具全部生成后监听）。

**7. 未完成 / 风险**

- 生产部署、生产验证、真实域名均未做；非 Chrome 引擎已用 Firefox 157 + WebKit 27.2 覆盖，但真机 Safari / iOS 未验证。
- 独立 Sandbox Origin：已有本地真实两源隔离实测（`tests/e2e/sandbox-origin.spec.ts`）；但生产域名/证书/Worker route **未创建**，且实测发现 Cookie 作用域是 host（换端口不隔离），落地必须使用独立 host。
- 真实 10 分钟配对 TTL 已由 `npm run qa:pairing-ttl` 覆盖；两台物理设备的人工冒烟未做。
- 导航逃逸只能事后惩罚；D1 是安装完整性信任根（安装接口不读 R2 原文）。
- Phase 2 的 2.2 Legacy / 2.5 Community 仍为 `Partially Verified`，作为独立遗留项跟踪，不阻塞 Phase 4（所有者 2026-11-09 确认）。

**结论：`Accepted (Local/CI)`；生产层 `Blocked`。** 本地 / 隔离环境与 GitHub Actions 全部通过（quality 三 job 全绿、E2E 147 passed）；生产部署、生产验证、物理设备与真机项按 Phase 1.6 门禁未执行，不写成「已验证」。PR #1 仅用于触发 CI，验证后已关闭、未合并 `main`，分支 `ci/phase3-verify` 保留。

### 16.17 Phase 4 云同步扩展与冲突解决（2026-11-09）

**本阶段未部署生产、未应用生产迁移**；以下结果全部来自本地 / 隔离环境（`wrangler dev --local` + 本地 D1）与真实浏览器 Context。

**1. 五个同步数据域**

- 迁移 `0018_sync_cloud_expansion.sql`：重建 `sync_entities` 的 domain CHECK（`notes / tasks / calendar / workspace / preferences`）并新增 `deleted_at`；
  旧表改名保留为 `sync_entities_legacy_v1`（不 DROP，可回滚）；新增 `sync_tombstone_ledger`（防复活）与 `sync_cleanup_log`（审计，保留 200 行）。
- `worker/api/sync/limits.js`：按域 payload 上限（workspace 128 KB、preferences 32 KB、其余 128 KB）、单用户实体 5000、墓碑 2000、TTL 90 天。
- `worker/api/sync/store.js`：墓碑写 `deleted_at` 与台账；实体行已清理时用台账拦截旧 `baseRevision`（返回合成 `deleted` 冲突，**不复活**）；
  新增配额统计/写前估算/分批清理（200/批）。
- `worker/api/sync/handlers.js`：`/status` 增加 `quotas`；push 按域校验并返回 409 `QUOTA_EXCEEDED` / 400 `PAYLOAD_TOO_LARGE`。
- `worker/index.js`：现有 `*/15` Cron 增加独立捕获异常的墓碑清理任务。

**2. Workspace 同步（4.1）**

- 新增 `src/lib/sync/workspace.ts`：只同步 `preset:false` 的自定义工作空间；payload ≤128 KB，名称/数组/窗口/组件均限长；
  跨端应用时用 `layout.normalizeSnapshot` + `rescaleSnapshot(cascade:false)` 按当前视口重算窗口几何，未重写 Window Manager；
  删除用 known-id 追踪合成墓碑，同 id 重建可撤销删除。
- `src/lib/os14/workspaces.ts`：`Workspace` 增加 `viewport`，`capture()` 写入，`applyWorkspace` 在恢复窗口前重算几何。

**3. Preferences 同步（4.2）**

- 新增 `src/lib/sync/preferences.ts`：**13 项白名单**（主题/材质/圆角/强调色/动画、图标文字/时钟秒/Dock 自动隐藏与位置/组件透明度、勿扰/音量、更新通道）；
  显式排除 `system.mode`、`system.diagnosticsRetention` 与全部设备级信息；payload ≤32 KB；未知键/非法值拒绝；应用走 SettingsManager。

**4. 冲突可视化与解决（4.3）**

- 新增 `src/lib/sync/conflicts.ts`：最多 50 条、TTL 7 天、按 `${domain}:${entityId}` 去重、受控快照 ≤4KB/边且脱敏、仅本地不上传。
- `providers.ts`：5 域注册；冲突时保留「服务端版本落回本地」并记录冲突元数据；`resolveSyncConflict` 支持保留本地（以 serverRevision 重推，乐观锁不关，
  再次冲突返回 `changed`）与保留云端（pull→apply→revision→清除），重复调用 noop 幂等。
- System Center 云端设置：新增配额 KPI（实体/5000、墓碑/2000）与「最近同步冲突」面板（域/实体/时间/revision、保留本地/保留云端、清理已解决）。

**5. 质量门禁（本机实跑 + GitHub Actions）**

| 门禁 | 结果 |
| --- | --- |
| `npm run verify` | 通过：typecheck、**18 文件 / 331 单测**、security:test 六组、`check:unused` 18、`check:astro` 0 errors/0 warnings/149 hints、`check:html-security` 291 处全审查、lint、build 29 pages、CSP 12 哈希/30 HTML |
| `npm run check:migrations`（verify 内） | **18 个迁移 / 117 个索引**；两条历史遗留 `idx_backups_*` 重复索引 warning（非本阶段引入） |
| `npx playwright test`（整包一次运行） | **155 passed（2.9m）**：chromium 67 + worker 64 + firefox 12 + webkit 12 |
| 其中 worker project | **64 passed**（真实 Worker 8788：签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / **同步 8**） |
| `npm run qa:sync` | **45/45**（含 `--test-scheduled` 真实触发清理、配额 5000→409、preferences 40KB→400、台账防复活、清理幂等） |
| `npm run qa:devices` | **31/31**（回归，无回退） |
| `npm run qa:prod` | **禁止执行**（Phase 1.6 门禁未解除） |
| GitHub Actions quality | **全绿**（run [42965051693](https://github.com/guandao6666-creator/my-homepage/actions/runs/42965051693)，commit `04cf8f8`）：verify / API smoke（含 `qa:sync` 45 项）/ E2E **155 passed (4.5m)** |

GitHub Actions（`.github/workflows/quality.yml`，run [42965051693](https://github.com/guandao6666-creator/my-homepage/actions/runs/42965051693)，commit `04cf8f8`）三个 job 全绿：Typecheck/Unit/Build、API smoke（真实本地 D1 上 `qa:sync` 45 项）、E2E（四 project，**155 passed / 4.5m**）。CI 使用 Node 22.23.4（`.nvmrc`），与本地 Node 26 的结果一致。

同步 E2E（`tests/e2e/sync.spec.ts`）连续 3 次全绿（20.3 / 20.5 / 20.5s，8 项）：两个独立 `browser.newContext()` 分别使用同账号两台设备的真实 Session，
覆盖 workspace 推送/索引/拉取/修改/墓碑/防复活/重建、preferences 按域限额、冲突与保留本地/云端链路、参数边界 400/403/413、账号隔离与配额自洽。
开始与结束均调用仅本机的 `POST /__e2e/reset-sync` 清理夹具，可重复运行。

**6. 顺带发现与处理**

1. SQLite 不能修改 CHECK 约束 → 0018 采用「旧表改名保留 + 新建 + 复制数据」，保留回滚路径，不删除任何用户数据。
2. D1 的 IN 参数上限 → 批量查询按 ≤100 分块，避免大用户量下查询失败。
3. E2E 首次失败是测试假设错误（`/api/auth/me` 不走 `{success,data}` 信封），按真实契约修正测试，未改产品代码。

**7. 未完成 / 风险**

- 生产 D1 迁移（0018）与生产双设备同步验证未执行；未部署、未运行 `qa:prod`。
- 页面级冲突面板/解决动作的浏览器 E2E 未做：`dist` 由 Phase 4 客户端代码合入前的构建提供，`sync.spec.ts` 走协议级；
  客户端状态机由 `tests/unit/sync-conflicts.test.ts` 覆盖，UI 纯函数由 `tests/unit/systemcenter-sync.test.ts` 覆盖；构建后应补一次页面级确认。
- 5000 实体 / 2000 墓碑的 409 造数不在 E2E 中，由 `qa:sync` 真实触发。
- 90 天 TTL 采用「TTL + 台账」策略；离线超过 90 天的设备再同步会收到 deleted 冲突（预期）。清理日志未接外部告警。
- Phase 2 的 2.2 Legacy / 2.5 Community 仍为 `Partially Verified`，作为独立遗留项跟踪。

**结论：`Partially Verified`（本地 / 隔离层通过；生产层 `Blocked`）。** 全部本地门禁与真实浏览器 Context 证据通过；生产迁移、生产验证、页面级冲突 UI E2E 与物理设备冒烟按 Phase 1.6 门禁未执行，不写成「已验证」。

### 16.18 Phase 5 社区与市场发布链（2026-11-11）

**1. 目标与范围**

在不重写社区产品与插件市场的前提下，把社区 / 插件从「代码已实现」推进到「完整发布链经过真实、可重复验证」：5.1 社区发布链 E2E、5.2 Tutorials 复用与展示、5.3 审核/举报/下架/审计闭环；插件沿用 Phase 3 签名策略与 UnifiedInstaller。

**2. 本阶段交付**

- `scripts/community-qa.mjs` 重写为自包含 14 段 / 260 项断言 + 31 项清理断言（真实 `wrangler dev --local`、新 QA 身份、唯一 runId）；`scripts/qa-local-run.mjs` 增 `community` target（`--test-scheduled`）；`scripts/seed-qa-local.mjs` 增 `QA_COMMUNITY_TOKENS`；`scripts/lib/qa-cleanup.mjs` 的 `CHILD_TABLES` 追加 7 张社区表；`package.json` 的 `qa:community` 改为自包含包装器。
- 修复真实缺陷：`src/lib/os14/community.ts` 的 `loadDetail` 曾把 tutorial 排除在拉包之外，导致教程正文永不渲染。
- 插件 QA：`scripts/plugins-qa.mjs` 新增 37 项完整发布链（Ed25519 签名 verified → submit → 审核 → 市场 → 下载复算 SHA-256 → 安装 → takedown → 审计）；新增 `tests/e2e/plugin-publishing.spec.ts`（4 Context）。
- 教程测试：新增 `tests/unit/community-tutorial.test.ts`（20）与 `tests/e2e/community-tutorial.spec.ts`（双 Context 全链）。
- 文档：新增 `docs/architecture/COMMUNITY-PUBLISHING.md`；更新本文件、`GUANDAO_2_0_AUDIT.md`（附录 O）、`GUANDAO_2_0_ROADMAP.md`（5.5）、`docs/ACCEPTANCE-2.0.md`。

**3. 质量门禁（本机实跑 + GitHub Actions）**

| 门禁 | 结果 |
| --- | --- |
| `npm run verify` | exit 0；19 文件 / **351 单测**；html-security 291 处全审查；lint；build 29 pages；CSP 12 哈希/30 HTML；migrations 18/117 |
| `npx playwright test` | **158 passed（2.9m）**：chromium 67 + worker 67（签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / 同步 8 / 教程 2 / 插件发布链 1）+ firefox 12 + webkit 12 |
| `npm run qa:sync` | **45/45**（Phase 4 域无回归） |
| `npm run qa:community` | **260/260 ×3**（47.5s / 47.6s / 48.0s；清理 R2=OK / 身份=OK / 残留=0） |
| `npm run qa:plugins` | **107/107 ×2**（原 70 + 新增 37） |
| GitHub Actions quality | **全绿**（run [43588486049](https://github.com/guandao6666-creator/my-homepage/actions/runs/43588486049)，commit `a84af7e`）：verify（19 文件 / 351 单测、migrations 18/117、CSP 12/30）/ API smoke（qa:sync 45/45）/ E2E **158 passed (4.4m)** |

GitHub Actions quality 全绿（run [43588486049](https://github.com/guandao6666-creator/my-homepage/actions/runs/43588486049)，commit `a84af7e`）：Typecheck/Unit/Build（19 文件 / 351 单测、migrations 18/117、CSP 12/30）、API smoke（本地 D1 上 qa:sync 45/45）、E2E（四 project，**158 passed / 4.4m**）。CI 使用 Node 22.23.4（`.nvmrc`），与本地结果一致。

**4. 安全 / 隔离验证**

- 权限：所有非 GET 走 `assertSameOrigin`；审核接口服务端 `isStaff`（403），敏感动作 `requireAdminRole`；普通用户 403、未登录 401、下架后公开 404。
- 上传：`assertImage` magic bytes、大小上限、所有权校验；R2 先写后 D1，D1 失败清理对象，无孤儿。
- 清理：复用 `scripts/lib/qa-cleanup.mjs` 四重校验（QA id/email 正则、期望身份重读、目标数量上限、删除行数断言），失败抛错不退化；三轮运行后 D1 基线 `total_posts=11`、`total_assets=9` 不变、残留 0。
- 未新增生产调试接口；未绕过 Phase 3 签名与权限策略。

**5. 未完成 / 风险**

- 生产发布链未执行（生产 D1/R2 写入、生产迁移、部署、`qa:prod` 均按 Phase 1.6 门禁禁止；备份告警未配置、2026-11-06 事故未 Closed）。
- 插件客户端安装的页面级证据为本地证据脚本（真实桌面页 + UnifiedInstaller，20/20 + 截图），未并入 Playwright；Playwright 内为协议级。
- 教程无页面级浏览器 E2E；正文渲染由 `renderMarkdown` 源码守卫 + API/单测覆盖。
- `follow` 正向链路在无 UUID 创作者的新库 SKIP（API 强制 UUID 属生产设计）。
- `seed-qa-local.mjs` 复用唯一 admin 并清其其它 session，与 e2e fixtures 共用 admin 时不可并发；spec 已做回退。

**结论：`Partially Verified`（本地 / 隔离层通过；生产层 `Blocked`）。** 社区与插件发布链在真实 Worker + 本地 D1/R2 上完整通过并可重复运行；生产发布链与页面级插件安装（Playwright 内）未执行，不写成「已验证」。

### 16.4 回滚预案（已确认可用，未实际执行）

```bash
npx wrangler rollback 3540542e-a45c-4802-b3cb-852d0627814a   # 回滚到上一版本
npx wrangler rollback fecd8355-fa4d-45d0-91b5-76d5192b5d7f   # 回滚到 1.9
```

- 上一版本仍在部署历史中，可一键回滚；
- D1 的 0013 只新增索引、0014 只新增表（`sync_entities`），**回滚代码不需要回滚数据库**；
- 2.0 只新增 `guandao.core.*` 本地键，未改写 1.x 数据，回滚到 1.9 不会丢用户数据；
- 未做线上回滚演练：本次发布窗口内没有出现需要回滚的故障。

---

## 17. 已知限制

1. **同步只覆盖 Notes / Tasks / Calendar**：主题、组件、工作空间与文件内容不在 2.0 同步范围。
2. **同步冲突是「服务端版本优先」**：不做逐字段三方合并，连续并发编辑可能丢失最后一次修改。
3. **插件供应链无签名**：只有哈希，checksum 由同一服务端下发。
4. **插件逃逸事件会上报，但数据一旦出网无法回滚**；独立沙箱域未做。
5. **移动端只覆盖 5 类应用**，三模式判定仍有 3 份拷贝。
6. **`index.astro` 仍是 17.5k 行**（ADR-1：不重写稳定外壳）。
7. **服务端同源/JSON 校验收敛完成（Phase 1）**；剩余安全逻辑集中在 `worker/api/guards.js`。
8. **两套云栈并存**（D1/R2 与 Supabase 存量社交）。
9. **回滚未实际演练**：上一版本可用、数据库无需回滚，但本次发布没有执行一次真实回滚。
10. **首次启动引导在极窄屏的排版**只做了基础适配（≤900px 隐藏侧栏），未做真机回归。
11. **设置项的「下次启动生效」**（运行模式、更新通道）不会立即重启系统，需要用户手动刷新。
12. **插件存储上限约 6MB**、**卸载主题插件残留主题**：两个低风险问题已在 2.0 修复（总预算 2MB + 卸载清理）。

---

## 18. 2.0 发布说明（可直接作为更新日志）

### Guandao OS 2.0 · The Platform Era · 平台时代

**新增**

- **统一内核 Guandao Core**：11 阶段启动流程、生命周期、事件总线、错误隔离、启动报告。
- **应用注册中心与正式 Manifest**：46 个内置应用全部登记；状态由真实窗口驱动，不再靠 UI 自我描述。
- **统一权限服务**：默认拒绝、逐项授权、拉黑与审计日志导出。
- **Window System 3.0**：统一窗口 API，贴靠 / 分屏 / 工作空间快照 / 跨设备几何重算。
- **系统设置（System Center）**：外观、个性化、应用、插件、云端、设备、隐私、系统八类，改动真实落盘。
- **首次启动七步引导**：欢迎、Local/Cloud 模式、个性化、设备名称、桌面应用、工作空间、完成；可跳过、状态持久化。
- **更新中心**：当前版本、构建时间、服务端版本检查、插件兼容性、数据保护检查、更新历史与回滚说明。
- **应用与资源市场**：应用 / 插件 / 主题 / 组件 / 壁纸 / 工作空间 / 社区七类资源统一入口，12 步安装流水线。
- **云同步（Notes / Tasks / Calendar）**：实体级增量同步、乐观锁冲突检测、删除墓碑传播；系统设置可一键同步。
- **1.x 数据迁移**：先快照、再新增、幂等可重试、旧键零改动。

**修复**

- 普通成员无法注销账号（重新验证被写死为 admin）。
- 初始化管理员密钥可被分布式爆破（新增最短长度与全局锁）。
- `/sb` 同源代理可被当作开放中继（前缀/方法白名单 + 限流 + 错误脱敏）。
- 3 处请求体上限可被分块传输绕过。
- 插件更新不检查系统兼容性。
- 插件名可注入宿主 HTML（窗口标题 / Dock 选择器）。
- SDK 声明了 `widget.setTitle` 但宿主没有实现；组件模式 `ui.setTitle` 静默成功。
- 插件逃逸只做本地封禁，服务端看不到事件（现进入审核队列）。
- 撤销插件权限不跨标签页；换设备恢复插件会静默继承敏感权限（现在需要本机重新确认）。
- 社区下载量被详情页浏览灌水。
- 诊断中心把「没有同步引擎」显示成「已同步」。
- 备份条目超过 5000 必失败；备份下载不校验摘要；恢复的 Merge 语义名不副实。
- 注销时 R2 清理失败被吞掉，现在会重试并留下审计。
- `/api/health` 匿名不限流。
- 版本号 1.6 / 1.8 / 1.9 三份真相；CI 现在强制一致。
- 桌面 `/` 未进 PWA 预缓存导致首访后断网白屏；SW 更新检查竞态。

**工程**

- 新增 115 项单元测试、7 项 2.0 E2E；加上同步联调与生产端到端，共 202 项自动化验证通过。
- CI 增加迁移静态检查、CSP 哈希与 dist 一致性校验、`wrangler dev --local` API 冒烟。
- 新增 CLI `test` 子命令（Manifest / 入口 / SDK 表面 / 打包摘要 6 项自检）。
- 新增 `scripts/sync-qa.mjs`（API 20 项）与 `scripts/sync-client-qa.mjs`（双设备 8 项）。

**升级方式**

2.0 已于 2026-11-05 发布到 https://guandao.xin，直接刷新页面即可（Service Worker 会在后台更新缓存）。
首次打开会看到引导（老用户不会）；本地数据在迁移前会先做快照，
迁移只新增 2.0 需要的键，1.x 的笔记、任务、日历、文件、主题、组件、插件配置全部保留。
Cloud Mode 登录后，Notes / Tasks / Calendar 会在后台首次同步；也可以到「系统设置 → 云端」手动点「立即同步」。

如果浏览器仍显示旧版本，强制刷新一次（`Ctrl/Cmd + Shift + R`）或在更新中心点「重新加载并更新」。

---

*Guandao OS 2.0 — The Platform Era. Your Digital World, Reimagined.*