# AI-BUILD-STATUS · Guandao OS 当前状态

> 本文件只记录**当前事实**，不复制历史细节。
> 历史细节见 `GUANDAO_2_0_AUDIT.md`（附录 A–P）、`GUANDAO_2_0_ROADMAP.md`、`docs/RELEASE-2.0.md`。
> 每轮开发结束必须更新本文件；`Implemented` 不得写成 `Verified`。

- **更新时间**：2026-11-20
- **版本**：2.0.1（Steady Clicks，补丁版本；发布说明 `docs/RELEASE-2.0.1.md`）
- **分支**：`dsh-da37e99c-1ac8`
- **当前里程碑**：Milestone A（系统基础成熟）收尾 → Milestone D（性能与稳定性）起步
- **当前阶段**：Phase 6（性能与可观测），P2

## 1. 阶段状态总览

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 1 · 安全与数据基线 | `Verified`（本地/CI） | 生产门禁按 1.6 规则 `Blocked` |
| Phase 2 · Shell 拆分与工程护栏 | `Verified`（本地/CI） | 2.1–2.5 全部完成（附录 P / RELEASE §16.19） |
| Phase 3 · 插件供应链与多设备 | `Verified`（本地/CI） | 签名 / 沙箱 / OAuth / 设备 |
| Phase 4 · 同步与冲突策略 | `Verified`（本地/CI） | `qa:sync` 45/45 |
| Phase 5 · 社区与市场发布链 | `Partially Verified` | 本地 260/260；生产发布链 `Blocked` |
| Phase 6 · 性能与可观测 | **进行中（6.1 部分完成）** | 见 §3 |

## 2. 当前质量基线（2026-11-20 本机实跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error（362 文件） |
| `npx vitest run` | **21 文件 / 375 单测通过**（2.0.1 新增 3 项分页判定） |
| `npm run security:test` | 六组自检全过 |
| `npm run check:unused` / `check:astro` / `check:html-security` / `lint` | 通过（html-security 294 处全审查、0 未审查） |
| `npm run build` | exit 0，29 页；CSP 12 哈希 / 30 HTML 一致；HTML 安全 294 处全审查、0 未审查 |
| 产物体积（`node scripts/perf-baseline.mjs --json`） | 入口 JS **433.4 KB / 439.5 KB**；首屏 CSS **184.7 KB / 195.3 KB**；两项预算均通过 |
| `npm run verify` | **exit 0**（版本一致性 → 迁移 → typecheck → 单测 → 安全 → unused → astro → html-security → lint → build → csp） |
| `npx playwright test`（`E2E_ADMIN_PORT=18789`） | 见 §4（本轮全量结果） |

> 环境注意：本机 WorkBuddy 沙箱的 safe-delete 守卫会在 Astro 清理 `dist/.prerender` 时中断进程（exit 1），
> 属环境问题而非代码失败。规避方式：构建前 `mv dist/.prerender /tmp/...`。

## 3. 正在执行的目标（Phase 6）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 6.1 入口 JS ≤ 450 KB | **`Verified`（本地）**：525,102 B → **442,621 B**（−82,481 B / −15.7%），应用中心改 `load()` 后达标 | `manifest.ts`、`os14/appcenter/app.ts`；`LEGACY-APPLICATIONS.md` §9.1 |
| 6.2 首屏 CSS ≤ 200 KB | **`Verified`（本地）**：首页 **185,110 B / 2 个样式表**（自 476,749 B 降 61.2%）。主题中心改懒加载后 `themes.css` 也移出首屏 | `lazy-css.ts`、`themes/app.ts`、`docs/PERF-BASELINE.md` |
| 6.3 诊断中心接入真实 LCP/CLS/INP | **`Verified`（本地）**：新增「指标」分区，`observeVitals`（buffered）在本机采集，无数据显示「未采集」、不支持显示「不支持」 | `src/lib/quality/diagnostics.ts`、`tests/e2e/desktop.spec.ts` |
| 6.4 生产性能基线进发布报告 | `Not Started` | `scripts/prod-e2e.mjs` |

### 3.1 入口包剩余体积归因（sourcemap 实测，2026-11-18）

入口 chunk 生成字符 445,777：

| 模块 | 占比 | 是否启动必需 |
| --- | ---: | --- |
| `index.astro` 内联脚本（外壳/设置面板） | 15.8% | 是（settings 未迁移） |
| `os13.ts`（1.3 桌面层闭包，2,397 行） | 10.4% | 是，且紧耦合，暂不硬拆 |
| `os14/widgetstore.ts` | 6.6% | 组件规格启动必需；画廊可拆 |
| `os14/catalog.ts` | 4.5% | `META_BY_ID` 启动必需 |
| `plugins/host.ts` + `registry.ts` | 7.7% | 是（安全关键，不动） |
| `account/client.ts` | 3.3% | 是 |

结论：在不重写窗口系统、不硬拆 `os13` 闭包的前提下，6.1 的可行剩余空间约 15–25 KB
（appcenter/workspaces 的 app UI 走 `load()`、widgetstore 画廊拆分）。
要达到 450 KB 需同时处理 6.2 或引入 Settings Service。

## 4. 本轮验证结果

| 项 | 结果 |
| --- | --- |
| 目标 spec（`community-search-open`，worker project） | **2 passed（17.1s）**；把 `pickPageButton` 改回裸选择器后 `1 failed / 1 passed`（负向对照，见 RELEASE-2.0.1 §3.1） |
| 目标 spec（`legacy-apps` 抽奖/议会/社交 + `mobile` 笔记） | 逐条复跑 **4 passed**（修掉 2.0.0 遗留的旧断言，见 RELEASE-2.0.1 §3.3） |
| 全量 E2E | **184 passed（4.4m），exit 0**——chromium 88 + worker 72 + firefox-worker 12 + webkit-worker 12 |
| 单测 | **21 文件 / 375 通过**（新增 `pickPageButton` 3 项） |

## 5. 重大风险（未关闭）

1. **生产层全部 `Blocked`**：未部署、未应用生产迁移、未跑 `qa:prod`（Phase 1.6 门禁，需所有者授权）。
2. **社区发布链仅本地验证**：生产 D1/R2 未执行，管理员审核链未在生产验证。
3. **`os13.ts` 巨型闭包**（2,397 行）：壁纸/图标/Dock/控制中心/设置面板共用一份 cfg，
   是入口体积与可维护性的主要结构性债务，需 Core Settings API 才能干净拆分。
4. **页面级插件安装**未并入 Playwright（仅本地证据脚本）。
5. 本地并发跑 Playwright 与 verify 会共享 `.wrangler/state` 本地 D1，互相干扰。
6. **CSP 哈希与 dist 必须一起更新**：改动内联脚本后 `wrangler/api/csp-hashes.js` 会变；
   若只重建 dist 却回滚该文件，页面会被 CSP 拦掉、`window.GOS20` 不出现，E2E 大面积超时
   （2026-11-18 复现两次）。
7. 仓库中的 `src/**` 存在 CRLF/LF 抖动：构建/格式化后会显示为已修改，`git checkout` 即恢复，
   不要误提交。
8. **本地 E2E 会被自己的限流卡住**（2.0.1 期间反复踩到）：`plugin-upload` 规则 20 次/小时，
   e2e-server 造夹具每轮就要上传约 20 个签名包，同一小时内连跑两三遍全量就会
   `429 RATE_LIMITED`，且 `wrangler d1 execute --local` 在本机因
   `miniflare-email-store` 目录权限起不来，只能用 Node 26 的 `node:sqlite` 直连
   `.wrangler/state/v3/d1/**/*.sqlite` 清 `rate_limits`。连跑前先清计数器，否则报错会被
   误读成产品回归。
9. `sandbox-origin.spec.ts` 在全量并发下有偶发失败（2 次全量中 1 次 `origin !== "null"`），
   单独复跑稳定通过；已记录为抖动，未修改断言。

## 6. 下一步（按优先级）

1. **P2 · 6.3**：诊断中心接入真实 LCP/CLS/INP（页面级采集一次、写入本地快照、无数据显示「未采集」）——独立性最好、可验收。
2. **P2 · 6.1 收尾**：appcenter / workspaces 的 app UI 改 `load()`；widgetstore 画廊拆分；目标再降 12–20 KB。
3. **P2 · 6.2**：首屏 CSS 审计（273 KB → 200 KB），先产出「规则 → 出现时机」清单再动手。
4. **P3 · 6.4**：发布报告记录真实 DCL/load/资源体积。
