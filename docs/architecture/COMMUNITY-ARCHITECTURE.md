# 社区模块架构（Community）

**阶段**：Guandao OS 2.5（**批次 1 完成，批次 2 进行中**）
**状态**：`Partially Verified`
**最后核对**：2026-11-07
**入口**：`src/lib/os14/community.ts`（兼容入口，原路径不变）

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 原始规模 | **3,350 行 / 171,279 字节** |
| 公开导出 | **2 个**：`renderCommunity`、`initCommunity` |
| 本轮拆出 | **6 个模块 / 342 行**（类型、常量、通知文案、纯渲染工具） |
| `community.ts` 现在 | **3,147 行**（-203） |
| 公开 API 兼容 | ✅ 导出面仍为 `["initCommunity", "renderCommunity"]`（有测试锁定） |
| 全量门禁 | `verify` **195 单测**；E2E **64**；`qa:sync` 20/20 |
| 未完成 | `initCommunity` 内部 **73 个函数**仍在一个 3,000 行闭包里 |

---

## 2. 原始结构

```
src/lib/os14/community.ts (3,350 行)
├── L1–L67      导入（css / html / core / api / install / manifest / widgetstore …）
├── L68–L92     类型：Post, Role, ViewState, AssetRef, PublishState
├── L94–L145    常量：TYPE_LABEL, TYPE_GLYPH, STATUS_LABEL, ROLE_LABEL,
│                     REASON_LABEL, SEARCH_SORTS, LAYOUT_KEY, VIEW_KEY
├── L147–L293   纯渲染工具（~20 个）：
│                     esc, clampText, safeWallId, safeHex, timeAgo, bytesText,
│                     roleBadge, avatarHtml, coverHtml, postCard, pageNav,
│                     skeleton, loginGate, errorPanel, progressBar,
│                     typeChips, categoryChips, detailPermissionText
├── L296–L332   export renderCommunity()
└── L334–L3350  export initCommunity(win, ctx)
                 └── 73 个内层函数，全部共享同一个闭包
```

**关键发现**：除 2 个导出外，全部业务逻辑都在 `initCommunity` 这一个函数里。
73 个内层函数通过闭包共享 `state / meta / viewer / root / body / isStaff / isAdmin` 等变量。

---

## 3. 已拆出的模块（批次 1）

```
src/lib/os14/
├── community.ts              # 兼容入口（3,128 行，仍含 render/init）
└── community/
    ├── types.ts              #  32 行  类型定义
    ├── constants.ts          #  56 行  常量表与 storage key
    ├── notifications.ts      #  25 行  通知文案映射（批次 2）
    ├── context.ts            #  25 行  CommunityContext 接口（批次 2 关键）
    ├── loaders.ts            #  50 行  列表 loader（批次 2）
    └── ui.ts                 # 154 行  纯渲染工具（可独立单测）
```

### 3.5 context.ts —— 批次 2 的解锁点

`initCommunity` 的 3,000 行闭包里，内层函数靠闭包共享状态。
要让它们搬出去，必须先有一个**显式**的上下文：

```ts
export interface CommunityContext {
  setActiveNav(tab: string): void;
  needLogin(): boolean;
  setBody(html: string): void;
  showError(error: unknown): void;
  ensureMeta(): Promise<unknown>;
  emptyState(title: string, hint: string, glyph: string): string;
  nextToken(): number;
  isStale(token: number): boolean;
  readonly layout: string;
  readonly favoritesCollection: string;
}
```

**关键设计**：ctx **不复制状态**，`layout` / `favoritesCollection` 是 getter，
`nextToken` / `isStale` 是箭头函数——它们读的仍然是闭包里那**同一个**变量。
因此不存在「两份 state 不同步」的问题。

### 3.6 loaders.ts

`loadFollowing` / `loadFavorites` 两个 loader 已搬出，函数体逐字保留，
只把闭包引用改成 `ctx.xxx`：

| 原写法 | 现在 |
| --- | --- |
| `const token = ++loadToken` | `ctx.nextToken()` |
| `if (token !== loadToken) return` | `ctx.isStale(token)` |
| `setBody(...)` | `ctx.setBody(...)` |
| `${layout}` / `layout === "list"` | `ctx.layout` |
| `favoritesCollection` | `ctx.favoritesCollection` |

竞态令牌、加载顺序、渲染 HTML 全部未变。

### 3.4 notifications.ts（批次 2 第一个模块）

`notificationTitle` / `notificationBody` 原本定义在 `initCommunity` 闭包里，
但**完全不读闭包状态**——只是位置在闭包内。

搬出来用的是**大括号配对**定位（不是行号），因此不会切到注释中间。
行为完全不变，但现在可以单独测试：11 项单测覆盖 6 种通知类型、
未知类型回落、`payload.message` 优先、作者名拼接、空 payload 不崩溃。

### 3.1 types.ts

`Post`（= `api.CommunityPost`）、`Role`、`ViewState`、`AssetRef`、`PublishState`。
依赖：`../../community/api`、`../../community/manifest`（仅类型）。

### 3.2 constants.ts

`TYPE_LABEL`、`TYPE_GLYPH`、`STATUS_LABEL`、`ROLE_LABEL`、`REASON_LABEL`、
`SEARCH_SORTS`、`LAYOUT_KEY`、`VIEW_KEY`。纯数据，零运行时依赖。

### 3.3 ui.ts

从 `esc` 到 `detailPermissionText` 共 ~20 个函数。**这一层是纯函数**：
只接收参数、返回 HTML 字符串，不读闭包状态，因此可以脱离
`initCommunity` 单独测试（见 `tests/unit/community.test.ts`）。

依赖：
- `escapeHtml` / `safeUrl` → `../../html`（继续遵守 Phase 2.3 安全约定）
- `fmtAgo` → `../core`
- `CATEGORY_LABEL` → `../../community/manifest`
- 常量 → `./constants`，类型 → `./types`

---

## 4. 兼容入口设计

原文件**没有删除**，仍然导出 `renderCommunity` 和 `initCommunity`。
拆分出来的模块通过顶部 import 回填，`initCommunity` 内部的 73 个函数
继续用**完全相同的名字**访问类型、常量和工具函数。

```ts
// src/lib/os14/community.ts（顶部新增，原逻辑未动）
import type { AssetRef, Post, PublishState, Role, ViewState } from "./community/types";
import { LAYOUT_KEY, ... } from "./community/constants";
import { avatarHtml, esc, ... } from "./community/ui";
```

**副作用**：无。没有改变事件初始化时机、没有改变全局状态引用、没有产生第二份模块实例。

---

## 5. 公共导出列表

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `renderCommunity()` | function | 渲染社区入口 HTML |
| `initCommunity(win, ctx)` | function | 初始化社区窗口，返回 dispose 函数 |

有测试锁定：`Object.keys(community).sort()` 必须等于 `["initCommunity", "renderCommunity"]`。

---

## 6. 测试结果

| 文件 | 数量 | 覆盖 |
| --- | ---: | --- |
| `tests/unit/community.test.ts` | **11** | 导出兼容性、导出面锁定、`esc` 走统一转义、`clampText`、`bytesText`、`timeAgo`、通知标题/正文 5 项 |
| `tests/e2e/*`（全量） | **64** | 桌面、设置、市场、沙箱、安全、生命周期 |

`npm run verify`：**200 单测**，0 error，HTML 安全扫描通过（291 处 0 未审查）。
`npm run qa:sync`：**20/20**。

---

## 7. 尚未迁移的代码（批次 2–4）

`initCommunity` 内 **73 个函数**，按业务可归为：

| 批次 | 业务 | 代表函数 |
| --- | --- | --- |
| 2 | 列表 / 搜索 / 筛选 | `loadHome`、`loadExplore`、`loadSearch`、`loadCreators`、`loadCreator`、`loadFollowing`、`loadFavorites`、`loadNotifications`、`loadCreations` |
| 3 | 详情 / 互动 | `loadDetail`、`paintDetail`、`renderComments`、`renderComment`、`refreshComments` |
| 3 | 发布 / 上传 | `newPublishState`、`loadPublish`、`paintPublishForm` |
| 4 | 审核 / 预览 | `themePreviewPanel`、`widgetPreviewPanel`、`workspacePreviewPanel`、`licenseName`、`licenseSummary` |

### 7.1 符号级依赖分析（TypeScript 编译器 API）

用 AST 算出每个 loader 的**真实自由变量**（引用到、且不是自己声明的、且属于 `initCommunity` 闭包的）：

| loader | 自由变量数 | 其中 `CommunityContext` 还没有的 |
| --- | ---: | --- |
| `loadCreators` | 6 | `creatorsSort` |
| `loadExplore` | 7 | `explore` |
| `loadHome` | 7 | `meta`、`viewer` |
| `loadCreator` | 8 | `creatorPostSort`、`creatorPostType`、`view` |
| `loadNotifications` | 9 | `applyViewerChrome`、`meta`、`notificationsPage` |
| `loadSearch` | 9 | `loadHome`、`searchState`、`view` |
| `loadCreations` | 12 | `creationsStatus`、`creationsTab`、`creationsType`、`installedCache`、`meta` |

**结论：剩余 7 个 loader 没有一个能直接用当前 ctx 搬走。** 它们都需要先扩大接口，
而且其中多数是**可变状态**（`creatorsSort`、`explore`、`searchState`、`view`、`meta` 等会被写入），
ctx 必须同时提供 getter 和 setter，不能只读。

### 7.2 为什么批次 2 停在 2/9

前两次批量迁移失败的原因已经查清，都是「靠正则猜依赖」导致的：

| 失败 | 真实原因 |
| --- | --- |
| `creatorsSort is not defined` | 正则扫描没抓到它（声明形式不匹配我的模式）；AST 分析一跑就暴露了 |
| `loadExplore` 语法错误 | 带对象参数 `options: {...} = {}` 的函数，`bodyOf()` 从第一个 `{` 切，切进了参数解构 |
| `safeUrl` / `avatarHtml` 缺失 | 被搬走的部分引用了模块级 import，没有一起搬 |
| wrapper 参数不匹配 | 生成的包装函数丢了原参数表 |

AST 分析现在把这四类问题都变成了可预知的数据（见 §7.1 的表）。

### 7.3 下一步的正确做法

1. 按 §7.1 的表扩大 `CommunityContext`（可变项用 getter + setter）；
2. 每次只搬 **1 个** loader，搬完立刻 `tsc` + `verify`；
3. 用 AST 复核自由变量集合是否为空，而不是靠人工阅读。

**不要一次搬 4 个**——这正是本轮失败的原因。

---

## 8. 循环依赖与共享状态

- **循环依赖**：无。`community/` 三个模块只向下依赖 `../../html`、`../core`、`../../community/*`，不反向引用 `community.ts`。
- **共享状态**：仍是 `initCommunity` 内的闭包变量，**没有复制到新模块**。
  拆分只搬动了无状态部分，所以不存在两份状态的情况。

---

## 9. 后续维护规范

1. **继续把纯函数放进 `community/ui.ts`** —— 不读闭包状态的都归这里，并补单测。
2. **新增常量放 `community/constants.ts`**，不要散落在 `community.ts`。
3. **不要为了「看起来拆干净了」把闭包状态复制到多个文件**；需要共享时抽 context 对象。
4. 任何新模块都必须继续用 `escapeHtml` / `escapeAttr` / `safeUrl`，不得绕过 `src/lib/html.ts`。
5. 拆分后仍要跑：`npm run verify`、`npx playwright test`、`npm run check:html-security`。

---

## 10. 相关文档

- [`EVENT-LIFECYCLE.md`](EVENT-LIFECYCLE.md)：Phase 2.4 资源生命周期
- [`HTML-SECURITY.md`](HTML-SECURITY.md)：Phase 2.3 安全边界
- [`LEGACY-APPLICATIONS.md`](LEGACY-APPLICATIONS.md)：Phase 2.2 应用迁移
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图