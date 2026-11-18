# AI-BUILD-BACKLOG · Guandao OS 待办与优先级

> 只记录**尚未完成**的工作。已完成项在 `docs/AI-BUILD-LOG.md` 与 `docs/RELEASE-2.0.md`。
> 优先级定义与纲领一致：P0 数据/安全/认证 → P1 核心功能/一致性/备份 → P2 架构/稳定/性能 → P3 规划功能 → P4 视觉 → P5 实验。

## P0 · 数据与安全（当前无未关闭项）

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P0-1 | 生产部署 / 生产迁移 / `qa:prod` | `Blocked` | 需所有者授权（纲领 §4.2） |
| P0-2 | 社区发布链生产验证 | `Blocked` | 本地 260/260 已过 |

## P1 · 核心功能与一致性

| # | 任务 | 状态 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P1-1 | 页面级插件安装并入 Playwright | `Not Started` | 现有 `plugin-publishing.spec.ts` | 不再依赖 `.shots/_p5-page-install-evidence2.mjs` 手工脚本 |
| P1-2 | `initRank` 的 `void load()` 随窗口取消 | `Not Started` | 需要 fetch 取消 port | 关窗后不再向脱离文档的节点写入 |
| P1-3 | legacy 网络请求取消 port | `Not Started` | 同上 | `AbortController` 随 `lifecycle.dispose` 触发 |

## P2 · 性能与可观测（当前阶段）

| # | 任务 | 状态 | 目标 | 验收 |
| --- | --- | --- | --- | --- |
| P2-2 | 6.1 收尾：appcenter / workspaces app UI 改 `load()` | `Not Started` | 入口再降 12–20 KB | 入口 ≤ 460 KB；E2E 无回归 |
| P2-3 | 6.1 收尾：widgetstore 画廊拆分 | `Not Started` | 同上 | 组件中心可开、运行时不受影响 |
| P2-4 | 6.2 首屏 CSS ≤ 200 KB | `Not Started` | 273,238 B → ≤ 200 KB | 先产出「规则 → 出现时机」审计清单，再延迟加载非首屏样式 |
| P2-5 | 6.1 目标 450 KB | `Blocked` | 需 P2-2/P2-3 + Settings 拆分 | 达成前不得在文档写「6.1 完成」 |
| P2-6 | `os13.ts` 巨型闭包拆分 | `Blocked` | 需 Core Settings API | 拆分后入口与设置面板可独立测试 |

## P3 · 生态与开发者体验

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P3-1 | 6.4 生产性能基线进发布报告 | `Not Started` | `scripts/prod-e2e.mjs` + `docs/RELEASE-2.0.md`；需生产授权 |
| P3-2 | 教程页面级浏览器断言 | `Not Started` | 当前仅 API/单测覆盖正文渲染 |
| P3-3 | 真机（物理设备）冒烟 | `Not Started` | 设备接力/配对未在真机验证 |

## P4 · 视觉与体验

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P4-1 | 平板模式验证 | `Unknown` | 审计 §7.2 遗留；无证据不得写 Verified |

## 已完成

- 6.1 旧版应用懒加载（2026-11-18）：入口 525,102 B → 482,939 B；单测 13 → 16 项；E2E 目标 spec 27 passed。
- 6.3 诊断中心接入真实 LCP/CLS/INP（2026-11-18）：新增「指标」分区；无数据「未采集」；
  浏览器不支持「不支持」；E2E `desktop.spec.ts` 新增 1 项，全量 172 passed；HTML 安全 292 处全审查。
