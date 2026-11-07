# D1 备份（独立 R2 SQL 归档）

**状态**：`Implemented / Partially Verified`（生产备份已成功；告警通知渠道未配置）
**最后核对**：2026-11-07
**当前生产**：版本 `6928916f`；Bucket `guandao-db-backups`；Cron `0 19 * * *`；最近成功备份 `cf_ff32148d...`。

---

## 1. 两层恢复能力

| 层 | 机制 | 范围 | 本阶段状态 |
| --- | --- | --- | --- |
| 第一层 | D1 Time Travel | 官方文档：最近 **30 天**（Workers Paid）/ **7 天**（Free），按分钟恢复；Bookmark 可撤销恢复 | 已有，不替代第二层 |
| 第二层 | 独立 R2 SQL 归档 | 每日 Workflow 导出整库 SQL，独立 Bucket，保留 ≥30 个版本 | **本阶段新增，未启用** |

两者不能混为一谈：

- Time Travel 是平台内时间点恢复，超过保留期不可用；
- R2 归档是独立文件，可长期保留、可离线校验、可导入隔离库；
- 本阶段**不执行任何生产恢复**。

官方依据：

- <https://developers.cloudflare.com/d1/reference/time-travel/>
- <https://developers.cloudflare.com/workflows/examples/backup-d1/>
- <https://developers.cloudflare.com/workflows/build/trigger-workflows/>

---

## 2. 只读现状核查（2026-11-07）

### 2.1 D1 存储版本

`npx wrangler d1 info guandao-db` 在当前 Wrangler 4.157.0 下**没有输出 `version` 字段**；
通过 Cloudflare 只读 API `GET /accounts/{account}/d1/database/{id}` 确认：

```text
uuid       9c89b111-bd89-47a6-8615-2c838993ede5
name       guandao-db
version    production
file_size  1,093,632 B（约 1.09 MB）
num_tables 59
created_at 2026-11-04T04:31:58.292Z
```

结论：**使用 production 存储后端，支持 Time Travel**。

当前 Time Travel bookmark（只读查询）：

```text
00000118-00000030-0000511c-fec0b00f2424123ffd1edbc56b077a33
```

bookmark 会随 Cloudflare 内部维护推进，不代表数据发生变化；恢复时以当时 `time-travel info`
和事故时间点为准。

### 2.2 D1 Audit Logs 的边界

官方 D1 Audit Logs 文档只列出：

- `CreateDatabase`
- `DeleteDatabase`
- `TimeTravel`

**不包含行级 SQL / `DELETE FROM users`**。因此：

- 不能仅凭 Audit Logs 没有记录，断言没有人执行过 SQL；
- 本阶段新增的备份与状态记录，是发现数据异常的另一条证据链。

---

## 3. 架构

```text
Workflow schedule 0 19 * * * (UTC)
        │
        ▼
POST /accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/export
  body: { output_format: "polling" }
        │  result.at_bookmark
        ▼
POST 同一 endpoint，body: { current_bookmark }
        │  result.signed_url
        ▼
下载 SQL → SHA-256(plain)
        │
        ├─ AES-256-GCM（BACKUP_ENCRYPTION_KEY）
        ├─ R2 DB_BACKUPS.put(daily/YYYY/MM/DD/<runId>.sql.enc)
        ├─ R2 get 回读 → SHA-256(object) 对比
        ├─ AES-GCM 解密 → SHA-256(plain) 对比
        ├─ manifest: daily/YYYY/MM/DD/<runId>.manifest.json
        └─ status: logs/backup-status.json + logs/runs/<runId>.json
```

- 独立 Bucket：**`guandao-db-backups`**（已创建，Standard / APAC）；
- 不复用 `guandao-files` / `FILES`；
- 不覆盖历史对象：key 含 workflow runId；
- 不删除任何对象；
- 不使用公开下载链接。

---

## 4. 文件与代码

| 文件 | 作用 |
| --- | --- |
| `worker/workflows/d1-backup.js` | Workflow 类 `D1BackupWorkflow`（`cloudflare:workers`） |
| `worker/workflows/d1-backup-run.js` | 可 Mock 测试的实际流程 |
| `worker/workflows/d1-backup-core.js` | REST 响应校验、AES-GCM、SHA-256、manifest、状态判断 |
| `migrations/0016_d1_backup.sql` | `d1_backup_runs` 运行记录（**未应用生产**） |
| `worker/api/admin/backup.js` | `GET /api/admin/backup-status` |
| `scripts/backup-status.mjs` | 本地/远程只读状态 CLI |
| `scripts/verify-d1-backup.mjs` | 隔离 SQLite 恢复验证 |
| `scripts/d1-backup-selftest.mjs` | Workflow Mock 测试 11 项 |
| `scripts/d1-recovery-selftest.mjs` | 隔离恢复测试 4 项 |
| `config/d1-backup.wrangler.example.jsonc` | 资源绑定示例（已合并到主配置并部署） |

Workflow 类已从 `worker/index.js` 导出；主 `wrangler.jsonc` 已加入 `workflows` / `DB_BACKUPS`，
生产版本 `6928916f` 已带 Workflow binding 与 `0 19 * * *` Cron。生产 Workflow 已成功完成，
R2 回读与隔离恢复均已验证；剩余告警通知渠道问题与部署结构无关。

---

## 5. Manifest

每个备份生成独立 manifest（不包含 Secret）：

```json
{
  "schemaVersion": 1,
  "database": { "name": "guandao-db", "ref": "guandao-db/9c89b111" },
  "workflow": { "runId": "...", "schedule": "0 19 * * *" },
  "exportedAt": "2026-11-07T19:00:00.000Z",
  "bookmark": "...",
  "r2": {
    "sqlKey": "daily/2026/11/07/<runId>.sql.enc",
    "manifestKey": "daily/2026/11/07/<runId>.manifest.json"
  },
  "sql": {
    "bytes": 123456,
    "sha256": "<plain SHA-256>",
    "encryption": { "algorithm": "AES-256-GCM", "iv": "<base64>" }
  },
  "object": { "bytes": 123456, "sha256": "<ciphertext SHA-256>" },
  "upload": { "status": "put_ok" },
  "verify": { "status": "sha256_match", "verifiedAt": "..." }
}
```

- `sha256` 是明文 SQL 的摘要；`object.sha256` 是 R2 对象（密文）的摘要；
- 不记录 Token、signed_url、SQL 内容、Cookie；
- `marker` 失败状态写入 `logs/backup-status.json` 与 `logs/runs/<runId>.json`。

---

## 6. 加密与密钥

- 算法：**AES-256-GCM**（WebCrypto）；
- Secret：`BACKUP_ENCRYPTION_KEY`，base64 编码的 **32 字节**；
- 生成：`openssl rand -base64 32`；
- 只能放在 Cloudflare Secret；不得写入 `.env`、源代码、GitHub 普通变量或日志；
- 丢失密钥会导致历史备份不可解密；必须离线保存一份恢复副本（不在本仓库）；
- 本阶段已生成随机 32 字节密钥并设置为 Secret；本机恢复副本为
  `C:\Users\1\.guandao-backup-key.xml`（Windows DPAPI 保护，仅当前 Windows 账号可读）。

---

## 7. 权限与人工配置

### 7.1 需要项目所有者操作

1. 创建**私有** R2 Bucket：`guandao-db-backups`；
   - 不开启 Public Access / r2.dev；
   - 不配置 Lifecycle 自动删除。
2. 创建 API Token：
   - Account → D1 → **Edit**（实测 D1 Read 调用 `/export` 返回 401；export 需要 Edit/Export 级别权限）；
   - 资源范围限定 `guandao-db`；
   - 不授予 Workers/R2 管理或 Global API Key；
   - 当前已配置的 Token 只有 Read，需重新创建或修改权限；
   - 不复用 Supabase 凭据。
3. 设置 Secrets：

```bash
npx wrangler secret put D1_REST_API_TOKEN
npx wrangler secret put BACKUP_ENCRYPTION_KEY
# 可选
npx wrangler secret put BACKUP_ALERT_WEBHOOK
```

4. 合并 `config/d1-backup.wrangler.example.jsonc` 中的 `vars` / `workflows` / `r2_buckets` 到
   `wrangler.jsonc`；
5. 人工确认 `schedules` 被当前 Wrangler 识别（4.157.0 schema 已支持）；
6. 应用迁移（**本阶段未执行**）：`d1_backup_runs`；
7. 人工部署；
8. 第一次手动触发并核对 R2 对象、manifest、状态。

### 7.2 非敏感 vars

```text
ACCOUNT_ID      e40e3f33f13aabaae2c6da6c36b38749
DATABASE_ID     9c89b111-bd89-47a6-8615-2c838993ede5
DATABASE_NAME   guandao-db
```

### 7.3 配置状态

- 独立 Bucket 已创建；
- `workflows` / `DB_BACKUPS` / `ACCOUNT_ID` / `DATABASE_ID` 已合并到主 `wrangler.jsonc`；
- Worker 已部署 `6928916f`，Cron `0 19 * * *` 已启用；
- 仍缺：Token 的 D1 export 权限（当前 export 401）。

---

## 8. 调度

**实际状态**：已部署 `0 19 * * *` Cron，但**不使用 Workflows `schedules`**。

原因：Wrangler 部署时 Cloudflare 返回：

```text
Workflow "guandao-d1-backup" has "schedules" configured,
but scheduled Workflows require a paid Workers plan.
```

因此改为：

```jsonc
"triggers": {
  "crons": ["*/15 * * * *", "0 19 * * *"]
}
```

`worker/index.js` 的 `scheduled()` 在 `event.cron === "0 19 * * *"` 时调用：

```js
env.BACKUP_WORKFLOW.create({ id: `d1-backup-${UTC日期}` })
```

- UTC 19:00 = 北京时间次日 03:00；
- 不依赖付费 Workflows schedule；
- 当前已部署版本 `6928916f` 已带该 Cron；
- 如果 Workflow 实例创建失败，会写 Worker 日志，不会影响正常请求；
- 同一个 UTC 日期使用固定 instance id，避免重复创建；
- 失败由 Workflow step retries 处理，最终失败写状态并（可选）发 Webhook。

---

## 9. 保留与成本（估算，不是实际导出）

| 项 | 估算 |
| --- | --- |
| 当前 D1 `file_size` | 1.09 MB |
| 单次 SQL/密文 | 约 1–3 MB（取决于实际数据与压缩；本阶段未导出生产） |
| 30 个每日版本 | 约 30–90 MB |
| R2 Standard 存储 | 约 $0.0005–$0.0015/月（按 $0.015/GB-month 粗算） |
| 请求 | 每日数次的 PUT/GET，成本可忽略 |

**本阶段不实现自动删除**，不配置 Lifecycle Rule。保留策略需在观察到真实文件大小后由所有者确认。

---

## 10. 失败处理

| 场景 | 处理 |
| --- | --- |
| D1 REST API 失败 | step retry；最终失败写 `failed` 状态 |
| 没有 `at_bookmark` | 抛 `EXPORT_BOOKMARK_MISSING`，不继续 |
| 没有 `signed_url` | step retry；最终失败 |
| 下载失败 | step retry；最终失败 |
| R2 上传失败 | step retry；最终失败 |
| R2 回读失败 | 抛 `R2_OBJECT_MISSING` |
| SHA-256 不一致 | 抛 `R2_SHA256_MISMATCH` / `PLAINTEXT_SHA256_MISMATCH`，拒绝成功 |
| 加密密钥缺失 | `ENCRYPTION_KEY_MISSING`，失败 |
| Workflow 超时 | Workflows 实例失败；状态可能缺失，监控按 stale/unknown 处理 |
| 连续 24h 无成功 | 15 分钟监控在 26 小时阈值触发 `BACKUP_STALE` |

失败状态写入独立 R2；D1 `d1_backup_runs` 可选，表不存在时标记 `degraded`，不阻止 R2 状态。

---

## 11. 测试状态

| 测试 | 结果 | 类型 |
| --- | --- | --- |
| `npm run qa:d1-backup` | **11/11** | Mock（Mock fetch + Mock R2，不访问 Cloudflare） |
| `npm run qa:d1-recovery` | **4/4** | 隔离 node:sqlite 真实导入 |
| `npx wrangler deploy --dry-run` | 通过（695.74 KiB / gzip 152.38 KiB） | 打包验证，未部署 |
| **本地 Workflows 真实执行** | **完成**：runId `247f9281-f769-41d6-97d5-aa0165eae7d6`，5 steps，status `complete` | Miniflare + 本地 R2 + Mock D1 API |
| 本地 R2 回读 | 通过：`sha256_match`，对象 252,953 B | 本地 R2 |
| 本地隔离恢复 | 通过：63 表 / 110 索引 / 74 外键 / 16 迁移 | node:sqlite，`productionTouched:false` |
| Cloudflare 生产 Workflow | **成功**：runId `cf_ff32148d3003f667d8e336ac19fc0b037d484124bb27e6220d7f110cab622ec3`，5 steps | 生产真实执行 |
| Cloudflare 独立 R2 回读 | **通过**：`sha256_match`；对象 100,992 B | `guandao-db-backups` |
| Cloudflare R2 Bucket | **已创建**：`guandao-db-backups`（Standard / APAC） | 未配置公开访问 |
| 生产 Secrets | **已设置**：`D1_REST_API_TOKEN`、`BACKUP_ENCRYPTION_KEY` | Secret 内容未输出 |
| 生产迁移 | **已应用**：0015、0016 | D1 数据量未减少 |
| 生产部署 | **已部署**：`6928916f`，Cron `0 19 * * *` | `/api/health` 200 |
| 生产恢复演练 | **通过（隔离）**：63 表 / 110 索引 / 74 外键 / 16 迁移 | node:sqlite，`productionTouched:false` |
| 告警测试 | **本地 9/9 + 11/11** | Mock fetch，仅证明调用逻辑 |
| **告警真实送达** | **16/16 通过**：webhook.site 真实收到 `guandao.backup.alert` 与 `guandao.data.alert` | 真实外部 HTTPS（`npm run qa:alerts`） |
| 告警生产配置 | **未配置** | `BACKUP_ALERT_WEBHOOK` 仍未设置 |

> 本地 Workflow 使用真实 Workflows runtime、真实本地 SQL 和本地 R2，但 D1 REST API 是
> `scripts/mock-d1-export-server.mjs` 的 Mock，**不是 Cloudflare 生产导出**。
> 它证明 Workflow 代码/步骤/加密/回读链路可执行，不等于生产备份已运行。

### 本地真实执行命令

```bash
# 1) 本地 SQL（真实本地 D1）
npx wrangler d1 export guandao-db --local --output "$TEMP/guandao-phase16-local.sql" -y

# 2) Mock D1 REST API
$env:MOCK_D1_SQL="$TEMP/guandao-phase16-local.sql"
node scripts/mock-d1-export-server.mjs

# 3) 本地 Worker + Workflows binding
npx wrangler dev -c wrangler.backup.local.jsonc --port 8787 --local \
  --var D1_REST_API_TOKEN:local-test-token \
  --var "BACKUP_ENCRYPTION_KEY:<ephemeral-base64>" \
  --var BACKUP_ALERT_WEBHOOK:http://127.0.0.1:8799/webhook

# 4) 触发
npx wrangler workflows trigger guandao-d1-backup-local --local --port 8787 --json

# 5) 取回 R2 对象并恢复验证
npx wrangler r2 object get guandao-db-backups-local/<key> --local --file ...
BACKUP_ENCRYPTION_KEY=... node scripts/verify-d1-backup.mjs --manifest ... --sql ...
```

---

## 12. 当前状态与下一步

**Implemented / Partially Verified**

已满足：Workflow 代码、Mock 测试、本地 Workflows 真实执行、**Cloudflare 生产 Workflow 成功**、
**SQL 写入独立 R2**、**R2 回读 SHA-256 通过**、**隔离恢复 63 表/16 迁移**、Bucket/Secrets/迁移/部署/Cron。

未满足（因此不能 Verified）：

1. ~~**真实告警通知渠道未配置**~~ → **部分关闭（2026-11-07）**：告警**代码链路**已用真实外部
   HTTPS 验通（`npm run qa:alerts` 16/16，webhook.site 实际收到两种 payload）；
   但 Cloudflare 上 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK` **仍未设置**，
   生产故障不会真正外发，仍需所有者提供渠道并部署；
2. Token 的完整权限列表无法通过 API 枚举，只验证了 D1 GET + export 可用；
3. 生产恢复演练是隔离 node:sqlite，不是 D1 原地恢复；
4. Phase 2.1 生产 UI 已于 2026-11-07 只读复测通过（CSS 资产与本机构建同名同字节）。

**已完成的真实备份**：

- runId `cf_ff32148d3003f667d8e336ac19fc0b037d484124bb27e6220d7f110cab622ec3`
- SQL 100,976 B；对象 100,992 B
- 明文 SHA-256 `fbb24c29e9f7...`；对象 SHA-256 `627d4aa8e0ea...`
- 备份状态 `healthy`，`lastSuccessAt 2026-11-07T02:15:31.721Z`
- 无生产数据删除；未运行 `qa:prod`。