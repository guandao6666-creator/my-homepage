# Guandao OS 1.7 · Plugin Ecosystem & Developer Platform

**Release: Open Desktop** · `1.7.0` · SDK `1`

本文是 1.7 的交付说明：架构、生命周期、Manifest、SDK、沙箱、权限、市场、开发者中心、CLI、数据库、R2、API、测试结果、部署步骤与已知限制。

原则只有一条：**没有实现的能力不写在文档里，没有通过的测试不写成通过。**

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Guandao OS 主页面（https://guandao.xin）                              │
│                                                                      │
│  Window Manager ── 插件应用窗口（每窗口一个 iframe）                  │
│  Widget System  ── 插件组件（每组件一个 iframe）                      │
│  Command Palette── 命令插件（20 秒短生命周期隐藏上下文）              │
│                                                                      │
│  Plugin Registry ── 安装记录 / 版本 / 权限 / 日志 / 禁用 / 回退       │
│  Plugin Broker   ── 方法 → 权限映射、频率、体积、超时、审计           │
│                                                                      │
│  Cookie / D1 / R2 永远不进入 iframe                                   │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ iframe sandbox="allow-scripts"
                            │ + MessageChannel（宿主生成，port2 转移）
┌───────────────────────────▼──────────────────────────────────────────┐
│ /sandbox/runner.html（opaque origin，读不到宿主 DOM / Cookie）        │
│  · 注入 SDK                                                          │
│  · 只转发自己创建的子 iframe 的消息                                   │
│  · 用挂载时的 pluginId 覆盖插件自报身份                               │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ postMessage（event.source 校验）
┌───────────────────────────▼──────────────────────────────────────────┐
│ 插件文档（Blob URL + sandbox="allow-scripts"，opaque origin）         │
│  HTML / CSS / JS，入口资源由宿主内联；无 Cookie、无 localStorage、     │
│  无 D1/R2 Binding、无文件系统、无 shell                                │
└──────────────────────────────────────────────────────────────────────┘
```

服务端（Cloudflare Worker + Static Assets）：

```
/api/plugins/*     市场、安装、权限、评价、举报、网络代理、管理员审核
/api/developer/*   开发者资料、草稿、上传版本、提交审核
D1                 plugins / versions / installations / permissions / ...
R2                 plugins/{pluginId}/{version}/package.json + icon
```

关键取舍：

- **不新造第二套社区**：插件市场复用 `users`、`community_profiles`、`community_roles` 与社区审核角色；插件评价与社区内容同源账号。
- **不新造 R2 Bucket**：沿用 `FILES`（`guandao-files`）。
- **不使用 Pages Functions**：本项目是 Worker + Static Assets，路由统一挂在 `worker/api/router.js`。
- **不把第三方脚本引入主页面**：只通过双层 iframe 执行。

---

## 2. 插件生命周期

```
available → downloading → validating → installed → enabled → running
                                                   │          │
                                                   │          ├→ disabled → enabled
                                                   │          ├→ update_available → update → running
                                                   │          ├→ rollback
                                                   │          └→ uninstall
                                                   └→ failed / blocked
```

| 状态 | 产生条件 | 持久化位置 |
| --- | --- | --- |
| available | 市场存在 `published` 插件且版本 `approved` | D1 |
| downloading | 用户确认权限后请求 `/package` | 内存（界面） |
| validating | 复核 Manifest、文件摘要、包 SHA-256 | 内存 + 日志 |
| installed | 包写入 IndexedDB，服务端写入 `plugin_installations` | 本地 + D1 |
| enabled | `plugin_installations.enabled = 1` 且本地记录 enabled | 本地 + D1 |
| running | 至少一个沙箱上下文（窗口 / 组件 / 命令）存活 | 内存计数 |
| disabled | 用户禁用；运行上下文立即销毁 | 本地 + D1 |
| update_available | 服务端存在更高 `approved` 版本 | D1 计算 |
| failed | 包丢失、校验失败、启动 12 秒超时、沙箱报错 | 本地日志 |
| blocked | 管理员紧急下架；安装记录标记 blocked 且 enabled=0 | D1 + 本地同步 |

**状态不是 UI 变量**：`enabled`、`version`、`granted` 都来自安装记录；`running` 来自真实的 `PluginSandbox` 实例计数；`update_available` 来自服务端返回。刷新页面后状态一致。

关键代码：`src/lib/plugins/registry.ts`、`src/lib/plugins/store.ts`、`worker/api/plugins/handlers.js`。

---

## 3. Manifest Schema

唯一事实来源：`shared/plugin-spec.js`（Worker、浏览器、CLI 共用）。

```json
{
  "manifestVersion": 1,
  "id": "com.example.markdown",
  "name": "Markdown 速记",
  "version": "1.0.0",
  "description": "在独立窗口里写 Markdown，保存到插件自己的命名空间。",
  "author": { "name": "Example Studio", "url": "https://example.com" },
  "type": "application",
  "entry": "index.html",
  "icon": "icon.svg",
  "category": "productivity",
  "license": "MIT",
  "compatibility": { "minimumOSVersion": "1.7.0", "sdkVersion": 1 },
  "permissions": ["window.open", "plugin.storage.read", "plugin.storage.write"],
  "networkDomains": [],
  "dependencies": [],
  "screenshots": [],
  "contributes": {}
}
```

校验规则（节选，全部在 `validateManifest` / `validateBundle` 中实现）：

| 规则 | 行为 |
| --- | --- |
| `id` 2–5 段小写反向域名，≤80 字符 | 不合法直接拒绝；发布后不可改 |
| `version` SemVer | 同版本不可重复上传，必须严格递增 |
| `entry` 必须是包内存在的 `.html`（主题插件可空） | `ENTRY_MISSING` |
| 文件路径 | 禁止 `..`、反斜杠、绝对路径、盘符、空段；扩展名白名单 |
| 可执行后端文件 | `.php/.wasm/.exe/.node/.sh/.bat/.ps1` 等直接拒绝 |
| 权限 | 必须是 17 项目录中的 ID；未知权限拒绝 |
| `network.fetch` | 必须同时声明 `networkDomains`，最多 8 个主机名 |
| 包体积 | ≤ 2 MB；≤ 48 个文件；单文件 ≤ 512 KB |
| `filesDigest` | 上传时必填，并与文件清单重算结果一致 |
| 依赖 | 最多 8 个；安装时缺依赖返回 `DEPENDENCY_MISSING` |

插件包（`.gplug`）是单个 JSON 文本：

```json
{
  "format": "guandao-plugin",
  "formatVersion": 1,
  "manifest": { "...": "..." },
  "files": [{ "path": "index.html", "encoding": "utf8", "content": "..." }],
  "filesDigest": "64 位 SHA-256"
}
```

两层摘要：

1. `filesDigest` = SHA-256(canonicalJson(按 path 排序的 {path, encoding, content}))
2. 包摘要 = SHA-256(原始文本)，服务端存 R2 metadata 与 `plugin_versions.package_sha256`

客户端下载后再算一次，两者任一不一致就中止安装。

---

## 4. SDK API

预置脚本：`public/sandbox/sdk.js`。全局 `guandao`，全部返回 Promise，失败 reject 带 `code` 的 Error。

| 模块 | 方法 | 权限 |
| --- | --- | --- |
| `guandao.ui` | `toast(text)` | 无（限频） |
| | `notify({ title, body, level })` | `notification.show` |
| | `dialog({ title, message, actions })` | `dialog.open` |
| | `openApp(appId)` | `desktop.open_app` |
| | `setTitle` / `resize` / `close` | 无（只作用于自己的窗口） |
| | `theme()` | `theme.read` |
| `guandao.storage` | `get` / `keys` | `plugin.storage.read` |
| | `set` / `delete` / `clear` | `plugin.storage.write` |
| `guandao.files` | `pick({ accept, multiple })` | `files.pick` |
| | `read(token)` | `files.read_selected` |
| `guandao.network` | `fetch(url, options)` | `network.fetch` + 域名白名单 |
| `guandao.commands` | `register(list)` | `desktop.register_command` |
| | `onInvoke(fn)` | 无（只收自己的命令） |
| `guandao.notes` | `create(note)` | `notes.create` |
| | `readSelected()` | `notes.read_selected` |
| `guandao.calendar` | `createEvent(event)` | `calendar.create_event` |
| | `readSelected()` | `calendar.read_selected` |
| `guandao.widget` | `setEnabled(bool)` | `desktop.add_widget` |
| `guandao.lifecycle` | `on("ready" / "command" / "theme-change")`、`ready()`、`reportError()` | 无 |
| `guandao.device` | `info()` | 无（只读环境） |

约束：

- 单次 payload ≤ 24 KB；宿主 8 秒超时（SDK 12 秒兜底）；
- 每个上下文 60 次 / 10 秒；通知 5 条 / 分钟；
- 存储键 `^[A-Za-z0-9._-]{1,64}$`，单插件 256 KB / 128 键；
- 文件只读文本 ≤ 256 KB，token 10 分钟失效；
- 不暴露 Session、D1 Binding、R2 Binding、Secret、Cookie。

TypeScript 类型：`shared/plugin-spec.d.ts` 是 Manifest / 权限 / 包结构的权威声明；SDK 运行时类型由 JSDoc 与文档描述，未生成 `.d.ts`（已知限制）。

---

## 5. 沙箱隔离方案

**已实现（默认部署形态）**

- 运行器：`/sandbox/runner.html`，由 Worker 下发独立 CSP。
- 宿主 iframe：`sandbox="allow-scripts"`，无 `allow-same-origin` / `allow-top-navigation` / `allow-popups` / `allow-downloads`。
- 插件 iframe：运行器内再建一层，同样只允许 `allow-scripts`，通过 Blob URL 加载自包含文档。
- 实际 origin 为 opaque（`"null"`）：读不到父页面 DOM、宿主 Cookie、`localStorage`；`document.cookie` 为空。
- 网络出口：`connect-src 'none'`；外部图片被 `img-src data: blob:` 限制；跳转由 `frame-src 'self'` 阻断。
- 插件不能直接访问 D1 / R2：没有任何 Binding 暴露给浏览器，接口全部要求同源 Session 与权限。

**CSP**

沙箱文档：

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; media-src data: blob:; font-src data:;
connect-src 'none'; frame-src 'self' data: blob:;
base-uri 'none'; form-action 'none'; frame-ancestors 'self'
```

主页面仍是哈希白名单 CSP，不含 `unsafe-eval`；`frame-src 'self' blob: data:` 允许宿主嵌入运行器。

**可选加固：独立子域**

当前版本**没有**默认部署 `sandbox.guandao.xin`。如果要把「同源路径 + sandbox 属性」升级为「独立源站」，步骤：

1. 新建 Cloudflare Worker（Static Assets）项目 `guandao-plugin-sandbox`，把 `public/sandbox/` 作为 assets 目录部署；
2. 绑定自定义域 `sandbox.guandao.xin`，DNS 走 Cloudflare 代理，开启 HTTPS；
3. 在 Worker 里对 `runner.html` / `sdk.js` 下发与上面相同的 CSP（去掉 `frame-ancestors` 限制为 `https://guandao.xin`）；
4. 该域名**不要设置任何 Cookie**，也不要绑定 D1 / R2；
5. 修改 `src/lib/plugins/host.ts` 的 `RUNNER_URL` / `SDK_URL`，以及主页面 CSP 的 `frame-src`；
6. 重新跑 `npm run qa:plugins:ui` 与 CSP 检查。

未完成上述步骤前，系统不会声称已经使用独立源站。

---

## 6. MessageChannel 通信机制

握手顺序：

1. 宿主创建 iframe，监听 `message`；运行器加载后发 `HELLO`（带随机 nonce）；
2. 宿主校验 `event.source === iframe.contentWindow`（**不校验 `event.origin`**，opaque iframe 的 origin 就是 `"null"`）；
3. 宿主创建 `MessageChannel`，向 iframe `postMessage(MOUNT, "*", [port2])`；
4. 运行器保存 `port1`，创建插件 iframe，注入 SDK 与配置；
5. 插件 iframe `load` 后，运行器通过端口发 `READY`；宿主解析 ready Promise；
6. 插件 SDK 发 `RPC` → 运行器校验 `event.source === 插件 iframe.contentWindow`、requestId/method 格式、payload 大小，并覆盖 `pluginId`；
7. 宿主 Broker 校验方法白名单、权限、频率、体积、超时，执行后回 `RESULT`；
8. 运行器把 `RESULT` 转发给插件；`DESTROY` 时关闭端口、revoke Blob URL、移除 iframe。

消息结构：

```json
{
  "channel": "guandao.plugin",
  "kind": "RPC",
  "requestId": "r1abc",
  "method": "storage.set",
  "payload": { "key": "draft", "value": "..." }
}
```

宿主绝不采信插件自报的 `pluginId`；会话与「iframe 实例 + MessagePort」绑定。运行器也不接受第三方窗口的消息。

---

## 7. 权限系统

17 项权限，按模块分组：UI / 存储 / 外观 / 文件 / 网络 / 桌面 / 日历 / 笔记。

- 默认拒绝：Manifest 没声明 → 拒绝；声明了但用户没勾选 → 拒绝；撤销后 → 立即拒绝。
- 安装前逐项展示：作用、是否涉及私人数据、是否访问网络、风险等级。
- 支持全部允许 / 全部拒绝 / 逐项勾选；允许「一项都不授予」继续安装。
- 权限升级：更新时新增权限必须重新确认；服务端也会二次校验（`PERMISSION_CONSENT_REQUIRED`）。
- 回退：权限取交集，新版本独有权限被撤销。
- 卸载：全部授权删除；插件数据可选择保留或清除。
- 服务端存储：`plugin_permissions (user_id, plugin_id, permission, granted_via, granted_at)`，主键去重。

运行时校验表在 `src/lib/plugins/host.ts` 的 `METHOD_PERMISSION`；服务端在 `worker/api/plugins/handlers.js` 的 `install/update/rollback/permissions/net` 中再次校验。两层都做，不依赖单点。

---

## 8. 插件市场

入口：桌面「插件市场」，或 Community 侧栏「插件市场」。

- 首页：最新 / 趋势 / 下载最多 / 评分最高；分类：效率、系统工具、娱乐、教育、创意、开发工具；官方示例单独栏目。
- 卡片：图标、名称、作者、简介、版本、下载量、评分、审核状态；数据全部来自 D1。
- 详情：截图（作者上传，可为空）、介绍、开发者、版本历史、更新日志、权限、兼容性、许可证、依赖、评价、审核记录。
- 安装：登录 → 权限确认 → 下载 → 三重校验 → 写本地 → 写服务端 → 注册到桌面。
- 趋势排序：近 30 天去重下载事件（`plugin_download_events`），没有事件就是 0，不生成随机热度。
- 未登录可浏览；安装 / 评价 / 举报需要 Guandao Account。

真实数据边界：下载量按「用户 + 版本 + 天」去重；安装量由 `COUNT(plugin_installations)` 重算；评分由 `plugin_reviews` 聚合；不存在种子假数据。

---

## 9. 开发者中心

入口：桌面「开发者中心」。

- 概览：已发布数、下载、安装、评价、发布流程与限制。
- 我的插件：状态、最新版本、审核意见、安装/下载/评分；新建、编辑、上传版本、提交、撤回、删除草稿。
- 上传：先本地校验 Manifest 与文件，再上传；服务端返回 422 时逐条显示 `issues`。
- 资料：展示名称、简介、https 主页；与 `users` 私密字段分离。
- 审核中心（admin / moderator）：待审版本、举报、已发布插件的推荐/下架；通过/拒绝必须留痕；不能审核自己的插件；下架需要管理员。
- 审计日志：审核、下架、恢复、推荐、权限变更、开发者限制，全部写 `plugin_audit_logs`。
- 开发者限制：复用 `community_profiles.restriction`，不另建黑名单。

---

## 10. CLI

位置：`cli/guandao.mjs`（零依赖，Node ≥ 18）。

```bash
node cli/guandao.mjs create my-plugin --id com.example.tool --name "My Tool" --type application
node cli/guandao.mjs validate my-plugin
node cli/guandao.mjs build my-plugin      # 校验 + 生成 .gplug
node cli/guandao.mjs dev my-plugin        # 本地 Mock Host（5173）
node cli/guandao.mjs package my-plugin    # 生成 dist/<id>-<version>.gplug
node cli/guandao.mjs preview my-plugin    # 从 .gplug 加载并校验摘要
node cli/guandao.mjs publish my-plugin --cookie "gauth_sid=..." --changelog "首个版本"
```

- `dev` 用真实 SDK + Mock Host，支持 storage / notify / dialog / theme；其它方法明确返回 `PREVIEW_UNSUPPORTED`，不假装成功。
- `publish` 只向 `/api/developer/*` 发请求，不获取 GitHub / Cloudflare 权限；Cookie 由用户显式提供。
- `package` 与浏览器共用 `canonicalFilesJson`，摘要算法一致。

已实测：`create` → `validate` → `package` → `dev`（页面渲染正常）。

---

## 11. D1 数据表（migration `0010_plugins.sql`）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `plugins` | 插件主体 | id 主键；status 枚举；download/install/rating 计数缓存 |
| `plugin_versions` | 版本 | `UNIQUE(plugin_id, version)`；package_key / package_sha256 |
| `plugin_installations` | 安装记录 | `UNIQUE(user_id, plugin_id)`；enabled/status/source |
| `plugin_permissions` | 授权 | 主键 `(user_id, plugin_id, permission)` |
| `plugin_reviews` | 评价 | 主键 `(plugin_id, user_id)`；rating 1–5 |
| `plugin_reports` | 举报 | status open/resolved/dismissed |
| `plugin_audit_logs` | 审计 | action / actor / plugin / detail_json |
| `developer_profiles` | 开发者资料 | 与 users 私密字段分离 |
| `plugin_download_events` | 下载事件 | `UNIQUE(plugin_id, user_id, version, day)` |

迁移是增量：`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，不改 0001–0009。

---

## 12. R2 存储结构

沿用 `FILES` 绑定（`guandao-files`），不新建 Bucket。

```
plugins/{pluginId}/{version}/package.json     插件包（JSON 文本）
plugins/{pluginId}/icon.{svg|png|webp|jpg}    最新图标（覆盖写）
```

- Bucket 保持私有；没有公开域名。
- 下载只走 `GET /api/plugins/:id/package`：校验发布状态、版本状态、SHA-256 后返回文本。
- 图标走 `GET /api/plugins/:id/icon`，响应带 `Content-Security-Policy: default-src 'none'; sandbox`。
- 包对象带 `customMetadata`：pluginId / version / sha256 / filesDigest。
- 删除插件不物理删除 R2 历史对象（保留审计与回退可能）；对象清理是后续维护任务。

---

## 13. API 路由清单

所有接口同源、`no-store`、统一信封 `{ success, data | error }`。

### 市场 / 安装

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 列表（tab / category / q / sort / page） |
| GET | `/api/plugins/meta` | 版本、权限目录、限制、viewer |
| GET | `/api/plugins/installed` | 我的安装（需登录） |
| GET | `/api/plugins/:id` | 详情（未发布仅作者/审核员可见） |
| GET | `/api/plugins/:id/versions` | 版本历史 |
| GET | `/api/plugins/:id/package` | 下载（需登录，校验 SHA-256） |
| GET | `/api/plugins/:id/icon` | 图标 |
| GET | `/api/plugins/:id/file?path=` | 包内静态文件（截图等） |
| GET | `/api/plugins/:id/reviews` | 评价 + 分布 |
| POST | `/api/plugins/:id/reviews` | 评价（需已安装） |
| DELETE | `/api/plugins/:id/reviews/mine` | 删除自己的评价 |
| POST | `/api/plugins/:id/report` | 举报 |
| POST | `/api/plugins/install` | 安装 |
| POST | `/api/plugins/:id/enable` / `disable` | 启用 / 禁用 |
| POST | `/api/plugins/:id/update` | 更新（新增权限需确认） |
| POST | `/api/plugins/:id/rollback` | 回退 |
| POST | `/api/plugins/:id/launch` | 记录启动时间 |
| DELETE | `/api/plugins/:id/install` | 卸载 |
| GET/POST | `/api/plugins/:id/permissions` | 查看 / 授权 |
| DELETE | `/api/plugins/:id/permissions/:permission` | 撤销 |
| POST | `/api/plugins/net` | 外部请求代理 |

### 开发者 / 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PATCH | `/api/developer/profile` | 资料 |
| GET/POST | `/api/developer/plugins` | 我的插件 / 创建草稿 |
| PATCH/DELETE | `/api/developer/plugins/:id` | 编辑 / 删除草稿 |
| POST | `/api/developer/plugins/:id/versions` | 上传版本 |
| POST | `/api/developer/plugins/:id/submit` | 提交审核 |
| POST | `/api/developer/plugins/:id/withdraw` | 撤回待审版本 |
| GET | `/api/developer/creators/:id` | 公开开发者页 |
| GET | `/api/plugins/admin/queue/:status` | 审核队列（staff） |
| POST | `/api/plugins/admin/:id/review` | 通过 / 拒绝（staff） |
| POST | `/api/plugins/admin/:id/takedown` | 紧急下架（admin） |
| POST | `/api/plugins/admin/:id/restore` | 恢复（admin） |
| POST | `/api/plugins/admin/:id/feature` | 推荐 / 取消（admin） |
| GET | `/api/plugins/admin/reports` | 举报队列 |
| POST | `/api/plugins/admin/reports/:id` | 处理举报 |
| GET | `/api/plugins/admin/audit` | 审计日志 |
| POST | `/api/plugins/admin/users/:id/restriction` | 限制开发者 |

所有写接口：同源校验 + Session + 服务端身份；客户端传来的 `user_id` / `developer_id` 一律忽略。

---

## 14. 安全测试结果

### 14.1 API 端到端（`npm run qa:plugins`）

真实 Worker + 本地 D1 + 本地 R2（Miniflare），**65 / 65 通过**：

- Manifest：未知权限、路径穿越、`.php`、缺 filesDigest、入口缺失全部拒绝（422）；
- 审核：自审 403、普通成员 403、管理员通过后发布、重复 ID 409、重复版本 409；
- 安装：未登录 401、包哈希不一致 409、未声明权限 400、缺依赖 409；
- 权限：撤销立即生效、未授权网络调用 403、禁用后不能上报启动；
- 更新：新增权限返回 `needsConsent`、拒绝新增权限 409、同意后 1.1.0；
- 回退：版本回退成功、权限取交集；
- 安全：下架后禁止安装、已安装用户 blocked 且 enabled=0、详情 404、用户数据保留；
- 网络代理：非声明域名 403、非 https 400；
- CSRF：`Origin: https://evil.example` → 403；
- 审计：install / takedown 等动作入库；
- CSP / 响应头：主页面 XFO=DENY，沙箱页无 XFO 且 `connect-src 'none'`。

> 测试过程中发现并修复了一个真实缺陷：`assertSameOrigin` 被写成 `async` 但调用处未 `await`，导致同源校验被静默跳过。修复后 403 生效，并加入回归用例。

### 14.2 浏览器 UI（`npm run qa:plugins:ui`）

静态构建 + headless Chrome（`QA_CSP=1` 走真实 Worker CSP），**17 / 17 通过**：

- 权限弹窗逐项展示；
- 安装 → 打开 → 沙箱 iframe 渲染；
- `location.origin === "null"`；
- `window.parent.document` 访问被拒绝；
- `localStorage` 访问被拒绝；
- 存储计数、通知、对话框、主题读取正常；
- 关闭窗口后 iframe 被销毁；
- 组件插件挂载沙箱 iframe；
- `fetch("https://example.com")` 被 CSP `connect-src 'none'` 阻断；
- 无脚本错误、无非 API 资源 404。

### 14.3 安全边界逐项

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 插件不能访问主页面 DOM | ✅ | UI 测试 `parentAccess=blocked` |
| 插件不能读取 Session | ✅ | HttpOnly Cookie + opaque origin；沙箱 `document.cookie` 为空 |
| 插件不能直接访问 D1 / R2 | ✅ | 浏览器无 Binding；接口需 Session + 权限 |
| 插件不能执行 Shell | ✅ | 无任何进程/命令 API；包内 `.sh/.bat/.exe` 被拒 |
| 恶意 Manifest 被拒 | ✅ | 未知权限 / 路径穿越 / 缺入口 / 超大包 |
| 无效插件包不能安装 | ✅ | filesDigest + packageHash 双重校验 |
| 第三方脚本不在主页面执行 | ✅ | 双层 iframe，主页面无动态 import |
| 权限不会静默扩大 | ✅ | 更新时 API 返回 needsConsent，服务端 409 |
| 审核状态不可由普通用户修改 | ✅ | requireStaff / requireAdmin |
| 紧急下架不删除用户数据 | ✅ | 只改 status/enabled，本地存储保留 |

---

## 15. 修改文件清单

新增：

```
shared/plugin-spec.js               Manifest / 权限 / 包校验（唯一事实来源）
shared/plugin-spec.d.ts             类型声明
migrations/0010_plugins.sql         9 张表 + 索引
worker/api/plugins/spec.js          服务端异步校验（摘要）
worker/api/plugins/common.js        同源 / Session / 审计 / 开发者资料
worker/api/plugins/store.js         数据访问与映射
worker/api/plugins/handlers.js      市场 / 安装 / 权限 / 审核 / 网络代理
worker/api/plugins/developer.js     开发者中心接口
public/sandbox/runner.html          沙箱运行器（独立 CSP）
public/sandbox/sdk.js               SDK 预置脚本
src/lib/plugins/api.ts              客户端 API
src/lib/plugins/bundle.ts           包校验与入口装配
src/lib/plugins/store.ts            本地安装记录 / IndexedDB / 命名空间存储
src/lib/plugins/adapters.ts         Notes / Calendar 适配
src/lib/plugins/host.ts             沙箱宿主 + 权限 Broker
src/lib/plugins/commands.ts         命令面板
src/lib/plugins/builtin.ts          4 个官方示例插件包
src/lib/plugins/registry.ts         生命周期与注册中心
src/lib/plugins/ui-kit.ts           权限弹窗 / 进度 / 状态组件
src/lib/plugins/manager.ts          插件管理器
src/lib/plugins/market.ts           插件市场
src/lib/plugins/developer.ts        开发者中心
src/styles/plugins.css              三套界面 + 弹窗 + 命令面板 + 沙箱承载
src/pages/developers.astro          /developers 文档站
cli/guandao.mjs                     CLI
cli/package.json                    CLI 元数据
scripts/plugins-qa.mjs              API 安全测试
scripts/plugins-ui-qa.mjs           浏览器沙箱测试
docs/PLUGINS-1.7.md                 本文件
```

修改：

```
worker/api/router.js                挂载 /api/plugins、/api/developer
worker/api/ratelimit.js             6 条插件限流规则
worker/index.js                     沙箱专用 CSP / 移除 XFO
src/lib/os14/index.ts               注册 3 个系统应用 + 启动插件运行时
src/lib/os14/community.ts           侧栏「插件市场」入口
src/pages/index.astro               引入 plugins.css、版本号 1.7
src/components/Footer.astro         文档入口
package.json                        版本 1.7.0 + qa:plugins / plugins:cli
migrations/README.md                迁移列表补充 0010
README.md                           1.7 章节
```

---

## 16. 构建结果

```
astro build
26 page(s) built
Complete!
gen-csp: 10 个内联脚本哈希（27 个 HTML）
```

- `/developers/` 静态生成成功；
- `/sandbox/runner.html` 与 `/sandbox/sdk.js` 随 `public/` 复制；
- Worker 语法检查通过（wrangler dev 实测）；
- 没有新增构建依赖，CLI 零依赖。

---

## 17. Cloudflare 部署说明

### 17.1 首次部署 1.7

```bash
npm ci
npm run build

# 1) 只新增 0010，不改已有表
npm run db:migrations:list
npm run db:migrate:remote

# 2) 部署 Worker + 静态资源
npm run cf:deploy
```

R2：继续使用 `guandao-files`，无需新建 Bucket；确认 `wrangler.jsonc` 的 `FILES` 绑定未变。

### 17.2 部署后自检

```bash
curl -s https://guandao.xin/api/health
curl -s https://guandao.xin/api/plugins/meta
curl -sI https://guandao.xin/sandbox/runner.html   # 不应有 x-frame-options: DENY
curl -sI https://guandao.xin/                      # 应有 x-frame-options: DENY
```

浏览器：

1. 打开桌面 → 插件管理器 → 官方示例 → 安装 Hello World；
2. 打开应用，确认 UI 与「沙箱 iframe」；
3. 撤销「发送系统通知」权限，再点通知，应看到 `PERMISSION_DENIED`；
4. 开发者中心 → 新建 → 上传 → 提交；管理员在审核中心通过；
5. 市场应出现该插件，安装、评价、卸载走通。

### 17.3 可选：沙箱独立子域

见第 5 节。未配置时系统使用同源运行器 + `sandbox="allow-scripts"`，不会声称已启用独立源站。

### 17.4 回滚

```bash
npx wrangler d1 time-travel info guandao-db --remote
npx wrangler d1 time-travel restore guandao-db --remote --timestamp=<unix 秒>
```

Time Travel 是整库回滚；执行前先 `wrangler d1 export` 备份。1.7 的新表可以保留，旧代码不会读取它们。

---

## 18. 已知限制

1. **文件处理插件未与文件管理器自动关联**：当前通过插件管理器打开，再由 `files.pick` 选择文件；没有注册系统级文件关联。
2. **主题插件只引用现有壁纸 ID**，不能携带壁纸文件；壁纸包仍走 1.6 Community 的声明式资源。
3. **网络代理只允许 https / 443 / 无凭据 URL**，不跟随重定向，不转发 Cookie；返回文本上限 256 KB。
4. **跨设备恢复**只在已登录时按服务端安装记录补装，且不会因为另一台设备卸载而删除本地安装。
5. **不提供 CPU / 内存精确统计**：浏览器不暴露 iframe 资源数据；管理器只展示上下文数量、存储、请求与日志。
6. **审核结果不推送社区通知**：下架后用户下次打开管理器会看到「已下架」，但不会收到即时通知；社区通知表与插件通知的整合留待后续。
7. **评价没有人工审核队列**：只有安装过的账号能评价，默认 visible；管理员目前没有隐藏单条评价的 UI（表结构已预留 status）。
8. **插件间依赖只校验不自动安装**：缺依赖时安装被拒绝，需要用户先安装依赖插件。
9. **SDK 没有生成 TypeScript `.d.ts` 包**：Manifest 与权限有完整类型，运行时 API 以文档与 JSDoc 描述。
10. **`assertSameOrigin` 只校验 Origin / Sec-Fetch-Site**：没有额外 CSRF Token；对同源 Cookie 模型足够，但未来若开放跨域 API 需要补 Token。
11. **R2 历史对象不随卸载删除**：保留用于回退与审计；对象清理需要独立的维护任务。
12. **官方示例插件不在市场数据库里**：它们是内置包，标注「官方内置」，与第三方数据分开，避免污染市场统计。
13. **独立子域沙箱未默认部署**：见第 5 节的可选步骤。
14. **命令插件运行 20 秒后回收**：适合通知、写存储、打开应用等短任务；长任务应改为应用插件。

---

## 附：本地 QA 准备

```bash
npm run db:migrate:local
npm run build
npx wrangler dev --port 8787 --local

# 另开终端
npx wrangler d1 execute guandao-db --local --command "DELETE FROM rate_limits"
node scripts/plugins-qa.mjs

# 静态产物 + 浏览器沙箱测试
node scripts/serve-dist.mjs 4321
QA_BASE=http://127.0.0.1:8787 QA_CSP=1 QA_BASE=http://127.0.0.1:8787 QA_CSP=1 node scripts/plugins-ui-qa.mjs
```

本地会话（仅测试环境，写入 `users` / `sessions`，不要用于线上）：

| 角色 | Cookie |
| --- | --- |
| admin | `gauth_sid=qa-plugin-admin-token-1234567890` |
| developer | `gauth_sid=qa-plugin-dev-token-1234567890` |
| other | `gauth_sid=qa-plugin-other-token-1234567890` |

`plugin-upload` 限流为 20 次/小时；重复跑 QA 前清空本地 `rate_limits`，否则会收到 429。

---

**Guandao OS 1.7 — Extend Your System. Create Your Possibilities.**
