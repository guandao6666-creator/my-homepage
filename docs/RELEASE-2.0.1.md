# Guandao OS 2.0.1 · 发布说明

**版本**：2.0.1
**代号**：Steady Clicks（稳如点按）
**日期**：2026-11-20
**类型**：补丁版本（无 schema 变更、无数据迁移）
**上游**：2.0.0 · The Platform Era
**状态**：**已部署到生产（https://guandao.xin，2026-11-20 22:07 +08:00）**，`qa:prod` 35/35 通过

> 2.0.1 只做一件事的收尾：把 2.0.0 时期「社区搜索结果里点作品卡片打不开详情」的
> 缺陷定性、修复并用自动化测试锁住，同时补上三处同一链路上的并发/重复挂载加固。
> 没有新增功能，没有改数据库结构，没有改任何公开 API 的契约。

---

## 1. 缺陷回顾（P1-8）

**现象**：在社区「搜索」结果里点击作品卡片，既没有打开详情，页面还刷新成了别的内容；
点击结果区的空白/说明文字也会「乱跳」。

**当时的错误结论**：曾把原因记成「`loadDetail` 被并发重渲染判为 stale（`isStale` 竞态）」。
这个结论是错的——`loadDetail` 根本没有被调用过。

**真正原因**：社区根节点上的 click 代理把「分页」判定放在了最前面，并且用的是裸选择器
`target.closest("[data-page]")`。OS 外壳会自适应模式写到根元素上：

```ts
// src/lib/shell/adaptive.ts:141
document.documentElement.dataset.page = page;
```

于是**任何没有被前面分支接住的点击**（卡片封面、标题、空白）都会命中 `<html data-page="desktop">`，
命中后代理直接 `return`，`openPostFromEvent` 轮不到执行：

```ts
// 2.0.0 的错误写法（示意）
const page = target.closest("[data-page]");   // ← 命中的是 <html data-page="desktop">
if (page) { void loadSearch(q, false); return; } // Number("desktop") || 1 → 重画第 1 页
```

**修复归属**：修复本身随 2.0.0 的后续提交进入主线（`bc44b75 fix(community): 修复点击卡片/空白乱跳发现页`），
但 BACKLOG 一直停在 `Partially Verified`——**没有回归测试**，所以既不能算验证过，也没人敢关。
2.0.1 的工作就是把它从「改过」变成「有证据」。

---

## 2. 2.0.1 的改动

### 2.1 分页判定收敛为纯函数（可单测）

`src/lib/os14/community/interactions.ts`

```ts
/**
 * 只认真正的分页按钮。
 * 2.0.1 起：选择器必须是 button[data-page]，且 data-page 必须是数字。
 */
export const pickPageButton = (target: HTMLElement): HTMLButtonElement | null => {
  const button = target.closest<HTMLButtonElement>("button[data-page]");
  if (!button) return null;
  return /^\d+$/.test(button.dataset.page ?? "") ? button : null;
};
```

`src/lib/os14/community.ts` 的分页分支改为 `const page = pickPageButton(target);`。
两条约束同时生效：**非按钮元素不参与判定**（`<html>` 天然出局）、**非数字 `data-page` 不参与判定**
（防御外壳或第三方写入其他字符串）。

### 2.2 详情加载不再覆盖更新的视图

`src/lib/os14/community/detail.ts`

- 令牌在 `setView` **之前**占用（消除「视图已切、号还没占」的窗口期）；
- 返回时除 `isStale(token)` 外再校验视图目标：

```ts
if (ctx.isStale(token)) return;
const view = ctx.getView();
if (view.kind !== "detail" || view.id !== id) return;
```

含义：即便将来某个 loader 抢先重画了 body，旧请求返回后也不会把 A 作品的详情盖到 B 作品或列表上。

### 2.3 社区应用重复挂载时幂等

`src/lib/os14/community.ts`

```ts
const disposers = new WeakMap<HTMLElement, () => void>();   // 窗口 → 旧实例的卸载函数
export const initCommunity = (win, ctx) => {
  disposers.get(win)?.();                                   // 先卸旧实例
  …
  let disposed = false;                                     // 卸载后旧实例停止写 DOM
  const setBody = (html) => { if (disposed) return; … };
  const dispose = () => { disposed = true; loadToken++; … };
  disposers.set(win, dispose);
  return dispose;
};
```

只摘监听器是不够的：已经飞出去的 `await` 仍会回来写 DOM，所以用 `disposed` 兜住 `setBody`，
并在启动 IIFE 的 `await ensureMeta()` 之后提前返回。用 `WeakMap` 而不是 DOM 标记，窗口回收即失效。

### 2.4 版本号与文案

| 位置 | 2.0.0 → 2.0.1 |
| --- | --- |
| `package.json` / `package-lock.json` | `version` |
| `src/lib/version.ts` | `OS_VERSION` + `RELEASES` 新增首条 |
| `worker/api/version.js` | `WORKER_VERSION` |
| `public/sw.js` | `VERSION = "guandao-2.0.1"` |
| `shared/plugin-spec.js` / `worker/api/community/validate.js` | `OS_VERSION` |
| `cli/guandao.mjs` | `CLI_VERSION`、新模板 `minimumOSVersion` |
| `src/lib/core/registry.ts` | 注册中心默认 `osVersion` 回退值 |

`scripts/check-version.mjs` 强制这些值一致，已在 CI 门禁里跑过：

```
[version] 一致：2.0.1（package.json / version.ts / worker / sw.js）
```

---

## 3. 测试证据

| 用例 | 覆盖 | 位置 |
| --- | --- | --- |
| 分页判定单测（3 项） | 数字 `data-page` 才算翻页；`data-page="desktop"`、空值、`2abc` 都不算 | `tests/unit/community.test.ts` |
| 「搜索 → 点卡片 → 详情」E2E | 真实 Worker + 真实 UI：搜索 → 点卡片 → `.cx-detail-hero h1` 是作品标题 → 返回列表 | `tests/e2e/community-search-open.spec.ts` |
| 「点空白不跳走」E2E | 点搜索结果里的非交互统计文字，仍停在搜索结果 | 同上 |
| 版本一致性 | 8 处版本源一致 | `npm run check:version` |
| 既有版本界面 | 更新中心/设置页显示 2.0.1 | `tests/e2e/os20.spec.ts`（已同步断言） |

E2E 数据的来源与清理：全部使用本地夹具账号（`qa-p3-*`）在本地 D1/R2 里造一条 tutorial，
发布 → 管理员审核 → 公开 → 测完由作者删除；不触碰生产。

### 3.1 反证：把修复删掉，测试会不会红

一条「永远是绿的回归测试」等于没有测试。所以 2.0.1 的回归用例做过一次**负向对照**：
把 `pickPageButton` 临时改回 2.0.0 的裸选择器 `target.closest("[data-page]")`，重建后重跑：

```
1 failed   [worker] › community-search-open.spec.ts:137 › 搜索 → 点作品卡片 → 打开详情
1 passed
```

恢复修复后同一份用例：

```
2 passed (17.1s)
```

结论：第一组用例确实能区分「修了」和「没修」，不是同义反复。
（第二组「点空白」用例在旧代码下也会通过——旧逻辑把它重画成同一页搜索结果，
所以它是**稳定性**断言，不是**判别**断言；文档里不把它算成 P1-8 的证明。）

### 3.2 造数据时踩到的坑（写下来免得下一个人再踩）

两个用例最初共用同一个 `packageId`，第二个用例发布时报 `409 PACKAGE_ID_TAKEN`。
原因在服务端：`assertPackageIdAvailable` 只按 `package_id` 查行，不看状态；而删除作品
只把作品/内容包标成 `deleted`，行仍在。所以**同一文件里的用例必须各自带后缀**，
已改为 `qa-click-<run>-open` / `qa-click-<run>-blank`。

### 3.3 顺带修复四个与产品脱节的既有 E2E 断言

全量 E2E 在 2.0.1 收口时是 `180 passed / 4 failed`。四个红都不是 2.0.1 改出来的，
而是**断言还停在旧文案/旧入口**——产品早改了，测试没跟上，久而久之被当成「已知抖动」。
2.0.1 一并修掉，否则每次全量都红，真回归会被淹没：

| 用例 | 原断言 | 实际行为 | 修法 |
| --- | --- | --- | --- |
| `legacy-apps.spec.ts` 每日抽奖 | 正文一直是 `每天可以抽一张，明天再来` | 正文初始是 `每天可以抽一张`，抽完换成抽签语；`明天再来` 是**按钮**文案（`draw/index.ts:24`、`:40-41`） | 断言拆成正文/按钮两条，抽完校验按钮变「明天再来」 |
| `legacy-apps.spec.ts` 议会 | 未登录必有 `#council-auth .auth-form` | 议题来自构建期数据；无议题时产品按设计走「暂无议题」空态并提前 `return`，不渲染登录框（`council/index.ts:117-131`） | 按 `#council-list .council-item` 是否存在分支：有议题验登录框，无议题验空态文案 |
| `legacy-apps.spec.ts` 社交名片 | 必有 `.social-empty`「还没有别的访客」 | 这个应用读 Supabase 而不是本站 API；云端未配置是「云端没接上」，请求失败是「连不上，关掉重开试试」，只有云端真返回空才有空态文案（`social/index.ts:54-55`、`:172-215`） | 三种终态都断言：离线时不得出现 `.social-row`，可达时必须是「访客行 / 空态」二选一 |
| `mobile.spec.ts` 笔记入口 | 底栏有 `.m-tab[data-tab="notes"]` | `eb967eb` 起底栏让给「博客」「桌面」，笔记入口移到首页「最近笔记」的 `button[data-tab="notes"]`（`mobile/app.ts:444`） | 改为 `.m-sec-head button[data-tab="notes"]` |

修完后全量：**184 passed（4.4m），exit 0**（证据见 `docs/AI-BUILD-STATUS.md` §4）。
这几条改的是「测什么」，没有放宽产品约束：每一条都从「唯一旧形态」改成「产品当前承诺的
全部合法终态」，并且都补了源码位置注释，避免下次再被同一处改动打红。

---

## 4. 兼容性

- **无 schema 变更**：D1 迁移无新增，`npm run check:migrations` 通过。
- **无数据迁移**：2.0.0 的本地数据、工作空间快照、插件安装记录继续可用。
- **公开 API 契约不变**：`x-guandao-version` 头与 `meta.osVersion` 变为 `2.0.1`；
  声明 `minimumOSVersion: "2.0.0"` 的插件/应用在 2.0.1 上照常可用（`satisfiesMinimum` 为真）。
- **Service Worker**：`VERSION` 变化会重建 `guandao-2.0.1-*` 缓存，旧缓存按前缀清理；
  首次升级后的第一个页面会重新填充静态资源，属预期行为。
- **已知既有行为（未改）**：从搜索结果打开详情后，「← 返回」回到上一个标签页（通常是首页），
  不回搜索结果。这是 2.0.0 的设计，不在 2.0.1 变更范围内。

---

## 5. 本机门禁实跑（2026-11-20）

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-version.mjs` | `[version] 一致：2.0.1（package.json / version.ts / worker / sw.js）` |
| `npm run typecheck` | 0 error（362 文件） |
| `npx vitest run` | **21 文件 / 375 单测通过** |
| `npm run build` | exit 0，29 页；CSP 12 哈希 / 30 HTML 一致 |
| `node scripts/perf-baseline.mjs --json` | 入口 JS 433.4 KB / 439.5 KB；首屏 CSS 184.7 KB / 195.3 KB |
| `npm run verify` | **exit 0**（完整链：版本 → 迁移 → typecheck → 单测 → 安全 → unused → astro → html-security → lint → build → csp） |
| `npx playwright test` | **184 passed（4.4m），exit 0**（chromium 88 + worker 72 + firefox-worker 12 + webkit-worker 12） |

> 2.0.1 期间顺带修红了一处既有门禁：`check:html-security` 报 `src/lib/mobile/app.ts` 有 3 处未审查 sink，
> 而 allowlist 记的是 2 处（「回博客」footer 新增了第 3 处）。复核后登记 `count: 3` 并写明第 3 处为静态模板，
> 现为 294 处全审查、0 未审查。这不是 2.0.1 引入的缺陷，但门禁不绿就不能发版。

---

## 6. 部署注意

1. `npm run build` 与 `check:csp` 必须同批：`worker/api/csp-hashes.js` 由构建重写，
   改动内联脚本后不同步会触发 CSP 拒绝。
2. Worker 版本以 `worker/api/version.js` 为准；前端更新中心显示的「服务端版本」来自
   `/api/health` 的 `version` 字段（`/api/version` 在本项目里没有对应路由，不要照旧文档引用）。
3. 生产部署仍受 2.0.0 的门禁约束（所有者授权后跑 `qa:prod`）；本文件的部署结果见 §7。

---

## 7. 部署结果（2026-11-20）

| 项 | 结果 |
| --- | --- |
| 部署命令 | `npm run cf:deploy`（build → `wrangler deploy`） |
| Worker Version | `7258a2a3-5ed6-479e-946e-3c0f74e71267` |
| `/api/health` | `"version":"2.0.1"`、`d1:"connected"`、`r2:"available"` |
| 响应头 | `x-guandao-version: 2.0.1`；CSP/HSTS/COOP 等安全头齐全 |
| 静态资源 | 部署 63 个资源；首页入口包 `index.astro_...DJ_tz0bB.js` 内含 `2.0.1` |
| 生产 D1 迁移 | 部署前 `d1 migrations list --remote` → `No migrations to apply!` |
| 部署前备份 | `C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261120-220521.sql`（587,383 B） |
| 生产端到端 | `npm run qa:prod` **35/35 通过**，测试账号与数据清理归零 |
| 生产 UI 冒烟（真实 Chrome + Playwright） | 跳过引导 → 社区首页卡片点击 → 详情打开（`用工作空间整理一天`）；返回后搜索 `用工作空` → 1 条结果 → 点卡片 → 详情打开；`pageerror` 为 0——即本次修复的 P1-8 路径在生产可用 |
| 回滚 | `npx wrangler versions deploy <上一 Version ID>`；数据侧用上述 D1 备份恢复 |