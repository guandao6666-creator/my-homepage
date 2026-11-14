# Phase 2.1 · Desktop Shell CSS 拆分记录

**状态**：Implemented / 本地已验证；已随 6928916f 上线（非计划部署，未做生产 UI 复测）
**范围**：只拆分 `src/pages/index.astro` 的桌面全局 CSS；未改 JS、窗口逻辑、Dock/菜单栏设计、Worker、D1、R2、认证。
**原则**：只搬代码，不改设计；按原文件顺序连续切分，`index.css` 只做有序 `@import`。

---

## 1. 拆分前结构

```text
src/pages/index.astro
├── <noscript><style>…</style></noscript>     # 保留
├── <style is:global> 9,799 行 / 270,945 B    # 本次拆离
└── <script is:inline define:vars>            # 未动

src/styles/ 18 个现有 CSS（global / os14 / os20 / 页面级等）
```

构建顺序（关键）：

```text
global.css
index.B_TNKWp7.css   ← 原内联全局样式在这里（第二个 link）
playground / drive / devices / backup / security / community / app / manager
```

---

## 2. 拆分后结构

```text
src/styles/desktop/
├── index.css               # 18 条有序 @import
├── variables.css           # 1.1 token / :root
├── reset.css               # html/body/.os 基础
├── desktop-shell.css       # 壁纸与壁纸动画
├── menubar.css             # 菜单栏、虚拟桌面、移动端菜单控件
├── desktop-icons.css       # 桌面图标、图标绘制、桌面宠物
├── windows.css             # 窗口、标题栏、窗口预览
├── applications.css        # Finder/关于/终端/设置/音乐/成就/通知
├── overlays.css            # Spotlight + Mission Control
├── widgets.css             # Widget 与短屏适配
├── games.css               # 水族箱/访客/排队/抽奖/议会/树洞/新闻/社交/关机
├── boot.css                # 关机画面 + 开机动画
├── dock.css                # Dock
├── responsive.css          # 手机卡片选择器、响应式、减少动效
├── apps-legacy.css         # 1.2 计算器/便签/监视器/日历/图片/浏览器/文件/终端
├── themes.css              # 浅色主题与覆盖
├── launchpad.css           # 启动台
├── os20.css                # 1.3/2.0 token、Dock、窗口、Widget、设置、菜单、Toast
└── responsive-final.css    # 2.0 减少动效 + 最终移动端覆盖
```

`index.astro` 只新增：

```astro
import "../styles/desktop/index.css";
```

`src/styles/desktop/index.css` 的顺序：

```css
@import "./variables.css";
@import "./reset.css";
@import "./desktop-shell.css";
@import "./menubar.css";
@import "./desktop-icons.css";
@import "./windows.css";
@import "./applications.css";
@import "./overlays.css";
@import "./widgets.css";
@import "./games.css";
@import "./boot.css";
@import "./dock.css";
@import "./responsive.css";
@import "./apps-legacy.css";
@import "./themes.css";
@import "./launchpad.css";
@import "./os20.css";
@import "./responsive-final.css";
```

**没有循环导入**；Vite 在构建时内联 `@import`，不增加运行时请求。

---

## 3. 迁移内容与保留内容

### 已迁移

- 全部 9,799 行桌面全局 CSS，按原行段连续迁移；
- 1.1 → 1.2 → 1.3 → 2.0 的覆盖顺序原样保留；
- 35 个 `@keyframes` 留在各自原区段，不集中重排；
- 12 个 `@media` 断点原样保留；
- 4 个 `:root`（含媒体查询内覆盖）原样保留；
- 浅色主题、减少动效、移动端最终覆盖保持在原相对位置。

### 保留在 Astro

- `<noscript><style>.boot{display:none!important}</style></noscript>`：无 JS 兜底，不属于桌面全局 CSS；
- `<script is:inline define:vars={{ OS_DATA: data }}>`：是脚本数据注入，**不是 CSS `define:vars`**；
- 无任何依赖 `define:vars` 的 CSS，因此没有“无法外移”的样式块。

### 动态样式

| 机制 | 是否受拆分影响 |
| --- | --- |
| JS 写 `--di-rows`（桌面图标行数） | 不受影响；变量仍作用于全局选择器 |
| JS 写 `--lp-cols`（启动台列数） | 不受影响 |
| `data-shell` / `data-os-theme` / `data-dock-*` / `data-wall` / class 切换 | 不受影响；外部 CSS 仍是全局作用域 |
| 运行时 `document.createElement("style")` | 未发现 |
| `define:vars` CSS | 不存在 |

---

## 4. 加载顺序与构建产物

拆分前后构建的 `index.B_TNKWp7.css`：

- 文件名/hash 相同；
- 大小均为 **273,238 B**；
- 仍是 `<head>` 中第 2 个 stylesheet（`global.css` 之后，页面级 CSS 之前）。

结论：**构建后的 CSS 内容哈希未变，加载位置未变**。这是视觉零差异的主要原因。

---

## 5. 性能数据

| 指标 | 拆分前 | 拆分后 |
| --- | ---: | ---: |
| `index.astro` 行数 | 17,566 | **7,766** |
| `index.astro` 字节数 | 602,226 | **331,283** |
| 源 CSS 文件数 | 18 | **37**（18 旧 + 19 desktop，含 `index.css`） |
| 拆分出的 CSS 文件 | 0 | **18 个内容文件 + 1 个入口** |
| 桌面 CSS 原始字节 | 270,945（内联） | **271,419**（含 18 条 import，约 +474 B） |
| 构建后 CSS 总大小 | 570,726 B | **570,726 B** |
| 首屏 `<link>` CSS 合计 | 476,749 B | **476,749 B** |
| 主 JS 入口 | 508,949 B | **508,949 B** |
| 构建耗时（实测） | 4,597 ms（1 次） | **5,365 ms**（3 次中位数；范围 3,992–7,396 ms） |
| 首屏资源请求数 | 29 | **29**（10 CSS / 8 JS / 2 img / 8 fetch / 1 other） |
| CSS 规则数 | 1,520 | **1,520** |
| CSS 声明数 | 5,323 | **5,323** |
| `@keyframes` / `@media` / `:root` | 35 / 12 / 4 | **35 / 12 / 4** |

**首屏 CSS 仍是 476,749 B，超过路线图 200 KB 目标。**
本次是纯结构拆分，不删除任何使用中的样式；未达标事实保留，延迟加载留到后续阶段。

---

## 6. 视觉回归

目录：

- `.shots/phase-2.1-before/`
- `.shots/phase-2.1-after/`
- `.shots/phase-2.1-diff-report.json`

方法：

- Playwright + 本机 Chrome；
- 固定时钟（`2026-11-06T10:52:00Z`）；
- 阻断外部请求，禁用 animation/transition，隐藏 toast；
- 每张图同时记录 `layout.json` 的关键元素 boundingBox。

结果：

| 项 | 结果 |
| --- | --- |
| 对比状态数 | 21 |
| 像素完全一致 | **20 / 21** |
| 动态差异 | 1（`768x1024-window` 顶部通知未读红点，异步状态） |
| 失败 | **0** |
| boundingBox 检查 | **147 / 147 一致** |

覆盖：

- 1440×900：深色/浅色、Dock 隐藏/展开、菜单栏、窗口打开/最大化/拖动、多窗口、Widget、应用对话框（桌面卡片）；
- 1920×1080：初始/多窗口；
- 768×1024、1024×768：初始/窗口；
- 390×844、430×932：移动端页面 + 强制桌面布局。

> Spotlight 截图未纳入：`Ctrl+K` 同时命中插件命令面板与内置 Spotlight，截图存在测试竞态；
> 其行为由现有 Playwright E2E（Spotlight 打开/搜索/关闭）覆盖。

---

## 7. 自动化验证

| 命令 | 结果 |
| --- | --- |
| `npm run verify` | 通过：115 单测 + 33 安全测试；0 errors / 0 warnings；build 29 页；CSP 12 哈希 |
| `npx playwright test` | **24 passed** |
| `npm run check:astro` | **0 errors / 0 warnings / 138 hints** |
| `npm run lint` | **0 problems** |
| `npm run check:csp` | **12 个哈希与 30 个 HTML 一致** |
| `npm run qa:sync` | 本次未重跑（CSS 拆分不涉及同步 API；前序任务 20/20）→ **2026-11-07 已重跑：20/20** |
| `npm run qa:prod` | **未运行（禁止）** |

---

## 8. 未完成 / 注意事项

1. **已随 6928916f 上线**（因工作区含未提交 CSS 拆分，部署 Phase 1.6 时一并上线）；未做生产 UI 复测；
2. 首屏 CSS 仍为 476,749 B，200 KB 目标未达成；本次不通过删样式凑数；
3. 构建耗时中位数从 4.6s 变为 5.4s，属于单机噪声范围，未做性能结论；
4. `index.astro` 仍有 7,766 行（含 7,000+ 行应用 JS），属于下一阶段 JavaScript 拆分范围；
5. 工作区存在既有未提交修改，**未创建分支**，未重置任何用户改动；
6. 未修改 `worker/`、迁移、R2、认证、账号删除、Supabase、`wrangler.jsonc`。

---

## 9. 结论

- 桌面全局 CSS 已按职责拆为 18 个内容文件 + 1 个入口；
- 规则顺序、全局作用域、媒体查询、动画、动态变量均保持；
- 构建 CSS 哈希与加载位置未变；
- 20/21 截图逐像素一致，1 张为异步通知红点；147 个布局框全部一致；
- 现有 24 项 E2E、verify、CSP 全部通过；
- **已上线 6928916f，未改生产数据**；Phase 2.1 代码层完成，但生产 UI 尚需复测。

---

## 10. 2026-11-07 独立复核

本次**没有修改任何代码**，只在分支 `refactor/2.1-desktop-css-extraction` 上做验证与文档。

| 复核项 | 结果 |
| --- | --- |
| 内容字节守恒 | 18 文件合计 **270,945 B**，与拆分前内联块完全相同 |
| 规则守恒 | `@keyframes` / `@media` / `:root` = **35 / 12 / 4**，行数合计 **9,799** |
| 构建产物 | `index.B_TNKWp7.css` = **273,238 B**，内容 hash 未变，仍是第 2 个 stylesheet |
| 构建总量 | CSS 19 文件 / **570,726 B**；首屏 10 link / **476,749 B** |
| 单元 + 安全测试 | `npm run verify` 绿：115 单测 + 49 安全；`check:astro` 0 error / 0 warning；`lint` 0 problem；CSP 12 哈希 |
| E2E | **24 / 24 通过** |
| 云同步 QA | **20 / 20 通过**（需把 `TEMP`/`TMP` 指向工作区内目录，否则 workerd 报 `CreateDirectory #5 拒绝访问`） |
| 视觉重采 | 21 状态：**19 完全一致**、1 动态红点、1 单像素 Δ=3/255；147/147 boundingBox 一致 |
| `dialog` 缺口 | **已恢复复采**（派发 `#card-tools` click），与基线 **diff=0** |
| 生产 UI 复测 | **9/9 通过**：生产 10 个 CSS 资产与本机构建同名同字节（含 `index.B_TNKWp7.css` 273,238 B） |
| 告警真实送达 | **16/16 通过**（`npm run qa:alerts`，真实外部 HTTPS，非 Mock） |
| 取证脚本 | 已入库提交 `a712d96`（截图/对比/告警/生产复测 4 个脚本 + 架构文档） |
| 首屏 CSS 200 KB 目标 | **未达成**（476,749 B）；经所有者决定**移交 Phase 6.2**，以 476,749 B 作为 6.2 起点基线 |
| **最终结论** | **Verified**（结构 / 语义 / 视觉口径，2026-11-07 所有者修订验收后改判） |

复核后的口径与权威说明见 [`docs/architecture/DESKTOP-CSS.md`](architecture/DESKTOP-CSS.md)；
本节 §6 的「20/21」是当时 `before` 与 `after` 两次采集（含 `dialog` 状态）的结果，与本次重采状态集合不同，
两者不冲突：§6 证明拆分当时没有视觉变化，§10 证明当前构建仍与基线一致。

> **口径修订说明**：原 2.1 验收含「首屏 CSS ≤ 200 KB」，在只搬不改的约束下结构性不可达
> （仅桌面样式包即 273,238 B）。2026-11-07 由所有者决定把该指标移交 Phase 6.2，
> 2.1 改以「结构 / 语义 / 视觉」验收。未达标的 476,749 B 未被删除，
> 而是作为 Phase 6 的起点基线保留在路线图 6.2 与本文 §5 / §10。