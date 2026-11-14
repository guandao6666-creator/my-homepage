# Guandao OS 2.0 · 实施路线图（Phase 1–6）

**制定日期**：2026-11-05
**基线**：Guandao OS 2.0.0，生产 `3540542e-a45c-4802-b3cb-852d0627814a`
**依据**：`GUANDAO_2_0_AUDIT.md`（Phase 0 审计）
**原则**：不重写已验证模块；每个阶段都可独立发布、独立回滚；每阶段结束必须全绿。

> 阶段顺序不是按「功能看起来酷」排的，而是按**风险 × 依赖**排的：
> 先处理凭据与安全逻辑收敛（P0），再动最大的维护风险（Shell），最后才是生态与性能。
> 每阶段的前置条件不满足就不进入下一阶段。

---

## Phase 1 · 安全与数据基线（P0）

**周期估算**：3–5 天
**目标**：消除明文凭据、把散落的同源/body 校验收敛成一套、让 R2 孤儿可被发现、把「未知」变成「已核对」。

### 1.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 1.1 | 轮换 `.env` 中的 Supabase 凭据，确认前端是否仍依赖 `/sb`；若已不依赖，移除代理与 37 处引用 | `.env`（不提交）、`worker/index.js`、`src/pages/index.astro`、`supabase/*` | `/sb/*` 返回 404 或仍可用但有明确用途说明；`npm run typecheck` 0 error |
| 1.2 | 新增 `worker/api/guards.js`：统一 `assertSameOrigin(request, origin)`、`readJsonLimited(request, max)`、`requireSession` 包装；逐路由替换 8 份副本 | 新增 guards；`auth/files/devices/backups/privacy/community/plugins/sync` handlers | 所有 API smoke 通过；CSRF 用例（跨源 POST）返回 403；chunked 超大 body 返回 413 |
| 1.3 | R2 孤儿巡检：新增 `GET /api/admin/r2-audit`（仅管理员）与 `scripts/r2-audit.mjs`，对比 D1 引用与 R2 对象（只读） | 新增 `worker/api/admin/r2.js`（或 privacy 下 admin 路由）、`scripts/r2-audit.mjs` | 输出「引用数 / 桶对象数 / 孤儿候选」；不删除任何对象 |
| 1.4 | 复核未使用依赖并加 `check:unused`；实测 `@astrojs/markdown-remark` 是 Astro 7 配置必需，**保留** | `package.json`、`scripts/check-unused.mjs` | `npm ci && npm run verify` 通过；未使用依赖有明确证据才移除 |
| 1.5 | 增加最小工程护栏：`@astrojs/check`（或 `astro check`）与 ESLint（仅错误级），进 CI | `package.json`、`astro.config.mjs`、`.github/workflows/quality.yml`、`.eslintrc` | CI 通过；人为引入 1 个类型错误会被拦住 |

### 1.2 前置条件

- 确认 Supabase 是否仍承载线上社交数据（查 `supabase` 表与 `/sb` 访问日志）。
- 确认部署账号具备 Secrets 写入权限（本次已确认 wrangler 可部署）。
- 生产 D1 已有逻辑备份（2026-11-05 部署前导出）。

### 1.3 风险

| 风险 | 缓解 |
| --- | --- |
| 轮换凭据导致旧社交功能失效 | 先只加新凭据、双写验证，再撤销旧凭据 |
| 统一 guards 改变错误码 | 保留旧函数做对照测试；逐路由灰度 |
| 管理端 R2 巡检暴露对象键 | 只返回计数与哈希前缀，不返回完整 key |

### 1.4 验收标准

- `npm run verify` 全绿（版本/迁移/类型/单测/构建/CSP）。
- 新增 CSRF、超大 body、未登录三类 API 测试。
- 生产 `/api/health` 200，`/api/health` 响应头正常。
- 生产端到端 `npm run qa:prod` 35/35。
- 审计报告 §9 的「高」风险关闭或明确降级。

### 1.5 执行结果（2026-11-06）

| 任务 | 状态 | 结果 |
| --- | --- | --- |
| 1.1 凭据与 Supabase 审查 | **Verified（owner-confirmed）** | `SUPABASE_DB_PASSWORD` 已移除；publishable key 已部署验证；legacy keys 已由 owner 停用；未删 `/sb`、未删 `supabase/*.sql` |
| 1.2 Guards 统一 | **Verified** | `worker/api/guards.js` 单一实现；auth/files/devices/backups/privacy/community/plugins/sync 全部迁移；401/403/413/chunked 探针通过 |
| 1.3 R2 巡检 | **Verified** | 管理员只读接口 + CLI；生产实跑：0 引用、12 对象、0 缺失、12 孤儿候选（仅报告，未删除） |
| 1.4 依赖清理 | **Verified（结论修正）** | `@astrojs/markdown-remark` 是 Astro 7 配置必需，移除会导致 `astro check`/build 失败；已保留并加入 `check-unused` 白名单；`check:unused` 通过 |
| 1.5 工程护栏 | **Verified** | `astro check` 0 errors（246 文件）；ESLint 0 problems；CI 已加 `check:unused` / `check:astro` / `lint` |

**门禁**：`npm run verify` 全绿；E2E 24/24；`qa:sync` 20/20；`qa:prod` 35/35；生产 `/api/health` 200；部署 `a5161e28`。

**遗留**：
- anon key 轮换已完成（publishable 上线 + legacy 由 owner 停用；未做旧 key 401 复测）。
- 12 个 R2 孤儿候选待人工确认（禁止自动删除）。
- `astro check` 仍有 137 条 hint（历史隐式 any 提示，不影响错误级门禁）。
- 生产数据事件：见 [`docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md`](docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md)，状态 **Mitigated / Pending Investigation**。

### 1.6 生产数据事故调查（2026-11-06）

| 项 | 结果 |
| --- | --- |
| 事故 | 2026-11-06 发现 `users=0`（原 1/3/3），已用 D1 Time Travel 恢复 |
| 根因 | **未确认**；无删除审计、无注销事件；应用内删除路径已被证据排除 |
| 已排除 | 应用内注销、Cron 删除任务、auth 登出/注册回滚、sync QA、外键反向级联、Time Travel |
| 未排除 | 人工 D1 SQL/Dashboard、仓库外脚本、平台异常、凭据滥用 |
| 缺口 | Cloudflare Audit Logs 403；Worker 无持久日志；D1 无 SQL 审计 |
| 防护 | `scripts/lib/qa-cleanup.mjs`；prod-e2e 删除前复核；应用内注销加身份/审计/状态/行数约束 |
| 测试 | 11/11 清理护栏测试；`verify` / 24 E2E / 20 同步 QA 通过；**未跑 qa:prod、未改生产** |

**进入 Phase 2 的条件**：

1. 本阶段代码与测试已满足；
2. 但生产数据事件未闭环，建议先完成：Cloudflare Audit Logs 权限、D1 每日导出/写入告警、owner 确认无手工删除；
3. 未完成第 2 项前，允许做只读/本地 Phase 2 工作，**不允许**在生产重跑 `qa:prod` 或执行批量删除。

### 1.7 生产数据安全补强（2026-11-06）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Audit Logs 权限调查 | **Pending Manual Action** | 当前 OAuth 无 `audit_logs`；见 `docs/SECURITY-AUDIT-ACCESS.md` |
| D1 整库备份工具 | **Implemented / 本地验证** | backup/verify/list/restore-check；本地加密、篡改检测、隔离恢复通过 |
| 每日自动备份 | **未启用** | workflow 已准备；缺 3 个 GitHub Secrets；未上传 R2、未跑生产 |
| 数据异常监控 | **Implemented / 本地验证，未部署** | 0015 迁移 + Croc + 管理员接口；本地 scheduled 实跑通过 |
| 告警通知 | **未配置** | 仅写 D1；`DATA_ALERT_WEBHOOK` 未设置 |
| 安全事件日志 | **Implemented / 本地验证，未部署** | 新增事件类型与敏感字段过滤；49 项安全测试通过 |
| 生产变更 | **无** | 未部署、未应用迁移、未跑 qa:prod |

**Phase 2 前必须由所有者完成**：

1. Cloudflare Audit Logs 只读权限并导出事故窗口记录；
2. 配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_BACKUP_KEY` 并手动跑一次 `db-backup`；
3. 授权应用 `0015_data_monitor.sql` 并部署监控；
4. 决定是否配置 `DATA_ALERT_WEBHOOK`（未配置前不得声称告警已送达）。

### 1.8 生产数据保护 Phase 1.6（2026-11-07）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Workflow 备份 | **生产真实执行成功** | 5 steps complete；SQL 100,976 B |
| 每日调度 | **已启用（Worker Cron）** | `0 19 * * *`；绕过免费 plan 的 Workflows schedules 限制 |
| 独立 R2 Bucket | **已创建** | `guandao-db-backups`；未公开 |
| D1 REST Token | **已设置，export 可用** | GET/export 成功；权限列表未枚举 |
| 加密 + SHA-256 | **生产验证通过** | R2 回读 `sha256_match`；对象 100,992 B |
| 隔离恢复 | **生产备份隔离验证通过** | 63 表 / 16 迁移；`productionTouched:false` |
| 备份监控 | **已部署** | 26h stale / failed / unknown |
| 生产状态 | **备份成功** | 版本 `6928916f`；R2 对象 100,992 B；SHA match |
| 告警真实送达 | **已验证（真实外部 HTTPS）** | `npm run qa:alerts` 16/16；webhook.site 实收两种 payload，非 Mock |
| 生产告警配置 | **未配置** | Cloudflare 仍未设置 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK` |

**当前状态**：生产备份已成功，R2 回读与隔离恢复通过，告警**代码链路**已用真实外部 HTTPS 验通；
但 Cloudflare 上仍未配置接收端，生产故障不会真正外发，
因此整体保持 `Implemented / Partially Verified`，不能写成「生产告警已验证」。
剩余动作只需所有者提供一个渠道地址并授权部署，详见 `docs/architecture/DESKTOP-CSS.md` §10。

---

## Phase 2 · Shell 拆分与工程护栏（P1）

**周期估算**：1–2 周
**目标**：把 17,541 行的 `index.astro` 拆到「可以并行开发」的程度，但**不重写窗口系统**。

### 2.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 2.1 | 抽出全局样式：把 `<style is:global>` 中的桌面样式迁移到 `src/styles/desktop.css`，按「基础 → 组件 → 应用」分文件；保持加载顺序 | `src/pages/index.astro`、新增 `src/styles/desktop/*.css` | **结构**：迁入 `src/styles/desktop/` 且加载顺序不变；**语义**：规则顺序/媒体查询/动画不重排；**视觉**：生产截图与基线对比无差异。~~首屏 CSS ≤ 200 KB~~ → 移交 Phase 6.2（2026-11-07 所有者修订，见 2.1 验收口径修订） |
| 2.2 | 抽出独立应用脚本：把 1.x 内联的应用（终端/文章/关于/排行榜等）逐个迁到 `src/lib/legacy-apps/*.ts`，由 `registerApp` 注入 | `src/pages/index.astro`、新增 `legacy-apps/` | 每迁一个应用跑一次 `desktop.spec.ts`；最终 `index.astro` ≤ 12k 行 |
| 2.3 | 统一模板转义：把分散的 `escapeHtml` 收敛到 `src/lib/html.ts`，替换 3 份副本 | 新增 `html.ts`；`index.astro`、`os14/core.ts`、`mobile/ui.ts` | 单测覆盖 `<script>`、引号、`&`；生产控制台 0 错误 |
| 2.4 | 事件监听审计：为长生命周期监听加统一 `Scope`（已有 `quality/resources.ts`），接入未使用的 `installRootDisposal` 或在启动/销毁时调用 | `quality/resources.ts`、`os20/bridge.ts`、`index.astro` | 连续开关 20 次窗口，监听数不增长（Playwright 断言） |
| 2.5 | 补充 `community.ts` 拆分：发布表单、详情、列表、审核四块拆文件，保留原导出 API | `src/lib/os14/community.ts`、新增 `community/*.ts` | 社区页面手工回归；`tsc` 0 error |

### 2.1 执行结果（2026-11-06 实施 / 2026-11-07 复核）

| 项 | 结果 |
| --- | --- |
| 全局 CSS | 已拆到 `src/styles/desktop/`：18 个内容文件 + `index.css`；9,799 行连续迁移 |
| 语义等价 | 18 文件合计 **270,945 B**，与拆分前内联块字节完全相同 |
| `index.astro` | 17,566 → **7,766 行**（602,226 → 331,283 B） |
| 加载顺序 | 构建 `index.B_TNKWp7.css` hash/大小未变（273,238 B），仍是第 2 个 stylesheet |
| 视觉回归 | 19/21 逐像素完全一致；1 张通知红点（动态）；1 张单像素 Δ=3/255；147/147 boundingBox 一致；`dialog` 状态已恢复复采（diff=0） |
| 生产 UI 复测 | 通过：生产 10 个 CSS 资产与本机构建同名同字节；渲染检查 9/9（只读） |
| 自动化 | `verify` / 24 E2E / `qa:sync` 20/20 / `check:astro` / `lint` / `check:csp` 全部通过（2026-11-07 实跑） |
| 首屏 CSS | **476,749 B，仍超 200 KB**；仅桌面样式包本身 273,238 B，纯搬迁结构性不可达 → 该指标移交 **Phase 6.2** |
| 生产 | 已随 6928916f 上线；本阶段未部署、未改数据 |
| 结论 | **Verified**（结构 / 语义 / 视觉口径，见下方口径修订） |

### 2.1 验收口径修订（2026-11-07 · 所有者决定）

**背景**：原验收同时要求「视觉无差异」与「首屏 CSS ≤ 200 KB」。实测首屏 476,749 B；
仅桌面样式包本身就 273,238 B，**即使把其余 9 个页面级样式全部延迟加载仍超 200 KB**。
在「只搬不改」的约束下该指标结构性不可达，混在 2.1 会让阶段永远无法收口。

**决定（方案 A）**：把 2.1 的验收口径收敛为「结构 + 语义 + 视觉」，**200 KB 移交 Phase 6.2**。
显式记录，避免未达标数字被静默忽略：

| 项 | 修订前 | 修订后 |
| --- | --- | --- |
| 2.1 验收 | 视觉无差异 **且** 首屏 ≤ 200 KB | 结构 / 语义 / 视觉三项 |
| 首屏 ≤ 200 KB | Phase 2.1 | **Phase 6.2「CSS 拆分与按需加载」** |
| 当前实测 | — | 476,749 B（作为 Phase 6 的起点基线保留） |

> 这不是「把失败改成成功」：476,749 B 的事实、以及它未达标的原因与后续责任，
> 都写进了 `docs/architecture/DESKTOP-CSS.md` §9 与 Phase 6 的验收。
> 2.1 现在判 `Verified`，仅代表**这次 CSS 搬迁本身**达到它应有的标准。

> 本次复核**未修改任何产品代码**，只做验证、取证工具与文档；分支 `refactor/2.1-desktop-css-extraction`，
> 取证脚本与架构文档已提交 `a712d96`。
> 权威说明见 [`docs/architecture/DESKTOP-CSS.md`](docs/architecture/DESKTOP-CSS.md)。

### 2.2 执行结果（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 已迁移应用 | **5 个**：`posts`（文章）/ `about`（关于）/ `rank`（排行榜）/ `calc`（计算器）/ `viewer`（图片查看器） |
| 新模块 | `src/lib/legacy-apps/`：8 文件 / 470 行（含 `types.ts` 与共享上报 `leaderboard/report.ts`） |
| 接入方式 | 复用 `registerApp`；能力经 `LegacyAppContext` 显式注入，注册点位于 `renderDock()` 之前 |
| `index.astro` | 7,765 → **7,439 行**（迁移）→ **6,605 行**（清理死代码后；331,283 → 283,007 B） |
| 重复实现 | 排行榜上报由外壳与窗口共用一份（`RANK_NAME_KEY` 键名保持不变） |
| 回归 | E2E **36/36**（新增 12）；单测 **123/123**（新增 8）；`verify` 绿；`qa:sync` 20/20 |
| 未迁移 | 12 个应用仍读闭包：终端/设置为 10–12 项外壳依赖，树洞/议会/社会网络共享认证链路 |
| 死代码清理 | **已删除 831 行**：`notes`/`calendar`/`files`/`music` 旧实现被 os14 同名应用覆盖，不可达 |
| 结论 | **Partially Verified**：低耦合应用一类已完整迁移并验证；高耦合应用需先做外壳能力接口化 |

> 行数不是本阶段目标（`index.astro` 早已低于 12,000 行）。
> 判断标准是「迁出的应用不再依赖闭包」，而不是删掉多少行。
> 权威说明见 [`docs/architecture/LEGACY-APPLICATIONS.md`](docs/architecture/LEGACY-APPLICATIONS.md)。

### 2.3 执行结果（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 统一模块 | **`src/lib/html.ts`**：`escapeHtml` / `escapeAttr` / `safeUrl` / `isSafeUrl` |
| 迁移的重复实现 | **6 处**：`os14/core.ts`、`mobile/ui.ts`（escapeAttr）、`quality/errors.ts`（escapeAttr）、`index.astro`、`home.astro`、`notes.astro`（原审计只列了 3 处） |
| 保留例外 | **1 处**：`blog/index.astro`——`<script is:inline>` 不能用 ESM import，改模块脚本会改 CSP 哈希 |
| 别名处理 | `esc`（421 处调用）统一为 `escapeHtml` 的别名，不构成第二份实现 |
| 新能力 | **`safeUrl`**：协议白名单，拦截 `javascript:` / `vbscript:` / 控制字符拆解；此前全仓库**没有任何 URL 协议校验** |
| URL 应用范围 | 4 处第三方内容入口（插件主页、开发者网站、插件截图、插件图标） |
| 单元测试 | `tests/unit/html.test.ts` **40 项** |
| DOM 测试 | `tests/e2e/html-security.spec.ts` **11 项**（含「未转义会真的生成节点」的对照组） |
| 全量门禁 | `verify` 通过（163 单测 + 49 安全）；E2E **49/49**；`qa:sync` 20/20 |
| 未解决 | `href`/`src` 仍有 34 处动态插值、22 处直接赋值未做协议校验；268 处 `innerHTML` 未逐一审计 |
| 结论 | **Partially Verified**：转义已统一且双层测试通过；URL 校验只覆盖第三方入口，其余按风险登记 |

> 判断标准：转义统一 + 单元/DOM 双层测试是硬要求，已达成；
> 但「全仓库 URL 协议校验」不是本阶段能一次做完的，如实留在风险清单里。
> 权威说明见 [`docs/architecture/HTML-SECURITY.md`](docs/architecture/HTML-SECURITY.md)。

### 2.3.1 全量审计收尾（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 扫描方式 | TypeScript 编译器 API 做 AST 扫描（正则只用于属性文本匹配） |
| HTML sink | **268 处**（26 个文件插值 100% 已包装；26 个文件逐个复核，只落在数字/内部渲染/已校验常量） |
| 动态 URL 插值 | **42 处 → 0 处未处理**（社区封面头像 15、插件 3、对象 URL 7、内部路径 2、常量等） |
| 直接 URL 赋值 | **22 处**：全部为 `blob:` / 内部 API 路径 / 常量，属性赋值不经 HTML 解析 |
| 新增修复 | `pairing/page.ts` 与 `admin/index.astro` 各有一份**上一轮正则漏掉的** `escapeHtml` 副本 |
| 保留例外 | **1 处**：`blog/index.astro` 内联副本，已加 20 组输入的一致性测试 |
| 自动化 | 新增 `npm run check:html-security`（白名单每条必须写 reason，文件级条目带 count，新增 sink 会让检查失败），已接入 `verify` |
| 测试 | 单元 **47**；DOM **26**；全量 `verify` 170 单测 / E2E **64** / `qa:sync` 20/20 |
| 结论 | **Verified** |

> 数字全部来自本次真实扫描。上一轮报告的 34 处动态 URL 是行级正则的结果，
> 改 AST 后为 42 处；同时修掉了扫描器自身的两处误报。
> 权威说明见 [`docs/architecture/HTML-SECURITY.md`](docs/architecture/HTML-SECURITY.md) 附录。

### 2.4 执行结果（2026-11-07）

| 项 | 结果 |
| --- | --- |
| Scope | **复用** `src/lib/quality/resources.ts`，未新建第二套资源管理器；接口未改 |
| 修复缺陷 | **1 个**：`once: true` 监听器触发后计数与登记不回收（`on()` 包一层回收） |
| 新增测试 | Scope 契约 **19 项**（`tests/unit/resources.test.ts`） |
| 生命周期 E2E | 从 5 项计数扩展到 **7 项**（新增 observers / objectUrls），并加功能回归 |
| 20 次开关 | listeners 5→5、timeouts 1→1、intervals 1→1、rafs 0→0、scopes 7→7、observers 4→4、objectUrls 0→0 |
| 模块迁移 | **0 个**：审计显示基线干净，按「不为覆盖而强行迁移」原则不动现有归属 |
| `installRootDisposal` | **评估后不启用**：`pagehide` 与 BFCache 冲突，卸载时浏览器本就会回收 |
| 未交付 AST 门禁 | 不新增 `check-resource-lifecycle`：生命周期归属无法可靠静态判定，避免误报门禁 |
| 全量门禁 | `verify` **189 单测**；E2E **64**；`qa:sync` 20/20 |
| 结论 | **Verified**（监控盲区已在文档 §10 如实列出） |

> 权威说明见 [`docs/architecture/EVENT-LIFECYCLE.md`](docs/architecture/EVENT-LIFECYCLE.md)。

### 2.5 批次 1 执行结果（2026-11-07）

| 项 | 结果 |
| --- | --- |
| 原始规模 | `community.ts` **3,350 行 / 171,279 字节** |
| 公开导出 | **只有 2 个**：`renderCommunity`、`initCommunity` |
| 已拆出 | `community/{types,constants,ui}.ts`，合计 **252 行**（类型 / 常量 / 纯渲染工具） |
| `community.ts` 现在 | **3,163 行**（-187），作为兼容入口，导出面不变 |
| 兼容性 | 有测试锁定导出面 = `["initCommunity","renderCommunity"]` |
| 未完成 | `initCommunity` 内 **73 个函数**仍共享同一闭包（批次 2–4） |
| 全量门禁 | `verify` **195 单测**；E2E **64**；`qa:sync` 20/20 |
| 结论 | **Partially Verified** |

> 说明：本轮只完成零风险的纯逻辑层。剩余 73 个函数需要先抽 context 对象，
> 与 Phase 2.2 的 5 应用迁移同量级，留给专门批次。
> 详见 [`docs/architecture/COMMUNITY-ARCHITECTURE.md`](docs/architecture/COMMUNITY-ARCHITECTURE.md)。

### Phase 2 阶段判断（2026-11-07）

| 阶段 | 状态 |
| --- | --- |
| 2.1 Desktop CSS | Verified |
| 2.2 Legacy Applications | Partially Verified |
| 2.3 / 2.3.1 HTML Security | Verified |
| 2.4 Event Lifecycle | Verified |
| 2.5 Community | **Partially Verified**（批次 1/4） |

**Phase 2 整体：`Partially Verified`** —— 2.5 未完成，按验收标准不能标记 Verified，
因此**不进入 Phase 3**。

架构现状：`index.astro` 6,603 行；`community.ts` 3,163 行；CSS 已独立；
旧应用已迁出 `src/lib/legacy-apps/`；HTML 安全统一（291 处注入点全部登记）；
资源生命周期有 19 项契约测试 + 7 项计数基线。

任务 2.5 批次 2（列表/搜索迁移）尚未开始。

### 2.2 前置条件

- Phase 1 的 guards/CI 已完成（避免拆分中引入安全回归）。
- 截图基线：`.shots/os20-*.png` + 生产截图。
- Playwright 21 项可稳定跑。

### 2.3 风险

| 风险 | 缓解 |
| --- | --- |
| CSS 顺序变化导致视觉回归 | 只搬不改；每文件一次提交；截图 diff |
| 内联应用迁移破坏闭包 | 一次一个应用；先加包装函数再搬 |
| `index.astro` 行数下降但耦合未降 | 以「可独立测试」为完成标准，不以行数为唯一指标 |

### 2.4 验收标准

- `index.astro` ≤ 12,000 行（当前 7,766 行，CSS 部分已达标）。
- ~~CSS ≤ 200 KB 首屏~~ → **移交 Phase 6.2**（2026-11-07 所有者修订；当前实测 476,749 B 作为 Phase 6 起点基线）。
- 21 项 E2E + 生产 `qa:prod` 全绿。
- 构建 chunk 警告消失或降到 1 条以下（入口 ≤ 450 KB）。
- 新增 `npm run check:listeners`（可选）或单测覆盖 Scope。

---

## Phase 3 · 插件供应链与多设备验证（P2）

**周期估算**：1–2 周
**目标**：让第三方插件可信、让多设备从「代码存在」变成「已验证」。

### 3.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 3.1 | 发布者签名（Ed25519）：开发者中心生成密钥对，发布时签名包摘要；客户端安装/更新时验签 | `worker/api/developer/*`、`worker/api/plugins/*`、`plugins/bundle.ts`、CLI `publish` | 签名包可安装；篡改包被拒；旧包标记 `unsigned` 仍可安装（两阶段） |
| 3.2 | 独立沙箱域：把 `public/sandbox/*` 迁到独立 origin（或 Worker 路由），切断同源父页面引用 | `public/sandbox/**`、`worker/index.js`、`host.ts` | `sandbox.spec.ts` 通过；逃逸后无法读取宿主存储 |
| 3.3 | 双设备配对/接力自动化：用 Playwright 两个 context 模拟两台设备，跑 `pairing → approve → continuity` | 新增 `tests/e2e/device.spec.ts`、`scripts/continuity-qa.mjs`（复用） | 配对成功、接力 pending→delivered→opened、撤销后失效 |
| 3.4 | OAuth 可测化：提供 `AUTH_TEST_MODE`（仅本地/测试环境）或注入式 session 测试夹具，覆盖登录回调 | `worker/api/auth/*`、`scripts/prod-e2e.mjs` | CI 中可跑「回调 → Session → /me」；生产不开启 |

### 3.2 前置条件

- Phase 1 的 guards 已完成。
- 有可用的测试 GitHub OAuth App（或测试模式开关）。
- 两个独立浏览器 context 的 E2E 基础设施（已有 Playwright）。

### 3.3 风险

| 风险 | 缓解 |
| --- | --- |
| 签名导致旧插件全部失效 | 「可选验签 → 强制验签」两阶段；保留 `unsigned` 白名单 |
| 独立域增加部署复杂度 | 先同域子路径 + CSP 隔离，再评估独立域 |
| 测试 Session 泄漏到生产 | 环境变量硬开关 + 生产构建剔除代码路径 |

### 3.4 验收标准

- 插件签名/验签单测 + 篡改包 E2E。
- 双设备 E2E 至少 6 项（配对、批准、接力、剪贴板、撤销、过期）。
- OAuth 回调测试在 CI 中可重复运行。
- 生产 `qa:prod` 扩展到覆盖配对/接力。

### 3.5 执行结果（2026-11-08 收尾更新）

> 前置状态说明：Phase 2 整体仍为 `Partially Verified`（2.2 Legacy、2.5 Community 未完成），
> 本路线图此前的结论是「不进入 Phase 3」。本次是**所有者直接指派 Phase 3**；
> Phase 2 的状态不因本阶段工作而变化，也没有在本阶段里顺手修改 Phase 2 的代码。

| 项 | 结果 |
| --- | --- |
| 3.1 发布者签名 | **Verified（本地层）**。`shared/plugin-signature.js` 519 行：签名信封 + 规范载荷（信封去 `sig` 后 `canonicalJson` 的 UTF-8 字节；字段缺失即非法；v1 只允许字符串 / 非负整数 / 布尔），Ed25519 走 WebCrypto（**未新增任何依赖**）。迁移 `0017_plugin_signatures.sql`（`publisher_keys` + `plugin_versions` 4 列）。服务端 `resolveSignature` 在**落库前**拦截非法签名（422），`pluginPackage` 每次下载动态复验；客户端 `verifyPackageSignature` 接入 4 条下载路径；CLI `keygen` / `sign` / `keys register`；市场列表与详情页信任徽标 |
| 3.2 沙箱隔离 | **Verified（本地层）**。未改 `host.ts` / `runner.html` / `worker/index.js`，**未新增任何 `allow-*`**；新增 `tests/e2e/sandbox-worker.spec.ts` 10 项（真实 Worker + 真实 CSP 响应头）、`tests/e2e/sandbox-origin.spec.ts` 1 项（本地真实两源隔离实测：8788 宿主 + 4399 沙箱源，证明 `window.origin`、localStorage、DOM、CORS、postMessage 的隔离语义；同时实测发现 Cookie 作用域是 host，换端口不隔离，落地需独立 host），`tests/e2e/sandbox.spec.ts` 3 → 6 项 |
| 3.3 双浏览器设备 | **Verified（本地层）**。`tests/e2e/device.spec.ts` **12 项**：A / A2 / B / C / outsider / crowded **六个独立 `browser.newContext()`**，覆盖配对、批准（含 `WRONG_DEVICE`、`DEVICE_LIMIT`）、完整领取 Session、**真实过去时间戳的过期拒绝**、claim 同源校验与 `INVALID_TOKEN`、接力 `pending → delivered → opened → completed`、错误码、剪贴板隔离、撤销（五路径统一 `SESSION_REVOKED` / `DEVICE_REVOKED`）；连续两轮全绿且中间不重启服务；同一 spec 另在 **Firefox 157** 与 **WebKit 27.2** 各通过 12 项 |
| 3.4 OAuth 可测化 | **Verified（本地层）**。`AUTH_TEST_MODE=1` 为三条件 AND（env + 请求 origin loopback + 配置 origin loopback）；测试身份只来自固定 `qa-*` 档案；state / PKCE 校验零改动；`tests/e2e/oauth.spec.ts` 14 项 |
| 全量门禁 | `npm run verify` 通过（**12 文件 / 251 单测**，含 `check:html-security`、`check:csp` 12 哈希 / 30 HTML）；`npx playwright test` 整包一次运行 **147 passed**（chromium 67 + worker 56 + firefox 12 + webkit 12；worker = 签名 19 / 沙箱 11 / 设备 12 / OAuth 14）；`npm run qa:sync` **20/20**；`npm run qa:plugins` **70/70**、`npm run qa:continuity` **45/45**、`npm run qa:devices` **31/31**（自包含 seed + 本地 Worker）、`npm run qa:pairing-ttl` 真实等待 10 分钟 **12/12**（`elapsedMs=605004`） |
| 修掉的真实缺陷 | ① `POST /api/pairing/claim` 缺同源校验（第三方页面可替用户提交 claim）② `POST /api/continuity/:id/open` 的 `openedAt` 恒为 null ③ `mapSignatureTrust` 从错误模块导入导致 Worker 构建失败（`tsc` 不检查 `.js`，只有真实构建能发现）④ CLI `sign` 产物写到 CWD 而非项目根、且未回填 `filesDigest` ⑤ `ApiError` 无法携带结构化原因（新增第 4 参数 `details`）⑥ 插件管理器「已安装」标签页有本地记录时不渲染列表（`listView()` 缺分支），已补分支并显示签名信任 ⑦ `continuity/handlers.js` 剪贴板分支调用未导入的 `requireSession`（运行时 ReferenceError）⑧ 撤销后 401 错误码不一致（新增 `guards.sessionFailure` / `requireActiveSession` 统一）⑨ `PAIRING_ATTEMPTS_EXCEEDED` 不可达分支（attempts 永不累加）已删除假保护 ⑩ E2E 就绪竞态：Playwright 就绪探针改到 8789 `GET /__e2e/ready`，避免测试与夹具写入抢本地 D1 |
| 已知未修 | 无新增。原两项（ATTEMPTS、401 错误码）已在本轮处理 |
| 未验证 | 生产环境与真实域名、真机 Safari/iOS（WebKit 引擎已本地通过，≠ 真机）、两台物理设备人工冒烟、独立 Sandbox Origin 的生产部署（本地已两源实测，但域名/证书/Worker route 未创建）、`network.fetch` 之外的服务端 Broker 复核、资源滥用（死循环 / postMessage 洪泛） |
| 生产变更 | **无**。未部署、未改生产数据、未跑 `qa:prod` |
| 结论 | **Partially Verified**（本地 / 隔离环境全部通过；生产验证按 Phase 1.6 门禁未执行） |

补充两点，避免把「脚本存在」当成「已验证」：

- `qa:plugins` / `qa:continuity` 已改为**自包含**：`scripts/seed-qa-local.mjs` 写本地 D1 的固定 QA 账号/设备/Session，
  `scripts/qa-local-run.mjs` 起本地 Worker（8794）后运行脚本并自动关进程。实测 `qa:plugins` 70/70、
  `qa:continuity` 45/45，只连 loopback。
- 任务书提到的 `qa:devices` 已补齐：新增 `scripts/devices-api-qa.mjs`（31 项：设备总览/当前设备/详情/会话/活动/心跳/CSRF/未登录/跨账号/会话撤销/设备撤销），由 `scripts/qa-local-run.mjs` 自包含驱动，实测 **31/31 通过**；`scripts/devices-qa.mjs` 仍是需要人工 `GDV_TOKEN` 的旧浏览器冒烟脚本。
  真实双设备覆盖由 worker project 的 `device.spec.ts`（12 项，Chrome + Firefox + WebKit）承担。
- CI 门禁已同步：`.github/workflows/quality.yml` 的 E2E job 增加 `npx playwright install --with-deps firefox webkit`，四个 project 全部在 CI 执行；e2e-server 自行迁移本地 D1 并生成夹具。2026-11-09 已推送 `ci/phase3-verify` 并通过 PR 触发 quality workflow（run `42564445648`）：三 job 全 success，E2E **147 passed**（四 project 与本地一致）；首次实跑修复了 `backups/` 误忽略源码与 typecheck 缺 `astro sync` 两个问题（`559adf5`）。

### Phase 3 阶段判断（2026-11-09 所有者确认分层口径）

| 阶段 | 状态 |
| --- | --- |
| 3.1 插件发布者签名 | Verified（本地 / CI） |
| 3.2 沙箱隔离 | Verified（本地 / CI）；独立 Origin 生产部署 Blocked（资源未创建） |
| 3.3 双浏览器设备 | Verified（本地 / CI，Chrome + Firefox + WebKit） |
| 3.4 OAuth 可测化 | Verified（本地 / CI）；生产环境实跑未执行 |

**Phase 3：`Accepted (Local/CI)`，生产层 `Blocked`。** 全部自动化验收项在本地 / 隔离环境
与 GitHub Actions 有真实执行证据，视为代码层验收通过；生产部署与生产验证仍按 Phase 1.6
门禁未执行（备份告警未配置、2026-11-06 事故为 `Mitigated / Pending Investigation`），
物理设备冒烟与真机 Safari/iOS 未做。**不标记「全部通过」；Phase 4 是否启动由所有者另行决定。**

处置记录：PR #1（`ci/phase3-verify` → `main`）仅用于触发 CI，验证后已关闭、未合并；
`main` 仍为 `e8603f7`。Phase 2 的 2.2 / 2.5 遗留作为独立项跟踪，不阻塞 Phase 4。

---

## Phase 4 · 同步范围扩展与冲突策略（P3）

**周期估算**：1 周
**目标**：把 Workspace/Preferences 接入同步；把「服务端优先」变成用户可理解的冲突策略。

> 状态：**已实施（2026-11-09）**，本地 / 隔离环境验证通过；生产未部署、未迁移。
> 所有者已明确指派 Phase 4；Phase 3 的分层口径（`Accepted (Local/CI)`，生产层 `Blocked`）保持不变，
> 其双设备 / 同步测试基建（`device.spec.ts`、`qa:devices`、e2e-server fixtures）已复用。

### 4.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 4.1 | 新增 `workspace` 同步域：工作空间快照作为实体（id=workspaceId），复用 `sync_entities` | `worker/api/sync/store.js`（domain 白名单）、`src/lib/sync/providers.ts`、`os14/workspace*` | 两台设备同步工作空间；删除传播 |
| 4.2 | 新增 `preferences` 同步域：只同步白名单字段（主题、Dock、时钟），不含设备相关设置 | 同上、`core/settings.ts` | 冲突时保留本地设备设置 |
| 4.3 | 冲突可视化：System Center 显示「最近冲突」，提供「保留本地 / 保留云端」 | `os20/apps/systemcenter.ts`、`core/sync.ts` | 冲突可选择；选择后清墓碑/更新 revision |
| 4.4 | 同步配额与清理：单用户实体上限、墓碑 TTL | `worker/api/sync/store.js`、Cron | 超过上限返回 409；墓碑 90 天后清理 |

### 4.2 前置条件

- Phase 3 完成（同步/设备测试基建可复用）。
- 产品确认冲突策略（默认服务端优先，允许逐条覆盖）。

### 4.3 风险

| 风险 | 缓解 |
| --- | --- |
| 工作空间快照体积大 | 只同步语义（应用/窗口/空间），不同步坐标像素；限制 128 KB |
| 偏好同步覆盖设备差异 | 字段白名单 + 设备级覆盖 |
| 墓碑无限增长 | TTL + 定期清理 |

### 4.4 验收标准

- 两个新域的 `sync-qa` 用例（推送/拉取/墓碑/冲突）。
- 双设备 E2E 覆盖工作空间同步。
- 生产 `qa:prod` 扩展并通过。

### 4.5 执行结果（2026-11-09）

| 项 | 结果 |
| --- | --- |
| 4.1 Workspace 同步域 | **Verified（本地）**。`src/lib/sync/workspace.ts` 只同步 `preset:false` 的自定义工作空间；payload 含名称/主题/壁纸/组件/Dock/快捷方式/窗口几何/`viewport`，JSON ≤128KB，id/数组/窗口数量均限长；跨端应用时用 `layout.normalizeSnapshot` + `rescaleSnapshot`（`cascade:false`）按当前视口重算，不重写 Window Manager；删除用 known-id 追踪合成墓碑，同 id 重建可撤销删除；服务端复用 `sync_entities`（`domain=workspace`），修订冲突由乐观锁裁决 |
| 4.2 Preferences 同步域 | **Verified（本地）**。`src/lib/sync/preferences.ts` 严格 **13 项白名单**（appearance.mode/material/radius/accent/animations、desktop.iconLabels/clockSeconds/dock.autohide/dock.position/widgets.opacity、notifications.dnd/volume、system.updateChannel）；显式排除 `system.mode`、`system.diagnosticsRetention` 与全部设备级信息；payload ≤32KB；未知键/非法值拒绝写入；应用走既有 SettingsManager 与 `settings:change`；首次同步本地 updatedAt=0 让云端赢 |
| 4.3 冲突可视化 | **Verified（本地）**。`src/lib/sync/conflicts.ts`：最多 50 条、TTL 7 天、按 `${domain}:${entityId}` 去重、受控快照 ≤4KB/边且脱敏、仅本地不上传；System Center 云端设置新增「最近同步冲突」（数量/域/时间/本地与云端 revision/保留本地/保留云端/清理已解决）与配额 KPI；保留本地 = 以 serverRevision 为 base 重推（乐观锁不关，期间再变化返回 `changed` 并保持 open）；保留云端 = pull→apply→写 revision→标记解决；重复调用 noop 幂等 |
| 4.4 配额与墓碑 | **Verified（本地）**。`migrations/0018_sync_cloud_expansion.sql` 重建 5 域 `sync_entities`（新增 `deleted_at`，旧表保留为 `sync_entities_legacy_v1`）；新增 `sync_tombstone_ledger`（防复活）与 `sync_cleanup_log`；上限：单用户实体 5000 / 墓碑 2000 / workspace 128KB / preferences 32KB；超限 409 `QUOTA_EXCEEDED`，不静默删数据；墓碑 90 天 TTL，`*/15` Cron 分批清理（200/批、2000/次、幂等、写审计、失败不影响其他任务）；旧设备用旧 `baseRevision` 重推被台账判为 deleted 冲突，不复活 |
| 全量门禁 | `npm run verify` 通过（**18 文件 / 331 单测**；typecheck、security:test 六组、`check:unused` 18、`check:astro` 0 errors/0 warnings/149 hints、`check:html-security` 291 处全审查、lint、build 29 pages、CSP 12 哈希/30 HTML、migrations **18 文件 / 117 索引**）；`npx playwright test` 整包 **155 passed**（chromium 67 + worker 64 + firefox 12 + webkit 12；worker 64 = 签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / **同步 8**）；`npm run qa:sync` **45/45**（含 `--test-scheduled` 触发清理、配额 5000→409、preferences 40KB→400、防复活）；`npm run qa:devices` 回归 **31/31**；GitHub Actions quality 全绿（run 42965051693，commit 04cf8f8：verify + API smoke 含 qa:sync 45 项 + E2E 155 passed / 4.5m） |
| 修掉的真实缺陷 | 本阶段未发现既有 Notes/Tasks/Calendar 同步逻辑的阻断性缺陷；实现中处理了两个结构性约束：① SQLite 不能修改 CHECK 约束 → 0018 用「改名保留 + 新建 + 复制」扩展域并保留回滚路径；② D1 的 IN 参数上限 → 批量查询分块（≤100/批）。E2E 首个失败是测试对 `/api/auth/me` 响应形状的假设错误（该接口无 `{success,data}` 信封），已按真实契约修正，未改产品代码 |
| 已知未修 / 未验证 | 生产 D1 迁移与生产双设备验证（Phase 1.6 门禁未执行）；页面级 `GOS20.syncConflicts/syncResolveConflict` 的浏览器 E2E（dist 为旧构建，本轮由 `tests/unit/sync-conflicts.test.ts` 直接覆盖状态机）；5000 活实体 / 2000 墓碑的 409 E2E 造数（由 `qa:sync` 覆盖）；两条物理设备人工冒烟 |
| 生产变更 | **无**。未部署、未应用生产迁移、未跑 `qa:prod` |
| 结论 | **Partially Verified**（本地 / 隔离层全部通过；生产层按 Phase 1.6 门禁 `Blocked`） |

---

## Phase 5 · 社区与市场发布链（P4）

**周期估算**：1 周
**目标**：把社区/市场从「代码实现」推进到「真实发布过一次」。

### 5.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 5.1 | 发布链 E2E：草稿 → 上传包 → 提交审核 → 管理员通过 → 公开列表 → 安装 | `worker/api/community/*`、`worker/api/plugins/*`、`scripts/community-qa.mjs` | 全链路通过；计数、版本、审核状态正确 |
| 5.2 | 教程模型：新增 `community_tutorials` 或复用 posts + `kind=tutorial` | `migrations/0015_*.sql`、`community/*` | 教程可发布/浏览；不破坏现有 posts |
| 5.3 | 审核后台补测：举报 → 处理 → 下架 → 审计 | `community/admin.js`、`admin/index.astro` | 管理员操作有审计；非管理员 403 |

### 5.2 前置条件

- Phase 1 的 guards；测试账号具备管理员/审核员角色。
- 有测试内容包（小体积）。

### 5.3 风险

| 风险 | 缓解 |
| --- | --- |
| 测试数据污染生产 | 使用 `qa-*` 账号 + 结束后清理（已有 `prod-e2e` 模式） |
| 新表迁移 | 仅新增；先本地 D1 验证再 remote |

### 5.4 验收标准

- 社区/市场发布链 E2E 通过，测试数据清理为 0。
- 教程功能可用且不影响旧帖子。
- 审核操作有审计记录。

### 5.5 执行结果（2026-11-11）

| 项 | 结果 |
| --- | --- |
| 5.1 发布链 E2E | **Verified（本地 / 隔离）**。`scripts/community-qa.mjs` 重写为自包含 14 段、260 项断言 + 31 项清理断言；`npm run qa:community` 连续三次 **260/260**（47.5s / 47.6s / 48.0s，RUN_ID `mwbpn6qw` / `mwbpodbb` / `mwbpwgmk`）；覆盖上传安全（PNG 201、SVG 415、9MB 413、失败无孤儿）、内容包负例、草稿仅作者可见、成员提交 `pending_review`、管理员与 moderator 审核闭环、公开 feed/search/详情、下载与浏览计数分离、版本链、互动/通知、举报、审计、设置/stats/邀请权限、清理 |
| 5.2 教程模型 | **Verified（本地）**。审计确认 `community_posts.post_type` 已含 `tutorial`、`community_packages.package_type` 已含 `tutorial` → 复用现有帖子模型，**不新增表/迁移**；`validate.js` 分类 `guide/tip/workflow/other`、正文 ≤20000；前端已有编辑器/详情/标签/计数。修复真实缺陷：`loadDetail` 曾把 tutorial 排除在拉包之外，导致正文永不渲染；新增单测 20、E2E 2 项（双 Context 全链） |
| 5.3 审核与举报 | **Verified（本地）**。举报创建 201 / 重复 409 / 队列 dismiss / hide_post / delete_post；审核 approve / reject / hide / restore / delete；审计 `community_audit_logs` 断言 action + targetId；普通用户 403、未登录 401、下架后公开 404、重复审批 409；下架与物理删除分离，未删除 R2 |
| 插件发布闭环 | **Verified（API 级）/ Partially Verified（页面级）**。`npm run qa:plugins` 扩至 **107/107 ×2**（新增 37 项：签名 verified → submit → 审核 → 市场 → 下载复算 SHA-256 → 安装 → takedown → 审计）；`tests/e2e/plugin-publishing.spec.ts` 1 passed ×2；页面级 UnifiedInstaller 由本地证据脚本真实执行 20/20 + 截图，未并入 Playwright |
| 全量门禁 | `npm run verify` 通过（**19 文件 / 351 单测**；lint、build 29 pages、CSP 12 哈希/30 HTML、migrations 18/117、html-security 291 处全审查）；`npx playwright test` 整包 **158 passed**（chromium 67 + worker 67 + firefox 12 + webkit 12；worker 67 = 签名 19 / 沙箱 11 / 设备 12 / OAuth 14 / 同步 8 / 教程 2 / 插件发布链 1）；`npm run qa:sync` **45/45**；`npm run qa:community` **260/260** |
| 修掉的真实缺陷 | ① 教程详情正文不渲染（`src/lib/os14/community.ts` 的 `loadDetail` 条件错误）；② Phase 5 未发现 Worker 侧新的安全缺陷；QA 脚本自身修了 CSRF 断言、清理 admin 资产漏删、D1 并发瞬时错误重试、草稿非作者应为 404 等测试问题 |
| 已知未修 / 未验证 | 生产发布链与生产 D1/R2 未执行（Phase 1.6 门禁）；页面级插件安装未并入 Playwright；教程无页面级浏览器断言；`follow` 正向链路在新库 SKIP；物理设备人工冒烟未做 |
| 生产变更 | **无**。未部署、未应用生产迁移、未跑 `qa:prod` |
| 结论 | **Partially Verified**（本地 / 隔离层全部通过；生产发布链按 Phase 1.6 门禁 `Blocked`） |

---

## Phase 6 · 性能与可观测（P5）

**周期估算**：3–5 天
**目标**：入口 JS ≤ 450 KB、首屏 CSS ≤ 200 KB、诊断中心展示真实 LCP/CLS/INP。

### 6.1 任务清单

| # | 任务 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 6.1 | 入口拆包：把 19 个旧应用从入口 chunk 拆出（动态 import + `registerApp` 时加载） | `index.astro`、`os14/index.ts` | 入口 chunk ≤ 450 KB；首屏可用；应用按需加载 |
| 6.2 | CSS 拆分与按需加载 | `src/styles/desktop/*.css` | 首屏 CSS ≤ 200 KB（起点基线 **476,749 B**，2026-11-07 由 Phase 2.1 移交；桌面样式包本身 273,238 B，必须先做「非首屏样式延迟加载」才能逼近） |
| 6.3 | 诊断中心接入 LCP/CLS/INP（`PerformanceObserver`，仅本地采集） | `quality/diagnostics.ts`、`os20/apps/systemcenter.ts` | 显示真实数值；无数据时显示「未采集」 |
| 6.4 | 生产性能基线进入发布报告 | `scripts/prod-e2e.mjs`、`docs/RELEASE-2.0.md` | 每次发布记录 DCL/load/资源体积 |

### 6.2 前置条件

- Phase 2 的 CSS/应用拆分完成。
- 性能预算与验收口径确认。

### 6.3 风险

| 风险 | 缓解 |
| --- | --- |
| 拆包导致应用首次打开变慢 | 保留预取提示；按需加载已有 1.9 机制 |
| 指标采集影响性能 | 仅采样、仅本地、默认关闭上报 |

### 6.4 验收标准

- 入口 chunk ≤ 450 KB，首屏 CSS ≤ 200 KB。
- 生产 DCL ≤ 1s（本地缓存命中时）。
- 诊断中心展示真实指标，不伪造。

---

## 阶段依赖图

```
Phase 1（安全/数据）
   ├─► Phase 2（Shell 拆分） ─► Phase 6（性能）
   ├─► Phase 3（插件/多设备） ─► Phase 4（同步扩展）
   └─► Phase 5（社区/市场）
```

- Phase 2、3、5 可在 Phase 1 完成后并行（不同文件域）。
- Phase 4 依赖 Phase 3 的设备测试基建。
- Phase 6 依赖 Phase 2 的拆分结果。

---

## 每阶段的固定门禁

无论哪个阶段，合并前必须：

```bash
npm run verify      # 版本 + 迁移 + 类型 + 115 单测 + 构建 + CSP
npx playwright test # 21 E2E
npm run qa:sync     # 20 项同步 API
npm run qa:prod     # 35 项生产端到端（发布后）
```

并且：

1. 不新增生产数据（测试账号用 `qa-*`，结束后清理）。
2. 不删除表、不做破坏性迁移。
3. 不把「实现」写成「已验证」。
4. 每个阶段结束更新 `docs/RELEASE-2.0.md` 与 `docs/ACCEPTANCE-2.0.md`。

---

## 明确不做（避免过度设计）

- 不重写窗口系统、不重写 Core。
- 不为 Notes/Tasks/Calendar 增加 Repository 抽象层。
- 不把 Supabase 存量社交强行并入 D1（除非确认仍在使用且有预算）。
- 不追求「更多应用」；优先修复架构与安全。
- 不做没有测试的「大版本重构」。