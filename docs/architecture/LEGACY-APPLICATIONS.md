# 旧版应用迁移（Legacy Applications）

**阶段**：Guandao OS 2.2（第二批：外壳能力接口化 + 高耦合应用迁移）
**状态**：`Verified`（16 / 17 个旧版应用已迁出；`settings` 按判断标准有意保留在外壳，理由见 §6）
**最后核对**：2026-11-14
**分支**：`feat/5.0-community-publishing-pipeline`
**范围**：把 `src/pages/index.astro` 里的旧版应用搬到 `src/lib/legacy-apps/`，并把它们依赖的外壳能力显式接口化为 `LegacyAppContext` 的 port；
未改窗口系统、App Registry、App Runtime、Core 启动流程、Dock、菜单栏、Worker、D1/R2、同步、PWA。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 迁移方式 | 复用 `registerApp`；应用只通过显式 `LegacyAppContext` 取依赖，不读闭包、不读全局 |
| 已迁移 | **16 个**：`posts` / `about` / `rank` / `calc` / `viewer`（第一批）+ `achievements` / `aquarium` / `visitors` / `draw` / `council` / `treehole` / `news` / `social` / `monitor` / `browser` / `terminal`（第二批） |
| 未迁移 | **1 个**：`settings`——按 §6 判断标准有意保留（纯透传，迁出去等于把耦合换个位置） |
| `index.astro` 行数 | **6,605 → 4,832**（−1,773；字节 283,037 → 209,758） |
| `src/lib/legacy-apps/` | **21 文件 / 2,639 行**（类型、5 类 port、16 个应用、2 份共享逻辑） |
| 新增 port | `shell` / `auth` / `lifecycle` / `achievements` / `desktopFacilities` 五类，全部白名单化并写明使用方 |
| 生命周期 | 所有应用内 `setInterval` / `setTimeout` / 全局事件监听统一走 `lifecycle` port，窗口关闭时由 `__gosCleanup` → `dispose(win)` 回收 |
| `APPS` 键序 | 与 1.0 完全一致（`terminal` 用字面量锚点占位，注册时原地覆盖；见 §4.5） |
| 回归证据 | E2E 全量 chromium **80 passed（2.8m）**（含 `legacy-apps.spec.ts` 25 项、`lifecycle.spec.ts` 2 项）；单测全量 **357/357**（含本文件 14 项）；`test` / `check:astro` / `lint` / `build` / `check:csp` 均绿，`check:html-security` 仅差新增 sink 的 allowlist 登记（见 §8.3） |
| 行为变化 | **无**：HTML 模板逐字节比对一致，class / data-* / 事件 / `guandao.*` 存储键零改动（见 §5.4） |

> **为什么是 Verified 而不是「100% 迁完」**：`settings` 的 12+ 项依赖全是外壳自己的状态
> （壁纸、主题、程序坞、小组件、数据备份），搬进模块只能靠十几个闭包透传维持等价行为，
> 既不减少耦合、也无法独立测试。按 §6 的判断标准，它应当留在外壳，等真正的
> Core Settings API 出现后再迁。

---

## 2. 迁移前的结构

### 2.1 单闭包问题

`index.astro` 的主脚本是一整个 IIFE：

```text
<script>                                    ← <script> 标签
  └── (() => {                              ← 唯一的闭包
        const boot / DATA / makeId / …      ← 300+ 个 IIFE 顶层声明
        const renderPosts / initTerminal …  ← 应用实现散落其中
        const APPS / registerApp …          ← 注册表也在同一个闭包
      })()
```

所有应用共享同一个词法作用域，因此「应用依赖什么」在代码里没有边界——
只能靠人工审计。这是本阶段要解决的根问题。

### 2.2 应用清单（迁移前）

行数取自实际行段；「外部依赖」指该段引用的 IIFE 顶层声明数量。

| 应用 | id | 行数（迁移前） | 主要依赖 | 迁移结论 |
| --- | --- | ---: | --- | --- |
| 文章 | `posts` | 27 | `DATA`, `escapeHtml` | ✅ 第一批 |
| 关于 | `about` | 20 | `DATA.site` | ✅ 第一批 |
| 排行榜 | `rank` | 114 | `DATA`, `escapeHtml`, `fetchWithTimeout` | ✅ 第一批 |
| 计算器 | `calc` | 77 | 无 | ✅ 第一批 |
| 图片查看器 | `viewer` | 92 | 无 | ✅ 第一批 |
| 浏览器 | `browser` | 65 | `escapeHtml`, `localStorage` | ✅ 第二批 |
| 每日抽奖 | `draw` | 85 | `unlock`, `localStorage`, `setTimeout` | ✅ 第二批 |
| 成就 | `achievements` | 23 | `ACHIEVEMENTS`, `readAch` | ✅ 第二批（`achievements` port） |
| 水族箱 | `aquarium` | 110 | `phaseNow`, `setInterval`, `setTimeout` | ✅ 第二批（`lifecycle` + `desktopFacilities.phase`） |
| 访客墙 | `visitors` | 196 | `DATA`, `makeId`, `fetchWithTimeout`, `escapeHtml` | ✅ 第二批 |
| 新闻联播 | `news` | 100 | `DATA`, `escapeHtml` | ✅ 第二批 |
| 系统监视器 | `monitor` | 74 | `OS_BOOT`, `windows`, `desks`, `APPS`, `setInterval` | ✅ 第二批（`desktopFacilities` + `lifecycle`） |
| 终端 | `terminal` | 197 | `openApp`/`closeWin`/`writeState`/`applyOsTheme`/`GOS14.terminal`… | ✅ 第二批（`shell` + `desktopFacilities` + `achievements`） |
| 匿名树洞 | `treehole` | 338 | 认证链路（`authFormHtml`/`readAuth`/`ensureFreshToken`） | ✅ 第二批（`auth` port） |
| 民主议会 | `council` | 274 | 认证链路 + `fetchWithTimeout` | ✅ 第二批（`auth` port） |
| 社会网络 | `social` | 348 | 认证链路 + `safeUrl` | ✅ 第二批（`auth` port） |
| 设置 | `settings` | 92 | 12 项外壳状态（壁纸/主题/Dock/小组件/数据备份…） | ❌ 保留（§6） |
| 便签 / 日历 / 文件 / 音乐 | — | 893 | — | **已是死代码**（第一批已删，§7） |

### 2.3 依赖关系图（迁移前）

```text
                ┌──────────────────────────── IIFE 闭包 ────────────────────────────┐
                │  DATA  makeId  escapeHtml  fetchWithTimeout  readState  writeState │
                │  openApp  closeWin  focusWin  pushNotif  unlock  readAch  …          │
                │                                                                     │
                │   renderPosts ──┐                                                  │
                │   renderAbout ──┤                                                  │
                │   renderRank ───┼──►  APPS (静态对象)  ──►  mountApp ──► 窗口       │
                │   renderCalc ───┤                                                  │
                │   renderViewer ─┘         ▲                                        │
                │                           │  registerApp(spec)                     │
                │                    os14 / os20 / 插件注册 ──┘                       │
                └─────────────────────────────────────────────────────────────────────┘
```

关键点：**`renderXxx` 不是通过参数拿到依赖的，而是直接读闭包变量**。

---

## 3. 迁移后的结构

```text
src/lib/legacy-apps/
├── index.ts                  # registerLegacyApps(ctx) + LEGACY_APPS 清单（1.0 键序）
├── types.ts                  # LegacyAppContext / 5 类 port / LegacyAppSpec / LegacyAppModule / OsData
├── lifecycle.ts              # 窗口级定时器与全局监听登记表（WeakMap，不依赖外壳闭包）
├── articles/index.ts         # posts（文章）
├── about/index.ts            # about（关于）
├── leaderboard/
│   ├── index.ts              # rank（排行榜窗口）
│   └── report.ts             # 停留时长上报：窗口与外壳共用一份
├── calc/index.ts             # 计算器
├── viewer/index.ts           # 图片查看器
├── achievements/index.ts     # 成就（body-only）
├── aquarium/index.ts         # 水族箱
├── visitors/index.ts         # 访客墙
├── draw/
│   ├── index.ts              # 每日抽奖
│   └── quotes.ts             # 签文：抽奖应用与桌面「今日一句」小组件共用
├── council/index.ts          # 民主议会
├── treehole/index.ts         # 匿名树洞
├── news/index.ts             # 新闻联播
├── social/index.ts           # 社会网络
├── monitor/index.ts          # 系统监视器
├── browser/index.ts          # 浏览器
└── terminal/index.ts         # 终端
```

**没有 `adapters/` 目录**：外壳能力已经在 `LegacyAppContext` 里声明，
适配器本身就是 `index.astro` 里那个带类型的对象字面量（§4.2），再套一层属于无意义抽象。

---

## 4. Adapter 设计

### 4.1 契约（`src/lib/legacy-apps/types.ts`）

`LegacyAppContext` 由「构建期数据 + 5 类白名单 port」组成。每个字段都注明
**谁在用、为什么必须暴露**；没有出现的闭包变量，应用就碰不到。

```ts
export type LegacyAppContext = {
  // ── 基础能力（第一批就存在） ────────────────────────────────
  escapeHtml: (text: string) => string;                     // 全部应用；复用外壳转义，不建第 2 份
  data: OsData;                                             // posts/about/news/rank/visitors/council/treehole/social/terminal
  fetchWithTimeout: (url, init?, ms?) => Promise<Response>; // rank/visitors/council/treehole/social；统一超时语义
  register: (spec: LegacyAppSpec) => void;                  // 注册入口，必须复用 index.astro 的 registerApp

  shell: LegacyShellPort;                 // 终端、访客墙
  auth: LegacyAuthPort;                   // 议会、树洞、社会网络
  lifecycle: LegacyLifecyclePort;         // 水族箱、系统监视器、抽奖（以及所有应用的关闭清理）
  achievements: LegacyAchievementsPort;   // 成就页（读）、抽奖与终端（写）
  desktopFacilities: LegacyDesktopFacilitiesPort; // 水族箱、监视器、终端
};

/** 外壳命令：应用可以主动改变窗口/主题/壁纸，但不能拿到外壳实现 */
export interface LegacyShellPort {
  /** 终端 `exit` 关闭自己；其它应用不需要 */
  closeWindow: (win: HTMLElement) => void;
  /** 终端 `theme` 命令；写 body[data-os-theme] + localStorage */
  setTheme: (theme: "dark" | "light") => void;
  /** 终端 `wallpaper` 命令；写 os[data-wall] + localStorage */
  setWallpaper: (wall: string) => void;
  /** 终端未知命令委托：os14/插件注册进来的命令，返回输出文本或 null */
  runExtensionCommand: (name: string) => string | null;
  /** 访客墙上传文件名需要与外壳一致的随机 id（不是 Math.random 的临时实现） */
  makeId: () => string;
}

/** 认证会话：只暴露「表单 + 身份 + 续期 + 退出 + 变更通知」，不暴露 supabase 客户端 */
export interface LegacyAuthPort {
  /** 统一登录表单 HTML（议会/树洞/社会网络共用，保证三处样式与字段一致） */
  formHtml: () => string;
  /** 当前会话（含 token/refresh/uid/email/at），未登录为 null */
  read: () => LegacyAuthState | null;
  /** 过期前自动刷新；失败会清空会话并返回 null（三处网络请求都要先续期） */
  ensureFreshToken: () => Promise<string | null>;
  /** 社会网络「退出」按钮 */
  signOut: () => void;
  /** 订阅 `guandao:auth-change`：窗口内切号后重建 authBox / 重拉数据 */
  onChange: (win: HTMLElement, handler: () => void) => void;
}

/** 窗口级生命周期：应用自己开的计时器/全局监听必须在这里登记 */
export interface LegacyLifecyclePort {
  interval: (win: HTMLElement, handler: () => void, ms: number) => number;
  timeout: (win: HTMLElement, handler: () => void, ms: number) => number;
  onGlobal: (win: HTMLElement, type: string, handler: EventListener) => void;
  /** 由 registerLegacyApps 的 cleanup 统一调用：清 interval/timeout/监听并删作用域 */
  dispose: (win: HTMLElement) => void;
}

/** 成就系统：成就页只读；抽奖/终端写入 */
export interface LegacyAchievementsPort {
  list: () => readonly LegacyAchievement[];
  state: () => LegacyAchievementState;
  /** 返回是否新解锁；silent 时不弹 toast/通知（终端首次命令静默解锁） */
  unlock: (id: string, silent?: boolean) => boolean;
}

/** 桌面设施：只读快照，避免应用直接操作 #windows / desks / APPS */
export interface LegacyDesktopFacilitiesPort {
  openWindowCount: () => number;                 // 监视器、终端 neofetch
  openWindowTitles: () => string[];              // 监视器「运行中的应用」
  deskCount: () => number;                       // 监视器、终端 neofetch
  bootedAt: number;                              // 监视器「已开启」、终端 neofetch
  appTitles: () => string[];                     // 终端 `apps` 命令
  phase: () => LegacyDayPhase;                   // 水族箱昼夜文案与 data-phase
}
```

应用模块统一形状（未变化）：

```ts
export type LegacyAppModule = {
  id: string; title: string; width: number; height: number; glyph?: string;
  body: (ctx: LegacyAppContext) => string;
  init?: (win: HTMLElement, ctx: LegacyAppContext) => void | (() => void);
};
```

### 4.2 接线点（`index.astro`）

在 `loadingSkeleton` 之后、`renderDock()` 之前：

```ts
registerLegacyApps({
  escapeHtml,
  data: DATA,
  fetchWithTimeout,
  register: registerApp,
  lifecycle: legacyWindowLifecycle,
  shell: {
    closeWindow: (win) => closeWin(win),
    setTheme: (theme) => applyOsTheme(theme),
    setWallpaper: (wall) => { os.dataset.wall = wall; writeState({ wall }); },
    runExtensionCommand: (name) => window.GOS14?.terminal?.(name) ?? null,
    makeId: () => makeId(),
  },
  auth: {
    formHtml: () => authFormHtml(),
    read: () => readAuth(),
    ensureFreshToken: () => ensureFreshToken(),
    signOut: () => writeAuth(null),
    onChange: (win, handler) => legacyWindowLifecycle.onGlobal(win, "guandao:auth-change", handler),
  },
  achievements: {
    list: () => ACHIEVEMENTS,
    state: () => readAch(),
    unlock: (id, silent) => unlock(id, silent ?? false),
  },
  desktopFacilities: {
    openWindowCount: () => windows.querySelectorAll(".window").length,
    openWindowTitles: () => Array.from(windows.querySelectorAll<HTMLElement>(".window"))
      .map((el) => APPS[el.dataset.app ?? ""]?.title ?? el.dataset.app ?? ""),
    deskCount: () => desks.length,
    bootedAt: OS_BOOT,
    appTitles: () => Object.values(APPS).map((app) => app.title),
    phase: () => phaseNow(),
  },
});
```

三点约束，写进代码注释里防止以后被改坏：

1. **必须在 `renderDock()` 之前**——程序坞按 `APPS` 过滤，注册晚了图标会消失；
2. **必须复用 `registerApp`**——不新建第二个注册中心；
3. **不把闭包整体传进去**——只传清单里列出的能力，新增能力要显式加字段并注明使用方。

### 4.3 生命周期接线

`registerLegacyApps` 把模块 `init` 统一包一层：

```ts
init: (win) => {
  const cleanup = app.init?.(win, ctx);
  return () => {
    cleanup?.();
    ctx.lifecycle.dispose(win);   // 应用没手动清的 interval/timeout/监听，这里兜底
  };
}
```

`cleanup` 由 `mountApp` 写进 `win.__gosCleanup`，`closeWin` 在移除窗口 DOM 之前调用并清空——
与 1.0 的 `__gosCleanup` 语义完全一致，只是多了一步 port 侧的兜底回收。

`lifecycle.ts` 用 `WeakMap<HTMLElement, { intervals, timeouts, listeners }>` 记录，
`dispose(win)` 清三类并删除作用域；`timeout` 回调执行前会把自己的 id 从登记表移除。
它不读外壳任何闭包，因此单测可以独立覆盖（`tests/unit/legacy-apps.test.ts`）。

### 4.4 与现有架构的关系

| 层 | 是否改动 |
| --- | --- |
| `src/lib/core/registry.ts`（2.0 App Registry） | 未改 |
| `src/lib/core/runtime.ts`（App Runtime） | 未改 |
| `src/lib/os20/bridge.ts`（Core ↔ 旧 Shell） | 未改 |
| `index.astro` 的 `registerApp` / `APPS` / `APP_INIT` | 未改，只被调用 |
| `mountApp` 的 init 分派 | 仅删除已迁移应用的 `legacyInit` 分支，最后只剩 `settings` |

迁移后的应用走**既有**的两条路径之一：

- 有 `init` 的 → `APP_INIT[id]`，由 `runInit` 执行；
- 只有 `body` 的 → 直接渲染，无初始化。

### 4.5 APPS 键序锚点

`Object.keys(APPS)` 的顺序会出现在启动台网格、设置页程序坞勾选列表、终端 `apps` 命令、
「最近打开」小组件和 os14 的 `ctx.APPS` 里，**必须保持 1.0 时的顺序**：

```text
terminal, settings, achievements, aquarium, visitors, draw, council, treehole,
news, social, monitor, browser, posts, about, rank, calc, viewer, …
```

`terminal` 是这一批唯一会**原地覆盖**字面量条目的应用。为避免 `registerApp` 把它追加到末尾，
`APPS` 里保留一行键序锚点：

```ts
terminal: { title: "终端", width: 560, height: 360, body: () => "", glyph: "di-term" },
// 键序锚点：真实 body/init 由 registerLegacyApps 覆盖，保持 1.0 时 APPS 键序 terminal 在第一位
```

`registerApp` 对已存在的键是赋值（不改位置），所以运行时顺序不变。
`legacy-apps.spec.ts` 有一条用例直接断言 `Object.keys(APPS).slice(0, 17)`，防止以后回退。

### 4.6 6.1 懒加载接线（按需下载应用实现）

Phase 6.1 把 16 个应用的**实现**移出入口 chunk，元数据仍同步可读：

```ts
// manifest.ts：只有元数据 + loader，几十字节一条
{ id: "achievements", title: "成就", width: 540, height: 476, glyph: "di-ach",
  load: () => import("./achievements").then((m) => m.achievementsApp) }

// index.ts：统一走外壳既有的 load() 通道
ctx.register({ id, title, width, height, glyph,
  load: () => entry.load().then((app) => adapt(app, ctx)) });
```

- 元数据必须同步：程序坞、启动台、终端 `apps` 在注册阶段就要读标题与图标，晚一帧就会缺格子。
- 实现异步：`mountApp` 先渲染 `loadingSkeleton`，chunk 到齐后替换 `.win-body` 并执行 `init`；
  12 秒未完成显示崩溃卡片（可重试），加载失败只影响这一个窗口。
- 元数据在两处出现（清单 + 模块导出），由单测「清单元数据与模块导出完全一致」守住，不接受漂移。
- 与 os14 应用使用**同一条**懒加载通道，没有第二套机制；`LegacyAppSpec.body` 保留但当前无人使用。

已验证的边界：`load()` 返回的 `body()` 与模块直接调用逐字节一致；
init 仍由 `adapt()` 包一层 `lifecycle.dispose` 兜底清理。

---

## 5. 已迁移应用

### 5.1 第一批（Phase 2.2 前半）

| 应用 | 模块 | 依赖 | 生命周期 | 验证 |
| --- | --- | --- | --- | --- |
| 文章 `posts` | `articles/index.ts` | `data`, `escapeHtml` | 无 init | E2E 程序坞打开 + 列表非空 + 关闭 |
| 关于 `about` | `about/index.ts` | `data` | 无 init | E2E 作者名 + 站内链接 |
| 排行榜 `rank` | `leaderboard/index.ts` | `data`, `escapeHtml`, `fetchWithTimeout` | `init` 绑定加入按钮、加载列表 | E2E 状态文案不是「正在加载…」 |
| 计算器 `calc` | `calc/index.ts` | 无 | `init` 绑定按键 + 键盘 | E2E 7+8=15、历史记录、重开清零 |
| 图片查看器 `viewer` | `viewer/index.ts` | 无 | `init` 绑定工具栏 | E2E 空状态 + 工具栏 |

### 5.2 第二批（本次，外壳能力接口化后）

| 应用 | 模块（行数） | port 依赖 | 生命周期 | E2E |
| --- | --- | --- | --- | --- |
| 成就 `achievements` | `achievements/index.ts`（39） | `achievements` | 无 init（body-only） | `.ach` 11 项、计数含 `/ 11` |
| 水族箱 `aquarium` | `aquarium/index.ts`（115） | `desktopFacilities.phase`, `lifecycle` | `init`：2 个 interval（60s 相位 / 2.3s 瞌睡泡）+ 投喂 timeout | `.fish` 7 条、点击出现食物、开关 5 次计数器不增长 |
| 访客墙 `visitors` | `visitors/index.ts`（208） | `data`, `fetchWithTimeout`, `escapeHtml`, `shell.makeId` | `init` 绑定上传表单 | 加载态结束、展开表单、提交校验提示 |
| 每日抽奖 `draw` | `draw/index.ts`（69）+ `quotes.ts`（35） | `achievements`, `lifecycle` | `init`：抽签 timeout 900ms | 初始文案 → 点击 → 结果写入 `guandao.draw.v1` |
| 议会 `council` | `council/index.ts`（259） | `data`, `fetchWithTimeout`, `escapeHtml`, `auth` | `init`：`auth.onChange` 订阅，无定时器 | 加载态结束、未登录出现登录表单 |
| 树洞 `treehole` | `treehole/index.ts`（348） | `data`, `fetchWithTimeout`, `escapeHtml`, `auth` | `init`：`auth.onChange` 订阅，无定时器 | 未登录锁输入、`0 / 500`、登录表单可见 |
| 新闻联播 `news` | `news/index.ts`（110） | `data`, `escapeHtml` | `init`：日期种子 + 4 条新闻 | 标题、日期、4 条 |
| 社会网络 `social` | `social/index.ts`（360） | `data`, `fetchWithTimeout`, `escapeHtml`, `auth`, `safeUrl` | `init`：`auth.onChange` 订阅 | 加载态结束、离线列表有明确空态 |
| 系统监视器 `monitor` | `monitor/index.ts`（76） | `desktopFacilities`, `lifecycle`, `escapeHtml` | `init`：2 个 interval（1.5s tick / 2s update） | 指标含 `%`、窗口数/桌面数/存储非空 |
| 浏览器 `browser` | `browser/index.ts`（77） | `escapeHtml` | 无 init 定时器；历史写 `guandao.os.browser.v1` | 快捷入口、输入网址 → 历史持久化 |
| 终端 `terminal` | `terminal/index.ts`（207） | `data`, `shell`, `desktopFacilities`, `achievements` | `init` 绑定键盘；无定时器 | `help` / `version` 真实输出；开关 10 次无残留（lifecycle 用例） |

### 5.3 共享逻辑处理

| 共享逻辑 | 做法 | 原因 |
| --- | --- | --- |
| 排行榜停留时长上报 | `leaderboard/report.ts`，窗口与外壳共用一份 | 键名 `guandao.rank.name` 与 POST body 必须只有一份实现 |
| 抽签签文 | `draw/quotes.ts`（`DRAW_QUOTES` / `DRAW_BONUS`），抽奖应用与「今日一句」小组件共用 | 应用模块不能被外壳 `import` 反向依赖，放中立共享模块避免两处漂移 |
| 认证表单与续期 | `auth` port，议会/树洞/社会网络三处共用 `authFormHtml` / `ensureFreshToken` | 三处都必须处理 token 续期与 `guandao:auth-change`，各抄一份必然漂移 |

### 5.4 保真校验（本次迁移的关键证据）

迁移完成后用三个一次性脚本把「迁移前（git HEAD）的 `index.astro`」与「新模块」逐项比对：

| 校验 | 方法 | 结果 |
| --- | --- | --- |
| `body` HTML 模板 | 提取原 `renderXxx` 模板字符串，去掉首尾空白后与模块 `body` 对比 | 9 个模板应用逐字节一致；`achievements` / `aquarium` 是 brace 渲染函数，人工核对逻辑等价（仅把 `ACHIEVEMENTS` / `readAch` / `phaseNow` 换成 port 调用） |
| APPS 元数据 | 对比 id / title / width / height / glyph | 一致；修正了 4 个模块里被手写改错的标题（`draw`→每日抽奖、`monitor`→系统监视器、`council`→议会、`treehole`→树洞） |
| 字符串字面量 | 提取原 `render`/`init` 的全部字符串，检查是否仍出现在模块中 | 用户可见文案、选择器、URL、`guandao.*` 存储键全部保留；差异仅为预期的 port 改名（`DATA.`→`data.`、`authFormHtml`→`auth.formHtml`、`readAuth`→`auth.read`、`makeId`→`shell.makeId` 等） |

因此 **DOM 结构 / class / `data-*` / 事件绑定 / 存储键零变化**，视觉与行为回归由 §8 的 E2E 兜底。

### 5.5 审计中踩到的坑（记录）

1. 第一轮依赖审计脚本用「区块起始行 → 下一个 banner」切分，把 APPS 对象误算进「文件管理器」区块，
   得出 `renderFiles` 依赖 20 个 `renderXxx` 的错误结论。**脚本依赖表必须用 grep 复核。**
2. PowerShell `-replace` 默认**大小写不敏感**：对抽奖模块做 `\bBONUS\b` / `\bQUOTES\b` 替换时
   把 `is-bonus`、`saved.bonus`、`bonus: isBonus`、`import "./quotes"` 一起改坏。
   含标识符的批量替换改用 Node 脚本或 `edit` 工具。
3. `registerApp` 对**已存在的键**是原地赋值，这是 §4.5 用字面量锚点保住 `terminal` 首位的前提；
   如果改成 `delete` 再赋值，键序会变，启动台第一格会跑掉。

---

## 6. 未迁移应用与原因

| 应用 | 结论 | 原因 |
| --- | --- | --- |
| 设置 `settings` | **有意保留在外壳** | 见下方逐项清单 |

`initSettings` 直接操作的外壳能力（12+ 项）：

| 能力 | 用途 |
| --- | --- |
| `os.dataset.wall` + `writeState({ wall })` | 壁纸切换（设置页是**唯一**的壁纸入口之一，另一个是终端命令） |
| `applyOsTheme` | 深/浅主题切换 |
| `saveDock` + `renderDock` | 程序坞勾选（设置页直接改 Dock 数据并立即重绘） |
| `writeState({ autoWall })` + `applyTimeWallpaper` + `os.dataset.autoWall` | 自动壁纸 |
| `writeState({ showIcons })` + `.desk-icons.hidden` | 显示桌面图标 |
| `writeState({ showPet })` + `#desk-pet.hidden` | 显示桌面宠物 |
| `writeState({ reduceMotion })` + `body.classList` | 减少动效 |
| `setWidgetEnabled` + `guandao:widgets-change` 监听 + `syncWidgetBoxes` | 小组件开关与联动 |
| `exportData` / `importData` / `resetAllData` + `confirm` | 数据备份 / 恢复 / 重置 |
| `readState()` | 渲染当前设置状态 |

**为什么迁出去等于把耦合换个位置**：这些能力没有一个是「应用可独立使用」的语义，
它们全是外壳自身的状态与 UI 联动。要迁移就必须在 `LegacyAppContext` 里再加一个
`settingsPort`，把上面每一行变成 1:1 的方法——模块里仍然是一个个外壳调用，
只是多了一层接口；既不能独立测试，也没有减少 `index.astro` 的行数。

**后续若要迁需要补什么**：应该先有「Core Settings API」（读/写用户设置、订阅变更、
数据备份属于平台能力），`settings` 应用只调用这套 API；在此之前按 §6 判断标准保留。

> 判断标准：如果一个应用迁出去需要在模块里重建 10 个以上外壳调用，
> 那不是解耦，只是把耦合搬了个地方。本阶段不为了凑数量硬迁。

---

## 7. 死代码清理（第一批已完成）

`notes` / `calendar` / `files` / `music` 的旧实现已被 `os14` 同名应用覆盖，
第一批迁移时已删除 **831 行实现 + 8 行登记项**，并补了一次 `openFromHash()`
让 `#notes` 这类直达链接在 os14 注册后仍然可用。

证据：`os14/index.ts` 的注册循环注释「直接注册：同名内置应用会被 1.9 的实现覆盖」；
`mountApp` 先查 `APP_INIT`，os14 的 `load()` 会写入 `APP_INIT[id]`，`legacyInit` 不可能命中；
仓库内没有 `#notes` / `#calendar` / `#files` / `#music` 链接；删除后 `tsc` / `astro check` 均 0 error。

`tests/e2e/legacy-apps.spec.ts` 保留 4 个回归用例，确认这 4 个应用仍能打开、不是崩溃卡片。

---

## 8. 测试证据

### 8.1 E2E

命令（端口覆盖见 §11）：

```powershell
$env:E2E_API_PORT='18788'; $env:E2E_ADMIN_PORT='18789'
npx playwright test tests/e2e/legacy-apps.spec.ts --project=chromium
```

- `legacy-apps.spec.ts`：**25 passed（1.3m）**——第一批 12 项 + 本次新增 13 项（11 个应用逐个打开/交互/关闭 + APPS 键序 + 生命周期回收）。
- 全量 chromium project：**80 passed（2.8m）**，含 `desktop.spec.ts` 8 项、`lifecycle.spec.ts` 2 项（计数基线全部持平）。
- 生命周期用例读「性能实验室」真实计数器：水族箱 / 监视器各开关 5 次后
  `listeners 5 → 5、timeouts 1 → 1、intervals 1 → 1`；`lifecycle.spec.ts` 的 20 次计算器开关与
  10 次终端开关同样全项持平（`rafs 0 → 0、scopes 7 → 7、observers 4 → 4、objectUrls 0 → 0`）。

新增 13 项用例覆盖：

| # | 用例 | 关键断言 |
| --- | --- | --- |
| 1 | APPS 1.0 键序 | `Object.keys(APPS).slice(0, 17)` 与 §4.5 完全一致 |
| 2 | 终端 | `help` → 「可用命令」；`version` → 「Guandao OS 2.0 · The Platform Era」 |
| 3 | 每日抽奖 | 初始「每天可以抽一张，明天再来」→ 点击 → `#draw-mark` 变化 + `guandao.draw.v1` 写入 |
| 4 | 水族箱 | `.fish` 7 条、提示非空、点击出现 `.food` |
| 5 | 监视器 | CPU/内存含 `%`、运行窗口 ≥1、桌面数 ≥1、存储非「—」、窗口数随后刷新为真实值 |
| 6 | 新闻联播 | 标题、日期非空、4 条新闻 |
| 7 | 浏览器 | 快捷入口、空历史 → 输入网址 → 新标签打开 → 重开后历史含该网址 |
| 8 | 成就 | 11 项 + 「已解锁 / 11」 |
| 9 | 访客墙 | 加载态结束、展开上传表单、提交给出校验文案 |
| 10 | 议会 | 加载态结束、未登录渲染登录表单 |
| 11 | 树洞 | 未登录时输入/发送 disabled、`0 / 500`、登录表单可见 |
| 12 | 社交名片 | 加载态结束、离线列表有明确空态 |
| 13 | 生命周期 | 水族箱/监视器各开关 5 次，窗口数回基线，三项计数器不增长，关闭后水族箱仍可用 |

### 8.2 单测

`tests/unit/legacy-apps.test.ts`：**14 / 14 passed**；全量单测 `npx vitest run`：**19 files / 357 tests passed**。

- 清单顺序 = §4.5 的 1.0 键序（`posts` 的目录是 `articles`、`rank` 的目录是 `leaderboard`，id 与目录不同名）；
- id 唯一、格式合法、`body(ctx)` 返回非空字符串；
- `registerLegacyApps` **只**通过传入的 `register` 注册，注册顺序 = 清单顺序；
- 有 `init` 的应用集合恰为 `aquarium / browser / calc / council / draw / monitor / news / rank / social / terminal / treehole / viewer / visitors`；
- **模块源码不读外壳闭包**：对每个模块文件做「去注释后禁止出现 `readAuth` / `authFormHtml` / `readAch(` / `phaseNow(` / `applyOsTheme` / `writeState` / `querySelectorAll(".window")` / `OS_BOOT` / `window.__OS__` / `window.GOS14`」扫描；
- `lifecycle` port：interval/timeout/onGlobal 登记与 `dispose` 清理；`registerLegacyApps` 的 init 包装在 cleanup 时调用 `dispose(win)`；
- `DRAW_QUOTES` 28 条唯一 + `DRAW_BONUS` 精确值；
- 排行榜上报原 4 例（键名/未配置不发请求/POST `report_time` body/失败吞掉）。

### 8.3 全量门禁

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（exit 0） |
| `npm run check:astro` | 345 files，0 error / 0 warning（163 hints） |
| `npm run lint` | 通过（exit 0） |
| `npm run test` | 通过：版本/迁移检查 + typecheck + 单测 19 files / 357 tests + 安全测试（D1 恢复 4/4、安全日志 6/6 等） |
| `npm run build` | 29 页 + postbuild CSP 12 个内联脚本哈希 |
| `npx playwright test --project=chromium` | **80 passed（2.8m）** |
| `npm run check:csp` | 通过：12 个哈希与 30 个 HTML 一致 |
| `npm run check:html-security` | **未通过（预期）**：291 处 sink / 未登记 65 处（新增 legacy-apps 模块与社区拆分文件），等 Lead 统一更新 `scripts/html-security-allowlist.json` |

> `npm run verify` 的失败点只有 `check:html-security`（第 4 步，属 allowlist 未更新），
> 其余步骤已逐项单独运行并全部通过；`qa:prod` 按任务要求未运行。

---

## 9. 代码规模

| 指标 | 第一批前 | 第一批后 | 本次前 | 本次后 | 本次变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `index.astro` 行数 | 7,765 | 6,605 | 6,605 | **4,832** | −1,773 |
| `index.astro` 字节 | 331,283 | 283,007 | 283,037 | **209,758** | −73,279 |
| `src/lib/legacy-apps/` | 0 | 8 文件 / 470 行 | 8 文件 / 470 行 | **21 文件 / 2,639 行** | +2,169 |
| `APPS` 静态条目 | 21 | 12 | 12 | **2**（terminal 锚点 + settings） | −10 |
| `legacyInit` 分支 | 18 | 11 | 11 | **1**（settings） | −10 |

模块总量增加是正常的：它包含 5 类 port 的类型声明、生命周期实现、16 个应用与 2 份共享逻辑；
`index.astro` 减少的是原先内联在闭包里的应用实现。

### 9.1 6.1 懒加载收益（2026-11-18 实测）

| 项 | 6.1 前 | 6.1 后 | 变化 |
| --- | ---: | ---: | ---: |
| 入口 chunk（`index.astro_astro_type_script`） | 525,102 B | **482,939 B** | −42,163 B（−8.0%） |
| 应用分块总量 | 0（全在入口） | 76,003 B / 18 文件 | 按需下载 |
| 单测 | 13 项 | **16 项** | +3（元数据漂移、load/body 一致性、按需注册） |
| 入口 chunk 相对 450 KB 预算 | +75 KB | **+33 KB** | 未达标，剩余差距见下 |

剩余体积归因（sourcemap 按生成字符统计，入口 445,777 字符）：
`index.astro` 内联脚本 15.8%、`os13.ts` 10.4%、`widgetstore.ts` 6.6%、`catalog.ts` 4.5%、
`plugins/host.ts` 4.3%、`plugins/registry.ts` 3.4%、`account/client.ts` 3.3%。
其中 `os13.ts` 是 2,397 行紧耦合闭包（壁纸 / 图标 / Dock / 控制中心 / 设置面板），
按「不为减行数硬拆」的约束不在本阶段动，留待 Core Settings API。

---

## 10. 剩余技术债

| # | 债 | 影响 | 建议阶段 |
| --- | --- | --- | --- |
| 1 | `settings` 仍在外壳 | 设置页无法独立测试；壁纸/主题/Dock/小组件/备份能力仍耦合 | 等 Core Settings API |
| 2 | `initRank` 的 `void load()` 未随窗口关闭取消 | 关窗后仍会写已脱离文档的节点（不抛错、不泄漏处理器） | Phase 2.4（统一用 `lifecycle` + AbortController 处理请求取消） |
| 3 | `LegacyAppContext` 之外的通用清理（fetch 取消）尚无 port | 网络请求不能随窗口取消 | Phase 2.4 与 #2 一起做 |
| 4 | 应用级单测仍依赖真实 DOM | `init` 主要靠 E2E 与 lifecycle 单测覆盖 | 可选：补 jsdom 脚手架 |

已关闭：

- ~~12 个应用仍读闭包~~ → 本次迁出 11 个，仅 `settings` 按标准保留；
- ~~`LegacyAppContext` 只有 4 个能力~~ → 扩展为 5 类 port（§4.1）；
- ~~应用内定时器/监听泄漏~~ → `lifecycle` port + `dispose` 兜底，E2E 计数基线验证。

---

## 11. 复现命令

```powershell
npm run build                 # E2E 跑的是构建产物
npx tsc --noEmit              # 新模块类型检查
npm run check:astro           # index.astro 检查
npx vitest run tests/unit/legacy-apps.test.ts

# E2E：本机 8789 被代理软件占用，用环境变量把 API/管理端口挪开
$env:E2E_API_PORT='18788'; $env:E2E_ADMIN_PORT='18789'
npx playwright test tests/e2e/legacy-apps.spec.ts --project=chromium
npx playwright test --project=chromium

# 全量
npm run verify
$env:TEMP = "$PWD\.wrangler\tmpdir"; $env:TMP = $env:TEMP
npm run qa:sync
```

并发跑 E2E 会共用 `.wrangler/state`（本地 D1），导致 `e2e-server` 夹具登记 401 或启动竞态；
**同一工作区同一时间只跑一个 playwright 进程**。

---

## 12. 相关文档

- [`docs/architecture/DESKTOP-CSS.md`](DESKTOP-CSS.md)：Phase 2.1 桌面 CSS 架构
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图
- [`GUANDAO_2_0_AUDIT.md`](../../GUANDAO_2_0_AUDIT.md)：总体审计
- [`docs/ACCEPTANCE-2.0.md`](../ACCEPTANCE-2.0.md)：验收清单
