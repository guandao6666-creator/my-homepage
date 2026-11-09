# 插件沙箱安全边界（Phase 3.2）

> Phase 3.2 交付物。状态：本机真实 Worker（`wrangler dev --local` + `dist/` 构建产物）上 E2E 实测通过；**未在生产环境验证**（本阶段不做生产部署）。测试代码：`tests/e2e/sandbox-worker.spec.ts`、`tests/e2e/sandbox.spec.ts`。
>
> 本文只描述**现在真实存在**的机制。凡属设计但未实现、或只在测试里模拟的部分，均单独标注「未验证 / 未实现」。

---

## 1. 结论摘要

- 插件运行在**两层 `sandbox="allow-scripts"`** 的 iframe 里，两层都没有 `allow-same-origin`：外层是宿主页里的 `/sandbox/runner`，内层是 runner 用 Blob URL 创建的插件文档。插件文档的真实 Origin 是 opaque（`"null"`），读不到宿主 Cookie / localStorage / DOM。
- 握手是一次性 nonce + 一次性 `MessageChannel` 端口：HELLO 只用来同步 nonce，真正的通信端口只在 MOUNT 时通过 `postMessage` 的 transfer list 交给 runner；握手成功后宿主把端口作为唯一控制通道。
- 所有能力经宿主 Broker 白名单校验：方法表 + 声明授权 + 60 次/10 秒限速 + 24 KB 请求体 + 8 秒超时；`pluginId` 由 runner 用挂载时确认的身份**覆盖**，不采信插件自报。
- 插件文档自带 CSP：`default-src 'none'`、`connect-src 'none'`、`frame-src 'none'`、`form-action 'none'`，没有网络出口；宿主为 `/sandbox/*` 响应独立 CSP 头（`frame-ancestors 'self'`、`frame-src 'self' data: blob:`、`cache-control: no-store`）。
- 导航逃逸（插件把自己的 frame 导航出沙箱）**只能事后检测**：runner 记录 `load` 次数，第二次 load 即上报 `sandbox:navigation`，宿主终止会话、`blocked=true` 持久禁用并上报 `/api/plugins/:id/security`。
- 实测结果：`sandbox-worker.spec.ts` **10/10 通过（35.7s）**；`chromium` project 全量 **67/67 通过（1.8m）**，其中 `sandbox.spec.ts` **6/6 通过（4.5s）**；`npx tsc --noEmit` 通过。详见 §3。
- 发现一个与本阶段相关的真实 UI 缺陷：插件管理器「已安装」标签在有本地安装记录时退化成「安全策略」卡片，本地安装插件没有列表/详情入口，因此也没有「权限」撤销入口（见 §4.6、§7）。本阶段未修改该文件（超出任务边界）。

---

## 2. 隔离机制现状（真实代码）

### 2.1 三层文档结构

```
宿主页 https://<host>/                    （应用 bundle、localStorage 状态源）
└─ iframe  /sandbox/runner?v=1.7.0        sandbox="allow-scripts"，opaque origin
   └─ iframe  Blob URL（插件文档）          sandbox="allow-scripts"，opaque origin
```

| 层 | 创建位置 | 关键属性 |
| --- | --- | --- |
| 宿主 → runner | `src/lib/plugins/host.ts:195-201` | `sandbox="allow-scripts"`、`referrerpolicy="no-referrer"`、`src="/sandbox/runner?v=1.7.0"` |
| runner → 插件 | `public/sandbox/runner.html:136-143` | `sandbox="allow-scripts"`、`referrerpolicy="no-referrer"`、`csp="<PLUGIN_CSP>"`，内容经 Blob URL（失败时回退 `srcdoc`） |
| worker `/sandbox/*` | `worker/index.js:92-104,132` | 独立 CSP 响应头（见下）、删除 `x-frame-options`/COOP、`cache-control: no-store` |

三份 CSP 各自的作用：

- **应用页 CSP**（`worker/index.js:106-123`）：`frame-src 'self' blob: data:` 允许加载 runner；`frame-ancestors 'none'` 禁止被嵌入。
- **runner CSP**（`worker/index.js:92-104`，`SANDBOX_CONTENT_SECURITY_POLICY`）：
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`
- **插件文档 CSP**（`public/sandbox/runner.html`，`PLUGIN_CSP`，同时写入 `<meta http-equiv="Content-Security-Policy">` 和 iframe 的 `csp` 属性）：
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`

> 注：插件文档是 Blob URL。Chrome 对本地 scheme 文档会继承创建者 CSP，这也是为什么 runner 既写 `<meta>` 又给 iframe 加 `csp` 属性，做双保险。

### 2.2 握手与消息链路

1. runner 启动即向 `window.parent` 发 HELLO：`{channel:"guandao.plugin.sandbox", kind:"HELLO", nonce}`，nonce = `Math.random().toString(36).slice(2) + Date.now().toString(36)`（`runner.html:343-345`）。
2. 宿主 `onWindowMessage`（`host.ts:219-240`）只接受：
   - `event.source === this.iframe.contentWindow`（**不依赖 `event.origin`**，因此 opaque origin 也能安全判断身份）；
   - `channel === "guandao.plugin.sandbox"`；
   - `kind === "HELLO" && !this.mounted`；
   之后记录 nonce 并进入 mount。
3. 宿主 `mount()`（`host.ts:242-285`）：
   - 读取 SDK 与插件入口 HTML（`loadSdk` / `loadEntryHtml`，后者会 `verifyBundle` 复核包摘要与 `packageHash`）；
   - 新建 `MessageChannel`，把 **`port2` 作为 transfer** 与 MOUNT 消息一起发出：`{channel,kind:"MOUNT",mountId:"mnt-...",nonce,pluginId,html,sdk,granted,theme,context}`；
   - 12 秒内没收到 READY 就判定启动失败并销毁。
4. runner 收 MOUNT（`runner.html:102-123`）必须同时满足：`event.source === hostWindow`、channel、`kind==="MOUNT"` 且未挂载、`event.ports[0]` 存在、`pluginId` 非空、**nonce 与自己的 HELLO nonce 完全相等**、HTML 非空且 ≤2.6 MB、SDK 非空且 ≤160 KB。任一失败直接 `throw`，不会交出端口（宿主侧表现为 12s 超时）。
5. 握手成功后，宿主后续 RPC 全部走这个 MessagePort；runner 把 `RESULT` / `EVENT` 转给插件 frame，把插件 RPC 转给宿主端口。

### 2.3 RPC 校验（插件 → 宿主）

| 校验点 | 位置 | 规则 |
| --- | --- | --- |
| 来源 | `runner.html:238-250` | 必须是内层插件 frame 的 `contentWindow`、`channel === "guandao.plugin"`、`kind === "RPC"` |
| requestId | 同上 | `/^[a-zA-Z0-9_.:-]{1,64}$/`，不合法直接丢弃 |
| method | 同上 | `/^[a-zA-Z0-9_.]{1,40}$/`，不合法直接丢弃 |
| payload 大小（runner） | 同上 | 序列化后 >64 KB → `PAYLOAD_TOO_LARGE`「参数超过大小限制」 |
| pluginId | 同上 | **用 mount 时确认的 `mount.pluginId` 覆盖**，不采信插件自报 |
| pluginId 一致性 | `host.ts:298-338` | 请求里的 `pluginId` 必须等于当前会话 record.id，否则忽略 |
| 方法白名单 | `host.ts:364-414` | `METHOD_PERMISSION` 表，未知方法 → `UNKNOWN_METHOD` |
| 权限 | 同上 | `METHOD_PERMISSION[method]` 非空且 `record.granted` 不含 → `PERMISSION_DENIED`，并写 warn 日志 |
| 限速 | 同上 | 60 次 / 10 秒 → `RATE_LIMITED` |
| 请求体 | 同上 | 序列化后 >24 KB → `PAYLOAD_TOO_LARGE`「参数超过 24 KB」 |
| 超时 | 同上 | 8 秒无结果 → `TIMEOUT`「宿主处理超时」 |

`METHOD_PERMISSION` 的关键条目（`host.ts:64-93`）：`app.context`/`ui.toast`/`ui.setTitle`/`ui.resize`/`ui.close`/`lifecycle.error` 无需权限；`storage.get|keys` 需要 `plugin.storage.read`；`storage.set|delete|clear` 需要 `plugin.storage.write`；`network.fetch` 需要 `network.fetch`（服务端还会再复核域名）；`files.*`、`calendar.*`、`notes.*`、`ui.openApp`、`ui.notify`、`commands.register`、`widget.*` 各有独立权限项。

### 2.4 状态与存储

- 插件数据不落插件侧存储，只通过 `storage.*` RPC 落到宿主 localStorage 的 `guandao.plugin.storage.<pluginId>` 命名空间（`store.ts`）；键名 `^[A-Za-z0-9._-]{1,64}$`，有单插件配额与全局 2 MB 配额。
- 插件包本体在宿主 IndexedDB `guandao-os14` / `blobs`，键 `plugin:<id>@<version>`。
- 插件清单与授权在 `localStorage["guandao.plugins.v1"]`（`{v:1, installs:{...}}`），是唯一状态源。

### 2.5 生命周期、撤销与逃逸

- 关闭窗口/导航/命令结束都会 `destroy()`：向端口发 `DESTROY` → 关闭端口 → 移除 iframe（`host.ts:829-860`）。
- 权限变更（`registry.saveGrantedPermissions`，`registry.ts:586-601`）：过滤声明权限 → **`destroySessionsFor(id)` 立即销毁运行实例** → 写回 `granted`/`needsConsent`。即「授权是挂载时快照，撤销后重启」。
- 跨标签页：宿主监听 `storage` 事件（`host.ts:899-904`），`guandao.plugins.v1` 变化时销毁本页所有会话。
- 导航逃逸：runner 记录内层 iframe 的 `load` 次数（`runner.html:173-196`）。第二次 load → `postToHost({kind:"EVENT",event:"sandbox:navigation"})` → `location.replace("about:blank")` 并终止。宿主收到后：写 error 日志「插件试图导航出沙箱，已强制禁用」、toast、`patchInstall({enabled:false, blocked:true})`、`reportSandboxEscape()` POST `/api/plugins/:id/security`、销毁会话。

---

## 3. 测试与实测结果

### 3.1 测试资产与命令

| 资产 | project | 说明 |
| --- | --- | --- |
| `tests/e2e/sandbox-worker.spec.ts`（新增） | `worker` | 10 个用例，`page.goto` 到真实 Worker `http://127.0.0.1:8788`（`wrangler dev --local` + `dist/`），真实 CSP 响应头、真实 runner/SDK |
| `tests/e2e/sandbox.spec.ts`（扩充） | `chromium` | 原 3 个握手/属性用例保持不动，新增 3 个静态/运行时断言，共 6 个 |
| `docs/security/PLUGIN-SANDBOX.md` | — | 本文 |

```powershell
npx tsc --noEmit
npx playwright test --project=worker tests/e2e/sandbox-worker.spec.ts
npx playwright test --project=chromium
```

> `worker` project 的 webServer 会复用已经在跑的 8788（`scripts/e2e-server.mjs`），未重启服务；页面层首次在真实 Worker 上跑（此前 E2E 只跑 4399 静态 dist，`plugin-signature.spec.ts` 只测 API，不加载页面）。

**实测结果（2026-11-07，本机 Windows / Chrome stable / Node v26.13.0）：**

- `npx tsc --noEmit`：通过（无输出）。
- `npx playwright test --project=worker tests/e2e/sandbox-worker.spec.ts`：**10 passed (35.7s)**（重启 8788 前一轮 35.1s，结果一致）。
- `npx playwright test --project=chromium`：**67 passed (1.8m)**，其中 `sandbox.spec.ts` **6 passed (4.5s)**。

### 3.2 十项逐条结果

| # | 场景 | 关键断言（实测） | 性质 |
| --- | --- | --- | --- |
| 1 | 正常插件运行 | 宿主 `.gp-frame` 存在且 `sandbox="allow-scripts"`、无 `allow-same-origin`、`referrerpolicy="no-referrer"`、`src` 含 `/sandbox/runner`；runner 内层 iframe 同样只有 `allow-scripts`、经 Blob URL 载入；**插件脚本真的执行了**（`window.__probeBooted` 为真）、SDK 已注入（`typeof guandao === "object"`）、收到 MOUNT 配置（pluginId/mountId/granted）；宿主 record 日志含「应用窗口已启动」，`enabled=true`、`blocked=false`；runner 页 CSP 响应头含 `default-src 'none'`、`connect-src 'none'`、`frame-src 'self' data: blob:`、`frame-ancestors 'self'` | 属性断言 + 真实行为（插件执行、日志） |
| 2 | 消息通信 HELLO → MOUNT → RPC | 宿主页 trace 收到 HELLO（channel、非空 nonce、来源不是宿主自己）；runner trace 收到 MOUNT（`event.ports.length === 1`、html/sdk 长度 >0、pluginId 正确、nonce 与 HELLO 完全相等、来源是父窗口）；插件 frame 收到 RESULT；插件内 `guandao.app.context()` 返回 `{pluginId, sandbox:true, type:"application", mode:"app", granted}` | 真实行为（运行时消息与 RPC 往返） |
| 3 | 伪造 `event.source` 的 HELLO / RPC | 宿主页里插入独立的 `sandbox="allow-scripts"` `data:` iframe，由它向宿主发伪造 HELLO / READY / RPC；**伪造消息确实到达宿主**（宿主 trace 可见，`sourceIsSelf=false`），但没有产生新的 MOUNT、`.gp-frame` 数量不变、record 未被改写、真实插件 `app.context()` 仍成功 | 真实行为（伪造注入 + 会话不受影响） |
| 4 | 恶意 postMessage | 直连 runner 页：错误 nonce 的 MOUNT → 无 READY、无 iframe；同一页面用正确 nonce → READY 且 iframe 为 `allow-scripts`。真实插件帧：错误 channel 的 RPC 无回包；非法 requestId / method 字符无回包；30 KB payload → 宿主 `PAYLOAD_TOO_LARGE`「参数超过 24 KB」；70 KB payload → runner 先拒绝 `PAYLOAD_TOO_LARGE`「参数超过大小限制」；插件自报 `pluginId=com.attacker.someone.else` 被 runner 覆盖，`app.context()` 返回的仍是真实 PLUGIN_ID | 真实行为（错误输入实际被拒 + 身份覆盖） |
| 5 | 未授权 Broker | `granted=[]` 时插件 `storage.set` → `PERMISSION_DENIED`（「缺少权限」）；直接发未声明方法 `os.exfiltrate` → `UNKNOWN_METHOD`（「宿主没有提供方法」）；无需权限的 `app.context` 仍成功；record.granted 保持 `[]` | 真实行为（宿主返回真实错误码） |
| 6 | 宿主存储隔离 | 插件 frame 内 `localStorage.getItem(...)` → **SecurityError**；`window.parent.localStorage.getItem` → SecurityError；`window.parent.document` → SecurityError；IndexedDB 访问失败；宿主自己的探针 secret 值事后仍在 | 真实行为（在插件 frame 内执行断言） |
| 7 | Cookie 与网络隔离 | 宿主先写非 httpOnly 探针 Cookie；插件 frame 内 `document.cookie` → **SecurityError**；`window.parent.document.cookie` → SecurityError；`fetch("http://127.0.0.1:8788/api/health")` 被拒（CSP `connect-src 'none'`）；插件文档 meta CSP 含 `connect-src 'none'`、`frame-src 'none'`；宿主 Cookie 事后完好 | 真实行为（在插件 frame 内执行断言） |
| 8 | 导航逃逸 | 插件 frame `location.replace("about:blank")` 触发 runner 第二次 load → 宿主 record 在 20s 内变为 `{blocked:true, enabled:false}`、`.gp-frame` 数量变 0、blob frame 消失；日志含「插件试图导航出沙箱，已强制禁用」「插件试图跳出沙箱」；关闭窗口后重新打开直接显示禁用态（`.gp-blocked`），不再创建沙箱 | 真实行为（但检测是**事后**，见 §4.4） |
| 9 | 权限撤销 | 走插件管理器真实 UI：官方示例 `com.guandao.hello` 安装（权限弹窗「全部允许」）→ 打开实例（`.gp-frame` 为 1）→ 详情 →「权限」→「全部拒绝」→「保存授权」→ 运行实例 iframe 被销毁、record.granted 变 `[]` | 真实 UI + 真实行为（`saveGrantedPermissions → destroySessionsFor` 路径） |
| 10 | 跨标签页撤销 | 同 context 另一个标签页改写 `localStorage["guandao.plugins.v1"]` → 本页 `storage` 事件触发，`.gp-frame` 变 0、blob frame 消失；插件记录本身仍在（只销毁运行上下文） | 真实行为（真实 storage 事件） |

补充（`chromium` project，`sandbox.spec.ts` 新增 3 项）：

- runner 源码 CSP 无网络出口、含 `sandbox:navigation` / `location.replace("about:blank")` / 「沙箱握手校验失败」——静态契约断言。
- runner 里所有 `sandbox` 属性赋值都只能是 `allow-scripts`，可执行代码中没有 `allow-same-origin` / `allow-popups` / `allow-forms` / `allow-modals` / `allow-top-navigation` / `allow-downloads`——静态契约断言。
- 直接加载静态 `runner.html` 并挂载插件文档：插件 frame 内 `window.origin === "null"`、localStorage / `document.cookie` / `window.parent.document` 均抛 **SecurityError**、SDK 预置脚本注入成功——真实行为（不依赖 Worker 的防线层验证）。

### 3.3 未验证 / 未覆盖

- 未在生产环境（真实域名 + 生产 CSP + 真实证书）验证；本机只验证了 `wrangler dev --local` + `dist/`。
- 未在 Firefox / Safari / 其他 Chromium 版本验证。
- 未做人工浏览器（真实用户操作）复核；Playwright 自动化可能快速点击，UI 交互时序未覆盖极端慢机。
- 第 1/2 项里的插件是 E2E 注入的 dev 插件（直接写 localStorage + IndexedDB），**绕过了安装时的签名/来源校验**——它验证的是「沙箱运行时」，不是「安装供应链」；安装链路由 `docs/security/PLUGIN-SIGNING.md` 与 `plugin-signature.spec.ts` 覆盖。
- 未验证 `network.fetch` 服务端复核、`files.*`、`calendar.*`、`ui.dialog/notify` 等其余 Broker 方法的实际行为（超出本阶段 10 项范围）。
- 未做性能/资源滥用测试（插件死循环、postMessage 洪泛、超大 DOM）。
- 未验证跨浏览器/跨设备的插件状态同步；跨标签页撤销只覆盖同一浏览器同一 context。

---

## 4. 安全边界清单

### 4.1 沙箱**能保证**什么（前提：两层都没有 allow-same-origin）

1. **同源隔离**：插件文档是 opaque origin，读不到宿主 DOM、Cookie、localStorage、IndexedDB、`window.parent.document`（第 6、7 项实测抛 SecurityError）。
2. **网络出口默认关闭**：插件文档 CSP `connect-src 'none'`，`fetch`/XHR/WebSocket 被阻止；`frame-src 'none'` 禁止再嵌 iframe；`form-action 'none'` 禁止表单提交；`base-uri 'none'` 禁止 `<base>` 改写。
3. **顶层导航被限制**：sandbox 没有 `allow-top-navigation` / `allow-popups` / `allow-forms` / `allow-modals` / `allow-downloads`；插件只能导航自己的 frame，而且会被 runner 的第二次 `load` 检测到并终止（第 8 项）。
4. **通信面收敛**：宿主只认 `event.source === iframe.contentWindow` 的消息与一次性 MessagePort；插件无法直接调用宿主函数，只能走 RPC 白名单。
5. **身份不可伪造**：`pluginId` 由 runner 用挂载身份覆盖（第 4 项），宿主再按 record 复核；伪造来源消息被丢弃（第 3 项）。
6. **能力默认拒绝**：未授权方法/未知方法都返回错误，不会静默执行（第 5 项）。
7. **滥用限速与超时**：60 次/10 秒、24 KB、8 秒超时；通知 5 条/分钟。
8. **可撤销**：关闭窗口、权限变更、跨标签页状态变化、导航逃逸都会销毁运行实例；导航逃逸还会持久 `blocked`（第 8、9、10 项）。

### 4.2 沙箱**不能保证**什么

1. **不能防宿主自身 XSS**：`guandao.plugins.v1`、插件包、授权都在宿主 origin 的 localStorage/IndexedDB 里；宿主页一旦被 XSS，插件隔离层无法保护这些数据（状态源同源可写）。这是本架构最大的前提性风险。
2. **不能阻止插件消耗资源**：插件仍可死循环、疯狂绘制 canvas、占用内存，或高频 `postMessage` 给 runner；当前只有 RPC 限速，没有 CPU 时间片/内存上限/消息洪泛全局限流。
3. **导航逃逸只能事后惩罚**：检测依赖内层 iframe 的第二次 `load`，此时导航已经发生；宿主能保证的是「之后的会话被销毁 + 持久禁用」，而不是「导航被浏览器阻止」。对「插件在导航前最后一刻用数据 URI/`location` 触发外发」的场景，实际上受插件文档 CSP `connect-src 'none'` 与 sandbox 能力限制，但仍不应该把「事后检测」宣传成「事前拦截」。
4. **授权是快照式的**：`granted` 在 MOUNT 时随消息下发，运行中修改授权不会热更新，而是销毁实例重启（`saveGrantedPermissions`）。不会出现「老实例带着旧授权继续跑」。
5. **服务端只复核 `network.fetch`**：其余方法（storage/ui/files/calendar/notes…）完全靠宿主前端校验；伪造宿主前端（用户自己改浏览器）不在威胁模型内，但「服务端可审计」的只有 network.fetch 与导航逃逸上报。
6. **跨标签页撤销依赖浏览器 storage 事件**：同一浏览器同一 origin 才生效；不同浏览器、不同设备之间不同步（云端状态同步是另一条链路，不在本阶段范围）。
7. **`allow-scripts` 本身是必要且危险的授权**：没有它插件不可运行；它允许插件执行任意 JS。安全边界依赖「没有 allow-same-origin」+「CSP 无网络」+「消息白名单」三者同时成立。
8. **E2E 注入的 dev 插件绕过安装期校验**：测试为可重复性直接注入包与 record；生产安装路径有 `verifyBundle` + 签名/来源校验，但两者不能混为一谈。

### 4.3 威胁模型备忘

- 信任：宿主应用 bundle、runner.html、sdk.js（同源静态资源）、服务端 API。
- 不信任：第三方插件代码（任意 JS，可能恶意）、插件自报的 pluginId、插件发来的任意消息。
- 不在范围：宿主源码被改、浏览器扩展、操作系统级攻击、物理访问。

### 4.4 「导航逃逸只能事后惩罚」的准确表述

- runner 在挂载内层 iframe 时记录 `load` 次数，第一次 `load` 视为正常启动；第二次（含插件自己 `location.replace` / `location.href=` / 表单提交 / 任意 frame 导航）即视为逃逸尝试。
- 此时顺序是：上报 → 把 iframe 导航到 `about:blank` → 终止会话。宿主再把插件 `blocked=true`，下次打开直接拒绝。
- 所以准确说法是：**「逃逸会被检测、终止并持久禁用」**，不是「逃逸在发生前被阻止」。真正的「事前」边界是 sandbox 能力位 + 插件文档 CSP（无网络、无表单、无弹窗、无顶层导航）。

### 4.5 版本参数

- `RUNNER_URL = "/sandbox/runner?v=1.7.0"`、`SDK_URL = "/sandbox/sdk.js?v=1.7.0"`（`host.ts:35` 附近）。版本参数用于缓存刷新；runner 与 SDK 的实际内容由构建产物决定，本阶段未改版本号。

### 4.6 已知缺陷（本阶段发现，已修复）

- **插件管理器「已安装」列表缺失**：`src/lib/plugins/manager.ts` 的 `listView()` 原在 `tab === "installed"` 且存在安装记录时没有对应分支，直接落到最后的「安全策略」卡片；后果是本地安装的插件在管理器里看不到列表/详情，也就没有「权限」入口，无法通过 UI 撤销本地插件授权。**已在本阶段修复**：补上 `installed` 分支（列表行、管理/更新/启用禁用按钮），并同时显示签名信任徽标。沙箱第 9 项仍走官方插件验证撤销路径，因为该路径不依赖本地安装记录。

---

## 5. 独立 Sandbox Origin 方案

> 本节写方案、对比与**本地隔离实测**；不创建任何生产资源（域名、证书、Worker 路由、DNS 记录均未变更）。

### 5.1 为什么还要独立 Origin

当前安全边界成立的前提是「两层 iframe 都保持 `sandbox="allow-scripts"` 且永不添加 `allow-same-origin`」。这是一条**靠代码纪律维持**的边界：未来任何一次改动（为了某个功能加 `allow-same-origin`、宿主 XSS、把 runner 代码合并进主 bundle）都可能让隔离失效。独立 Origin 提供第二道结构性边界：即使某一层失去 sandbox 保护，插件文档与宿主仍然跨源。

### 5.2 方案 A：同域独立 Worker 路由 + 独立 CSP

**做法**：把 `/sandbox/*` 从应用 Worker 中拆出来，由独立 Worker（或独立 route/服务）提供；沿用/收紧现有响应头（`SANDBOX_CONTENT_SECURITY_POLICY`、`X-Frame-Options` 删除、`frame-ancestors 'self'`、no-store）；宿主 CSP 的 `frame-src` 精确允许该路径；runner/sdk 只从该路由加载。

**优点**：零 DNS/证书成本；与现有同源 CORS/部署链路完全兼容；CSP 与缓存策略可以独立演进；改动面小（`host.ts` 的 URL 常量 + Worker route）。

**缺点**：仍是**同源**——origin 层面的 Cookie/localStorage 共享没有变化；真正的隔离依然完全依赖 `sandbox` 属性；如果 runner 页面被 XSS，攻击者仍在宿主 origin 内；「独立 Worker」更多是部署与响应头隔离，不是安全边界升级。

**适用**：短中期工程整理；希望把沙箱服务的发布、CSP、缓存、日志从应用主 Worker 解耦，但暂时不引入新域名。

### 5.3 方案 B：真正独立域名（推荐目标）

**做法**：为 runner/SDK 使用独立域名（例：`sandbox.guandao.xin`，仅举例，未创建）：独立 DNS 记录、TLS 证书、独立 Worker/静态源；宿主页通过绝对 URL 加载 `https://sandbox.example/runner?v=...`；宿主 CSP `frame-src` 增加该 origin；沙箱 CSP `frame-ancestors` 改为宿主 origin；跨源 `postMessage` 使用现有协议（现有代码只判断 `event.source` 与端口，不判断 `event.origin`，因此协议兼容）。

**优点**：

- 结构性隔离：即使沙箱 iframe 意外获得 `allow-same-origin`，它与宿主仍是跨源，Cookie/localStorage/DOM 依旧不可互访；
- 宿主 origin 的 XSS 不能直接读写沙箱 origin 的存储（反之亦然）；
- 沙箱域名可独立配置 CSP、WAF/限流、缓存、日志与访问审计；
- 可按 origin 使用 COOP/COEP、独立 cookie 策略（沙箱域名可完全不发 Cookie）。

**缺点/成本**：

- 新域名 + 证书 + DNS + 部署/监控；
- 需要调整宿主 CSP、沙箱 CSP、可能的 CORS 与静态资源路径；
- 需要把 runner/SDK 的发布流程拆成独立服务（版本参数 `?v=` 仍可沿用）；
- 依赖 `frame-src` 显式 allowlist，CSP 配置错误的启动失败模式要专门测试（适用现有 10 项 E2E + 新增宿主 CSP 断言）；
- 若浏览器对第三方存储分区/第三方 Cookie 有策略，需确认不影响（当前沙箱文档本身是 opaque origin，不受影响；影响的是沙箱域名自身的存储，如未来要用）。

**迁移步骤（建议顺序，本阶段不做）**：

1. 注册并备案独立沙箱域名，签发证书，配置独立 Worker route 或静态托管；
2. 部署 runner/SDK，验证响应头与现有 8788 完全一致（可复用 `sandbox-worker.spec.ts` 的 CSP 断言）；
3. 宿主 `host.ts` 常量改为绝对 URL；宿主 CSP `frame-src` 加 `https://<sandbox-domain>`；沙箱 CSP `frame-ancestors` 改为宿主 origin；
4. 回归：10 项 worker E2E + `sandbox.spec.ts` 静态断言 + 手工冒烟（加载/挂载/撤销/导航逃逸）；
5. 灰度：先用 feature flag 切一部分用户，保留回滚到同源 runner 的开关；
6. 稳定后再考虑把沙箱域名完全从主站 CSP 的 `script-src`/`connect-src` 中隔离。

### 5.4 对比与推荐

| 维度 | 现状（同源 + 双 sandbox） | 方案 A（同域独立 Worker 路由） | 方案 B（独立域名） |
| --- | --- | --- | --- |
| 跨源隔离 | 依赖 sandbox 属性（opaque origin） | 同现状 | 结构性跨源 + sandbox |
| 抗「误加 allow-same-origin」 | 无兜底 | 无兜底 | 有兜底（跨源仍生效） |
| 抗宿主 XSS 读写插件存储 | 弱（同源） | 弱（同源） | 较好（跨源） |
| 部署/证书成本 | 0 | 低 | 中（域名/证书/DNS） |
| 改动面 | — | 小 | 中（URL/CSP/发布流程） |
| CSP/缓存/WAF 独立演进 | 部分（现有响应头已独立） | 好 | 最好 |
| 本阶段建议 | 保持 | 可选工程整理 | **推荐作为目标架构** |

**推荐**：短期保持现状（两层 `allow-scripts` + 独立 CSP + 白名单 Broker），先修复 §4.6 的管理器缺陷、补资源滥用防护；中期按方案 B 把 runner/SDK 迁到独立域名，把「不能加 allow-same-origin」从代码纪律升级为结构性边界。方案 A 可以顺手做（降低沙箱服务与应用主 Worker 的耦合），但不应把它当成安全边界升级。

### 5.5 本地两源隔离实测（本阶段新增证据）

> 结论先行：**Origin 隔离语义已由真实浏览器证明**；**Cookie 的隔离粒度是 host，不是 Origin**（RFC 6265 明确忽略端口），因此方案 B 的落地必须使用**独立 host**，仅换端口不够。生产资源仍**未创建**。

`tests/e2e/sandbox-origin.spec.ts`（worker project，1 项）用两个真实 Origin 实测：

- 宿主页：`http://127.0.0.1:8788`（真实 Worker，本地 D1/R2），用 `/api/health`（JSON、无 CSP）作为可创建跨源 iframe 的宿主页；预先写入 `localStorage["host-storage-marker"]="host-secret"` 与 `host_cookie`。
- 沙箱源：`http://127.0.0.1:4399`（Playwright `serve-dist.mjs` 提供的真实静态 dist）。
- 对照组（证明探针有效）：同源 `srcdoc` iframe 未加 sandbox，能读到 `parent.localStorage` = `host-secret`。

| 探针 | 当前生产模型（8788 同源 + sandbox） | 独立源 + **故意不加 sandbox**（4399） | 独立源 + sandbox（目标形态） |
| --- | --- | --- | --- |
| `window.origin` | `null`（不透明） | `http://127.0.0.1:4399` | `null` |
| `localStorage` | `SecurityError` | 可用但为空（不同 Origin 不共享） | `SecurityError` |
| 读 `document.cookie` | `SecurityError` | 可读；**读到宿主写入的 `host_cookie`**（见下） | `SecurityError` |
| 读父窗口存储/DOM | `SecurityError` | `SecurityError`（跨源） | `SecurityError` |
| `fetch(宿主 /api/auth/me)` | 失败 | CORS 拦截失败 | 失败 |
| postMessage 的 `event.origin` | `"null"` | 真实沙箱源 | `"null"` |
| `location.origin` | 仍返回 URL 的源（不能用于判定沙箱） | 真实源 | 仍是 URL 的源 |

**关键发现**：`127.0.0.1:8788` 与 `127.0.0.1:4399` 端口不同，但 **Cookie 仍然共享**（读到 `host_cookie=host-storage-marker`），因为 Cookie 作用域只有 host。这带来两条落地要求：

1. 若采用方案 B，沙箱域名必须是**独立 host**（如 `sandbox.guandao.xin`），不是同一 host 的另一端口/路径；并且该域名不设置任何 Cookie。
2. 现有的「插件 iframe 不透明 Origin + 读不到宿主 Cookie」仍然成立（沙箱帧读 Cookie 直接 `SecurityError`），这也是本阶段生产模型能保护认证 Cookie 的原因；独立 Origin 是兜底，不是替代。

复现：`npx playwright test --project=worker tests/e2e/sandbox-origin.spec.ts`（本机 Chrome stable，1 passed，测试本体 < 1s）。证据等级：真实浏览器行为验证（localStorage / Cookie / DOM / CORS / postMessage 均由浏览器执行，不是 mock）；**生产未验证**。

**方案 B 生产资源清单（本阶段均未创建，需所有者操作）**：

| 资源 | 说明 |
| --- | --- |
| 独立域名 + DNS | 例 `sandbox.guandao.xin` 的 A/AAAA 或 CNAME 记录；域名注册/备案按主体要求 |
| TLS 证书 | 由 Cloudflare 自动签发（若 DNS 托管）或自行签发；`https` 强制 |
| Worker route / 静态源 | 独立 Worker 路由或独立静态托管，只提供 `runner.html`、`sdk.js` 与必要静态资源 |
| 宿主 CSP | `frame-src` 精确加入 `https://sandbox.<domain>`；保留现有 `script-src` 哈希 |
| 沙箱 CSP | `frame-ancestors` 改为宿主 origin（不再是 `'self'`） |
| Cookie 策略 | 沙箱域名不 Set-Cookie；宿主 Cookie 保持 `HttpOnly` + `SameSite` 不变 |
| 监控/告警 | 沙箱域名独立日志、可用性告警、CSP 违规上报（report-to） |

---

## 6. 复现与证据等级

```powershell
# 1. 类型检查
npx tsc --noEmit

# 2. 真实 Worker 上的 10 项沙箱 E2E（自动复用/拉起 8788）
npx playwright test --project=worker tests/e2e/sandbox-worker.spec.ts

# 2b. 独立 Origin 两源隔离实测（宿主 8788 + 沙箱源 4399）
npx playwright test --project=worker tests/e2e/sandbox-origin.spec.ts

# 3. 全量 chromium（静态 dist，4399；包含 sandbox.spec.ts 6 项）
npx playwright test --project=chromium
```

- 环境：Windows 10/11、Node v26.13.0、Playwright `channel: "chrome"`（本机 Chrome stable）、`nodes: 1`、`retries: 0`。
- 8788 由 `scripts/e2e-server.mjs`（`wrangler dev --local` + 本地 D1/R2 + QA 夹具）提供；测试期间未重启该服务。
- 结果：worker spec 10 passed (35.7s)；sandbox-origin 1 passed（真实两源，测试本体 < 1s）；chromium 67 passed (1.8m)；`tsc --noEmit` 无错误。均为本机证据，**生产未验证**。

**证据等级**：

- 真实行为验证：第 1–10 项中的消息投递/拒绝、插件 frame 内 `localStorage`/`document.cookie`/`fetch` 抛错、record 状态变化、UI 撤销流程、跨标签页销毁。
- 属性/契约断言：iframe `sandbox`/`referrerpolicy`/`src` 字符串、CSP 响应头/meta 文案、`sandbox.spec.ts` 的源码静态检查。
- 未验证：生产环境、非 Chrome 浏览器、真实安装供应链（签名/来源）、性能与资源滥用。

---

## 7. 改动清单与后续

- 新增：`tests/e2e/sandbox-worker.spec.ts`（10 项，worker project）。
- 新增：`tests/e2e/sandbox-origin.spec.ts`（1 项，真实两源隔离实测）。
- 扩充：`tests/e2e/sandbox.spec.ts`（保留原 3 项，新增 3 项静态/运行时断言，共 6 项）。
- 新增：`docs/security/PLUGIN-SANDBOX.md`（本文）。
- **未改动**：`src/lib/plugins/host.ts`、`public/sandbox/runner.html`、`worker/index.js`、任何 `sandbox` 属性或 `allow-*` 能力位（任务硬约束）。
- 已修复：插件管理器「已安装」列表缺失（§4.6，`manager.ts` 的 `listView()` installed 分支）。

后续建议：

1. ~~修复 `manager.ts` 的 `listView()` installed 分支~~（已完成）；
2. 为沙箱增加消息洪泛/CPU 时间/内存的资源滥用防护（当前只有 RPC 限速）；
3. 评估方案 B（独立域名）的落地，把「不加 allow-same-origin」变成结构性约束；注意必须使用独立 **host**，仅换端口无法隔离 Cookie（§5.5）；
4. 生产环境部署后用同一批 E2E 复跑，并补充 Firefox/Safari 冒烟（本机 Firefox 已安装并运行设备 E2E）；
5. 把 §3.2 的 10 项纳入 CI 的 worker project，防止回归。