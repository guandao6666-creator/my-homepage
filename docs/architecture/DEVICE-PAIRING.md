# 设备配对与跨设备接力（Guandao OS 2.0 · Phase 3.3）

> 本文描述**当前代码里真实存在的行为**，不是产品愿望清单。所有与设计意图不一致的地方都在
> 「安全边界与已知偏差」里明确标注。E2E 实测结论见最后一节，未验证的内容如实列出。

## 1. 范围与结论

本阶段关注三条跨设备能力：

| 能力 | 入口 | 一句话语义 |
| --- | --- | --- |
| 设备配对 | `/api/pairing/*` | 已登录设备生成 6 位码 / 二维码，新设备提交后由旧设备批准，新设备领取独立 Session |
| 跨设备接力 | `/api/continuity/*` | 账号内把一份带类型的内容快照定向（或任选）投递到另一台设备，并跟踪待办状态 |
| 剪贴板 | `/api/clipboard/*` | 账号内显式发送 ≤4000 字符纯文本，24 小时过期，可定向或任选设备 |

三条都要求登录 Session（cookie `gauth_sid`），写接口额外校验同源。配对是唯一一个
「B 端在配对完成前没有登录态」的流程，因此它的领取接口不要求 Session，靠一次性
`claimSecret` 轮询。

## 2. 数据模型

### 2.1 devices（设备）

`devices` 表由 `migrations/0001_init.sql` 建立，`0004_devices.sql` 补齐设备画像：

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 服务端 `randomUUID()` 生成；不作为认证凭证 |
| `user_id` | TEXT NOT NULL → users(id) CASCADE | 所有查询必须带 `user_id` |
| `name` | TEXT NOT NULL，长度 1–80 | 用户可见名；配对提交时截断到 40 字 |
| `platform` / `app_version` | TEXT | 1.5 之前的旧字段，仍保留 |
| `device_type` | TEXT CHECK desktop/laptop/tablet/mobile，默认 desktop | UA 只能粗分，允许后续更正 |
| `browser_name` / `os_name` / `user_agent` | TEXT | `describeUserAgent` 解析结果，**不做指纹识别**，只用于设备卡片 |
| `last_seen_at` | INTEGER | 最近一次任意心跳 |
| `last_active_at` | INTEGER | 最近一次前台心跳（与 last_seen 分开，避免后台标签页算「在线」） |
| `last_sync_at` | INTEGER | 最近一次同步 |
| `trusted_at` | INTEGER | 旧设备批准后写入；配对确认成功后即 `trusted_at = now` |
| `status` | TEXT CHECK active/revoked，默认 active | 与 `revoked_at` 双写：status 供查询，revoked_at 供审计 |
| `revoked_at` | INTEGER | 撤销时间 |
| `created_at` | INTEGER | 创建时间 |

相关表：

- `sessions`（`0002_account.sql` + `0004`）：`id / user_id / token_hash(UNIQUE) / device_id / user_agent / expires_at / created_at / last_used_at / revoked_at`。撤销设备时先把该设备所有 Session 置 `revoked_at`，再把设备置 `revoked`。
- `device_activity`：只记事件类型与最小元数据（registered / signed_in / signed_out / renamed / device_revoked / session_revoked / trusted / sync_*），不写 Token、Secret、正文。
- `device_sync_state`：每设备每域（notes/tasks/calendar/drive）的同步状态；`mode` 区分 cloud/local，避免把浏览器本地存储显示成「已同步」。
- `device_contexts`：语义化上下文（app_id / resource_id / 标题 / workspace / 滚动位置），**不保存窗口绝对坐标**。

### 2.2 device_pairings（配对会话）

`migrations/0011_continuity.sql`：

| 字段 | 说明 |
| --- | --- |
| `id` | 配对会话 ID |
| `user_id` | 发起配对的账号 |
| `source_device_id` | 发起配对的旧设备（A 端），confirm 时校验它等于当前 Session 的 device_id |
| `target_device_id` | 批准后写入的新设备 ID |
| `token_hash` | 二维码短期 token 的 SHA-256；原始 token 只在创建响应里出现一次 |
| `code_hash` | 6 位数字码的 SHA-256（加 `code:` 前缀后哈希） |
| `claim_secret_hash` | 新设备轮询凭据的 SHA-256；旧设备永远看不到 |
| `status` | `pending / claimed / confirmed / completed / cancelled / expired` |
| `attempts` / `max_attempts` | 提交尝试计数 / 上限（默认 5） |
| `target_name/type/browser/os/user_agent` | claim 时从请求体 + UA 解析后写入 |
| `expires_at` | `created_at + 600000`（10 分钟） |
| `claimed_at/confirmed_at/completed_at/cancelled_at` | 状态时间戳，供审计 |

索引：`(user_id, status, created_at DESC)`、`(code_hash, status, expires_at DESC)`（防枚举查找）。

### 2.3 continuity_items（接力条目）

| 字段 | 说明 |
| --- | --- |
| `item_type` | CHECK 于 `note/task/event/file/link/workspace/reading/app` 八类 |
| `title` | 默认空串，DB 上限 160；接口写入时截断 120 |
| `resource_id` | 可选，≤160 |
| `payload_json` | 内容快照，`json_valid` 约束；接口限制序列化后 ≤32KB |
| `status` | `pending / delivered / opened / completed / cancelled / expired` |
| `target_device_id` | NULL 表示「任一设备可领取」；首个拉取收件箱的设备会把它落成自己 |
| `expires_at` | 默认 72h，接口允许 1h–7d |
| 各状态时间戳 | `delivered_at / opened_at / completed_at / cancelled_at` |

> 注意：发送字段名是 **`itemType`**，不是 `kind`。传 `kind` 会被当作缺少 `itemType` → 400 INVALID_TYPE。

### 2.4 clipboard_items（剪贴板）

| 字段 | 说明 |
| --- | --- |
| `content` | CHECK 长度 1–4000；接口拒绝纯空白 |
| `source_device_id` / `target_device_id` | 来源 / 可选定向目标（NULL = 账号内任意设备） |
| `created_at` / `expires_at` | 固定 24h TTL |
| `deleted_at` | 软删除时间；查询过滤 |

表注释明确：只在用户点击 Send 时写入，没有后台监听；服务端**不记录 IP / UA**。

## 3. 配对状态机与接口

### 3.1 状态机

```
create ──▶ pending ──(B claim)──▶ claimed ──(A confirm)──▶ confirmed ──(B poll)──▶ completed
              │                     │                        │
              └── cancel ──▶ cancelled◀── cancel ──┘          │
              └── TTL 到期 ──▶ expired（lazy 清理）            └── cancel ──▶ cancelled
```

- **pending**：A 已生成码 / 二维码，等待 B 提交。
- **claimed**：B 提交了 6 位码或 token，等待 A 在已登录设备上批准。B 拿到 `claimSecret` 用于轮询。
- **confirmed**：A 批准，`devices` 插入一行（`trusted_at = now`），等待 B 领取 Session。
- **completed**：B 轮询到 confirmed，服务端签发独立 Session 与设备 Cookie；此后再轮询返回 `alreadyDelivered: true` 且不再重复下发 Cookie。
- **cancelled**：A 主动取消（pending/claimed/confirmed 都可取消）。
- **expired**：`expires_at <= now` 的 lazy 清理（创建 / 列表时调用 `expirePairings`；查询接口本身也会按时间判定）。

### 3.2 接口

| 方法/路径 | 前置条件 | 成功响应要点 | 主要错误 |
| --- | --- | --- | --- |
| `POST /api/pairing/create` | 登录 Session + 同源 + `session.deviceId` 非空 | `{pairingId, code(6位), token(32字符 base64url), expiresAt, ttl:600000, qrUrl, origin}` | 401 UNAUTHENTICATED / 409 NO_DEVICE / 403 CSRF_REJECTED |
| `GET /api/pairing` | 登录 | `{items: publicPairing[], currentDeviceId}`，含 attempts/maxAttempts/expired/target | 401 |
| `POST /api/pairing/claim` | **无需登录**（B 端此时未登录）+ 同源；body `{code \\| token, device:{name,type,browser,os}}` | `{pairingId, claimSecret, status:"claimed", device, source, expiresAt}` | 400 INVALID_CODE / 400 INVALID_TOKEN / 404 PAIRING_NOT_FOUND / 403 CSRF_REJECTED |
| `GET /api/pairing/claim/:id?secret=` | 持 claimSecret | pending/claimed：`{status, expiresAt, source, paired:false}`；confirmed：`{status:"completed", paired:true, deviceId, user}` + 两个 `Set-Cookie` + `x-pairing-cookie: gauth_sid` / `x-pairing-device-cookie: gauth_did`；已完成重放：`alreadyDelivered:true` | 400 INVALID_CLAIM / 404 / 410 PAIRING_EXPIRED / 410 PAIRING_CANCELLED |
| `POST /api/pairing/:id/confirm` | 登录 + 同源 + `session.deviceId === source_device_id` | `{status:"confirmed", device:{id,name,type}, pairing}`；插入 devices 行 | 404 / 409 PAIRING_STATE / 410 PAIRING_EXPIRED / 403 WRONG_DEVICE / 409 DEVICE_LIMIT |
| `POST /api/pairing/:id/cancel` | 登录 + 同源 | `{cancelled:true}` | 404 |

领取成功后服务端下发的 Cookie：

- `gauth_sid`（HttpOnly、`Path=/`、`SameSite=Lax`、Max-Age 30 天）——新设备的独立 Session；
- `gauth_did`（HttpOnly、`Path=/`、`SameSite=Lax`、Max-Age 365 天）——设备标识；
- 响应头 `x-pairing-cookie` / `x-pairing-device-cookie` 供前端判断是否已领取。

### 3.3 TTL

`PAIRING_TTL_MS = 10 * 60 * 1000`。创建响应同时返回 `expiresAt`（绝对毫秒时间戳）和 `ttl: 600000`。
服务端**没有定时任务**，过期是 lazy 语义：`expirePairings()` 在创建 / 列表时把超时行改成
`expired`；查询 / claim 路径还会直接比较 `expires_at <= now`，所以即使没被清理也不会被使用。

## 4. 安全边界与已知偏差

设计上的边界：

1. **6 位数字码 = 1,000,000 组合（约 19.93 bit / 常称 20bit）**。单靠它防不住穷举，必须叠加限流与一次性。
2. **10 分钟 TTL**：码 / token 只在 10 分钟内可用；过期行 lazy 清理但查询时也会判时间。
3. **一次性认领**：同一配对最多成功认领一次（`markClaimed` 条件更新 `status='pending'`）；`attempts / max_attempts` 字段保留作历史兼容，但不会累加到 5（见偏差 2）。真实防枚举 = 10 分钟 TTL + `pairing-claim` 10 次/10 分钟/IP 限流 + 必须由已登录原设备 confirm。
4. **全哈希存储**：`token_hash = SHA-256(token)`、`code_hash = SHA-256("code:" + code)`、`claim_secret_hash = SHA-256(claimSecret)`；Session 也只存 `token_hash`。原始值只在创建响应或 claim 响应里出现一次。
5. **一次性提交**：`markClaimed` 的 UPDATE 带 `WHERE id = ? AND status = 'pending'`，claim 后同一码再提交不会命中。
6. **confirm 必须登录 + 同源 + 当前设备匹配**：`session.deviceId` 必须等于 `source_device_id`，防止 B 端自己批准自己；账号内最多 10 台未撤销设备（`MAX_DEVICES=10`，revoked 不计数）。
7. **Cookie**：HttpOnly、SameSite=Lax，不设 Domain；令牌不暴露给 JS。
8. **审计**：批准记录 `trusted` 活动与 `new_device_registered` 安全事件；登录记录 `signed_in` 与 `session_created`。
9. **限流**（`worker/api/ratelimit.js`，路由层先于业务逻辑）：`pairing-create` 12 次/小时/IP、`pairing-claim` 10 次/10 分钟/IP、全局 600 次/分钟；按 `cf-connecting-ip` 分桶（本地 wrangler 所有请求都落 127.0.0.1 单桶）。

实现与设计/任务描述不一致的地方（**发现，未改代码**）：

| # | 偏差 | 实际行为 | 影响 / 建议 |
| --- | --- | --- | --- |
| 1 | ~~`POST /api/pairing/claim` 没有同源校验~~ | **已在 3.3 修复**：`claim` POST 补上 `assertSameOrigin(request, env)`，缺 Origin / 跨源 → 403 `CSRF_REJECTED` | 修复前第三方页面可替用户提交 claim；现在与其余写接口一致。E2E「3b 批准边界」锁定该行为 |
| 2 | ~~`PAIRING_ATTEMPTS_EXCEEDED`（429）经公开 API 不可达~~ | **已在 3.3 处理**：删除 claim 里不可达的 `attempts >= max_attempts → 429` 分支，并在代码注释中说明原因；DB 的 `attempts/max_attempts` 列保留（历史兼容），`markClaimed` 仍写 1 | 不再让读者误以为存在「5 次锁定」。真实防线：10 分钟 TTL + `pairing-claim` 10 次/10 分钟/IP 限流 + 只能由已登录原设备 confirm。若未来要恢复尝试计数，需按码维度记录失败次数（保持 pending），那是独立设计 |
| 3 | ~~`open` 响应里的 `openedAt` 为 `null`~~ | **已在 3.3 修复**：handler 在 `markItem` 之后用 `getItem` 重新读取，响应里的 `openedAt` 与 DB 一致 | 修复前只是响应快照陈旧，列表接口本身正常；E2E 仍以 open 之后 `GET /inbox` 的时间戳为最终断言 |
| 4 | ~~撤销设备后的 401 错误码不统一~~ | **已在 3.3 统一**：`worker/api/guards.js` 导出 `sessionFailure(state)` 与 `requireActiveSession()`，devices / continuity / clipboard / pairing 全部复用 → `SESSION_REVOKED` / `DEVICE_REVOKED` / `SESSION_EXPIRED` / `ACCOUNT_DISABLED` / `UNAUTHENTICATED` 在所有模块一致 | 前端可统一提示「已在其他设备撤销」；E2E 测试 9 对五条路径（devices / continuity inbox / clipboard / pairing）断言同一组错误码 |
| 5 | 任务背景把接力发送字段写成 `kind` | 实现字段是 `itemType`，8 类枚举 | 以 `itemType` 为准；E2E 已锁定该契约 |

> 第 1–4 条已在本次修复并加入回归断言；第 5 条只报告（字段名以实现为准，属文档偏差，不改代码）。

## 5. 跨设备接力状态机

### 5.1 状态机

```
send ──▶ pending ──(目标设备 GET inbox：pending→delivered，并绑定 target)──▶ delivered
                                  │                                            │
                                  ├──(目标设备 open)──▶ opened ──(complete)──▶ completed
                                  └──(send 方 cancel)──▶ cancelled
任意 running 状态 TTL 到期（lazy purgeExpired）──▶ expired
```

- **pending**：已写入。`target_device_id` 为 NULL 时，第一个拉取收件箱的设备会把它写成自己，防止同一份内容被多台设备重复消费。
- **delivered**：目标设备拉过收件箱（`GET /api/continuity/inbox` 内部先做 UPDATE），`deliveredAt` 落库。
- **opened**：目标设备 `POST /:id/open`；响应使用更新后的行，`openedAt` 与 DB 一致（3.3 已修复，见偏差 3）。
- **completed**：`POST /:id/complete`。
- **cancelled**：仅 pending / delivered 可取消，其它状态 409 NOT_CANCELLABLE。
- **expired**：pending / delivered / opened 且 `expires_at <= now` 的条目由 `purgeExpired` 置 expired；claim / open 路径也会直接判过期。

发件箱 / 收件箱语义：

- `GET /api/continuity/inbox`：只列 `delivered` / `opened`，且目标设备是当前设备或 NULL；返回 `currentDeviceId` 与 `serverTime`。
- `GET /api/continuity/history`：同账号全部条目（最多 60 条），`outgoing` 字段表示「当前设备是否是发送方」。
- 发给指定设备的条目不会出现在发送方收件箱里。

### 5.2 接口

| 方法/路径 | 说明 | 主要错误 |
| --- | --- | --- |
| `POST /api/continuity/send` | body `{itemType, title?, payload?, resourceId?, targetDeviceId?, ttlMs?}`；`targetDeviceId` 缺省 = 任一设备 | 400 INVALID_TYPE / 400 INVALID_PAYLOAD / 413 PAYLOAD_TOO_LARGE / 400 SELF_TARGET / 404 TARGET_NOT_FOUND / 409 NO_DEVICE |
| `GET /api/continuity/inbox` | 拉取 + 领取（pending→delivered） | 401 / 409 NO_DEVICE |
| `GET /api/continuity/history` | 账号内历史（60 条） | 401 |
| `POST /api/continuity/:id/open` | 置 opened（首次也会绑定 target） | 404 NOT_FOUND / 403 NOT_TARGET / 410 EXPIRED |
| `POST /api/continuity/:id/complete` | 置 completed | 同上 |
| `POST /api/continuity/:id/cancel` | 仅 pending / delivered | 404 / 409 NOT_CANCELLABLE |

限制：`title` 接口截断 120 字（DB 上限 160）、`payload` 序列化后 ≤32KB、TTL 1h–7d（默认 72h）、body 读取上限 48KB。

## 6. 剪贴板

- 显式发送纯文本：`POST /api/clipboard/send {content, targetDeviceId?}` → 201 `{id, ttl: 86400000}`。
- `content` 去 NUL、trim 后不得为空（400 EMPTY_CONTENT）；长度上限 **4000 字符**（超限 413 CONTENT_TOO_LONG）；请求体上限 12KB。
- `targetDeviceId`：缺省 = 任一设备；等于当前设备时按「任一设备」处理（写 NULL）；不属于本人 → 404 TARGET_NOT_FOUND。
- 每账号最多保留 50 条（插入前删最旧）；`GET /api/clipboard` 返回**最新 30 条**、24h 内、未删除、目标为当前设备或 NULL。
- `DELETE /api/clipboard/:id` 为软删除；非本人 / 不存在 → 404。
- 过期清理：`purgeExpired()` 删除过期行与已删除行。
- 迁移注释明确不记录来源 IP / UA；这是「用户主动发送」而非剪贴板监听。

## 7. E2E 实测

### 7.1 文件与运行方式

- 用例：`tests/e2e/device.spec.ts`（12 个用例，`serial` 串行共享 A/B 设备状态）。
- 辅助：`tests/e2e/support/device-flow.ts`（Context / Cookie / HTTP / 各业务流封装）。
- 环境：真实 Worker（`scripts/e2e-server.mjs` 拉起 `wrangler dev --local`，端口 8788）+ 本地 D1；5 个 seed 账号（developer / installer / admin / outsider / crowded），其中 installer 额外预置**第二台已登录设备**（`installer2` token），crowded 预置 **10 台未撤销设备**；每台设备都有绑定 `device_id` 的 Session。夹具里还包含两条**直插的已过期配对**（`expiredPairing`），用于真实过期判定。
- 运行：

  ```powershell
  npx playwright test --project=worker tests/e2e/device.spec.ts
  # 同一 spec 的第二浏览器引擎（Firefox 157，已安装）
  npx playwright test --project=firefox-worker
  # 第三引擎：WebKit 27.2（Safari 家族引擎；≠ 真机 Safari/iOS）
  npx playwright test --project=webkit-worker
  ```

  首次运行前安装引擎：`npx playwright install firefox webkit`；本机实测 WebKit 官方 CDN 曾停滞，可改用 `PLAYWRIGHT_WEBKIT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`（60.2 MiB，`webkit-2370`）。

  Playwright 的 `webServer` 会自动拉起 `scripts/e2e-server.mjs`（若已在 8788 运行则复用），并以 8789 的 `GET /__e2e/ready` 作为夹具就绪信号。无需清限流：support 层给每个 Actor 注入每轮唯一、跨轮随机的 `cf-connecting-ip`；过期配对夹具由 `beforeAll` 通过本地夹具端点自动复位。

### 7.2 上下文隔离方式

| 身份 | 建立方式 | Cookie 来源 |
| --- | --- | --- |
| A（旧设备） | `browser.newContext()` + `addCookies(gauth_sid = fixtures.tokens.installer)` | 预置 Session |
| A2（同账号第二台已登录设备） | `browser.newContext()` + `addCookies(gauth_sid = fixtures.tokens.installer2)` | 预置第二台设备的 Session |
| B（新设备） | `browser.newContext()`，初始**零 Cookie** | 配对 confirmed 后由服务端 `Set-Cookie`，E2E 再显式 `addCookies` 接管 |
| C（未确认设备） | `browser.newContext()`，零 Cookie；只 claim、不 confirm | 无（claim 不下发 Session） |
| outsider | `browser.newContext()` + 另一个账号的 token | 预置 Session |
| crowded | `browser.newContext()` + `fixtures.tokens.crowded` | 预置 10 台设备 + 1 个 Session |

六个 Context 不共享 storageState / Cookie / 页面存储；所有请求从各自 `context.request` 发出。

### 7.3 实测结果

最终验证：**连续两次全绿，12/12，无重试**。两次运行之间不重启 e2e-server、不清本地 D1，用于验证用例幂等、限流分桶隔离与过期夹具复位。

| 轮次 | 本地时间（+08:00） | 结果 | 总耗时 |
| --- | --- | --- | --- |
| 第 1 次 | 2026-11-07 22:08 | 12 passed / 0 failed / 0 skipped | 4.3s |
| 第 2 次 | 2026-11-07 22:08 | 12 passed / 0 failed / 0 skipped | 4.2s |

两次命令均为：

```powershell
npx playwright test --project=worker tests/e2e/device.spec.ts
```

- **环境**：`http://127.0.0.1:8788` 上的真实 Worker（`wrangler dev --local`）+ 本地 D1；`.wrangler/e2e-fixtures.json` stage=`complete`（5 个 seed 账号、installer 第二台已登录设备、crowded 10 台设备）；Playwright `worker` project，`workers:1`、`retries:0`、chromium channel `chrome`；同一 spec 另由 `firefox-worker`（Firefox 157）与 `webkit-worker`（WebKit 27.2）project 各通过 12 项。
- **幂等性**：两次运行之间没有重启 e2e-server、没有清 D1；上一轮创建的 `qa-dp-*` 设备在下一轮 `beforeAll` 里通过公开 revoke API 撤销（撤销设备不计入 `MAX_DEVICES=10`）；1b 依赖的两条过期配对由 `beforeAll` 调用 e2e-server 的本地夹具端点 `POST /__e2e/reset-expired`（`127.0.0.1:8789`，只存在于该测试脚本）复位，没有依赖直接改业务表。
- **限流**：单轮 9 个 claim POST + 4 个 create POST。support 层给每个 Actor 注入每轮唯一、跨轮随机的 `cf-connecting-ip`（生产环境该头由 Cloudflare 覆写、客户端无法伪造），单个 Actor 单轮最多 8 个 claim POST，低于 `pairing-claim` 10/10min；`pairing-create` 4/12h。连续两轮未触顶。
- **修复记录**：worker 侧两处真实缺陷已在 3.3 修复并纳入回归——① `POST /api/pairing/claim` 缺同源校验 → 补 `assertSameOrigin`（E2E 断言缺 Origin → 403）；② `POST /api/continuity/:id/open` 响应 `openedAt` 恒为 `null` → 标记后重读（E2E 以 open 后的列表时间戳为准）。测试侧：1b 夹具会被 `createPairing` 顺带的 `expirePairings` 翻状态，改为 beforeAll 自动复位。③ 测试基础设施就绪竞态：Playwright 曾以 `/api/health` 判定 e2e-server 就绪，此时 `buildFixtures()` 可能仍在写本地 D1，测试与夹具写入抢锁曾致夹具生成失败、服务退出（`ECONNRESET`）；现以夹具管理端口 `GET /__e2e/ready` 就绪（只在夹具全部生成后监听）。
- **TTL 真实时间**：`npm run qa:pairing-ttl`（`scripts/pairing-ttl-check.mjs`）单独验证真实 10 分钟过期：自旋 e2e-server → 创建配对 → 匿名 claim → **真实 sleep 605 秒**（不修改任何时间戳）→ 过期后轮询 / confirm 均 410 `PAIRING_EXPIRED`、同码重领 404、设备快照不变；**实跑 12/12 通过，`elapsedMs=605004`**。该脚本不并入 12 项主套件，避免每次 CI 多等 10 分钟。
- **未验证项**：`PAIRING_ATTEMPTS_EXCEEDED`（已删除不可达分支）等见 7.5；没有把缺陷行为写成正向断言。

### 7.4 覆盖矩阵

| 场景 | 是否真实验证 | 方式 |
| --- | --- | --- |
| 两个真正独立的 Browser Context | ✅ | 六个 `browser.newContext()`；B/C 初始无 Cookie；B 的 `gauth_sid` 来自 Set-Cookie 且 ≠ A 的 token |
| 完整配对：A 建码 → B claim → A confirm → B 轮询 completed | ✅ | 设备出现在 A 的 `GET /api/devices`，`trusted:true`、`isCurrent:false`；B 用新 Session 访问 `/api/auth/me` |
| 批准语义 | ✅ | 未 claim 直接 confirm → 409；其他账号 confirm → 404；重复 confirm → 409；无 Origin → 403 CSRF_REJECTED |
| **WRONG_DEVICE（403）** | ✅ | A2（同账号第二台已登录设备）confirm A 发起的配对 → 403 WRONG_DEVICE，配对保持 claimed |
| **DEVICE_LIMIT（409）** | ✅ | crowded 账号已有 10 台未撤销设备，confirm 第 11 台 → 409 DEVICE_LIMIT；设备数仍为 10 |
| **已过期配对（真实过去时间戳）** | ✅ | pending 码 / token claim → 404 PAIRING_NOT_FOUND（与不存在合并文案）；claimed 轮询与 confirm → 410 PAIRING_EXPIRED；设备列表不变 |
| **INVALID_TOKEN / claim 同源** | ✅ | 129 字符 token → 400 INVALID_TOKEN；claim 缺 Origin → 403 CSRF_REJECTED（3.3 修复项） |
| 错误配对码 | ✅ | 6 位不存在码 → 404 PAIRING_NOT_FOUND（与过期合并文案） |
| 重复使用配对码 | ✅ | completed 后再 claim 同码 → 404 |
| 取消配对 | ✅ | cancelled 后轮询 → 410 PAIRING_CANCELLED；confirm → 409 |
| TTL 契约 | ✅ | 断言 `ttl === 600000`、`expiresAt ≈ now + 600000`；真实过期由 `npm run qa:pairing-ttl` 真实等待 10 分钟后验证（过期轮询/确认 410、重领 404、设备不变） |
| 接力 pending → delivered → opened → completed | ✅ | 收件箱领取、open、complete 后状态与时间戳；A 历史 outgoing/状态 |
| 非目标设备 / 未配对设备不能收接力 | ✅ | A open B 的条目 → 403 NOT_TARGET；未登录 Context → 401 |
| 接力错误码 | ✅ | SELF_TARGET / TARGET_NOT_FOUND / INVALID_TYPE / PAYLOAD_TOO_LARGE / 取消后 410 / NOT_CANCELLABLE |
| 剪贴板 A→B 定向投递 | ✅ | B 能看到、A 与 outsider 看不到；删除后 B 也看不到 |
| 剪贴板 4000 字符上限 | ✅ | 4001 字符 → 413 CONTENT_TOO_LONG；纯空白 → 400；外来设备 → 404 |
| 撤销后 B 的请求被拒 | ✅ | `/api/devices`、`/api/continuity/*`、`/api/clipboard`、`/api/pairing` 五条路径统一 → 401 `SESSION_REVOKED` / `DEVICE_REVOKED`（3.3 一致化，见偏差 4）；A 不受影响 |
| 撤销权限边界 | ✅ | outsider 撤 B → 404；撤销当前设备 → 400 CANNOT_REVOKE_CURRENT |

### 7.5 未覆盖 / 未验证（如实列出）

| 项 | 原因 |
| --- | --- |
| **真实等待 10 分钟 TTL** | 已由 `npm run qa:pairing-ttl` 覆盖（真实 `sleep`，`elapsedMs ≥ 600000`，过期轮询/确认 410、重领 404、设备快照不变）；不并入主套件，避免每次多等 10 分钟。 |
| **PAIRING_ATTEMPTS_EXCEEDED（429）** | 已按偏差 2 处理：删除不可达分支，测试不伪造一个不存在的保护。 |
| **INVALID_CLAIM（缺 id / secret 的 400）与 BROKEN_PAIRING** | 属于格式校验分支；3b 已覆盖 INVALID_TOKEN 与 claim 缺 Origin，其余未断言。 |
| **真实跨浏览器 / 真机矩阵** | Firefox 157 与 WebKit 27.2 已通过同一 spec 各 12 项（`--project=firefox-worker` / `--project=webkit-worker`）；真机 Safari / iOS 差异未验证（WebKit 引擎 ≠ 真机 Safari）。 |

### 7.6 限流与夹具复位说明

- 生产按 `cf-connecting-ip` 分桶；本地全部请求都来自 127.0.0.1，连续多轮会共用同一个计数桶。
- E2E 的 support 层给每个 Actor 注入一次运行内唯一、跨运行随机的 `cf-connecting-ip`（仅本地 `wrangler dev` 接受该头；生产由 Cloudflare 覆写，客户端无法伪造），让上一轮用掉的配额不影响这一轮，不改变限流阈值本身。
- 单轮用量：`pairing-claim` 9 次（单个 Actor 最多 8 次，限额 10/10 分钟）、`pairing-create` 4 次（限额 12/小时）。
- 过期配对夹具会被 `createPairing` 顺带的 `expirePairings` 翻转状态，`beforeAll` 调用 `POST http://127.0.0.1:8789/__e2e/reset-expired` 复位；该端点只存在于 `scripts/e2e-server.mjs`，只监听 127.0.0.1，不是 Worker 代码、不会进入生产构建。
- 如果绕过上述隔离、真的撞到 429：清 D1 `rate_limits` 表不足以恢复（Worker 进程内还有一层内存计数），需重启 e2e-server。
- `npm run qa:continuity` 现在自包含：`scripts/qa-local-run.mjs` 先跑本地迁移、写入固定 QA 账号/设备/Session（`scripts/seed-qa-local.mjs`，含 `qa-dev-laptop` / `qa-dev-phone` 两台同账号设备），再起 `wrangler dev --local`（默认 8794），跑完自动关进程；实测 **45/45 通过**。它只连 loopback，不需要先手工起服务。同一运行器也驱动 `npm run qa:plugins`（实测 **70/70**）与 `npm run qa:devices`（新增 `scripts/devices-api-qa.mjs`，实测 **31/31**：设备总览、当前设备、详情、会话列表、活动、心跳、CSRF、未登录 401、跨账号 404、会话撤销、设备撤销与总览计数）。

### 7.7 相关文件

- `tests/e2e/device.spec.ts` — 用例
- `tests/e2e/support/device-flow.ts` — 双 Context / HTTP / 业务流辅助
- `tests/e2e/support/worker-api.ts` — fixtures 等待、`as()` 等通用辅助
- `worker/api/pairing/handlers.js`、`worker/api/pairing/store.js` — 配对实现
- `worker/api/continuity/handlers.js`、`worker/api/continuity/store.js` — 接力 / 剪贴板实现
- `worker/api/devices/handlers.js`、`worker/api/devices/model.js` — 设备与 UA 画像
- `worker/api/guards.js`、`worker/api/ratelimit.js` — 同源校验、限流
- `migrations/0001_init.sql`、`0002_account.sql`、`0004_devices.sql`、`0011_continuity.sql` — 表结构
- `scripts/e2e-server.mjs` — 本地 E2E 服务、账号与过期配对夹具、`127.0.0.1:8789` 夹具复位端点
- `scripts/seed-qa-local.mjs`、`scripts/qa-local-run.mjs` — 自包含 QA 种子 + 本地 Worker 运行器（`npm run qa:continuity`）
- `scripts/pairing-ttl-check.mjs` — 真实等待 10 分钟 TTL 的验证脚本（`npm run qa:pairing-ttl`）
- `scripts/devices-api-qa.mjs` — 设备管理 API QA（`npm run qa:devices`，31 项，自包含）