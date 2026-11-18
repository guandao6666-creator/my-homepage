# 社区模块架构（Community）

**阶段**：Guandao OS 2.5（**批次 1–4 完成**）
**状态**：`Verified`（本地 + CI；生产行为未变，无生产部署）
**最后核对**：2026-11-14
**入口**：`src/lib/os14/community.ts`（兼容入口，原路径不变）

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 原始规模 | **3,350 行 / 171,279 字节** |
| 公开导出 | **2 个**：`renderCommunity`、`initCommunity`（测试锁定） |
| 本轮拆出 | **11 个模块 / 2,648 行** |
| `community.ts` 现在 | **1,271 行**（3,131 → 2,718 → 1,271，累计 -1,860） |
| `initCommunity` 内剩余函数 | 仅 DOM 事件代理、启动 IIFE、编排壳层与 9 个 loader wrapper（无独立业务闭包） |
| 行为兼容 | ✅ 导出面、事件委托、CSS 类名、localStorage 键、文案、计数语义均未变 |
| 门禁 | `npx tsc --noEmit` 0；`vitest tests/unit/community.test.ts` 11/11；lint/build/check:csp 通过；os20+desktop E2E 15 passed |

---

## 2. 原始结构（重构前）

```
src/lib/os14/community.ts (3,350 行)
├── L1–L67      导入（css / html / core / api / install / manifest / widgetstore …）
├── L68–L92     类型：Post, Role, ViewState, AssetRef, PublishState
├── L94–L145    常量：TYPE_LABEL, TYPE_GLYPH, STATUS_LABEL, ROLE_LABEL,
│                     REASON_LABEL, SEARCH_SORTS, LAYOUT_KEY, VIEW_KEY
├── L147–L293   纯渲染工具（~20 个）
├── L296–L332   export renderCommunity()
└── L334–L3350  export initCommunity(win, ctx)
                 └── 73 个内层函数，全部共享同一个闭包
```

关键事实：除 2 个导出外，全部业务逻辑都在 `initCommunity` 这一个函数里；
73 个内层函数通过闭包共享 `state / meta / viewer / root / body / isStaff / isAdmin` 等变量。

---

## 3. 最终模块结构

```
src/lib/os14/
├── community.ts                 # 1,271 行  兼容入口：事件代理 + 启动 IIFE + 编排 + 9 个 loader wrapper
└── community/
    ├── types.ts                 #   48 行  类型 + DetailCache / VersionState / ModerationTab
    ├── constants.ts             #   56 行  常量表与 storage key
    ├── context.ts               #  110 行  CommunityContext 接口（批次 2 关键）
    ├── notifications.ts         #   25 行  通知文案映射
    ├── ui.ts                    #  154 行  纯渲染工具（可独立单测）
    ├── loaders.ts               #  617 行  9 个列表/详情 loader
    ├── detail.ts                #  357 行  详情渲染、评论、预览面板、许可证文案
    ├── publish.ts               #  515 行  发布/版本表单、Manifest 构建、上传
    ├── interactions.ts          #  422 行  点赞/收藏/安装/更新/编辑/删除/举报/通知事件
    ├── moderation.ts            #  279 行  审核队列与审核动作
    └── upload.ts                #   65 行  图片选择与上传
```

### 3.1 批次 1：类型 / 常量 / 通知文案 / 纯渲染工具

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `Post`（= `api.CommunityPost`）、`Role`、`ViewState`、`AssetRef`、`PublishState`（批次 3/4 增加 `DetailCache`、`VersionState`、`ModerationTab`） |
| `constants.ts` | `TYPE_LABEL`、`TYPE_GLYPH`、`STATUS_LABEL`、`ROLE_LABEL`、`REASON_LABEL`、`SEARCH_SORTS`、`LAYOUT_KEY`、`VIEW_KEY` |
| `notifications.ts` | `notificationTitle` / `notificationBody`（原本在闭包里但完全不读闭包状态） |
| `ui.ts` | `esc` … `detailPermissionText` 约 20 个纯函数；依赖 `escapeHtml`/`safeUrl`（`../../html`）、`fmtAgo`（`../core`）、`CATEGORY_LABEL` |

### 3.2 批次 2：`CommunityContext` 扩容 + 9 个 loader

`context.ts` 在原有 10 项能力（`setActiveNav` / `needLogin` / `setBody` / `showError` /
`ensureMeta` / `emptyState` / `nextToken` / `isStale` / `layout` / `favoritesCollection`）之上新增：

```ts
getMeta(): CommunityMeta | null;
setMetaUnread(unread: number): void;
getViewer(): CommunityViewer | null;
applyViewerChrome(): void;
getExplore(): ExploreState;            // { type, category, sort, page }
getSearchState(): SearchState;          // { q, type, sort, page }
setView(view: ViewState): void;
getCreatorsSort(): string;  setCreatorsSort(value: string): void;
getCreatorPostType(): string; setCreatorPostType(value: string): void;
getCreatorPostSort(): string; setCreatorPostSort(value: string): void;
getCreationsTab(): CreationsTab;      setCreationsTab(value: CreationsTab): void;
getCreationsStatus(): string;         setCreationsStatus(value: string): void;
getCreationsType(): string;           setCreationsType(value: string): void;
getNotificationsPage(): number;       setNotificationsPage(value: number): void;
getInstalledCache(): InstallRecord[]; setInstalledCache(records: InstallRecord[]): void;
loadHome(): Promise<void>;
```

**关键设计**：ctx **不复制状态**。getter 返回闭包里同一份值/引用，setter 原地赋值；
不存在「两份 state 不同步」。

`loaders.ts` 迁移 9 个 loader：`loadHome`、`loadExplore`、`loadSearch`、`loadCreators`、
`loadCreator`、`loadFollowing`、`loadFavorites`、`loadNotifications`、`loadCreations`。
函数体逐字保留，只把闭包引用改成 `ctx.xxx`：

| 原写法 | 现在 |
| --- | --- |
| `const token = ++loadToken` | `ctx.nextToken()` |
| `if (token !== loadToken) return` | `ctx.isStale(token)` |
| `setBody(...)` | `ctx.setBody(...)` |
| `${layout}` / `layout === "list"` | `ctx.layout` |
| `favoritesCollection` | `ctx.favoritesCollection` |

竞态令牌、加载顺序、渲染 HTML 全部未变。

### 3.3 批次 3：详情 / 发布 / 交互 / 审核 / 上传

| 模块 | 搬迁函数 |
| --- | --- |
| `detail.ts` | `loadDetail`、`paintDetail`、`renderComments`、`renderComment`、`renderCommentComposer`、`themePreviewPanel`、`widgetPreviewPanel`、`workspacePreviewPanel`、`licenseName`、`licenseSummary`、`refreshComments` |
| `publish.ts` | `newPublishState`、`loadPublish`、`paintPublishForm`、`dataUrlPlaceholder`、`widgetFields`、`publishPackageFields`、`manifestSummary`、`paintPublishAssets`、`readFormValue`、`readChecked`、`buildManifest`、`paintVersionForm`、`submitPublish`、`submitVersion` |
| `interactions.ts` | `backToList`、`refreshPostButtons`、`toggleLike`、`toggleFavorite`、`installFlow`、`installVersion`、`newVersionFlow`、`editPostFlow`、`deletePostFlow`、`withdrawFlow`、`editMetaFlow`、`submitReport`、`handleInstalledAction`、`doUpdate`、`openPostFromEvent` |
| `moderation.ts` | `loadModeration`、`reviewModeration`、`reviewReport`、`onCommunityChange` |
| `upload.ts` | `pickImage`、`handleUpload`、`handleUploadMany` |

上下文再次扩 `win` / `toast` / `isStaff` / `isAdmin` / `getView` / `getLastTab` / `setLastTab`，
以及 `detailCache`、`publishState`、`versionState`、`moderationTab`、`moderationQueueStatus`、
`moderationReportStatus` 的 getter/setter（均返回闭包同一引用）。

---

## 4. 兼容入口设计

原文件**没有删除**，仍然导出 `renderCommunity` 和 `initCommunity`。
拆出的模块通过顶部 import 回填；`community.ts` 中对应旧函数体替换为同名 wrapper，
**DOM 事件委托层零改动**：

```ts
const loadDetail = (id: string) => loadDetailImpl(communityCtx, id);
const toggleLike = (postId: string) => toggleLikeImpl(communityCtx, postId);
```

保留在 `community.ts` 的内容（有意为之）：

- 2 个 `click`、`change`、2 个 `submit`、`keydown`、搜索按钮、window 监听与 cleanup；
- 启动 IIFE、openTab / setBody / showError / needLogin / run / ensureMeta / applyViewerChrome / setActiveNav；
- 9 个 loader wrapper、`communityCtx` 对象、`renderCommunity` / `initCommunity` 本体。

理由：这些是唯一入口的编排 / 事件委托 / 清理引用层，必须绑定同一 DOM 生命周期；
拆出去不会减少复杂度，反而会破坏事件委托与 cleanup 语义。

**副作用**：无。没有改变事件初始化时机、没有改变全局状态引用、没有产生第二份模块实例。

---

## 5. 公共导出列表

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `renderCommunity()` | function | 渲染社区入口 HTML |
| `initCommunity(win, ctx)` | function | 初始化社区窗口，返回 dispose 函数 |

`tests/unit/community.test.ts` 锁定：`Object.keys(community).sort()` 必须等于
`["initCommunity", "renderCommunity"]`。

---

## 6. 测试与门禁

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run tests/unit/community.test.ts` | 11/11（导出兼容、导出面锁定、转义、`clampText`、`bytesText`、`timeAgo`、通知文案） |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0（29 页，postbuild 生成 12 个 CSP 哈希） |
| `npm run check:csp` | exit 0（12 个哈希 / 30 个 HTML 一致） |
| `npx playwright test tests/e2e/os20.spec.ts tests/e2e/desktop.spec.ts --project=chromium` | 15 passed（os20 7 + desktop 8） |
| HTML 安全扫描 | 逐字搬迁：`community.ts` sink 13 → 7；`detail.ts` 1；`publish.ts` 5（合计仍 13，0 新增） |

---

## 7. 经验教训（批次 2–4）

前几轮批量迁移失败的原因已查清，全部是「靠正则/行号猜依赖」：

| 失败 | 真实原因 |
| --- | --- |
| `creatorsSort is not defined` | 正则扫描没抓到声明形式；AST 分析一跑就暴露 |
| `loadExplore` 语法错误 | 带对象参数 `options: {...} = {}` 的函数，按第一 `{` 切 body 会切进参数解构 |
| `safeUrl` / `avatarHtml` 缺失 | 被搬走的部分引用了模块级 import，没有一起搬 |
| wrapper 参数不匹配 | 生成的包装函数丢了原参数表 |

本次做法：

1. 先用 TypeScript 编译器 API 求每个函数的**真实自由变量**，把缺口补进 `CommunityContext`；
2. 每次只搬 1 个函数/1 组函数，搬完立刻 `tsc`；
3. 删除旧函数体用「函数起始 marker + 其后第一个同缩进 `};`」定位，并先做 EOL 归一化
   （文件是 CRLF；`\n` marker 匹配不到 CRLF）；
4. 全部搬完跑单测 + lint + build + check:csp + 相关 E2E。

---

## 8. 循环依赖与共享状态

- **循环依赖**：无。`community/` 各模块只向下依赖 `../../html`、`../core`、`../../community/*`、
  `./types` / `./constants` / `./context`，不反向引用 `community.ts`。
- **共享状态**：仍是 `initCommunity` 内的闭包变量，通过 `communityCtx` 的 getter/setter 暴露，
  **没有复制到新模块**。

---

## 9. 后续维护规范

1. **继续把纯函数放进 `community/ui.ts`**，并补单测。
2. **新增常量放 `community/constants.ts`**，不要散落在 `community.ts`。
3. **不要为了「看起来拆干净了」把闭包状态复制到多个文件**；需要共享时走 `CommunityContext`。
4. 任何新模块都必须继续用 `escapeHtml` / `escapeAttr` / `safeUrl`，不得绕过 `src/lib/html.ts`；
   新增 HTML sink 必须同步 `scripts/html-security-allowlist.json`。
5. 拆分后仍要跑：`npm run verify`、`npx playwright test`、`npm run check:html-security`。

---

## 10. 相关文档

- [`EVENT-LIFECYCLE.md`](EVENT-LIFECYCLE.md)：Phase 2.4 资源生命周期
- [`HTML-SECURITY.md`](HTML-SECURITY.md)：Phase 2.3 安全边界
- [`LEGACY-APPLICATIONS.md`](LEGACY-APPLICATIONS.md)：Phase 2.2 应用迁移
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图
