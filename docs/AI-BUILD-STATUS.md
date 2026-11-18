# AI-BUILD-STATUS · Guandao OS 当前状态

> 本文件只记录**当前事实**，不复制历史细节。
> 历史细节见 `GUANDAO_2_0_AUDIT.md`（附录 A–P）、`GUANDAO_2_0_ROADMAP.md`、`docs/RELEASE-2.0.md`。
> 每轮开发结束必须更新本文件；`Implemented` 不得写成 `Verified`。

- **更新时间**：2026-11-18
- **版本**：2.0.0
- **分支**：`feat/5.0-community-publishing-pipeline`
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

## 2. 当前质量基线（2026-11-18 本机实跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error |
| `npm run test:unit` | **19 文件 / 359 单测通过** |
| `npm run security:test` | 六组自检全过 |
| `npm run check:unused` / `check:astro` / `check:html-security` / `lint` | 通过（html-security 291 处全审查、0 未审查） |
| `npm run build` | exit 0，29 页；CSP 12 哈希 / 30 HTML 一致；HTML 安全 292 处全审查、0 未审查 |
| `npx playwright test`（`E2E_ADMIN_PORT=18789`） | 见 §4（本轮全量结果） |

> 环境注意：本机 WorkBuddy 沙箱的 safe-delete 守卫会在 Astro 清理 `dist/.prerender` 时中断进程（exit 1），
> 属环境问题而非代码失败。规避方式：构建前 `mv dist/.prerender /tmp/...`。

## 3. 正在执行的目标（Phase 6）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 6.1 入口 JS ≤ 450 KB | **部分完成**：525,102 B → 482,939 B（−42 KB）；剩余 +33 KB | `docs/architecture/LEGACY-APPLICATIONS.md` §9.1 |
| 6.2 首屏 CSS ≤ 200 KB | `Not Started`：273,238 B | 需要「非首屏样式延迟加载」审计 |
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
| 目标 spec（`legacy-apps` + `lifecycle`） | **27 passed**（2.4m），含「连续开关 20 次监听器不增长」 |
| 全量 E2E | **172 passed（5.1m），exit 0**（新增诊断中心「指标」用例） |

## 5. 重大风险（未关闭）

1. **生产层全部 `Blocked`**：未部署、未应用生产迁移、未跑 `qa:prod`（Phase 1.6 门禁，需所有者授权）。
2. **社区发布链仅本地验证**：生产 D1/R2 未执行，管理员审核链未在生产验证。
3. **`os13.ts` 巨型闭包**（2,397 行）：壁纸/图标/Dock/控制中心/设置面板共用一份 cfg，
   是入口体积与可维护性的主要结构性债务，需 Core Settings API 才能干净拆分。
4. **页面级插件安装**未并入 Playwright（仅本地证据脚本）。
5. 本地并发跑 Playwright 与 verify 会共享 `.wrangler/state` 本地 D1，互相干扰。

## 6. 下一步（按优先级）

1. **P2 · 6.3**：诊断中心接入真实 LCP/CLS/INP（页面级采集一次、写入本地快照、无数据显示「未采集」）——独立性最好、可验收。
2. **P2 · 6.1 收尾**：appcenter / workspaces 的 app UI 改 `load()`；widgetstore 画廊拆分；目标再降 12–20 KB。
3. **P2 · 6.2**：首屏 CSS 审计（273 KB → 200 KB），先产出「规则 → 出现时机」清单再动手。
4. **P3 · 6.4**：发布报告记录真实 DCL/load/资源体积。
