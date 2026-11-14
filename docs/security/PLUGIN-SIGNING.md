# 插件发布者签名（Ed25519）

> Phase 3.1 交付物。状态：服务端验签、客户端验签、CLI 签名、市场与插件管理器信任徽标、单元测试与真实 Worker E2E 均已实现并本地通过；**尚未在生产环境验证**（本阶段不做生产部署）。详见文末「证据等级」。

本文档描述 **现在真实存在** 的机制。凡属设计但未实现的，单独标注「未实现」。

---

## 1. 问题与威胁模型

改造前，插件供应链只有「完整性」没有「来源」：

| 环节 | 改造前 | 风险 |
| --- | --- | --- |
| 上传 `POST /api/developer/plugins/:id/versions` | 只校验包格式、体积、路径、`filesDigest` | 任何能登录的人都能上传任意内容到自己的插件下 |
| 存储 | R2 存原始包 JSON，DB 存 `sha256(package)` | 只保证「服务端存的和客户端取的一致」 |
| 下载 `GET /api/plugins/:id/package` | 重算 R2 对象 sha256 与 DB 比对 | 防传输/存储损坏，不防「服务端主动返回伪造包」 |
| 安装 `POST /api/plugins/install` | 客户端声明的 `packageHash` 必须等于 DB 里的 `package_sha256` | 同上 |
| 客户端 | `verifyBundle()` 复核双摘要 | 同上 |

也就是说：**D1 与 R2 是唯一信任根**。能改写 D1/R2 的人（管理员误操作、DB 泄漏后被改、内部越权）可以静默替换任何插件包，而所有校验都会通过。

Ed25519 发布者签名的目标：让**发布者离线持有的私钥**成为独立于服务端的信任根。服务端被攻破时，攻击者仍无法为已有版本伪造新签名（只能拒绝服务）。

签名**不替代** SHA-256：摘要证明「内容没变」，签名证明「谁认可了这份内容」。两者缺一不可。

---

## 2. 被签内容（规范化的唯一来源）

实现：`shared/plugin-signature.js`（纯 ESM，无第三方依赖，Worker / 浏览器 / CLI 共用同一份代码）。

### 2.1 信封字段

```json
{
  "spec": 1,
  "alg": "ed25519",
  "keyId": "ggk_915262afb3b7a0fa",
  "publisherId": "user_xxx",
  "pluginId": "com.example.hello",
  "version": "1.0.0",
  "format": "guandao-plugin",
  "formatVersion": 1,
  "filesDigest": "<64 hex>",
  "manifestDigest": "<64 hex>",
  "signedAt": 1760000000000,
  "sig": "<64 字节签名的 base64url>"
}
```

- `publisherId` = `users.id`（插件 `plugins.developer_id`），不是 GitHub 登录名。
- `filesDigest` = `sha256(canonicalFilesJson(files))`，**直接复用** `shared/plugin-spec.js:716` 的既有实现，避免签名与包校验对文件排序/编码产生两种理解。
- `manifestDigest` = `sha256(canonicalJson(manifest))`。
- `signedAt` 是毫秒时间戳。

### 2.2 签什么、怎么序列化

**签名对象 = 信封去掉 `sig` 字段后的 `canonicalJson` 的 UTF-8 字节**，不是原始包文本。

理由：包是缩进过的人类可读 JSON（CLI 用 `JSON.stringify(obj, null, 2)`），逐字节签名要求 CLI、服务端、客户端三端对换行/缩进完全一致，实践中必然漂移；而且签名要嵌在包里，签包内文本会形成循环依赖。所以签的是**语义**，由规范化序列化保证三端一致。

规范（`shared/plugin-signature.js`）：

- 对象键按 `Object.keys().sort()` 升序，无空格，`JSON.stringify` 规则。复用 `shared/plugin-spec.js:305 canonicalJson`。
- v1 **只允许**：字符串、非负整数、布尔值。禁止浮点、`null`、数组、嵌套对象、自由文本。因此不存在「浮点格式差异」「Unicode 归一化差异」「null 与缺失的歧义」。
- 所有 `SIG_FIELDS` 必须存在且非空；**缺字段即非法，不做默认值填充**。
- 字符串只允许 `[A-Za-z0-9._:/-]`（ID、版本、摘要、base64url），从根上排除 Unicode 与转义歧义。
- `spec` 是签名载荷格式版本，当前为 `1`。未知 `spec` → `SIG_UNSUPPORTED_SPEC`，直接拒绝。

### 2.3 密钥 ID

`keyId = "ggk_" + first16hex(sha256(raw 32 字节公钥))`。

派生规则在共享模块里，CLI 生成的 `keyId`、服务端登记的 `keyId`、客户端从服务端拿到并用于查表的 `keyId` 是同一个函数算出来的；服务端登记时**强制** `keyId === keyIdForPublicKey(publicKey)`，不匹配直接 `KEY_ID_MISMATCH`，因此不存在「同一把公钥挂两个 ID」或「ID 与公钥不符」的状态。

---

## 3. 密钥生命周期

### 3.1 三类材料严格分离

| 材料 | 存放位置 | 谁能读 |
| --- | --- | --- |
| Publisher Private Key（pkcs8，base64url） | 发布者本地密钥文件（CLI `keygen` 生成，`mode:0o600`） | 只有发布者 |
| Publisher Public Key | D1 `publisher_keys.public_key` | 公开（`GET /api/developer/keys`、下载响应里的 `publisherKeys`） |
| Server Secret（`GITHUB_CLIENT_SECRET` 等） | Cloudflare secret | 仅 Worker |
| Signature Metadata | D1 `plugin_versions.signature_*`、包内 `bundle.signature` | 客户端可见 |

**服务端从不生成、从不接收、从不存储私钥**。`keygen` 完全在本地执行，只打印公钥、keyId 与密钥文件路径。

### 3.2 生成（`node cli/guandao.mjs keygen`）

- WebCrypto `Ed25519` 生成密钥对，导出 raw 公钥（32 B）与 pkcs8 私钥（48 B）。
- 写 `{type:"guandao-publisher-key", version:1, spec:1, algorithm:"ed25519", keyId, publicKey, privateKey, label, createdAt}`，文件权限 `0o600`。
- 目标文件已存在则**拒绝覆盖**，避免误撕已有密钥。

### 3.3 登记（`node cli/guandao.mjs keys register --key <file>`）

`POST /api/developer/keys`：

```json
{ "publicKey": "<base64url>", "keyId": "ggk_...", "issuedAt": 1760000000000,
  "proof": "<Ed25519(registerProofPayloadText({userId,keyId,publicKey,issuedAt}))>",
  "label": "main laptop" }
```

- `proof` 证明调用者**确实持有私钥**（不是随便贴一串公钥），`checkRegisterProof` 还有 10 分钟时间窗。
- 同一把公钥只能属于一个账号（`UNIQUE idx_publisher_keys_public`），已属他人 → `KEY_TAKEN 409`。
- 单账号活跃密钥上限 10 把。
- 服务端只保存公钥与状态，写审计 `plugin.key_register`（detail 只记 keyId）。

### 3.4 轮换

1. 本地 `keygen` 生成新密钥；
2. `keys register` 登记新公钥；
3. 用新密钥 `sign` + 发布新版本；
4. 旧密钥在**确认没有在途发布**后 `keys revoke <keyId>`；
5. 撤销是**动态生效**的：下载与安装每次都会重新读 `publisher_keys.status`，不是「上传时验过就永久放行」。

### 3.5 撤销

`POST /api/developer/keys/:keyId/revoke` → `status='revoked'`、`revoked_at`、`revoke_reason`。

撤销后：该密钥签名的所有版本在下载与安装两条路径上都被拒绝（`SIG_KEY_REVOKED`）。已安装的旧版本不会自动被卸载（那属于运行期治理，不在本阶段范围）；但下载/重装/更新都会失败。

### 3.6 私钥丢失

- 私钥不在服务端，**无法找回**。
- 处置：登记新密钥 → 用新密钥重新签一个新版本号（不能复用旧版本号，`VERSION_EXISTS`）→ 撤销旧密钥 → 旧版本从市场下架/隐藏。
- 不存在「服务端代签恢复」通道，这是设计选择：任何代签通道都会把服务端重新变成信任根。

---

## 4. 签名流程

```
Plugin Source
  → Manifest Validation            (shared/plugin-spec.js validateManifest)
  → Build / makeBundle             (cli/guandao.mjs makeBundle)
  → Package Generation             (files + filesDigest)
  → Canonical Package Digest       (bundleDigests)
  → Ed25519 Signing                (crypto.subtle.sign)
  → Signature Metadata             (bundle.signature)
  → Upload & Review                (POST /api/developer/plugins/:id/versions)
  → Server-side 验签               (worker/api/plugins/signature.js resolveSignature)
  → 入库 signature_status          (plugin_versions)
```

CLI：

```bash
node cli/guandao.mjs create ./my-plugin --id com.example.hello
node cli/guandao.mjs keygen --out ./publisher-key.json
node cli/guandao.mjs keys register --key ./publisher-key.json --token <session-cookie>
node cli/guandao.mjs sign . --key ./publisher-key.json --publisher <users.id>
node cli/guandao.mjs publish . --key ./publisher-key.json
```

`sign` 输出 `dist/<id>-<version>.gplug`（内含 `signature` 顶层键）。`publish` 不带 `--key` 时仍可发布，但会打印「未签名发布」警告，并落地为 `signature_status='unsigned'`。

---

## 5. 服务端验签

`worker/api/plugins/signature.js`：

- `resolveSignature(env, {bundle, signature, plugin, version})` → `{status: "verified"|"unsigned"|"invalid", code, keyId, signedAt, envelope, errors}`。
- 判定顺序：
  1. 没有签名 → `unsigned`（`SIG_MISSING`，阶段 A 允许）；
  2. 信封结构非法 → `invalid`；
  3. 查 `publisher_keys` 找不到 keyId → `SIG_KEY_UNKNOWN`；
  4. `key.user_id !== plugin.developer_id` → `SIG_IDENTITY_MISMATCH`（防冒用他人公钥）；
  5. `key.status !== 'active'` → `SIG_KEY_REVOKED`；
  6. `verifyBundleSignature` 校验 Ed25519 + 三个摘要 + pluginId/version/publisherId 一致；
  7. 任何一步失败 → `invalid`，**不降级为 unsigned**。

接入的三条路径：

| 路径 | 行为 |
| --- | --- |
| 上传 `uploadVersion` | 先 `inspectBundle`，再 `resolveSignature`；`invalid` → HTTP 422 `SIGNATURE_INVALID`，**不落库** |
| 下载 `pluginPackage` | 先比对 R2 对象 sha256 与 DB（`PACKAGE_INTEGRITY_ERROR`），再动态验签；`invalid` → 409 `SIGNATURE_INVALID`；`verified` 时刷新 `last_used_at` |
| 安装 `installPlugin` | `signature_status='invalid'` → 409；`signature_key_id` 对应的密钥不存在/不属作者/已撤销 → 409 |

响应里客户端拿到的是「信任状态 + 公钥列表」：

```json
{
  "signature": { "status": "verified", "keyId": "ggk_...", "signedAt": 1760000000000, "payload": { ... } },
  "publisherKeys": [ { "keyId": "ggk_...", "publicKey": "...", "algorithm": "ed25519", "status": "active" },
                     { "keyId": "ggk_...", "publicKey": "...", "status": "revoked", "revokedAt": 1760000000000 } ]
}
```

列表卡片与详情页的 `security.signature` 也带同一份信任状态（`mapPluginCard` / `mapVersion`）。

---

## 6. 客户端验签

`src/lib/plugins/signature.ts`：`verifyPackageSignature()`，**不信服务端的结论，自己重算**。

1. `sha256(packageJson)` 必须等于响应里的 `checksum` → 否则 `PACKAGE_DIGEST_MISMATCH`；
2. JSON 解析失败 → `PACKAGE_MALFORMED`；
3. 重算 `filesDigest` 与包内声明比对 → `FILES_DIGEST_MISMATCH`；
4. 无签名 → `unsigned`；
5. `keyId` **只在服务端返回的 `publisherKeys` 里查**（绝不接受签名自带公钥，否则等于没验）；
6. 该 key 必须 `active`；
7. `verifyBundleSignature` 校验 Ed25519 与 pluginId/version/publisherId/双摘要；

接受路径（`src/lib/plugins/registry.ts`）：云端恢复 `refreshFromServer`、市场安装 `installFromMarket`、更新 `updatePlugin`、回滚 `rollbackPlugin`，四条全部验签后才写入 `InstallRecord`。`invalid` 一律抛错，不写本地存储。

**信任状态展示**：市场列表卡片与详情页（`src/lib/plugins/market.ts`）、插件管理器「已安装」列表与详情（`src/lib/plugins/manager.ts`）都使用 `trustLabel()` / `trustDetail()` 显示同一套状态；管理器详情页额外显示签署时间。本轮同时修复了管理器 `listView()` 的真实 UI bug：当 `tab === "installed"` 且存在安装记录时，函数会穿透到 policy 分支，导致「已安装」标签页看不到列表。

---

## 7. 旧插件兼容（阶段 A：Optional Signature）

| 情况 | 服务端 | 客户端 | UI |
| --- | --- | --- | --- |
| 无签名旧包 | `signature_status='unsigned'`，下载/安装都放行 | `status: "unsigned"`，照常安装 | 「未签名」徽标（`is-warn`） |
| 签名正确 | `verified` | 复核后 `verified` | 「已签名」（`is-ok`） |
| 签名存在但任何一步失败 | 409/422 拒绝 | 拒绝 | 「签名无效」（`is-warn`） |

- **「签名无效」与「缺少签名」永远是两个不同状态**（`invalid` vs `unsigned`），不会被合并成同一个错误。
- 阶段 B（强制签名）**本阶段未实现、未启用**。将来启用需要单独宣布并给出迁移窗口。
- 兼容期不删除任何未签名插件数据（本地 `InstallRecord` 里 `signature` 字段是可选新增）。

---

## 8. 错误码

| 错误码 | 含义 | HTTP |
| --- | --- | --- |
| `SIG_MISSING` | 没有签名（→ unsigned，非错误） | — |
| `SIG_UNSUPPORTED_SPEC` | 签名载荷版本不支持 | 409/422 |
| `SIG_UNSUPPORTED_ALGORITHM` | 算法不是 ed25519 | 409/422 |
| `SIG_MALFORMED` | 信封结构非法 | 409/422 |
| `SIG_KEY_UNKNOWN` | keyId 未登记 | 409/422 |
| `SIG_KEY_REVOKED` | 公钥已撤销 | 409 |
| `SIG_IDENTITY_MISMATCH` | 公钥不属于该作者 / publisherId 不符 | 409 |
| `SIG_DIGEST_MISMATCH` | 摘要与签名内容不符（包/Manifest 被替换） | 409/422 |
| `SIG_VERIFY_FAILED` | Ed25519 验证失败 | 409/422 |
| `SIG_TIME_ANOMALY` | signedAt 异常（未来时间等） | 409/422 |
| `PACKAGE_DIGEST_MISMATCH` | 包文本 sha256 与 checksum 不符 | 客户端拒绝 |
| `PACKAGE_INTEGRITY_ERROR` | R2 对象与 DB 记录的 sha256 不符 | 409 |
| `PACKAGE_MALFORMED` | 包不是合法 JSON | 客户端拒绝 |
| `FILES_DIGEST_MISMATCH` | 文件摘要不符 | 客户端拒绝 |
| `SIGNATURE_INVALID` | 上传/下载路径的对外错误码，`details.signatureCode` 给出具体原因 | 422/409 |
| `SIGNATURE_KEY_REVOKED` / `SIGNATURE_KEY_UNKNOWN` | 安装路径的对外错误码 | 409 |

安全事件记录：`plugin_audit_logs` 里有 `plugin.version_upload`（含 `signatureStatus`/`signatureKeyId`）、`plugin.key_register`、`plugin.key_revoke`。**日志不记录私钥、不记录完整签名材料。**

---

## 9. 数据库变更

`migrations/0017_plugin_signatures.sql`（只增不删，回退到 Phase 2.1 不需要改表）：

- 新表 `publisher_keys`：`key_id` PK（`ggk_` 前缀 + 20 字符）、`user_id` FK→users(CASCADE)、`public_key`、`algorithm`（仅 ed25519）、`status`（active/revoked）、`label`、`created_at`、`revoked_at`、`revoke_reason`、`last_used_at`；唯一索引 `idx_publisher_keys_public`。
- `plugin_versions` 增列：`signature_json`、`signature_status`（默认 `unsigned`）、`signature_key_id`、`signed_at`。

---

## 10. 测试证据

| 层级 | 文件 | 数量 | 状态 |
| --- | --- | --- | --- |
| 共享模块单测 | `tests/unit/plugin-signature.test.ts` | 40 | 通过 |
| 服务端门禁单测（假 DB） | `tests/unit/plugin-signature-server.test.ts` | 11 | 通过 |
| 真实 Worker E2E（HTTP + 真 D1/R2） | `tests/e2e/plugin-signature.spec.ts` | 19 | 通过 |

E2E 覆盖：正确签名、公钥列表含已撤销密钥、包替换、签名字节错、算法不支持、已撤销公钥、冒用他人公钥、包摘要被改、未签名旧包容忍、安装三条路径、未登录拒绝、市场列表/详情信任状态、Manifest 摘要可独立复算、版本降级、重复发布、伪造签名上传被拒且不落库。

E2E 夹具由 `scripts/e2e-server.mjs` 通过**真实公开 API**（创建插件→上传→提交→审核→撤销）生成，不是直接往数据库塞行；唯一例外是「篡改类」夹具必须事后改 DB 行才能模拟被攻破的服务端，这一点在测试文件里逐条注明。

复现：

```bash
npm run test:unit                     # 含签名相关 51 个单测
npx playwright test --project=worker tests/e2e/plugin-signature.spec.ts
```

---

## 11. 残余风险（未解决，如实记录）

1. **安装接口的信任模型依赖 D1**：`POST /api/plugins/install` 只比对「客户端声明的 packageHash」与 DB 里 `plugin_versions.package_sha256`，不读 R2、不重算。因此若 D1 被改而 R2 未改，安装会成功而下载会失败（E2E 里 `install integrity` 返回 200 就是这个原因）。真正的完整性闸门在下载接口；这是既有设计，本阶段未改变。
2. **签名信任根仍有服务端成分**：客户端从服务端拿 `publisherKeys`，服务端若整体被控可以给出「攻击者公钥 + 攻击者签名」的自洽组合。要彻底解决需要把公钥固定到插件市场之外（如 OS 内置信任列表 / 证书透明度式日志），本阶段未实现。
3. **私钥保护责任在发布者**：CLI 只做到 `0o600` 文件权限与拒绝覆盖，没有硬件密钥、没有口令加密。`keygen` 不提供口令保护（未实现）。
4. **撤销不追溯已安装**：已安装的旧版本不会在撤销时被强制禁用。
5. **未在生产验证**：所有证据都是本地 `wrangler dev --local` + 本地 D1/R2。
6. **`signedAt` 只做异常检测**，没有可信时间源；回填历史版本依赖发布者诚实。

---

## 12. 生产启用所需的人工操作（本阶段未执行）

1. 执行迁移：`wrangler d1 migrations apply guandao-db --remote`（新增 `0017`）。
2. 确认 R2 绑定不变（签名不新增存储桶）。
3. 发布后校验：用一个测试插件走完整签名发布流程，确认 `plugin_versions.signature_status='verified'`，并确认未签名旧包仍可安装（阶段 A）。
4. 若要收紧为强制签名，需另开阶段并宣布迁移窗口 —— **不是** 本阶段的动作。