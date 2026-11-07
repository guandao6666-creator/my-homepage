# Guandao OS 2.0 · Phase 0 全项目审计报告

**审计日期**：2026-11-05 22:10（Asia/Shanghai）
**审计对象**：`C:\Users\1\Desktop\my-homepage`（本地仓库） + `https://guandao.xin`（生产）
**当前版本**：2.0.0，Worker 版本 `3540542e-a45c-4802-b3cb-852d0627814a`
**审计方式**：只读代码审查 + 本地构建/测试 + 生产只读查询 + 真实浏览器验证
**审计约束**：未修改任何生产数据、未删除表、未更换 Cloudflare 资源、未输出任何 Secret

> **重要前提（必须先说清楚）**
>
> 这份 Phase 0 审计面对的不是「尚未开始 2.0」的仓库：当前仓库与线上已经是 **Guandao OS 2.0.0**
> （含 Core、App Registry、Window Manager、权限、System Center、Onboarding、Update Center、统一市场、
> 云同步），并且已经部署到 https://guandao.xin。因此本报告审计的是**当前真实状态**，
> 并据此给出「距离一个真正完整的平台还差什么」的路线图，而不是假装从零开始。
>
> 上一轮 1.9→2.0 的详细审计原文保留在 `docs/AUDIT-1.9-BASELINE.md`（本文件的前一版），
> 区域证据在 `audit/part-A..D.md`。
>
> 另一个前提修正：任务书写的 **Cloudflare Pages + Pages Functions 并不存在**。
> 仓库没有 `functions/` 目录；`wrangler.jsonc` 配置的是 **Worker + Static Assets**
> （`main: worker/index.js`、`assets.directory: ./dist`、`run_worker_first: true`）。
> 审计以实际部署形态为准。

---

## 1. 项目现状

### 1.1 基础信息

| 项 | 实际值 |
| --- | --- |
| 站点 | https://guandao.xin（线上可访问） |
| 框架 | Astro 7.4.4（`output: static`，构建产物 29 个页面） |
| 语言 | TypeScript 5.9（`astro/tsconfigs/strict`，`tsc --noEmit` 0 error） |
| 部署 | Cloudflare **Worker + Static Assets**（不是 Pages） |
| Worker 入口 | `worker/index.js`（约 160 行，负责安全头、静态资源、`/sb` 代理、API 路由） |
| D1 | `DB` → `guandao-db`，58 张表，14 个迁移 |
| R2 | `FILES` → `guandao-files` |
| 认证 | GitHub OAuth + PKCE、HttpOnly Cookie `gauth_sid`、D1 Session |
| 前端数据 | localStorage（`guandao.*` 1.x 键）+ IndexedDB（`guandao-os14`/`blobs`/`backups`） |
| 离线 | Service Worker `public/sw.js`（缓存版本 `guandao-2.0.0`）+ `manifest.webmanifest` |
| 定时任务 | Worker Cron `*/15 * * * *`；GH Actions `auto-publish`（10 分钟）、`comment-notify`（30 分钟） |

### 1.2 线上实时状态（本次重新探测，不沿用旧结论）

```json
GET https://guandao.xin/api/health  → 200
{
  "status": "ok",
  "version": "2.0.0",
  "services": { "d1": "connected", "r2": "available" },
  "durationMs": 233
}
```

只读查询（2026-11-05 22:07）：

| 表 | 行数 | 说明 |
| --- | --- | --- |
| `users` | 1 | 站点所有者账号 |
| `sessions` | 3 | 有效登录会话 |
| `devices` | 3 | 已登记设备 |
| `files` | 0 | 云盘为空 |
| `backups` / `backup_items` | 0 / 0 | 无历史备份 |
| `sync_entities` | 0 | 2.0 同步表为空 |
| `community_posts` / `community_assets` | 0 / 0 | 社区为空 |
| `plugins` / `plugin_installations` | 0 / 0 | 插件市场为空 |
| `security_events` | 3 | `successful_login` / `session_created` / `new_device_registered` |
| `sync_changes` / `notes` / `multipart_uploads` | 0 / 0 / 0 | 历史死表，无代码引用 |
| `rate_limits` | 491 | 滚动窗口计数（Cron 会清理） |

结论：线上是一个**真实但低数据量**的个人站点。D1/R2 绑定正常，2.0 的同步表与迁移已就位；
云端目前没有用户文件，因此「文件/备份」相关风险暂时是低暴露面，但代码路径已用生产 E2E 验证。

### 1.3 仓库规模

| 项 | 数量 |
| --- | --- |
| 页面 | 23 个 `.astro` / `.ts` |
| 组件 | 7 个 |
| 内容 | 6 篇 Markdown |
| 迁移 | 14 个 SQL + README |
| 脚本 | 34 个（QA / 构建 / 运维） |
| Worker 模块 | 9 条显式路由 + 11 个 API 前缀 |
| 单元测试 | 6 个文件 / 115 项 |
| E2E | 4 个 spec / 21 项 |
| 其他联调 | 同步 20 + 双设备 8 + 生产端到端 35 |

---

## 2. 技术架构

### 2.1 分层现状

```
Presentation
  index.astro（17,541 行，桌面 Shell + 1.x 应用脚本 + 全局样式）
  m.astro / mobile/app.ts（移动端第二外壳）
  23 个页面、7 个组件、48 个应用 Manifest

Application（2.0 新增）
  src/lib/core/**   18 个模块：Kernel / ServiceHost / Bus / Storage / Settings /
                    Permissions / Registry / Runtime / WindowManager / Layout /
                    Migrations / Notifications / Cloud / Sync / Device
  src/lib/os20/**   平台应用：System Center / Onboarding / Update Center / Market（+ 桥接）
  src/lib/market/** 统一安装器与资源聚合

Domain（未做仓储层抽象）
  os14/*（应用与业务）、plugins/*、community/*、backups/*、devices/*、privacy/*

Infrastructure
  Worker：D1 / R2 / GitHub OAuth / Cron / 安全头
  浏览器：localStorage / IndexedDB / Service Worker
  第二套云：Supabase（`/sb` 代理 + `supabase/*.sql`，存量社交）
```

**关键事实**

- Core 是「包在 1.x 外壳外面」的，不是把 1.x 拆进了 Core。`index.astro` 仍是 17,541 行 / 562 KB。
- UI 不直接访问 D1/R2：前端只调用 `/api/*`；R2 只在 Worker 内访问。
- 插件运行在双层 `sandbox="allow-scripts"` iframe（opaque origin），只能通过 Broker 访问系统能力。
- 认证统一在 `worker/api/auth/**`；权限判定有 `core/permissions.ts`（应用侧）与
  `host.ts` 的 `METHOD_PERMISSION`（插件侧）两套，但都是真实执行点，不是前端隐藏按钮。

### 2.2 API 面

| 前缀 | 能力 | 认证 |
| --- | --- | --- |
| `/api/health` | D1/R2 探活、版本 | 匿名（120 次/分钟限流） |
| `/api/auth/*` | status / OAuth / callback / me / logout / initialize / profile / devices | 混合 |
| `/api/files/*` | 列表、配额、上传、下载、回收站、文件夹 | Session |
| `/api/sync/*` | status / index / pull / push | Session + CSRF |
| `/api/backups/*` | 创建、进度、run、verify、下载、恢复、删除、设置 | Session + CSRF |
| `/api/devices/*` | 设备、会话、信任、撤销、心跳 | Session |
| `/api/pairing/*` | 6 位码配对 | Session |
| `/api/continuity/*` | 接力与剪贴板 | Session |
| `/api/privacy/*`、`/api/security/*` | 导出、删除、隐私设置、审计、概览 | Session |
| `/api/community/*` | 内容、互动、审核（管理员服务端校验） | 混合 |
| `/api/plugins/*`、`/api/developer/*` | 市场、安装、权限、审核、发布 | 混合 |
| `/sb/*` | Supabase 同源代理（仅 `/rest|auth|storage/v1`，白名单 + 限流） | 透传 |

### 2.3 数据库

58 张表，按域分组：

- 账号：`users` `sessions` `oauth_states` `setup_tickets` `reauth_tickets` `rate_limits`
- 云盘：`files` `folders` `file_events` `multipart_uploads`（死表）
- 设备：`devices` `device_activity` `device_sync_state` `device_pairings` `continuity_items` `device_contexts` `clipboard_items`
- 备份：`backups` `backup_jobs` `backup_items` `backup_settings` `backup_restores` `backup_restore_items`
- 隐私：`security_events` `privacy_settings` `data_exports` `data_export_jobs` `data_deletion_jobs` `account_deletion_audit`
- 社区：`community_*` 共 19 张
- 插件：`plugins` `plugin_versions` `plugin_installations` `plugin_permissions` `plugin_reviews` `plugin_reports` `plugin_audit_logs` `developer_profiles` `plugin_download_events`
- 同步：`sync_entities`（2.0）+ `sync_changes`（死表）

---

## 3. 已实现功能（按域）

状态说明：**Verified** = 本次有可重复执行的测试或生产实测；**Implemented** = 代码真实存在但本次未端到端；
**Partially Implemented**；**UI Only**；**Not Implemented**；**Broken**；**Unknown**。

| 功能 | 状态 | 证据（文件 / 路由 / 表 / 测试） |
| --- | --- | --- |
| 桌面环境 | Verified | `src/pages/index.astro`；`tests/e2e/desktop.spec.ts:44`；生产 28 个图标 |
| 桌面壁纸 | Implemented | `src/lib/os13.ts`、`src/lib/os14/wallpapers.ts`；无自动化断言 |
| Dock | Verified | `desktop.spec.ts:78`；`index.astro` `openWin/closeWin` |
| 菜单栏 | Verified | `desktop.spec.ts:44`；`index.astro` `#mb-*` |
| 窗口管理 | Verified | `index.astro` 窗口闭包；`desktop.spec.ts:91` 拖动；`core/windows.ts` |
| 虚拟桌面 | Implemented | `index.astro` `desks/switchSpace`；无 E2E |
| Mission Control | Implemented | `index.astro` `mission`；无 E2E |
| Widget | Implemented | `index.astro` 组件区、`os14/widgetstore.ts`；System Center 可开关 |
| 应用中心 | Implemented | `os14/appcenter.ts`、`os14/system.ts` |
| 应用注册系统 | Verified | `core/registry.ts`、`core/manifest.ts`；`core.test.ts`、`os20.spec.ts:138` |
| 文件管理器 | Implemented | `os14/drive.ts`；生产上传/下载已验证（API） |
| Notes | Implemented（同步 Verified） | `os14/apps/notes.ts`；`tests/unit/sync.test.ts`、`prod-e2e` 拉取笔记 |
| Tasks | Implemented（同步 Verified） | `os14/tasks-store.ts`；生产同步 `tasks:ok` |
| Calendar | Implemented（同步 Verified） | `os14/apps/calendar.ts`；生产同步 `calendar:ok` |
| Music | Implemented | `os14/music-core.ts`、`os14/apps/music.ts` |
| Gallery | Implemented | `os14/apps/gallery.ts` |
| Reader | Implemented | `os14/apps/reader.ts` |
| System Center | Verified | `os20/apps/systemcenter.ts`；`os20.spec.ts:156/187`；生产配额显示 `62 B / 5.0 GB` |
| Guandao Account | Verified | `worker/api/auth/**`；生产临时 Session 读取 `/api/auth/me` |
| GitHub OAuth | Implemented | `auth/handlers.js`（PKCE + state）；交互登录未执行 |
| Session | Verified | `auth/session.js`；生产 Session 列表 200；未登录 401 |
| D1 | Verified | `/api/health` `connected`；57 表；14 迁移 |
| R2 | Verified | `/api/health` `available`；生产上传/下载真实对象 |
| Cloud Sync | Verified | `worker/api/sync/**`、`src/lib/sync/**`；`sync-qa` 20/20、`sync-client-qa` 8/8、`prod-e2e` 全通过 |
| Cloud Drive | Verified | `files/handlers.js`；生产上传 201、内容读回、下载附件头 |
| Devices | Partially Implemented | `devices/handlers.js`；设备列表可用；配对/信任未端到端 |
| Backup | Verified | `backups/handlers.js`；生产创建/run/verify/download |
| 恢复 | Verified | 生产删除文件 + 清空回收站 → 恢复，`filesRestored=1` |
| Privacy & Security | Partially Implemented | `privacy/handlers.js`；overview/activity 已验证；导出/删除未端到端 |
| 社区首页 | Implemented | `os14/community.ts`；生产 `/api/community/feed` 200 |
| 创作者主页 | Implemented | `community.ts`、`community_*` 表 |
| 主题分享 | Implemented | 社区资源 + 统一 Manifest |
| 组件分享 | Implemented | 同上 |
| 工作空间分享 | Implemented | 同上 |
| 点赞评论 | Implemented | `community/write.js`、`community_likes/comments` |
| 举报与审核 | Implemented | `community/admin.js`；服务端 `requireAdminRole` |
| Plugin Manager | Implemented | `plugins/manager.ts` |
| Plugin Market | Implemented | `plugins/market.ts`、`/api/plugins`；公开列表 200 |
| Plugin SDK | Verified | `docs/SDK-1.md`、`public/sandbox/sdk.d.ts`；`sandbox.spec.ts` |
| Plugin Sandbox | Verified | `host.ts`、`runner.html`；`sandbox.spec.ts` 3 项 |
| 插件权限 | Verified | `core/permissions.ts`、`METHOD_PERMISSION`；`platform.test.ts`、`os20.spec.ts:187` |
| Developer Center | Implemented | `plugins/developer.ts`、`/api/developer/*` |
| Plugin CLI | Verified | `cli/guandao.mjs`；`test` 子命令实测 6/6 |
| Desktop Mode | Verified | `desktop.spec.ts`（1440×900） |
| Tablet Mode | Unknown | `shell/adaptive.ts`；无 E2E、无真机 |
| Mobile Mode | Verified | `mobile.spec.ts` 3 项；生产 `/m/` 200 |
| Device Pairing | Implemented | `pairing/handlers.js`；双设备未跑 |
| Continuity | Implemented | `continuity/handlers.js`；双设备未跑 |
| Clipboard | Implemented | `clipboard_items`、`continuity/*` |
| PWA | Verified | 生产 SW 接管 + 断网刷新成功 |
| Performance Lab | Implemented | `quality/perflab.ts`；`desktop.spec.ts:165` |
| Diagnostics | Implemented | `quality/diagnostics.ts`；同步状态真实读取 |
| Automated Testing | Verified | 115 单测 + 24 E2E + 20 + 8 + 35 = 202 |
| CI | Implemented | `.github/workflows/quality.yml` 3 job |
| Deployment | Verified | 生产 `3540542e`，`/api/health` 200 |
| Backup and Recovery | Verified | 同 Backup / 恢复 |

**统计**：Verified 24、Implemented 29、Partially Implemented 2、Unknown 1（共 56 项）。

---

## 4. 已验证功能（仅列本次有证据的）

| 域 | 验证方式 | 结果 |
| --- | --- | --- |
| 内核启动 | `os20.spec.ts`、生产浏览器 | 11 阶段全部成功，degraded=[] |
| 应用状态机 | `core.test.ts`、`os20.spec.ts:138` | 窗口打开 → running，关闭 → enabled |
| 权限默认拒绝 | `platform.test.ts`、`os20.spec.ts:187` | 拒绝写入审计 |
| 窗口拖动 / Dock 同步 | `desktop.spec.ts` | 通过 |
| 系统设置落盘 | `os20.spec.ts:156` | 刷新后仍生效 |
| 同步（本地） | `sync-qa.mjs` | 20/20（冲突、墓碑、隔离、401） |
| 同步（双设备） | `sync-client-qa.mjs` | 8/8 |
| 云盘 | 生产 E2E | 上传/读回/下载 |
| 备份 / 恢复 | 生产 E2E | 创建/校验/下载/恢复，恢复文件内容一致 |
| 生产内核 + 同步 | `prod-e2e.mjs` | 带登录态 11 阶段、三个域 ok、笔记落本地 |
| PWA 离线 | 生产 E2E | 断网刷新可打开桌面 |
| 构建 / 版本 / CSP | `npm run verify` | 29 页；12 哈希与 30 HTML 一致 |
| 生产部署 | `wrangler deploy` + 线上探测 | 200 / 2.0.0 / D1 / R2 |

---

## 5. 部分完成的功能

| 功能 | 完成的部分 | 缺的部分 | 影响 |
| --- | --- | --- | --- |
| Devices | 会话/设备列表、心跳、撤销接口 | 配对/信任/多设备同步的端到端验证 | 无法宣称「多设备已验证」 |
| Privacy & Security | 概览、安全事件、设置 | 导出、账号删除的端到端验证 | 隐私承诺缺少实测证据 |
| Tablet Mode | 密度与尺寸规则 | 真机与 E2E | 平板体验未知 |
| 社区发布链 | 表、审核、公开读取 | 发布/上传/审核的端到端 | 只能算「实现」 |
| 插件发布链 | 上传、审核、版本 | 真实发布 + 安装全流程 | 市场冷启动未验证 |
| 云同步范围 | Notes / Tasks / Calendar | Workspace / Preferences / Device 信息 | 平台同步仍不完整 |
| 移动端 | 5 类应用 + 接力 | 其余应用 | 移动端不是完整桌面 |

---

## 6. 尚未实现的功能

1. **插件供应链签名**：只有服务端下发的 SHA-256，没有发布者签名与公钥信任链。
2. **Workspace / 用户偏好 / 设备信息云同步**：同步引擎只注册了三个文本域。
3. **社区教程（Tutorials）**：没有独立模型，只有帖子分类。
4. **R2 孤儿对象巡检任务**：没有定期对比 D1 引用与桶对象的 job。
5. **Astro 模板类型检查 / Lint**：仓库没有 `@astrojs/check`、ESLint、Prettier 配置；
   `tsc` 只覆盖 `.ts`，不检查 `.astro` 模板。
6. **CI 中的生产端到端**：`qa:prod` 需要线上写权限，只在本地手工执行。
7. **服务器端 API 契约测试（自动生成）**：现有 API smoke 是手写断言，不是 schema 校验。

---

## 7. 发现的 Bug

### 7.1 本次审计/上线过程中已修复

| # | 问题 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 普通成员无法注销账号（重新验证写死 admin） | 改为校验同一 GitHub 身份 + 当前会话 | `auth/handlers.js` |
| 2 | 初始化密钥可被分布式爆破 | 密钥 ≥24 字符 + 全局 10 次/小时锁 | `auth/config.js`、`auth/handlers.js` |
| 3 | `/sb` 可当开放中继 | 前缀/方法白名单 + 300/min + 错误脱敏 | `worker/index.js` |
| 4 | 3 处 body 上限可被 chunked 绕过 | 统一 `readJsonLimited` | `http.js` + 3 handler |
| 5 | 备份 >5000 条目必失败 | 分页读取 | `backups/store.js` |
| 6 | 备份下载不校验摘要 | 下载前复核 SHA-256 | `backups/handlers.js` |
| 7 | Merge 语义名不副实 | 云盘按哈希跳过重复 + 文案对齐 | `backups/handlers.js`、`os14/backup.ts` |
| 8 | 插件更新不查兼容性 | 补 `minimumOSVersion` / `sdkVersion` | `plugins/registry.ts` |
| 9 | 插件名注入宿主 HTML | `escapeHtml` | `index.astro` |
| 10 | SDK `widget.setTitle` 漂移、`ui.setTitle` 静默成功 | 补 Broker、组件模式 `UNSUPPORTED` | `host.ts` |
| 11 | 插件逃逸只本地封禁 | `POST /api/plugins/:id/security` 上报 | `plugins/handlers.js`、`host.ts` |
| 12 | 撤销插件权限不跨标签页 | `storage` 监听销毁会话 | `host.ts` |
| 13 | 换设备静默继承敏感权限 | 恢复后禁用 + 待确认 | `plugins/registry.ts` |
| 14 | 插件总存储无上限 | 全局 2 MB 预算 | `plugins/store.ts` |
| 15 | 卸载主题插件残留主题 | 清理自定义主题 + 回退 | `plugins/registry.ts` |
| 16 | `/api/health` 匿名不限流 | 120 次/分钟 | `ratelimit.js` |
| 17 | 注销 R2 清理失败被吞 | 前缀级重试 + 审计 | `privacy/handlers.js` |
| 18 | 更新中心把「无需迁移」显示为「未完成」 | 按 `from/to` 区分 | `updatecenter.ts`（部署 `8866fe13`） |
| 19 | 首次启动引导覆盖 Cloud Mode | 初始化当前设置 + 跳过不写 mode | `onboarding.ts`（部署 `3540542e`） |

### 7.2 当前未修复 / 未复现

| # | 问题 | 严重度 | 状态 |
| --- | --- | --- | --- |
| 1 | `.env` 明文保存 Supabase 凭据（未被 git 跟踪） | 低 | 已切 publishable key 并停用 legacy（owner-confirmed） |
| 2 | 插件供应链无签名 | 中 | 未修 |
| 3 | 插件逃逸数据一旦出网无法回滚 | 中 | 未修（仅事后封禁 + 上报） |
| 4 | 平板模式未验证 | 低 | Unknown |
| 5 | 社区/插件真实发布链未跑 | 中 | 未验证 |
| 6 | 同步冲突为「服务端优先」 | 中 | 设计取舍，非 bug |

---

## 8. 技术债务

### 8.1 巨型文件

| 文件 | 行数 / 体积 | 风险 |
| --- | --- | --- |
| `src/pages/index.astro` | 17,541 行 / 562 KB | 任何改动都可能影响桌面；无法并行开发 |
| `src/lib/os14/community.ts` | 3,349 行 / 157 KB | 14 个区块、事件代理 955 行 |
| `src/lib/os13.ts` | 2,397 行 / 88 KB | 壁纸/Dock/菜单栏/设置混在一起 |
| `src/lib/mobile/app.ts` | 1,814 行 / 70 KB | 第二套外壳 |
| `worker/api/backups/handlers.js` | 1,618 行 / 54 KB | 路由 + 业务 + ZIP 流 |
| `worker/api/privacy/handlers.js` | 1,392 行 / 55 KB | 导出/删除/审计 |
| `worker/api/community/write.js` | 1,409 行 / 60 KB | 路由 + SQL + 校验 |

### 8.2 重复实现

- `assertSameOrigin` / `readJson`：Phase 1 已收敛到 `worker/api/guards.js`；原 8 份实现已删除或转为薄委托。

- 前端请求封装：4 份（account/devices/backups/privacy client）。
- 模式判定：3 份（`shell/adaptive.ts`、`m.astro`、`index.astro`）。
- 两套云栈：D1/R2 + Supabase（`src` 中 37 处 `/sb`/SUPABASE 引用，`supabase/*.sql` 6 个文件）。

### 8.3 资源与生命周期

- `addEventListener` 508 次 vs `removeEventListener` 62 次（含一次性全局监听，但比例仍偏高）。
- `void promise(` 309 处、`.catch(() => undefined)` 41 处：多数是刻意的「不阻塞 UI」，但缺少统一的可观测性。
- `quality/resources.ts:440` 的 `installRootDisposal()` **从未被调用**（死代码）。
- 死表：`sync_changes`、`notes`、`multipart_uploads`（0 行、0 代码引用）。

### 8.4 工程缺口

- 无 ESLint / Prettier / `@astrojs/check`；`.astro` 模板不参与类型检查。（Phase 1 已接入 `astro check` + ESLint）
- `@astrojs/markdown-remark` **不是未使用依赖**：Phase 1 实测，Astro 7 在配置
  `markdown.rehypePlugins` 时会显式加载它；移除后 `astro check` / build 直接报错。
  已保留，并在 `check-unused` 中登记为「配置要求」。
- 构建有 1 条 Vite chunk >500KB 警告（未处理）。
- CI 不跑 `qa:prod`（需要生产写权限，合理，但没有 staging 环境）。

---

## 9. 安全风险

| # | 风险 | 严重度 | 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | `.env` 明文 Supabase 凭据 | **低** | `SUPABASE_DB_PASSWORD` 已移除；前端切到 publishable key（`a05bedf8`），dist 无 JWT/secret；legacy keys 已由 owner 在控制台停用 | 已降级；旧 key 未保留，未做 401 复测（owner-confirmed） |
| 2 | 插件无签名 | 中 | 只有哈希，checksum 由同一服务端下发 | 设计 Ed25519 发布签名 + 客户端验签 |
| 3 | 插件逃逸 | 中 | 双层 sandbox + `connect-src 'none'`；逃逸后封禁 + 上报 | 独立沙箱域 + 更小权限面 |
| 4 | 巨型 `index.astro` 的 XSS 面 | 中 | 大量 `innerHTML`，已广泛 `escapeHtml` | 拆分 + 统一模板转义函数 |
| 5 | 安全逻辑重复 | 中 | 8 份同源校验/body 读取 | 收敛到 `worker/api/guards.js` |
| 6 | 管理员权限 | 低 | 服务端 `requireAdminRole` + `role` 校验 | 保持；补 API 层测试 |
| 7 | 跨用户访问 | 低 | 所有用户数据查询带 `user_id`；同步隔离已实测 | 加自动审计（静态检查 SQL） |
| 8 | 生产账号被非应用路径删除 | **中** | 2026-11-06 事故根因未定位；应用内删除路径已加四重防护 | 获取 Cloudflare Audit Logs；对 D1 写操作加审计/告警 |

未发现：SQL 注入、IDOR、路径穿越、开放重定向、`/sb` SSRF、Session 伪造。
（这些在本轮生产 E2E 与历史审计中均有覆盖。）

---

## 10. 性能问题

### 10.1 实测

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 生产首页传输 | **553 KB / 31 个资源** | css 107 KB、webp 238 KB、js 206 KB |
| DOM 节点 | 1,086 | 桌面 Shell 常驻 |
| DCL | 1,316 ms | 生产、无缓存 |
| load | 2,927 ms | 生产、无缓存 |
| 最大 JS chunk | **497 KB**（`index.astro` 入口） | 触发 Vite >500KB 警告 |
| 最大 CSS | 267 KB | 单文件 |
| 内核启动 | 43–54 ms | 2.0 Core 开销可接受 |

### 10.2 结构性问题

1. 入口 chunk 497 KB：桌面 shell、大量 1.x 应用脚本与工具函数混在一个 bundle；应用虽按需加载，但主包仍大。
2. `index.astro` 的 9,800 行全局 CSS 产出 267 KB 单文件，首屏全量加载。
3. 508 个监听器 + 309 个 fire-and-forget：长会话下需要关注泄漏与重复绑定。
4. 生产 LCP 未采集（PerformanceObserver 未注册）；建议在诊断中心接入真实 LCP/CLS/INP。

---

## 11. 数据风险

| # | 风险 | 现状 | 评估 |
| --- | --- | --- | --- |
| 1 | 1.x 本地数据迁移 | 先写 IndexedDB 快照、只新增 `guandao.core.*`、幂等、失败不提升版本 | 低；已有单测 + 浏览器实测 |
| 2 | 云同步删除传播 | 墓碑 + 推送成功后清理 | 低；`sync-qa` 覆盖 |
| 3 | 同步冲突 | 服务端版本优先，可能丢最后一次并发编辑 | 中；需产品确认 |
| 4 | 备份完整性 | 创建校验 + 下载校验 + 恢复前校验 | 低 |
| 5 | R2 孤儿对象 | Phase 1 生产巡检：D1 引用 0，R2 对象 12，孤儿候选 **12** | 已可发现（`/api/admin/r2-audit`）；未删除，待人工确认 |
| 6 | 死表 | `sync_changes`/`notes`/`multipart_uploads` 0 行 | 低；不建议删，先标记 deprecated |
| 7 | 两套云栈 | Supabase 存量社交与 D1 并存 | 中；数据分散、权限模型不同 |
| 8 | 生产 D1 备份 | 本次部署前已导出逻辑备份（130 KB） | 低；建议定期自动导出 |

---

## 12. 2.0 架构建议

原则：**复用已验证的，改造边界不清的，暂不重写稳定的。**

| 模块 | 建议 | 理由 |
| --- | --- | --- |
| Guandao Core | **复用**（`src/lib/core/**`） | 18 个模块、单测覆盖、启动 11 阶段已验证 |
| Desktop Shell | **渐进拆分**（不重写） | 17.5k 行是最大风险；先抽 CSS、再抽独立应用脚本 |
| Application Registry | **复用** | Manifest + 状态机 + 窗口事实来源已验证 |
| App Runtime | **复用**，补 suspend/resume 的真实调用方 | 现有 API 已实现，缺使用场景 |
| Window Manager | **复用** | 1.x 已验证的拖动/贴靠，2.0 只做编排 |
| Plugin Runtime | **复用**，加签名与独立域 | 沙箱与 Broker 已验证；供应链是缺口 |
| Permission Manager | **复用并收敛** | 应用侧已有；服务端 guards 需要统一 |
| Event Bus | **复用** | 错误隔离已单测 |
| Storage Manager | **复用** | 信封/配额/旧键只读已验证 |
| Cloud Service Manager | **复用** | 真实探测，不伪造 |
| Device Manager | **复用**，补配对/接力 E2E | 本地设备档案与云端设备已分离 |
| Notification Manager | **复用** | 复用 1.x 通知存储，勿扰真实 |

**不建议现在做**：

- 不要为了「Repository Pattern」给 Notes/Tasks/Calendar 再包一层抽象；现有 store + sync adapter 已经够用。
- 不要把 Supabase 存量社交强行迁到 D1（除非确认仍在使用且有迁移预算）。
- 不要重写 `index.astro` 的窗口系统（1.x 已验证，重写等于清零）。

---

## 13. 迁移风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 拆分 `index.astro` 时破坏窗口/事件绑定 | 中 | 桌面白屏或交互失效 | 先抽 CSS（纯样式）、再抽独立应用；每步跑 21 项 E2E |
| 统一 `assertSameOrigin` / `readJson` 时行为漂移 | 中 | CSRF 或 413 行为变化 | 保留旧实现做对照测试；逐路由迁移 |
| 插件签名上线导致旧插件无法安装 | 中 | 生态断裂 | 签名「可选→强制」两阶段；旧包标记 unsigned |
| 同步冲突策略调整导致数据覆盖 | 低 | 用户数据丢失 | 先做逐字段合并的离线比对，灰度 |
| Supabase 迁移不彻底 | 中 | 两套权限/数据 | 先冻结写入，再导出、对账、切换 |
| D1 结构变更 | 低 | 回滚困难 | 只做增量；迁移前导出；禁止 DROP |

---

## 14. 开发优先级

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| **P0** | 轮换 `.env` 凭据并迁到 Secrets；R2 孤儿巡检；统一服务端 guards | 安全与数据完整性优先 |
| **P1** | 拆分 `index.astro`（CSS → 应用脚本）；补 Astro 类型检查/Lint | 最大维护风险 |
| **P2** | 插件签名 + 独立沙箱域；OAuth/配对/接力的自动化 E2E | 生态与多设备可信度 |
| **P3** | 同步扩展到 Workspace/Preferences；冲突策略产品化 | 平台完整性 |
| **P4** | 社区/市场发布链实测；教程模型 | 生态冷启动 |
| **P5** | 性能：chunk 拆分、CSS 拆分、LCP/INP 采集 | 体验 |

---

## 15. 预计开发阶段

| 阶段 | 目标 | 预计 |
| --- | --- | --- |
| Phase 1 | 安全与数据基线（P0） | ✅ 已完成（2026-11-06，见附录 C；数据事故 Mitigated / Pending Investigation，不阻断代码层 Phase 2） |
| Phase 2 | Shell 拆分与工程护栏（P1） | 1–2 周 |
| Phase 3 | 插件供应链与多设备验证（P2） | 1–2 周 |
| Phase 4 | 同步范围扩展与冲突策略（P3） | 1 周 |
| Phase 5 | 社区/市场发布链（P4） | 1 周 |
| Phase 6 | 性能与可观测（P5） | 3–5 天 |

详细文件、前置条件、风险与验收标准见 `GUANDAO_2_0_ROADMAP.md`。

---

## 附录 A：审计证据索引

- 区域审计：`audit/part-A-cloud.md`、`part-B-community-market.md`、`part-C-plugins-sdk.md`、`part-D-mobile-quality.md`
- 历史基线：`docs/AUDIT-1.9-BASELINE.md`
- 架构：`docs/ARCHITECTURE-2.0.md`
- 迁移：`docs/MIGRATION-2.0.md`
- 发布与部署：`docs/RELEASE-2.0.md`
- SDK / API：`docs/SDK-1.md`、`docs/API-2.0.md`
- 验收：`docs/ACCEPTANCE-2.0.md`
- 测试：`tests/unit/**`（115）、`tests/e2e/**`（24）、`scripts/sync-qa.mjs`（20）、`scripts/sync-client-qa.mjs`（8）、`scripts/prod-e2e.mjs`（35）

## 附录 B：审计边界（未做/不能做）

- 未执行 GitHub OAuth 交互登录（需要账号授权）。
- 未执行双设备配对/接力实测（需要两台设备）。
- 未执行社区/插件真实发布（需要人工审核与内容）。
- 未做真机平板测试。
- 未主动制造线上故障做回滚演练。

## 附录 C：Phase 1 执行记录（2026-11-06）

| # | 交付项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | `.env` 凭据审查 | Verified | 仅检查变量名；`SUPABASE_DB_PASSWORD` 无代码引用、未进 dist，已从本地 `.env` 移除 |
| 2 | Supabase 真实依赖 | Verified | 仍在使用：`src/pages/index.astro` 23 处、`cloud.ts` 8 处；生产 `/sb` 代理 401（存活）；未删除 `/sb` 与 `supabase/*.sql` |
| 3 | anon key 轮换 | **Verified（owner-confirmed）** | publishable key 已上线并验证；legacy keys 已由 owner 在控制台停用（2026-11-06 17:44） |
| 4 | Guards 统一 | Verified | 新增 `worker/api/guards.js`；8 个模块迁移：auth / files / devices / backups / privacy / community / plugins / sync |
| 5 | 安全探针 | Verified | 401 未登录；403 跨源；413 超大与 chunked；合法同源到达业务（400 EMPTY_BATCH） |
| 6 | R2 巡检工具 | Verified | `GET /api/admin/r2-audit` + `scripts/r2-audit.mjs`；仅管理员、只读、脱敏 |
| 7 | R2 生产巡检结果 | Verified | 数据库引用 0；R2 对象 **12**；匹配 0；缺失 0；孤儿候选 **12**（未删除） |
| 8 | 依赖清理 | Verified | 实测 `@astrojs/markdown-remark` 是 Astro 7 配置必需，不能移除；`check:unused` 通过（18 个直接依赖） |
| 9 | Astro 模板类型检查 | Verified | `astro check`：246 文件，**0 errors** / 0 warnings / 137 hints；已进 CI |
| 10 | ESLint | Verified | Worker/scripts/CLI 安全规则，**0 problems**；已进 CI |
| 11 | 单元测试 | Verified | 115 passed |
| 12 | E2E | Verified | 24 passed（新增移动端 3 项） |
| 13 | 生产 E2E | Verified | 35/35（`a5161e28` 后；publishable 切换后又复跑 35/35） |
| 14 | 部署 | Verified | Worker `a05bedf8-a5ff-4839-a9eb-03ab090b943f`（publishable key）；`/api/health` 200 |
| 15 | 生产数据事件 | **Mitigated / Pending Investigation** | 验证中发现 `users=0`；无删除审计、无注销事件；D1 Time Travel 恢复到 `2026-11-05T14:00:00Z`，恢复 1 账号 / 3 Session / 3 设备；根因未定位，详见 `docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md` |

## 附录 D：生产数据事故调查（2026-11-06）

完整记录见 [`docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md`](docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md)。

- **状态**：Mitigated / Pending Investigation（未 Closed）；
- **已确认**：users 行在 11-05 22:35—11-06 13:15 之间消失，sessions/devices 级联消失；
- **已排除**：应用内注销（无 audit、无注销事件）、Cron（无 job）、auth 登出/注册回滚、sync QA（local）、外键反向级联、Time Travel（发生在事故后）；
- **未排除**：人工 D1 SQL/Dashboard 删除、仓库外脚本、平台异常、凭据滥用；
- **证据缺口**：Cloudflare Audit Logs 读取 403；Worker 无持久日志；D1 无 SQL 审计；
- **防护**：`scripts/lib/qa-cleanup.mjs` 四重校验 + 资源上限 + 删除后计数；应用内注销增加身份、审计、`deletion_state='pending'`、影响行数=1 约束；
- **测试**：11/11 QA 清理护栏测试；`npm run verify`、24 E2E、20 同步 QA 通过；**未运行 qa:prod、未做任何生产修改**。

## 附录 E：生产数据安全补强（2026-11-06）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| Cloudflare Audit Logs 权限 | **Pending Manual Action** | 当前 Wrangler OAuth 无 `audit_logs`；API 403；见 `docs/SECURITY-AUDIT-ACCESS.md` |
| D1 整库备份工具 | **Implemented / 本地验证** | `scripts/db-backup.mjs`：backup / verify / list / restore-check；本地 62 表 519 行备份、加密、篡改检测、隔离恢复均通过 |
| D1 每日自动备份 | **未启用** | `.github/workflows/db-backup.yml` 已准备；缺 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_BACKUP_KEY` |
| 数据异常监控 | **Implemented / 本地验证，未部署** | `0015_data_monitor.sql` + Cron `runDataMonitor` + `/api/admin/data-monitor`；本地 scheduled 实跑 1 快照 0 告警 |
| 告警通知 | **未配置** | 可选 `DATA_ALERT_WEBHOOK`；当前只写 D1，不伪造送达 |
| 安全事件日志 | **Implemented / 本地验证，未部署** | 新增注销失败、监控、备份、QA 清理事件；Token/Cookie/邮箱过滤测试 6/6 |
| 测试 | **Verified（本地）** | 11 清理 + 8 备份 + 9 监控 + 11 Workflow + 4 恢复 + 6 日志，共 49/49；verify / 24 E2E / 20 同步 QA 通过 |
| 生产变更 | **无** | 未部署、未应用迁移、未跑 qa:prod、未写生产 D1/R2 |

## 附录 F：Phase 2.1 Desktop Shell CSS 拆分（2026-11-06 实施 / 2026-11-07 复核）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| CSS 拆分 | **已完成（本地）** | index.astro 内联全局 CSS 9,799 行拆为 `src/styles/desktop/` 18 个内容文件 + 1 个入口 |
| 语义等价 | **字节级一致** | 18 文件合计 270,945 B，与拆分前内联块完全相同；`@keyframes`/`@media`/`:root` = 35/12/4 |
| 加载顺序 | **保持** | 构建 `index.B_TNKWp7.css` 内容 hash/大小未变（273,238 B），仍是第 2 个 stylesheet |
| 视觉回归（复核） | **19/21 完全一致 + 1 动态 + 1 单像素** | `768x1024-window` 为通知未读红点；`1440x900-menubar-open` 仅 1 px、Δ=3/255；147/147 boundingBox 一致 |
| 生产 UI 复测 | **通过（只读）** | 生产 10 个 CSS 资产与本机构建同名同字节（`index.B_TNKWp7.css` 273,238 B）；渲染检查 9/9 |
| 取证缺口 | **已关闭** | `1440x900-dialog` 已恢复复采（diff=0）；截图脚本入库 `a712d96` |
| 自动化（本次实跑） | **通过** | `verify` 绿（115 单测 + 49 安全）；24 E2E；`qa:sync` 20/20；`check:astro` 0 error/0 warning；`lint` 0 problem；CSP 12 哈希 |
| 首屏 CSS | **476,749 B → 移交 Phase 6.2** | 超 200 KB 的事实保留；2.1 验收口径已由所有者修订为「结构/语义/视觉」，性能指标转入 6.2 |
| 验收口径 | **已修订（2026-11-07 所有者决定，方案 A）** | 首屏 ≤ 200 KB 从 2.1 移交 6.2；476,749 B 作为 6.2 起点基线，未静默丢弃 |
| 生产变更 | **已随 6928916f 上线** | 本阶段未部署、未改数据；生产 UI 已于 2026-11-07 只读复测 |
| 分支 | `refactor/2.1-desktop-css-extraction` | 2026-11-07 创建；工作区既有改动全部保留 |
| 结论 | **Verified**（结构 / 语义 / 视觉口径） | 不表示性能目标已达成，仅表示本次搬迁达标 |

详见 **docs/architecture/DESKTOP-CSS.md**（新增，权威说明）、docs/PHASE-2.1-CSS-AUDIT.md、docs/PHASE-2.1-CSS-REFACTOR.md。

## 附录 G：Phase 1.6 生产数据保护（2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| D1 存储版本 | **production** | 只读 API 确认 `version: production`；当前 Time Travel bookmark 已记录 |
| Workflow 备份代码 | **生产真实执行成功** | run `cf_ff32148d...` 5 steps complete；SQL 100,976 B |
| 每日调度 | **已启用（Worker Cron）** | `0 19 * * *`；Workflows `schedules` 因免费 plan 不可用，改由 Cron 创建实例 |
| 独立 R2 Bucket | **已创建** | `guandao-db-backups`（Standard / APAC）；未公开 |
| D1 REST API Token | **已设置，export 可用** | D1 GET/export 均成功；完整权限列表未枚举 |
| 加密/SHA-256 | **生产验证通过** | AES-256-GCM；R2 回读 `sha256_match`；对象 100,992 B |
| 隔离恢复 | **生产备份隔离验证通过** | 63 表 / 110 索引 / 74 外键 / 16 迁移；`productionTouched:false` |
| 备份监控 | **已部署** | 26h stale / failed / unknown；生产 Cron 运行 |
| 生产备份 | **成功** | R2 对象 100,992 B；SHA-256 match；隔离恢复通过 |
| 告警真实送达 | **已验证（真实外部 HTTPS）** | `npm run qa:alerts` 16/16：webhook.site 实际收到 `guandao.backup.alert` 与 `guandao.data.alert`，payload 无 Token/SQL/邮箱 |
| 生产告警配置 | **Pending Manual Action** | Cloudflare 仍未设置 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`；需所有者提供渠道 |
| 生产变更 | **已发生** | 创建 Bucket/Secret、应用 0015/0016、部署 `6928916f`；未跑 qa:prod |

文档：docs/operations/D1-BACKUP.md、D1-RECOVERY.md、D1-MONITORING.md。

> 告警**代码链路**已用真实外部 HTTPS 验通（不是 Mock），但 Cloudflare 上仍未配置接收端，
> 因此整体维持 `Implemented / Partially Verified`：不能声称"生产告警已在真实故障中送达"。
> 验证脚本与口径见 `docs/architecture/DESKTOP-CSS.md` §10 与 `scripts/alert-delivery-check.mjs`。

## 附录 H：Phase 2.2 旧版应用迁移（2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 迁移方式 | **复用现有注册机制** | `registerApp` + `LegacyAppContext` 显式注入；未新建注册中心 |
| 已迁移 | **5 个** | `posts` / `about` / `rank` / `calc` / `viewer` |
| 新模块 | `src/lib/legacy-apps/` | 8 文件 / 470 行，含 `types.ts` 与共享上报 `leaderboard/report.ts` |
| 注册时机 | **保持正确顺序** | 注册点在 `renderDock()` 之前，程序坞不会漏图标 |
| `index.astro` | **7,765 → 7,439 行** | 字节 331,283 → 317,430 |
| 重复实现 | **已消除** | 排行榜上报由外壳 60s 计时器与窗口共用一份实现 |
| E2E | **31/31 通过** | 新增 `tests/e2e/legacy-apps.spec.ts` 7 项，覆盖 5 个应用的开/关/重开/去重 |
| 单测 | **123/123 通过** | 新增 8 项：模块形状、注入契约、上报适配器 |
| 全量门禁 | **通过** | `verify` 0 error / 0 lint problem；build 29 页；CSP 12 哈希；`qa:sync` 20/20 |
| 未迁移 | **12 个仍读闭包** | 终端/设置 10–12 项外壳依赖；树洞·议会·社会网络共享认证链路 |
| 死代码 | **已定位，未清理** | `notes`/`calendar`/`files`/`music` 旧实现约 817–893 行被 os14 覆盖 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Partially Verified** | 低耦合一类已完整迁移并验证；高耦合需先做外壳能力接口化 |

详见 **docs/architecture/LEGACY-APPLICATIONS.md**（权威说明）。