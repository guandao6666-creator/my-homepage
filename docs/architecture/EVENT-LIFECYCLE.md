# 事件与资源生命周期（Event Lifecycle）

**阶段**：Guandao OS 2.4
**状态**：`Verified`（Scope 契约有 19 项单测；20 次开关 7 项计数零净增长；未发现需要迁移的泄漏模块）
**最后核对**：2026-11-07
**核心实现**：`src/lib/quality/resources.ts`（**复用，未新建第二套**）
**基线测试**：`tests/e2e/lifecycle.spec.ts`、`tests/unit/resources.test.ts`

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| Scope 实现 | 复用既有 `ResourceScope`，**未新增资源管理器** |
| 本轮修复 | **1 个真实缺陷**：`once: true` 监听器触发后计数与登记不回收 |
| 新增测试 | Scope 契约 **19 项**；生命周期 E2E 从 5 项计数扩展到 **7 项** |
| 20 次开关 | listeners 5→5、timeouts 1→1、intervals 1→1、rafs 0→0、scopes 7→7、observers 4→4、objectUrls 0→0 |
| 模块迁移 | **0 个**——审计显示没有需要迁移的泄漏；理由见 §7 |
| `installRootDisposal` | **评估后决定不启用**，理由见 §6 |
| 全量门禁 | `verify` 189 单测；E2E **64**；`qa:sync` 20/20 |

---

## 2. Scope 的实际 API

`ResourceScope` 已经覆盖了本阶段需要的全部能力，**没有改接口**，只修了 `on()` 的 `once` 分支语义。

| 方法 | 作用 | 释放时机 |
| --- | --- | --- |
| `add(cleanup)` | 登记任意清理函数，返回可单独执行的 disposer | `dispose()` 或手动调用 |
| `on(target, type, handler, options)` | `addEventListener` + 自动 `removeEventListener` | `dispose()` / 手动 off / `once` 触发后 |
| `timeout(fn, ms)` | 一次性定时器 | 执行完自动回收 / 取消 / dispose |
| `interval(fn, ms)` | 周期定时器 | dispose 或手动 off |
| `raf(fn)` | 单帧回调 | 执行完 / 取消 / dispose |
| `rafLoop(fn, opts)` | 自驱动画循环，页面隐藏自动暂停 | 回调返回 false / stop / dispose |
| `observer(observer)` | Mutation/Resize/Intersection/Performance Observer | dispose 时 `disconnect()` |
| `objectUrl(blob)` | `createObjectURL` + 释放时 `revokeObjectURL` | dispose |
| `worker(w)` | 释放时 `terminate()` | dispose |
| `abortController()` | 释放时 `abort()` | dispose |
| `child(label)` | 子域，随父域级联释放 | 父域或自身 dispose |
| `dispose()` | 幂等释放，**逆序**执行 | 手动 |

计数器：`resourceStats()` 返回 `scopes / timeouts / intervals / rafs / listeners / observers / objectUrls / workers`，**统计的是当前活动数量，不是累计注册次数**。

---

## 3. 生命周期分类

| 类别 | 归属 | 实例 | 约定 |
| --- | --- | --- | --- |
| **A. Root** | 整个页面 | 全局快捷键、菜单栏委托、Core 事件总线、`initConnectivity` | 只初始化一次；不随窗口开关增减 |
| **B. Application** | 应用存活期 | 终端会话、应用级定时器、同步订阅 | 应用启动注册、销毁释放，重开重建 |
| **C. Window** | 窗口存活期 | 窗口内按钮、拖动辅助、窗口级状态监听 | `trackWindowScope(win, …)` 绑定，`closeWin` 释放 |
| **D. Component** | 组件存活期 | 局部渲染产生的监听 | 用 `child()` 派生子域，组件替换时释放 |
| **E. One-shot / External** | 一次性 | `{ once: true }`、带 `AbortSignal` 的请求、`pagehide` | 由平台自动释放，**不要再包一层** |

> 判定资源是否泄漏时，先看它属于哪一类。Root 监听数量在窗口开关前后不变是**正确**的，不能算泄漏。

---

## 4. 监听器统计规则

### 4.1 本轮修复的缺陷

`on()` 原来直接把调用方的 `options` 透传给 `addEventListener`。当 `options.once === true` 时：

- 浏览器在首次触发后**自动移除**监听器；
- 但 Scope 里的计数和 disposer 登记**不会消失**；
- 结果：`resourceStats().listeners` 永久偏高，`scope.size` 也不归零，`dispose()` 时还会对已移除的监听再执行一次清理。

修复方式（`resources.ts` 的 `on()`）：`once` 时包一层，首次触发先回收自身计数与登记，再调用原处理函数。

```ts
const isOnce = typeof options === "object" && options !== null && options.once === true;
const bound = isOnce ? (event) => { off(); handler(event); } : handler;
```

行为不变（仍只触发一次），只是计数与登记同步消失。回归测试见 `tests/unit/resources.test.ts` 的
「once 监听器触发后自动回收计数」。

### 4.2 监听器匹配语义

`removeEventListener` 的匹配只关心 **capture**，其余 options 不参与比较。Scope 的做法是
**原样保存调用方传入的 `options` 对象**再回传，因此 `capture` / `once` / `passive` / `signal`
的语义与手写 `addEventListener` 完全一致，没有二次解释。

### 4.3 统计不看注册次数

计数器在「资源真正结束」时回落：timer 执行完、`once` 触发后、`revokeObjectURL` 之后。
因此 `resourceStats()` 可以直接当作活动资源快照使用（见 §8）。

---

## 5. Timer / Observer 管理

- **timeout**：回调执行时先扣减计数，再跑业务函数；`dispose` 时 `clearTimeout`（对已完成的定时器是空操作）。
- **interval**：只在 `dispose`/手动 off 时停止。
- **Observer**：统一用 `scope.observer(obs)` 登记，`dispose` 时 `disconnect()`。已释放的 scope 收到 observer 会**立即 disconnect**，不会留下活动对象。
- **Object URL**：用 `scope.objectUrl(blob)` 创建，dispose 时 `revokeObjectURL`，避免 Blob 常驻内存。

---

## 6. `installRootDisposal` 的评估（决定：不启用）

现状：函数已定义，但**全仓库没有调用**。`rootResources()` 会在需要时懒创建 `rootScope`。

如果调用它，会在 `pagehide` 时 `rootScope.dispose()`。评估结果：

| 关注点 | 结论 |
| --- | --- |
| 原设计目的 | 页面卸载前释放 root 级资源（定时器、监听、rAF） |
| 页面生命周期冲突 | **有**：`pagehide` 在进入 BFCache 时也会触发。此时释放 root 资源，用户按「后退」回到页面时页面会被复用但资源已销毁 —— 界面在、交互失效 |
| 实际收益 | 低：页面卸载时浏览器本来就会回收全部资源 |
| 风险 | 高：BFCache 恢复后桌面可能变成「看得见点不动」 |
| 决定 | **不启用**，并在此记录原因，避免以后有人为了「消除未使用函数」而接上它 |

如果将来确实需要在卸载前收尾，应改用 `visibilitychange` + `document.hidden` 之外的信号，
并显式排除 BFCache 场景（`event.persisted`）。

---

## 7. 模块迁移情况：0 个，以及为什么

按任务要求逐模块审计后，**没有发现需要迁移的泄漏模块**，因此本轮**没有做任何模块级改写**。

| 模块 | 资源类型 | 现状 |
| --- | --- | --- |
| Desktop Shell（`index.astro`） | Root 监听：键鼠委托、hashchange、resize | 全部是 A 类 Root，初始化一次，**不是泄漏** |
| Window Manager 外围 | 每个窗口一个 `ResourceScope`（`trackWindowScope`） | 已接入，`closeWin` 时 `releaseWindowScope` |
| Legacy Applications（2.2 迁移的 5 个） | 监听全部绑在窗口元素或其后代上 | 随 DOM 回收；`calc/viewer` 无外部资源 |
| os14 应用 | 通过 `ctx` 注册的应用级监听 | 走既有窗口域 |
| System Center / Onboarding / Market / Plugin UI | 监听绑在窗口内元素 | 同上 |
| Mobile Shell | 页面级 Root 监听 | A 类，页面级生命周期 |

**为什么不动它们**：20 次开关的实测计数（§8）在这 7 个维度上都没有净增长，
说明现有归属是正确的。按任务书「不要为了追求全覆盖而强行迁移」，
本轮只修了**确实有缺陷**的 `once` 分支。

> 这不是「什么都没做」：审计结论本身就是本阶段的产出——**基线是干净的**，
> 并且现在有自动化测试锁住这个结论。

---

## 8. 20 次开关实测

命令：`npx playwright test tests/e2e/lifecycle.spec.ts`

```
[lifecycle] listeners 5 → 5；timeouts 1 → 1；intervals 1 → 1；rafs 0 → 0；
            scopes 7 → 7；observers 4 → 4；objectUrls 0 → 0
```

| 指标 | 初始 | 20 次后 | 净增长 |
| --- | ---: | ---: | ---: |
| 事件监听 | 5 | 5 | **0** |
| timeout | 1 | 1 | **0** |
| interval | 1 | 1 | **0** |
| 动画帧回调 | 0 | 0 | **0** |
| 存活资源域 | 7 | 7 | **0** |
| 观察器 | 4 | 4 | **0** |
| 未释放 Object URL | 0 | 0 | **0** |

同一测试在 20 次循环之后还做了**功能回归**（不是只看计数）：

1. 桌面图标点击 → 计算器打开；
2. 计算器按键 → 显示 `4`（证明 init 在窗口重建后仍执行）；
3. 程序坞点击 → 文章窗口打开；
4. `Ctrl+K` → Spotlight 打开、`Esc` 关闭（证明 Root 快捷键没有被重复绑定或失效）。

重应用（终端）连续 10 次开关：listeners 5→5、timeouts 1→1、intervals 1→1。

---

## 9. 已确认的资源泄漏

| 项 | 状态 |
| --- | --- |
| `once: true` 监听器触发后计数不回落 | **已修复**（本轮唯一确认缺陷） |
| 窗口开关导致的监听/定时器累积 | **未发现**（7 项计数零增长） |
| Observer 未释放 | **未发现**（4→4） |
| Object URL 未释放 | **未发现**（0→0） |

---

## 10. 监控盲区（如实记录）

| # | 盲区 | 影响 |
| --- | --- | --- |
| 1 | **只在 `ResourceScope` 登记的资源会被计数**。直接调用 `document.addEventListener`、裸 `setInterval` 的代码不计入 | 计数为「Scope 内的活动资源」，不是全页面的真实总量 |
| 2 | 监听器数量是「Scope 登记数」，不是浏览器内部的真实监听器总数 | 同上；这也是为什么 5 这样的绝对值没有意义，**只有前后差值有意义** |
| 3 | `subscription`（EventBus / 自定义订阅）没有独立计数 | 通过 `scope.add(unsub)` 间接覆盖，但无法单独观测 |
| 4 | WebSocket / BroadcastChannel / MessagePort 没有专门计数器 | 本仓库当前没有长期存活实例 |
| 5 | 计数是模块级全局变量，多标签页各自独立，不汇总 | 单页视角 |

**没有新增 `scripts/check-resource-lifecycle.mjs`**：本阶段的审计结论是「基线干净」，
用 AST 去判断一个 `addEventListener` 该属于哪类生命周期，误报率会很高
（同样的写法在 Root 和 Window 场景下都合理）。按任务书要求，**不交付大量误报的虚假门禁**；
改用「20 次开关 + 7 项计数」的真实运行时证据来守门。

---

## 11. 测试

| 文件 | 数量 | 覆盖 |
| --- | ---: | --- |
| `tests/unit/resources.test.ts` | **19** | dispose 幂等、重复执行、异常隔离、逆序、子域级联、已释放域注册、监听手动/自动释放、`once` 回收、timeout 完成/取消、interval 释放、销毁后建 timer、observer disconnect、abortController、scopes 对称 |
| `tests/e2e/lifecycle.spec.ts` | **2** | 20 次开关 + 7 项计数 + 功能回归；终端 10 次开关 |

全量：`npm run verify` **189 单测**；`npx playwright test` **64**；`npm run qa:sync` **20/20**。

---

## 12. 相关文档

- [`docs/architecture/HTML-SECURITY.md`](HTML-SECURITY.md)：Phase 2.3 安全边界
- [`docs/architecture/LEGACY-APPLICATIONS.md`](LEGACY-APPLICATIONS.md)：Phase 2.2 应用迁移
- [`docs/architecture/DESKTOP-CSS.md`](DESKTOP-CSS.md)：Phase 2.1 CSS 拆分
- [`GUANDAO_2_0_ROADMAP.md`](../../GUANDAO_2_0_ROADMAP.md)：Phase 2 路线图