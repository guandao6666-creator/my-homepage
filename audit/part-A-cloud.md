# Guandao OS 2.0 · 云端后端审计（Part A）

审计对象：`worker/`、`migrations/0001..0012`、`wrangler.jsonc`、`.dev.vars.example`、6 个前端数据访问入口。
方法：逐文件阅读源码；所有结论以 `文件:行号` 为据；未读到的配置/控制台状态标为“无法确认”。
代码版本：`package.json` 1.9.0 / `worker/api/version.js:9` 1.9.0（两侧一致）。

## 1. 真实 API 清单（表格）

路由入口：`worker/index.js:111` → `worker/api/router.js:54`；限流在业务分发之前执行（`router.js:63-81`），`/api/health` 被显式豁免（`router.js:64`）。
除特别注明外，未命中专用规则的接口一律落“全局 600 次/分钟·IP”（`worker/api/ratelimit.js:18-23`）。

| 路径 | 方法 | 认证 | CSRF/同源 | 限流 | 实际行为（一句话） |
| --- | --- | --- | --- | --- | --- |
| `/api/health` | GET, HEAD | 无 | — | **无**（显式跳过） | 真实执行 `SELECT 1` + R2 `head` 探测，返回版本、binding 能力与延迟（`health.js:27-47`） |
| `/api/auth/status` | GET | 无 | — | 600/min | 返回 OAuth 是否配置、是否已有管理员、`setupAvailable`、社区注册摘要（`auth/handlers.js:106`） |
| `/api/auth/github` | GET | 无 | —（302 跳转） | 20/min | 生成 PKCE S256 + state，302 到 GitHub；state 哈希入 D1（`auth/handlers.js:124-198`） |
| `/api/auth/github/callback` | GET | state Cookie + D1 未消费 state + PKCE | 由 state/PKCE 承担 | 40/min | 换 token、读 GitHub 用户、发 Session；无管理员时改发 setup 票据（`auth/handlers.js:204-427`） |
| `/api/auth/me` | GET | 可匿名 | — | 600/min | 返回 `authenticated`/`user`/`session`；过期/撤销时下发清 Cookie（`auth/handlers.js:522-555`） |
| `/api/auth/logout` | POST | 会话（可无） | Origin + Sec-Fetch-Site | 600/min | 无条件撤销当前 token 对应 session 并清 Cookie（`auth/handlers.js:561-583`） |
| `/api/auth/initialize` | POST | setup Cookie + 初始化密钥 | Origin + Sec-Fetch-Site | 5 次/10 分钟 | 建首个 admin；`countAdmins()===0` 时任何 GitHub 账号都能先拿到 setup 票据（`auth/handlers.js:433-516`） |
| `/api/auth/profile` | PATCH | 会话 | Origin | 600/min | 改 `display_name`（≤60，过滤 C0 控制字符）（`auth/handlers.js:589-608`） |
| `/api/auth/devices` | GET | 会话 | — | 600/min | 弃用别名，转发 `/api/devices` 并加 `deprecation` 头（`auth/handlers.js:614-626`） |
| `/api/files` | GET | 会话 | — | 600/min | 列表；view/search/sort/limit（limit 夹在 1..200）（`files/handlers.js:208`、`files/store.js:88`） |
| `/api/files/quota` | GET | 会话 | — | 600/min | 配额与分类计数（`files/handlers.js:259`） |
| `/api/files/recent`、`/favorites` | GET | 会话 | — | 600/min | 最近 24 条 / 收藏（`files/handlers.js:67-78`） |
| `/api/files/folders` | GET, POST | 会话 | POST 同源 | 600/min | 列目录 / 新建；父目录必须属于本人且未删（`files/handlers.js:81-95`） |
| `/api/files/folders/{id}` | PATCH, DELETE | 会话 | 同源 | 600/min | 改名/移动（用祖先链防成环）/软删；非 recursive 且非空返回 409（`files/handlers.js:106-134`） |
| `/api/files/folders/{id}/restore`、`/permanent` | POST, DELETE | 会话 | 同源 | 600/min | 整组恢复 / 永久删除（先删 R2 再删 D1）（`files/handlers.js:440-502`） |
| `/api/files/upload` | POST | 会话 | 同源 | 60 次/10 分钟 | 必填 Content-Length（≤25 MiB）、魔数校验，对象键 `users/{uid}/files/{uuid}`（`files/handlers.js:280-341`） |
| `/api/files/{id}` | GET, PATCH, DELETE | 会话 | 写同源 | 600/min | 元数据 / 改名移动 / 移入回收站（`files/handlers.js:144-177`） |
| `/api/files/{id}/content`、`/download` | GET | 会话 | — | 120 次/10 分钟 | 先按 `user_id` 查行，再由服务端读 R2；inline 白名单 + attachment（`files/handlers.js:347-377`） |
| `/api/files/{id}/restore`、`/permanent` | POST, DELETE | 会话 | 同源 | 600/min | 回收站恢复 / 永久删（`files/handlers.js:383-399`） |
| `/api/files/trash/empty` | POST | 会话 | 同源 | 600/min | 分批删 R2 后删该用户全部 trash 行（`files/handlers.js:538-555`） |
| `/api/devices` | GET | 会话 | — | 600/min | 设备/会话/云盘统计/新设备告警总览（`devices/handlers.js:161-239`） |
| `/api/devices/register` | POST | 会话 | 同源 | 600/min | 写 `last_seen/active`，返回设备与本人 session（`devices/handlers.js:291-315`） |
| `/api/devices/current` | GET | 会话 | — | 600/min | 当前设备详情（`devices/handlers.js:241-260`） |
| `/api/devices/heartbeat` | POST | 会话 | 同源 | 600/min | 60 秒节流写库，返回 presence 与待同步域（`devices/store.js:130-153`） |
| `/api/devices/revoke-others` | POST | 会话 | 同源 | 600/min | 撤销除当前外的全部 session（`devices/handlers.js:578-597`） |
| `/api/devices/revoke-all` | POST | 会话 | 同源 | 600/min | 需 `confirm:"REVOKE ALL"`，可保留当前（`devices/handlers.js:599-640`） |
| `/api/devices/sync-report` | POST | 会话 | 同源 | 600/min | 仅记录客户端自报的 pending/conflicts；local 域直接 409（`devices/handlers.js:429-476`） |
| `/api/devices/activity`、`/sessions` | GET | 会话 | — | 600/min | 账号级活动 / 最新 100 条 session（`devices/handlers.js:95-106`） |
| `/api/devices/sessions/{sid}/revoke` | POST | 会话 | 同源 | 600/min | 撤销指定 session（先 `WHERE user_id=?` 校验）（`devices/handlers.js:548-576`） |
| `/api/devices/{id}` | GET, PATCH | 会话 | PATCH 同源 | 600/min | 详情 / 改名改类型（`WHERE id=? AND user_id=?`）（`devices/store.js:31-44`） |
| `/api/devices/{id}/sessions`、`/activity` | GET | 会话 | — | 600/min | 设备级会话 / 活动（`devices/handlers.js:130-151`） |
| `/api/devices/{id}/revoke`、`/trust`、`/sync-request` | POST | 会话 | 同源 | 600/min | 撤销该设备全部会话 / 标记可信 / 排队同步请求（`devices/handlers.js:512-546`、`478-506`） |
| `/api/pairing/create` | POST | 会话 + 已绑定设备 | 同源 | 12 次/小时 | 生成 6 位码 + 24 字节 token（只存哈希），返回二维码 URL（`pairing/handlers.js:47-69`） |
| `/api/pairing` | GET | 会话 | — | 600/min | 列出 pending/claimed/confirmed 配对（`pairing/handlers.js:72-81`） |
| `/api/pairing/claim` | POST | **无** | — | 10 次/10 分钟 | 凭 6 位码或 token 认领，返回一次性 `claimSecret`（`pairing/handlers.js:84-119`） |
| `/api/pairing/claim/{id}?secret=` | GET | claimSecret | — | 600/min | 轮询；confirmed 时签发新 Session 并 Set-Cookie（`pairing/handlers.js:122-198`） |
| `/api/pairing/{id}/confirm`、`/cancel` | POST | 会话 + 源设备 | 同源 | 600/min | 源设备确认后建 devices 行（≤10 台）/ 取消（`pairing/handlers.js:201-262`） |
| `/api/push/status` | GET | 会话 | — | 600/min | 恒返回 `enabled:false`（未实现推送）（`continuity/handlers.js:40-52`） |
| `/api/clipboard` | GET | 会话 | — | 600/min | 24h 内、目标为本机或广播的剪贴板（`continuity/handlers.js:61-72`） |
| `/api/clipboard/send` | POST | 会话 | 同源 | 60 次/10 分钟 | ≤4000 字符，目标设备须属本人（`continuity/handlers.js:74-94`） |
| `/api/clipboard/{id}` | DELETE | 会话 | 同源 | 600/min | 软删（`WHERE id=? AND user_id=?`）（`continuity/store.js:279-286`） |
| `/api/continuity/send` | POST | 会话 + 设备 | 同源 | 120 次/10 分钟 | 快照 payload ≤32 KB，TTL 夹在 1h..7d（`continuity/handlers.js:117-170`） |
| `/api/continuity/inbox` | GET | 会话 + 设备 | — | 600/min | 把 pending 更新为 delivered 并绑定目标设备（`continuity/store.js:85-106`） |
| `/api/continuity/history` | GET | 会话 | — | 600/min | 本人接力记录 60 条（`continuity/store.js:108-115`） |
| `/api/continuity/context` | GET, PUT/POST | 会话 + 设备 | 写同源 | 600/min | 设备级“当前应用/资源/滚动位置”（`continuity/store.js:211-241`） |
| `/api/continuity/{id}/open`、`/complete`、`/cancel` | POST | 会话 + 设备 | 同源 | 600/min | 状态推进；目标设备不符 403（`continuity/store.js:123-176`） |
| `/api/backups` | GET, POST | 会话 | POST 同源 | 建 20/h，列表 600/min | 列表（附 settings/storage/cron）/ 建快照（≤60 份；账号总量校验）（`backups/handlers.js:223-343`） |
| `/api/backups/settings` | GET, PUT | 会话 | 同源 | 600/min | 自动备份频率与保留数（`backups/handlers.js:1320-1343`） |
| `/api/backups/storage` | GET | 会话 | — | 600/min | 备份/实时/回收站用量（`backups/store.js:541-592`） |
| `/api/backups/restores` | GET | 会话 | — | 600/min | 恢复记录（`backups/store.js:517-535`） |
| `/api/backups/restores/{id}/run`、`/ack` | POST | 会话 | 同源 | 240/h | 分批复制恢复文件 / 客户端回执（`backups/handlers.js:119-127`、`1255-1269`） |
| `/api/backups/{id}` | GET, PATCH, DELETE | 会话 | 同源 | 600/min | 详情/改名/删除（删除需 `confirm:"DELETE"`）（`backups/handlers.js:747-773`） |
| `/api/backups/{id}/progress` | GET | 会话 | — | 600/min | 备份 + job 进度（`backups/handlers.js:142-145`） |
| `/api/backups/{id}/run` | POST | 会话 | 同源 | 400/h | 每轮最多复制 5 个文件或 18 秒（`backups/handlers.js:397-499`） |
| `/api/backups/{id}/verify` | POST | 会话 | 同源 | 400/h | 逐文件重算 SHA-256（`backups/handlers.js:661-741`） |
| `/api/backups/{id}/download`、`/export` | GET | 会话 | — | 60 次/10 分钟 | 下载 JSON/ZIP 或导出单域（`backups/handlers.js:775-869`） |
| `/api/backups/{id}/restore/preview`、`/restore` | POST | 会话 | 同源 | preview 240/h、restore 20/h | 需 1 小时内且覆盖同域的 protective 备份（`backups/handlers.js:939-1005`） |
| `/api/privacy/overview`、`/api/security/overview` | GET | 会话（含 pending_deletion） | — | 600/min | 安全评分 + 清单；会向自身 origin 发 2 次内部请求（`privacy/handlers.js:212-417`、`490-501`） |
| `/api/privacy/data-inventory` | GET | 会话 | — | 600/min | 各类数据计数（含 0001 遗留 `notes` 表）（`privacy/store.js:65-155`） |
| `/api/privacy/settings` | GET, PUT | 会话 | 同源 | 600/min | `cloudSync` + 五类本地域开关（`privacy/handlers.js:128-134`、`503-524`） |
| `/api/privacy/exports` | GET | 会话 | — | 600/min | 导出历史（`privacy/store.js:261-268`） |
| `/api/privacy/export` | POST | 会话 | 同源 | 6 次/小时 | 建 `data.json`（本地快照 ≤8 MB）（`privacy/handlers.js:530-579`） |
| `/api/privacy/export/{id}` | GET | 会话 | — | 600/min | 导出状态（`privacy/handlers.js:145-152`） |
| `/api/privacy/export/{id}/run` | POST | 会话 | 同源 | 400/h | 分批把实时文件复制到 exports 前缀（`privacy/handlers.js:720-847`） |
| `/api/privacy/export/{id}/download` | GET | 会话 | — | 60 次/10 分钟 | JSON/ZIP，7 天过期（`privacy/handlers.js:865-914`） |
| `/api/privacy/delete-data` | POST | 会话 | 同源 | 10 次/小时 | 需 `confirm:"DELETE"`，分批删文件/备份/导出（`privacy/handlers.js:920-960`） |
| `/api/privacy/deletion`、`/deletion/{id}` | GET | 会话 | — | 600/min | 删除任务列表/详情（`privacy/handlers.js:166-190`） |
| `/api/privacy/deletion/{id}/run` | POST | 会话 | 同源 | 400/h | 推进任务；account 类型走注销流（`privacy/handlers.js:172-185`） |
| `/api/privacy/delete-account` | POST | 会话 + reauth 票据 | 同源 | 3 次/小时 | 需 GitHub 重新验证；但代码只允许 `role==="admin"`（`auth/handlers.js:298-300`） |
| `/api/privacy/local-clear` | POST | 会话 | 同源 | 600/min | 只记一条安全事件，不删云端数据（`privacy/handlers.js:196-203`） |
| `/api/security/activity` | GET | 会话 | — | 600/min | 安全事件分页（limit ≤100）（`privacy/store.js:157-207`） |
| `/api/security/sessions`、`/sessions/{sid}/revoke` | GET, POST | 会话 | 写同源 | 600/min | 分别转发 `/api/devices/sessions` 与 `/api/devices/sessions/{id}/revoke`（`privacy/handlers.js:102-113`） |
| `/api/community/*` | 多方法 | 视路径 | 写同源 | 多条规则 | 社区后端；**本次未逐条审计**（代码在 `community/`，约 4.6k 行） |
| `/api/plugins/*`、`/api/developer/*` | 多方法 | 视路径 | 写同源 | 多条规则 | 插件市场与开发者中心；含白名单 SSRF 代理 `/api/plugins/net`（`plugins/handlers.js:1145-1235`），**本次未逐条审计** |

补充：`HEAD` 只有 `/api/health`（`router.js:38`）与社区媒体（`community/handlers.js:637`）真正实现；其他 `/api/*` 的 HEAD 因各 handler 只匹配 `GET` 而落 404（未登录时先 401），`router.js:140-143` 的“HEAD 去 body”分支只对 `ROUTES` 表里的 8 条路由生效。

## 2. 功能状态（表格）

| 功能 | 状态 | 证据 file:line | 一句话说明 |
| --- | --- | --- | --- |
| GitHub OAuth 登录（PKCE + state） | Implemented | `auth/handlers.js:204-426`、`auth/github.js:25-49` | token 只在内存用一次，不落库；state 与 verifier 只存哈希/短期行 |
| 首次管理员初始化 | Implemented | `auth/handlers.js:433-516` | setup 票据 + 密钥双条件；并发由 `idx_users_single_admin` 兜底（`migrations/0002:27-29`） |
| Session 签发与校验 | Implemented | `auth/session.js:29-138`、`auth/store.js:186-199` | Cookie 存原始 token，D1 存 SHA-256；JOIN 校验用户/设备撤销状态 |
| Session 滑动续期 | Not Implemented | `auth/session.js:123-125` | 只更新 `last_used_at`，过期时间固定 30 天（`auth/store.js:5`） |
| 注销 / 单设备撤销 / 全端撤销 | Implemented | `devices/store.js:87-128` | 撤销写 `revoked_at`，保留记录供审计 |
| CSRF 防护 | Implemented | `auth/handlers.js:70-83`、`community/common.js:16-26` | 仅 `Origin` 精确匹配或 `Sec-Fetch-Site: same-origin`，无 token |
| 请求限流 | Partially Implemented | `ratelimit.js:29-296`、`338-430` | 32 条规则（含 1 条重复）、按 IP 固定窗口；`/sb`、`/api/health` 无限流 |
| 安全事件审计 | Implemented | `privacy/events.js:8-82` | 事件类型与 metadata 双重白名单，写入失败不阻断业务 |
| 云盘上传/列表/回收站 | Implemented | `files/handlers.js:280-555` | 25 MiB 上限、5 GiB 默认配额、魔数校验 |
| 文件版本 / 冲突检测 | Not Implemented | `migrations/0003:9-18` | `files` 只有 `updated_at`，无 revision/etag 语义的并发控制 |
| 文件下载授权 | Implemented | `files/handlers.js:181-189`、`347-357` | 先 `WHERE id=? AND user_id=?` 取行，再由服务端读 R2 key |
| 设备管理与撤销 | Implemented | `devices/handlers.js:48-155` | 设备 ID 来自 Cookie，URL 里的设备 ID 必须同时匹配 user_id |
| 设备心跳 / 在线状态 | Implemented | `devices/model.js:210-218`、`devices/store.js:130-153` | 5 分钟在线窗口、60 秒写库节流 |
| 设备配对 | Partially Implemented | `pairing/handlers.js:84-198` | 主流程可用，但 claim 只凭 6 位码、后认领覆盖前认领 |
| 跨设备接力 | Implemented | `continuity/handlers.js:117-190` | 内容快照 + 一次性投递，非同步引擎 |
| 跨设备剪贴板 | Implemented | `continuity/handlers.js:55-103` | 24h 过期、4000 字符上限、可删 |
| Web Push | Not Implemented | `continuity/handlers.js:44-51` | 接口自述 “1.8 未部署推送发送服务”，恒 `enabled:false` |
| 统一同步引擎（增量/冲突/删除同步） | Not Implemented | `migrations/0001:82-97`；全仓无 `sync_changes` 读写 | 表和两个索引建了，代码零引用（`grep` 仅命中 migrations 与 README） |
| Notes/Tasks/Calendar 云同步 | Not Implemented | `devices/handlers.js:434-443` | 服务端主动 409 “尚未接入云同步”；数据只在浏览器 localStorage |
| 同步状态上报 | Implemented（仅状态） | `devices/handlers.js:429-476`、`devices/store.js:163-230` | 存客户端自报的 pending/conflicts，不代表任何真实数据同步 |
| 全量备份（文件 + 本地快照） | Implemented | `backups/handlers.js:397-573` | 每次全量复制 R2 对象并生成 manifest |
| 备份完整性校验 | Implemented | `backups/handlers.js:575-741` | data.json 与逐文件 SHA-256 复核后才置 completed |
| 恢复（copy/merge/replace） | Partially Implemented | `backups/handlers.js:1007-1036` | 服务端 merge 与 copy 行为相同（都换新 UUID）；merge 只存在于前端本地域 |
| 自动备份 Cron | Implemented | `wrangler.jsonc:10-12`、`backups/handlers.js:1359-1466` | 触发器 `*/15 * * * *` 真实注册；`BACKUP_CRON_ENABLED=true` 时按 24h/7d 到期判断 |
| 保留策略（自动备份轮转） | Implemented | `backups/handlers.js:1468-1489` | 仅对 `backup_type='auto'` 且已完成的备份生效 |
| 数据导出 | Implemented | `privacy/handlers.js:530-914` | 结构化 JSON + 分批复制文件 + manifest/checksum，7 天 TTL |
| 云端数据删除 | Implemented | `privacy/handlers.js:920-1121` | 分批、可重入、失败保留 `pending_delete` |
| 账号注销 | Partially Implemented | `auth/handlers.js:298-300`、`privacy/handlers.js:1127-1324` | 普通 member 拿不到 reauth 票据，等于无法注销（见隐患 #2） |
| 隐私开关 | Partially Implemented | `privacy/store.js:6-59`、`backups/handlers.js:232-248` | 只在“创建备份”时被检查；没有任何同步路径可被它约束 |
| 健康检查 | Implemented | `health.js:27-130` | 真的做 D1/R2 IO，不是假探活 |
| `/sb` Supabase 反代 | Deprecated（仍在用） | `worker/index.js:115-161`、`src/pages/index.astro:80-83` | 生产首页仍走它读 Supabase；代理删除 cookie/authorization，也不限流 |
| 旧版 Supabase 前端云栈 | Deprecated（仍在用） | `src/lib/cloud.ts:48-64`、`159-181` | access/refresh token 存 localStorage；与 D1/R2 栈完全平行 |
| 大数据量备份（>5000 文件） | Broken | `backups/store.js:322-324`、`backups/handlers.js:501-508` | 条目读取硬上限 5000，超出必然 `MANIFEST_INCOMPLETE` 失败 |
| 多租户数据隔离 | Implemented | `files/store.js:120-126`、`devices/store.js:31-44`、`backups/store.js:41-47` | 抽样核对的所有用户数据查询都带 `user_id` |
| R2 私有性自检 | Partially Implemented | `privacy/handlers.js:426-488` | `R2_PUBLIC_BASE_URL` 为空（`wrangler.jsonc:17`）时永远显示 Unknown |

### 2.1 Session 体系

- **Cookie 属性**：`gauth_sid`，`Path=/; SameSite=Lax; HttpOnly`，`Secure` 仅在 `origin.startsWith("https://")` 时加；无 `__Host-` 前缀（`auth/cookies.js:43-56`）。设备 Cookie `gauth_did` 365 天、同样 HttpOnly（`cookies.js:66-72`）。
- **过期**：30 天固定窗口（`auth/store.js:5`、`createSessionRow` 写 `expires_at`），`inspectSession` 过期即删行（`auth/session.js:100-103`）。没有空闲超时、没有滑动续期。
- **刷新**：不存在 refresh token；`last_used_at` 每 5 分钟最多写一次（`auth/session.js:123-125`）。重新登录即新 token，旧 session 不自动作废（多设备设计使然）。
- **撤销**：logout（`auth/handlers.js:565-578`）、单 session（`devices/store.js:101-109`）、按设备（`:87-99`）、除当前外（`:111-119`）、全部（`:121-128`）五条路径齐全，均写 `revoked_at` 而非删行。
- **多设备**：设备与 session 分离；`listSessionRows` 上限 100（`devices/store.js:58-70`）；`bindDeviceOnLogin` 只在 Cookie 中设备 ID 属于本人且未撤销时复用（`devices/model.js:105-138`）。
- **CSRF 校验方式**：无 CSRF token，纯 `Origin` 精确比较 + `Sec-Fetch-Site` 兜底（7 份重复实现，见技术债）。所有写操作（POST/PATCH/PUT/DELETE）在各自 handler 入口统一调用；读接口不校验。
- **可能的绕过路径**：
  1. `/api/health` 无认证**且**跳过限流（`router.js:64`、`health.js:27`），每次触发 1 次 D1 + 1 次 R2 IO。
  2. `HEAD` 不是绕过：子路由只认 `GET`，HEAD 一律 404；`community/handlers.js:637` 的 HEAD 只回媒体头。
  3. 方法白名单在 `ROUTES` 表内有效（`router.js:129-135`），但子路由各写一套 `if (method === ...)`，无统一 405；未知方法落 404。
  4. GET 存在副作用：`/api/continuity/inbox` 会把 pending 改为 delivered（`continuity/store.js:86-94`），可被跨站顶层导航触发（SameSite=Lax 允许），影响仅限本人数据。
  5. `assertSameOrigin` 在 `Origin` 缺失时接受 `Sec-Fetch-Site: same-origin`；非浏览器客户端两者皆无 → 403，属“默认拒绝”，不是绕过。

### 2.2 用户数据隔离与 R2 授权

- 抽样核对了 files / devices / pairing / continuity / backups / privacy 的全部 SQL（约 200 处 `DB.prepare`）：用户数据查询均带 `user_id`；`UPDATE` 的动态列来自固定白名单，`IN (...)` 的占位符由数组长度生成，**未发现 SQL 注入**（证据：`ratelimit.js:378-384`、`files/store.js:91-97`、`backups/store.js:118-122`、`plugins/store.js:316-322`）。
- 未发现 IDOR：所有从 URL 取 ID 的路径都先按 `id + user_id` 查行再操作（`files/store.js:120-126`、`devices/store.js:31-44`、`backups/store.js:41-47`、`continuity/store.js:117-121`、`pairing/handlers.js:206-209`、`devices/handlers.js:558-562`）。
- **R2 key 可预测**：`users/{userId}/files/{fileId}`（`files/handlers.js:314`）、`users/{uid}/backups/{bid}/…`（`archive.js:17-25`）、`users/{uid}/exports/{eid}/…`（`privacy/handlers.js:543`）。UUIDv4 不可枚举；`userId` 只在 `/api/auth/me` 里对本人可见。
- **下载服务端授权**：是。两处都先查 D1 行，再用行里的 `r2_key` 读对象（`files/handlers.js:145-189`、`community/handlers.js:584-622`）。**未发现路径穿越**：对象键全部由服务端生成，文件名经 `sanitizeName` 去掉分隔符（`files/util.js:11-21`），ZIP 条目名也做了替换（`backups/handlers.js:815`）。
- **残留风险**：若 R2 桶在控制台被开成公开，键格式足以让拿到 `userId + fileId` 的人直读对象；仓库无法证明桶是私有的（见第 6 节）。

### 2.3 Cloud Sync：仓库里没有同步引擎

结论：**不存在**统一同步引擎，也没有 pull/push 协议；只有“状态上报 + 单次备份/恢复”。

1. `migrations/0001:82-97` 建了 `sync_changes`（含 `seq` 自增与两个索引），**全仓无任何 INSERT/SELECT**；`README.md:706` 也自认“表存在但从未写入”。
2. 设备同步接口只写状态表：`devices/handlers.js:429-476` → `devices/store.js:163-230`（`device_sync_state` 的 upsert），值全部来自客户端 body，服务端只做 clamp（`:446-448`）。
3. 服务端明确拒绝本地域同步：`devices/handlers.js:434-443` 返回 409「该数据类型目前仍保存在浏览器本地，尚未接入云同步」。
4. 前端“同步”实现是查一次配额：`src/lib/devices/client.ts:382-397` 的 `runQueuedSync` 只 `GET /api/files/quota`，成功就 `reportDriveSync({result:"success"})`。
5. 展示层硬编码：`devices/model.js:271` 无条件 `mode:"cloud"`；`overviewHandler` 里 `cloudSynced: true`（`devices/handlers.js:234`）。
6. 备份也不是增量：`backups/handlers.js:447-475` 每次遍历全部文件复制；`source_cursor` 列（`0006:31`）只被读取（`store.js:159`）、从未写入。
7. 没有 `/api/sync` 路由：`router.js:98-123` 的分发列表与各子路由中均无此路径。

### 2.4 Backup：完整性、可恢复性、Cron

- **完整性**：是。manifest 与 data.json 都记 SHA-256（`archive.js:77-85`、`189-241`）；`completed` 前逐文件复核（`handlers.js:575-639`）；恢复前再验 manifest 摘要与 data.json（`:1278-1302`），因此“校验后被篡改”会被拒（`BACKUP_TAMPERED`）。
- **历史版本**：有，但是“多份完整快照”，无增量链；上限 60 份 + 512 MiB/份 + 账号总量 4×512 MiB（`backups/store.js:9-11`、`handlers.js:262-280`）。
- **失败重试**：有断点。失败只重置状态、已复制对象与 `backup_items` 保留（`handlers.js:429-432`、`442-475`）；verify 有 `checkpoint.verifyIndex`（`:592-616`）。
- **不可恢复场景**：①条目 >5000（见 Broken 行）；②`collecting/uploading/verifying` 卡死后无取消接口，`hasActiveBackup` 永久挡住新建（`store.js:310-320`）。
- **Cron 真实注册**：是。`wrangler.jsonc:10-12` 为 `*/15 * * * *`，`vars.BACKUP_CRON_ENABLED="true"`（`:14`），`worker/index.js:191-212` 在 `scheduled` 里 `waitUntil` 四件事（备份/隐私清理/删除续跑/社区维护）。**但** `backups/handlers.js:1345-1356` 的 `cronInfo` 硬编码 `schedule:"0 18 * * *"` 并声称“每日一次”，与实际触发器不一致。

## 3. 安全隐患（表格，按严重度排序）

| 严重度 | 位置 | 问题 | 影响 |
| --- | --- | --- | --- |
| 高（仅 admins=0 窗口可触发） | `auth/handlers.js:150-156`、`433-467`、`ratelimit.js:46-53` | 无管理员窗口内，任何 GitHub 账号都能拿到 setup 票据；初始化密钥只按 IP 限 5 次/10 分钟，无全局计数/锁定，无最小长度校验（只判非空、≤200） | 弱初始化密钥可被分布式爆破，成功后成为唯一 admin（`idx_users_single_admin` 只保证唯一，不保证合法）；已初始化后该路径关闭 |
| 高 | `auth/handlers.js:293-306` | 注销重新验证要求 `user.role === "admin"`，普通 member 永远拿不到 reauth 票据；`delete-account` 恒 403 | 普通用户无法注销账号，隐私/合规承诺与实际能力不符（`privacy/client.ts:268-275` 仍会调用） |
| 中 | `worker/index.js:115-161` | `/sb` 同源反代不经过 `/api` 限流，仅删除 cookie/authorization，其他头与方法全透传，错误体回显 `err.message` | 可被匿名当作访问该 Supabase 项目的免费中继（配额外流量/滥用面）；错误细节泄露 |
| 中 | `files/handlers.js:519-525`、`auth/handlers.js:85-94`、`devices/handlers.js:677-687` | 三处直接 `request.json()` 或只信 `content-length`；分块传输可绕过上限 | 大 body 打满 isolate 内存；`http.js:43` 已有双重复核实现却无人调用 |
| 中 | `privacy/handlers.js:1285-1290`、`1300` | 注销最后阶段对 `users/{uid}/files`、`backups`、`exports`、`community` 四个前缀的删除全部 `.catch(()=>undefined)`，随后删 `users` 行 | R2 删除失败会留下孤儿对象，且 job 随级联删除消失，无法重试；“已删除”是假象 |
| 中 | `backups/store.js:322-324`、`backups/handlers.js:501-508` | `listBackupItems` 硬上限 5000 | >5000 文件的账号备份永远失败，且已消耗 R2 写入；无入口提示上限 |
| 中 | `backups/store.js:310-320` | 活跃备份判定无超时、无取消接口；Cron 只续跑 `backup_type='auto'`（`handlers.js:1377-1384`） | 手动备份中断后永久返回 `BACKUP_IN_PROGRESS`，用户无法自愈 |
| 中 | `backups/handlers.js:1007-1036` | 服务端 restore 的 `merge` 与 `copy` 都生成新 UUID，不存在按 ID 合并/冲突处理 | 恢复页宣称的 Merge 语义是假的；重复恢复产生重复文件 |
| 中 | `pairing/handlers.js:84-119`、`pairing/store.js:83-110` | 认领只需 6 位码；后一次 claim 覆盖 `claim_secret_hash` 与目标设备信息；确认时不校验设备名/确认码 | 猜码者若先认领、用户盲确认，最后认领者可领到该账号 Session（10 次/10 分钟/IP 只降低速率） |
| 中 | `.env:5-20`（工作目录，未跟踪） | Supabase 管理员邮箱/口令、`SUPABASE_DB_PASSWORD`、anon key 明文存放，注释形式写在 `.env` | 目录被备份/打包/共享即等于交出整个 Supabase 项目与数据库 |
| 中 | `privacy/handlers.js:212-253`、`490-501` | 每次 `GET /api/privacy/overview` 都向自身 origin 发 2 次 `fetch`（探未登录 401），无缓存、GET 无限流约束 | 自我放大请求 + 双倍计费；`APP_ORIGIN` 配错会指向外部主机（非用户可控） |
| 中 | `privacy/handlers.js:426-488`、`364-369` | R2 私有性只能靠 `R2_PUBLIC_BASE_URL` 探测，`wrangler.jsonc:17` 为空 | 安全中心永远显示 Unknown（Unknown 不计分，见 `:364-369`），等于这一项没有真实校验 |
| 低 | `health.js:22-47`、`router.js:64` | `/api/health` 匿名且不限流，每次真实 D1 + R2 IO，并返回版本/binding 能力/延迟 | 可被低成本放大；版本与基础设施细节外泄 |
| 低 | `ratelimit.js:311-316` | 无 `cf-connecting-ip` 时回退 `x-forwarded-for` | 本地/非 CF 环境可伪造身份绕过限额（生产由 CF 注入，风险有限） |
| 低 | `ratelimit.js:318-327` | 内存计数超过 4000 桶时整表 `clear()` | D1 故障降级期间，限额可被重置 |
| 低 | `ratelimit.js:255-261` vs `:57-63` | `pairing-claim` 规则重复定义，后一条（20 次）永不生效；`publicRateLimitRules` 把 32 条含重复的规则展示给用户 | 配置误导；改限额时容易改到死规则 |
| 低 | `cookies.js:50-72` | 无 `__Host-` 前缀；`SameSite=Lax`；`Secure` 依赖 `APP_ORIGIN` 是否为 https；设备 Cookie 365 天 | 若 `APP_ORIGIN` 配成 http，Cookie 会缺 Secure；子域可覆盖同名 Cookie（当前无子域） |
| 低 | `backups/handlers.js:775-838` | 下载不校验 manifest/data 摘要（只有 preview/restore 校验） | R2 对象被篡改时仍原样打包给用户，仅在 zip 里附 checksums.txt |
| 低 | `community/handlers.js:589-637` | 媒体按 UUID 读取，公开资源 `max-age=300`；取消发布后仍可能被边缘/浏览器缓存命中 | 下架内容最多 5 分钟可见（越界项，仅提示） |
| 低 | `index.js:144` | 502 响应体拼接 `err.message` | 上游网络错误细节外泄 |
| 低 | `pairing/handlers.js:124`、`193-196` | `claimSecret` 走 query string | 进入访问日志/Referer 风险面（一次性、10 分钟 TTL 缓解） |
| 低 | `devices/model.js:105-169` | 正常登录路径不限制设备数；`MAX_DEVICES=10` 只在配对路径校验（`pairing/store.js:133`） | 单账号可无限新增 devices 行，统计与配额失真 |

**明确未发现的问题**：SQL 注入（全部绑定参数，动态列来自白名单）；路径穿越（对象键服务端生成、文件名去分隔符）；跨用户读写（所有用户数据查询带 `user_id`）；`/sb` 的 SSRF（主机硬编码）；用户可控的 SSRF（`/api/plugins/net` 需已安装插件 + Manifest 白名单 + 禁止私网，且有 `global_fetch_strictly_public`，`wrangler.jsonc:6`）；开放重定向（`auth/handlers.js:134` 只拼同源路径 + query）。

## 4. 技术债

**巨型 handler / 单文件多职责**
- `backups/handlers.js` 1558 行、`privacy/handlers.js` 1479 行、`community/write.js` 1515 行、`plugins/handlers.js` 1253 行，路由、校验、SQL、编排混在一个文件。
- `auth/handlers.js:16` 两条 import 写在同一行（格式事故）；`backups/store.js:255`、`:322` 两个函数声明与首条语句挤在同行。

**重复实现**
- `assertSameOrigin` 复制 7 份：`auth/handlers.js:70`、`files/handlers.js:527`、`devices/handlers.js:689`、`backups/handlers.js:1550`、`privacy/handlers.js:1353`、`community/common.js:16`、`plugins/common.js:13`。
- `readJson` 有 8 份实现：`http.js:43`（双重复核的安全版）加上 7 份模块内拷贝 `auth/handlers.js:85`、`files/handlers.js:519`、`devices/handlers.js:677`、`backups/handlers.js:1527`、`privacy/handlers.js:1330`、`community/common.js:39`、`plugins/common.js:36`。其中 `readJsonLimited` **零调用**。
- 前端 4 个 client 各写一份 `request()`：`account/client.ts:124`、`devices/client.ts:132`、`backups/client.ts:106`、`privacy/client.ts:147`。

**重复数据模型 / 两套体系**
- 两套云栈：D1+R2（`worker/`）与 Supabase（`src/lib/cloud.ts`，token 存 localStorage `:48-64`；`/sb` 反代 `index.js:115`）。首页生产环境仍走 `/sb`（`src/pages/index.astro:80-83`）。
- 两套文件模型：`files`/`folders`（`0003:9-42`）与 `community_assets`（`0009:111`），R2 前缀互不复用；`multipart_uploads`（`0003:48-61`）从未被任何代码使用。
- 两套设备登记 SQL：`devices/model.js:148-169` 与 `pairing/store.js:143-168` 各自 INSERT `devices`，字段列表已漂移（配对路径不解 UA）。
- 文档与实现不一致：`migrations/README.md:78` 仍写“表已建好，但没有任何对外数据接口”，与当前 30+ 路由的事实相反。

**死代码 / 无用列**
- 表/列：`sync_changes`（`0001:82`）、`notes`（`0001:45`）、`multipart_uploads`、`backups.kind/note_count/expires_at`（`0001:100-109`）、`backups.source_cursor/parent_backup_id`（`0006:31-32`，只读不写）、`files.sha256`（上传时从不写，`files/store.js:151-157`；却被 `archive.js:35` 读取）。
- 函数：`replaceBackupItems`（`backups/store.js:255`）、`listBackupsForPurge`（`:622`）、`sha256StreamUnavailable`（`files/util.js:119`）、`communityHealth`（`community/handlers.js:644`）、`deleteSessionByHash`（`auth/store.js:211`）、`newId`（`continuity/store.js:301`）、`defaultDeviceName`（`devices/model.js:95`）、`pruneSecurityEvents`（`privacy/events.js:85`，只导出不调用）。

**未处理 Promise / 静默失败**
- `privacy/handlers.js:1285-1290` 用 `.catch(()=>undefined)` 吞掉 R2 删除失败，随后删 users 行。
- `backups/handlers.js:439` 忽略状态写入失败；`auth/handlers.js:333`、`:419` 对 `purgeExpired` fire-and-forget（`scheduled` 里也没有调用它）。
- `backups/archive.js:287-385` 的 `createZipStream` 没有 `cancel()`；客户端中断后 R2 流与 controller 不释放。`backups/crypto.js:136-152` 只 `releaseLock`，不 `cancel`。

**迁移工程**
- 索引名冲突导致“静默不建”：`0006:39` 与 `0001:111` 同名 `idx_backups_user_created`；`0012:27` 与 `0006:43` 同名 `idx_backups_user_status`（后者想加 `deleted_at`，因 `IF NOT EXISTS` 直接跳过）。`0001:41`/`0004:40` 的 devices 索引同样存在语义重叠。
- 无回滚脚本：12 个迁移全是 `CREATE/ALTER ADD`，D1 不支持 `DROP COLUMN`；`migrations/README.md:60-74` 只给整库 Time Travel。
- 顺序正确（0001→0012，`wrangler.jsonc:41` 指向 `migrations`），但 `migrations/README.md:21` 仍写“0012_xxx.sql 下一次变更”。
- 索引覆盖不足：`security_events` 的过期清理按 `created_at`，0012 才补索引（`0012:19`）；`continuity_items` 的 inbox 查询与 `0011:93` 的复合索引基本吻合；`backups` 列表的 `(user_id, deleted_at, created_at)` 组合缺索引（想补的那条 0012:27 因重名被跳过）。

**测试与文档**
- 后端零自动化测试：`vitest.config.ts` 只 include `tests/unit/**`，而 `tests/unit/` 里只有 `net/perf/quality` 三个前端质量模块用例，`tests/e2e/` 是 3 个 Playwright 界面用例（`playwright.config.ts:13`），没有任何对 `worker/` 的用例；`scripts/*-qa.mjs` 需要真实会话令牌与本地 wrangler，无法在 CI 跑。
- 文档漂移：`cronInfo` 声称每日 18:00 UTC（`backups/handlers.js:1349`）vs 实际 `*/15`（`wrangler.jsonc:11`）；README 的“已完成”与 `notes`/`sync_changes` 现状并存。

## 5. 2.0 云端架构建议（基于现有代码增量改造）

原则：不重写。现有分层（router → module handler → store → D1/R2）是清晰的，问题集中在“边界不统一”和“同步/备份语义缺失”。

1. **统一请求边界（1 天工作量）**：把 `assertSameOrigin` 收敛到 `worker/api/http.js` 一处导出，`readJson` 用已存在但闲置的 `readJsonLimited`（`http.js:43`）替换 7 份拷贝；`files`/`auth`/`devices` 三处裸 `request.json()` 全部换成它。删除 `files/handlers.js:519`、`auth/handlers.js:85`、`devices/handlers.js:677`。
2. **Session 硬化（保留 `auth/session.js` 与 `auth/cookies.js`）**：Cookie 改名 `__Host-gauth_sid`；`SESSION_TTL_MS` 改为“绝对 30 天 + 空闲 7 天”，在 `touchSession`（`auth/store.js:201`）里同时比较 `last_used_at`；`inspectSession` 增加 `rotated_at` 字段，注销重验证后轮换 token。CSRF 仍用 Origin，另加双提交 token（`/api/auth/me` 下发，写接口校验）作为纵深。
3. **修掉两个“高”**：`auth/handlers.js:298` 的 `role !== "admin"` 改为“票据 user_id 与当前会话一致即可”；初始化密钥增加最小长度（≥32）与全局尝试表（`setup_attempts(hash, hits, window_start)`），在 `authInitialize` 之前用 `rateLimit(..., {scope:"setup"})` 计数。
4. **限流补齐（复用 `ratelimit.js:338` 的 `subject` 参数）**：认证后调用 `rateLimit(env, request, rule, {scope:"user", subject:userId})`，避免 NAT 共用 IP；删除重复的 `pairing-claim`（`ratelimit.js:255-261`）；给 `/api/health` 与 `/sb` 各加 60/min 的软限（`/sb` 可在 `index.js` 里用同一 D1 表，或改成只允许 `GET` + `/rest/v1/`、`/storage/v1/object/public/` 前缀）。
5. **R2 与配额（保留 `files/util.js`、`files/store.js`）**：上传时把流式 SHA-256 写进 `files.sha256`（`backups/crypto.js:136` 的 `hashStream` 已现成），这样备份可用“按 sha256 去重”，把 512 MiB 上限变成真实增量；`MAX_BACKUP_BYTES` 判断提前到 `collectDrive` 之后（`backups/handlers.js:290` 处），避免白写 data.json。
6. **同步引擎（从最小闭环开始，不是先做 UI）**：
   - 复用 `sync_changes`（`0001:82`）：在 files/folders 的每次写操作里，与业务 UPDATE 同批 `INSERT INTO sync_changes(user_id, entity_type, entity_id, op, revision, payload, created_at)`；
   - 新增 `GET /api/sync/pull?since=<seq>&limit=`（按 `seq` 升序，返回 `nextSince`）与 `POST /api/sync/push`（带 `baseRevision`，冲突返回 409 + 服务端当前行）；
   - `devices/store.js:163` 的 `writeSyncState` 保留为“结果展示”，但值必须由服务端在 pull/push 里计算，禁止再用客户端自报（`devices/handlers.js:445-448`）；
   - 删除 `devices/model.js:271` 与 `devices/handlers.js:234` 的硬编码 `cloud`/`cloudSynced:true`。
7. **备份（保留 `backups/archive.js`、`backups/crypto.js`，只改编排）**：`listBackupItems` 改分页（`LIMIT/OFFSET` 或按 `entity_id > ?` 游标），去掉 5000 硬顶；新增 `POST /api/backups/{id}/cancel` 与 `hasActiveBackup` 的 30 分钟超时（把 `status` 置 `failed` 并写明 `STALE`）；`merge` 改为按 `manifest.files[].id` 比对 `revision` 后再插入，或干脆从 UI 移除（`backups/client.ts:19` 的 `RestoreMode` 同步删）。
8. **账号注销（保留 `privacy/handlers.js:1182` 的阶段机）**：R2 前缀删除改为“先记录待删前缀到 `data_deletion_jobs.checkpoint_json`，失败进入下一轮 Cron”，不要 `.catch(()=>undefined)`；`users` 行删除前确认所有前缀已清空，否则保持 `pending`。这样 `runDeletionMaintenance`（`privacy/handlers.js:1401`）就是唯一可重试入口。
9. **迁移治理**：新增 `0013_fix_index_names.sql`，把 `idx_backups_user_status` 改名为 `idx_backups_user_status_deleted`、`idx_backups_user_created` 改名后重建带 `WHERE deleted_at IS NULL` 的版本；每份迁移头部写“回滚 SQL（DROP INDEX / 重建旧索引）”；删除 `multipart_uploads`/`sync_changes` 前先在 `docs/` 标 Deprecated 并保留一版。
10. **可观测性**：`wrangler.jsonc` 增加 `observability: { enabled: true }`；`router.js:148` 的 `console.error` 带上 `requestId`（已有）与 `path`；给 `/api/health` 加 30 秒 Cache API 缓存，把真实 IO 探测改成 `?deep=1` + 仅管理员。
11. **拆分 handler（可渐进）**：`backups/handlers.js` 拆成 `create.js` / `run.js` / `restore.js` / `download.js` / `scheduled.js`，先把 `runScheduledBackups`（`:1359-1466`）搬出去；`privacy/handlers.js` 拆 `overview.js` / `export.js` / `deletion.js`。路由表保持在 `router.js` 一处可读。
12. **可直接保留/复用的文件**：`auth/crypto.js`（PKCE/常量时间比较）、`auth/cookies.js`、`auth/session.js`、`auth/store.js`、`files/store.js`、`files/util.js`、`backups/archive.js`（流式复制/校验/ZIP）、`backups/crypto.js`（流式 SHA-256/CRC32）、`privacy/events.js`、`http.js`（只补各模块改用）、`ratelimit.js`（补 subject 与去重即可）。这些是当前质量最高的部分，2.0 不应推倒。

## 6. 无法确认的点

1. **R2 桶是否真的私有**：仓库只有 `r2_buckets` 绑定（`wrangler.jsonc:28-33`），没有 public access/自定义域配置；`R2_PUBLIC_BASE_URL` 为空（`:17`）。需在 Cloudflare 控制台确认，否则第 2.2 节的“下载授权”结论只覆盖应用层。
2. **生产环境变量是否配置正确**：`APP_ORIGIN`、`GITHUB_CLIENT_ID/SECRET`、`INITIAL_ADMIN_SETUP_TOKEN` 是否已 `wrangler secret put`、`APP_ORIGIN` 是否为 https、setup token 强度如何，均无法从仓库判断（`.dev.vars.example:15-18` 只是模板）。
3. **迁移是否已应用到线上**：`wrangler.jsonc:40` 有 `database_id`，但 `d1_migrations` 的实际内容无法在本地确认；索引冲突（第 4 节）是否已在线上造成缺失索引，取决于 0006/0012 的执行结果。
4. **`.env` 中的凭据是否已泄露/轮换**：只能确认它未被 git 跟踪（`git check-ignore` 命中），无法确认是否进过压缩包、聊天记录或备份。
5. **`scripts/*-qa.mjs` 是否通过**：它们需要本地 `wrangler dev` + 真实会话令牌（如 `devices-qa.mjs` 需 `GDV_TOKEN`），本次未运行，不能据此判定“Tested”。
6. **Cron 的实际执行情况**：触发器已声明，但 `BACKUP_CRON_ENABLED` 是否在线上生效、`scheduled` 是否超时/降级（`runScheduledBackups` 串行处理最多 25 个用户，`backups/store.js:412-423`），需要看 Cloudflare 日志。
7. **D1 的并发语义**：多个 `/run` 请求同时推进同一 job 的行为（无行锁、无唯一约束）无法在本地静态确认；`hasActiveBackup` 的竞态是否真实存在需压测。
8. **`/sb` 的 Supabase 项目配额与 RLS 策略**：`supabase/schema.sql` 存在但本次未审计；`/sb` 代理出去的匿名请求是否会被 RLS 正确限制，取决于该 schema。
9. **`dist/` 与源码是否一致**：仓库有构建产物 `dist/`，未逐文件比对，因此“线上跑的就是这份 `worker/index.js`”只能由 `x-guandao-version` 响应头（`version.js:13`）间接验证。
10. **`community/` 与 `plugins/` 的约 4.6k 行**：超出本次指定范围，未逐条审计；第 1 节表格里只标了存在与入口，不代表已确认安全。