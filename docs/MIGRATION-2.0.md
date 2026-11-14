# Guandao OS 2.0 · 数据迁移方案与报告

> 目标：**任何情况下都不丢用户数据**。升级 2.0 不重新创建账号、不丢笔记/文件/备份/主题/组件/插件配置、不重复登记设备。

---

## 1. 原则

| # | 原则 | 落地方式 |
| --- | --- | --- |
| 1 | 先备份 | 迁移前把全部 `guandao.*` 键写入 IndexedDB `backups`，键名 `pre-2.0-<时间戳>` |
| 2 | 再迁移 | 只**新增** `guandao.core.*` 键 |
| 3 | 校验数据 | 每步可选 `verify()`；迁移后比对旧键清单 |
| 4 | 保持旧字段兼容 | 不删除、不改写、不重命名任何 1.x 键 |
| 5 | 失败不删数据 | 失败不提升 `schemaVersion`，下次启动重试 |
| 6 | 幂等 | 每步先检查目标键是否已存在；重复执行不重复写入 |
| 7 | 状态明确 | `journal` 记录每一步的时间、结果、耗时；系统设置可见 |

---

## 2. 版本判定

```
读取 guandao.core.migrations.v1
├─ 存在 → 使用其中 schemaVersion
└─ 不存在
   ├─ detectLegacyUser() === true  → schemaVersion = 1（执行六步迁移）
   └─ detectLegacyUser() === false → schemaVersion = 2（全新安装，不跑迁移）
```

### 2.1 为什么需要 `detectLegacyUser`

1.x 外壳在**每次启动**都会写 `guandao.os.state.v1`、`guandao.os13.v1`、`guandao.os.ach.v1`、
`guandao.os14.apps.v1`、`guandao.os.recent` 等运行态键。如果「存在任意 `guandao.*` 键」
就算老用户，第一次打开 2.0 的新访客会被误判成升级用户，永远看不到首次启动引导
（这一点在 E2E 里真实复现过）。

判定只看「用户内容」：

- 笔记 / 任务 / 日程 / 文件 / 音乐 / 相册 / 游戏记录 / 抽奖 / 专注；
- 自定义主题或自定义工作空间（预设不算）；
- 插件安装记录、社区安装记录、备份元数据；
- 应用中心里安装过可选应用（gallery / reader）；
- `guandao.os.state.v1` 里**真的保存过窗口布局**（`windows` 非空）。

只打开过 1.x、什么都没做的访客会看到引导 —— 这是可接受的产品行为（引导可跳过、不影响数据）。

---

## 3. 六步本地迁移

| # | 步骤 ID | 做什么 | 幂等条件 | 校验 |
| --- | --- | --- | --- | --- |
| 1 | `2.0-core-device` | 延续旧设备名（若存在 `guandao.device.name`），否则由 DeviceManager 首次启动生成 | 已有 `device.v1` 则跳过 | — |
| 2 | `2.0-onboarding-skip` | 老用户标记 `onboarding.completed = true, migrated = true`，不强制重新引导 | 已 completed 则跳过 | 必须读到 completed |
| 3 | `2.0-settings-seed` | 从 `os13` 外观 / `os14.prefs` / 图标状态生成 2.0 设置 | `settings.v1` 已存在则跳过 | — |
| 4 | `2.0-layout-snapshot` | 把 1.x `windows` 快照升级成 `layout.v2` 结构 | 已有 `layout.v2` 则跳过 | — |
| 5 | `2.0-registry-seed` | 写 `apps.seeded` 标记；真正的应用登记在启动阶段按 1.x 安装状态完成 | 已有非空 `apps.v2.records` 则跳过 | — |
| 6 | `2.0-audit-baseline` | 记录迁移来源、目标版本、旧键数量 | 覆盖写（只影响自身） | 基线必须存在且 `legacyKeys` 为数字 |

> 没有为了「版本号好看」而搬运已经符合 2.0 的结构（例如笔记、任务、日历的存储格式在 1.4 之后没变，2.0 原样读取）。

---

## 4. 备份格式

写入 IndexedDB：database `guandao-os14` / store `backups`，键 `pre-2.0-<timestamp>`：

```jsonc
{
  "schema": "guandao-os/local-backup",
  "fromVersion": "1.x",
  "toVersion": "2.0.0",
  "at": 1793871389080,
  "keys": { "guandao.os14.notes.v1": "<原始字符串>", "...": "..." }
}
```

- 存的是**原始字符串**，不是反序列化后的对象 —— 恢复时不会因为结构变化而丢字段；
- 只备份，不自动恢复；恢复入口在数据中心（本地备份历史）；
- 更新中心的「回滚」区会列出最近 5 份 `pre-2.0-*` 快照；
- 隐私模式下 IndexedDB 不可用时，备份失败 → **迁移中止**（不改任何数据）。

---

## 5. 失败处理

| 失败点 | 行为 |
| --- | --- |
| 备份失败 / 返回 null | 迁移不开始，`errors` 写明原因；旧数据零改动 |
| 某一步抛错 | 停止后续步骤；已完成步骤保留（幂等，可重试）；`schemaVersion` 停在最后成功的版本 |
| `verify()` 不通过 | 与抛错同等处理 |
| 迁移后旧键缺失 | 发 `migration:data-missing` 事件 + 诊断日志（不继续伪装成功） |
| 用户清空浏览器数据 | 无法恢复（本地数据只在本机；云端备份需事先创建） |

系统设置 → 系统 → 启动报告会显示 storage 阶段是否失败；更新中心「数据保护」区显示迁移状态与快照数量。

---

## 6. 服务端（D1）迁移

| 迁移 | 内容 | 状态 |
| --- | --- | --- |
| 0001–0012 | 1.x 基线（账号、云盘、设备、备份、隐私、社区、插件、接力、索引） | 已存在；本机已应用 |
| **0013_index_fixes.sql** | 修正索引名冲突；补 `backups` 列表索引、`backup_items` 分页索引、`backup_jobs` 状态索引 | 本机 `wrangler d1 migrations apply --local` 已通过 |
| **0014_sync.sql** | 新增 `sync_entities` 表与两个索引（云同步实体） | 本机已应用；`sync-qa` 20 项在真实表上通过 |
| 线上应用 | `npm run db:migrate:remote` | **未执行**（需要凭据与人工确认） |

`0013` 只新增索引，不改列、不删数据。回滚 = `DROP INDEX` 三条新索引（不写进迁移，按需手工执行）。

`0014` 是**纯新增表**：不触碰 1.x 任何表，回滚 = `DROP TABLE sync_entities`（会丢失云端同步副本，但本地数据仍在）。
旧的 `sync_changes` 死表保持不动，2.0 不读写它。

服务端迁移静态检查（新增）：`npm run check:migrations`

- 编号连续、文件名规范；
- `CREATE INDEX` 必须带 `IF NOT EXISTS`；
- 同名索引定义冲突会失败（两个历史冲突在 allowlist 里，0013 已用新名字补齐）；
- 禁止 `DROP TABLE` / `DROP COLUMN`。

---

## 7. 兼容性验证（本次实际执行）

| 验证 | 结果 |
| --- | --- |
| 全新安装：不跑迁移、引导正常出现 | ✅ E2E `tests/e2e/os20.spec.ts:72` |
| 老用户判定：只有运行态键时不误判 | ✅ 人工复现并修复（`os20/migrations.ts:detectLegacyUser`） |
| 迁移前备份键存在 | ✅ 迁移引擎单测 + 浏览器实测（`pre-2.0-*`） |
| 迁移失败中止且不改数据 | ✅ `tests/unit/platform.test.ts`「备份失败时中止迁移」 |
| 幂等：重复启动不重复写 | ✅ 每步先检查目标键 |
| 旧键完整保留 | ✅ `verifyLegacyPreserved()`；浏览器实测旧键数量一致 |
| 迁移后设置生效 | ✅ E2E 修改 `appearance.material` → 刷新后仍为 `solid` |
| 1.x 安装状态映射到 2.0 注册中心 | ✅ 启动阶段 `seedRegistry()` + E2E registry 统计 |
| D1 0013 可应用 | ✅ 本地 D1 执行成功（5 条语句） |
| D1 0014（同步表）可应用 | ✅ 本地 D1 执行成功；`scripts/sync-qa.mjs` 在真实表上完成 20 项断言 |
| 同步不会改动 1.x 存储键 | ✅ 只读写 `guandao.os14.notes.v1` / `tasks.v1` / `calendar.v1` 与 `guandao.core.sync.*`；不改键名、不改结构 |

---

## 8. 回滚

| 回滚对象 | 方式 | 限制 |
| --- | --- | --- |
| 网站资源（JS/CSS） | 服务端重新部署上一版静态资源 | 客户端无法自行回滚已部署的网站 |
| 2.0 设置 | 系统设置 → 重置设置（只重置 2.0 设置） | 不影响笔记/文件/应用数据 |
| 本地数据 | 数据中心 → 本地备份历史 → 恢复 | 需要事先有备份 |
| 迁移前快照 | IndexedDB `backups` 里的 `pre-2.0-*` | 需要手动恢复，不自动覆盖 |
| D1 结构 | Time Travel 整库回滚 / 手工 `DROP INDEX` | 整库回滚会连同业务数据一起回退 |
| 2.0 数据键 | 删除 `guandao.core.*` 即可回到 1.x 行为 | 会丢失 2.0 的设置与迁移记录，旧数据仍在 |

**明确不能做**：为了「回滚到 1.9」而删除或改写 1.x 的旧键 —— 那才是真正的数据丢失。

---

## 9. 迁移报告（本机实跑）

```
[storage 阶段] 迁移报告
  from=1 to=2
  applied=true
  backupKey=pre-2.0-1793871389080
  steps:
    2.0-core-device        applied  → v2
    2.0-onboarding-skip    applied  → v2
    2.0-settings-seed      applied  → v2
    2.0-layout-snapshot    applied  → v2
    2.0-registry-seed      applied  → v2
    2.0-audit-baseline     applied  → v2
  旧键核验：全部存在
```

- 全新安装的浏览器：`from=2 to=2`，`steps=[]`，`applied=false`（无需迁移）。
- 线上用户的迁移报告需要在 Preview/Production 部署后按同一路径验证；本次**未执行**线上迁移。