# Guandao Cloud API 2.0 规范

> 权威实现：`worker/api/http.js`（信封）、`worker/api/router.js`（路由与限流）、
> `worker/api/*/handlers.js`（业务）。本文描述对外契约，不重复内部实现细节。

---

## 1. 通用约定

### 1.1 响应信封

成功：

```json
{ "success": true, "data": { } }
```

失败：

```json
{
  "success": false,
  "error": { "code": "PERMISSION_DENIED", "message": "没有权限执行该操作" },
  "requestId": "0f0a…"
}
```

- `code` 是稳定错误码，前端只按 `code` 分支，不解析 `message`；
- `message` 已脱敏，可直接展示给用户；
- 所有响应 `cache-control: no-store`，`content-type: application/json; charset=utf-8`；
- 响应头 `x-request-id`：同一次请求的日志关联 ID；
- 响应头 `x-guandao-version`：Worker 版本（2.0.0）。

### 1.2 认证

- 浏览器使用 HttpOnly Cookie `gauth_sid`（`SameSite=Lax`、`Secure`、30 天）；
- 设备归属 Cookie `gauth_device` 只在登录绑定设备时使用；
- Session 状态：`active` / `expired` / `revoked` / `device_revoked` / `pending_deletion` / `disabled`；
- 服务端只从 Session 取 `user_id`，**从不**接受客户端传入的 `user_id`。

### 1.3 CSRF

所有非 GET/HEAD 请求校验来源：

1. 有 `Origin` → 必须与站点 origin 完全一致；
2. 无 `Origin` → 看 `Sec-Fetch-Site`，只允许 `same-origin` / `none`；
3. 两者皆无（curl 等非浏览器客户端）→ 放行，但此类请求没有浏览器 Cookie，风险等价于未登录。

不一致返回 `403 CSRF_REJECTED`。

### 1.4 请求体

- 统一 `readJsonLimited(request, maxBytes)`：先看 `content-length`，再复核实际字节；
- 超过上限 → `413 PAYLOAD_TOO_LARGE`；非法 JSON → `400 INVALID_JSON`；空体 → `400 EMPTY_BODY`（按接口而定）。

### 1.5 分页

列表接口统一：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | 20 / 50（按接口） | 服务端有硬上限，超出按上限截断 |
| `cursor` / `before` / `after` | string | — | 游标或时间戳，按接口定义 |
| `offset` | number | 0 | 仅少量接口支持 |

响应里带 `nextCursor` 或 `hasMore`；**不要**假设固定页大小。

### 1.6 幂等

- 备份创建：`Idempotency-Key` 头（或 body `idempotencyKey`），窗口内重复请求返回同一任务；
- 恢复：`findRestoreByIdempotency`，重复提交返回既有恢复任务；
- 同步推送：以 `(user, domain, entity_id, baseRevision)` 做乐观锁，重复推送同一 baseRevision 会得到冲突而不是重复写入；
- 其他 POST 默认不幂等，客户端需自行防抖。

### 1.7 限流

| 规则 | 上限 | 窗口 |
| --- | --- | --- |
| `api-global` | 600 | 分钟 |
| `api-health` | 120 | 分钟 |
| 登录 / 初始化 / 设备 / 上传 / 导出 / 删除 | 5–60（按规则） | 分钟或小时 |
| `sync-pull` | 600 | 小时 |
| `sync-push` | 300 | 小时 |

超限返回 `429 RATE_LIMITED`，带 `retry-after`、`x-ratelimit-*`。

---

## 2. 错误码

共 180+ 个稳定错误码，按模块分组（完整清单见各 handler）：

| 分组 | 示例 | 典型状态码 |
| --- | --- | --- |
| 通用 | `INTERNAL_ERROR`、`INVALID_JSON`、`INVALID_BODY`、`PAYLOAD_TOO_LARGE`、`METHOD_NOT_ALLOWED`、`NOT_FOUND` | 400/404/405/413/500 |
| 认证 | `UNAUTHENTICATED`、`SESSION_EXPIRED`、`SESSION_REVOKED`、`REAUTH_REQUIRED`、`ACCOUNT_PENDING_DELETION` | 401/403 |
| 授权 | `PERMISSION_DENIED`、`FORBIDDEN`、`CSRF_REJECTED`、`SCOPE_REQUIRED` 类 | 403 |
| 限流 | `RATE_LIMITED`、`QUOTA_EXCEEDED`、`DEVICE_LIMIT`、`INSTALL_LIMIT` | 429 |
| 文件 | `FILE_TOO_LARGE`、`FILE_NOT_READY`、`FOLDER_NOT_EMPTY`、`INVALID_PATH`、`UPLOAD_FAILED` | 400/409/413 |
| 备份 | `BACKUP_BROKEN`、`BACKUP_TAMPERED`、`BACKUP_CORRUPTED`、`BACKUP_NOT_VERIFIED`、`PROTECTIVE_BACKUP_REQUIRED`、`PROTECTIVE_BACKUP_STALE` | 409 |
| 设备 | `DEVICE_REVOKED`、`SESSION_REVOKED`、`WRONG_DEVICE`、`DEVICE_LIMIT`、`PAIRING_EXPIRED`、`PAIRING_CANCELLED` | 401/403/409/410 |
| 社区 | `POST_QUOTA_EXCEEDED`、`COMMENT_BLOCKED`、`SELF_REVIEW`、`NOT_PUBLISHED`、`VERSION_NOT_NEWER` | 400/403/409 |
| 插件 | `PLUGIN_BLOCKED`、`PLUGIN_DISABLED`、`PACKAGE_INTEGRITY_ERROR`、`MANIFEST_INCOMPLETE`、`PERMISSION_NOT_DECLARED`、`DOMAIN_NOT_ALLOWED`、`REDIRECT_BLOCKED` | 400/403/409/502 |
| 同步 | `UNKNOWN_DOMAIN`、`INVALID_CHANGE`、`BATCH_TOO_LARGE`、`EMPTY_BATCH`、`TOO_MANY_IDS` | 400 |

状态码语义：`400` 参数问题、`401` 未登录/失效、`403` 已登录但无权、`404` 不存在或无权可见、
`409` 状态冲突（可重试或需用户决策）、`413` 超大、`429` 限流、`500` 服务端错误、`502` 上游失败、`503` 降级。

---

## 3. 端点索引

### 3.1 健康

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET/HEAD | `/api/health` | 否 | D1 `SELECT 1` + R2 只读 head；`200` 健康 / `503` 降级。限流 120/分钟 |

### 3.2 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/status` | 是否已初始化、是否可登录 |
| GET | `/api/auth/github` | 发起 OAuth（state + PKCE） |
| GET | `/api/auth/github/callback` | 回调，签发 Session |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/logout` | 撤销当前 Session |
| POST | `/api/auth/initialize` | 首个管理员初始化（密钥 ≥24 字符；全局 10 次/小时） |
| PATCH | `/api/auth/profile` | 修改显示名称 |
| GET | `/api/auth/devices` | 当前账号的 Session 列表 |

### 3.3 文件（R2 + D1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files` | 列表（分页、排序、过滤） |
| GET | `/api/files/quota` | 配额与用量 |
| GET | `/api/files/recent`、`favorites` | 最近 / 收藏 |
| POST | `/api/files/upload` | 预签名或直传（按实现） |
| GET | `/api/files/:id`、`/download` | 元数据 / 授权下载 |
| PATCH | `/api/files/:id` | 重命名、移动、收藏 |
| DELETE | `/api/files/:id` | 进回收站 |
| POST | `/api/files/trash/empty` | 清空回收站 |
| GET/POST | `/api/files/folders*` | 文件夹树、创建、移动 |

### 3.4 设备 / 配对 / 接力

| 前缀 | 能力 |
| --- | --- |
| `/api/devices/*` | 设备列表、重命名、信任、撤销、心跳、同步报告 |
| `/api/pairing/*` | 6 位码创建/领取/批准/取消（10 分钟 TTL） |
| `/api/continuity/*` | 接力与剪贴板（pending → delivered → opened → completed） |

### 3.5 备份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/backups` | 创建（幂等键） |
| GET | `/api/backups` | 列表 |
| GET | `/api/backups/:id` | 详情（含校验状态） |
| GET | `/api/backups/:id/download?format=json\|zip` | 下载前复核 SHA-256，损坏返回 `409 BACKUP_CORRUPTED` |
| POST | `/api/backups/:id/restore` | 恢复（replace / merge / copy） |
| POST | `/api/backups/:id/verify` | 重新校验 |
| DELETE | `/api/backups/:id` | 删除历史备份 |

### 3.6 隐私与安全

| 前缀 | 能力 |
| --- | --- |
| `/api/privacy/export*` | 数据导出（创建、状态、下载、取消） |
| `/api/privacy/delete*` | 账号删除（预检、启动、状态、取消） |
| `/api/privacy/audit` | 安全事件列表 |
| `/api/privacy/settings` | 隐私开关 |

### 3.7 社区

| 前缀 | 能力 |
| --- | --- |
| `/api/community/*` | 作品、详情、点赞、评论、收藏、关注、举报 |
| `/api/community/admin/*` | 审核队列、举报处理、下架（管理员） |

### 3.8 插件 / 开发者

| 前缀 | 能力 |
| --- | --- |
| `/api/plugins/*` | 市场列表、详情、安装记录、权限授予、`report`、`security`（2.0） |
| `/api/developer/*` | 草稿、上传版本、提交审核、发布记录、统计 |
| `/api/plugins/net` | 插件网络代理（域名白名单 + 审计） |

### 3.9 同步（2.0 新增）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sync/status` | 每个域的条目数、墓碑数、最后更新时间 |
| GET | `/api/sync/index?domain=` | 全量索引（id / revision / deleted / updatedAt），上限 10000 条 |
| GET | `/api/sync/pull?domain=&since=` | 增量拉取（含 payload），`since` 毫秒时间戳 |
| GET | `/api/sync/pull?domain=&ids=a,b` | 按 id 拉取，单次 ≤200 |
| POST | `/api/sync/push` | 推送变更（见下） |

`push` 请求：

```json
{
  "domain": "notes",
  "changes": [
    { "id": "n1", "baseRevision": 2, "updatedAt": 1793871389080, "payload": { "title": "…" } },
    { "id": "n2", "baseRevision": 0, "deleted": true, "updatedAt": 1793871389080 }
  ]
}
```

响应：

```json
{
  "success": true,
  "data": {
    "applied": [{ "id": "n1", "revision": 3, "updatedAt": 1793871389081 }],
    "conflicts": [{ "id": "n2", "revision": 5, "deleted": false, "updatedAt": 1793871389000, "payload": { "title": "服务端版本" } }],
    "serverTime": 1793871389082
  }
}
```

规则：

- `baseRevision` 小于库内 revision → 冲突，**不覆盖**，返回服务端实体；
- 删除是墓碑（`deleted: true`），不物理删除，避免另一端复活；
- 单次 ≤100 条、单条 payload ≤128 KB、整包 ≤768 KB；
- 未知域、非法 id（非 `[A-Za-z0-9._:-]{1,128}`）直接 400。

---

## 4. 版本与兼容

- Worker 版本、响应头、`/api/health` 的 `version` 三处一致，由 `scripts/check-version.mjs` 在 CI 强制；
- 新增字段向后兼容；删除字段或改变语义必须提升主版本并在 `docs/RELEASE-*.md` 标注；
- 旧客户端超过两个次版本未升级时，服务端仍返回兼容结构，不做静默降级。

---

## 5. 客户端调用约定

- 统一 `credentials: "same-origin"`；
- 只按 `code` 分支处理错误，展示 `message`；
- 网络错误与 HTTP 错误分开：`fetch` 抛错 = 离线/被拦截，`success: false` = 服务端明确拒绝；
- 同步、备份、导出等长任务一律轮询任务状态，不假设一次请求完成；
- 所有列表按 `hasMore` / `nextCursor` 翻页，不假设总数。