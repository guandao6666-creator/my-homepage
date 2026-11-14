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
| `index.astro` | **7,765 → 6,605 行** | 迁移 5 个应用 + 删除 831 行死代码；字节 331,283 → 283,007 |
| 重复实现 | **已消除** | 排行榜上报由外壳 60s 计时器与窗口共用一份实现 |
| E2E | **36/36 通过** | 新增 `tests/e2e/legacy-apps.spec.ts` 12 项：5 个应用开/关/重开/去重 + 4 个清理回归 + 注册表完整性 |
| 单测 | **123/123 通过** | 新增 8 项：模块形状、注入契约、上报适配器 |
| 全量门禁 | **通过** | `verify` 0 error / 0 lint problem；build 29 页；CSP 12 哈希；`qa:sync` 20/20 |
| 未迁移 | **12 个仍读闭包** | 终端/设置 10–12 项外壳依赖；树洞·议会·社会网络共享认证链路 |
| 死代码 | **已清理 831 行** | `notes`/`calendar`/`files`/`music` 旧实现被 os14 覆盖，不可达；含可达性论证与深链补偿 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Partially Verified** | 低耦合一类已完整迁移并验证；高耦合需先做外壳能力接口化 |

详见 **docs/architecture/LEGACY-APPLICATIONS.md**（权威说明）。

## 附录 I：Phase 2.3 统一 HTML 转义与 URL 校验（2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 统一模块 | **已建立** | `src/lib/html.ts`：`escapeHtml` / `escapeAttr` / `safeUrl` / `isSafeUrl` |
| 重复实现迁移 | **6 处已迁移** | `os14/core.ts`、`mobile/ui.ts`、`quality/errors.ts`、`index.astro`、`home.astro`、`notes.astro` |
| 保留例外 | **1 处（已说明）** | `blog/index.astro`：`<script is:inline>` 不能 import，改模块脚本会改变 CSP 哈希 |
| 别名 | **已归一** | `esc`（421 处调用）改为 `escapeHtml` 别名，不是第二份实现 |
| URL 协议校验 | **新增能力** | 此前全仓库无任何协议校验；`safeUrl` 拦截 `javascript:`/`vbscript:`/控制字符拆解 |
| URL 覆盖范围 | **4 处第三方入口** | 插件主页、开发者网站、插件截图、插件图标 |
| 单元测试 | **40/40** | `tests/unit/html.test.ts`；含 `safeUrl({}) → ""` 反向用例（该用例一开始失败，暴露并修复了实参类型漏洞） |
| DOM 测试 | **11/11** | `tests/e2e/html-security.spec.ts`；含对照组证明检测有效 |
| 全量门禁 | **通过** | `verify` 163 单测 + 49 安全；E2E 49/49；`qa:sync` 20/20 |
| 剩余风险 | **已登记，未修复** | 34 处动态 URL 插值 / 22 处直接赋值未做协议校验；268 处 `innerHTML` 未逐一审计 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Partially Verified** | 转义统一与双层测试已达成；URL 校验仅覆盖第三方入口 |

详见 **docs/architecture/HTML-SECURITY.md**（权威说明）。

## 附录 J：Phase 2.3.1 全量 HTML 安全审计（2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 扫描方式 | **AST（TypeScript 编译器 API）** | 正则只用于模板内属性文本匹配；`.astro` 先抽 script 块并保留行号 |
| HTML sink | **268 处，全部登记** | 26 文件插值 100% 已包装；26 文件逐个复核（数字/内部渲染函数/已校验常量） |
| 动态 URL 插值 | **42 → 0** | 按用途分别用 `safeUrl`（第三方/内部路径）、`{allowBlob}`（对象 URL）、`{allowData}`（插件图标） |
| 直接 URL 赋值 | **22 处，全部 Safe** | `blob:` / 内部 API 路径 / 常量；属性赋值不经 HTML 解析 |
| 危险协议字面量 | **0** | 上一轮的 `"JavaScript"` 是标签字符串误报，规则已加冒号要求 |
| 修复 | **2 份遗漏的转义副本** | `pairing/page.ts`、`admin/index.astro`（上一轮正则漏掉 `function escapeHtml` 写法） |
| 保留例外 | **1 处** | `blog/index.astro` 内联副本 + 20 组一致性测试 |
| 自动化 | **已接入 verify** | `npm run check:html-security`：白名单需写 reason、文件级 count 防漂移 |
| 测试 | **47 单元 / 26 DOM** | 全量 `verify` 170 单测；E2E **64**；`qa:sync` 20/20 |
| 剩余风险 | **已登记** | 白名单为文件级粒度；无 sanitizer；`img.src` 未强制协议校验；CSP 兜底 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Verified** | 全部注入点完成分类，无未审计项 |

详见 **docs/architecture/HTML-SECURITY.md** 附录。

## 附录 K：Phase 2.4 事件与资源生命周期治理（2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| Scope | **复用现有实现** | `src/lib/quality/resources.ts`；未新建资源管理器，接口未变 |
| 确认缺陷 | **1 个，已修复** | `once: true` 监听器触发后计数与 disposer 登记不回收，导致 `resourceStats()` 永久偏高 |
| 新增单测 | **19 项** | `tests/unit/resources.test.ts`：dispose 幂等/重复执行/异常隔离/逆序/子域级联/监听手动与自动释放/timeout 完成与取消/interval/observer/abort/scopes 对称 |
| 生命周期 E2E | **7 项计数** | 新增 observers、objectUrls；另加 4 项功能回归（图标、按键、程序坞、Ctrl+K） |
| 20 次开关 | **全部零净增长** | 5→5 / 1→1 / 1→1 / 0→0 / 7→7 / 4→4 / 0→0 |
| 模块迁移 | **0 个** | 审计未发现泄漏模块；现有 Root/Application/Window/Component 归属正确 |
| Root Disposal | **不启用（已论证）** | `installRootDisposal` 用 `pagehide`，与 BFCache 冲突；卸载时浏览器自会回收 |
| 静态门禁 | **不新增** | 生命周期归属无法可靠 AST 判定，避免高误报门禁；改用运行时计数证据 |
| 监控盲区 | **已记录** | 计数只覆盖 Scope 内资源；subscription / WebSocket / BroadcastChannel 无独立计数器 |
| 全量门禁 | **通过** | `verify` 189 单测；E2E 64；`qa:sync` 20/20 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Verified** | 缺陷已修、回归有据、盲区如实列出 |

详见 **docs/architecture/EVENT-LIFECYCLE.md**。

## 附录 L：Phase 2.5 社区模块拆分（批次 1，2026-11-07）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 原始规模 | **3,350 行 / 171,279 字节** | 本次重新统计，与历史审计一致 |
| 公开导出 | **2 个** | `renderCommunity`、`initCommunity` |
| 已拆出 | **3 模块 / 252 行** | `community/types.ts`、`constants.ts`、`ui.ts` |
| 入口兼容 | **保持** | `community.ts` 仍导出原 2 个函数；导出面有测试锁定 |
| 循环依赖 | **无** | `community/*` 只依赖 `../../html`、`../core`、`../../community/*` |
| 共享状态 | **未复制** | 闭包状态仍只在 `initCommunity` 内 |
| 测试 | **6 项** | `tests/unit/community.test.ts` |
| 全量门禁 | **通过** | `verify` 195 单测；E2E 64；`qa:sync` 20/20 |
| 未完成 | **73 个闭包函数** | 需先抽 context 对象，留给批次 2–4 |
| 生产变更 | **无** | 未部署、未改数据、未跑 `qa:prod` |
| 结论 | **Partially Verified** | 纯层已拆且验证通过；业务闭包尚未拆分 |

详见 **docs/architecture/COMMUNITY-ARCHITECTURE.md**。

---

## 附录 M：Phase 3 插件供应链安全与多设备验证（2026-11-07）

**边界**：未重写 Core / Window Manager / App Registry / Plugin Runtime；未删除任何未签名插件数据；
未强制旧插件签名；私钥未写入数据库普通字段、源码、构建日志或客户端包；生产未部署、未写入、未跑 `qa:prod`。

### M.1 改造前的真实供应链（不是文档推测）

1. **生成包**：CLI `makeBundle(manifest, files)` → `{format:"guandao-plugin", formatVersion:1, manifest, files, filesDigest}`，
   `filesDigest = sha256(canonicalFilesJson(files))`。
2. **上传**：`POST /api/developer/plugins/:id/versions`（body `bundle` 必须是**字符串**）→
   `inspectBundle()` = `validateBundle` + 重算 `filesDigest` / `packageDigest=sha256(raw)` 并与声明比对 →
   写 R2 `plugins/<id>/<version>/package.json` + `plugin_versions` 行（`status='pending'`）。
3. **存储**：R2 `FILES` 存整包原文；D1 `plugin_versions.package_sha256` 存摘要、`package_key` 存对象键。
4. **发布者身份**：`plugins.developer_id` → `users.id`（GitHub 账号），**没有任何密钥概念**。
5. **市场返回**：`listPlugins` / `pluginDetail` 由 `mapPluginCard` / `mapVersion` 出卡片与版本列表。
6. **客户端下载**：`GET /api/plugins/:id/package` → 服务端重算 `sha256(text)` 与 `package_sha256` 比对 →
   返回 `{packageJson, checksum, manifest}`。
7. **安装 / 更新**：`POST /api/plugins/install`（比对客户端声明的 `packageHash` 与 DB 摘要）→
   客户端 `verifyBundle()` 再算一次双摘要 → 写入 IndexedDB 安装记录。
8. **回滚**：`updateInstallation` / `rollbackInstallation` 重放先前的 `packageHash`，同样没有签名环节。

**结论**：改造前 D1 + R2 是唯一信任根。谁能让 D1 与 R2 同时被改（或谁能冒充开发者账号上传），
谁就能让所有客户端装上任意内容——这正是本阶段要补的洞。

### M.2 签名架构（已落地）

- **被签内容**：`SIG_FIELDS = spec / alg / keyId / publisherId / pluginId / version / format / formatVersion / filesDigest / manifestDigest / signedAt`，
  载荷 = 信封去掉 `sig` 后的 `canonicalJson` 的 UTF-8 字节。**不签原始包文本**：包是格式化 JSON，
  逐字节跨端不可保证，且签名内嵌进包会造成循环。
- **规范化**：复用 `shared/plugin-spec.js` 的 `canonicalJson`（对象键排序、数组保序）与 `canonicalFilesJson`（按 path 排序）；
  v1 只允许字符串 / 非负整数 / 布尔，禁止浮点、null、数组、嵌套与自由文本 → 不存在 Unicode 归一化与数值格式歧义；
  **字段必须全部存在，缺字段即非法，不做默认值填充**。
- **keyId**：`ggk_` + `sha256(publicKey raw)` 前 16 hex，公钥与 keyId 一一对应，`publisher_keys` 上另有唯一索引兜底。
- **密钥生命周期**：`keygen`（客户端本地生成，私钥只写 `mode 0o600` 文件并提示保存责任）→
  `keys register`（用私钥对 `registerProofPayloadText` 签名，服务端验证持有证明后只存公钥）→
  轮换 = 新密钥对 + 重新登记（旧密钥可保留 active 用于验旧包）→ 撤销 = `POST /api/developer/keys/:keyId/revoke` →
  丢失 = 重新生成并登记，旧密钥撤销，已发版本需重新签名后重发。
- **判定顺序（服务端 `resolveSignature`）**：无签名 → `unsigned`；结构非法 → `invalid`；
  keyId 未登记 → `SIG_KEY_UNKNOWN`；`publisher_keys.user_id !== plugins.developer_id` → `SIG_IDENTITY_MISMATCH`；
  已撤销 → `SIG_KEY_REVOKED`；再验 Ed25519 与摘要/版本/插件 ID 一致性。
- **客户端二次验签**：`src/lib/plugins/signature.ts` 独立实现，公钥**只从服务端 `publisherKeys` 取**，
  绝不接受签名自带的公钥；包摘要 → filesDigest → 信任状态 → keyId 查找 → 撤销状态 → Ed25519 → 插件 ID/版本一致性。
- **阶段 A（本阶段）**：签名缺失 = `unsigned`，**允许安装但界面必须标注**；签名存在但任何一步失败 = `invalid`，
  拒绝安装 / 更新，**绝不静默降级为无签名安装**；上传期即拒绝（422），不写版本行。
- **保留 SHA-256**：哈希与签名承担不同责任。哈希防篡改（传输/存储损坏），签名防伪造（发布者身份）。

### M.3 沙箱隔离现状与实测

- 双层 `sandbox="allow-scripts"`（宿主 iframe + 插件 iframe），**全仓无 `allow-same-origin`**，两帧都是 opaque origin。
- 每次挂载独立 `MessageChannel` + nonce 握手；全仓不做 `event.origin` 比较，依赖 WindowProxy 相等 + 一次性 port + nonce。
- Broker（`METHOD_PERMISSION` 白名单 + payload 上限 + 权限 + 限速 + 超时）门控全部 SDK 能力；
  `network.fetch` 另有服务端复核（域名白名单、私网 IP 拦截、禁重定向、256 KB 上限）。
- 实测（`tests/e2e/sandbox-worker.spec.ts` 10 项，真实 Worker）：插件 frame 内 `localStorage` / `document.cookie` /
  `fetch` 真实抛错或被 CSP 拒绝；导航逃逸后 `record.blocked=true`、iframe 销毁、重开直接禁用；
  权限撤销与跨标签页撤销都会销毁运行实例；伪造 HELLO/RPC 消息可达宿主但不影响真实会话。
- 独立 Origin 本地实测（`tests/e2e/sandbox-origin.spec.ts`，宿主 8788 + 沙箱源 4399）：sandbox 帧 `window.origin` 为 `null`、
  `localStorage` / `document.cookie` 读取抛 `SecurityError`、父 DOM 与宿主 API 不可达；**未加 sandbox 的独立源帧**仍被
  Origin / CORS / 父文档同源策略隔离；同时实测发现 **Cookie 作用域是 host（端口不隔离）**，方案 B 落地必须使用独立 host。
  该实测只证明隔离语义，生产域名/证书/Worker route 未创建。
- 残余风险：**导航逃逸只能事后惩罚**（越权的 URL 请求已经发出）；撤销依赖调用点而非运行期回读 store；
  服务端只对 `network.fetch` 复核。独立 Sandbox Origin 方案 A/B 对比与迁移步骤见 `docs/security/PLUGIN-SANDBOX.md`。

### M.4 多设备与 OAuth

- 配对：6 位数字码（约 20 bit）+ 32 字符 token，10 分钟 TTL，`max_attempts 5`，服务端只存 SHA-256；
  A 批准才插设备并下发独立 Session（`x-pairing-cookie`）。
- 接力：`pending → delivered → opened → completed`，另有 `cancelled / expired`；载荷 32 KB 上限。
- 剪贴板：4000 字符上限、24h TTL、目标设备或广播、软删。
- 实测：`tests/e2e/device.spec.ts` **12 项**，六个独立 `browser.newContext()`（A / A2 / B / C / outsider / crowded），不共享 Cookie / localStorage / IndexedDB；
  连续两轮全绿且中间不重启服务、不清库（12 passed 4.3s / 4.2s），覆盖真实过期判定、`WRONG_DEVICE`、`DEVICE_LIMIT`、`INVALID_TOKEN` 与 claim 同源校验；
  同一 spec 另在 **Firefox 157**（`--project=firefox-worker`）与 **WebKit 27.2**（`--project=webkit-worker`）各通过 12 项。撤销后 401 错误码已统一为 `SESSION_REVOKED` / `DEVICE_REVOKED`。
- 真实 TTL：`npm run qa:pairing-ttl`（`scripts/pairing-ttl-check.mjs`）真实等待 10 分钟（不修改时间戳），
  断言 `elapsedMs ≥ 600000`、过期轮询/确认 410、同码重领 404、设备快照不变；**实跑 12/12 通过，`elapsedMs=605004`**。
- OAuth：本阶段新增的测试模式开关为三条件 AND，且**只在 loopback origin 成立**；测试身份只来自固定 `qa-*`；
  state / PKCE / Cookie 属性一律不改。生产侧用伪造 `Host: guandao.xin` 实测被拒（302 `not_configured`，无 Set-Cookie）。

### M.5 本阶段发现并修复的缺陷

1. `POST /api/pairing/claim` 缺 `assertSameOrigin` —— 第三方页面可替用户提交 claim。
2. `POST /api/continuity/:id/open` 响应的 `openedAt` 恒为 `null`（用更新前行映射）。
3. `worker/api/plugins/handlers.js` 从 `./signature.js` 导入 `mapSignatureTrust`（实际在 `./store.js`）→ Worker 构建失败；
   `tsc` 不检查 `.js`，只有真实 `wrangler dev` 能发现。
4. CLI `sign` 产物写到 CWD 而非项目根；`signBundleObject` 未回填 `filesDigest`（会被服务端判 `FILES_DIGEST_MISSING`）。
5. `ApiError` 无法携带结构化原因 → 新增第 4 参数 `details`，客户端可区分 `SIG_DIGEST_MISMATCH` / `SIG_KEY_REVOKED` 等。
6. 插件管理器 `listView()` 缺 `tab === "installed"` 分支：存在本地安装记录时「已安装」标签页会穿透到 policy 视图，
   列表不渲染；已补分支，并在列表/详情显示签名信任 chip 与签署时间。
7. `worker/api/continuity/handlers.js` 的剪贴板分支调用未导入的 `requireSession`（重构漏改，运行时 ReferenceError）；
   已改为统一的 `requireActiveSession`。
8. 撤销后 401 错误码在 devices 与 continuity/clipboard/pairing 之间不一致；已抽出
   `guards.sessionFailure()` / `requireActiveSession()` 统一（`SESSION_REVOKED` / `DEVICE_REVOKED` / `SESSION_EXPIRED`）。
9. E2E 就绪竞态：Playwright 以 `/api/health` 判定 e2e-server 就绪时，Worker 已健康但 `buildFixtures()` 仍在写本地 D1，测试与夹具写入抢锁曾致夹具生成失败、服务退出（`ECONNRESET`）。
   已把就绪探针改为夹具管理端口 `GET /__e2e/ready`（只在夹具全部生成后监听），并在 `playwright.config.ts` 写明原因。

**本轮继续处理（原「只报告未修」）**：`PAIRING_ATTEMPTS_EXCEEDED` 分支经核实不可达
（`findByIdentity` 只匹配 `pending`、`markClaimed` 会置 `claimed`，attempts 永不累加），已删除假保护分支并写明真实防线
（10 分钟 TTL + `pairing-claim` 10 次/10 分钟/IP 限流 + 源设备 confirm）；撤销后 401 错误码已如上统一。

### M.6 证据索引

| 证据 | 位置 |
| --- | --- |
| 签名规范与共享实现 | `shared/plugin-signature.js`、`shared/plugin-signature.d.ts` |
| 服务端验签 | `worker/api/plugins/signature.js`、`developer.js`、`handlers.js`、`store.js` |
| 客户端验签 | `src/lib/plugins/signature.ts`、`registry.ts`、`market.ts` |
| CLI | `cli/guandao.mjs`（`keygen` / `sign` / `keys register`） |
| 迁移 | `migrations/0017_plugin_signatures.sql` |
| 单测 | `tests/unit/plugin-signature.test.ts`（40）、`plugin-signature-server.test.ts`（11） |
| E2E | `tests/e2e/plugin-signature.spec.ts`（19）、`sandbox-worker.spec.ts`（10）、`sandbox-origin.spec.ts`（1）、`sandbox.spec.ts`（6）、`device.spec.ts`（12，Chrome + Firefox + WebKit）、`oauth.spec.ts`（14） |
| 配对 TTL 真实时间 | `scripts/pairing-ttl-check.mjs`（`npm run qa:pairing-ttl`：真实等待 10 分钟） |
| QA 自包含运行 | `scripts/seed-qa-local.mjs`、`scripts/qa-local-run.mjs`（`npm run qa:plugins` 70/70、`npm run qa:continuity` 45/45、`npm run qa:devices` 31/31） |
| 文档 | `docs/security/PLUGIN-SIGNING.md`、`PLUGIN-SANDBOX.md`、`docs/architecture/DEVICE-PAIRING.md`、`docs/testing/OAUTH-TESTING.md` |
| CI | `.github/workflows/quality.yml`：E2E 安装 Firefox / WebKit 并跑四个 project；2026-11-09 已由 PR #1 触发 quality run `42564445648`：verify / API smoke / E2E 全 success，E2E 147 passed；首次实跑修复 `backups/` 忽略误伤源码与 typecheck 缺 `astro sync`（`559adf5`） |

**结论：`Accepted (Local/CI)`；生产层 `Blocked`。** —— 本地 / 隔离环境与 GitHub Actions 全绿且有真实执行证据；生产验证与部署按门禁未执行，不写成「已验证」。PR #1 仅用于触发 CI，已关闭未合并；Phase 2 的 2.2 / 2.5 作为独立遗留项跟踪。

---

## 附录 N：Phase 4 云同步扩展与冲突解决（2026-11-09）

> 前置状态：Phase 3 `Accepted (Local/CI)`、生产层 `Blocked`；Phase 1.6 门禁未解除（备份告警未配置、
> 2026-11-06 账号删除事故 `Mitigated / Pending Investigation`）。本阶段只在本地 / 隔离环境开发与验证。

### N.1 改造前的真实同步结构（不是文档推测）

- 服务端 `worker/api/sync/store.js`：`SYNC_DOMAINS = ["notes","tasks","calendar"]`，`sync_entities` 主键 `(user_id,domain,entity_id)`，
  有 `revision / deleted / payload_json / updated_at`；`applyChange` 在 `baseRevision < 云端 revision` 时返回 conflict 且**不覆盖**。
- `worker/api/sync/handlers.js`：`MAX_BATCH=100`、`MAX_PAYLOAD_BYTES=128KB`、`MAX_BODY_BYTES=768KB`；push 逐条落库并汇总 `applied/conflicts`；
  无用户级配额、无墓碑清理、`/status` 不含配额。
- 客户端 `src/lib/core/sync.ts` + `src/lib/sync/providers.ts`：实体级增量 + Revision 乐观锁；三域 provider；
  冲突时**服务端版本落回本地**，只把冲突数写进 `DomainStatus.conflicts`，没有用户可见的冲突记录与选择。
- `migrations/0014_sync.sql` 的 CHECK 只允许三域，SQLite 不能直接修改 CHECK，加域必须重建表。
- System Center 云端设置只显示同步状态、域列表与本地墓碑总数，不显示服务器配额与冲突详情。

### N.2 本阶段实现

1. **迁移 0018**：`sync_entities` 改名为 `sync_entities_legacy_v1` 保留（不 DROP）；重建 5 域表并新增 `deleted_at`；复制数据（历史墓碑 `deleted_at=updated_at`）；
   重建索引 + `(deleted, deleted_at)` 清理索引；新增 `sync_tombstone_ledger`（防复活台账）与 `sync_cleanup_log`（清理审计，保留最近 200 行）。
2. **限额**：`worker/api/sync/limits.js` 纯函数：5 域、`DOMAIN_PAYLOAD_LIMITS`（workspace 128KB / preferences 32KB，其余 128KB）、
   单用户实体 5000、墓碑 2000、TTL 90 天、清理 200/批、单次 2000 条。
3. **存储**：`applyChange` 写 `deleted_at` 并 upsert 台账；无实体行但台账存在且 `baseRevision < ledger.revision` → 合成 `deleted` 冲突（防复活）；
   `userQuotaStats` / `estimateQuotaDelta`（写前保守估算）/ `purgeExpiredTombstones`（先补台账再分批删、幂等）。
4. **HTTP**：`/api/sync/status` 增加 `quotas`；push 按域校验 payload 上限，配额超限 409 `QUOTA_EXCEEDED`（`details.scope`）。
5. **Cron**：`worker/index.js` 现有 `*/15` 体系新增独立 `runSyncTombstoneMaintenance`，内部捕获所有异常、写审计、失败不影响其他任务。
6. **客户端**：`src/lib/sync/workspace.ts`（仅 `preset:false`，payload ≤128KB，known-id 合成删除，应用时用 Layout Manager 重算几何）、
   `preferences.ts`（13 项白名单，≤32KB，first-sync 云端优先）、`conflicts.ts`（50 条 / 7 天 / 脱敏受控快照 / 可注入 storage）；
   `providers.ts` 扩 5 域、冲突时记录元数据、新增 `resolveSyncConflict`（保留本地按 serverRevision 重推；保留云端 pull→apply；再冲突 `changed`；noop 幂等）。
7. **UI**：System Center 云端设置新增配额 KPI（实体/墓碑）与「最近同步冲突」面板（域/实体/时间/revision、保留本地/保留云端、清理已解决、changed/noop/离线提示）。

### N.3 实测结果（本机真实执行）

| 证据 | 结果 |
| --- | --- |
| `tests/unit/sync-limits.test.ts` / `sync-store.test.ts`（node:sqlite 跑真实 0014+0018） | 10 / 16 通过 |
| `tests/unit/sync-workspace.test.ts` / `sync-preferences.test.ts` / `sync-conflicts.test.ts` | 10 / 7 / 12 通过 |
| `tests/unit/systemcenter-sync.test.ts` | 25 通过 |
| 全量单测 | **18 文件 / 331 passed** |
| `scripts/sync-qa.mjs`（`wrangler dev --local` + `--test-scheduled`） | **45/45**：5 域、workspace 100KB 通过、preferences 40KB→400、未知域 400、5000 实体→409、过期墓碑清理、台账保留 revision、旧 base 重推 deleted 冲突、按台账重建、二次清理幂等 |
| `tests/e2e/sync.spec.ts`（两个独立 Browser Context，真实 Worker 8788 + 本地 D1） | **8/8 通过，连续 3 次全绿（20.3–20.5s）**：双设备 Session/隔离、workspace 推送/索引/拉取/修改/墓碑/防复活/重建、preferences 按域限额、冲突与保留本地/云端链路、参数边界 400/403/413、账号隔离与配额自洽 |
| `npm run verify` | 通过：typecheck、18 文件/331 单测、security:test 六组、`check:unused` 18、`check:astro` 0 errors/0 warnings/149 hints、`check:html-security` 291 处全审查、lint、build 29 pages、CSP 12 哈希/30 HTML、migrations **18/117** |
| `npx playwright test` | **155 passed (2.9m)**：chromium 67 + worker 64（签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / 同步 8）+ firefox 12 + webkit 12 |
| `npm run qa:sync` / `npm run qa:devices` | **45/45** / 回归 **31/31** |
| GitHub Actions quality（run 42965051693，commit `04cf8f8`） | **三个 job 全绿**：Typecheck/Unit/Build、API smoke（含 `qa:sync` 45 项）、E2E **155 passed (4.5m)**；Node 22.23.4 |

### N.4 风险与未验证项

1. 生产 D1 未应用 0018、未做生产双设备同步验证；未部署、未跑 `qa:prod`。
2. 页面级 `GOS20.syncConflicts` / `syncResolveConflict` 的浏览器 E2E 未做：本轮 `dist` 由 Phase 4 客户端代码合入前的构建提供，`sync.spec.ts` 走协议级；
   状态机由单测直接覆盖，UI 纯函数由单测覆盖。重新构建后应补一次页面级人工/E2E 确认。
3. 5000 实体 / 2000 墓碑的 409 造数不在 E2E 中，由 `scripts/sync-qa.mjs` 真实触发。
4. 90 天 TTL 的前提是「无法证明所有设备都收到删除」，因此采用「TTL + 台账」而非纯物理删除；离线超过 90 天的设备再次同步会收到 deleted 冲突（预期行为）。
5. 配额估算在并发下可能保守提前拒绝（不超卖）；D1 大用户量查询耗时需生产观测。
6. 清理日志目前仅表内保留，未接外部告警；生产启用前建议补告警。

### N.5 证据索引

| 证据 | 位置 |
| --- | --- |
| 迁移 | `migrations/0018_sync_cloud_expansion.sql` |
| 服务端 | `worker/api/sync/{limits,store,handlers,maintenance}.js`、`worker/index.js`（Cron） |
| 客户端 | `src/lib/sync/{workspace,preferences,conflicts,providers}.ts`、`src/lib/os20/bridge.ts`、`src/lib/os14/workspaces.ts` |
| UI | `src/lib/os20/apps/systemcenter.ts`（配额 + 冲突面板） |
| 单测 | `tests/unit/sync-{limits,store,workspace,preferences,conflicts}.test.ts`、`tests/unit/systemcenter-sync.test.ts` |
| 协议 QA | `scripts/sync-qa.mjs`（45 项，`--test-scheduled`） |
| E2E | `tests/e2e/sync.spec.ts`（8 项，双 Context）、`tests/e2e/support/sync-flow.ts`、`scripts/e2e-server.mjs`（`POST /__e2e/reset-sync`） |
| 文档 | `docs/architecture/WORKSPACE-SYNC.md`、`PREFERENCES-SYNC.md`、`SYNC-CONFLICTS.md`、`docs/operations/SYNC-RETENTION.md` |

**Phase 4 结论：`Partially Verified`。** 本地 / 隔离层全部门禁通过；生产迁移、生产验证、页面级冲突 UI E2E 与物理设备冒烟未执行（生产层 `Blocked`），不写成「已验证」。

## 附录 O：Phase 5 社区与市场发布链（2026-11-11）

### O.1 改造前真实结构（审计结论）

- 社区资源：`community_posts`（`post_type` theme/widget/workspace/wallpaper/**tutorial**；status draft/pending_review/published/hidden/rejected/deleted；visibility public/unlisted）→ `community_packages`（active/deleted、checksum_sha256）→ `package_versions`（UNIQUE(package_id, version)、published_at）→ `community_assets`（kind + mime 白名单 + status ready/deleting/deleted）。
- 举报/审计：`community_reports`（open/reviewing/resolved/dismissed、UNIQUE reporter+target）、`community_audit_logs`（actor/action/target/detail_json）。
- 权限：所有非 GET 走 `assertSameOrigin`；admin 前缀要求 `isStaff`（moderator 或 admin），敏感动作在 `admin.js` 内 `requireAdminRole`（仅 admin）；`loadPost` 可见性 = published 或 owner 或 staff，deleted 默认 404。
- 上传：先 R2 `put` 再 D1 batch，D1 失败 `cleanupObjects` 回滚；`assertImage` 校验 magic bytes；object key 服务端生成 `users/<userId>/community/<kind>/<assetId>.<ext>`。
- 插件发布：Developer Center（草稿/上传/提交/撤销）→ 管理员审核 approve/reject/block → 市场只返回 `plugins.status='published'` → 下载时动态复验签名与 SHA-256 → 安装校验版本/哈希/签名/权限。
- 改造前缺口：没有完整「草稿→上传→提交→审核→公开→安装」的真实可重复 E2E；旧 `scripts/community-qa.mjs` 依赖手工起服务与手工 seed、未覆盖审计/清理/R2 孤儿/教程；插件 QA 未覆盖完整发布链与签名结合。

### O.2 本阶段实现与修复

- `scripts/community-qa.mjs` 重写（+1941 行）：自包含 14 段、260 项断言 + 31 项清理断言；真实 Worker `wrangler dev --local`，新 QA 身份 + 每轮唯一 runId；覆盖上传/草稿/待审/审核/公开/计数/版本/互动/举报/审计/设置权限/清理。
- `scripts/seed-qa-local.mjs`：新增 `QA_COMMUNITY_TOKENS`（creator/other，github_id 990010/990011）+ 设备/session/profile upsert + roles 清理；复用本地唯一 admin，不碰生产。
- `scripts/qa-local-run.mjs`：新增 `community` target；仅 community 加 `--test-scheduled`（用于观察维护任务）。
- `scripts/lib/qa-cleanup.mjs`：`CHILD_TABLES` 追加 7 张含 `user_id` 的社区表并加顺序注释；四重校验与数量限制未放宽。
- `package.json`：`qa:community` 改为 `node scripts/qa-local-run.mjs community`（原先需手工起 8787）。
- `src/lib/os14/community.ts` 修复真实缺陷：`loadDetail` 条件 `data.post.type !== "tutorial" && data.package` → `data.package`；否则教程正文存于 `manifest.configuration.content` 却永不拉包、详情正文区不渲染。
- `scripts/plugins-qa.mjs` +379 行：新增 [11] Phase 5 完整发布链 37 项（Ed25519 签名 → 上传 verified → submit → 权限 → approve → 市场 → 下载 SHA-256 → 安装 → takedown → 审计）。
- 新增 `tests/e2e/plugin-publishing.spec.ts`（4 Context）、`tests/e2e/community-tutorial.spec.ts`（双 Context）、`tests/unit/community-tutorial.test.ts`（20 项）；`playwright.config.ts` 的 `WORKER_SPEC` 加入 `plugin-publishing`、`community-tutorial`。

### O.3 实测结果

| 项 | 结果 |
| --- | --- |
| `npm run qa:community` | **260/260 ×3**，47.5s / 47.6s / 48.0s，exit 0；清理 R2=OK / 身份=OK / 残留=0 |
| `npm run qa:plugins` | **107/107 ×2**（原 70 + 新增 37） |
| `tests/e2e/plugin-publishing.spec.ts` | 1 passed ×2 |
| `tests/e2e/community-tutorial.spec.ts` | 2 passed ×2；`tests/unit/community-tutorial.test.ts` 20 passed ×2 |
| `npm run verify` | exit 0：19 文件 / **351 单测**；html-security 291 处全审查；build 29 pages；CSP 12/30；migrations 18/117 |
| `npx playwright test` | **158 passed (2.9m)**：chromium 67 + worker 67（签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / 同步 8 / 教程 2 / 插件发布链 1）+ firefox 12 + webkit 12 |
| `npm run qa:sync` | **45/45**（Phase 4 域无回归） |
| 页面级插件安装本地证据 | 20/20，截图 `.shots/p5-page-evidence2-*.png`（未入 Playwright） |
| GitHub Actions quality（run 43588486049，commit `a84af7e`） | **三个 job 全绿**：Typecheck/Unit/Build（19 文件 / 351 单测、migrations 18/117、CSP 12/30）、API smoke（qa:sync 45/45）、E2E **158 passed (4.4m)**；Node 22.23.4 |

### O.4 风险与未验证项

1. 生产发布链未执行：未写生产 D1/R2、未应用生产迁移、未部署、未跑 `qa:prod`（Phase 1.6 门禁）。
2. 页面级插件安装仅有本地证据脚本，未纳入 Playwright；Playwright 中为协议级 `plugin-publishing.spec.ts`。
3. 教程无页面级浏览器 E2E；正文渲染由 `renderMarkdown` 源码守卫 + API/单测覆盖。
4. `follow` 正向链路在无 UUID 创作者的新库 SKIP（API 强制 UUID 属生产设计）。
5. `seed-qa-local.mjs` 复用唯一 admin 并清其其它 session：与 e2e fixtures 共用 admin 时不可并发；spec 已做 fixtures → seed 回退。
6. R2 物理删除依赖维护任务重试；测试清理以 D1 状态 + 维护任务结果复核，不直接枚举桶。

### O.5 证据索引

| 证据 | 位置 |
| --- | --- |
| 发布链 QA | `scripts/community-qa.mjs`（14 段 / 260 项）、`scripts/qa-local-run.mjs`、`scripts/seed-qa-local.mjs` |
| 清理守卫 | `scripts/lib/qa-cleanup.mjs`（`CHILD_TABLES` 扩展） |
| 教程修复 | `src/lib/os14/community.ts`（`loadDetail`） |
| 教程测试 | `tests/unit/community-tutorial.test.ts`、`tests/e2e/community-tutorial.spec.ts` |
| 插件发布链 | `scripts/plugins-qa.mjs` [11]、`tests/e2e/plugin-publishing.spec.ts` |
| 页面级证据 | `.shots/_p5-page-install-evidence2.mjs`、`.shots/p5-page-evidence2-*.png`（本地，未提交） |
| 文档 | `docs/architecture/COMMUNITY-PUBLISHING.md` |

**Phase 5 结论：`Partially Verified`。** 本地 / 隔离层与真实浏览器 API 证据全部通过；生产发布链、页面级插件安装（Playwright 内）与真机冒烟未执行（生产层 `Blocked`），不写成「已验证」。
