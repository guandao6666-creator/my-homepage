# Guandao OS 1.9 · 质量升级报告

**Release Name:** Polish Before the Next Era
**Version:** 1.9.0 · **Date:** 2026-11-05
**Deployment:** Worker `my-homepage` → `fecd8355-fa4d-45d0-91b5-76d5192b5d7f` · https://guandao.xin

> 本报告里的每个数字都来自本次实际执行：`tsc --noEmit`、`vitest run`、`playwright test`、
> `astro build`、`wrangler deploy`、`wrangler d1 migrations`、`scripts/measure-perf.mjs`、
> `scripts/prod-smoke.mjs`。没有一项是估算或引用历史文档。
> 凡是没有执行的检查，都会在 §13 / §15 里明确写成「未执行」。

---

## 1. 全项目健康检查（Phase 1）

### 1.1 审计方式

- 逐文件阅读源码（`src/` 128 个文件 / 2.8 MB，`worker/` 43 个文件 / 657 KB，`migrations/` 12 个文件）；
- 用真实构建产物反推打包结果（`dist/_astro` 分块、HTML 里实际引用的资源）；
- 实测：`npx tsc --noEmit`（当时 46 个错误）、`node scripts/analyze-bundle.mjs`（主包 841 KB）、
  `npm run build`（2.6 s / 29 页）；
- 线上只读探活：`/api/health`、响应头、CSP 哈希；
- 三条并行深度审计：桌面前端性能 / Worker 与 API 安全 / 插件与社区安全 / 移动端与基础设施。

### 1.2 能力状态（按实测分类）

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| Astro 静态桌面、窗口系统、Dock、虚拟桌面、Mission Control | **已实现并通过测试** | E2E：启动 / 开窗 / 关窗 / 拖拽 / 主题 / Spotlight 全绿 |
| 应用注册、安装 / 卸载、应用中心 | **已实现，存在缺陷（已修）** | 新增内置应用不会被老用户判定为已安装（`catalog.ts`） |
| 主题 / 组件中心、工作空间、数据导出导入 | **已实现，存在缺陷（部分已修）** | 导入格式版本此前不校验（已修）；数据迁移仍无版本升级路径 |
| Guandao Account（GitHub OAuth / Session / 设备） | **已实现并通过测试** | 线上 `/api/auth/me` 返回 `authenticated:false / reason:missing`；401/403 行为符合预期 |
| Cloud Drive（D1 + R2） | **已实现并通过测试** | 线上 R2 put/get/head/delete 能力探测全部 true |
| Backup / Restore / 完整性 | **已实现，安全上限缺失（已修）** | `MAX_BACKUP_BYTES` 之前只声明不使用；现在单次备份与账号总量都生效 |
| Privacy & Security（导出 / 删除 / 注销） | **部分实现** | 导出与删除链路可用；两个清理查询缺索引（已补） |
| Community（作品 / 评论 / 审核 / 安装包） | **已实现并通过测试（旧 QA 脚本 + 本次类型修复）** | 服务端所有权校验齐全；1.9 修了渲染层类型缺陷 |
| Plugin Market / SDK / Sandbox | **已实现，存在安全缺口（已加固 + 部分未修）** | 导航外泄通道已加检测与 nonce 握手；权限默认勾选已改为默认拒绝 |
| PWA / Service Worker / 离线 | **已实现，首次离线不可用（已修）** | 预缓存只含 HTML，不含 JS/CSS；现在页面会回传实际用到的 chunk |
| 移动端 Desktop / Tablet / Mobile 三档外壳 | **已实现并通过测试** | E2E：手机首页、桌面宽度访问 `/m/` 自动回桌面版 |
| 设备配对 / 接力 / 推送 | **已实现，存在数据丢失缺陷（已修）** | 离线队列曾把 401 当永久失败直接丢弃 |
| 多设备云同步引擎 | **尚未实现** | 代码里只有接力快照与 Drive 元数据上报，没有通用同步队列与冲突合并；文档此前也如实写了「仅保留入口」 |
| 第三方可执行插件沙箱 | **部分达标** | 双层 `sandbox="allow-scripts"`、opaque origin、服务端网络代理都正确；**无法阻止插件自我导航**，1.9 改为确定性检测 + 强制禁用 |
| 自动化测试 | **本次新建** | 之前只有手工 puppeteer 脚本，CI 里没有任何测试 |
| CI | **本次新建** | 之前两个工作流只做内容同步与评论通知 |
| 发布 / 回滚 | **部分实现 → 本次补齐** | 之前只有 D1 的 Time Travel 说明，没有 Worker 回滚手册 |

### 1.3 需要人工配置（不是代码问题）

| 项 | 说明 |
| --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `APP_ORIGIN` / `INITIAL_ADMIN_SETUP_TOKEN` | Cloudflare Secret，登录与首次管理员初始化依赖它 |
| `R2_PUBLIC_BASE_URL` | 当前为空 → 安全中心如实显示 Unknown（0 = 不做公网探测，属预期） |
| `GMAIL_APP_PASSWORD` | 评论通知工作流用；未配置时任务退出码 0 但实际不发送 |
| Cloudflare Pages | **不使用**。本项目是 Worker + Static Assets，没有 Git 集成 |

---

## 2. 已发现的问题（Phase 1 产出）

按严重程度摘录，完整清单来自四份深度审计。**P0（可导致数据泄露或整站不可用）：无。**

### P1

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| 1 | 离线队列把所有 4xx 当永久失败丢弃，其中包含 401 | `src/lib/mobile/data.ts` | 会话过期 + 重新联网时，用户离线写的内容被静默删除 |
| 2 | 插件沙箱无法阻止插件把自己的 iframe 导航到外部地址 | `public/sandbox/runner.html` | 绕过 `connect-src 'none'` 与网络白名单，把插件读到的数据放进 URL 带走 |
| 3 | 备份只有「数量 ≤ 60」，`MAX_BACKUP_BYTES` 从不校验 | `worker/api/backups/*` | 一个账号可把 R2 用量放大数十倍 |
| 4 | 关闭的窗口从不从 ResizeObserver 解除观察 | `src/pages/index.astro` | 每次开关窗口永久保留整棵窗口子树 |
| 5 | 权限弹窗默认勾选全部权限 | `src/lib/plugins/ui-kit.ts` | 「默认拒绝」在界面上不成立 |
| 6 | PWA 预缓存不含 `/m/` 的 JS/CSS | `public/sw.js` | 首次安装后断网 = 白屏 |
| 7 | 46 个 TypeScript 错误，其中两个是真实运行期 bug | `workspaces.ts`（缺 `sendToDevice` 导入）、`system.ts`（引用未定义变量 `n`） | 工作空间「发送到设备」必然抛 ReferenceError |
| 8 | 版本号 6 处拷贝，社区清单停在 1.6.0 | `community/manifest.ts` | 声明 `minimum 1.7/1.8` 的社区内容在 1.8 系统上被拒绝安装 |
| 9 | `/sb/*` 反向代理把站点 Cookie 转发给 Supabase | `worker/index.js` | 第三方收到本站会话 Cookie |

### P2（摘录，含已修与未修）

- 登录 / 备份 / 隐私接口的请求体上限只信 `content-length`，分块传输可绕过；
- 配对 `max_attempts` 只写入不校验；三条昂贵路由落到 600 次/分钟的全局兜底；
- 插件举报处理绑定了 `parts[3]`（应为 `parts[2]`），管理员操作实际不生效；
- 新增内置应用不补齐安装状态（`catalog.ts` 注释写了但没做）；
- 组件时钟切换的点击监听被复制两份，一次点击切换两次 → 功能看起来「没反应」；
- 桌面主题有 6 套并存的设计 token；浅色模式里 `[data-os-theme="light"] body` 选择器不可达；
- 桌面有 14 处 `outline: none` 覆盖了键盘焦点框；
- 插件卸载默认「保留数据」且事后无入口清理；命令模式容器 div 泄漏；
- 两个 1 Hz 组件定时器 + 两个 1 Hz 时钟定时器并存；
- 桌面 Dock 放大效果有两套实现同时写 `transform`。

---

## 3. 修复清单（Phase 2–8 产出）

### 3.1 可靠性 / 数据安全

| 修复 | 文件 | 说明 |
| --- | --- | --- |
| 离线队列可恢复失败分类 | `src/lib/mobile/data.ts` | 401 → 保留并提示重新登录；408/429/5xx/网络 → 保留重试（最多 8 次）；只有内容无效的 4xx 才丢弃 |
| 排队补发统一入口 | `src/lib/mobile/app.ts` | `flushOutbox()` 区分「需要登录 / 补发成功 / 丢弃 N 条」 |
| 备份单次与账号上限 | `worker/api/backups/handlers.js` | 单次 ≤ 512 MiB；账号（备份 + 云盘 + 回收站）≥ 2 GiB 拒绝新建 |
| 请求体真实字节复核 | `worker/api/http.js` + backups/privacy | 读取后再校验一次，分块传输无法绕过 |
| 配对尝试次数生效 | `worker/api/pairing/handlers.js` | `attempts >= max_attempts` 直接 429 |
| 导入格式版本校验 | `src/lib/os14/datacenter.ts` | 只接受 `guandao-os/1.x`；版本号来自单一来源 |
| 插件举报处理绑定修复 | `worker/api/plugins/handlers.js` | `parts[3]` → `parts[2]` |

### 3.2 安全加固

| 修复 | 文件 | 说明 |
| --- | --- | --- |
| 沙箱导航检测 + 强制禁用 | `runner.html` + `host.ts` | 插件文档只允许加载一次；第二次 `load` 判定为外泄，立即销毁会话、`blocked=true`、写审计日志 |
| 策略随文档下发 | `runner.html` | 插件文档内注入 `<meta http-equiv="Content-Security-Policy">`，iframe 同时带 `csp` 属性，不再依赖 blob 继承 |
| 沙箱 nonce 握手 | `runner.html` + `host.ts` | MOUNT 必须带回 runner 刚生成的 nonce，被导航后的文档拿不到端口 |
| 权限默认拒绝 | `ui-kit.ts` | 只默认勾选「低风险 + 非私人数据 + 无网络」；高风险/私人数据/网络必须逐项确认 |
| 卸载默认清空数据 | `ui-kit.ts` | 复选框默认不勾选，避免残留无人清理 |
| `/sb` 代理剥离 Cookie / Authorization | `worker/index.js` | 不再把本站会话透传给第三方 |
| 三条昂贵路由独立限流 | `worker/api/ratelimit.js` | 文件下载、恢复执行、配对尝试 |
| 插件命令容器回收 | `host.ts` | `destroy()` 时移除命令模式容器 |

### 3.3 性能 / 资源

| 修复 | 文件 | 说明 |
| --- | --- | --- |
| **应用按需加载** | `os14/index.ts`、`index.astro`、`os14/core.ts` | 23 个应用里 19 个改为 `load()`；打开时先显示骨架，模块到达再渲染，失败可重试 |
| 应用样式随应用加载 | 各应用模块 | 8 个应用样式从首屏 CSS 移到模块内（**注意：见 §5 的诚实说明，Astro 仍把它们链接进 HTML**） |
| 窗口关闭释放资源域 | `index.astro` + `quality/resources.ts` | 每个窗口一个 `ResourceScope`，关闭时清理定时器 / 监听 / 观察器 / Object URL |
| ResizeObserver 解除观察 | `index.astro` | `removedNodes` 时 `unobserve`，并在回调里跳过已离屏窗口 |
| 窗口缩放合帧 | `index.astro` | pointermove 只记录坐标，`requestAnimationFrame` 里写一次 width/height |
| Dock 放大去重 | `index.astro` | 删除 1.0 的重复实现，只保留 1.3 的风格引擎 |
| 图标注入降频 | `icons13.ts` | 只处理未绘制过的图标；页面隐藏时不处理；返回值（disconnect）现在真的被调用 |
| 粒子事件监听回收 | `os13.ts` | 停止粒子时移除 resize 监听 |
| 时钟切换去重 | `widgetstore.ts` | 删除重复监听（原本一次点击切换两次） |
| PWA 首装可离线 | `public/sw.js` + `shell/pwa.ts` | 页面把实际加载过的同源 js/css 发给 SW 预缓存；SWR 的 `waitUntil` 不再在事件结束后调用；`/music/` 不再进缓存；导航缓存上限 40 条 |
| 自动备份退出首屏 | `os14/index.ts` | 改为 `requestIdleCallback`（4 s 兜底）后再检查 |

### 3.4 错误隔离与诊断

| 新增 | 文件 | 说明 |
| --- | --- | --- |
| 全局错误捕获 | `quality/errors.ts` | `error` / `unhandledrejection` / 资源加载失败分别归类 |
| 应用级错误边界 | `index.astro` | 渲染失败、初始化失败、chunk 下载失败、12 s 超时都有独立崩溃卡片（重试 / 关闭 / 打开诊断） |
| 诊断日志（本地环形缓冲） | `quality/errors.ts` | 200 条 / 14 天，30 秒内相同错误合并计数；写盘前脱敏 |
| 统一网络层 | `quality/net.ts` | 超时、取消、指数退避、幂等键、错误分类（401/403/404/409/429/5xx/超时/断网） |
| 在线状态机 | `quality/connectivity.ts` | Online / Offline / Reconnecting / Sync Pending / Sync Failed |
| Performance Lab | `quality/perflab.ts` | 概览 / Web Vitals / 应用性能 / 历史（真实测量，标注适用范围） |
| System Diagnostics | `quality/diagnostics.ts` | 系统状态 / 诊断记录 / 一键只读自检 / 日志与隐私 |

### 3.5 体验一致性

- 键盘焦点：用 `:focus-visible` + `!important` 把被 `outline:none` 覆盖的焦点框要回来；
- 桌面禁止选中，但窗口内容、终端、错误文本恢复可选中；
- Spotlight / 任务视图 / 通知中心补 `role="dialog"`、`aria-modal`、`aria-label`；搜索框补 `aria-label`；
- 浅色模式不可达选择器修正（`body[data-os-theme="light"]`）；
- 手机端 PWA 更新提示补样式（原先在 `/m/` 上是裸按钮）；
- 菜单栏版本号从单一版本源显示 `1.9`。

---

## 4. 性能优化报告（Phase 3–4）

### 4.1 打包体积（真实构建产物）

| 指标 | 1.8（本次会话基线） | 1.9 | 变化 |
| --- | --- | --- | --- |
| 桌面入口 JS | 861 KB（单块） | **445 KB** | **−48%** |
| JS 分块数量 | 12 | 35 | +23（应用独立 chunk） |
| JS 总体积 | 1,040 KB | 1,085 KB | +4%（分块开销 + 新增质量层） |
| CSS 主文件（入口） | 440 KB | 251 KB | −43% |
| **首屏实际链接的 CSS** | **440 KB（1 个文件）** | **444 KB（10 个文件）** | **基本持平** |
| dist 总大小 | 24.5 MB | 23.5 MB | −4% |

> **必须说清楚的一点：** 把应用样式移进按需模块后，入口 CSS 文件确实从 440 KB 降到 251 KB，
> 但 Astro 仍把其余 9 个 CSS 文件以 `<link rel="stylesheet">` 写进首页 HTML（实测 10 个 link、
> 合计 444 KB）。也就是说**首屏 CSS 体积没有真正下降**，只是从 1 个文件拆成 10 个文件。
> 真正把这些样式移出首屏需要「运行时注入 link」或路由级 CSS 拆分，属于 §15 的未完成事项。
> 本次的改动是**为后续拆分做的结构准备**，不虚报收益。

### 4.2 窗口与交互

- 拖动：transform 跟随、松手才写 `left/top`，每次拖放只写一次 localStorage（1.8 已正确，1.9 未回退）；
- 缩放：由「每个 pointermove 写一次宽高」改为「每帧写一次」；
- Dock：删除重复的放大实现，pointermove 的强制布局读取减半；
- 窗口关闭：资源域（定时器 / 监听 / 观察器 / Object URL）确定性释放，ResizeObserver 解除观察；
- 桌面切换、Dock 点击、应用打开都上报真实耗时，可在 Performance Lab「应用性能」查看。

### 4.3 首屏与初始化

- 打开桌面时不再下载 19 个应用模块；
- 自动备份从启动路径移到空闲回调；
- 应用打开采用骨架 → 内容两段式，用户不会对着空白窗口等 chunk；
- 页面隐藏时资源层的 `rafLoop` 自动暂停（新代码统一走 `ResourceScope`）。

### 4.4 图片 / 壁纸

未做新的图片管线改造（本项目壁纸本来就是构建期生成的 WebP + 13× 缩略图）。
本次只补了「已加载/失败/加载中」的真实统计，性能实验室会显示图片数量与失败数。
`srcset`、AVIF、按视口选图仍是未完成事项。

---

## 5. Web Vitals 实测结果

**测量条件（必须连同数字一起读）：** 本机 Chrome（Playwright `channel=chrome`）、1440×900、
静态服务器直连、**无网络节流**。它代表「开发机上的上限」，不是用户设备的中位数，
更不是这台设备的永久性能结论。

| 指标 | 冷启动（空缓存） | 二次访问（已缓存） | web.dev 良好阈值 |
| --- | --- | --- | --- |
| TTFB | 4 ms | 4 ms | ≤ 800 ms |
| FCP | **348 ms** | 216 ms | ≤ 1800 ms |
| LCP | **348 ms** | 232 ms | ≤ 2500 ms |
| CLS | **0.001** | 0.002 | ≤ 0.1 |
| DOMContentLoaded | 117 ms | 54 ms | — |
| Load | 140 ms | 64 ms | — |
| 资源数 / 传输量 | 23 个 / 1,164 KB | 22 个 / 2 KB | — |

按类型（冷启动）：`script 478 KB` · `link(CSS) 447 KB` · `img 238 KB` · `fetch 2 KB`。

- **LCP 元素**是首屏壁纸/开机遮罩区（两者在同帧出现），所以 LCP ≈ FCP；
- **CLS 极低**是因为桌面外壳尺寸在 CSS 里固定，窗口是绝对定位；
- 二次访问传输量 2 KB，说明哈希资源与 `_headers` 的长缓存配置生效。

原始数据：`docs/perf-measurements.json`（可用 `node scripts/measure-perf.mjs` 复现）。
**INP 未测量**：桌面静态加载没有用户交互，用脚本模拟的「点击」不能代表真实 INP；
Performance Lab 会在用户真实操作时持续观测，届时应以那里的数值为准。

### 生产环境读数

| 项 | 实测 |
| --- | --- |
| `/api/health` D1 延迟 | 80 ms |
| `/api/health` R2 head 探测 | 137 ms |
| Worker 启动时间 | 2 ms |
| 上传体积 | 639.48 KiB / gzip 138.15 KiB |

---

## 6. 自动化测试报告

### 6.1 数量

| 套件 | 文件 | 用例 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- | --- | --- |
| 单元测试（Vitest） | 3 | **39** | **39** | 0 | 0 |
| E2E · 桌面（Playwright） | 1 | 8 | 8 | 0 | 0 |
| E2E · 手机（Playwright） | 1 | 3 | 3 | 0 | 0 |
| E2E · 插件沙箱 | 1 | 3 | 3 | 0 | 0 |
| 类型检查（tsc） | — | 0 error | ✅ | — | — |
| 版本一致性 | — | 4 处比对 | ✅ | — | — |
| **合计** | **6** | **53** | **53** | **0** | **0** |

跳过数为 0。没有任何用例被标记为「跳过」来凑通过率。

### 6.2 覆盖范围

**单元（39）**

- 网络层：状态码分类、幂等判定、可重试状态集、指数退避与抖动上下界、`Retry-After`
  秒数/日期/上限、错误体错误码提取、401/409/离线/429/未知异常的说明文案；
- 诊断层：GitHub 令牌 / JWT / `key=value` / 长十六进制脱敏、堆栈裁剪、记录合并计数、
  导出内容不含令牌、清理生效；
- 资源层：interval 释放后不再触发、dispose 幂等、已释放域注册即清理、子域随父域释放、
  事件监听释放后不再收到事件；
- 性能层：LCP/INP/CLS 阈值边界、支持度探测不谎报、应用耗时聚合、
  快照对比方向、综合分区间；
- 离线队列：401 / 408 / 429 / 4xx / 5xx / 网络错误的分类；
- 版本：`src/lib/version.ts` 与 `package.json` 一致。

**E2E（14）**

- 桌面：启动渲染、按需加载（真实请求 chunk）、开窗/关窗与 Dock 状态、拖拽并落盘、
  深/浅色切换、便签写入后刷新仍在、Spotlight 搜索、Performance Lab 打开并显示真实计数；
- 手机：390×844 首页可见、**不加载桌面主包**、进入笔记标签、桌面宽度访问 `/m/` 自动跳回；
- 沙箱：无 nonce 的 MOUNT 被拒、正确 nonce 才能挂载、iframe 属性只能是 `allow-scripts`。

### 6.3 未覆盖模块（如实列出）

- Worker 业务接口的集成测试（文件、备份、社区、插件、隐私）：需要可登录的测试账号与
  远程 D1/R2，本次未建立隔离测试环境；已有手工脚本 `scripts/*-qa.mjs` 复用，但不在 CI 中；
- 多设备（两个独立浏览器上下文）同步 / 冲突：产品本身没有同步引擎，无可测对象；
- 真实鼠标/触屏手势的陀螺仪、剪贴板、通知 API：Playwright 无法完整模拟，未测。

---

## 7. 安全审计摘要

### 7.1 结论

- **P0：0 个。**
- 后端三件最容易出错的事都做对了：全部 SQL 绑定参数（52 处 `${}` 都在 SQL 结构位置）、
  `user_id` 一律取自会话（没有任何 `body.userId`）、所有变更接口都有同源断言。
- Session 是不透明 256 位随机令牌，库里只存 SHA-256，没有可泄露的签名密钥。
- 仓库与构建产物中没有 GitHub Client Secret / 初始化管理员令牌 / R2 凭证 / Session 签名密钥。

### 7.2 本次修掉的安全问题

1. **沙箱导航外泄（P1）**：检测 + 终止 + 禁用 + 审计；CSP 随文档下发；nonce 握手；
2. **备份存储放大（P1）**：单次与账号总量双重上限；
3. **`/sb` 泄露本站 Cookie**：代理不再转发 Cookie / Authorization；
4. **权限默认全选**：改为低风险才默认勾选；
5. **卸载默认保留数据**：默认清空；
6. **请求体上限可绕过**：按实际字节数复核；
7. **配对尝试无上限**：`max_attempts` 生效 + 独立限流；
8. **插件举报处理不生效**：绑定修正。

### 7.3 明确未修（见 §13）

- 插件发布后改名/改描述不需要重新审核（钓鱼式换名）；
- `/api/plugins/:id/file` 不要求会话，可匿名抓取已发布插件源码；
- 限流只有 IP 维度，没有按用户；
- 备份在 R2 是明文 JSON（依赖 R2 服务端加密），没有应用层加密；
- `window.open` 权限在清单里声明但宿主未强制映射。

---

## 8. 数据完整性测试结果

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| D1 迁移可执行 | `wrangler d1 migrations apply --local` | ✅ 10 条语句 |
| D1 迁移远程一致 | `migrations list --remote` | 仅 0012 待应用 → 已应用 ✅ |
| 迁移向前兼容 | 审查 0012 | 只加索引，不改表、不删数据，可 DROP INDEX 回滚 |
| D1 连通 | `/api/health` | `connected`（本地 15 ms / 线上 80 ms） |
| R2 连通 | `/api/health` head 探测 | `available`，put/get/head/delete 全部 true（线上 137 ms） |
| 备份单次上限 | 代码审查 + 新增校验 | 超过 512 MiB 直接失败并清理，不写 `size_bytes` |
| 备份账号上限 | 代码审查 + 新增校验 | 备份 + 云盘 + 回收站 ≥ 2 GiB 拒绝新建 |
| 导入格式校验 | 代码审查 | 现在真的校验 `guandao-os/1.x` |
| IndexedDB 结构 | 代码审查 | 两个库均为 v1，`onupgradeneeded` 只有建表；**没有版本升级路径**（见 §13） |
| R2 孤立对象扫描 | 未执行 | 需要全桶 List，成本高，且本次没有管理员巡检工具 |

**没有做的部分要讲清楚：** 本次没有对 R2 做全量一致性扫描（D1 记录 ↔ 真实对象），
也没有对 IndexedDB 做迁移演练。原因与后续做法写在 §13 / §15。

---

## 9. 移动端测试结果

| 项 | 结果 |
| --- | --- |
| 手机首页（390×844，iPhone UA） | ✅ 可见，且**没有**请求桌面主包 |
| 手机首屏传输 | HTML + 16.5 KB CSS + 57 KB 手机脚本 + PWA 51 KB + 自适应 3.8 KB + 壁纸 195 KB ≈ 318 KiB（与 1.8 审计一致，本次未新增依赖） |
| 手机进入笔记 | ✅ 标签可切换 |
| 桌面宽度访问 `/m/` | ✅ 自动跳回 `/`（1.9 新增：在 head 里先判断，不必先下载 112 KB 脚本） |
| 手机 PWA 更新提示样式 | ✅ 已随 `pwa.css` 加载 |
| 离线首装 | 已修（页面回传 chunk 给 SW），但**未在真机验证**，只有代码路径与本地 SW 测试 |

未测：iOS Safari 真机、Android WebView、推送通知、设备配对全流程。
（设备配对与接力的服务端逻辑已有单元级实现与旧的手工 QA 脚本，本次未纳入 CI。）

---

## 10. CI 工作流说明

文件：`.github/workflows/quality.yml`

- **触发**：push 到 main、PR 到 main、手动。
- **verify 作业**：安装依赖 → 版本一致性 → `tsc --noEmit` → Vitest → `astro build`（含 CSP 哈希生成）
  → 检查 `csp-hashes.js` 非空 → `node --check` Worker 入口 → 本地 D1 应用迁移 → 上传 `dist`。
- **e2e 作业**（依赖 verify）：重新构建 → Playwright（本机 Chrome，`channel: "chrome"`）→ 上传报告。
- **权限**：`contents: read`，不保存任何 Cloudflare / GitHub / Supabase 密钥。
- **不自动部署**：生产发布仍是人工 `npm run cf:deploy`，避免未经检查的版本上线。
- **与现有工作流的关系**：`auto-publish.yml`（内容同步）与 `comment-notify.yml`（评论通知）保持不变，
  互不依赖。

需要 GitHub 仓库设置里把 `quality` 设为 main 的必需检查（branch protection），才能真正阻止合并；
这一步需要仓库管理员在网页上操作，代码改不了。

---

## 11. 性能预算（1.9 基线）

| 项目 | 预算 | 当前实测 | 状态 |
| --- | --- | --- | --- |
| 桌面入口 JS | ≤ 480 KB | 445 KB | ✅ |
| 首屏 CSS（所有 link 合计） | ≤ 300 KB（目标） | **444 KB** | ❌ 未达标 |
| 单个应用 chunk | ≤ 130 KB | 最大 community 125 KB | ✅ |
| 首屏传输总量 | ≤ 1.3 MB | 1,164 KB | ✅ |
| 壁纸首屏 | ≤ 260 KB | 238 KB | ✅ |
| 首屏字体 | 0 字节 | 0（系统字体栈） | ✅ |
| LCP（本机无节流） | ≤ 1.5 s | 348 ms | ✅ |
| CLS | ≤ 0.1 | 0.001 | ✅ |
| 移动首屏 | ≤ 350 KiB | ≈ 318 KiB | ✅ |
| 新增依赖 | 0 个运行时依赖 | 仅 devDependencies（vitest / playwright / typescript） | ✅ |

后续任何提交如果让入口 JS 或首屏 CSS 明显上涨，都应该在 PR 里解释原因。

---

## 12. 修改文件清单

### 新增（1.9）

```
src/lib/quality/resources.ts      资源生命周期（ResourceScope + 计数器）
src/lib/quality/net.ts            统一网络层（超时/重试/取消/幂等键/错误分类）
src/lib/quality/errors.ts         错误边界 + 脱敏诊断日志 + 崩溃卡片
src/lib/quality/perf.ts           Web Vitals / 资源 / 图片 / 内存 / 应用耗时 / 历史
src/lib/quality/connectivity.ts   Online / Offline / Reconnecting / Sync Pending / Failed
src/lib/quality/perflab.ts        Performance Lab 应用
src/lib/quality/diagnostics.ts    System Diagnostics 应用
src/lib/version.ts                前端唯一版本来源
src/styles/quality.css            质量层样式（卡片/诊断/崩溃/焦点/可选中）
src/styles/pwa.css                桌面与手机共用的 PWA 更新提示样式
worker/api/version.js             Worker 唯一版本来源
migrations/0012_indexes.sql       9 个热点索引（只加索引）
vitest.config.ts / playwright.config.ts
tests/unit/net.test.ts            12 用例
tests/unit/quality.test.ts        15 用例
tests/unit/perf.test.ts           12 用例
tests/e2e/desktop.spec.ts         8 用例
tests/e2e/mobile.spec.ts          3 用例
tests/e2e/sandbox.spec.ts         3 用例
.github/workflows/quality.yml     CI 质量门禁
scripts/check-version.mjs         版本一致性
scripts/measure-perf.mjs          真实性能测量
scripts/prod-smoke.mjs            生产只读冒烟
scripts/analyze-bundle.mjs        打包体积分析（审计工具）
docs/RELEASE-1.9.md / docs/QUALITY-1.9.md / docs/perf-measurements.json
```

### 修改（按主题）

- **入口与外壳**：`src/pages/index.astro`（按需挂载、错误边界、资源域、ResizeObserver 回收、
  缩放合帧、Dock 去重、重复深链表删除、菜单项、a11y、版本号、CSS 引入）、`src/pages/m.astro`（早跳、样式）
- **应用注册**：`src/lib/os14/index.ts`（19 个懒加载 spec、空闲备份、版本）、`os14/core.ts`（`load` 类型）、
  `os14/system.ts`（未定义变量）、`os14/catalog.ts`（内置应用补齐安装状态）
- **应用实现**：`os14/datacenter.ts`、`os14/community.ts`、`os14/devices.ts`、`os14/games.ts`、
  `os14/music-core.ts`、`os14/workspaces.ts`、`os14/{drive,backup,security,playground}.ts`（样式引入）、
  `os13.ts`（类型、粒子监听、版本）、`icons13.ts`（注入效率）
- **插件与沙箱**：`plugins/host.ts`、`plugins/ui-kit.ts`、`plugins/registry.ts`、`plugins/manager.ts`、
  `public/sandbox/runner.html`、`public/sw.js`
- **其他前端**：`account/client.ts`、`backups/client.ts`、`continuity/app.ts`、`mobile/app.ts`、
  `mobile/data.ts`、`pairing/page.ts`、`shell/pwa.ts`、`styles/adaptive.css`
- **Worker**：`index.js`、`api/health.js`、`api/router.js`、`api/http.js`、`api/ratelimit.js`、
  `api/backups/handlers.js`、`api/privacy/handlers.js`、`api/pairing/handlers.js`、`api/plugins/handlers.js`
- **工程**：`package.json`（版本 1.9.0 + 5 个脚本）、`tsconfig` 未改（本来就 strict）

> 工作区里还有 1.5–1.8 期间未提交的功能代码（devices / backups / privacy / community / plugins /
> continuity / mobile 等）。它们不是本次 1.9 新增，但本次的审计与测试覆盖到了它们。

---

## 13. Cloudflare 构建与部署结果（Phase 14）

### 13.1 构建

```
astro build            29 页，2.30 s
postbuild (gen-csp)    12 个内联脚本哈希，扫描 30 个 HTML
wrangler deploy        43 个资产更新（133 个已存在），上传 639.48 KiB / gzip 138.15 KiB
Worker 启动时间        2 ms
```

### 13.2 部署

```
Worker: my-homepage
Version ID: fecd8355-fa4d-45d0-91b5-76d5192b5d7f
Triggers: */15 * * * *
Bindings: DB(D1) / FILES(R2) / ASSETS / BACKUP_CRON_ENABLED / R2_PUBLIC_BASE_URL
```

### 13.3 线上验证（只读）

| 检查 | 结果 |
| --- | --- |
| `/api/health` | `success:true, status:ok, version:1.9.0` |
| D1 | connected（80 ms） |
| R2 | available（137 ms，probe not_found 属正常） |
| 首页响应头 | CSP（12 哈希）+ `x-frame-options: DENY` + HSTS |
| 新版资源 | 首页引用新哈希；旧哈希正确返回 404 且 `no-store` |
| `scripts/prod-smoke.mjs` | **8/8 通过**（含真实打开按需加载的便签应用） |

---

## 14. 剩余风险

| 风险 | 影响 | 建议 |
| --- | --- | --- |
| 首屏 CSS 仍是 444 KB（10 个 link） | 中：移动端流量与首屏渲染 | 下一版做路由级 CSS 拆分或运行时注入 |
| `index.astro` 17,500 行单文件 | 中：冲突、审查、冷启动解析 | 逐步把应用实现搬出到 `src/lib/apps/*` |
| 没有通用同步引擎 | 高（能力上限）：多设备编辑无法同步 | 2.0 的平台化前置项 |
| 插件发布后改名不需复审 | 中：钓鱼式换名 | 服务端把 name/description/icon 视为敏感变更 |
| `/api/plugins/:id/file` 无需会话 | 低-中：匿名抓取已发布源码 | 加登录校验或签名 URL |
| 限流只有 IP 维度 | 中：共享出口 IP 的用户会互相影响 | 用 `rateLimit(env, request, rule, userId)` 的 scope 参数 |
| 备份无应用层加密 | 中：依赖 R2 静态加密 | 用账号派生密钥做信封加密 |
| IndexedDB / localStorage 无版本升级路径 | 高：将来一次 schema 变更可能覆盖用户数据 | 引入 `migrate(raw, from, to)` + 迁移前自动备份 |
| 代码未提交 / 未打标签 | 中：无回滚锚点 | 按 `docs/RELEASE-1.9.md` §7 提交并 `git tag v1.9.0` |
| 深色/浅色有 6 套 token 并存 | 低-中：主题补丁越加越多 | 先合并 `--os-*` 两套，再谈统一 |
| 插件沙箱导航检测是「检测」不是「阻止」 | 中：极端情况下仍有一次外泄机会 | 把 runner 放到独立域名（`sandbox.guandao.xin`）是根治方案 |

---

## 15. 未完成事项

1. **首屏 CSS 真正按需**：当前只做了文件拆分，没有移出 HTML 的 `<link>`；
2. **Lighthouse 报告**：本次没有安装 Lighthouse，用的是浏览器原生 Navigation Timing +
   PerformanceObserver。要产出 Lighthouse 报告需要额外依赖与一次专门运行；
3. **Worker 接口集成测试**：文件 / 备份 / 社区 / 插件 / 隐私的自动化 API 测试需要隔离账号与
   测试库，本次没有搭建；
4. **多设备测试**：没有同步引擎，也没有真正跑两个独立浏览器上下文的同步用例；
5. **R2 一致性巡检工具**：管理员专用的分页扫描（D1 记录 ↔ 对象 ↔ 孤儿对象）未实现；
6. **R2 批量删除超过 D1 100 参数上限**：递归删除大目录仍可能失败（审计 P2，未修）；
7. **移动端编辑时的整树重绘**：来信刷新会重建 `<textarea>`，打断输入法组合（审计 P1，未修）；
8. **组件 1 Hz 多次重绘**：两个组件定时器 + 两个时钟定时器仍在，未合并；
9. **插件社区剩余安全问题**：改名复审、插件文件接口鉴权、`window.open` 权限未映射；
10. **`files` 接口的 JSON 读取上限**：只修了 backups / privacy，files 的 `readJson` 仍只信 `content-length`。

---

## 16. 一句话总结

1.9 把「一开桌面就下载全部应用」变成按需加载（入口 JS −48%），给每个应用加了真正的错误边界、
统一网络错误说明与资源回收，补齐了 53 个自动化用例与一条会拦住类型错误 / 版本漂移 / 构建失败的 CI，
修掉了 9 个 P1（含 3 个数据安全类），并成功发布到 Cloudflare Worker（`1.9.0` 线上验证 8/8）。
同时，首屏 CSS 体积、同步引擎、IndexedDB 迁移保护这些真正困难的部分仍然摆在那里，
已在本报告 §14/§15 如实列出，没有用「已优化」四个字糊过去。