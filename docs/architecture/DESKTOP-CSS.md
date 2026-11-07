# 桌面外壳 CSS 架构（Desktop Shell CSS）

**阶段**：Guandao OS 2.1 · Phase 2.1
**状态**：`Partially Verified`（唯一未达标项：首屏 CSS ≤ 200 KB）
**最后核对**：2026-11-07
**分支**：`refactor/2.1-desktop-css-extraction`（`a712d96` 取证脚本入库）
**范围**：只搬迁 `src/pages/index.astro` 的桌面全局样式；未改 JS、窗口系统、应用行为、Worker、D1、R2、认证。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 搬迁方式 | 按原文件**连续行段**切分，不重排、不合并、不重写选择器 |
| CSS 语义 | **字节级一致**：18 个内容文件合计 `270,945 B`，与拆分前内联块完全相同 |
| 行数守恒 | 合计 `9,799` 行，与拆分前 `<style is:global>` 行数相同 |
| 构建产物 | `index.B_TNKWp7.css` = `273,238 B`，**内容 hash 与拆分前相同** |
| 加载位置 | 仍是 `<head>` 中第 2 个 stylesheet（`global.css` 之后、页面级 CSS 之前） |
| 首屏 CSS | `476,749 B`，**未达 200 KB 目标**（本次不删样式凑数） |
| 视觉回归（本地） | 21 状态中 **19 完全一致**；1 动态（通知红点）；1 单像素 Δ3；147/147 布局框一致 |
| 生产 UI | **已复测**：生产 10 个 CSS 资产与本机构建**同名同字节**（含 `index.B_TNKWp7.css` 273,238 B）；9/9 渲染检查通过 |
| 自动化 | `verify` 绿；E2E 24/24；`qa:sync` 20/20；告警真实送达 16/16 |

> **能否升级为 Verified**：视觉与生产复测已闭环，但路线图 2.1 的第二条验收「首屏 CSS ≤ 200 KB」**结构性不可达**
> （仅桌面样式包本身就是 273,238 B，已超 200 KB）。因此维持 `Partially Verified`，
> 需要所有者决定「本条豁免 / 推迟到 Phase 6」，才能改判。

---

## 2. 原始 CSS 所在位置

拆分前，桌面样式位于 `src/pages/index.astro` 的两个位置：

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| `<noscript><style>.boot{display:none!important}</style></noscript>` | 无 JS 时隐藏启动层 | **保留在 Astro**（不属于桌面全局 CSS） |
| `<style is:global>`（约第 7,763–17,562 行） | 9,799 行 / 270,945 B 桌面全局样式 | **已迁出** |

同文件另有 `<script is:inline define:vars={{ OS_DATA: data }}>`：那是**脚本数据注入**，与 CSS `define:vars` 无关，未改动。

`src/styles/` 既有的 18 个页面级 CSS（`global / os14 / os14-apps / account / adaptive / pwa / quality / os20` 等）**保持原样**，导入顺序未变。

> 拆分前的精确行数与字节数来自 [`docs/PHASE-2.1-CSS-AUDIT.md`](../PHASE-2.1-CSS-AUDIT.md)。原始内联块已被替代，本次无法重新测量“拆分前文件”，因此以**内容字节守恒**作为等价性证据（见 §6）。

---

## 3. 新目录结构

```text
src/styles/
├── desktop/
│   ├── index.css               # 统一入口：18 条有序 @import
│   ├── variables.css           # 设计 token / :root
│   ├── reset.css               # html / body / .os 基础
│   ├── desktop-shell.css       # 壁纸与壁纸动画
│   ├── menubar.css             # 菜单栏、虚拟桌面
│   ├── desktop-icons.css       # 桌面图标、图标绘制、桌面宠物
│   ├── windows.css             # 窗口、标题栏、窗口预览
│   ├── applications.css        # Finder/关于/终端/设置/音乐/成就/通知
│   ├── overlays.css            # Spotlight + Mission Control
│   ├── widgets.css             # Widget 与短屏适配
│   ├── games.css               # 水族箱/访客/排队/抽奖/议会/树洞/新闻/社交/关机
│   ├── boot.css                # 关机画面 + 开机动画
│   ├── dock.css                # Dock
│   ├── responsive.css          # 手机卡片选择器、响应式、减少动效
│   ├── apps-legacy.css         # 1.2 计算器/便签/监视器/日历/图片/浏览器/文件/终端
│   ├── themes.css              # 浅色主题与覆盖
│   ├── launchpad.css           # 启动台
│   ├── os20.css                # 1.3 / 2.0 token、Dock、窗口、Widget、设置、菜单、Toast
│   └── responsive-final.css    # 2.0 减少动效 + 最终移动端覆盖
└── （既有 18 个页面级 CSS，未改动）
```

**与路线图建议的差异**：路线图写作 `src/styles/desktop.css`，实际落为 `src/styles/desktop/index.css`。
原因是单文件无法承载 9,799 行的顺序敏感规则；目录 + 入口既满足“统一入口”，又保持切分粒度。
`src/styles/desktop.css` **不存在**，因此不存在重复入口。

---

## 4. 加载顺序

`src/styles/desktop/index.css` 是唯一入口，只有 18 条 `@import`，无其他规则：

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

该顺序**等于原始内联块的物理行序**，因此：

- `:root` token 先定义，后续 `@media` / `.os` / 2.0 区段按原样覆盖；
- `menuIn` 动画的**重复定义**先后关系不变（后者仍覆盖前者）；
- 浅色主题（`themes.css`）仍排在基础规则之后；
- 2.0 覆盖（`os20.css`）仍排在 1.x 规则之后；
- `responsive-final.css` 仍是最后一道移动端覆盖。

构建后 `dist/index.html` 的 stylesheet 顺序（10 个首屏 link）：

```text
1. global.CkXUMb-L.css          8,118 B
2. index.B_TNKWp7.css         273,238 B   ← 桌面全局样式（原内联块内容）
3. playground.4SxkD2mF.css     21,647 B
4. drive.CnztSQe1.css          11,184 B
5. devices.CubCLEY2.css        29,580 B
6. backup.HvjsV6tD.css         24,494 B
7. security.jzgXizCC.css       25,996 B
8. community.dIY5I7se.css      46,207 B
9. app.CcX1zf6k.css            10,843 B
10. manager.Bsc_0A1E.css       25,442 B
```

---

## 5. CSS 分类规则

分类依据是**原文件的行段顺序**，不是“主题类型”。规则：

1. **顺序优先**：任何重组都不得改变选择器之间的相对先后，因此只能按连续行段切分。
2. **动画不集中**：35 个 `@keyframes` 留在各自原区段，不抽到 `animations.css`——`menuIn` 有重复定义，集中会改变覆盖关系。
3. **媒体查询不集中**：12 个 `@media` 留在原位，避免断点覆盖顺序改变。
4. **变量先于使用**：`variables.css` 必须是第 1 个文件。
5. **主题与响应式靠后**：浅色主题、减少动效、移动端最终覆盖保持在后段。
6. **文件按“归属领域”命名**，但边界由原始行段决定；宁可某个文件内混有少量相邻领域规则，也不跨行段抽取。

各文件体量（本次实测）：

| 顺序 | 文件 | 行数 | 字节 | @keyframes | @media |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | `variables.css` | 49 | 1,770 | 0 | 0 |
| 2 | `reset.css` | 35 | 971 | 0 | 0 |
| 3 | `desktop-shell.css` | 83 | 3,208 | 1 | 0 |
| 4 | `menubar.css` | 429 | 10,812 | 1 | 0 |
| 5 | `desktop-icons.css` | 539 | 14,823 | 0 | 1 |
| 6 | `windows.css` | 217 | 5,888 | 1 | 0 |
| 7 | `applications.css` | 864 | 20,096 | 2 | 0 |
| 8 | `overlays.css` | 368 | 8,633 | 3 | 0 |
| 9 | `widgets.css` | 317 | 7,974 | 1 | 2 |
| 10 | `games.css` | 1,494 | 35,578 | 13 | 0 |
| 11 | `boot.css` | 142 | 3,491 | 2 | 0 |
| 12 | `dock.css` | 83 | 2,252 | 0 | 0 |
| 13 | `responsive.css` | 571 | 15,853 | 2 | 5 |
| 14 | `apps-legacy.css` | 964 | 25,488 | 0 | 0 |
| 15 | `themes.css` | 1,060 | 35,310 | 0 | 0 |
| 16 | `launchpad.css` | 261 | 8,516 | 2 | 2 |
| 17 | `os20.css` | 2,214 | 67,489 | 7 | 0 |
| 18 | `responsive-final.css` | 109 | 2,793 | 0 | 2 |
| | **合计** | **9,799** | **270,945** | **35** | **12** |

### 动态样式与 JS 依赖

拆分对以下机制**无影响**，因为它们依赖的选择器/变量仍然是全局作用域：

| 机制 | 说明 |
| --- | --- |
| `--di-rows` | JS 写入的桌面图标行数 |
| `--lp-cols` | JS 写入的启动台列数 |
| `data-shell` / `data-os-theme` / `data-dock-pos` / `data-dock-auto` / `data-wall` / `data-app` | 状态属性选择器 |
| class 切换（`has-open`、`is-active`、`os13-reduce` 等） | 全局 class |
| 运行时 `document.createElement("style")` | **未发现** |
| CSS `define:vars` | **不存在** |

> 结论：没有任何样式因为“无法外移”而被迫留在 Astro 内。

---

## 6. Astro 引入方式

`src/pages/index.astro` frontmatter 末尾新增一行：

```astro
import "../styles/desktop/index.css";
```

要点：

- 外部 CSS **天然全局**，不需要 `is:global`，也不能放进 `<style>` 或 CSS Modules；
- Vite 在构建时把 `@import` **内联**进同一个产物，不产生额外运行时请求（首屏仍 10 个 CSS link）；
- 导入位置在既有 8 个页面级导入之后，构建器据此把它放到第 2 个 stylesheet 位置；
- 未改 HTML 结构、未改脚本初始化顺序、未改 CSP（CSP 只校验内联脚本哈希）；
- 未引入任何外部 CDN；Cloudflare Worker + Static Assets 架构不变。

### 等价性证据（本次实测）

| 证据 | 值 |
| --- | --- |
| 18 个内容文件字节合计 | `270,945 B` |
| 按 `index.css` 顺序拼接后的 UTF-8 字节 | `270,945 B` |
| 拆分前内联块字节（`PHASE-2.1-CSS-AUDIT.md`） | `270,945 B` |
| `@keyframes` / `@media` / `:root` | `35 / 12 / 4`（与原审计一致） |
| 构建产物 CSS | `index.B_TNKWp7.css` = `273,238 B`，**hash 未变** |
| 构建后 CSS 总量 | `570,726 B`（与原值一致） |

由于 Vite 产物文件名包含**内容 hash**，`B_TNKWp7` 与拆分前相同，即证明打包后的 CSS 字节完全相同。

---

## 7. 视觉测试证据

工具：`scripts/visual-css-shots.mjs`（截图）+ `scripts/compare-css-shots.mjs`（逐像素 + boundingBox 对比）。

方法：

- 本机 Chrome（`channel: "chrome"`），`deviceScaleFactor: 1`；
- 固定时钟 `2026-11-06T10:52:00Z`；
- 阻断所有跨源请求；注入 `animation:none / transition:none`，隐藏 toast；
- 每张图同时记录 `layout.json` 中 `#os / .menubar / #dock / .window / #widgets / #spotlight / #mission` 的 boundingBox。

本次重新采集：`.shots/phase-2.1-recheck/`（22 张），基线 `.shots/phase-2.1-before/`（21 张）。

| 项 | 结果 |
| --- | --- |
| 对比状态数 | 21 |
| 逐像素完全一致 | **19** |
| 动态差异 | **1**：`768x1024-window.png`，165 px，bbox `[124,7,711,20]`，顶部通知未读红点 |
| 单像素噪声 | **1**：`1440x900-menubar-open.png`，1 px，Δ=3/255，坐标 `(16,6)` |
| boundingBox | **147 / 147 全部一致** |

### 7.1 差异归因

两条剩余差异都**不是 CSS 造成**，理由是构建产物本身逐字节相同（§6），并且：

- `768x1024-window` 的 165 px 全部落在顶部状态栏（y 7–20），是**异步到达的未读通知红点**；
  同一状态在不同运行中红点有无不定，属于应用状态而非样式。
- `1440x900-menubar-open` 只有 **1 个像素**、色差 3/255，位于菜单栏 logo 边缘，是栅格化抗锯齿差异。

补充证据：上一轮采集里 `1440x900-window-drag.png` 曾在 22 行上出现 110 px 的星点差异（Δ≤11），
本轮同一份代码重新采集后该差异**完全消失**，说明那类差异是壁纸星野的渲染相位，与 CSS 无关。

### 7.2 `1440x900-dialog` 已恢复复采（原缺口已关闭）

- 基线 `.shots/phase-2.1-before/` 含 `1440x900-dialog.png`（桌面卡片选择器 `#card-picker`）；
- 先前该状态从截图脚本中消失（被 `spotlight` 取代），本次已补回；
- `#card-tools` 按钮在 1440 宽度下不可见，因此改为**派发 click 事件**触发 `openCardPicker`；
- 复采结果与基线 **diff = 0，逐像素完全一致**（另做过对照实验：先开便签再开选择器会产生 240,294 px 差异，故基线状态确为「仅打开选择器」）。

> 覆盖范围：1440×900（深/浅色、Dock 隐藏/展开、菜单栏、窗口打开/最大化/拖动、多窗口、Widget、桌面卡片对话框）、
> 1920×1080、768×1024、1024×768、390×844、430×932（移动端页面 + 强制桌面布局）。

---

## 7bis. 生产 UI 复测

工具：`scripts/prod-visual-check.mjs`（只读 GET + 截图，不登录、不写数据、不部署）。

### 7bis.1 生产 CSS 资产与本机构建一致

`https://guandao.xin/` 返回的 10 个 stylesheet 与本地 `dist/index.html` **文件名与字节数完全相同**：

| # | 资产 | 字节 |
| ---: | --- | ---: |
| 1 | `global.CkXUMb-L.css` | 8,118 |
| 2 | `index.B_TNKWp7.css` | **273,238** |
| 3 | `playground.4SxkD2mF.css` | 21,647 |
| 4 | `drive.CnztSQe1.css` | 11,184 |
| 5 | `devices.CubCLEY2.css` | 29,580 |
| 6 | `backup.HvjsV6tD.css` | 24,494 |
| 7 | `security.jzgXizCC.css` | 25,996 |
| 8 | `community.dIY5I7se.css` | 46,207 |
| 9 | `app.CcX1zf6k.css` | 10,843 |
| 10 | `manager.Bsc_0A1E.css` | 25,442 |
| | **首屏合计** | **476,749** |

因为 Vite 用内容哈希命名，同名即同内容：**生产正在跑的 CSS == 本机构建 == 拆分前 CSS**。

### 7bis.2 生产渲染检查 9/9

| 检查 | 结果 |
| --- | --- |
| 菜单栏已渲染 | `1440×38` @ (0,0) |
| 程序坞已渲染 | `423×66` @ (508.5,820) |
| 外壳占满视口 | `1440×900` |
| 桌面图标数量 | 28 |
| 桌面样式包已加载 | `index.B_TNKWp7.css` HTTP 200 |
| 窗口可打开 | 通过 |
| 标题栏尺寸正常 | `918×42` |
| 移动端 `/m/` 已渲染 | 通过 |
| 移动端底栏存在 | 通过 |

截图：`.shots/prod-2.1/1440x900-desktop.png`、`1440x900-window.png`、`390x844-mobile.png`、`report.json`。

> 生产截图与本机截图的差别只来自**实时数据**（时钟、天气、日期、成就弹窗），不作为像素比对基准；
> 像素级等价由 §7 的本地基线对比 + §7bis.1 的资产同一性共同保证。

---

## 8. 性能对比

口径：本机实测，`npm run build` 全流程（含 `prebuild` 内容同步与 `postbuild` CSP 生成），`dist/` 产物逐文件统计。

| 指标 | 拆分前（基线） | 拆分后（本次实测） |
| --- | ---: | ---: |
| `index.astro` 行数 | 17,566 | **7,766** |
| `index.astro` 字节 | 602,226 | **331,283** |
| 桌面 CSS 源文件数 | 1（内联） | **18 内容 + 1 入口** |
| 桌面 CSS 源字节 | 270,945 | **270,945**（+474 B 入口 `@import`） |
| 构建后 CSS 文件数 | 19 | **19** |
| 构建后 CSS 总字节 | 570,726 | **570,726** |
| 首屏 `<link>` CSS 合计 | 476,749 | **476,749** |
| 最大 CSS 文件 | `index.B_TNKWp7.css` 273,238 | **`index.B_TNKWp7.css` 273,238** |
| 首屏 CSS 请求数 | 10 | **10** |
| 主 JS 入口 | 508,949 | **508,949** |
| 全部 JS 产物 | 1,298,723 | **1,317,011**（46 文件，含内容同步差异） |
| `dist/index.html` | 29,135 | **29,135** |
| `dist/` 总字节 | — | **24,827,486**（188 文件） |
| `npm run build` 耗时 | 4,597 ms（1 次） | **3,701 ms**（1 次，本机噪声范围内） |

### 结论

- **CSS 体积没有减少，也不应该减少**：本次只做结构治理，每条规则只保留一份有效来源；
- 拆分**没有引入额外网络请求**（Vite 构建期内联 `@import`）；
- **首屏 CSS 476,749 B > 200 KB 目标，未达成**；要达标需要“非首屏样式延迟加载”或真正的样式裁剪，属于后续阶段，不在 Phase 2.1 授权范围内；
- 构建耗时差异（4.6s → 3.7s）在单机噪声范围内，**不作性能结论**。

---

## 9. 未解决问题 / 风险

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | **首屏 CSS 476,749 B，超 200 KB** | 移动网络首屏 CSS 下载偏重；路线图 2.1 第二条验收未达成 | 需要「非首屏样式延迟加载」或真正裁剪，属 Phase 6 范围；不允许靠删样式凑指标 |
| 2 | `index.astro` 仍有 7,766 行（约 7,000 行应用 JS） | 主文件依旧臃肿 | Phase 2.2：应用脚本迁到 `src/lib/legacy-apps/` |
| 3 | 生产告警通道仍未在 Cloudflare 上配置 | 生产备份失败不会真正外发通知 | 代码链路已用真实外部 HTTPS 验通（§10），剩下只需要所有者提供渠道地址并设置 Secret |
| 4 | 本机 `qa:sync` 需要可写临时目录 | 默认 `%TEMP%` 下 workerd 报 `CreateDirectory #5 拒绝访问` | 运行前把 `TEMP`/`TMP` 指到工作区内目录（见下） |
| 5 | 基线截图不入 Git（约 25 MB） | 换机后需重新生成基线 | 截图脚本已入库（`a712d96`）；基线用 `npm run shots` 重建，见 §7 |
| 6 | 1 px / Δ3 的栅格化噪声 | 无法做到 21/21 全等 | 已归因为抗锯齿，不再追查 |

已关闭的旧问题（保留记录）：

- ~~生产 UI 未复测~~ → §7bis，9/9 通过，生产 CSS 资产与本机构建同名同字节；
- ~~`visual-css-shots.mjs` 未纳入 Git~~ → `a712d96` 已入库；
- ~~`1440x900-dialog` 无法复采~~ → §7.2，已恢复且 diff = 0；
- ~~`1440x900-window-drag` 星点噪声~~ → 本轮复采完全消失，确认为渲染相位。

### 本机复现命令

```powershell
# 构建与静态服务
npm run build
node scripts/serve-dist.mjs 4399

# 视觉回归（需要本机 Chrome）
npm run shots                                     # → .shots/current
npm run shots:compare                             # 对比 .shots/phase-2.1-before

# 生产 UI 只读复测（不登录、不写数据）
npm run qa:prod-visual

# 告警真实送达（自动创建 webhook.site 通道并读回）
npm run qa:alerts

# 自动化门禁
npm run verify
npx playwright test
$env:TEMP = "$PWD\.wrangler\tmpdir"; $env:TMP = $env:TEMP   # workerd 需要可写临时目录
npm run qa:sync
```

---

## 10. 告警真实送达验证（Phase 1.6 第 7 项）

**问题**：`qa:d1-backup` 与 `qa:data-monitor` 都把 `fetch` 整体替换成 Mock，
Webhook **从来没有真正发出过**，只能证明"调用了 fetch"，不能证明"送达"。

**做法**：新增 `scripts/alert-delivery-check.mjs`（`npm run qa:alerts`）。
只 Mock「Cloudflare D1 导出/下载」与「D1 数据库」，**告警外发走真实 HTTPS**，
再从接收端 API 读回请求体做断言。

通道：自动创建 `https://webhook.site` 临时通道（30 天有效，可读回），
也可用 `ALERT_WEBHOOK_URL` 指定自己的接收端。

| # | 断言 | 结果 |
| ---: | --- | --- |
| 0 | 接收通道可用（真实外部 HTTPS） | ok |
| 1 | 备份失败产生 `failed` 状态，`errorCode=ENCRYPTION_KEY_MISSING` | ok |
| 2 | 失败记录 `notifiedAt` 非空 | ok |
| 3 | 失败记录 `notifyError` 为空 | ok |
| 4 | Webhook 走真实网络（未被 Mock 拦截） | ok |
| 5 | 接收端真实收到 `guandao.backup.alert`（POST） | ok |
| 6 | payload `runId` 与本次运行一致 | ok |
| 7 | payload 含 `code` 与 `requiresHumanReview:true` | ok |
| 8 | payload 不含 Token / SQL / 邮箱 | ok |
| 9 | 数据监控产出 `USERS_ZERO` critical | ok |
| 10 | 告警记录 `notified=true` | ok |
| 11 | 告警记录无 `notifyError` | ok |
| 12 | 数据告警同样走真实网络 | ok |
| 13 | 接收端真实收到 `guandao.data.alert`（POST） | ok |
| 14 | payload `code` / `severity` 正确 | ok |
| 15 | payload 只含计数，不含用户内容 | ok |

**结果：16/16 通过**，判定"真实外部 HTTPS 送达已验证"。

### 这次验证覆盖了什么，没覆盖什么

| 覆盖 | 未覆盖 |
| --- | --- |
| 告警 payload 生成（两种） | Cloudflare 生产环境的 Secret 配置 |
| 真实 HTTPS POST 与接收端落库 | 生产 Workflow 实跑时的真实外发 |
| `notifiedAt` / `notifyError` 语义 | 通知渠道的运维（谁接收、如何升级） |
| payload 不含敏感字段 | — |

**因此不能宣称"生产告警已配置"**：`BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`
在 Cloudflare 上仍未设置。

### 所有者需要做的最后一步

```bash
# 用一个真实可读的接收端（飞书/钉钉/Server酱/自建均可）
npx wrangler secret put BACKUP_ALERT_WEBHOOK
npx wrangler secret put DATA_ALERT_WEBHOOK
# 然后部署；下一次备份失败才会真正外发
```

配置后可用 `GET /api/admin/backup-status` 的 `notificationConfigured` 字段确认
（`true` = 已配置）。注意：本仓库当前**未执行部署**，也不应在未授权时部署。

---

## 11. 相关文档

- [`docs/PHASE-2.1-CSS-AUDIT.md`](../PHASE-2.1-CSS-AUDIT.md)：拆分前审计（选择器分布、断点、动画清单）
- [`docs/PHASE-2.1-CSS-REFACTOR.md`](../PHASE-2.1-CSS-REFACTOR.md)：拆分过程记录
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图
- [`GUANDAO_2_0_AUDIT.md`](../../GUANDAO_2_0_AUDIT.md)：总体审计
- [`docs/ACCEPTANCE-2.0.md`](../ACCEPTANCE-2.0.md)：验收清单