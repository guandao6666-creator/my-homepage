# Phase 2.1 · Desktop Shell CSS 审计

**状态**：审计完成（拆分前基线）
**范围**：`src/pages/index.astro` 的桌面全局样式；不涉及 `worker/`、D1、R2、认证。
**原则**：只搬代码，不改设计；先记录，再拆分。

---

## 1. 原始 CSS 文件结构

### 1.1 `src/pages/index.astro` 内的样式

| 位置 | 内容 | 作用域 |
| --- | --- | --- |
| 第 160–164 行 | `<noscript><style>.boot{display:none!important}</style></noscript>` | 无 JS 时隐藏启动层 |
| 第 7763–17563 行 | `<style is:global>` 桌面全局样式 | **全局** |

- `<style is:global>` 只有 **1 个**；
- `define:vars` 只出现在第 684 行的 `<script is:inline define:vars={{ OS_DATA: data }}>`，**没有** `define:vars` 的 `<style>`；
- 未发现运行时 `document.createElement("style")` 或 `style.cssText` 注入；
- 动态样式依赖 JS 写入的 CSS 变量：`--di-rows`、`--lp-cols`；以及 `data-*` / class 切换。

### 1.2 `src/styles/` 现有文件

| 文件 | 大小 |
| --- | ---: |
| `global.css` | 11,730 B |
| `os14.css` | 50,197 B |
| `os14-apps.css` | 57,436 B |
| `account.css` | 19,123 B |
| `adaptive.css` | 7,393 B |
| `pwa.css` | 1,640 B |
| `quality.css` | 11,734 B |
| `os20.css` | 29,772 B |
| 其他页面级 CSS | `backup / community / continuity / devices / drive / mobile / pairing / plugins / security / os14-games` 等 |

`index.astro` 的 frontmatter 导入顺序：

```text
global.css
os14.css
os14-apps.css
account.css
adaptive.css
pwa.css
quality.css
os20.css
```

### 1.3 构建产物中的加载顺序（拆分前）

`dist/index.html` 的 `<link rel="stylesheet">` 顺序：

1. `global.CkXUMb-L.css`（8,118 B）
2. `index.B_TNKWp7.css`（273,238 B，包含内联全局样式）
3. `playground.4SxkD2mF.css`（21,647 B）
4. `drive.CnztSQe1.css`（11,184 B）
5. `devices.CubCLEY2.css`（29,580 B）
6. `backup.HvjsV6tD.css`（24,494 B）
7. `security.jzgXizCC.css`（25,996 B）
8. `community.dIY5I7se.css`（46,207 B）
9. `app.CcX1zf6k.css`（10,843 B）
10. `manager.Bsc_0A1E.css`（25,442 B）

**全局样式的实际位置是第 2 个 `<link>`**，位于 `global.css` 之后、页面级 CSS 之前。
拆分为外部 CSS 后必须保持这个相对位置，否则会改变与页面级 CSS 的覆盖关系。

---

## 2. 样式块与体积

| 指标 | 拆分前 |
| --- | ---: |
| `index.astro` 总行数 | 17,566 |
| `index.astro` 字节数 | 602,226 B |
| 全局 `<style is:global>` 行数 | 9,799 |
| 全局 CSS 原始字节数 | 270,945 B |
| 全局 CSS 规则数（不含 keyframes 内规则） | 1,520 |
| 声明数 | 5,323 |
| `:root` 规则数 | 4（含 3 个媒体查询内覆盖） |
| `@keyframes` | 35 |
| `@media` | 12 |
| 构建后 CSS 文件总数 | 19 |
| 构建后 CSS 总大小 | 570,726 B |
| 首屏 `<link>` CSS 合计 | **476,749 B** |
| 主 JS 入口 | 508,949 B |
| 全部 JS 产物 | 1,298,723 B |
| `dist/index.html` | 29,135 B |
| 构建耗时（实测） | 4,597 ms |
| 首屏资源请求数（Playwright，1440×900） | 29（10 CSS / 8 JS / 2 img / 8 fetch / 1 other） |

> 首屏 CSS 已超过路线图 200 KB 目标。**本次是纯结构拆分，不承诺降低总体积**；如果拆分后仍超标，将如实记录并留到后续“非首屏样式延迟加载”阶段。

---

## 3. 关键选择器分布（按规则计数，近似）

| 领域 | 规则数（近似） | 代表选择器 |
| --- | ---: | --- |
| 桌面 / 壁纸 / 图标 | 186 | `.wallpaper`、`.desk-icons`、`.desk-icon`、`.di-*` |
| 菜单栏 | 86 | `.menubar`、`.mb-*`、`.spaces` |
| 窗口系统 | 52 | `.window`、`.titlebar`、`.dot-*`、`.resize-*` |
| Dock | 56 | `.dock`、`.dock-item`、`.dock-sep` |
| Widget | 50 | `.widget`、`.widget-head`、`.widget-body` |
| 内置应用 | 135 | `.n14-*`、`.fs-*`、`.term-*`、`.calc*`、`.cal-*` |
| 覆盖层 / 对话框 | 87 | `.spotlight`、`.mission`、`.notif-*`、`.cp-sheet` |
| 启动台 | 33 | `.launchpad`、`.lp-*` |
| 启动 / 锁屏 / 关机 | 18 | `.boot`、`.lock`、`.lk-*`、`.shutdown` |

高频 class：`is-touch-desktop`(45)、`desk-icon`(28)、`window`(25)、`widget`(24)、`dock-item`(24)、`dock`(22)、`wallpaper`(21)。

---

## 4. 媒体查询与断点

原始断点（必须原样保留）：

- `min-width: 1700px`（大屏 token 放大）
- `max-height: 820px and min-width: 721px`（短屏收紧 widget）
- `max-height: 700px and min-width: 721px`
- `max-width: 720px`（桌面转移动/紧凑布局）
- `max-width: 640px`
- `max-width: 520px`
- `max-width: 360px`
- `prefers-reduced-motion: reduce`（出现在 3 个位置）

---

## 5. 动画与关键帧

共 **35 个** `@keyframes`，分布在原样式的多个区段，包括：

`wallDrift`、`menuIn`（**重复定义 2 次**）、`winIn`、`discSpin`、`notifIn`、
`spotFade`、`spotIn`、`mcIn`、`widgetIn`、`bubbleRise`、`driftSoft`、`driftDeep`、
`driftWide`、`driftSlow`、`dashAround`、`orbitPath`、`glideDiagonal`、`foodSink`、
`zzzFloat`、`heartUp`、`drawShake`、`newsIn`、`bootFill`、`bootLogo`、`cpFade`、
`cpUp`、`lp-in`、`lp-jiggle`、`wpKen`、`ccIn`、`deskRefresh`、`winIn13`、
`lkPulse`、`dockPop`。

**拆分策略**：不集中搬到一个 `animations.css`。`@keyframes` 留在原区段文件内，
避免改变重复定义（如 `menuIn`）的先后覆盖关系；`animation` / `transition` / `transform`
语句保持原顺序。

---

## 6. 可能影响拆分的特殊规则

### 6.1 全局作用域

- 原样式是 `is:global`；移动到外部 CSS 后仍必须是**全局**样式；
- `html`、`body`、`.os`、`:root` 的规则不能放进 Astro scoped style；
- 不能使用 CSS Modules 或 `:global()` 包装，否则选择器语义会变化。

### 6.2 覆盖顺序

原文件包含 1.1 → 1.2 → 1.3 → 2.0 多层覆盖：

- `:root` token 先定义，后续 `@media` / `.os` / 2.0 区段覆盖；
- `menuIn` 在 1.1 和 2.0 各定义一次，后者覆盖前者；
- 浅色主题规则位于文件中后段，必须保持在基础规则之后；
- 2.0 的 `.os` token、Dock、窗口、Widget 覆盖必须排在 1.x 规则之后。

**结论：只能按原文件顺序切分，不能按主题重新排序。**

### 6.3 运行时变量与状态

- JS 写入 `--di-rows`（桌面图标行数）与 `--lp-cols`（启动台列数）；
- JS 切换 `data-shell`、`data-dock-pos`、`data-dock-auto`、`data-os-theme`、`data-wall`、
  `data-app`、class（`has-open`、`is-active`、`os13-reduce` 等）；
- 这些选择器全部依赖全局 CSS，外移后仍可匹配；
- 没有发现依赖 Astro `define:vars` 的 CSS。

### 6.4 复杂选择器

存在大量依赖 DOM 结构的选择器，例如：

- `.os[data-dock-pos="left"] .dock`
- `.window[data-app="notes"] .titlebar`
- `.widget .widget-head`
- `[data-os-theme="light"] .fs-confirm-text`
- `html[data-shell="tablet"] ...`

这些选择器对 DOM 层级敏感，但**拆分文件不会改变 DOM**；风险只在加载顺序。

### 6.5 CSS 构建机制

- Astro `build.inlineStylesheets: "auto"`；
- Vite 会把 CSS `@import` 在构建时内联，不产生额外运行时请求；
- 拆分后必须检查构建产物中的 `<link>` 顺序和 CSS 内容；
- CSP 当前校验的是内联脚本哈希；CSS 拆分不应改变脚本哈希，但仍需跑 `check:csp`。

---

## 7. 拆分方案（待执行）

按原文件连续行段切分，`index.css` 只按顺序 `@import`，不重排规则：

| 文件 | 原行段（1-based） | 职责 |
| --- | --- | --- |
| `variables.css` | 7764–7812 | 1.1 设计 token / `:root` |
| `reset.css` | 7813–7847 | `html/body/.os` 基础与 reset |
| `desktop-shell.css` | 7848–7930 | 壁纸与壁纸动画 |
| `menubar.css` | 7931–8359 | 菜单栏与移动端菜单控件 |
| `desktop-icons.css` | 8360–8898 | 桌面图标、图标绘制、桌面宠物 |
| `windows.css` | 8899–9115 | 窗口、标题栏、窗口预览 |
| `applications.css` | 9116–9979 | Finder/关于/终端/设置/音乐/成就/通知 |
| `overlays.css` | 9980–10347 | Spotlight + Mission Control |
| `widgets.css` | 10348–10664 | 桌面 Widget 与短屏适配 |
| `games.css` | 10665–12158 | 水族箱/访客/排队/抽奖/议会/树洞/新闻/社交/关机 |
| `boot.css` | 12159–12300 | 关机画面 + 开机动画 |
| `dock.css` | 12301–12383 | Dock |
| `responsive.css` | 12384–12954 | 手机卡片选择器、响应式、减少动效 |
| `apps-legacy.css` | 12955–13918 | 1.2 计算器/便签/监视器/日历/图片/浏览器/文件/终端 |
| `themes.css` | 13919–14978 | 浅色主题与相关覆盖 |
| `launchpad.css` | 14979–15239 | 启动台 |
| `os20.css` | 15240–17453 | 1.3/2.0 token、壁纸、Dock、图标、窗口、Widget、设置、菜单、Toast、浅色主题、按钮、图标、锁屏 |
| `responsive-final.css` | 17454–17562 | 2.0 减少动效 + 移动端最终覆盖 |

> 文件数量按真实内容决定；不会为了数量拆出空文件，也不会把所有内容塞进一个文件。

---

## 8. 验收基线

拆分前已保存 21 张确定性截图到 `.shots/phase-2.1-before/`：

- 1440×900：初始深色/浅色、Dock 隐藏/展开、菜单栏、窗口打开/最大化/拖动、多窗口、Widget、应用对话框（桌面卡片）；
- 1920×1080：初始、多窗口；
- 768×1024、1024×768：初始、窗口；
- 390×844、430×932：移动端页面 + 强制桌面布局。

> Spotlight 截图曾尝试，但 `Ctrl+K` 同时命中插件命令面板与内置 Spotlight，出现测试竞态；
> 未纳入像素对比，Spotlight 行为由现有 Playwright E2E 覆盖。

同时记录 `layout.json` 关键元素 boundingBox。

拆分后必须：

1. 生成 `.shots/phase-2.1-after/`；
2. 逐张像素对比 + boundingBox 对比；
3. 通过 `npm run verify`、24 项 Playwright、`check:astro`、`lint`、`check:csp`；
4. 不改变 200 KB 首屏 CSS 事实；若未达标，如实记录，不删样式凑数。