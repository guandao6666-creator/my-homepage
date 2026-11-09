# Guandao SDK 1.x 参考手册

> 适用：Guandao OS 2.0（`sdkVersion = 1`）
> 面向：插件、组件、命令、主题、集成与文件处理器的作者
> 机器可读声明：`public/sandbox/sdk.d.ts`

---

## 1. 版本与兼容承诺

| 项 | 值 | 说明 |
| --- | --- | --- |
| SDK 主版本 | `1` | `guandao.sdkVersion` |
| 宿主 | Guandao OS 2.x | `guandao.context().osVersion` |
| 兼容策略 | 1.x 在 2.x 内保持兼容 | 不删除已有方法；新增能力的旧插件不受影响 |
| 废弃流程 | 先标记 → 至少一个次版本后移除 | 移除时在 `docs/PLUGINS-1.7.md` 与本文件同步说明 |

插件 Manifest 里的 `sdkVersion` 必须 ≤ 宿主支持的主版本，否则安装时直接拒绝。

---

## 2. 运行时与安全模型

```
宿主页面（Guandao OS）
  └─ <iframe class="plugin-frame">  sandbox="allow-scripts"（外层，无 same-origin）
        └─ runner.html（隐藏中继，postMessage 转发）
              └─ <iframe>  插件页面（sandbox="allow-scripts"，opaque origin）
```

- 插件代码运行在 **opaque origin**，无法读取宿主的 Cookie、localStorage、DOM，也无法直接访问 D1/R2。
- 所有系统能力只能通过 `guandao.*` → `postMessage` → 宿主 Broker → 权限判定后执行。
- 单次 RPC 参数上限 **24 KB**，调用超时 **12 秒**；超时返回 `TIMEOUT`。
- 宿主对每个 RPC 方法都查 `METHOD_PERMISSION` 表，默认拒绝；未声明权限返回 `PERMISSION_DENIED`。
- 插件把 frame 导航出去会被判定为逃逸：立即销毁会话、本地禁用，并上报服务端审核队列。

---

## 3. 快速开始

`guandao.plugin.json`：

```jsonc
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "type": "application",
  "sdkVersion": 1,
  "minimumOSVersion": "2.0.0",
  "entry": "index.html",
  "permissions": ["plugin.storage.read", "plugin.storage.write", "notification.show"]
}
```

`src/index.html`：

```html
<!doctype html>
<meta charset="utf-8" />
<title>Hello</title>
<script src="/sandbox/sdk.js"></script>
<script>
  guandao.lifecycle.ready().then(async () => {
    const saved = await guandao.storage.get("count");
    const next = Number(saved || 0) + 1;
    await guandao.storage.set("count", next);
    await guandao.ui.toast(`第 ${next} 次打开`);
  });
</script>
```

验证命令：

```bash
node cli/guandao.mjs test .      # 静态自检（Manifest / 入口 / SDK 表面 / 摘要）
node cli/guandao.mjs dev .       # Mock Host 预览（全权限，非生产语义）
node cli/guandao.mjs build .     # 生成 dist/<id>-<version>.gplug
```

---

## 4. 核心对象

### `guandao.sdkVersion: 1`

SDK 主版本号。

### `guandao.pluginId: string`

当前插件 id（来自 Manifest）。沙箱内无法伪造。

### `guandao.granted: string[]`

当前已授予的权限 id 列表。**只读快照**，不等于声明列表。

### `guandao.has(permission: string): boolean`

本地判断权限是否已授予。适合在渲染前决定是否显示入口；

> 权限的最终判定在宿主与 Worker，`has()` 返回 true 也可能因为跨标签页撤销而失败，调用仍需处理错误。

### `guandao.context(): Promise<AppContext>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pluginId` | string | 插件 id |
| `version` | string | 已安装版本 |
| `type` | string | `application` / `widget` / `command` / `theme` / `integration` / `file-handler` |
| `mode` | string | `app` / `widget` / `command` |
| `osVersion` | string | 宿主版本，如 `2.0.0` |
| `sdkVersion` | number | 固定 `1` |
| `granted` | string[] | 已授予权限 |
| `sandbox` | true | 恒为 true，便于插件识别运行环境 |

权限：无。错误：无（宿主未就绪时返回 `SERVICE_UNAVAILABLE`）。

---

## 5. 模块参考

### 5.1 `guandao.ui`

| 方法 | 参数 | 返回 | 权限 | 错误 |
| --- | --- | --- | --- | --- |
| `toast(text)` | `text: string`（≤200 字） | `{ ok: true }` | 无 | `INVALID_PAYLOAD`（空文本） |
| `notify(options)` | `{ title?, body?, level?: "info"\|"success"\|"warning"\|"error" }` | `{ ok: true }` | `notification.show` | `NOTIFICATION_RATE_LIMITED`（5 条/分钟） |
| `dialog(options)` | `{ title?, message?, actions?: {label,value,primary?}[] }`（≤3 个） | `string \| null`：选中动作的 `value`，取消为 `null` | `dialog.open` | — |
| `openApp(appId)` | `appId: string` | `{ ok: true }` | `desktop.open_app` | `APP_NOT_FOUND` |
| `setTitle(title)` | `title: string`（≤60 字） | `{ ok: true }` | 无 | `UNSUPPORTED`（组件模式无窗口标题） |
| `resize({width,height})` | 数值，宽 360–1440，高 260–900 | `{ width, height }`（实际生效值） | 无 | `UNSUPPORTED`（组件模式） |
| `close()` | — | `{ ok: true }` | 无 | — |

示例：

```js
const choice = await guandao.ui.dialog({
  title: "删除草稿",
  message: "删除后无法恢复，确定继续吗？",
  actions: [
    { label: "删除", value: "delete", primary: true },
    { label: "取消", value: "cancel" },
  ],
});
if (choice === "delete") await guandao.storage.delete("draft");
```

### 5.2 `guandao.storage`

插件私有命名空间，宿主按插件 id 隔离。

| 方法 | 参数 | 返回 | 权限 |
| --- | --- | --- | --- |
| `get(key)` | `key: string` | `unknown \| null` | `plugin.storage.read` |
| `set(key, value)` | `key`、JSON 可序列化值 | `{ ok: true }` | `plugin.storage.write` |
| `delete(key)` | `key` | `{ ok: true }` | `plugin.storage.write` |
| `keys()` | — | `string[]` | `plugin.storage.read` |
| `clear()` | — | `{ ok: true }` | `plugin.storage.write` |

限制：键名 `[A-Za-z0-9._-]{1,64}`；单插件 256 KB / 128 键；**所有插件共享 2 MB 总预算**。
错误：`INVALID_KEY`、`STORAGE_QUOTA`、`STORAGE_QUOTA_GLOBAL`、`STORAGE_WRITE_FAILED`（隐私模式 / 浏览器拒绝）。

### 5.3 `guandao.notifications`

| 方法 | 参数 | 权限 |
| --- | --- | --- |
| `show({title, body, level})` | 同 `ui.notify` | `notification.show` |
| `success(text)` / `warning(text)` / `error(text)` | `text: string` | `notification.show` |

`guandao.notify` 是 `notifications.show` 的旧别名，保留兼容。

### 5.4 `guandao.files`

| 方法 | 参数 | 返回 | 权限 | 错误 |
| --- | --- | --- | --- | --- |
| `pick({accept?})` | `accept` 为 input accept 字符串 | `{ file: { token, name, size, type } \| null }` | `files.pick` | — |
| `read(token)` | 来自 `pick` 的 token（10 分钟有效） | `{ name, size, text }`，文本 ≤256 KB | `files.read_selected` | `FILE_TOKEN_EXPIRED`、`FILE_TOO_LARGE` |

> 插件永远不会获得文件路径或目录访问权限；用户必须在系统对话框里主动选择文件。

### 5.5 `guandao.theme`

| 方法 | 返回 | 权限 |
| --- | --- | --- |
| `get()` | `{ current: string, mode: "light"\|"dark", accent: string, wall: string }` | `theme.read` |
| `apply()` | `{ ok: true }`（应用本插件 Manifest 里的主题预设） | `theme.apply` |

错误：`NO_THEME`（没有主题预设）。

### 5.6 `guandao.commands`

| 方法 | 参数 | 返回 | 权限 |
| --- | --- | --- | --- |
| `register(commands)` | `{ command: string }[]`（≤8 个，必须在 Manifest `contributes.command` 中声明） | `{ ok: true }` | `desktop.register_command` |

错误：`COMMAND_NOT_DECLARED`、`COMMANDS_UNAVAILABLE`。
宿主通过事件 `command` 把用户选择传回：`guandao.lifecycle.on("command", ({ command }) => ...)`。

### 5.7 `guandao.calendar`

| 方法 | 参数 | 返回 | 权限 | 错误 |
| --- | --- | --- | --- | --- |
| `readSelected()` | — | `{ event: { id, title, date, time, note } \| null }` | `calendar.read_selected` | `EMPTY`（没有日程） |
| `createEvent({title, date, time?, note?})` | — | `{ id, title, date, time }` | `calendar.create_event` | — |

`readSelected()` 会弹系统选择框，只返回用户选中的那一条，不会批量读取。

### 5.8 `guandao.notes`

| 方法 | 参数 | 返回 | 权限 | 错误 |
| --- | --- | --- | --- | --- |
| `readSelected()` | — | `{ note: { title, body, tags } \| null }`，正文 ≤20000 字 | `notes.read_selected` | `EMPTY` |
| `create({title, body?, tags?})` | tags ≤6 个、每个 ≤16 字 | `{ id, title }` | `notes.create` | — |

### 5.9 `guandao.network`

| 方法 | 参数 | 返回 | 权限 | 错误 |
| --- | --- | --- | --- | --- |
| `fetch(url, options)` | `url: https`、`{ method?, headers?, body? }` | `{ status, contentType, text, truncated, bytes }` | `network.fetch` | `DOMAIN_NOT_ALLOWED`、`INVALID_URL`、`REDIRECT_BLOCKED`、`NETWORK_ERROR`、`METHOD_NOT_ALLOWED` |

约束：

- 只允许 `https`、标准 443 端口，禁止 URL 内嵌凭据；
- 域名必须写在 Manifest 的 `networkDomains` 里（最多 8 个），且禁止内网地址；
- 请求头白名单、body ≤16 KB、响应 ≤256 KB（超出截断并标记 `truncated`）；
- 服务器不跟随跳转：3xx 一律 `REDIRECT_BLOCKED`。

### 5.10 `guandao.device`

| 方法 | 返回 |
| --- | --- |
| `info()` | `{ platform, language, online, width, height, pixelRatio, reducedMotion }` |

纯只读，无权限。取自浏览器真实值，不是伪造的硬件信息。

### 5.11 `guandao.lifecycle`

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `ready()` | — | `Promise<{ ok: true }>` | 宿主完成挂载；建议所有初始化写在这里 |
| `on(event, callback)` | `event: string` | `() => void`（取消订阅） | 支持 `ready`、`command`、`theme-change` |
| `reportError(error)` | `Error \| string` | `Promise<void>` | 写入插件日志，失败静默 |

事件：

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `ready` | `{ pluginId, granted }` | 沙箱就绪 |
| `theme-change` | `{ mode, accent, wall }` | 用户切换主题 |
| `command` | `{ command }` | 用户从命令面板执行本插件命令 |

### 5.12 `guandao.app`

- `app.context()`：`context()` 的别名。
- `app.lifecycle`：`lifecycle` 的别名（1.x 旧写法）。

`lifecycle.reportError` 在宿主日志里以 `error` 级别记录，用户可在插件详情的运行日志中看到。

---

## 6. 错误模型

所有 Promise 拒绝值都是 `GuandaoError`：

```ts
type GuandaoError = Error & { code: string };
```

| code | 含义 | 典型处理 |
| --- | --- | --- |
| `INVALID_PAYLOAD` | 参数无法序列化 | 检查是否传了函数 / DOM 节点 |
| `PAYLOAD_TOO_LARGE` | 单次参数 >24 KB | 分片或改用 storage |
| `TIMEOUT` | 宿主 12 秒未响应 | 避免长循环阻塞；重试 |
| `CHANNEL_CLOSED` | 上下文已销毁 | 不再重试 |
| `PERMISSION_DENIED` | 未授予该权限 | `guandao.has()` 判断 + 引导用户授权 |
| `UNKNOWN_METHOD` | 调用了 SDK 不存在的方法 | 检查 SDK 版本 |
| `UNSUPPORTED` | 当前模式不支持（如组件模式 `setTitle`） | 降级 UI |
| `NOTIFICATION_RATE_LIMITED` | 通知超过 5 条/分钟 | 合并通知 |
| `STORAGE_QUOTA` / `STORAGE_QUOTA_GLOBAL` | 超出插件或全局预算 | 清理旧键 |
| `FILE_TOKEN_EXPIRED` / `FILE_TOO_LARGE` | 文件授权过期 / 超过 256 KB | 重新选择 / 提示 |
| `EMPTY` | 日历或笔记没有可选内容 | 引导用户先创建 |
| `COMMAND_NOT_DECLARED` | 命令未在 Manifest 声明 | 补 Manifest |
| `NO_THEME` | 插件没有主题预设 | 检查 `contributes.theme` |
| `NETWORK_FAILED` / `DOMAIN_NOT_ALLOWED` / `REDIRECT_BLOCKED` | 网络代理拒绝 | 检查域名白名单 |

SDK 自身还可能在参数校验阶段抛 `INVALID_PAYLOAD` / `PAYLOAD_TOO_LARGE`。

---

## 7. 权限表

| 权限 | 风险 | 触发的方法 | 授予时机 |
| --- | --- | --- | --- |
| `notification.show` | low | `ui.notify`、`notifications.*` | 安装时 |
| `dialog.open` | low | `ui.dialog` | 安装时 |
| `plugin.storage.read` | low | `storage.get/keys` | 安装时 |
| `plugin.storage.write` | low | `storage.set/delete/clear` | 安装时 |
| `theme.read` | low | `theme.get` | 安装时 |
| `desktop.open_app` | low | `ui.openApp` | 安装时 |
| `desktop.register_command` | low | `commands.register` | 安装时 |
| `desktop.add_widget` | medium | `widget.setEnabled/setTitle` | 安装时确认 |
| `theme.apply` | medium | `theme.apply` | 安装时确认 |
| `calendar.create_event` | medium | `calendar.createEvent` | 安装时确认 |
| `notes.create` | medium | `notes.create` | 安装时确认 |
| `files.pick` | medium | `files.pick` | 安装时确认 |
| `files.read_selected` | **high** | `files.read` | 逐项确认 |
| `network.fetch` | **high** | `network.fetch` | 逐项确认 |
| `notes.read_selected` | **high** | `notes.readSelected` | 逐项确认 |
| `calendar.read_selected` | **high** | `calendar.readSelected` | 逐项确认 |

2.0 起：**换设备恢复安装时，含高敏感权限的插件保持禁用**，必须在本机重新保存一次授权才能启用。

---

## 8. 兼容与迁移

| 变化 | 处理 |
| --- | --- |
| 新增方法 | 旧插件不需要改动 |
| 修改参数校验（如收紧长度） | 在 release notes 标注；SDK 仍返回明确的 `INVALID_*` |
| 废弃方法 | 标记 `@deprecated`，至少保留一个次版本；本文件与 `PLUGINS-1.7.md` 同步更新 |
| 主版本升级（SDK 2） | 需要插件声明新的 `sdkVersion`；旧插件继续按 1.x 运行 |

`docs/PLUGINS-1.7.md` 中的历史说明仍有效；若与本文件冲突，以本文件为准（2.0 修订）。

---

## 9. 调试与验证

| 命令 | 用途 |
| --- | --- |
| `guandao validate` | Manifest / 文件 / 体积 / 路径 |
| `guandao test` | 额外检查入口、SDK 调用表面、打包摘要 |
| `guandao dev` | Mock Host（全权限，仅开发） |
| `guandao preview` | 从 `.gplug` 包加载并校验摘要 |
| `guandao build` / `package` | 生成可分发包 |
| `guandao publish` | 发布到开发者中心（需要登录 Cookie） |

Mock Host 会授予 Manifest 里的全部权限，**不能代表正式安装后的权限行为**；发布前请在真实系统里安装验证。