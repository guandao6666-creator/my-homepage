> **Phase 1.6 更新（2026-11-07）**：本文件描述的是本地 scripts/db-backup.mjs（wrangler 导出）方案，仍可用于本地/应急；生产每日独立 R2 归档改用 Workers Workflow + D1 REST API，见 [operations/D1-BACKUP.md](operations/D1-BACKUP.md)。本阶段未启用生产 Workflow。

# D1 整库备份与恢复

**状态**：脚本与本地验证完成；**生产每日自动备份尚未启用**（缺 GitHub Secrets / R2 上传授权）。
**重要**：Guandao OS 的“用户备份”是应用级数据备份，**不是** D1 整库备份。

---

## 1. 现状与目标

| 项 | 现状 |
| --- | --- |
| D1 | `guandao-db` / `9c89b111-bd89-47a6-8615-2c838993ede5`，Binding `DB` |
| R2 | `guandao-files`，Binding `FILES` |
| 已有备份 | 应用内 `backups`（笔记/任务/文件等），不是整库 |
| D1 Time Travel | 平台提供，保留期由 Cloudflare 决定；**不能替代每日导出** |
| 目标 | 每日整库导出、SHA-256、AES-256-GCM、私有前缀、可验证、可隔离恢复 |

**注意**：D1 导出包含 `users`、`sessions`、`oauth_states`、`security_events` 等敏感数据；
备份文件视为最高敏感级别。

---

## 2. 架构

```
wrangler d1 export (--remote)
        │
        ▼
  整库 SQL（临时文件，权限受限）
        │
        ├─ SHA-256（明文）
        ├─ gzip
        ├─ AES-256-GCM（D1_BACKUP_KEY）
        └─ 写本地 backups/d1/（gitignored）
                 │
                 └─（可选）wrangler r2 object put
                         guandao-files/backups/d1/<id>.sql.gz.enc
                         guandao-files/backups/d1/<id>.sql.gz.json
```

- **不新建 R2 桶**：复用现有 `guandao-files` 的独立前缀 `backups/d1/`；**当前未验证该桶是否存在公开域名/公开访问**，上传前必须由所有者确认桶为私有。
- **不上传明文**：`--upload` 强制要求 `--encrypt`。
- **不覆盖历史**：文件名含 UTC 时间戳 + 模式；写入使用临时文件 + rename。
- **不自动恢复**：恢复检查只在隔离 SQLite 中执行；生产恢复必须人工确认。

---

## 3. 命令

```bash
# 本地（默认，不接触生产 D1）
node scripts/db-backup.mjs backup --local --dir backups/d1

# 加密本地备份
export D1_BACKUP_KEY="$(openssl rand -base64 32)"
node scripts/db-backup.mjs backup --local --encrypt --dir backups/d1

# 生产整库备份（显式确认；导出只读）
node scripts/db-backup.mjs backup --remote --confirm-production --encrypt \
  --dir backups/d1 --retention-days 30

# 上传到现有 R2 私有前缀（必须加密）
node scripts/db-backup.mjs backup --remote --confirm-production --encrypt --upload

# 验证 SHA-256 / 解密 / SQL 结构 / 行数
node scripts/db-backup.mjs verify --meta backups/d1/<id>.json

# 在隔离 SQLite 中执行并对比表/索引/外键/行数（不碰生产）
node scripts/db-backup.mjs restore-check --meta backups/d1/<id>.json

# 历史备份列表
node scripts/db-backup.mjs list --dir backups/d1
```

### 环境变量

| 变量 | 用途 | 是否必须 |
| --- | --- | --- |
| `D1_BACKUP_KEY` | base64 编码的 32 字节 AES-256 密钥 | 加密/上传时必须 |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions / 远程导出使用 | 自动备份时必须 |
| `CLOUDFLARE_ACCOUNT_ID` | 同上 | 自动备份时必须 |

密钥生成：

```bash
openssl rand -base64 32
```

密钥只能放入 GitHub Actions Secrets 或本机受保护的临时环境变量，**不得写入仓库、文档、CI 日志**。

---

## 4. 自动调度

新增 `.github/workflows/db-backup.yml`：

- 每日 `03:15 UTC`（北京时间 11:15）；
- 支持 `workflow_dispatch` 手动触发；
- 需要 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`D1_BACKUP_KEY`；
- 缺少 Secrets 时 workflow **明确失败**，不会静默跳过；
- 不把备份文件上传为 GitHub Artifact（避免敏感数据扩散）。

**当前状态**：Secrets/迁移/Bucket/部署已完成；生产 Workflow 已成功备份，Cron 每日 UTC 19:00 运行。

---

## 5. 保留策略

- 默认保留最近 **30 天**每日备份；
- `list` 会标记 `expired`，但**不会自动删除**；
- 删除旧备份需要单独的人工/受控任务，且必须确认新备份已成功、已验证；
- 本专项**未删除任何备份/R2 对象**。

---

## 6. 本地恢复测试（已完成）

环境：本机 **本地 D1**（`.wrangler/state`），未接触生产。

| 步骤 | 结果 |
| --- | --- |
| `backup --local` | 成功，SQL 62 表 / 519 行，归档 36,764 B |
| `verify` | 成功：明文 SHA-256、归档 SHA-256、gzip、SQL 结构一致 |
| `restore-check` | 成功：隔离 SQLite 执行，表/索引/外键/行数与元数据一致 |
| 加密备份 | 成功：AES-256-GCM，`verify`/`restore-check` 通过 |
| 篡改测试 | 归档改 1 字节后 `verify` 失败（SHA-256） |
| 不完整 SQL | `assertSqlLooksComplete` 拒绝 |
| 保留期 | 2 天内不删除，31 天标记过期 |
| 自动测试 | `npm run qa:db-backup` **8/8** |

> 生产 D1 **没有**执行备份/恢复测试；生产恢复只能在明确授权后通过 D1 Time Travel 或人工导入。

---

## 7. 生产恢复（人工，不在本专项执行）

1. 确认要恢复的备份 `id`，先运行 `verify` 与 `restore-check`；
2. 记录当前生产状态与 D1 bookmark；
3. 由项目所有者授权，选择：
   - Cloudflare D1 Time Travel 恢复到指定时间点；或
   - 在隔离 D1 导入 SQL，校验后再切流量；
4. 恢复后核对 `users/sessions/devices/files/backups/sync_entities` 与迁移版本；
5. 记录恢复审计（时间、备份 id、SHA-256 前 12 位、操作者）；
6. 绝不把恢复命令放进自动备份任务。

---

## 8. 未完成 / 需要所有者

1. 在 GitHub 仓库配置 3 个 Secrets；
2. 确认 `CLOUDFLARE_API_TOKEN` 至少有 D1 Read + R2 Write（仅限该桶）；
3. 手动触发一次 `db-backup` workflow，确认 R2 前缀出现 `.enc` + `.json`；
4. 在另一台机器/隔离环境下载并 `verify` 一次，确认密钥可恢复；
5. 决定 30 天保留策略的清理责任人（本专项不删除）。

在上述完成前，状态只能写 **Implemented / 本地已验证、生产未启用**。