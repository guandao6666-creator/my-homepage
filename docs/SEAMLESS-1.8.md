# Guandao OS 1.8 · Seamless Experience

**Release Name: Beyond One Device**  
**One System. Every Device. Always Connected.**

本文是 1.8 的交付说明：自适应外壳、设备配对、跨设备接力、剪贴板、移动端伴侣、PWA、数据表、API、安全测试、部署与已知限制。

---

## 1. 项目审查结论（1.0–1.7 真实状态）

| 模块 | 审查结果 | 1.8 处理 |
| --- | --- | --- |
| 窗口系统 / 虚拟桌面 / 工作空间 / Dock / Widget | 已实现，状态来自真实 localStorage 与 DOM | 保留，增加平板与窄窗口布局 |
| Notes / Tasks / Calendar | 桌面端已实现，数据保存在**本机 localStorage** | 不伪造云同步；移动端共用同一份数据；跨设备通过「内容快照接力」 |
| Cloud Drive | 已实现，文件在 R2、元数据在 D1 | 移动端复用 `/api/files`；文件接力只传引用 |
| Guandao Account | 已实现，HttpOnly Session + D1 | 配对成功后签发独立 Session |
| Guandao Devices | 已实现，在线状态来自真实心跳 | 增加「添加设备」与配对确认 |
| Cloud Sync | **不存在通用同步引擎**，只有 Drive 的云端状态 | 不新建第二套同步；只增加语义化上下文 |
| PWA / Service Worker | **完全不存在** | 新增 manifest、图标、SW、离线页、更新提示 |
| 移动端 | 只有「缩小桌面 + 手机桌面模式」 | 新增独立 `/m/`，不加载窗口系统 |
| 插件沙箱 | 1.7 已完成，双层 opaque-origin iframe | 保留；接力页面不进入沙箱 |

> 结论：1.8 没有把本地数据伪装成云同步；跨设备能力建立在「用户主动发送的内容快照」上，并明确区分本机保存与云端接力。

---

## 2. Adaptive Shell

### 2.1 模式判断

`src/lib/shell/adaptive.ts`：

- **mobile**：宽度 < 640，或触屏且 `min(宽, 高) < 500`（横屏手机）。
- **tablet**：宽度 < 1024，或触屏且宽度 < 1280。
- **desktop**：其余情况。

不读取 User-Agent；只看视口尺寸、`pointer: coarse` 与 `maxTouchPoints`。
首帧由 `index.astro` 的内联脚本写入 `data-shell`，避免先渲染桌面再跳走。

### 2.2 三种体验

- **Desktop**：完整菜单栏、Dock、窗口、虚拟桌面、Widget；≥1800px 时窗口上限 1480px，避免超宽屏拉伸。
- **Tablet**：46px 菜单栏、58px Dock、96px 桌面图标、窗口接近满宽（`vw-32`，高度至少 640）、触摸目标 ≥ 44px、允许手指拖到边缘贴靠。
- **Mobile**：独立 `/m/` 页面，不加载窗口系统。

### 2.3 手动切换

「视图」菜单：自适应 / 桌面 / 平板 / 手机。选择写入 `guandao.os18.shell.v1`。
移动端「更多 → 设置 → 布局模式」提供同样的四个选项。
切换跨页面时使用 `location.replace`，不产生历史垃圾。

### 2.4 应用内响应式

窗口宽度由 `ResizeObserver` 写入 `data-w="sm|md|lg"`，CSS 按**窗口容器宽度**重排 Notes、Calendar、Drive、Devices、Backup、Security、通用 `g14-shell` 等，不依赖视口宽度。

---

## 3. 设备配对

### 3.1 状态机

```
pending ──claim──▶ claimed ──confirm(source)──▶ confirmed ──deliver──▶ completed
   │                  │                          │
   └──── cancel ──────┴──────── cancel ──────────┘
                 expires_at 到期 → expired
```

### 3.2 流程

1. 已登录设备 A：`POST /api/pairing/create` → 6 位数字码 + 一次性 token + `qrUrl`。
2. 新设备 B：打开 `/pair/#t=<token>` 或输入数字码 → `POST /api/pairing/claim`，记录设备名称/类型/浏览器/系统，返回 `claimSecret`。
3. 设备 A：在「设备中心 → 添加设备」看到 B 的信息，点击批准 → `POST /api/pairing/:id/confirm`，服务端登记设备。
4. 设备 B：轮询 `GET /api/pairing/claim/:id?secret=`；确认后服务端签发**新的** Session，写入 `gauth_sid`（HttpOnly / SameSite=Lax）与 `gauth_did`，标记 completed。

### 3.3 安全约束

- 二维码只含 `/pair/#t=<短期 token>`，**不含** Session Cookie、GitHub Token 或长期凭证；token 在 URL fragment 中，不发往服务端日志。
- token / 配对码 / claimSecret 只存 SHA-256 哈希。
- 10 分钟过期；配对码只能成功一次；完成后重复领取返回 `alreadyDelivered`。
- 只有**发起配对的设备**能确认（`source_device_id` 必须匹配当前 Session 的设备）。
- 新设备 Session 在领取时才生成；未领取的 confirmed 会话不产生凭证。
- 每账号最多 10 台活跃设备；超过返回 `DEVICE_LIMIT`。
- 提交配对限流 20 次 / 10 分钟；创建配对 12 次 / 小时（按 IP）。
- 失败只返回通用文案，不泄露账号是否存在。

---

## 4. 跨设备接力

### 4.1 内容类型

`note`、`task`、`event`、`file`、`link`、`workspace`、`reading`、`app`。

### 4.2 状态

```
pending ──目标设备拉取──▶ delivered ──打开──▶ opened ──完成──▶ completed
   │                         │
   └──── cancel ─────────────┴──── cancel / expire
```

- `delivered` 只在目标设备**真的拉取收件箱**时写入，发送端看到的「已送达」来自数据库。
- 目标设备离线时保持 `pending`，界面显示「等待设备上线」，不会假装已送达。
- `target_device_id` 为空表示「任一设备」；第一个拉取的设备会领取并落成自己。

### 4.3 payload

- 只带恢复所需最小字段；笔记正文、任务备注、日程信息由用户主动发送。
- 上限 32 KB；超过返回 413。
- 不包含 Cookie、Token、文件二进制、窗口绝对坐标。
- 工作空间 payload 会剥离 `windows`，只保留主题、壁纸、组件配置、Dock、快捷方式、应用 ID。

### 4.4 恢复行为

| 类型 | 目标设备 |
| --- | --- |
| note | 写入本地 Notes（若已存在同 ID 则打开），并打开 Notes 窗口 |
| task | 加入任务中心 |
| event | 加入日历 |
| file | 打开云盘，显示文件名 |
| link | 新标签打开 |
| workspace | 经 `importCommunityWorkspace` 过滤不支持的应用/组件后应用；缺失项提示，原始 payload 保留在接力记录 |
| reading | 展示阅读进度，可完成 |
| app | 说明需要在原应用继续，不伪造现场 |

### 4.5 语义化上下文

`device_contexts` 只保存：`app_id`、`resource_id`、`resource_title`、`workspace_id`、`scroll`、`updated_at`。
桌面在应用打开时上报；移动端在切换页面 1.5 秒后上报。**不保存窗口坐标**。

---

## 5. 跨设备剪贴板

- 只在用户点击「发送」时写入，纯文本，最多 4000 字符。
- 不做后台监听、不读取系统剪贴板、不采集剪贴板历史。
- 24 小时过期；每人最多保留 50 条；可单条删除。
- 复制使用 `navigator.clipboard`，被拒绝时弹出可长按选择的文本框作为降级。
- 默认发送给「任一设备」，也可指定设备。

---

## 6. 移动端伴侣 `/m/`

独立页面，不加载窗口系统：

- 首页：问候、账号状态、离线提示、待接收接力、今日任务、近期日程、最近笔记、最近文件、其他设备进度。
- 笔记：搜索、新建、编辑、置顶、删除、发送到设备；自动保存到本机。
- 任务：今天 / 未完成 / 已完成；新建、编辑、完成、优先级、分类、截止日期。
- 日历：月历、选中日列表、新建/编辑/删除/发送。
- 文件：云端列表、图片预览、下载、上传、发送到设备。
- 更多：文件、设备与配对、剪贴板、账号、设置。
- 设置：布局模式、安装到主屏、检查更新、推送状态、清理离线缓存。
- 账号：GitHub 登录、设备管理、退出登录。

数据：Notes/Tasks/Calendar 与桌面**同一个 localStorage 键**；文件/设备/接力走现有 API。
离线：本机编辑照常；接力与剪贴板进入 `guandao.os18.outbox.v1`，联网后按顺序补发，4xx 丢弃、5xx 与网络错误保留。

---

## 7. PWA

- `public/manifest.webmanifest`：`start_url=/m/`、`scope=/`、standalone、192/512/maskable 图标、三个快捷方式。
- `public/sw.js`：
  - 预缓存 `/m/`、`/offline/`、图标、manifest、默认壁纸。
  - 导航请求 network-first，失败回退缓存或 `/offline/`。
  - 静态资源 stale-while-revalidate。
  - **绕过** `/api/*`、`/sb/*`、`/sandbox/*`、`/pair*`，避免私人数据进入公共缓存。
  - 新版本进入 waiting，用户在更新条点击后才 `skipWaiting`。
- `public/_headers`：`/sw.js` no-cache + `Service-Worker-Allowed: /`；manifest 正确 MIME。
- 离线页 `/offline/` 说明本机数据与排队行为。

---

## 8. Push 通知

**未启用。** `/api/push/status` 如实返回：

```json
{ "enabled": false, "configured": false, "delivery": "in-app", "reason": "未配置 VAPID 密钥，Web Push 未启用…" }
```

接力内容通过应用内 60 秒轮询与窗口通知发现；没有把页面内提示冒充系统 Push。

---

## 9. 数据表（migration 0011）

| 表 | 用途 |
| --- | --- |
| `device_pairings` | 配对会话、token/code/claimSecret 哈希、状态、目标设备信息 |
| `continuity_items` | 接力内容、payload、目标设备、状态与时间戳 |
| `device_contexts` | 每台设备一条语义化上下文 |
| `clipboard_items` | 纯文本剪贴板，24h 过期 |

不新建 R2 Bucket；接力内容存 D1（≤32 KB），文件只存引用。

---

## 10. API 清单

### 配对

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| POST | `/api/pairing/create` | Session + 同源 |
| GET | `/api/pairing` | Session |
| POST | `/api/pairing/claim` | 无（凭 token/码） |
| GET | `/api/pairing/claim/:id?secret=` | claimSecret |
| POST | `/api/pairing/:id/confirm` | 来源设备 Session + 同源 |
| POST | `/api/pairing/:id/cancel` | Session + 同源 |

### 接力

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/continuity/send` | 发送内容快照 |
| GET | `/api/continuity/inbox` | 当前设备收件箱，写入 delivered |
| GET | `/api/continuity/history` | 发送/接收历史 |
| POST | `/api/continuity/:id/open` | 打开，校验目标设备 |
| POST | `/api/continuity/:id/complete` | 完成 |
| POST | `/api/continuity/:id/cancel` | 取消（发送方） |
| GET | `/api/continuity/context` | 所有设备语义化进度 |
| PUT | `/api/continuity/context` | 上报当前设备进度 |

### 剪贴板 / 推送

| 方法 | 路径 |
| --- | --- |
| POST | `/api/clipboard/send` |
| GET | `/api/clipboard` |
| DELETE | `/api/clipboard/:id` |
| GET | `/api/push/status` |

所有需要身份的接口只从 Session 取 `user_id`；`targetDeviceId` 必须属于当前账号；非 GET 全部校验 Origin。

---

## 11. 测试结果

### API（真实 Worker + D1 + R2）

```bash
npm run qa:continuity
```

**45 / 45 通过**：配对创建/提交/越权确认/批准/领取/重放/重复码、接力发送/收件/越权打开/完成、剪贴板跨账号隔离、上下文隔离、CSRF、未登录、非法类型、自发送、跨账号目标、超大 payload、Push 状态。

### UI（headless Chrome）

```bash
npm run qa:continuity:ui
```

**38 / 38 通过**：1440 桌面、834 平板、1112 横屏平板、2560 超宽屏、390 手机、844 横屏手机；接力中心、发送面板、配对二维码、移动端笔记/任务/日历/设备、横向溢出、脚本错误、抽屉操作区可见性。

### 1.7 回归

```bash
npm run qa:plugins
npm run qa:plugins:ui
```

插件 API 与沙箱测试保持通过（见 `docs/PLUGINS-1.7.md`）。

---

## 12. 已知限制

1. Notes / Tasks / Calendar 仍是**本机数据**，不是账号云同步；跨设备使用「发送到设备」传快照。
2. 接力不是远程控制：不能操作离线设备，也不能重建目标设备的完整应用现场。
3. Web Push 未启用（无 VAPID）；只有应用内轮询。
4. 工作空间接力会过滤目标设备不支持的应用/组件；原始 payload 保留但不会加载。
5. 剪贴板仅纯文本，受浏览器剪贴板权限限制；已提供手动复制降级。
6. 文件接力只传引用，目标设备需要同一账号且文件未删除。
7. 移动端手势覆盖点击/长按目标与安全区；未实现复杂的横向滑动返回（避免与滚动冲突）。
8. 平板分屏依赖现有贴边吸附（手指可触发）与最大化，不是独立的 Stage Manager。
9. 离线只保证已缓存页面与本机数据；云端文件、接力、账号状态离线不可用。
10. PWA 安装提示由浏览器决定；不支持 `beforeinstallprompt` 的浏览器需要手动「添加到主屏幕」。
11. iOS 对 PWA 后台、推送与存储有系统级限制，行为以 Safari 实际为准。

---

## 13. 部署

```bash
npm ci
npm run build
npm run db:migrate:remote   # 0011_continuity.sql
npm run cf:deploy
```

部署后自检：

```bash
curl https://guandao.xin/api/health
curl https://guandao.xin/api/plugins/meta
curl -I https://guandao.xin/manifest.webmanifest
curl -I https://guandao.xin/sw.js
```

`/m/`、`/pair/`、`/offline/` 均随静态资源一起部署；无需新 R2 Bucket 或额外 Worker。

本次上线版本：Worker `b9bb98e8-1611-4912-bf26-5d72679de280`（2026-11-05）。
修改 `public/sw.js` 的外壳资源后，请同步提升 `VERSION`，否则老用户的 Cache Storage 不会主动换新。

---

## 14. 主要文件

```
migrations/0011_continuity.sql
worker/api/pairing/{handlers,store}.js
worker/api/continuity/{handlers,store}.js
src/lib/shell/adaptive.ts
src/lib/shell/pwa.ts
src/lib/continuity/{client,payloads,ui,app,qr}.ts
src/lib/mobile/{app,data,ui}.ts
src/lib/pairing/page.ts
src/pages/{m,pair,offline}.astro
src/styles/{mobile,pairing,continuity,adaptive}.css
public/{manifest.webmanifest,sw.js,icons/*}
scripts/{continuity-qa,continuity-ui-qa}.mjs
```
