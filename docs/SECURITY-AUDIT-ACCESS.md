# Cloudflare Audit Logs 访问调查

**状态**：权限缺口已确认（`Pending Manual Action`）
**调查时间**：2026-11-06
**操作边界**：只读；未创建 Token、未修改账号权限、未输出任何 Token/Secret。

---

## 1. 当前认证方式

| 项 | 值 |
| --- | --- |
| 工具 | Wrangler 4.157.0 |
| 认证方式 | **OAuth 登录**（`wrangler login`），不是 API Token |
| 配置位置 | `%APPDATA%\xdg.config\.wrangler\config\default.toml`（本机） |
| 账号 | `guandao6666@gmail.com` |
| Account ID | `e40e3f33f13aabaae2c6da6c36b38749` |
| 部署目标 | Worker `my-homepage` + Static Assets |

Wrangler 当前 OAuth 令牌包含 30 项权限（`tokenPermissions`），与部署相关的主要有：

`account:read`、`workers:write`、`workers_scripts:write`、`workers_tail:read`、
`d1:write`、`pages:write`、`zone:read`、`secrets_store:write` 等。

**没有** `audit_logs:read` / Audit Logs 相关权限。

---

## 2. 实际可用权限与实测结果

| 能力 | 实测 | 说明 |
| --- | --- | --- |
| 读取账号信息 | 可用 | `wrangler whoami` 返回账号与权限 |
| 部署 Worker | 可用 | 已有多次成功部署记录 |
| D1 读写 / 导出 | 可用 | `d1:write`；可执行导出与查询 |
| R2 对象读写 | 可用 | 通过 wrangler `r2 object` |
| **读取 Audit Logs API** | **不可用** | `GET /accounts/{id}/audit_logs` → **403 Authentication error** |
| 读取账号成员 / 其他 Token | 未验证 | 没有对应管理权限，不能假设 |
| 查看历史 Dashboard 操作 | 不可用 | 需要 Audit Logs 权限或 Dashboard 角色 |

实测命令（只读）：

```text
GET https://api.cloudflare.com/client/v4/accounts/e40e3f33f13aabaae2c6da6c36b38749/audit_logs
Authorization: Bearer <wrangler OAuth token>
→ HTTP 403 {"code":10000,"message":"Authentication error"}
```

结论：**拥有部署权限 ≠ 拥有审计日志读取权限**。当前账号能部署、能读写 D1/R2，但不能通过 API 读取审计日志。

---

## 3. 缺失的权限

Cloudflare 的审计日志读取需要 **Account 级别的 Audit Logs 权限**，与 Workers/D1 的写权限是分开的。

最小权限建议：

1. **只读 API Token**（推荐）：
   - Account → **Audit Logs → Read**
   - Account → **Account Settings → Read**（用于确认账号/成员上下文）
   - 如只想看 D1/Worker 控制面事件，不需要 D1 数据读写权限。
2. **Dashboard 角色**：
   - 使用账号的 **Audit Logs** 角色（只读）或 Administrator（范围更大，不推荐日常使用）。
3. **不要**把当前 Wrangler OAuth Token 直接共享给第三方；它包含 Workers/D1/R2 写权限。

> 本任务未创建任何 Token，也未修改账号权限。上述配置需由项目所有者手工完成。

---

## 4. 如何安全检查事故时间段

事故窗口（Asia/Shanghai）：

```text
2026-11-05 22:35 — 2026-11-06 13:15
= 2026-11-05T14:35:00Z — 2026-11-06T05:15:00Z
```

### 方式 A：Dashboard（最简单，推荐先做）

1. Cloudflare Dashboard → 右上角账号 → **Manage Account → Audit Logs**；
2. 时间范围设为 `2026-11-05 22:35` — `2026-11-06 13:15`（本地时区）；
3. 依次筛选/搜索：
   - `d1`：D1 数据库创建/删除/配置变更；**注意：行级 SQL 通常不在审计日志中**；
   - `workers`：部署、版本、路由、配置变更；
   - `token` / `api_token`：Token 创建、修改、删除；
   - `member` / `role`：成员与权限变更；
   - `login`：账号登录；
4. 导出 JSON/CSV（如果界面提供），保存到本地受控目录，不要提交 Git；
5. 重点核对：是否有非本人操作、是否有 D1 控制台查询、是否有新 Token。

### 方式 B：只读 API Token（可重复/可留证）

1. 创建一个 **仅 Audit Logs Read** 的 API Token（不要复用部署 Token）；
2. 用环境变量保存，不写入脚本或仓库：

```bash
export CLOUDFLARE_AUDIT_TOKEN="..."   # 仅当前 shell
export CLOUDFLARE_ACCOUNT_ID="e40e3f33f13aabaae2c6da6c36b38749"
```

3. 只读请求：

```bash
curl -sS \
  -H "Authorization: Bearer $CLOUDFLARE_AUDIT_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/audit_logs?since=2026-11-05T14:35:00Z&before=2026-11-06T05:15:00Z&per_page=100"
```

4. 将响应保存为证据文件（不要提交仓库），核对 `action.type`、`actor.email`、`resource.type`；
5. 使用完立即撤销该 Token。

---

## 5. Audit Logs 能回答/不能回答什么

| 问题 | Audit Logs | 说明 |
| --- | --- | --- |
| 是否有人创建/删除 API Token | ✅ 可能 | 控制面事件 |
| 是否有人修改账号成员/角色 | ✅ 可能 | 控制面事件 |
| 是否有人部署 Worker / 改配置 | ✅ 可能 | 控制面事件 |
| 是否有人创建/删除 D1 数据库 | ✅ 可能 | 控制面事件 |
| 是否有人执行 `DELETE FROM users` | ❌ 不能保证 | 行级 SQL 不在审计日志范围；D1 控制台查询是否记录需实际验证 |
| 请求级 API 日志 | ❌ | 需要 Workers Logs / 自建日志 |
| 数据库内容变化 | ❌ | 需要备份对比或数据库触发器/审计表 |

**不能因为“Audit Logs 没有记录”就断定没有人操作过数据库。** 行级删除必须靠 D1 备份对比、应用审计事件或数据库写入审计来还原。

---

## 6. 调查结果

### 已确认

- 当前 Wrangler OAuth 无 Audit Logs 权限，API 返回 403；
- 当前账号是部署账号，但不是“审计只读”账号；
- 无法从 API 获取事故窗口的历史 Audit Logs；
- 没有创建新 Token、没有修改权限。

### 尚未确认

1. 事故窗口内是否有人在 Cloudflare Dashboard 执行过 D1 查询/删除；
2. 是否存在其他 API Token / 仓库外脚本拥有 D1 写权限；
3. 账号下是否有其他成员或旧 Token；
4. D1 控制台查询是否进入 Audit Logs（需有权限后实测）。

### 需要项目所有者完成

1. 用 Dashboard 或只读 Audit Token 导出 `2026-11-05T14:35Z — 2026-11-06T05:15Z` 的审计记录；
2. 在 **Account → Members** 与 **API Tokens** 页面核对成员/Token 列表；
3. 确认是否本人执行过 D1 控制台 SQL；
4. 将证据交给调查，不要提交到 Git；
5. 调查完成后撤销临时 Audit Token。

---

## 7. 结论

- **审计权限：未具备**（`Pending Manual Action`）；
- **历史 Audit Logs：未能读取**；
- **是否允许据此排除人为操作：否**；
- 该缺口已记录到 `docs/INCIDENT-2026-11-06-ACCOUNT-DELETION.md` 与发布文档；
- 在拿到审计记录前，事故状态保持 `Mitigated / Pending Investigation`。