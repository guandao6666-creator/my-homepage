# 生产数据事故调查记录 · 2026-11-06 账号消失

**状态：Mitigated / Pending Investigation（未 Closed）**
**调查范围**：2026-11-05 22:07 — 2026-11-06 13:15（Asia/Shanghai）
**生产变更**：本次调查**未修改任何生产数据**，未执行 D1 Time Travel、未运行 `npm run qa:prod`、未删 R2 对象、未改部署架构。

---

## 1. 事件摘要

| 项 | 内容 |
| --- | --- |
| 发现时间 | 2026-11-06 13:15 CST（Phase 1 最终核验） |
| 现象 | `users=0`、`sessions=0`、`devices=0`；此前 2026-11-05 22:07 为 `users=1 / sessions=3 / devices=3` |
| 同期审计表 | `account_deletion_audit=0`、`data_deletion_jobs=0` |
| 恢复方式 | D1 Time Travel 恢复到 `2026-11-05T14:00:00Z` |
| 恢复结果 | 1 账号 / 3 Session / 3 设备 / 0 文件 / 0 备份 |
| 恢复后状态 | `/api/health` 200、`/api/auth/status initialized=true`、`qa:prod` 35/35（恢复后复跑） |

恢复前已导出当前库到 `%TEMP%\guandao-d1-before-recovery-20261106-131708.sql`；撤销恢复的 bookmark 为
`000000b4-ffffffff-0000511b-08ef306eee34571a050a63e8c6cac6b1`。恢复动作发生在检测之后，不是事故原因。

---

## 2. 时间线

| 时间（CST） | 事件 | 数据变化 | 证据来源 | 可信程度 |
| --- | --- | --- | --- | --- |
| 11-05 11:22 | 正常登录 | users=1, sessions/devices 建立 | `security_events`：`successful_login` / `session_created` / `new_device_registered` | 高（D1 记录） |
| 11-05 22:07 | Phase 0 审计只读查询 | **users=1 / sessions=3 / devices=3** | `wrangler d1 execute` 只读查询 | 高（原始输出） |
| 11-05 22:35 | 一条会话被撤销 | 1 个 Session 失效 | 恢复前 `security_events.session_revoked`（`created_at=1793889343133`） | 中高（恢复后被回滚） |
| 11-06 13:11 | Phase 1 部署 | 仅 Worker 版本变化；未写 users | `wrangler deploy` 输出 | 高 |
| 11-06 13:11–13:13 | 生产 E2E（qa:prod） | 创建/清理 `qa-e2e-*` 临时账号 | 脚本运行输出（35/35、清理残留 0） | 高 |
| 11-06 13:15 | 最终核验 | **users=0 / sessions=0 / devices=0** | 只读 D1 查询 | 高 |
| 11-06 13:17 | D1 Time Travel 恢复 | 回到 11-05 22:00 CST 状态 | `wrangler d1 time-travel restore` 输出、bookmark | 高 |
| 11-06 17:44 | Supabase legacy keys 停用 | 与本次账号事件无关 | Supabase 控制台（owner 操作） | 高 |

**关键窗口**：账号行消失发生在 **11-05 22:35 之后、11-06 13:15 之前**。

---

## 3. 删除路径清单

| 删除入口 | 调用条件 | 认证要求 | 涉及数据 | 是否存在误删可能 |
| --- | --- | --- | --- | --- |
| `POST /api/privacy/delete-account` → `runAccountDeletion` | 用户主动注销；`confirm="DELETE MY ACCOUNT"`；`acknowledgeBackups=true`；Reauth ticket | Session + GitHub reauth | files / backups / exports / users（级联 sessions/devices 等） | **低**；本次无 `account_deletion_audit`、无 `account_deletion_started/completed` 事件，证据不支持此路径 |
| Worker Cron `runDeletionMaintenance` | `data_deletion_jobs` 存在未完成 `account` 任务 | Cron（内部） | 续跑同上 | **低**；本次 `data_deletion_jobs=0`，无任务可续跑 |
| `authCallback` 邀请并发回滚 | 新用户插入后邀请被抢完 | GitHub OAuth + invite | 仅 `created.id` 这一新用户 | 低；仅新创建账号，不可能命中既有管理员 |
| `POST /api/auth/logout` | 用户退出 | Session | 仅当前 Session | 无（不删 users） |
| Session 过期清理 `purgeExpired` | Cron/登录后 | 内部 | 仅过期 Session | 无 |
| `scripts/prod-e2e.mjs` 清理 | 生产 E2E 结束 | 本地 `wrangler` OAuth（remote） | 仅 `qa-e2e-*` 账号及其子表 | **低**；所有 SQL 都以本次 `USER_ID` 限定；本次事故后已加四重校验 |
| `scripts/sync-qa.mjs` / `sync-client-qa.mjs` 清理 | 本地同步联调结束 | `wrangler --local` | 固定 `qa-sync-*` 账号 + 本地 D1 | 无（`--local`，不接触生产） |
| 手工 D1 SQL / Dashboard 查询 | 人工操作 | Cloudflare 账号权限 | 任意表 | **未排除**；无可用审计证据 |
| 外仓库/临时脚本 | 任意 | Cloudflare/D1 凭据 | 任意表 | **未排除**；无证据 |
| 外键级联 | 删除 users 行时 | — | sessions/devices/files/backups 等子表 | 不是原因；级联只发生在 users 行被删之后 |

---

## 4. 已确认与已排除

### 4.1 已确认

1. 事故存在：`users` 行在 11-05 22:35 之后、11-06 13:15 之前消失，且 sessions/devices 一并消失，符合 **users 行删除 + `ON DELETE CASCADE`** 的表现。
2. `security_events.user_id` 是 `ON DELETE SET NULL`；若走应用内注销流程，`account_deletion_started/completed` 事件会保留（`user_id` 变 NULL）。恢复前只看到登录/会话/设备/退出事件，**没有注销事件**。
3. `account_deletion_audit` 无 `users` 外键，注销流程会留下审计行；事故时该表为 0，**证据不支持应用内注销流程**。
4. `data_deletion_jobs` 有 `ON DELETE CASCADE`，若注销任务存在会随 users 行一起消失；但应用内注销同时应留下 audit 与注销事件，二者均无。
5. 仓库内所有 `DELETE FROM users` 语句均带明确 `WHERE`（见第 3 节）；`prod-e2e` 在事故时的清理语句也以 `qa-e2e-*` 为条件，不存在无条件删除。
6. 生产 D1 无触发器（`sqlite_master` 查询无 trigger/view 输出）。
7. 本次调查未发现任何证据表明 Worker API 能以真实账号调用到 `DELETE FROM users`。

### 4.2 已排除（有证据）

- **应用内账号注销流程**：无 audit、无注销事件，且流程要求 Reauth + 双确认。
- **Cron 删除任务**：`data_deletion_jobs=0`。
- **登录/登出/Session 清理**：只删 Session，不删 users。
- **auth 注册回滚**：只删除刚创建的新用户。
- **sync QA**：仅 `--local`。
- **外键反向级联**：删除子表不会删除 users。
- **D1 Time Travel**：恢复发生在发现 `users=0` 之后。

### 4.3 尚未排除

1. **人工在 Cloudflare D1 控制台 / SQL 客户端执行 `DELETE FROM users`**（最可能，但无日志证据）。
2. **仓库外的临时脚本/旧脚本**使用 Cloudflare 凭据执行删除。
3. **Cloudflare 平台侧异常**（概率低；无证据）。
4. **凭据泄漏导致的未授权操作**（Supabase key 与 D1 凭据是两套；D1 仅 Cloudflare 账号可写）。

---

## 5. 证据缺口

| 需要的证据 | 当前状态 | 影响 |
| --- | --- | --- |
| Cloudflare Audit Logs（11-05/11-06 窗口） | 尝试读取 API 返回 **403 Authentication error**；当前 wrangler OAuth 令牌无 audit_logs 权限 | 无法确认是否有 Dashboard/SQL 操作 |
| Worker/API 请求日志 | 未启用持久化 Worker Logs；`wrangler tail` 只能实时 | 无法确认是否有注销 API 调用 |
| D1 查询历史（SQL 文本） | Cloudflare D1 不提供逐条 SQL 审计 | 无法确认手工 SQL |
| 事故窗口的 `security_events` 完整快照 | 恢复后只保留 11-05 14:00Z 之前的事件；此前记录过 `session_revoked`，但已随恢复回滚 | 时间线只能靠事故前查询输出 |
| 生产操作者确认 | 未询问/未获取 | 无法判断是否有人手动执行 |

> 没有直接证据，因此根因保持 **Pending Investigation**，不把「最可能」写成「已确认」。

---

## 6. 已采取的防护

### 6.1 QA 清理护栏

新增 `scripts/lib/qa-cleanup.mjs`：

- 只允许 `qa-` 前缀 + `qa-*@example.test` 邮箱；
- 必须携带本次运行的 context（marker + runId）；
- 删除前重新读取账号，校验 `id / email / github_username / created_at`；
- 目标行数必须恰好 1；关联资源超过 1000 条即中止；
- users 删除 SQL 同时约束 `id + email + LIKE qa-% + LIKE qa-%@example.test`；
- 子表删除同时约束 `user_id + LIKE qa-%`；
- 删除后复核目标 users 行必须为 0；任何失败直接抛错，不退化、不扩大条件。

已接入：

- `scripts/prod-e2e.mjs`：清理前复核、资源上限、逐表 guarded SQL、删除后计数校验；不再 `catch` 后继续执行未限定删除。
- `scripts/sync-qa.mjs` / `scripts/sync-client-qa.mjs`：删除 SQL 增加 `LIKE 'qa-%'` 与测试邮箱条件。

### 6.2 应用内注销路径加固

- `deleteAccountHandler`：要求 `session.user.id === userId`，否则 403。
- `runAccountDeletion`：
  - 无 `checkpoint.auditId` 直接中止；
  - `DELETE FROM users` 只允许 `deletion_state='pending'`；
  - 必须恰好影响 1 行，否则 409；
  - 审计在用户删除成功后才标记 completed。

### 6.3 自动化测试

`scripts/qa-cleanup-selftest.mjs`（隔离 SQLite，不接触生产）：

1. QA 账号可正常清理；
2. 真实用户不会被 QA 删除 SQL 匹配；
3. 真实邮箱 + qa 前缀被拒绝；
4. 前缀匹配但邮箱不匹配被拒绝；
5. id 匹配但账号身份不匹配被拒绝；
6. 匹配到多个用户时中止；
7. 删除行数超出预期时中止；
8. 缺少测试上下文标记时拒绝；
9. 关联资源超限时中止；
10. 创建时间早于本次运行被拒绝；
11. 子表清理只匹配 qa- 前缀且拒绝非白名单表。

结果：**11/11 通过**。已加入 `npm test` 与 CI。

后续补强新增：D1 备份 8 项、数据监控 8 项、安全日志 6 项，共 **33/33** 本地通过。

---

## 7. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run verify` | 通过：115 单测、33 项安全测试（清理/备份/监控/日志）、0 Astro errors、lint 0、构建 29 页、CSP 12 哈希一致 |
| `npx playwright test` | 24 passed |
| `npm run qa:sync` | 20/20 |
| `npm run qa:prod` | **本任务禁止执行，未运行** |

生产环境：**未部署、未修改任何数据、未删 R2 对象**。

---

## 8. 结论与后续

- **根因是否确认**：否。`Mitigated / Pending Investigation`。
- **应用内删除路径是否可能误删真实用户**：现有代码路径已被限定，未发现可触发真实账号删除的 API；本次事故证据也不支持应用内注销。
- **是否允许恢复生产 QA**：**可以恢复**，但必须先满足：owner 确认近期未手工执行 D1 删除、Cloudflare audit logs 可读取（或明确接受无日志）、`prod-e2e` 新护栏在本地通过。当前建议仍**暂缓** `qa:prod`，直到拿到 Cloudflare 审计日志。
- **是否具备进入 Phase 2 条件**：代码与测试层面具备；但生产数据事件未闭环，建议 Phase 2 前先完成「Cloudflare Audit Logs 权限 + 每日 D1 导出/告警」两项。

### 仍需人工确认

1. 11-05 22:35 — 11-06 13:15 之间，是否有人在 Cloudflare D1 控制台或 SQL 客户端执行过 `DELETE FROM users`。
2. 是否有仓库外的脚本/旧凭据仍能写生产 D1。
3. 提供可读的 Cloudflare Audit Logs（或确认无法获取），以排除/确认人工操作。
4. 确认 `guandao6666@gmail.com` 的 Cloudflare 账号是否有多余成员/API Token。

---

## 9. 数据安全补强（2026-11-06 后续）

| 能力 | 状态 | 文档 |
| --- | --- | --- |
| Cloudflare Audit Logs 权限调查 | **Pending Manual Action**（OAuth 无 audit_logs，API 403） | `docs/SECURITY-AUDIT-ACCESS.md` |
| D1 整库备份工具 | **Implemented / 本地验证**（backup/verify/list/restore-check；8/8） | `docs/D1-BACKUP-RECOVERY.md` |
| 每日自动备份 | **未启用**（workflow 已准备；缺 3 个 Secrets） | 同上 |
| 数据异常监控 | **Implemented / 本地 scheduled 验证，未部署**（8/8） | `docs/PRODUCTION-DATA-MONITORING.md` |
| 告警通知 | **未配置**（未声称送达） | 同上 |
| 安全事件日志 | **Implemented / 本地验证，未部署**（6/6） | `docs/SECURITY-EVENT-LOGGING.md` |
| 生产变更 | **无**（未部署、未应用迁移、未跑 qa:prod） | — |

**事故状态保持 `Mitigated / Pending Investigation`**：上述措施提升发现与恢复能力，
但没有提供事故根因的直接证据，因此不能写 Closed。