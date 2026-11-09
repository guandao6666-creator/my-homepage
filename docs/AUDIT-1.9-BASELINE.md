# Guandao OS 2.0 · 全项目审计报告

**审计对象**：`C:\Users\1\Desktop\my-homepage`（基线版本 1.9.0，审计后升级为 2.0.0）
**审计日期**：2026-11-05
**审计方式**：只读代码审查 + 本地实跑（`check:version` / `tsc` / `vitest` / `playwright` / `astro build` / `wrangler d1 migrations apply --local`）
**证据约定**：所有结论均标注 `文件:行号`；无法确认的写「无法确认」，不以文档宣称代替代码事实。

> 这份报告是 Phase 1 的产物。第 8 节之后列出 2.0 的实际处置（已修 / 已建 / 仍是限制），
> 与 `docs/RELEASE-2.0.md` 的交付清单一一对应。

---

## 0. 结论摘要

1. **1.9 不是空壳**：桌面、窗口、Dock、主题、组件、笔记/任务/日历/文件、云盘、备份、设备、接力、社区、插件市场、开发者中心、诊断与性能实验室都有真实实现，本地实跑基线为 `tsc 0 error`、`vitest 39/39`、`playwright 14/14`、构建通过。
2. **但它不是一个「平台」**：系统能力锁在 17,503 行的 `index.astro` 与 3,348 行的 `community.ts` 里；应用没有 Manifest、没有统一状态机、没有统一权限判定；安装链有 5 条互不相通；版本号有 4 份真相且 CI 只覆盖其中 4 处中的 4 处（见 §5.4）。
3. **最严重的问题不是功能缺失，而是「看起来正常」**：诊断中心的 Cloud Sync 永远显示绿色，而仓库里根本没有同步引擎；`/api/plugins/meta` 对外报 1.8.0；社区首页抄的是 1.6.0；`backups` 的 `cronInfo` 声称每日 18:00，实际触发器是每 15 分钟。这些都属于「界面说了谎」，是 2.0 必须优先修掉的部分。
4. **两个高危安全缺陷已确认可复现的代码路径**：初始化窗口内管理员密钥可被分布式爆破（仅每 IP 限流、无全局锁、无最小长度）；普通成员永远无法注销账号（重新验证被写死为 admin）。
5. **数据安全底线是好的**：所有用户数据查询都带 `user_id`，未发现 SQL 注入 / IDOR / 路径穿越；备份有 SHA-256 校验与断点；迁移顺序正确且全增量。2.0 的迁移策略可以建立在「保留旧键、只做新增」之上。

---

## 1. 审查方法与环境

### 1.1 实跑基线（审计开始时）

| 项目 | 结果 |
| --- | --- |
| `npm run check:version` | 一致：1.9.0 |
| `npm run typecheck` | 0 error |
| `npm run test:unit` | 39/39（3 个文件） |
| `npm run test:e2e` | 14/14（对当时 dist） |
| `npm run build` | 29 个页面，2.4s，CSP 哈希 12 个 |
| `wrangler d1 migrations apply --local` | 0001–0012 已应用；0013 为 2.0 新增 |

### 1.2 审查范围

- 前端：`src/pages/index.astro`（17,503 行）、`src/lib/os13.ts`（2,396 行）、`src/lib/os14/**`、`src/lib/plugins/**`、`src/lib/community/**`、`src/lib/continuity/**`、`src/lib/mobile/**`、`src/lib/quality/**`、`src/styles/**`
- 后端：`worker/**`（约 6,800 行）、`migrations/0001–0012`、`shared/plugin-spec.js`、`public/sandbox/**`
- 工程：`scripts/**`、`tests/**`、`.github/workflows/**`、`wrangler.jsonc`、`astro.config.mjs`
- 文档：`README.md`、`docs/*.md`（仅作「宣称对照」，不作证据）

### 1.3 明确未做的事

- 没有在 Cloudflare 线上环境执行任何操作（不部署、不改 D1/R2）。
- 没有读取任何真实用户数据。
- 需要真实 Session / 双设备 / 真机 Chrome 的 QA 脚本（`devices-qa.mjs`、`community-qa.mjs` 等）没有执行，因此相关功能不能标记为 `Tested`，只能按代码证据标 `Implemented`。
- R2 桶是否真正私有、线上 secrets 是否配置、迁移是否已应用：**无法确认**（仓库里没有这些信息）。

---

## 2. 当前架构（1.9 基线）

### 2.1 分层现状

```
┌─────────────────────────────────────────────────────────────────────┐
│ index.astro（17,503 行）                                            │
│  ├─ 模板（菜单栏 / Dock / 桌面 / 窗口容器 / 启动遮罩）               │
│  ├─ 内联脚本（约 6,900 行）：窗口系统、Dock、启动台、Spotlight、      │
│  │   Mission Control、虚拟桌面、组件、19 个 1.0–1.2 应用、成就、      │
│  │   Supabase 社交（树洞/议会/社会网络/访客墙）                       │
│  └─ 全局样式（约 9,800 行）                                          │
├─────────────────────────────────────────────────────────────────────┤
│ src/lib/os13.ts（2,396 行）：壁纸引擎、Dock 3.0、图标布局、          │
│   菜单栏控制中心、个性化设置、动态桌面                                │
├─────────────────────────────────────────────────────────────────────┤
│ src/lib/os14/**（约 30 个模块）：应用目录与安装、主题、组件、         │
│   工作空间、笔记/任务/日历/文件/音乐/相册/阅读器、应用中心、          │
│   数据中心、设备、备份、隐私、社区、插件桥接                          │
├─────────────────────────────────────────────────────────────────────┤
│ src/lib/plugins/**（12 个模块）：Manifest 校验、安装/更新/回退、      │
│   沙箱宿主、命令面板、市场、开发者中心                                │
├─────────────────────────────────────────────────────────────────────┤
│ src/lib/quality/**（8 个模块）：错误边界、资源域、诊断、性能、        │
│   网络、离线队列                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ worker/**：路由 → 模块 handler → store → D1 / R2；Cron 每 15 分钟     │
├─────────────────────────────────────────────────────────────────────┤
│ 另一套云栈：Supabase（前端 build 期内联 + 运行时 /sb 同源代理）       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键事实

- 部署形态是 **Worker + Static Assets**，不是 Cloudflare Pages / Pages Functions（`wrangler.jsonc:4,19-26`）。README 有 4 处仍是 Pages 时代口径。
- 应用生命周期**不存在统一状态机**：`sys.running()` 数的是窗口 DOM（`os14/system.ts:187-198`），安装状态在 `guandao.os14.apps.v1`（`os14/catalog.ts:680-752`），插件安装状态在 `guandao.plugins.v1`。UI 可以任意描述「运行中」。
- 窗口系统**只有一套**，能力锁在 `index.astro` 闭包里（`focusWin/closeWin/minimizeWin/maximizeWin/snapZone/makeDraggable/bindResize`），应用只能通过 `ctx.openApp(id)` 使用（`os14/core.ts:67-116`）。
- 权限只有「展示 + 插件 Broker」：应用侧 `catalog.ts:49-57` 的 `permissions` 仅用于详情页文案；插件侧 `host.ts:63-89` 的 `METHOD_PERMISSION` 是真实判定，但服务端与客户端各写一套。
- 云同步不存在：`sync_changes` 表（`0001_init.sql:82`）全仓零读写；`devices/handlers.js:434-443` 明确对本地数据域返回 409；前端 `runQueuedSync` 只查一次配额（`devices/client.ts:382-397`）。

---

## 3. 功能状态矩阵

状态定义：**Implemented**（代码真实存在且能工作）/ **Tested**（有可重复执行的自动化验证）/ **Partially Implemented** / **Not Implemented** / **Broken** / **Deprecated**。
「Tested」只给被 `vitest` 或 `playwright` 覆盖、且本次实跑通过的路径；需要真实 Session / 双设备 / 真机的脚本不计入。

### 3.1 Desktop

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| 桌面环境 | Tested | `tests/e2e/desktop.spec.ts:37-49` | 菜单栏 / 图标 / Dock 渲染有断言 |
| 桌面壁纸 | Implemented | `os13.ts:400-470`、`wallpapers.ts` | 24 张本地壁纸，无远程随机源 |
| 桌面图标 | Tested | `desktop.spec.ts:37-49`；`os13.ts:689-750` | 网格 / 自由布局、右键菜单 |
| Dock | Tested | `desktop.spec.ts:71-82` | 打开/关闭与状态点同步 |
| 菜单栏 | Implemented | `index.astro:166-260`、`os13.ts:1512-2390` | 含控制中心与账号菜单 |
| 控制中心 | Implemented | `os14/control.ts` | 明确标注真实/模拟数据 |
| 通知中心 | Implemented | `index.astro:880-975`；`os14/../../..` | 单一 localStorage 数组，2.0 复用 |
| Mission Control | Implemented | `index.astro:6628-6690` | 只做窗口缩略图，无跨屏拖拽 |
| 虚拟桌面 | Implemented | `index.astro:1190-1270` | 桌面增删改 + 窗口归属 |
| 桌面 Widget | Implemented | `index.astro:6768-7150`、`os14/widgetstore.ts` | 19 个组件，可拖动/缩放 |
| 主题系统 | Implemented | `os14/themes.ts` | 10 套主题 + 自定义 + 导入校验 |

### 3.2 Application

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| 应用中心 | Implemented | `os14/appcenter.ts` | 分类/搜索/详情/安装 |
| 应用注册系统 | Partially Implemented | `index.astro:4288-4309`、`os14/index.ts:233-247` | 只有 `registerApp`，无 Manifest、无状态机 |
| 应用安装 / 卸载 | Implemented | `os14/system.ts:111-149` | 真实改写登记状态；系统应用禁止卸载 |
| 窗口管理 | Implemented | `index.astro:4319-4760` | 拖动/缩放/贴靠/最大化/多桌面 |
| 应用生命周期 | Partially Implemented | `index.astro:4756-4900` | 有 init/cleanup 与崩溃卡片，但无 suspend/resume、无状态上报 |
| 本地数据管理 | Implemented | `os14/core.ts:124-322` | localStorage + IndexedDB，配额统计 |

### 3.3 Cloud

来源：`audit/part-A-cloud.md`（34 项功能：Implemented 20 / Partially 6 / Not Implemented 5 / Deprecated 2 / Broken 1）。

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| Guandao Account | Implemented | `worker/api/auth/**` | GitHub OAuth + PKCE、Session Cookie |
| GitHub OAuth | Implemented | `auth/handlers.js:124-340` | state/PKCE 校验齐全 |
| Session 管理 | Implemented | `auth/session.js`、`auth/store.js` | 30 天固定窗口；无滑动续期 |
| D1 | Implemented | `wrangler.jsonc:36-43`、`migrations/**` | 13 个迁移 |
| R2 | Implemented | `wrangler.jsonc:28-33` | 服务端代理下载，不暴露直链 |
| Cloud Sync | **Implemented（2.0 补齐）** | `worker/api/sync/**`、`migrations/0014_sync.sql`、`src/lib/sync/**`、`core/sync.ts` | 1.9 时不存在；2.0 新增实体级增量同步（Notes / Tasks / Calendar）、乐观锁与墓碑。验证：`scripts/sync-qa.mjs` 20/20、`scripts/sync-client-qa.mjs` 8/8 |
| Cloud Drive | Implemented | `worker/api/files/**` | 上传/下载/配额/回收站 |
| Devices | Implemented | `worker/api/devices/**` | 会话/设备/心跳/撤销 |
| Backup | Partially Implemented | `backups/archive.js`、`backups/handlers.js` | 有校验与断点；>5000 条目必失败；无取消接口 |
| Privacy & Security | Implemented | `worker/api/privacy/**` | 导出/删除/审计/限流 |
| 账号注销（普通成员） | **Broken** | `auth/handlers.js:298-300` | reauth 写死 admin → member 恒 403 |

### 3.4 Community

来源：`audit/part-B-community-market.md`。

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| 社区首页 / 发现 / 搜索 | Implemented | `os14/community.ts`、`worker/api/community/**` | 真实 D1 + R2，无种子数据 |
| 创作者主页 | Implemented | `community.ts:474`、`handlers.js` | — |
| 主题 / 组件 / 壁纸 / 工作空间市场 | Implemented | `community.ts:1061` 起 | 与本地引擎对接 |
| 点赞 / 评论 / 收藏 / 关注 | Implemented | `worker/api/community/write.js` | 两层评论、收藏夹 |
| 举报 / 审核后台 | Implemented | `community/admin.js` | 队列/举报/审计 |
| 版本管理 | Implemented | `community/validate.js` | 版本递增与兼容性校验 |
| 安装计数真实性 | **Broken** | `community/api.ts:354`、`community.ts:1061` | 打开详情页就 +1，安装数失真 |
| 权限同意 | Partially Implemented | `community/install.ts` | 只展示，不强制逐项同意 |
| 隐私边界 | Implemented | 全仓检索 | 未发现笔记/文件/备份上传路径；但默认 visibility=public |

### 3.5 Developer

来源：`audit/part-C-plugins-sdk.md`。

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| Plugin Manager | Implemented | `plugins/manager.ts` | 安装/更新/回退/日志 |
| Plugin Market | Implemented | `plugins/market.ts`、`worker/api/plugins/**` | D1 真实表，无种子 |
| Plugin SDK | Partially Implemented | `public/sandbox/sdk.js` | 无 `.d.ts`、无错误码枚举 |
| Plugin Sandbox | Implemented | `host.ts:191-208`、`runner.html:138` | 双层 allow-scripts + opaque origin |
| Plugin Permissions | Implemented | `host.ts:63-89`、`handlers.js:489-494` | 客户端 + 服务端双校验 |
| Developer Center | Implemented | `plugins/developer.ts` | 草稿/上传/审核/统计 |
| Plugin CLI | Partially Implemented | `cli/guandao.mjs` | 缺 `test` 子命令；`package` 与 `build` 等价 |
| 更新时兼容性检查 | **Broken** | `plugins/registry.ts:356-419` | 只查权限，不查 minimumOSVersion |
| SDK / Broker 一致性 | **Broken** | `sdk.js:218-220` vs `host.ts:63-89` | `widget.setTitle` 必得 UNKNOWN_METHOD |

### 3.6 Multi-device

来源：`audit/part-D-mobile-quality.md`。

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| Desktop Mode | Tested | `desktop.spec.ts` | — |
| Tablet Mode | Partially Implemented | `shell/adaptive.ts:48-66` | 同一窗口系统 + 密度 CSS |
| Mobile Mode | Implemented | `src/pages/m.astro`、`mobile/app.ts` | 独立外壳，仅覆盖 5 类应用 |
| Device Pairing | Implemented | `worker/api/pairing/**` | 6 位码 + SHA-256 + 原设备确认 |
| Continuity | Implemented | `worker/api/continuity/**` | 10 分钟 TTL，不要求两端同时在线 |
| Clipboard | Implemented | `continuity/handlers.js` | 无目标设备选择 |
| PWA | Partially Implemented | `public/sw.js:27-36` | 桌面 `/` 未预缓存；`checkForUpdate` 有竞态 |
| 离线模式 | Implemented | `sw.js`、`offline.astro` | 桌面首访后断网会白屏（缺 `/`） |

### 3.7 Engineering

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| Performance Lab | Implemented | `quality/perflab.ts` | 真实测量，无伪造硬件 |
| Diagnostics | Partially Implemented | `quality/diagnostics.ts:136-142` | 8 项中 7 项真实，Cloud Sync 恒绿 |
| 自动化测试 | Partially Implemented | `tests/unit`、`tests/e2e` | 53 项通过，但 API 零覆盖 |
| GitHub Actions | Implemented | `.github/workflows/quality.yml` | 类型/单测/构建/迁移/E2E |
| Deployment | Implemented | `wrangler.jsonc`、`npm run cf:deploy` | 需先 build，否则 CSP 哈希过期 |
| Backup & Recovery | Partially Implemented | 见 3.3 | 恢复的 `merge` 语义是假的 |

---

## 4. 技术债务报告

### 4.1 巨型文件与职责混杂

| 文件 | 行数 / 体积 | 问题 |
| --- | --- | --- |
| `src/pages/index.astro` | 17,503 行 / 584.9KB | 模板 + 6,900 行脚本 + 9,800 行样式；19 个应用、窗口系统、社交、成就全在一个闭包里 |
| `src/lib/os14/community.ts` | 3,348 行 | 14 个区块；发布表单 343 行、事件代理 955 行 |
| `src/lib/mobile/app.ts` | 1,803 行 / 74.5KB | 11 个视图 + 状态管理 |
| `worker/api/community/write.js` | 1,515 行 | 路由、校验、SQL、编排混在一起 |
| `worker/api/backups/handlers.js` | 1,558 行 | 同上 |
| `worker/api/privacy/handlers.js` | 1,479 行 | 同上 |

### 4.2 重复实现

- `assertSameOrigin` **7 份**：`auth/handlers.js:70`、`files/handlers.js:527`、`devices/handlers.js:689`、`backups/handlers.js:1550`、`privacy/handlers.js:1353`、`community/common.js:16`、`plugins/common.js:13`。
- `readJson` **8 份**，其中 3 份只信 `content-length`（`files:519`、`auth:85`、`devices:677`）；`http.js:43` 的安全版长期零调用。
- 前端 `request()` 4 份：`account/client.ts:124`、`devices/client.ts:132`、`backups/client.ts:106`、`privacy/client.ts:147`；社区还有 3 份。
- 模式判定 3 份：`shell/adaptive.ts:48-66`、`m.astro:27-53`、`index.astro:112-129`。
- `escapeHtml` 3 份（`os14/core.ts:345`、`index.astro:1461`、`mobile/ui.ts`）。
- 安装链 **5 条**：应用中心、社区、插件市场、主题导入、壁纸引擎。
- 数据模型两套云栈：D1/R2 与 Supabase（`index.astro:80-83` 生产仍走 `/sb`）。
- 文件模型两套：`files/folders` 与 `community_assets`；`multipart_uploads` 从未使用。

### 4.3 冗余状态与全局状态

- 应用「是否运行」靠窗口 DOM（`os14/system.ts:187`），安装状态在 catalog，插件在 plugins store，主题在 themes store，页面外观在 os13 config，偏好又在 os14 prefs —— **6 套状态源，互相不知情**。
- `appcenter.ts:47-54`、`themes.ts:276`、`community.ts` 各有一个模块级可变 `state`，窗口重开不重置，多窗口下会串。
- `index.astro` 里 `zTop`、`cascade`、`currentSpace`、`desks`、`launchHidden` 等 20+ 全局变量。

### 4.4 未清理的监听 / 定时器 / Promise

- `sys.addShortcut` 与 `uninstall` 各有一段**完全重复**的守卫代码（`os14/system.ts:57-64`、`132-140`）。
- `datacenter` 的自动备份在 1.9 已改为 idle 触发，但 `autoBackupOnBoot` 内部仍有 fire-and-forget Promise。
- `privacy/handlers.js:1285-1290` 用 `.catch(()=>undefined)` 吞掉 R2 删除失败后删除 `users` 行 → 孤儿对象且不可重试。
- `community.ts` 有 1 秒全局 ticker；`before-close` 的 abort 分支实际不会触发。
- `installRootDisposal` 从未被调用（`quality/resources.ts:440`）。

### 4.5 死代码 / 无用列

- 表：`sync_changes`（`0001:82`）、`notes`（`0001:45`）、`multipart_uploads`（`0003:48`）。
- 列：`backups.source_cursor`、`parent_backup_id`（`0006:31-32`，只读不写）、`files.sha256`（上传从不写，备份却读它）。
- 函数：`replaceBackupItems`、`listBackupsForPurge`、`sha256StreamUnavailable`、`communityHealth`、`deleteSessionByHash`、`newId`、`defaultDeviceName`、`pruneSecurityEvents`。
- 前端：`state.loading` / `state.history` 与 3 个导出无人使用。

### 4.6 版本号与配置漂移

| 位置 | 1.9 时的值 | 后果 |
| --- | --- | --- |
| `src/lib/version.ts:12` | 1.9.0 | 前端唯一来源 |
| `worker/api/version.js:9` | 1.9.0 | 响应头 |
| `shared/plugin-spec.js:15` | **1.8.0** | `/api/plugins/meta`、`app.context` 对外报错版本 |
| `worker/api/community/validate.js:16` | **1.6.0** | 社区首页显示 1.6.0；minimum 1.7 内容被判不兼容 |
| `scripts/plugins-qa.mjs:135` | 断言 **1.7.0** | QA 与代码脱节 |
| `check-version.mjs:9-42` | 只查 4 处 | 上述漂移 CI 发现不了 |

### 4.7 数据库迁移

- 顺序正确（0001→0012），全部增量、无回滚脚本（D1 不支持 DROP COLUMN）。
- **索引名冲突**：`0006:39` 与 `0001:111` 同名 `idx_backups_user_created`；`0012:27` 与 `0006:43` 同名 `idx_backups_user_status`。`IF NOT EXISTS` 让后者的新列定义被**静默跳过**。
- `backups` 列表查询 `(user_id, deleted_at, created_at)` 缺完整索引。
- `migrations/README.md` 仍写「表已建好但没有任何对外数据接口」，与 30+ 路由的事实相反。

---

## 5. 安全隐患清单

严重度：**高** / **中高** / **中** / **低**。「2.0 处置」列对应本次实际修改。

| # | 严重度 | 问题 | 证据 | 2.0 处置 |
| --- | --- | --- | --- | --- |
| 1 | 高 | 初始化窗口内，管理员密钥仅按 IP 限流 5 次/10 分钟，无全局锁、无最小长度 → 弱密钥可分布式爆破成 admin | `auth/handlers.js:150-156,433-467`、`ratelimit.js:46-53` | ✅ 已修：密钥最短 24 字符（不足即关闭初始化）+ 全局 10 次/小时锁 |
| 2 | 高 | 账号注销的重新验证写死 `role === "admin"`，普通成员永远 403 | `auth/handlers.js:298-300` | ✅ 已修：只校验「同一 GitHub 身份 + 当前会话」 |
| 3 | 中 | `/sb` 同源反代不限流、不限路径、不限方法，错误回显 `err.message` | `worker/index.js:115-161` | ✅ 已修：只放行 `/rest|auth|storage/v1`、方法白名单、300 次/分钟、错误脱敏 |
| 4 | 中 | 3 处只信 `content-length` 的 body 上限，chunked 可绕过 | `files:519`、`auth:85`、`devices:677` | ✅ 已修：统一改用 `readJsonLimited` |
| 5 | 中 | 注销最后阶段 R2 前缀删除 `.catch(()=>undefined)` 后删 users 行 | `privacy/handlers.js:1285-1290` | ✅ 已修：前缀级重试（最多 5 轮），仍失败写 `account_deletion_r2_incomplete` 审计后才继续 |
| 6 | 中 | >5000 文件的账号备份必然失败 | `backups/store.js:322-324` | ✅ 已修：改分页读取（2000/页，上限 20000） |
| 7 | 中 | 插件自我导航外泄只做事后封禁，数据已出网；`blocked` 不上报服务端 | `runner.html:173-196`、`host.ts:313-325` | ⚠️ 部分修复：新增 `POST /api/plugins/:id/security`，逃逸事件进入审核队列；但数据一旦出网无法回滚，「独立沙箱域」仍未做 |
| 8 | 中 | 供应链只有哈希没有签名，checksum 由同一服务端下发 | `handlers.js:479-484`、`bundle.ts:53-56` | ⚠️ 未修（需要签名链，列入 2.1） |
| 9 | 中 | 插件更新不重新校验 minimumOSVersion / sdkVersion | `registry.ts:356-419` | ✅ 已修 |
| 10 | 中 | 跨设备静默继承插件权限，无二次同意 | `registry.ts:107-145` | ✅ 已修：高敏感权限（文件 / 网络 / 笔记 / 日程）恢复后保持禁用并标「待确认权限」，必须在本机重新保存授权才能启用 |
| 11 | 中 | SDK 表面与 Broker 表漂移：`widget.setTitle` 必失败、`ui.setTitle` 静默成功 | `sdk.js:218-220`、`host.ts:473-479` | ✅ 已修：补 Broker 方法；组件模式改为明确 `UNSUPPORTED` |
| 12 | 中 | 宿主窗口标题把插件名未编码塞进 `innerHTML` | `index.astro:5007`、`plugin-spec.js:455-458` | ✅ 已修：标题与 Dock 选择器都做 `escapeHtml` |
| 13 | 中 | 普通成员注销不可用导致隐私承诺与实际能力不符 | 同 #2 | ✅ 已修 |
| 14 | 低中 | 撤销插件权限不跨标签页 | `host.ts:91,344` | ✅ 已修：监听 `storage` 事件，其他标签页改权限后销毁本页插件运行时 |
| 15 | 低中 | 插件存储上限 24×256KB≈6MB，可压垮宿主 localStorage | `plugin-spec.js:26-28` | ✅ 已修：新增所有插件共享的 2MB 总预算（`STORAGE_QUOTA_GLOBAL`），按增量计算 |
| 16 | 低 | 卸载主题插件残留主题 | `themes.ts:522-529` | ✅ 已修：卸载时删除自定义主题；若正在使用则先退回内置主题 |
| 17 | 低 | `/api/health` 匿名且不限流，含版本与 binding 信息 | `health.js:22-47` | ✅ 已修：纳入限流（120 次/分钟） |
| 18 | 低 | 备份下载不校验摘要（仅 ZIP 内附 checksums） | `backups/handlers.js:775-838` | ✅ 已修：下载前复核 manifest / data 的 SHA-256，不一致返回 409 `BACKUP_CORRUPTED` |
| 19 | 中 | 工作目录 `.env` 明文保存 Supabase 管理员邮箱/口令、DB 密码与 anon key（未被 git 跟踪，但打包/共享即泄露） | `.env:5-20` | ⚠️ 未修（本次未读取/未修改该文件；建议轮换并只放在 Cloudflare Secrets） |

**明确排除**（避免误判）：SQL 注入（全绑定参数，动态列白名单）、路径穿越（对象键服务端生成、文件名去分隔符）、跨用户读写（所有查询带 `user_id`）、沙箱逃逸（双层 opaque origin + `event.source` 比对）、`/sb` SSRF（主机硬编码）、开放重定向（只拼同源路径）。

---

## 6. 「界面说谎」清单（2.0 重点修复）

| 位置 | 说了什么 | 实际是什么 | 2.0 处置 |
| --- | --- | --- | --- |
| `diagnostics.ts:136-142` | Cloud Sync 绿色「在线 · 已同步」 | 没有同步引擎，`reportSync` 只在诊断页自回传 | ✅ 改为读内核真实同步域；未接入显示「未接入数据域」（mute 灰） |
| `backups/handlers.js:1349` | Cron 每日 18:00 UTC | 实际 `*/15 * * * *` | ✅ 改为如实描述 |
| `plugins/meta` | OS 1.8.0 | 实际 1.9.0 | ✅ 单一版本源 + CI 覆盖 |
| `community.ts:474` | OS 1.6.0 | 实际 1.9.0 | ✅ 服务端校验版本改为 2.0.0 |
| `devices/model.js:271` | `mode: "cloud"` 无条件 | 本地模式也这么显示 | ✅ 由 2.0 云端管理器统一提供状态（旧接口未删，列入 2.1） |
| `backups` 恢复 UI | Merge 声称「同 ID 跳过、冲突提示」 | 云盘文件一律新 UUID、不做任何合并 | ✅ 已修：Merge 改为「只补缺失内容」——云盘按 SHA-256 跳过重复文件并在结果里报告 `filesSkipped`；笔记/任务/日程由客户端做真实合并；警告文案与实现一致 |

---

## 7. 架构决策（2.0）

| # | 决策 | 理由 | 代价 / 风险 |
| --- | --- | --- | --- |
| ADR-1 | **不推翻 1.x**，在桌面外壳之外新增 `src/lib/core/**` 内核 | 1.x 的窗口/主题/组件已经稳定，重写等于把 53 项已验证行为清零 | 需要一层适配器（`os20/bridge.ts`），短期有两套 API |
| ADR-2 | 用 **Manifest + AppRegistry** 统一应用状态，窗口 DOM 是唯一事实来源 | 杜绝「UI 自己写运行中」 | 需要给 46 个内置应用补 Manifest |
| ADR-3 | **权限统一到 PermissionManager**，默认拒绝，系统主体 bypass 但记账 | §11 要求；插件已有 Broker，只需接管判定 | 应用侧权限从「文案」变成「真实约束」，需要低风险自动授予策略 |
| ADR-4 | 迁移**只新增键、绝不改写旧键**；迁移前先写 IndexedDB 快照 | 「不能丢数据」是硬约束 | 旧键会长期存在，需要文档说明 |
| ADR-5 | 同步做成**可插拔引擎**，没有服务端 API 的数据域如实显示「未接入」 | 云 Notes/Tasks/Calendar 接口不存在，不能假装有 | 2.0 的「同步」是基础设施而非可用功能 |
| ADR-6 | 首个 2.0 版本**不改 Supabase 存量功能**（树洞/议会/社交） | 它们不在 2.0 平台目标内，改动风险高 | 两套云栈并存，列入技术债 |
| ADR-7 | 静态部署的「更新」= 新资源 + 客户端迁移，不伪装原子内核更新 | §13 明确禁止伪装 | 更新中心只能做「检查 + 重新加载」，不能热补丁 |

---

## 8. 迁移计划与执行状态（Phase 1–16）

| 阶段 | 计划 | 状态 | 交付物 |
| --- | --- | --- | --- |
| 1 | 全项目审计与架构报告 | ✅ 完成 | 本文件 + `audit/part-A..D.md` |
| 2 | 2.0 架构与迁移计划 | ✅ 完成 | `docs/ARCHITECTURE-2.0.md`、`docs/MIGRATION-2.0.md` |
| 3 | 统一 Core 与模块边界 | ✅ 完成 | `src/lib/core/**`（18 个模块） |
| 4 | 统一 Window Manager 与 App Registry | ✅ 完成 | `core/windows.ts`、`core/registry.ts`、`core/layout.ts`、`os20/bridge.ts` |
| 5 | 统一应用生命周期 | ✅ 完成 | `core/runtime.ts`、`core/service.ts`、窗口状态观察 |
| 6 | 统一权限与安全服务 | ✅ 完成（部分加固见 §5） | `core/permissions.ts`、插件 Broker 补丁 |
| 7 | 统一云端 API 与数据访问层 | ✅ 完成（同步域） / ⚠️ 路由未重构 | 新增 `/api/sync/*`（index / pull / push / status）+ `src/lib/sync/**`；但服务端仍有 7 份 `assertSameOrigin`、8 份 `readJson` 未合并 |
| 8 | 整合市场与社区 | ✅ 完成 | `src/lib/market/**`、`os20/apps/market.ts` |
| 9 | 完善 System Center | ✅ 完成 | `os20/apps/systemcenter.ts`（8 类设置） |
| 10 | First Launch Onboarding | ✅ 完成 | `os20/apps/onboarding.ts`（7 步） |
| 11 | Update Center | ✅ 完成 | `os20/apps/updatecenter.ts` |
| 12 | 统一诊断中心 | ✅ 完成（同步行如实显示） | `diagnostics.ts` 补丁 + 启动报告 |
| 13 | 数据迁移与向后兼容 | ✅ 完成 | `os20/migrations.ts`、`core/migrations.ts` |
| 14 | 完整回归测试 | ✅ 完成 | 115 单测 + 21 E2E + 28 项本地同步联调 + 35 项生产端到端，构建/CSP/迁移检查 |
| 15 | Preview 部署与验收 | ✅ 完成（本地静态 Preview + 生产环境验证） | `docs/RELEASE-2.0.md` §15–16 |
| 16 | Production 发布 | ✅ **已完成（2026-11-05）** | https://guandao.xin，版本 `8866fe13`；D1 备份 + 0013/0014 迁移 + 线上验证 |

---

## 9. 风险登记册

| # | 风险 | 影响 | 概率 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 2.0 内核在真实浏览器上引入启动错误 | 桌面白屏 | 中 | 内核启动在 1.x 外壳之后，任何阶段失败都不阻止桌面；BootReport 留证 |
| R2 | 1.x 旧数据在迁移中损坏 | 用户数据丢失 | 低 | 迁移前 IndexedDB 快照；只新增键；幂等；失败不提升版本号 |
| R3 | 权限收紧导致老应用无法启动 | 功能不可用 | 中 | 系统应用 bypass；市场应用低风险自动授予；`window.control` 默认授予 |
| R4 | 直接 `wrangler deploy` 导致 CSP 哈希过期 | 白屏 | 中 | `npm run cf:deploy` 先 build；CI `check:csp` 比对 dist |
| R5 | 部署后出现回归 | 线上不可用 | 低 | 发布前 `npm run verify`；发布后健康检查 + 浏览器内核启动 + CSP 复核；上一版本可 `wrangler rollback` |
| R6 | 插件供应链无签名 | 恶意更新 | 中 | 更新时重校验兼容性；文档标注为已知限制 |

---

## 10. 已知限制（2.0 交付时仍然存在）

1. **插件供应链无签名**：只有哈希，checksum 由同一服务端下发；签名链未实现。
2. **插件自我导航外泄**仍是「事后封禁 + 事件上报」，数据一旦出网无法回滚；独立沙箱域未做。
3. **移动端只覆盖 5 类应用**；三模式判定仍有 3 份拷贝。
4. **`index.astro` 仍是 17.5k 行**：2.0 只在内核层做了拆分，外壳未重构（ADR-1）。
5. **服务端仍是 7 份 `assertSameOrigin` / 8 份 `readJson`**：本次只修了 3 处不安全的 body 读取。
6. **两套云栈并存**：Supabase 存量功能未迁移。
7. **回滚未实际演练**：上一版本与数据库回滚路径已确认，但发布窗口内未主动执行一次回滚。
8. **同步只覆盖 Notes / Tasks / Calendar**：云盘走独立 API，主题/组件/工作空间的同步不在 2.0 范围。
9. **同步冲突策略是「服务端版本优先」**：不做逐字段三方合并；大批量并发编辑仍可能丢失最新一次修改。
10. **插件供应链无签名**：checksum 由同一服务端下发，签名链未实现。

---

## 11. 附录：证据索引

- 区域审计：`audit/part-A-cloud.md`（271 行）、`audit/part-B-community-market.md`（307 行）、`audit/part-C-plugins-sdk.md`（371 行）、`audit/part-D-mobile-quality.md`（276 行）
- 架构：`docs/ARCHITECTURE-2.0.md`
- 迁移：`docs/MIGRATION-2.0.md`
- 交付与发布：`docs/RELEASE-2.0.md`
- 开发者：`docs/SDK-1.md`、`public/sandbox/sdk.d.ts`、`docs/API-2.0.md`
- 验收：`docs/ACCEPTANCE-2.0.md`
- 2.0 新增代码：`src/lib/core/**`（18 模块）、`src/lib/os20/**`（6 模块 + 3 应用）、`src/lib/market/**`（2 模块）、`src/lib/sync/**`（2 模块）、`worker/api/sync/**`（2 模块）、`src/styles/os20.css`
- 2.0 新增测试：`tests/unit/core.test.ts`、`tests/unit/platform.test.ts`、`tests/unit/sync.test.ts`、`tests/e2e/os20.spec.ts`、`scripts/sync-qa.mjs`、`scripts/sync-client-qa.mjs`
- 2.0 新增工程检查：`scripts/check-migrations.mjs`、`gen-csp.mjs --check`、CI 的 API smoke job