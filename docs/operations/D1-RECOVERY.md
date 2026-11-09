# D1 恢复与隔离验证

**状态**：本地 + 生产备份的隔离恢复已验证；**生产原地恢复未执行、禁止执行**。
**重要**：恢复是破坏性操作，必须由项目所有者单独授权。

---

## 1. 恢复层级

| 层级 | 方式 | 适用 | 限制 |
| --- | --- | --- | --- |
| 1 | D1 Time Travel | 最近 30 天（Paid）/ 7 天（Free）内的时间点 | 平台内覆盖式恢复；需 bookmark/时间戳 |
| 2 | 独立 R2 SQL 归档 | 超过 Time Travel 保留期，或需要离线取证 | 需要解密密钥；需导入隔离库验证 |
| 3 | 应用用户备份 | 单个用户/笔记/文件 | **不是整库备份**，不能用于账号/Session 恢复 |

当前 `guandao-db` 的只读 API 检查为 `version: production`，支持 Time Travel。
当前 bookmark 会随平台维护推进，恢复前必须重新查询。

---

## 2. 隔离验证（本阶段已完成）

工具：

```bash
BACKUP_ENCRYPTION_KEY="<base64-32B>" \
node scripts/verify-d1-backup.mjs \
  --manifest ./run.manifest.json \
  --sql ./run.sql.enc \
  --report ./recovery-report.json
```

它会：

1. 校验 manifest schema；
2. 校验 R2 对象 SHA-256；
3. AES-256-GCM 解密；
4. 校验明文 SQL SHA-256；
5. 拒绝空/过短/无 `CREATE TABLE`/含 NUL 的 SQL；
6. 在 **node:sqlite 内存库**中执行整库 SQL；
7. 输出表数、索引数、外键数、迁移数、各表行数；
8. 报告 `isolated: true`、`productionTouched: false`。

### 本地结果

- `npm run qa:d1-recovery`：**4/4**；
- 正常加密 SQL 可导入；
- 对象 SHA 不一致：拒绝；
- 不完整 SQL：拒绝；
- 表/索引/外键/迁移/行数可读取；
- 全程不连接生产 D1。

### 本地真实 Workflow 产物验证

- Workflow run：`247f9281-f769-41d6-97d5-aa0165eae7d6`
- 本地 R2 对象：`daily/2026/11/07/…sql.enc`，252,953 B
- 回读对象 SHA：`sha256_match`
- 隔离恢复：**63 表 / 110 索引 / 74 外键 / 16 迁移**
- 报告：`isolated: true`、`productionTouched: false`

D1 REST API 在该测试中是 Mock；这不等于 Cloudflare 生产备份/恢复已验证。

### 生产真实备份的隔离恢复

- 备份 run：`cf_ff32148d3003f667d8e336ac19fc0b037d484124bb27e6220d7f110cab622ec3`
- R2 对象：`daily/2026/11/07/...sql.enc`，100,992 B
- 明文 SQL：100,976 B；S3 对象 SHA `627d4aa8e0ea...`；`sha256_match`
- node:sqlite：**63 表 / 110 索引 / 74 外键 / 16 迁移**
- `isolated: true`、`productionTouched: false`
- 生产 D1 未被导入、未被覆盖。

> 这是生产备份在隔离 SQLite 中的恢复验证，不是生产原地 Time Travel 恢复。

> 这不是“生产恢复演练”。生产恢复未执行，也不在本阶段授权范围内。

---

## 3. 从 R2 取回备份（人工）

1. 只在受控机器操作，使用只读凭据；
2. 从 `guandao-db-backups` 下载：
   - `daily/YYYY/MM/DD/<runId>.sql.enc`
   - 同目录 `<runId>.manifest.json`
3. 不允许把文件放到公开目录、仓库、聊天工具或普通网盘；
4. 先运行上面的 `verify-d1-backup.mjs`；
5. 验证通过后再讨论恢复；失败则保留文件与报告，不尝试“修一修再导入”。

---

## 4. 生产恢复流程（仅所有者，未执行）

### 4.1 先记录现场

```bash
npx wrangler d1 time-travel info guandao-db
npx wrangler d1 info guandao-db
```

记录当前 bookmark、数据库大小、迁移版本；导出/保存当前状态作为 undo 依据。

### 4.2 选择恢复方式

**A. Time Travel（优先，若在保留期内）**

```bash
npx wrangler d1 time-travel restore guandao-db --timestamp=<UNIX 或 RFC3339>
```

- 这是覆盖式破坏操作；
- 会取消 in-flight 查询；
- 返回 undo bookmark，必须立即记录；
- 不得在自动任务中执行。

**B. 独立 R2 SQL 归档**

1. 在隔离 D1（独立账号/独立 database，或本地 D1）导入；
2. 先在隔离环境运行 `verify-d1-backup.mjs` 与结构检查；
3. 对比 `d1_migrations`、表数量、关键表行数、外键、索引；
4. 由所有者确认后再决定生产导入方案；
5. 不直接把 SQL 导入生产 `guandao-db`。

### 4.3 恢复后核验

- `users / sessions / devices`；
- `d1_migrations` 是否完整；
- `account_deletion_audit` / `data_deletion_jobs` 是否符合预期；
- `/api/health`、`/api/auth/status`；
- 登录与关键读写路径；
- 记录恢复时间、备份 runId、SHA-256 前 12 位、操作者。

---

## 5. 禁止事项

- 不在本阶段执行生产恢复；
- 不用 Time Travel 做“测试”；
- 不在生产库执行 `verify-d1-backup.mjs`（它只接受本地文件）；
- 不把解密密钥写入命令行历史/报告；
- 不删除旧备份来“腾空间”；
- 不在根因未确认时用恢复掩盖证据。

---

## 6. 状态

| 项 | 状态 |
| --- | --- |
| 隔离恢复验证 | **已完成（本地 node:sqlite）** |
| 生产备份文件真实取回 | **未执行**（Bucket 未创建） |
| 生产恢复演练 | **未执行（禁止）** |
| Time Travel 可用性 | 已确认 production / 30 天或 7 天（取决于套餐） |
| 生产恢复授权 | 需要项目所有者单独确认 |