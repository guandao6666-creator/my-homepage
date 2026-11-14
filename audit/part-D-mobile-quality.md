# Guandao OS 2.0 · Part D 审计：多设备 / PWA / 接力 + 工程质量

- 审计对象：`C:\Users\1\Desktop\my-homepage`（工作区**未提交**，见 `docs/RELEASE-1.9.md:16-17`）
- 审计方式：只读通读源码；本地实跑 `check:version` / `tsc --noEmit` / `vitest run` / `playwright test`（结果见 §5）
- 审计时点：2026-11-05 17:1x（Asia/Shanghai）；审计期间 `src/lib/core/*`（2.0 骨架）正被并行写入，见 §8/§9

> **一句话结论**：1.9 的质量层（net / errors / perf / resources / connectivity / diagnostics）是**真实实现**，不是占位；但它**只覆盖桌面外壳**——移动端、接力、配对、云能力全部绕过它。最严重的一条是诊断中心把「云同步」显示为绿色「在线 · 已同步」，而产品根本没有同步引擎。

---

## 1. 多设备状态表

### 1.1 三种模式的真实差异

| 维度 | desktop | tablet | mobile |
| --- | --- | --- | --- |
| 入口 | `/`（`src/pages/index.astro:92-96`） | 同 `/` | `/m/`（`src/pages/m.astro:7` 写死 `data-shell="mobile"`） |
| 判定条件 | 视口宽 ≥1024 且（非粗指针 或 宽 ≥1280） | 640≤宽<1024；或粗指针且屏短边 ≥500 且宽<1280 | 宽<640；或粗指针且屏短边<500（`src/lib/shell/adaptive.ts:60-65`） |
| 窗口系统 | 完整窗口/菜单栏/Dock/组件 | **同一套**窗口系统 | **无**窗口系统，单页 Tab 壳（`src/lib/mobile/app.ts:266-282`） |
| 布局差异 | 基准 | 仅 CSS 密度：菜单栏 46px、Dock 58px、桌面图标 96px、窗口圆角 18px（`src/styles/adaptive.css:8-105`） | 独立 `mobile.css`，单列、底部 Tab、底部抽屉（`src/styles/mobile.css:107-113`） |
| 交互差异 | 鼠标可拖拽/贴边吸附 | 允许**手指**贴边吸附（`src/pages/index.astro:4703-4705`）；新窗口近全屏居中（`index.astro:4938-4947`） | 无多窗口、无 Spotlight、无右键菜单 |
| 数据 | localStorage（notes/tasks/calendar）+ D1/R2（files/continuity） | 同 desktop | **同一份** localStorage（`src/lib/mobile/app.ts:11-14` 直接 import `notesStore`/`calendarStore`/`taskStore`），云端走同一 Worker API |
| 应用数 | 25 个注册应用（`src/lib/os14/index.ts:55-231`） | 25 | 11 个视图：5 Tab + 5 子页（files/devices/clipboard/account/settings）+ 笔记编辑器（`mobile/app.ts:56`、`:806-820`、`:525-544`） |
| 首屏 JS | 445.3 KB 单 chunk（实测 `dist/index.html` 引用） | 同 | 56.2 KB + 16.1 KB CSS（实测 `dist/m/index.html`） |

**判定逻辑质量**：阈值本身是合理的（不看 UA，用 `screen` 短边规避软键盘收缩，`adaptive.ts:53-59`；`--app-vh` 供 CSS 用，`:77`）。问题在**同一套算法被抄了三份**：

- 权威实现 `src/lib/shell/adaptive.ts:48-66`
- 移动页内联副本 `src/pages/m.astro:27-53`
- 桌面页内联副本 `src/pages/index.astro:112-129`（这份还漏了 `--app-vh`，且 `?desktop=1` 会写死偏好 `index.astro:106-111`）

三份任一改动就会漂移；`m.astro:25-26` 注释称"一百多 KB 的手机脚本"，实测入口仅 56.2 KB。

### 1.2 移动端只是"另一套 UI"吗？

**功能上是，数据模型上不是。** 数据层复用桌面 store（同源 localStorage），所以笔记/任务/日历能互通；但 UI 与交互是第二套实现，且只覆盖桌面 25 个注册应用里的 5 类（notes/tasks/calendar/files/devices）：

| 缺失类别 | 缺失内容 | 证据 |
| --- | --- | --- |
| 内容消费 | Music / Gallery / Reader / Community / 博客阅读 | 桌面注册表 `src/lib/os14/index.ts:165-230`；mobile 无对应 Tab/子页 |
| 系统 | 诊断中心、Performance Lab、主题中心、组件中心、应用中心、工作空间、控制中心、数据中心、备份、隐私与安全、终端/监视器 | `index.ts:56-163`；mobile 设置页只有 4 项（`mobile/app.ts:1009-1053`） |
| 插件 | 插件管理器 / 市场 / 开发者中心 | `index.ts:181-204` |
| 能力 | Spotlight 全局搜索（mobile 仅笔记内搜索 `app.ts:495-523`）、通知中心、多窗口、右键菜单、拖拽 | — |
| 云端 | 文件仅"最近 40 个 + 图片预览/下载"（`mobile/data.ts:56-64`、`app.ts:1255-1279`），无文件夹、重命名、删除、移动、配额 | 桌面 `index.ts:133-140` drive 全功能 |
| 接力 | 只能"打开/完成"，不支持把接力写回云端资源；workspace/app 类型只提示"去桌面"（`mobile/app.ts:1228-1249`） | — |

反过来，移动端有两种桌面没有的形态：底部 Sheet（桌面用居中 `modal`）与 `beforeinstallprompt` 安装入口（`app.ts:1592-1598`；全仓仅此处监听该事件，桌面没有任何安装引导）。

---

## 2. PWA 与离线

### 2.1 manifest 完整性（`public/manifest.webmanifest`）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| name/short_name/description/lang/dir | 有 | `:2-4`、`:13-14` |
| id / start_url / scope | **有但不一致**：`id="/?source=pwa"`、`start_url="/m/"`、`scope="/"` | `:5-7` |
| display / display_override / orientation / 配色 | 有 | `:8-12` |
| icons | 3 个（192/512 各 `purpose:any`，512 `maskable`），文件均存在（`public/icons/`） | `:16-35` |
| shortcuts | 3 个（新建笔记 / 今天任务 / 接力收件箱） | `:36-55` |
| **screenshots** | **缺**（Chrome 富安装卡片不会出现） | 全文无 |
| **share_target** | **缺**（无法从系统分享面板"发送到 Guandao"，这对"接力"是最自然的入口） | 全文无 |
| launch_handler / protocol_handlers | 缺（可选） | — |
| apple-touch-icon | 不一致：`m.astro:22` 用 `icon-192.png`（非 180×180），`BaseLayout.astro:70` 用 `favicon.svg`，桌面 `index.astro` 完全没有 | — |

### 2.2 Service Worker 缓存策略（`public/sw.js`）

| 请求类型 | 策略 | 证据 |
| --- | --- | --- |
| install 预缓存 | 8 条固定清单：`/m/`、`/offline/`、manifest、favicon、3 个图标、`aurora.webp` | `:27-36`、`:38-54` |
| 导航请求 | network-first，成功后写 `SHELL_CACHE` 并裁剪到 40 条，失败回退缓存→`/offline/`→503 文本 | `:133-155`、`:24-25`、`:122-131` |
| 静态资源 | stale-while-revalidate，写入 `STATIC_CACHE`；仅同源 `basic` 响应 | `:157-181` |
| 静态判定 | 5 个前缀 + 扩展名白名单（**音乐被排除**） | `:103-108` |
| 绕行 | `/api/`、`/sb/`、`/pair`、`/sandbox/`、`/music/`、`/sw.js` 全部不接管 | `:110-119` |
| 页面回传 | `CACHE_URLS`：把本次实际加载的同源 js/css 交给 SW（上限 40） | `:80-99` + `src/lib/shell/pwa.ts:81-104` |
| 版本清理 | activate 只删 `guandao-` 前缀且非当前 VERSION 的缓存，再 `clients.claim()` | `:56-68` |

**离线可用范围（真实）**：
- ✅ `/m/` 全壳（install 已预缓存），以及本次加载过的 js/css（`pwa.ts:86-98` 从 Resource Timing + DOM 收集）。
- ✅ 已访问过的任意页面（靠导航缓存）。
- ⚠️ **桌面 `/` 首访后立刻断网不可用**：install 清单里没有 `/`，首访时 SW 尚未接管，`networkFirst` 没有机会写入；只有第二次导航才进缓存（`sw.js:27-36` 不含 `/`）。
- ❌ `/api/*` 全部不走缓存（设计如此），所以文件、设备、接力、剪贴板离线一律不可用；移动端只有"发送"进 outbox（`mobile/app.ts:1125-1130`、`:1530-1536`），**接收**没有任何离线能力。

### 2.3 更新机制与 skipWaiting

- `install` 里**没有**调用 `skipWaiting`，只有收到 `{type:"SKIP_WAITING"}` 才升级（`sw.js:70-75`）——这一步做对了。
- 页面侧：发现 waiting/installed 就弹 Toast，用户点"立即刷新"才 `postMessage` + 120ms 后 reload（`pwa.ts:37-54`）。
- 真实缺陷：
  1. **`checkForUpdate()` 竞态**：`await registration.update()` 之后立刻 `Boolean(registration.waiting)`（`pwa.ts:117-127`）。新 worker 往往还在 `installing`，此时返回 false，移动端会提示"已是最新版本"（`mobile/app.ts:1599-1601`）——明明是正在下载。
  2. **`sessionStorage` 标志位是死逻辑**：`controllerchange` 回调只写不读、也不 reload，首次安装与后续更新都被它白白过滤一次（`pwa.ts:56-63`）。
  3. **只刷新点按钮的那个标签页**：其它标签继续跑旧 JS + 新 SW（`pwa.ts:40-43` 无 `clients.matchAll` 广播）。
  4. `clients.claim()`（`sw.js:65`）让新 SW 立刻接管旧页面，与上面的"仅当前页 reload"叠加，是混合版本窗口期。

### 2.4 版本号一致性

| 位置 | 值 | 是否被 `check:version` 覆盖 |
| --- | --- | --- |
| `package.json:4` | 1.9.0 | ✅（基准） |
| `src/lib/version.ts:12` | 1.9.0 | ✅ |
| `worker/api/version.js` | 1.9.0 | ✅ |
| `public/sw.js:19` | `guandao-1.9.0` | ✅ |
| `src/lib/quality/diagnostics.ts:23` | `"1.9.0"` 硬编码 | ❌ |
| `src/lib/quality/perflab.ts:51` | `"1.9.0"` 硬编码 | ❌ |
| `src/lib/quality/errors.ts:281` | `version: "1.9.0"` 硬编码 | ❌ |
| `src/lib/mobile/app.ts:240, 852, 1052` | `"Guandao OS 1.9"` / `"1.9.0 · …"` | ❌ |
| `src/lib/os13.ts:2347` + `index.astro:170` | 界面版本显示 `"1.9"`（写死，不读 OS_VERSION） | ❌ |
| `src/lib/continuity/app.ts:67` | 标题 `"GUANDAO OS 1.8 · CONTINUITY"`（**已经落后一版**） | ❌ |

脚本只比对 4 处（`scripts/check-version.mjs:19-42`），所以后 6 处静默漂移，其中 `continuity/app.ts:67` 已经真实漂移。

---

## 3. 接力与配对

### 3.1 服务端是真实现（不是桩）

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 配对码生成 | 6 位数字 + 一次性 token，**均只存 SHA-256**，TTL 10 分钟 | `worker/api/pairing/store.js:14`、`:28-40`、`:61-76` |
| 二维码 | 内容 `${origin}/pair/#t=<token>`，token 放 hash（不发服务端） | `worker/api/pairing/handlers.js:66` |
| 新设备认领 | `POST /claim` 记设备信息，返回 claimSecret；同一配对最多 5 次 | `handlers.js:84-119`、`:96-102` |
| 旧设备批准 | `POST /:id/confirm`，**必须是发起配对的那台设备** | `handlers.js:201-248`、`:216-218` |
| 领取 Session | 新设备轮询 `GET /claim/:id?secret=`，`confirmed` 时才签发 Session + 设备 Cookie，且只发一次 | `handlers.js:122-198`、`:144-197` |
| 接力内容 | D1 `continuity_items`，8 种类型，payload ≤32KB，TTL 1h–7d（默认 72h） | `worker/api/continuity/store.js:14-30`、`handlers.js:117+`；客户端 TTL 选项 `mobile/app.ts:1085-1096` |
| 剪贴板 | D1 `clipboard_items`，≤4000 字符，24h 过期 | `store.js:29-30`、`handlers.js:55-103` |
| 表结构 | 迁移 0011 建 4 张表（device_pairings / continuity_items / device_contexts / clipboard_items） | `migrations/0011_continuity.sql` |
| 二维码渲染 | 本地生成 SVG（`qrcode`，有 browser 入口，已在 `dist/_astro/browser.Cu_wJ0eH.js` 22.9KB 中打包） | `src/lib/continuity/qr.ts:3-14`；`node_modules/qrcode/package.json` browser 字段 |

### 3.2 真实程度与边界

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| QR 生成（旧设备显示） | ✅ 真 | `src/lib/continuity/ui.ts:198-231`（桌面）、`mobile/app.ts:1291-1301`（移动） |
| QR 扫描（新设备） | ❌ 未实现**扫码**，只能手动输入 6 位码或点链接 | `src/lib/pairing/page.ts:55-65` 只有输入框；`pair.astro` 无摄像头 |
| 配对码输入 | ✅ 真（校验 `/^\d{6}$/`，`page.ts:151-161`） | — |
| payload 传输 | ✅ 真（D1 持久化，可跨小时） | `continuity/store.js:25` |
| clipboard | ✅ 真；`navigator.clipboard` 失败降级到手动复制抽屉（`mobile/app.ts:1690-1704`、`continuity/app.ts:567-581`） | 明文存 D1，24h 过期 |
| Web Push | ❌ **未实现，但如实标注**：接口返回 `enabled:false` + 原因文案 | `worker/api/continuity/handlers.js:40-52`；移动设置页只展示该文案（`mobile/app.ts:1602-1617`） |
| 指定设备投递 | ⚠️ 接力支持（`mobile/app.ts:1070-1082`），**剪贴板 UI 没有目标选择器**，API 的 `targetDeviceId` 在移动端永远为空 | 对比 `continuity/client.ts:199-203` 与 `mobile/app.ts:941-975`、`:1537-1544` |
| 冲突/合并 | ❌ 无（产品无同步引擎） | `README.md:540`、`src/lib/os14/security.ts:584` |

### 3.3 是否需要"两端同时在线"？

**不需要同时在线，但需要"两端都在 10 分钟内动作过"。**

1. 旧设备登录→生成码（在线）；2. 新设备在线提交 claim（拿到 claimSecret）；3. 旧设备在 10 分钟内批准（轮询 3s，`mobile/app.ts:1307-1326` / `continuity/ui.ts:233-245`）；4. 新设备轮询 2s 领 Session（`pairing/page.ts:113-133`）。
内容投递才是真异步：目标设备下次轮询（移动 60s，`mobile/app.ts:1770-1776`；桌面 60s，`continuity/app.ts:349-351`）或启动时拉取即可，不受"另一端此刻在线"约束。

**依赖的未实现后端能力**：只有 Web Push（已如实降级）。没有依赖不存在的接口——`router.js:98-123` 里 pairing/continuity/clipboard/push 全部有真实 handler。

---

## 4. 诊断与性能真实性核查

### 4.1 系统诊断（`src/lib/quality/diagnostics.ts`）逐项

| 指标 | 真实/伪造 | 证据 |
| --- | --- | --- |
| 前端运行 | **真实但恒为"正常"**：数据是实测（Navigation Timing、DOM 节点数、`resourceStats().scopes`），但 `tone:"ok" value:"正常"` 是硬编码，只要代码在跑就绿 | `:91-99`；`src/lib/quality/perf.ts:225-255`、`:376-393`、`src/lib/quality/resources.ts:405-419` |
| /api | **真实探测**（`GET /api/health` + 实测耗时） | `:106-122` |
| D1 | **真实探测**（服务端真的 `SELECT 1`，2s 超时，返回真实 latency） | `:124`、`worker/api/health.js:50-82`、`:59` |
| R2 | **真实探测**（`head` 一个固定 key，返回真实 latency） | `:125`、`health.js:84-130`、`:110` |
| Session | **真实**（`/api/auth/me`），但**未登录也显示绿色"本地模式"**，且 `unauthorized` 分支是死代码（该接口从不返回 401） | `:63-84`、`:78-80`；`worker/api/auth/handlers.js:522-541` |
| **Cloud Sync** | **🔴 伪造的"正常"**：文案来自本地状态机，而**没有任何生产者**。`reportSync` 只在诊断页自己调用并回传当前值（`diagnostics.ts:587` 是 no-op），全仓无同步引擎（`README.md:540`「Notes/Tasks/Calendar 仍是 localStorage，没有云端同步接口」；`security.ts:584`「云同步引擎尚未实现」）。用户看到的是绿色"在线 · 已同步 / 所有本地改动都已保存" | `:135-142`；`src/lib/quality/connectivity.ts:67-74`、`:150-172`；`src/lib/quality/connectivity.ts` 仅 `index.astro:686` 初始化，无业务调用 |
| Backup | **真实**（登录后只读 `GET /api/backups`，取真实条数与时间） | `:145-167`、`worker/api/backups/store.js:131` |
| 插件运行时 | **真实**（`registry.stateSummary()` 统计本地 installs 的 total/enabled/failed/blocked） | `:169-183`、`src/lib/plugins/registry.ts:737-746` |
| 自检 8 项 | **全部真实**：localStorage 写读、IndexedDB 开库+删库、health、session、backups（只读）、SW 注册状态、`caches.keys()`、`GET /sandbox/runner.html` | `:386-533`、`:482-497`、`:500-515`、`:517-530` |

**结论**：8 项里 7 项是真实探测；唯一"未实现却显示正常"的是 **Cloud Sync**。另有两处语义偏差：
- `/api/health` 在任一依赖异常时返回 **503**（`health.js:34-47`），而 `request()` 对非 2xx 直接抛错（`net.ts:314-336`），于是 D1 正常、R2 未配置时，界面会把 API 标成红色"服务暂时不可用"，并把 D1/R2 一起打成"未知 / 接口不可达"（`diagnostics.ts:126-131`）——**可达性判定错误**。
- 诊断中心只捕获桌面外壳的错误（`index.astro:685` 安装全局捕获）；**`/m/` 完全没有接入 `errors.ts`**，移动端异常既不留痕也不进诊断中心。

### 4.2 Performance Lab（`src/lib/quality/perf.ts` / `perflab.ts`）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 测什么 | Navigation Timing（TTFB/DCL/Load）、FCP/LCP/CLS（会话窗口）/INP（近似）、Resource Timing、真实 DOM 图片状态、Chrome `performance.memory`、窗口系统上报的 `performance.now()` 差值、ResourceScope 计数器 | `perf.ts:85-204`、`:225-255`、`:277-316`、`:329-349`、`:376-393`、`:413-418`、`perflab.ts:101-195`、`:252-319` |
| 是否伪造硬件 | **没有**。明确不显示 GPU/CPU/整机内存，拿不到就 `available:false` 并给文案；CLS/INP 不支持时显示"浏览器不支持"而非估算 | `perf.ts:9-13`、`:376-393`、`perflab.ts:1-13`、`:197-241` |
| "综合参考分" | 自研加权公式（LCP .35 / INP .25 / CLS .2 / FCP .12 / TTFB .08），**界面明确写"仅本机纵向比较，不是 Lighthouse"** | `perf.ts:474-487`；`perflab.ts:348` |
| 机器可读测量记录 | **存在**：`docs/perf-measurements.json`（`measuredAt 2026-11-05T09:03:59Z`，冷启 TTFB 4ms / LCP 348ms / transfer 1,191,976B；二次访问 transfer 1545B），由 `scripts/measure-perf.mjs:154-173` 真实生成 | `docs/perf-measurements.json:2-46` |

**性能方面的主要保留意见**：测量是"本机、无节流、Chrome desktop 1440×900"（`measure-perf.mjs:6-12` 自己写明），**没有移动设备/4G 档位**；而移动端首屏 56KB、桌面 445KB 的差距说明真正的风险在桌面入口（实测 `dist/_astro/index.astro_*_lang.BTRxHNgo.js` 445.3 KB）。另外 `perf.ts:471-472` 历史仅 20 条、`startGrowthMonitor` 需 6 次采样才给趋势（`perf.ts:599-609`），单次打开基本看不到结论。

---

## 5. 测试与 CI 现状

### 5.1 实跑结果（本次审计执行）

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-version.mjs` | ✅ 一致：1.9.0 |
| `npx tsc --noEmit` | ✅ 0 error |
| `npx vitest run` | ✅ 3 文件 / **39 通过** |
| `npx playwright test`（对现有 `dist/`，未重新构建） | ✅ **14 通过**（桌面 8 / 手机 3 / 沙箱 3），38.4s |

与 `docs/QUALITY-1.9.md:240-248`、`docs/RELEASE-1.9.md:167-170` 宣称的 39/14/53 完全一致，用例数经我逐文件核对（`it(`/`test(` 计数）无误。

### 5.2 覆盖了什么

| 套件 | 覆盖模块/路径 | 证据 |
| --- | --- | --- |
| 单测 `tests/unit/net.test.ts`（12） | 状态码分类、幂等判定、可重试集合、指数退避+抖动上下界、Retry-After（秒/日期/上限）、错误码提取、`explainError` 的 401/409/离线/429/未知 | — |
| `tests/unit/quality.test.ts`（15） | `redact` 脱敏（GitHub/JWT/k=v/长 hex）、`trimStack`、日志合并计数、导出不含令牌、清理；ResourceScope 的 interval/dispose 幂等/已释放注册/子域/监听移除 | — |
| `tests/unit/perf.test.ts`（12） | `rateVital` 阈值边界、`supportedMetrics` 兜底、应用耗时聚合、快照对比方向、分数区间、outbox 失败分类、版本常量 | — |
| E2E 桌面 `desktop.spec.ts`（8） | 启动渲染、按需加载真实 chunk、开/关窗+Dock、拖拽落盘、深浅色、便签刷新持久、Spotlight、Performance Lab 真实计数 | — |
| E2E 手机 `mobile.spec.ts`（3） | 390×844 首页可见、不加载桌面主包、进笔记 Tab、桌面宽度访问 `/m/` 跳回 | — |
| E2E 沙箱 `sandbox.spec.ts`（3） | 无 nonce MOUNT 被拒、有 nonce 才挂载、iframe 只有 `allow-scripts` | — |
| CI `quality.yml` | verify：check:version → tsc → vitest → build(+CSP) → CSP 哈希非空 → `node --check` → 本地 D1 迁移 → 上传 dist；e2e：重新 build → Playwright | `.github/workflows/quality.yml:42-77`、`:100-105` |

### 5.3 不在 CI 里的脚本（需真机 / 本机 Chrome / 密钥）

| 脚本 | 前置条件 | 证据 |
| --- | --- | --- |
| `os14-qa.mjs`（串 smoke/deep/edge） | `dist/` + 本机 **Windows** Chrome 绝对路径 | `scripts/os14-qa.mjs:12-20`；`os14-smoke.mjs:9-10` 写死 `C:/Program Files/Google/Chrome/...` |
| `security-qa.mjs` / `csp-check.mjs` / `backups-qa.mjs` / `devices-qa.mjs` | `wrangler dev --local` + `GDV_TOKEN`（本地有效 Session） | `security-qa.mjs:7-13`、`csp-check.mjs:4-6`、`backups-qa.mjs:2-3`、`devices-qa.mjs:2-5` |
| `continuity-qa.mjs` / `continuity-ui-qa.mjs` | 本地 D1 预置 3 个 QA Session + Windows Chrome | `continuity-qa.mjs:20-23`、`continuity-ui-qa.mjs:20-21` |
| `devices-multidevice.mjs` | 两个令牌 `GDV_TOKEN`/`GDV_TOKEN_B` | `devices-multidevice.mjs:1-12` |
| `plugins-qa.mjs` / `plugins-ui-qa.mjs` / `community-qa.mjs` | 本地 wrangler + 预置 admin/dev/other Session，或 QA_CSP=1 | `plugins-qa.mjs:2-10`、`plugins-ui-qa.mjs:2-10`、`community-qa.mjs:2-11` |
| `prod-smoke.mjs` / `verify-cloudflare.mjs` | 打线上 `https://guandao.xin`（网络+线上态） | `prod-smoke.mjs:10` |
| `measure-perf.mjs` | 本机 Chrome（Playwright channel=chrome） | `measure-perf.mjs:68` |

即：**所有 API 级、多设备、接力、配对、插件、备份、CSP 行为验证都不在 CI**；CI 里唯一的"集成"是本地 D1 迁移能否跑通（`quality.yml:65-69`），且不校验迁移与线上 schema 的差异。

### 5.4 "通过但其实没测"的四处

1. **移动端"写入本地数据"是真空断言**：`mobile.spec.ts:52-74` 只点 Tab，然后 `raw === null` 就返回 true——不建笔记、不校验内容，永远通过。
2. **"控制台干净"被人为放宽**：桌面与手机都过滤掉 `/api/` 报错与 `Failed to load resource`（`desktop.spec.ts:19-22`、`mobile.spec.ts:22-27`），而 E2E 跑的是**没有 Worker 的静态 dist**（`desktop.spec.ts:7-9` 自认），所以 API 相关回归一律捕获不到。
3. **条件断言**：`perf.test.ts:60-67` 只有在 `count===0` 时才断言，样本存在时该用例不校验任何东西；`perf.test.ts:38-46` 在 Node 里必然全 false，只测了兜底分支。
4. **诊断中心/接力/配对/文件/备份零 E2E**：14 条用例里没有任何一条打开 System Diagnostics 或接力中心（`desktop.spec.ts` 全文只到 perflab）。

---

## 6. 构建部署现状

| 检查点 | 结论 | 证据 |
| --- | --- | --- |
| 部署形态 | **Worker + Static Assets**，`main: worker/index.js`、`assets.directory: ./dist`、`run_worker_first: true`、`not_found_handling: 404-page` | `wrangler.jsonc:4`、`:19-26` |
| 是否 Pages Functions | **不是**，仓库无 `functions/` 目录（已确认不存在），`/api/*`、`/sb/*` 全在 Worker | `worker/index.js:1-12`、`:111-161`；`worker/api/router.js:1-11` |
| README 是否一致 | **主体一致**：`README.md:129-133`、`:542`、`:897` 三处都写明"Worker + Static Assets，不是 Pages Functions"；`docs/RELEASE-1.9.md:37-42` 同 | ✅ |
| README 残留不一致 | ① `README.md:165`「/api/* 目前只有健康检查」（实际 9 组业务 handler + 路由表，`router.js:37-48`、`:98-123`）② `:197`「本阶段也没有任何读写业务数据的路由」③ `:463`「可直接部署到 Cloudflare Pages」④ `:543`「0001–0005 已应用到线上」（迁移已到 0012，`docs/RELEASE-1.9.md:22`） | ❌ |
| 其他过期注释 | `auto-publish.yml:3-4`「Cloudflare 收到推送后构建上线 / 不支持 Deploy Hook」（`RELEASE:46-48` 已明确更正：push 不上线）；`index.astro:80` 注释仍指向 `functions/sb/[[path]].js`；`comment-notify.yml:5` 仍假设 push 会触发重新部署 | ❌ |
| 部署命令 | `cf:deploy = npm run build && wrangler deploy`（`package.json:22`）；`prebuild` 跑 `sync-content --soft`（`:16`），`postbuild` 跑 `gen-csp`（`:17`） | ✅ |
| CSP 生成 | `gen-csp.mjs` 扫 dist 所有 HTML 的内联 `<script>`（排除带 src 与 `application/ld+json`），算 sha256 写入 `worker/api/csp-hashes.js`；`dist` 不存在时**保留旧文件并 exit 0** | `gen-csp.mjs:30-46`、`:48-57`、`:65-73` |
| CSP 使用 | Worker 用哈希拼 `script-src`；**哈希为空时回退 `'unsafe-inline'`** | `worker/index.js:18`、`:26-28`、`:53-70` |
| 版本检查 | 只查 4 处（§2.4），不含 CSP、manifest、页面文案 | `check-version.mjs:19-42` |
| 迁移检查 | CI 只对**本地** D1 跑 `migrations apply --local`；无 remote 比对、无 dry-run diff | `quality.yml:65-69` |
| 安全头 | 所有静态响应经 `secure()`：CSP/HSTS/XFO/COOP/Referrer/Permissions-Policy；404 加 `no-store` + `cdn-cache-control` | `worker/index.js:77-105`、`:168-180` |
| `_headers` | 声明了 `/_astro/*` immutable、`/sw.js` no-cache、manifest 的 Content-Type | `public/_headers:6-25` |

**部署侧的真实风险**：`wrangler deploy` 若不先 `npm run build`（例如直接 `npx wrangler deploy`），`csp-hashes.js` 可能是上一版的哈希 → 内联脚本被强制 CSP 拦掉，桌面白屏；而 CI 只校验"非空"（`quality.yml:57-60`），不校验"哈希与当前 dist 匹配"。这是我认为的 **P0 部署风险**。

---

## 7. 技术债

### 7.1 巨型文件（实测字节）

| 文件 | 体量 | 备注 |
| --- | --- | --- |
| `src/pages/index.astro` | 584.9 KB / 17,503 行 | 桌面外壳 + 全部内联样式/脚本；单 chunk 445 KB |
| `src/lib/os14/community.ts` | 167.1 KB | — |
| `src/lib/os13.ts` | 92.7 KB | 仍在写 `"1.9"` 版本号（`:2347`） |
| `src/lib/mobile/app.ts` | **74.5 KB / 1,803 行** | 11 个视图 + 事件委托 + 网络 + 配对 + 上传全在一个文件 |
| `src/lib/os14/widgetstore.ts` / `security.ts` / `backup.ts` | 59.9 / 56.6 / 53.1 KB | — |

### 7.2 重复实现

- 模式判定 **×3**（`adaptive.ts:48-66`、`m.astro:27-53`、`index.astro:112-129`）。
- `escapeHtml` / `escapeAttr` **×3**（`src/lib/mobile/ui.ts:158-160`、`src/lib/pairing/page.ts:75-81`、`src/lib/quality/errors.ts:435-441`）。
- "发送到设备"面板 **×2**（`src/lib/continuity/ui.ts:60-133` 与 `src/lib/mobile/app.ts:1060-1139`，字段与校验规则各自维护）。
- 收件箱轮询 **×2**（`continuity/ui.ts:297-326` 与 `mobile/app.ts:1770-1786`），语义不同（一个 pushNotif，一个只重绘）。
- 代码块级复制：`mobile/app.ts:1650-1657`（字数统计整段重复）、`continuity/app.ts:524-531`（`if (action === "login")` 连写两遍）、`continuity/ui.ts:290-291`（`contextAuth = authenticated` 重复赋值）。

### 7.3 资源与生命周期

| 问题 | 证据 |
| --- | --- |
| 移动端 60s 轮询、配对 3s 轮询都不挂在 ResourceScope 上；离开设备页后配对轮询仍继续（只有"取消/批准"才清） | `mobile/app.ts:1770-1776`、`:1307-1326`、`:1583-1588` |
| 桌面接力中心 60s 轮询有清理，但 `startContinuity` 里的全局 interval 无清理路径 | `continuity/app.ts:594-597`（有）；`continuity/ui.ts:326`（无） |
| `installRootDisposal()` 定义了但**从未调用** | `src/lib/quality/resources.ts:440-447`；全仓无引用 |
| `openSheet` 并发调用会让先前的 Promise 永不 resolve（`host.innerHTML=""` 直接丢弃） | `src/lib/mobile/ui.ts:50-99` |
| `clearOfflineCache` 删除**所有** cache 且不重新预热，清完当次离线即失效 | `mobile/app.ts:1706-1716` |

### 7.4 未处理 Promise / 无超时请求

- 全仓 **52 处裸 `fetch(`**，统一网络层 `net.ts` **只被诊断中心 import 1 次**（`diagnostics.ts:19`）。因此移动端与接力中心都没有超时、重试、错误分类：
  - `mobile/data.ts:28`（`/api/auth/me`）、`:57`（files）、`:67`（upload）：无超时；`boot()` 的第一个网络请求就是 `await loadAccount()`（`mobile/app.ts:1752`），弱网下首屏会长时间停在"0 笔记 / 未登录"的空状态，且没有任何超时提示。
  - `pairing/page.ts:167`、`continuity/app.ts:318`、`mobile/app.ts:1722`：同问题。
- 移动端未登录但 outbox 有货时，60s 轮询会每轮 401 → `needsLogin` → Toast 反复弹（`mobile/app.ts:1770-1776` + `:1352-1358` + `data.ts:148-153`）。

### 7.5 死代码 / 无效状态

- `state.loading` 只写不读（`mobile/app.ts:96`、`:1749`、`:1767`）→ 启动骨架永远不显示。
- `state.history` 每次启动多打一次 `/api/continuity/history` 却从不渲染（`:1404`、`:1763`）。
- `import { summarize }` 未使用（`:29`）。
- `ui.ts` 导出 `closeSheet` / `deviceIcon` / `relativeTime` 无人引用（`ui.ts:102`、`:137`、`:151`）。
- `errors.ts` 落盘字段写成 `endsAt`（无人读，应为 `savedAt`）（`errors.ts:141`）。
- `resources.ts:417` 在声明（`:422`）之前引用 `liveWindowScopes`，只是因调用时机在模块初始化后才没炸，属脆弱写法。
- `mobile/app.ts:250`：`…filter(active).length || 1` → **0 台在线也显示"1 台在线"**。

### 7.6 API 形状不一致

`/api/auth/me` 返回裸 `{authenticated, user, reason}`（`worker/api/auth/handlers.js:526-541`），其它接口统一 `{success, data}`（`worker/api/http.js:81-86` 的 `ok()`）；`continuity/client.ts:129-138` 只认后者，所以两套客户端（`mobile/data.ts` 裸 fetch、`continuity/client.ts` 包装）并存，任何统一改造都要先收敛形状。

---

## 8. 2.0 增量方案

> 前提：审计时 `src/lib/core/{types,service,storage,bus}.ts` 正在被并行写入（未提交，17:15-17:16）。下述方案**复用**这套骨架，不另起炉灶；若该骨架最终形态变化，接口名可替换，分层不变。

1. **统一诊断中心（最高优先，含"说到做到"）**
   - 以 `core/types.ts:94-103` 的 `HealthReport`（含 `state: ok|degraded|down|unknown`、`latencyMs|null`）作为唯一载体；`null` 表示"没探测"，禁止用 `ok` 兜底。
   - 8 项改为 Service 注册的 probe，**删除 `connectivity` 这条伪 Sync 源**：要么给出真实 sync 服务（Local 模式显示"未启用/仅本机"，Cloud 模式显示队列真实条数），要么显示 `unknown`。
   - 修正可达性判定：健康检查返回 503 时，把"API 可达"与"D1/R2 状态"分开（先看 HTTP 是否能通，再解析 `services`），见 §4.1 的两处语义偏差。
   - 移动端接入：`/m/` 引入 `installGlobalErrorHandlers()`（`errors.ts:339`）与只读诊断页（复用同一 storage key `guandao.os19.diag.v1`），让两端共享诊断记录。

2. **模式判定单一化**
   - 只保留 `adaptive.detectMode()`；`m.astro` / `index.astro` 的内联副本改为读取服务端/构建期注入的 `data-shell`（或只做一次 `<script is:inline>` 的极简兜底，且由脚本生成，不手写）。
   - 用 CSS `@media` + `data-shell` 表达差异，去掉 JS 里的 `dataset.shell === "tablet"` 分支（`index.astro:4705`、`:4936`）。

3. **PWA 2.0**
   - manifest：`id` 与 `start_url` 对齐（都指 `/m/` 或都指 `/`）；补 `screenshots`、`share_target`、`launch_handler`。
   - SW：install 清单由构建生成（新增 `scripts/gen-precache.mjs`，扫 `dist` 产出外壳数组），把桌面 `/` 与入口 chunk 纳入首访预缓存，消除 §2.2 的"首访断网白屏"。
   - 更新：`checkForUpdate` 返回三态（none/downloading/ready）；`controllerchange` 里统一 `location.reload()` 一次并删掉 `sessionStorage` 死标志；多标签用 `clients.matchAll` 广播提示。

4. **版本号单源化**
   - 所有 `"1.9.0"` 字面量改为 `import { OS_VERSION }`（diagnostics/perflab/errors/mobile/continuity），`os13.ts:2347` 与 `index.astro:170` 改读 `OS_VERSION`。
   - `check-version.mjs` 增加规则：`src/**` 中出现 `/\b1\.\d+\.\d+\b/` 或 `OS \d\.\d` 即失败（白名单：version.ts、CHANGELOG、docs）。

5. **CI 增强（按性价比排序）**
   - 立刻：`vitest --coverage` 并设门槛（`vitest.config.ts:16-18` 的 include 目前形同虚设）；构建后跑 `csp-check` 的纯静态版（比对 `dist` 内联脚本哈希 ⊂ `csp-hashes.js`，不需要 Worker/Token）。
   - 次之：新增 `api-e2e` job（`wrangler dev --local` + 迁移 + 种子 Session），至少覆盖 `pairing create→claim→confirm→claim(session)` 与 `continuity send→inbox→open→complete`——这些目前零自动化。
   - 再次：`wrangler deploy --dry-run` 校验绑定与 assets 目录；`migrations list` 与 `dist` 版本号一致性表。
   - 修正 §5.4 的四处真空/宽松断言（尤其 `mobile.spec.ts:63-73`）。

6. **移动端接入 Core（不重写 UI）**
   - 保留 `mobile/app.ts` 的 11 个 `view*()` 纯函数，把"数据获取"下沉：`mobile/data.ts` 改为 `core` 的 Cloud/Storage 适配器（返回值形状不变），从而一次性获得超时、重试、错误分类。
   - 用 `ResourceScope`（`resources.ts:141-151`）挂 60s 轮询、3s 配对轮询、`beforeinstallprompt` 监听（并**提前**到 `boot()` 第一行，修 `app.ts:1788` 的晚注册）；`dispose()` 已幂等，可直接复用。
   - 用 core 的 boot 阶段报告（`core/types.ts:122-140`）替代 `state.loading`，让"启动到哪一步"可见。
   - 路由：把 `paint()` 的嵌套三元（`app.ts:196-228`）换成 `views: Record<Route, () => string>` 表，配 `history` 状态机；`switch` 事件委托拆为 `actions` 表（`app.ts:1412-1627`，已 215 行）。
   - 明确"移动端=同一 Core 的第二个 Shell"：共享 store 的**只读 API + 事件**（现在直接 import store 实例，等于共享可变状态），写操作走 Core 的 mutation 通道。

7. **接力收敛**
   - 剪贴板补目标设备选择（API 已支持 `targetDeviceId`，`continuity/client.ts:199-203`），或明确文档化为"广播"。
   - 把两处轮询收敛为 Core 的 `Cloud` 服务 + `core/bus.ts` 事件，Local 模式不启动，避免空转与 401 Toast 风暴。

8. **验收口径**：诊断中心每一行都必须能回答"数据来自哪个探测、什么时候探测的、失败长什么样"；任何 `ok` 都必须有 producer。这一条建议直接写进 2.0 的 Definition of Done。

---

## 9. 无法确认的点

1. **`public/_headers` 在 Worker Static Assets + `run_worker_first: true` 下是否生效**：Worker 会复制 `ASSETS` 响应头（`worker/index.js:77-105`），但边缘是否应用 `_headers` 未被本审计验证；`serve-dist.mjs` 不模拟该行为。
2. **线上真实状态**：`/api/health` 当前值、D1 是否已应用 0011/0012、当前 Worker 版本 `fecd8355…` 是否仍在线——只读本地代码与文档（`RELEASE-1.9.md:17-22`），未访问生产。
3. **扫码链路的真机行为**：二维码内容与 `/pair/#t=` 解析在代码上闭环（`handlers.js:66`、`page.ts:25-31`），但未用手机实扫；`qrcode` 的运行时渲染只做了静态确认（dist 中存在 browser chunk），未在浏览器里生成过一张真实配对码（需登录态）。
4. **iOS Safari 的 PWA 行为**：安装、`beforeinstallprompt`（Safari 不支持，代码里只有 `installPrompt` 为空时提示"用浏览器菜单"，`app.ts:1592-1598`）、后台轮询挂起后的补发时机，均未真机验证。
5. **`vitest` 覆盖率**：CI 未开 `--coverage`，本次也未生成覆盖率报告，因此"覆盖了哪些模块"是按用例内容判断，不是按行覆盖。
6. **`dist/` 与源码严格同步**：E2E 跑的是 17:13 构建的 `dist`，而审计期间源码仍在被并行修改（`src/lib/core/*`），所以 E2E 通过只证明"那一刻的 dist 通过"。
7. **迁移与线上 schema 的差异**：CI 只跑本地 D1，仓库内没有任何 schema diff 或 remote 校验手段。
8. **`src/lib/core/*` 的最终形态**：§8 引用的 `HealthReport`/`ServiceStatus`/`BootReport` 取自审计时点的未提交文件，后续可能改名或重写。

---

### 附：本次审计的实跑命令与结论

```
node scripts/check-version.mjs   → [version] 一致：1.9.0
npx tsc --noEmit                 → 0 error
npx vitest run                   → 39 passed (3 files)
npx playwright test              → 14 passed (38.4s, 桌面 8 / 手机 3 / 沙箱 3)
```

（`tsc` 关闭了 `noUnusedLocals`（`tsconfig.json` 仅继承 `astro/tsconfigs/strict`），所以 §7.5 的未使用 import/状态不会被类型检查拦住。）