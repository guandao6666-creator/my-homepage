# 旧版应用迁移（Legacy Applications）

**阶段**：Guandao OS 2.2
**状态**：`Partially Verified`（5 个低耦合应用已迁移并有回归证据；12 个高耦合应用需前置的 Core 能力）
**最后核对**：2026-11-07
**分支**：`refactor/2.2-legacy-app-extraction`
**范围**：把 `src/pages/index.astro` 里的旧版应用搬到 `src/lib/legacy-apps/`，并清理已被 os14 覆盖的死代码；
未改窗口系统、App Registry、App Runtime、Core 启动流程、Dock、菜单栏、Worker、D1/R2、同步、PWA。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 迁移方式 | 复用 `registerApp`，应用通过显式 `LegacyAppContext` 取依赖 |
| 已迁移 | **5 个**：`posts` / `about` / `rank` / `calc` / `viewer` |
| 死代码清理 | **删除 831 行**：`notes` / `calendar` / `files` / `music` 旧实现（已被 os14 同名应用覆盖） |
| `index.astro` 行数 | 7,765 → **6,605**（−1,160；字节 331,283 → 283,007） |
| 新增模块 | 8 个文件 / 470 行（含类型与共享上报） |
| 重复实现 | 消除了排行榜上报的第二份可能副本（外壳与窗口共用 `report.ts`） |
| 回归证据 | E2E **36/36**（新增 12 项）；单测 **123/123**（新增 8 项）；`verify` 绿；`qa:sync` 20/20 |
| 未迁移 | 12 个仍在 `index.astro`，原因见 §6 |

> **为什么是 Partially Verified**：本次把「低耦合应用」这一类完整迁完并验证了，并顺手清掉了
> 已被覆盖的 831 行死代码；但 `terminal` / `settings` / `social` / `treehole` / `council` 这些高耦合应用
> 需要 Core 先提供「窗口级作用域 + 认证会话」能力，否则迁移只是在模块里重建闭包，
> 属于假解耦。这部分如实留给 Phase 2.3 之后。

---

## 2. 迁移前的结构

### 2.1 单闭包问题

`index.astro` 的主脚本是一整个 IIFE：

```text
<script>                                    ← 第 689 行
  └── (() => {                              ← 第 701 行起，唯一的闭包
        const boot / DATA / makeId / …      ← 314 个 IIFE 顶层声明
        const renderPosts / initTerminal …  ← 应用实现散落其中
        const APPS / registerApp …          ← 注册表也在同一个闭包
      })()
```

所有应用共享同一个词法作用域，因此「应用依赖什么」在代码里没有边界——
只能靠人工审计。这是本阶段要解决的根问题。

### 2.2 应用清单（迁移前）

行数取自实际行段；「外部依赖」指该段引用的 IIFE 顶层声明数量。

| 应用 | id | 原始位置 | 行数 | 主要依赖 | 适合独立迁移 | 迁移风险 |
| --- | --- | --- | ---: | --- | --- | --- |
| 文章 | `posts` | L1510–1536 | 27 | `DATA`, `escapeHtml` | ✅ | 低 |
| 关于 | `about` | L1538–1557 | 20 | `DATA.site` | ✅ | 低 |
| 排行榜 | `rank` | L2040–2153 | 114 | `DATA`, `escapeHtml`, `fetchWithTimeout` | ✅ | 中（外壳 60s 计时器也用它） |
| 计算器 | `calc` | L3410–3486 | 77 | 无 | ✅ | 低 |
| 图片查看器 | `viewer` | L3814–3905 | 92 | 无 | ✅ | 低 |
| 浏览器 | `browser` | L3907–3974 | 68 | `escapeHtml` | ⏳ 可迁移 | 低 |
| 每日抽奖 | `draw` | L2155–2246 | 92 | `unlock` | ⏳ 可迁移 | 低（需注入成就系统） |
| 成就 | `achievements` | L1682–1704 | 23 | `ACHIEVEMENTS`, `readAch` | ⏳ 可迁移 | 低 |
| 水族箱 | `aquarium` | L1706–1839 | 134 | `os` 元素、`setInterval` | ⚠️ 中 | 游戏循环需生命周期 |
| 访客墙 | `visitors` | L1840–2039 | 200 | `DATA`, `makeId`, `fetchWithTimeout`, `escapeHtml` | ⚠️ 中 | 中 |
| 新闻联播 | `news` | L2869–2972 | 104 | `DATA`, `escapeHtml`, `pet` | ⚠️ 中 | 中（依赖桌面宠物元素） |
| 系统监视器 | `monitor` | L3609–3685 | 77 | `OS_BOOT`, `windows`, `desks`, `APPS` | ⚠️ 中 | 中（读全局窗口集合） |
| 终端 | `terminal` | L5131–5320 | 190 | 10 项（`openApp`/`writeState`/`applyOsTheme`…） | ❌ | 高 |
| 设置 | `settings` | L5321–5412 | 92 | 12 项（数据导入导出、Dock、壁纸…） | ❌ | 高 |
| 匿名树洞 | `treehole` | L2526–2868 | 343 | 认证链路（`authFormHtml`/`readAuth`/`ensureFreshToken`） | ❌ | 高 |
| 民主议会 | `council` | L2247–2525 | 279 | 同上 | ❌ | 高 |
| 社会网络 | `social` | L2973–3409 | 437 | 同上 + `pet` | ❌ | 高 |
| 便签 / 日历 / 文件 / 音乐 | — | 共 893 行 | 893 | — | ❌ **不可迁移** | **已是死代码**（§7） |

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
├── index.ts                  # registerLegacyApps(ctx) + LEGACY_APPS 清单
├── types.ts                  # LegacyAppContext / LegacyAppSpec / LegacyAppModule / OsData
├── articles/index.ts         # posts（文章）
├── about/index.ts            # about（关于）
├── leaderboard/
│   ├── index.ts              # rank（排行榜窗口）
│   └── report.ts             # 停留时长上报：窗口与外壳共用一份
├── calc/index.ts             # 计算器
└── viewer/index.ts           # 图片查看器
```

**没有 `adapters/` 目录**：本次 5 个应用所需的全部外壳能力都已在 `LegacyAppContext` 里声明，
再套一层 adapter 属于无意义抽象。适配器本身就是 `index.astro` 里那个带类型的对象字面量（§4）。

---

## 4. Adapter 设计

### 4.1 契约

`src/lib/legacy-apps/types.ts` 只声明迁移真正需要的四类能力：

```ts
export type LegacyAppContext = {
  escapeHtml: (text: string) => string;                       // 复用旧 Shell 的转义，不建第 2 份
  data: OsData;                                               // 构建期数据（posts / site / supabase）
  fetchWithTimeout: (url, init?, ms?) => Promise<Response>;   // 旧 Shell 的统一超时 fetch
  register: (spec: LegacyAppSpec) => void;                    // ← 复用 index.astro 的 registerApp
};
```

应用模块统一形状：

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
});
```

三点约束，写进代码注释里防止以后被改坏：

1. **必须在 `renderDock()` 之前**——程序坞按 `APPS` 过滤，注册晚了图标会消失；
2. **必须复用 `registerApp`**——不新建第二个注册中心；
3. **不把闭包整体传进去**——只传清单里列出的能力，新增能力要显式加字段。

### 4.3 与现有架构的关系

| 层 | 是否改动 |
| --- | --- |
| `src/lib/core/registry.ts`（2.0 App Registry） | 未改 |
| `src/lib/core/runtime.ts`（App Runtime） | 未改 |
| `src/lib/os20/bridge.ts`（Core ↔ 旧 Shell） | 未改 |
| `index.astro` 的 `registerApp` / `APPS` / `APP_INIT` | 未改，只被调用 |
| `mountApp` 的 init 分派 | 仅删除 3 条已迁移应用的 `legacyInit` 分支 |

迁移后的应用走**既有**的两条路径之一：

- 有 `init` 的 → `APP_INIT[id]`，由 `runInit` 执行；
- 只有 `body` 的 → 直接渲染，无初始化。

`mountApp` 的「先查 `APP_INIT`，再回退 `legacyInit`」逻辑没有变化。

---

## 5. 已迁移应用

| 应用 | 模块 | 依赖 | 生命周期 | 验证 |
| --- | --- | --- | --- | --- |
| 文章 `posts` | `articles/index.ts` | `data`, `escapeHtml` | 无 init | E2E 程序坞打开 + 列表非空 + 关闭 |
| 关于 `about` | `about/index.ts` | `data` | 无 init | E2E 作者名 + 站内链接 |
| 排行榜 `rank` | `leaderboard/index.ts` | `data`, `escapeHtml`, `fetchWithTimeout` | `init` 绑定加入按钮、加载列表 | E2E 状态文案不是「正在加载…」 |
| 计算器 `calc` | `calc/index.ts` | 无 | `init` 绑定按键 + 键盘 | E2E 7+8=15、历史记录、重开清零 |
| 图片查看器 `viewer` | `viewer/index.ts` | 无 | `init` 绑定工具栏 | E2E 空状态 + 工具栏 |

### 5.1 共享逻辑处理：排行榜上报

审计时发现 `reportTime` 同时被两处使用：

- 排行榜窗口的「加入排行」；
- `index.astro` 外壳里每 60 秒一次的停留时长上报。

只搬进应用模块会让外壳去抄一份。做法是抽出 `leaderboard/report.ts`：

```ts
export const RANK_NAME_KEY = "guandao.rank.name";   // 键名必须与 1.0 一致
export function createRankReporter(supabase, fetchWithTimeout) { … }
```

- 应用侧：`const reportTime = createRankReporter(data.supabase, fetchWithTimeout)`
- 外壳侧：`const reportRankTime = createRankReporter(DATA.supabase, fetchWithTimeout)`

**只有一份 JSON body 拼接**，两边共用。

### 5.2 审计中踩到的坑（记录）

第一轮依赖审计脚本用「区块起始行 → 下一个 banner」切分，把 APPS 对象（L4299–4321）
误算进了「文件管理器」区块，导致 `renderFiles` 被判定依赖 20 个 `renderXxx`，
看起来几乎所有应用都被它锁住。

实际用 `grep 'renderPosts'` 核对后只有 4 处引用，全部在 `APPS` 映射里。
**教训：脚本给的依赖表必须用 grep 复核，不能直接据此决策。**

---

## 6. 未迁移应用与原因

| 应用 | 阻塞原因 | 需要的前置能力 |
| --- | --- | --- |
| 终端 `terminal` | 10 项外壳依赖：`openApp`/`closeWin`/`writeState`/`applyOsTheme`/`desks`… | 先定义「应用可调用的外壳命令」白名单，否则只是把闭包搬进模块 |
| 设置 `settings` | 12 项：数据导入导出、Dock 增删、壁纸、小组件联动 | 外壳能力接口化（`setDockFilter` 那类已有，但不成体系） |
| 树洞 / 议会 / 社会网络 | 共享 `authFormHtml` + `readAuth` + `ensureFreshToken` 认证链路 | 把登录表单与 token 刷新下沉到可注入的 `AuthPort` |
| 水族箱 / 访客墙 / 新闻 / 监视器 | 游戏循环、`pet` 元素、全局窗口集合 | 生命周期与「桌面设施」接口 |
| 便签 / 日历 / 文件 / 音乐 | 旧实现已被 os14 同名应用覆盖 | **已删除**，不再需要迁移（见 §7） |

> 判断标准：如果一个应用迁出去需要在模块里重建 10 个以上外壳调用，
> 那不是解耦，只是把耦合搬了个地方。本阶段不为了凑数量硬迁。

---

## 7. 死代码清理（2026-11-07 已完成）

`src/lib/os14/index.ts` 的注册循环里有明确注释：

```ts
// 直接注册：同名内置应用会被 1.9 的实现覆盖，旧 init 链不再执行
ctx.registerApp(spec);
```

`os14` 注册了与旧版**同名**的 `notes` / `calendar` / `files` / `music`，
而 `initOs14()` 在 `index.astro` 中于 `APPS` 初始化之后才执行，
因此这四个旧实现被整体覆盖，**永远不会执行**。

### 7.1 删除前的可达性论证

只凭上面那条注释还不够，删之前逐条确认：

| 检查 | 结果 |
| --- | --- |
| os14 是否无条件注册这 4 个 id | 是；`optional: true` 只有 `gallery` / `reader` |
| `initOs14` 是否在静态 `APPS` 之后执行 | 是（`ctx14` 构造完毕后才 `initOs14(ctx14)`） |
| `legacyInit` 回退是否可能命中 | 否；`mountApp` 的 `runInit` 先查 `APP_INIT`，os14 的 `load()` 会写入 `APP_INIT[id]` |
| 这些符号是否通过 `ctx14` 暴露给外部 | 否，只暴露了 `escapeHtml` 等通用能力 |
| 是否有插件/深链直接引用 | 无；仓库内没有 `#notes` / `#calendar` / `#files` / `#music` 链接 |
| 删除后编译是否通过 | `tsc` 0 error、`astro check` 0 error |

> 过程中我写过一个「传递式死代码分析」脚本，它把 `boot14`、`openFromHash`、`launchpad`
> 等活代码也判成死代码——因为该脚本用「下一个顶层声明」界定函数体，边界严重失真。
> **该结论被丢弃**，改用「明确区块边界 + 边界断言 + 编译/引用/回归三重验证」。

### 7.2 实际删除内容

| 删除对象 | 行数 |
| --- | ---: |
| `renderNotes` + `initNotes` + `NOTES_KEY` / `NOTE_COLORS` / `NoteItem` / `readNotes` / `writeNotes` | 121 |
| `renderCalendar` + `initCalendar` + `EVENTS_KEY` / `CalEvent` / `readEvents` / `writeEvents` / `pad2` / `dayKey` | 128 |
| `renderFiles` + `initFiles` + `FS_KEY` / `FsNode` / `readFs` / `writeFs` / `seedFs` | 313 |
| `renderMusic` + `initMusic` | 16 + 253 |
| `APPS` 4 条静态条目 + `legacyInit` 4 条分支 | 8 |
| **合计** | **839** |

（文档口径取整为 **831 行实现 + 8 行登记项**。）

### 7.3 一处行为差异及其补偿

删除后 `notes` / `calendar` / `files` / `music` 在 `APPS` 里只由 os14 注册。
但开机时的 `openFromHash()` 早于 `initOs14()`，所以 `#notes` 这类直达链接会失效。

补偿：在 `initOs14()` 之后补一次 `openFromHash()`。

```ts
boot14 = initOs14(ctx14 as never);
...
openFromHash();   // 注册表此刻才完整；对已开窗口是聚焦，幂等
```

副作用是正向的：`#drive`、`#devices` 这类 os14 应用的直达链接**以前也是坏的**，现在一并修好。

> 这也解释了为什么 `index.astro` 的「应用」比实际运行的少：
> `APPS` 静态表原有 21 个条目，真正走旧实现的只有 12 个。

---

## 8. 测试证据

### 8.1 E2E

`npx playwright test` → **36 passed**（原 24 + 新增 12）。

新增 `tests/e2e/legacy-apps.spec.ts`：

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 文章：程序坞打开 | `.finder` 可见、`.file-row` 数量 > 0、关闭后窗口消失、控制台无错 |
| 2 | 关于 | `h2` 文本为「管道」、`/blog/` 链接存在 |
| 3 | 计算器 | 依次点 7 / + / 8 → `7+8`；点 `=` → `15`；历史出现 `7+8 = 15` |
| 4 | 图片查看器 | 工具栏可见、空状态文案「还没有图片」 |
| 5 | 排行榜 | 状态区不再是「正在加载…」（本地无后端也要有明确文案） |
| 6 | 重复打开 | 连续 `openApp("calc")` 三次，窗口只有 1 个 |
| 7 | 关闭再打开 | 输入 9 → 关闭 → 重开，显示回到 `0`（init 重新执行，无状态残留） |
| 8–11 | 清理回归 ×4 | `notes` / `calendar` / `files` / `music` 仍能打开、内容非空、**不是崩溃卡片**、控制台无错 |
| 12 | 注册表完整性 | 这 4 个 id 仍在 `ctx.APPS` 里（图标可点） |

### 8.2 单测

`npm run test:unit` → **123 passed**（原 115 + 新增 8），新增 `tests/unit/legacy-apps.test.ts`：

- 已迁移应用 id 唯一且格式合法；
- 每个模块的 `body(ctx)` 返回非空字符串；
- `registerLegacyApps` **只**通过传入的 `register` 注册（不碰全局）；
- 声明了 `init` 的应用集合恰为 `calc / rank / viewer`；
- `RANK_NAME_KEY` 仍为 `guandao.rank.name`（改键会丢用户昵称）；
- 未配置 Supabase 时上报不发请求；
- 配置后 POST 到 `report_time` 且 body 为 `{p_name, p_seconds}`；
- 上报失败被吞掉，不向调用方抛错。

### 8.3 全量门禁

| 命令 | 结果 |
| --- | --- |
| `npm run verify` | 通过：123 单测 + 49 安全测试；`astro check` 0 error；`lint` 0 problem；build 29 页；CSP 12 哈希 |
| `npx playwright test` | **36 passed** |
| `npm run qa:sync` | **20 / 20 通过** |
| `npm run qa:prod` | **未运行**（按要求） |

> `qa:sync` 需要把 `TEMP`/`TMP` 指到工作区内目录，否则 workerd 报
> `CreateDirectory #5 拒绝访问`（Phase 2.1 已记录的环境问题，与本次迁移无关）。

---

## 9. 代码规模

| 指标 | 迁移前 | 迁移后 | 清理后 | 总变化 |
| --- | ---: | ---: | ---: | ---: |
| `index.astro` 行数 | 7,765 | 7,439 | **6,605** | −1,160 |
| `index.astro` 字节 | 331,283 | 317,430 | **283,007** | −48,276 |
| `src/lib/legacy-apps/` | 0 | 8 文件 / 470 行 | 8 文件 / 470 行 | +470 |
| `APPS` 静态条目 | 21 | 16 | **12** | −9 |
| `legacyInit` 分支 | 18 | 15 | **11** | −7 |

行数不是本阶段的目标（`index.astro` 早已低于路线图 12,000 行），
**目标是让迁移出去的 5 个应用不再依赖闭包 + 移除不可达代码**。
模块总量大于删除量是正常的：它包含类型定义、依赖注入接线和一份被消除重复的共享上报实现。

---

## 10. 剩余技术债

| # | 债 | 影响 | 建议阶段 |
| --- | --- | --- | --- |
| 1 | 12 个应用仍读闭包 | 无法独立测试，改动易牵连 | Phase 2.3+，需先做外壳能力接口化 |
| 2 | `initRank` 的 `void load()` 未随窗口关闭取消 | 关窗后仍会写已脱离文档的节点（不抛错、不泄漏处理器） | Phase 2.4（事件/作用域审计） |
| 3 | `LegacyAppContext` 只有 4 个能力 | 迁移终端/设置时会需要扩容 | 扩容前先确认每个新能力的归属 |
| 4 | 没有「应用级」单测脚手架（依赖真实 DOM） | init 只能靠 E2E 验证 | 可选：引入 jsdom 环境 |

已关闭：

- ~~约 831 行死代码（`notes`/`calendar`/`files`/`music` 旧实现）~~ → 2026-11-07 已删除，见 §7。

### 10.1 对 Phase 2.3 的输入

清理后 `index.astro` 里 `escapeHtml` 仍有 **37 处引用**，分布在通知中心、虚拟桌面、
访客墙、社会网络等区块，加上 `src/lib/os14/core.ts`、`src/lib/mobile/ui.ts` 的副本。
死代码清完后，这 37 处全部位于活代码路径，2.3 收敛时不需要在死代码里甄别。

---

## 11. 复现命令

```powershell
npm run build                 # E2E 跑的是构建产物
npx tsc --noEmit              # 新模块类型检查
npm run check:astro           # index.astro 检查
npx playwright test           # 含 tests/e2e/legacy-apps.spec.ts
npx vitest run tests/unit/legacy-apps.test.ts

# 全量
npm run verify
$env:TEMP = "$PWD\.wrangler\tmpdir"; $env:TMP = $env:TEMP
npm run qa:sync
```

---

## 12. 相关文档

- [`docs/architecture/DESKTOP-CSS.md`](DESKTOP-CSS.md)：Phase 2.1 桌面 CSS 架构
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图
- [`GUANDAO_2_0_AUDIT.md`](../../GUANDAO_2_0_AUDIT.md)：总体审计
- [`docs/ACCEPTANCE-2.0.md`](../ACCEPTANCE-2.0.md)：验收清单