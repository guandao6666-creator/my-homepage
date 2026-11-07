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

任务 2.4（事件监听器生命周期治理）尚未开始。

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

---

## Phase 4 · 同步范围扩展与冲突策略（P3）

**周期估算**：1 周
**目标**：把 Workspace/Preferences 接入同步；把「服务端优先」变成用户可理解的冲突策略。

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