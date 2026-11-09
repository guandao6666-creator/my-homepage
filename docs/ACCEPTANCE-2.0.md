# Guandao OS 2.0 · 正式发布验收清单

> 对照任务书 §21。图例：
> **✅ 已验证**（有可重复执行的自动化证据，或已在生产环境实际验证）
> **🟡 已实现，未端到端验证**（需要真实 GitHub OAuth / 双设备 / 真实上传等）
> **⚠️ 部分实现**
> **⛔ 未执行**（本次发布窗口内未做）

**发布状态**：已于 2026-11-05 部署到 Cloudflare 生产（https://guandao.xin，版本 `8866fe13`）。

| 结论 | 数量 |
| --- | --- |
| ✅ 已验证 | 39 |
| 🟡 已实现，未端到端 | 15 |
| ⚠️ 部分实现 | 0 |
| ⛔ 未执行 | 0 |

> 生产端到端（`npm run qa:prod`）覆盖：会话/账号、云盘上传下载、同步推送与冲突、备份创建/校验/下载/恢复、隐私与安全事件、社区与插件公开接口、登录态内核启动与同步下拉、System Center 真实配额、PWA 离线刷新，共 35 项。

---

## Core

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 系统启动正常 | ✅ | `tests/e2e/os20.spec.ts:48` 断言 11 个阶段都有耗时；`platform.test.ts` 拓扑/超时 |
| 核心模块职责清楚 | ✅ | `docs/ARCHITECTURE-2.0.md` §3，18 个模块一一对应文件 |
| 生命周期管理正常 | ✅ | `core.test.ts` initialize/start/activate/suspend/dispose + 逆序销毁 |
| 应用注册中心正常 | ✅ | `core.test.ts` 状态机；`os20.spec.ts:138` 窗口 ↔ 状态映射 |
| 事件系统正常 | ✅ | `core.test.ts` 通配/once/waitFor/错误隔离 |
| 错误隔离正常 | ✅ | `bus.ts` 单订阅者抛错不打断；`service.ts` 环依赖整环标记失败 |

## Desktop

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 桌面正常 | ✅ | `desktop.spec.ts` 菜单栏 / 图标 / Dock |
| 窗口管理正常 | ✅ | 拖动、关闭、最大化、程序坞同步（`desktop.spec.ts`） |
| Dock 正常 | ✅ | `desktop.spec.ts:78` |
| 菜单栏正常 | ✅ | `desktop.spec.ts:44` |
| 虚拟桌面正常 | 🟡 | 1.x 实现（`index.astro` 虚拟桌面），2.0 未新增自动化用例，人工验证通过 |
| Widget 正常 | 🟡 | 1.x 组件系统 + System Center 开关；无专门 E2E |
| 主题正常 | ✅ | `desktop.spec.ts:119` 深浅切换；System Center 主题卡片 |

## Applications

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 应用安装正常 | ✅ | 1.4 应用中心 + 市场预检（`os20.spec.ts:204`） |
| 应用启动正常 | ✅ | `desktop.spec.ts` 便签 / 文章 / 性能实验室 |
| 应用关闭正常 | ✅ | `desktop.spec.ts:78` 关闭后 Dock 状态复位 |
| 应用更新正常 | 🟡 | `sys.update` 与插件更新路径已实现；插件更新需真实市场包，未端到端 |
| 应用卸载正常 | ✅ | 系统应用禁止卸载（`system.ts`）；`platform.test.ts` 断言 |
| 生命周期统一 | ✅ | `registry.ts` 迁移表 + `runtime.ts`；窗口 observed |

## Cloud

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 登录正常 | 🟡 | 用生产临时 Session 验证了会话识别、账号读取、同步与云端状态；GitHub OAuth 交互登录本身未执行 |
| 数据同步正常 | ✅ | `sync-qa.mjs` 20/20（HTTP/D1）、`sync-client-qa.mjs` 8/8（双设备）；生产 `prod-e2e` 推送/索引/冲突/客户端拉取全通过 |
| 文件上传正常 | ✅ | 生产 `POST /api/files/upload?name=…` → 201，内容原样读回（56 字节） |
| 文件下载正常 | ✅ | 生产 `/content` 与 `/download` 均 200，下载带 attachment 头 |
| 多设备正常 | 🟡 | 配对/接力后端真实（6 位码 + SHA-256 + TTL）；双设备 QA 脚本未在本环境运行 |
| 备份正常 | ✅ | 生产创建保护性 + 手动备份、`run`、`verify`、JSON 下载含 SHA-256 均通过 |
| 恢复正常 | ✅ | 删除文件并清空回收站后恢复，`filesRestored=1`，文件重新出现且内容一致 |

## Ecosystem

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 社区正常 | 🟡 | D1 + R2 + 审核实现；`community-qa.mjs` 需要真实登录，未运行 |
| 主题分享正常 | 🟡 | 社区主题上传/安装链实现；同上 |
| 组件分享正常 | 🟡 | 同上 |
| 插件市场正常 | 🟡 | 市场/审核/安装实现；真实发布流程未跑 |
| 插件沙箱安全 | ✅ | `sandbox.spec.ts` 3 项：nonce、MOUNT、`allow-scripts` 无 `allow-same-origin` |
| SDK 文档正常 | ✅ | `docs/SDK-1.md` + `public/sandbox/sdk.d.ts` |
| 开发者工具正常 | ✅ | CLI `create/dev/validate/test/build/package/preview/publish`；`test` 6 项自检实测通过 |

## Security

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| Session 管理正常 | ✅ | 代码审查 + `/api/sync/*` 未登录 401 实测；撤销路径 5 条 |
| 权限系统正常 | ✅ | `os20.spec.ts:187` 默认拒绝写入审计；`platform.test.ts` 防提权/拉黑 |
| 用户数据隔离正常 | ✅ | `sync-qa.mjs` 第二个账号索引为空 |
| 插件权限正常 | ✅ | `METHOD_PERMISSION` + 高敏感权限逐项确认；换设备恢复需重新授权 |
| 文件权限正常 | ✅ | 所有文件查询带 `user_id`；IDOR 复核（审计 §5 排除项） |
| 数据导出正常 | 🟡 | `/api/privacy/export*` 实现；需要登录态，未端到端 |
| 数据删除正常 | 🟡 | 删除任务 + R2 重试实现；需要真实账号，未端到端 |

## Multi-device

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| Desktop Mode 正常 | ✅ | `desktop.spec.ts` 1440×900 |
| Tablet Mode 正常 | 🟡 | `adaptive.ts` 密度/尺寸规则；无 2.0 专门用例 |
| Mobile Mode 正常 | ✅ | `mobile.spec.ts` 3 项 |
| 设备配对正常 | 🟡 | 后端实现；双设备未跑 |
| 跨设备接力正常 | 🟡 | 后端实现；`continuity-qa.mjs` 未跑 |
| PWA 正常 | ✅ | 生产实测：SW 激活并接管页面，断网刷新仍能打开桌面 |
| 离线模式正常 | ✅ | 生产 `setOffline(true)` 后刷新成功渲染桌面（标题正常） |

## Migration & Stability

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 旧版本数据迁移正常 | ✅ | `platform.test.ts` 迁移引擎；浏览器实测 `pre-2.0-*` 快照与旧键保留 |
| 不存在已知数据丢失问题 | ✅ | 迁移只新增键；失败不提升版本；删除留墓碑 |
| 原有核心功能无回归 | ✅ | 21 项 E2E 全绿（含 1.9 桌面/移动/沙箱） |
| 自动化测试正常 | ✅ | 115 单测 + 21 E2E + 20 同步 API + 8 双设备 = 164 |
| 构建正常 | ✅ | 29 页 / 2.4s / CSP 12 哈希一致 |
| 部署正常 | ✅ | 2026-11-05 部署到 https://guandao.xin；`/api/health` 200 + 2.0.0 + D1/R2 正常；首页内核 11 阶段、0 CSP 违规、0 控制台错误（见 `docs/RELEASE-2.0.md` §16） |
| 回滚方案经过验证 | 🟡 | 上一版本 `fecd8355`（1.9）仍在部署历史中，`wrangler rollback` 可用；D1 只增索引与新表，无需回滚数据库。**未实际执行回滚演练** |

---

## 与任务书的差异说明

1. **§18 技术栈口径**：任务书写 Cloudflare Pages + Pages Functions；项目实际是
   **Worker + Static Assets**（`wrangler.jsonc`）。2.0 保持现有 Worker 形态，未改成 Pages。
2. **§9.4 同步范围**：实现 Notes / Tasks / Calendar 三个域；Workspace、User Preferences、
   Device Information 的同步未接入（设备信息由独立的 devices API 管理）。
3. **§10 Tutorials**：社区支持主题/组件/工作区/插件/应用/壁纸，**教程（Tutorials）未单独建模型**。
4. **§17 开发团队页面**：只写「Guandao Studio」与版本信息，**没有编造具体成员**。
5. **§13 更新中心**：静态站点语义，只做「检查 + 重新加载 + 迁移」，**不伪装内核热更新**。

---

## 未执行的验证（及原因）

| 项 | 原因 |
| --- | --- |
| GitHub OAuth 交互登录 | 需要真实 GitHub 账号在本机浏览器完成授权；本轮用生产临时 Session 验证了 Session 之后的所有链路 |
| 双设备配对 / 接力 | 需要两台设备与同一账号 |
| 社区发布 / 主题上传 | 需要真实创作者操作与人工审核；本轮验证了公开列表与登录态读取 |
| 线上回滚演练 | 发布过程未出现需要回滚的故障，未主动制造故障演练 |

这些项目在 `docs/RELEASE-2.0.md` 第 15–17 节同样标注为未执行，不会被写成「已验证」。

**已执行的部署验证**（详见 `docs/RELEASE-2.0.md` §16）：D1 逻辑备份、0013/0014 迁移、
Worker + 静态资源部署、`/api/health`、`/api/auth/status`、未登录 401、首页/移动端/Service Worker、
浏览器内核启动、CSP 与控制台零错误、数据完整性复核。

---

## Phase 1 · 安全与数据基线（2026-11-06）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| Supabase 凭据审查 | Verified | 只检查变量名；`SUPABASE_DB_PASSWORD` 零引用且未进 dist，已从本地 `.env` 移除 |
| Supabase 真实依赖 | Verified | 仍在使用（前端 23 + 8 处引用）；`/sb` 代理存活；未删除代理与 SQL |
| anon key 轮换 | **Verified（owner-confirmed）** | publishable key 已部署验证（`/sb` 200、dist 无旧 JWT/secret）；legacy keys 已由 owner 在控制台停用（2026-11-06 17:44） |
| Guards 统一 | Verified | `worker/api/guards.js`；auth/files/devices/backups/privacy/community/plugins/sync 已迁移 |
| 未登录 / 跨源 / 超大 body | Verified | 401 / 403 / 413；chunked 10KB 也返回 413；合法同源到达业务 |
| R2 只读巡检 | Verified | 管理员接口 + CLI；生产实跑：0 引用、12 对象、0 缺失、12 孤儿候选 |
| 依赖清理 | Verified | `@astrojs/markdown-remark` 实测为 Astro 7 配置必需，保留；`check:unused` 通过 |
| Astro 模板类型检查 | Verified | `astro check` 246 文件，0 errors / 0 warnings / 137 hints |
| ESLint | Verified | Worker/scripts/CLI 安全规则，0 problems |
| 单元测试 | Verified | 115 passed |
| QA 清理护栏测试 | Verified | 11/11（隔离 SQLite） |
| E2E | Verified | 24 passed |
| 同步 QA | Verified | 20/20 |
| 生产 QA | Verified | 35/35（本任务未重跑；按调查约束不执行） |
| 部署 | Verified | `a05bedf8-a5ff-4839-a9eb-03ab090b943f`（publishable key）；`/api/health` 200 |
| 生产数据事件 | **Mitigated / Pending Investigation** | `users=0` 后经 D1 Time Travel 恢复 1/3/3；应用内删除路径已加固；根因未确认，详见 [`docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md`](INCIDENT-2026-11-06-ACCOUNT-DELETION.md) |
| D1 整库备份工具 | Verified（本地） | backup/verify/restore-check；8/8；生产自动备份未启用 |
| 数据异常监控 | Implemented / 本地验证 | 0015 迁移 + Cron + 管理员接口；本地 scheduled 1 快照/0 告警；未部署 |
| 安全事件日志 | Implemented / 本地验证 | 49 项安全测试通过；生产未部署 |
| Cloudflare Audit Logs | **Pending Manual Action** | 当前 OAuth 403；见 `docs/SECURITY-AUDIT-ACCESS.md` |
| Phase 2.1 CSS 拆分 | **Verified / 已上线** | 18 文件合计 270,945 B，与拆分前字节完全相同；构建 `index.B_TNKWp7.css` 273,238 B hash 未变；19/21 逐像素完全一致 + 1 动态红点 + 1 单像素 Δ3；147/147 布局框；已随 `6928916f` 上线 |
| Phase 2.1 生产 UI 复测 | **通过** | 生产 10 个 CSS 资产与本机构建同名同字节（含 `index.B_TNKWp7.css` 273,238 B）；渲染检查 9/9；只读，未登录未写数据 |
| Phase 2.1 验收口径 | **已修订（2026-11-07 所有者决定）** | 2.1 收敛为「结构 / 语义 / 视觉」；首屏 ≤ 200 KB 移交 Phase 6.2，起点基线 476,749 B |
| Phase 6.2 首屏 CSS | **未达标（待 Phase 6 处理）** | 当前 476,749 B；仅桌面样式包本身 273,238 B，需先做非首屏样式延迟加载 |
| Phase 2.1 取证缺口 | **已关闭** | `1440x900-dialog` 已恢复复采且 diff=0；截图脚本已入库 `a712d96` |
| Phase 2.2 旧应用迁移 | **Partially Verified** | 5 个低耦合应用迁至 `src/lib/legacy-apps/`；复用 `registerApp` + `LegacyAppContext`；`index.astro` 7,765 → 6,605 行 |
| Phase 2.2 回归证据 | **通过** | E2E 36/36（新增 12 项）；单测 123/123（新增 8 项）；`verify` 绿；`qa:sync` 20/20 |
| Phase 2.2 未迁移应用 | **12 个仍读闭包** | 终端 10 项 / 设置 12 项外壳依赖；树洞·议会·社会网络共享认证链路；需先做外壳能力接口化 |
| Phase 2.2 死代码清理 | **已完成（831 行）** | `notes`/`calendar`/`files`/`music` 旧实现被 os14 覆盖，已删除；含可达性论证与 `openFromHash()` 深链补偿 |
| Phase 2.3 统一转义 | **Verified** | `src/lib/html.ts` 为唯一实现；6 处重复已迁移，`blog/index.astro` 内联副本保留并有 20 组一致性测试 |
| Phase 2.3 安全测试 | **通过** | 单元 **47/47**；DOM **26/26**（含对照组与 7 种危险 URL） |
| Phase 2.3.1 全量审计 | **Verified** | HTML sink **268**、动态 URL **42**、直接赋值 **22** 全部登记；`check:html-security` 接入 verify，291 处命中 0 未审查 |
| Phase 2.3.1 补漏 | **已修复** | 发现并迁移 2 份上一轮正则漏掉的转义副本（`pairing/page.ts`、`admin/index.astro`） |
| Phase 2.4 资源生命周期 | **Verified** | 复用既有 `ResourceScope`；修复 `once: true` 计数不回收缺陷；新增 Scope 单测 **19 项** |
| Phase 2.4 开关测试 | **通过** | 20 次开关 7 项计数全部零净增长（监听 5→5 / 定时器 1→1 / 观察器 4→4 / 资源域 7→7 等）+ 4 项功能回归 |
| Phase 2.4 模块迁移 | **0 个（不需要）** | 审计显示现有 Root/Application/Window/Component 归属正确，按「不为覆盖而强行迁移」处理 |
| Phase 2.4 Root Disposal | **评估后不启用** | `installRootDisposal` 用 `pagehide`，与 BFCache 冲突；理由见 EVENT-LIFECYCLE.md §6 |
| Phase 2.5 社区拆分 | **Partially Verified** | 批次 1/4：拆出 `community/{types,constants,ui}.ts`（252 行），`community.ts` 3,350 → 3,163 行，导出面不变 |
| Phase 2.5 未完成 | **73 个闭包函数** | 仍共享 `initCommunity` 闭包；需先抽 context 对象，留给批次 2–4 |
| Phase 2 整体 | **Partially Verified** | 2.1/2.3/2.3.1/2.4 Verified；2.2 与 2.5 Partially Verified → **不进入 Phase 3** |
| Phase 2.2 生命周期 | **通过** | 连续开关 20 次：监听 5→5、timeout 1→1、interval 1→1、资源域 7→7，零增长 |
| Phase 1.6 D1 备份 Workflow | **生产真实执行成功** | 5 steps complete；SQL 100,976 B |
| Phase 1.6 每日调度 | **已启用（Worker Cron）** | `0 19 * * *`；版本 `6928916f` |
| Phase 1.6 独立 R2 / Token | **已配置且可用** | D1 GET/export 成功；Bucket 已创建 |
| Phase 1.6 隔离恢复 | **生产备份隔离验证通过** | 63 表 / 16 迁移；`productionTouched:false` |
| Phase 1.6 备份监控 | **已部署** | 26h stale / failed / unknown |
| Phase 1.6 生产备份 | **成功** | R2 100,992 B；SHA match；隔离恢复 63 表 |
| Phase 1.6 告警真实送达 | **本地已验证（真实外部 HTTPS）** | `npm run qa:alerts` 16/16：webhook.site 真实收到 `guandao.backup.alert` 与 `guandao.data.alert`，payload 无敏感字段 |
| Phase 1.6 生产告警配置 | **Pending Manual Action** | Cloudflare 上仍未设置 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`；需所有者提供渠道并部署 |

Phase 1 不改变桌面/窗口/移动端行为；未执行 Shell 拆分与 Core 重写。

---

## Phase 3 · 插件供应链与多设备验证（2026-11-07）

> 前置说明：Phase 2 整体仍为 `Partially Verified`（见上表 2.2 / 2.5），本阶段由所有者**直接指派**，
> 不改变 Phase 2 的结论，也未在本阶段修改 Phase 2 的代码。

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 插件 Ed25519 签名成功 | **通过（本地）** | `tests/unit/plugin-signature.test.ts` 40 项、E2E 19 项；CLI 真实签名产物 `dist/<id>-<version>.gplug` |
| 客户端正确验签 | **通过（本地）** | `src/lib/plugins/signature.ts` 接入 4 条下载路径；公钥只取服务端 `publisherKeys` |
| 篡改包被拒绝 | **通过（本地）** | `SIG_DIGEST_MISMATCH` / `PACKAGE_INTEGRITY_ERROR` / `SIG_IDENTITY_MISMATCH` 均有 E2E 夹具 |
| 已撤销密钥被拒绝 | **通过（本地）** | 下载 `SIG_KEY_REVOKED`、安装 `SIGNATURE_KEY_REVOKED`（旧包撤销后也不可再装） |
| 旧插件兼容策略 | **通过（本地）** | `com.qa.unsigned` 可安装，信任状态为 `unsigned` 且界面标注；签名无效与缺少签名严格区分 |
| 私钥保护方案 | **已审计，仍需人工确认** | 私钥只在本机文件（`mode 0o600`）与 CLI 内存中；服务端只存公钥；迁移无任何私钥字段 |
| 沙箱安全边界明确 | **通过（本地）** | `docs/security/PLUGIN-SANDBOX.md` 列出「能保证 8 条 / 不能保证 8 条」 |
| Broker 权限继续有效 | **通过（本地）** | 未授权 SDK 调用 `PERMISSION_DENIED`；撤销后实例销毁 |
| 未授权访问被阻止 | **通过（本地）** | 插件 frame 内 `localStorage` / `document.cookie` / `fetch` 真实抛错或被 CSP 拒绝 |
| 撤销后运行实例被销毁 | **通过（本地）** | 权限撤销、禁用、卸载、跨标签页撤销均销毁实例 |
| 独立 Origin 隔离效果 | **未实施（方案已给）** | 本阶段只做同域隔离加固；独立 Origin 方案 A/B 对比见 `docs/security/PLUGIN-SANDBOX.md`，需新 DNS / Worker 资源 → 未创建 |
| 两个独立 Browser Context | **通过（本地）** | `tests/e2e/device.spec.ts` 12 项，六个独立 `browser.newContext()`（A / A2 / B / C / outsider / crowded），连续两轮全绿 |
| 配对完整 / 批准完整 | **通过（本地）** | create → claim → confirm → 轮询领取独立 Session |
| 接力完整 | **通过（本地）** | `pending → delivered → opened → completed` 与取消 / 过期 / 越权 |
| 剪贴板隔离有效 | **通过（本地）** | 定向投递、账号隔离、4000 字符上限、外来设备不可读 |
| 撤销 / 过期有效 | **通过（本地）** | 撤销后 B 请求全部 401；真实过去时间戳的过期配对覆盖 claim→404、轮询与 confirm→410（不 sleep 10 分钟，时钟未伪造） |
| OAuth 本地测试模式正常 | **通过（本地）** | `tests/e2e/oauth.spec.ts` 14 项：回调 → Session → `/me` → 退出 |
| 生产拒绝测试模式 | **通过（本地模拟）** | 伪造 `Host: guandao.xin` + `?test_login=` → 302 `not_configured`、无 Set-Cookie；`wrangler.jsonc` 无 `AUTH_TEST_MODE` |
| 回调与 Session 可重复测试 | **通过（本地）** | 同一脚本连续运行，无需真实 GitHub App |
| 质量门禁 | **通过** | `verify` 12 文件 / 251 单测 + lint + build + CSP；Playwright 整包 `npx playwright test` **147 passed**（chromium 67 + worker 56 + firefox 12 + webkit 12；worker 56 = 签名 19 / 沙箱（真实 Worker 10 + 独立 Origin 两源 1）11 / 设备 12 / OAuth 14）；`qa:sync` 20/20；`qa:plugins` 70/70；`qa:continuity` 45/45；`qa:devices` **31/31**；`qa:pairing-ttl` 真实等待 10 分钟 **12/12 通过**（elapsedMs=605004） |
| 生产验证 | **未执行（按门禁）** | Phase 1.6 备份告警未配置、事故未 Closed → 禁止生产写入与部署 |

**Phase 3 整体：`Partially Verified`。**

未完成 / 未验证项：

1. 生产部署与生产验证（本阶段明确不部署）。
2. 独立 Sandbox Origin：已有**真实浏览器两源隔离实测**（`tests/e2e/sandbox-origin.spec.ts`，宿主 8788 + 沙箱源 4399，1 passed）；同时实测发现 Cookie 的作用域是 host（换端口不隔离 Cookie），落地必须使用独立 host。生产域名/证书/Worker route **未创建**，生产隔离未验证。
3. 真实等待 10 分钟配对 TTL 已由 `npm run qa:pairing-ttl` 覆盖并通过 **12/12**（真实 `sleep`，实测 `elapsedMs=605004`；过期轮询/确认 410、重领 404、设备快照不变）；两台物理设备的人工冒烟仍未做。
4. 非 Chrome：Firefox 157 与 WebKit 27.2（Safari 家族引擎）均已安装，设备 12 项分别在 `--project=firefox-worker` / `--project=webkit-worker` 通过；真机 Safari / iOS、真实域名下的 CSP 与 Cookie `Secure` 行为仍未验证。
5. `qa:plugins` 70/70、`qa:continuity` 45/45、`qa:devices` **31/31** 已由自包含运行器跑通；旧的 `scripts/devices-qa.mjs` 仍需人工 `GDV_TOKEN`，仅作历史浏览器冒烟脚本。
6. 原两项已知缺陷已处理：`PAIRING_ATTEMPTS_EXCEEDED` 不可达分支已删除；撤销后 401 错误码已由 `guards.sessionFailure` / `requireActiveSession` 统一。
