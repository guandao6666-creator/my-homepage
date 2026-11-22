# Guandao OS 2.0.6 · Shell Proof

- **版本**：2.0.6
- **代号**：Shell Proof（外壳取证）
- **日期**：2026-11-22
- **类型**：补丁版本
- **上游**：2.0.5 Param Budget
- **状态**：**Implemented / Verified（本地）**，生产未部署（Blocked，等上线授权）

---

## 1. 为什么有这一版

2.0.5 之后我用只读子智能体审计了前端外壳（`src/lib/os13.ts`、`src/lib/os20/`），
它们在「代码读起来可疑」之外还找出了五条能直接讲清触发条件的缺陷。
共同点是：**都属于外壳层的状态/渲染问题，服务端接口与数据库结构一行没动**——
所以放在补丁版本里，不升 minor。

这五条按影响排序：

| # | 问题 | 触发者 | 后果 |
| --- | --- | --- | --- |
| 1 | 社区壁纸标题直接拼进 `innerHTML` | 任意发壁纸帖的人 | 安装者在设置页被存储型 XSS |
| 2 | 升级迁移把布局快照的 viewport 写成 `0×0` | 1.x 老用户升级 | 窗口比例放大 1440 倍后全被夹到右下 |
| 3 | 「清空本机数据」删的是不存在的 key | 点「清空」的用户 | IndexedDB 壁纸 blob 全留在本机 |
| 4 | 网格拖拽用「左上角阈值」选落点 | 拖图标的用户 | 永远插到第一个图标之前，顺序保存错误 |
| 5 | `applyLook()` 无条件关闭壁纸取色 | 选「自动」强调色的人 | 「自动」无法恢复；改材质也会误关 |

第一轮之后又派了两个只读审计子智能体（`audit-worker-b` 看 Worker、`audit-os14-c` 看社区与
桌面应用），各交回 7 条。其中能复现、且改动面可控的六条并入本版；

| # | 问题 | 触发者 | 后果 |
| --- | --- | --- | --- |
| 6 | 市场封面的 `preview` 拼进 `style="…url('…')"` | 上架应用的人 | 任何打开市场的人被 CSS 声明注入 |
| 7 | 评论「加载更多」不校验作品身份 | 快速切换作品的人 | A 的评论被写进 B 的面板 |
| 8 | 发布权限接口不要求管理员 | 审核员 | 可自行解封/封禁，包括其他审核员 |
| 9 | 笔记/任务读取不校验字段形状 | 有旧本地数据的人 | 首页 `TypeError`，任务页崩溃 |
| 10 | 通知分页把本页条数当总数 | 点「下一页」的人 | 「共 20 个条通知」，下一页空状态 |
| 11 | 错误面板「重试」只认两个视图 | 创作者页/搜索页出错的人 | 重试变成「作品不存在」 |
| 12 | 幻灯片计时器不随灯箱关闭 | 看幻灯片的人 | Esc 关掉 4.2 秒后自动弹回 |

其余八条（`deletePost` 不结算举报、`view`/下载计数可重放、绕过审核把草稿重新公开、
社区图片上传配额 TOCTOU、reauth 票据先消费后校验）写进 §6 的未修边界，没有静默丢弃。

---

## 2. 逐条改动

### 2.1 壁纸标题转义（存储型 XSS）

`src/lib/os13/wall-card.ts`（新增）：

```ts
export function wallCardHtml(wall: WallCardWall, state: WallCardState): string {
  const id = escapeAttr(wall.id);
  const name = escapeAttr(wall.name);
  const text = escapeHtml(wall.name);
  const thumb = wall.custom ? safeUrl(wall.thumb, { allowBlob: true }) : safeUrl(wall.thumb);
  const preview = thumb
    ? `<img src="${escapeAttr(thumb)}" alt="${name}" loading="lazy" decoding="async" />`
    : `<span class="wc-void">自定义</span>`;
  …
}
```

- 名字同时出现在「带引号的属性」和「文本节点」两种上下文里，两处分别用
  `escapeAttr` / `escapeHtml`，不再靠调用方自觉。
- 预览地址先过 `safeUrl`（`javascript:` 一律拒绝，`blob:` 只对自定义壁纸放行），
  再交给 `escapeAttr`。
- `renderWallGallery` 改为调用该纯函数，DOM 结构与类名保持不变
  （`button.wall-card[data-wall-id]`、`.wc-name`、`.wc-fav[data-fav]`、`.wc-del[data-del]`、`.wc-check`）。

名字的来源见 `src/lib/community/install.ts`：`installWallpaperAsset` 把作品标题传给
`api.importWallpaperFromBlob(blob, post.title)`，`os13.ts` 只按文件 basename 截断 24 字符，
**没有任何转义**。CSP 哈希白名单本来能挡内联事件，但 `worker/index.js` 在没有哈希的构建里
会回退 `unsafe-inline`，所以这条是真 XSS，不是理论风险。

### 2.2 布局快照不再写 0×0

`src/lib/os20/legacy-layout.ts`（新增）：

```ts
export function legacyLayoutSnapshot(windows, at = Date.now()) {
  return { at, windows, legacy: true };
}
export function legacyLayoutSnapshotForViewport(windows, viewport, at) {
  return normalizeSnapshot(legacyLayoutSnapshot(windows, at), viewport);
}
```

`src/lib/os20/migrations.ts` 的 `2.0-layout-snapshot` 改为：

```ts
const viewport = { width: window.innerWidth || 1440, height: window.innerHeight || 900 };
context.storage.write("layout.v2", legacyLayoutSnapshotForViewport(state.windows, viewport));
```

原因链：`layout.ts` 的 `isSnapshot()` 只判断字段存在，`{width:0,height:0}` 也算「有效快照」，
于是跳过 `normalizeSnapshot`；`rescaleSnapshot` 用 `Math.max(1, snapshot.viewport.width)`
做分母，0 变成 1，1440/1 = 1440 倍放大；`clampRect` 再把越界窗口压回屏幕右下。
单测里 120/80 的窗口被压成 800/480，就是这条的回归证据。

### 2.3 真正清空 IndexedDB 壁纸

`src/lib/os13.ts`：

```ts
const idbClearAll = () => new Promise<void>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
});
```

`reset-all` 从 `void idbDel("__all__"); location.reload()` 改为：

```ts
void idbClearAll().then(() => window.location.reload());
```

`idbDel` 是按 key 删除的，`"__all__"` 在库里不存在，等于什么都没删；而且 `void` 没等事务完成就刷新。

### 2.4 拖拽按中心选落点

`src/lib/os13/icons-order.ts`（新增）：

```ts
export function pickGridDrop(icons: IconRect[], drop: DropPoint): { index: number; after: boolean } | null {
  if (!icons.length) return null;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < icons.length; i += 1) {
    const r = icons[i];
    const dx = drop.x - (r.left + r.width / 2);
    const dy = drop.y - (r.top + r.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  const r = icons[best];
  const dy = drop.y - (r.top + r.height / 2);
  if (Math.abs(dy) > 8) return { index: best, after: dy > 0 };
  return { index: best, after: drop.x >= r.left + r.width / 2 };
}
```

旧实现用 `other.left - host.left <= drop.x + 24 && other.top - host.top <= drop.y + 24`，
第一个图标在 (0,0) 恒满足，`find` 直接命中它。

### 2.5 强调色「自动」可恢复

`src/lib/os13/look.ts`（新增）：

```ts
export function resolveLookAccent(patch, currentAutoAccent, wallpaper) {
  if (patch.accentAuto === true) {
    return { autoAccent: true, ...(wallpaper ? { accent: wallpaper.accent, accent2: wallpaper.accent2 } : {}) };
  }
  const next = { autoAccent: currentAutoAccent };
  if (patch.accent && HEX.test(patch.accent)) { next.accent = patch.accent.toLowerCase(); next.autoAccent = false; }
  if (patch.accent2 && HEX.test(patch.accent2)) { next.accent2 = patch.accent2.toLowerCase(); next.autoAccent = false; }
  return next;
}
```

- `os13.ts` 的 `applyLook(look)` 增加 `accentAuto?: boolean`，不再在结尾无条件写 `autoAccent = false`。
- `os20/apply.ts` 在 `accent === "auto"` 且当前不是 auto 时传 `look.accentAuto = true`；
  只有显式给 hex 才关闭联动。

### 2.6 市场封面不再拼 CSS

`src/lib/os20/market-thumb.ts`（新增）：

```ts
export function marketThumbHtml(preview: string): string {
  const src = safeUrl(preview, { allowData: true });
  if (!src) return "";
  return `<img class="os20-mk-cover" src="${escapeAttr(src)}" alt="" loading="lazy" decoding="async" />`;
}
```

- 旧代码 `style="background-image:url('${esc(item.preview)}')"`：`escapeHtml` 只做 HTML
  实体转义，浏览器解析属性时先把 `&#39;` 还原成 `'`，再交给 CSS ——
  `x');background:url(https://evil/…)` 能闭合 `url()` 注入任意声明。
- 现在协议由 `safeUrl` 判定（只放 http/https 与 `data:image`），属性值再 `escapeAttr`
  一次；`html-security` 的 `url-interp` 规则也只认可 `safeUrl`/`escapeAttr` 包裹的插值。
- 样式 `.os20-mk-cover { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }`
  保持原来的封面裁切效果。

### 2.7 评论刷新带作品身份

`src/lib/os14/community/detail.ts` 的 `refreshCommentsImpl`：

```ts
const postId = detailCache.data.post.id;
const result = await api.getComments(postId, page, 12);
const current = ctx.getDetailCache();
if (!current || current.data.post.id !== postId) return;   // 期间切到了别的作品
```

以前 `await` 之后直接写 `detailCache` 并把旧评论 `innerHTML` 进「当前」面板，
所以作品 A 点「加载更多」后立刻打开 B，B 的评论区会显示 A 的评论。
现在以「请求时记住的 postId」为准，回来时作品已换就直接丢弃。

### 2.8 发布权限接口要求管理员

`worker/api/community/admin.js` 的 `adminUserRestriction`：

- 目标查询补 `LEFT JOIN community_roles`，一并取 `moderator_role`；
- 非管理员：不能封禁（`blocked`）、不能解除封禁、不能改同级审核员的限制，
  且不能改自己的（`bad("不能修改自己的发布权限")`）。
- 管理员不受限；审计动作与响应字段不变。

**为什么这条重要**：审核员原本能把自己或同级的 `restriction` 从 `blocked` 改回 `none`，
等于管理员封禁被审核员一键撤销。

### 2.9 本地状态归一化

- `src/lib/os14/apps/notes-model.ts`（新增）：`normalizeNote` 补 `title/body/folder/tags/pinned/createdAt/updatedAt`，
  `tags` 只留字符串，无 `id` 的记录丢弃；`notes.ts` 的 `read()` 统一过一遍。
- `src/lib/os14/tasks-model.ts`（新增）：`normalizePriority` 把枚举外的值收敛成 `normal`；
  `read()`、`add`、`update`、`applySync` 都走归一化。

旧数据缺字段时首页不再 `TypeError`（`note.body.split`、`n.tags.join`），
任务的 `PRIORITY[priority].weight` 也不会因未知枚举取到 `undefined`。

### 2.10 分页与重试

- `pageNav(page, hasMore, total: number | null, label)`：不知道总数时只显示「第 N 页」。
  通知接口只返回当前页和 `unread`，以前把本页条数当总数，满页就写「共 20 个条通知」，
  点「下一页」是空状态。
- `src/lib/os14/community.ts` 的 `case "retry"` 按 `view.kind` 分派：
  `detail → loadDetail(id)`、`creator → loadCreator(id)`、`search → loadSearch(q)`、
  `tab → 对应列表`。以前创作者页/搜索页出错后重试会被当成作品 id。

### 2.11 幻灯片计时器随灯箱关闭

`src/lib/os13/slideshow.ts`（新增）把计时器收成 `createSlideshow(tick, intervalMs)`
（`start/stop/running`）；`gallery.ts` 在关闭灯箱（✕/Esc/背景）时 `slideshow.stop()`，
并摘掉该灯箱的 keydown 监听。

以前 `slideTimer` 只在下次点幻灯片或窗口 cleanup 时清：Esc 关掉后 4.2 秒又自动弹回，
每开一次灯箱还会多挂一个 keydown。

---

### 3.1 新增纯函数单测

| 文件 | 用例 | 钉住什么 |
| --- | --- | --- |
| `tests/unit/os13-wallcard.test.ts` | 5 | 标签/引号/id 属性转义、blob 放行、`javascript:` 挡掉、状态位 |
| `tests/unit/icons-order.test.ts` | 6 | 空列表、左侧、右侧、下方、两图标之间、同列上下 |
| `tests/unit/look-accent.test.ts` | 5 | auto 恢复、hex 接受、非法值忽略、只给 accent2 |
| `tests/unit/legacy-layout.test.ts` | 3 | 快照不写 viewport/schemaVersion、旧 0×0 快照 120/80 → 800/480 回归 |

合计 **19 passed**（`npx vitest run tests/unit/os13-wallcard.test.ts tests/unit/icons-order.test.ts tests/unit/look-accent.test.ts tests/unit/legacy-layout.test.ts`）。

**负向对照**：用临时脚本把四个模块改回旧实现后，同一命令 **12 failed / 7 passed**；
恢复后复跑 19 passed（恢复脚本逐文件校验 SHA256，输出 4 个 `SHA256_MATCH` + `RESTORE_OK`）。

### 3.2 真实浏览器 E2E

`tests/e2e/shell-wallpaper-safety.spec.ts`（真实 Worker + 真实 Chrome，`--project=worker`）：

1. 注入：把恶意标题 `<img src=x onerror="window.__wallXss=1">壁纸` 写进 `localStorage["guandao.os13.v1"]` 的
   自定义壁纸条目 → 打开 设置→壁纸→自定义 → 断言 `.wc-name` 文本等于原始字符串、
   `#wall-grid img` 为 0、`[onerror]` 为 0、`window.__wallXss === undefined`。
2. 清空：写一条自定义壁纸 + 往 IndexedDB `guandao-os13/wallpapers` 放入 blob →
   设置→系统→清空本机数据（接受确认框）→ 等刷新 → 断言 IDB `count` 为 0、
   `JSON.parse(localStorage["guandao.os13.v1"]).custom` 为 `[]`。

**2 passed（16.0s）**。

**负向对照**：把 `renderWallGallery` 换回 2.0.5 的裸拼接后，用例 1 **1 failed**：
`toHaveText` 收到 `"壁纸"`——注入的 `<img>` 被当标签解析掉了。

### 3.3 全量 E2E

```
$env:E2E_ADMIN_PORT='18789'; npx playwright test --reporter=line
198 passed (4.7m)
```

比 2.0.5 的 195 条多 3 条（新增 `shell-wallpaper-safety` 2 条与 `community-restriction-guard` 1 条）。
跑前清空本地 `rate_limits`，并且跑中每 20 秒再清一次，否则 e2e-server 造夹具会被
`plugin-upload` 20 次/小时限流挡住。

### 3.4 门禁

```
npm run verify
[version] 一致：2.0.6（package.json / version.ts / worker / sw.js）
Test Files 38 passed / Tests 449 passed
合计 294 处，未审查 0 处
build: 30 page(s)
[csp] 12 个哈希与 31 个 HTML 一致
```

（入口包与首屏 CSS 未变，本版只改前端逻辑与 Worker 校验，不加依赖、不加迁移。）

### 3.5 第二轮修复的证据

| 文件 | 用例 | 钉住什么 |
| --- | --- | --- |
| `tests/unit/market-thumb.test.ts` | 4 | http 出 `<img>`、`data:image` 放行、`javascript:` 返回空串、注入载荷没有 `style=` 且属性值里没有裸引号 |
| `tests/unit/community-comments-refresh.test.ts` | 2 | 同作品写入缓存；切到别的作品后不写 B 的面板 |
| `tests/unit/community-restriction-guard.test.ts` | 6 | 审核员封禁/解封 403、同级审核员 403、改自己 400 且不写库、管理员放行、审核员下调仍允许 |
| `tests/unit/notes-model.test.ts` | 5 | 缺 `tags`/`body` 不崩、非字符串 tags 丢弃、无 id 丢弃、非法时间戳补 0、`read()` 调用归一化 |
| `tests/unit/tasks-priority.test.ts` | 4 | 枚举外优先级收敛成 normal、`applySync` 不再原样落库、排序不取 `undefined` |
| `tests/unit/community-retry.test.ts` | 3 | 重试按 `view.kind` 分派，防止退回「只认 home/detail」 |
| `tests/unit/community-pager.test.ts` | 5 | `total=null` 时不写数量；`hasMore` 决定下一页；幻灯片 `start/stop` 与重复 start 不叠加 |

合计 **29 passed**（`npx vitest run tests/unit/market-thumb.test.ts tests/unit/community-comments-refresh.test.ts tests/unit/community-restriction-guard.test.ts tests/unit/notes-model.test.ts tests/unit/tasks-priority.test.ts tests/unit/community-retry.test.ts tests/unit/community-pager.test.ts`）。

**真实 Worker E2E**：`tests/e2e/community-restriction-guard.spec.ts` —— 管理员封禁 creator →
被封用户发作品 403 → 管理员解封 → 恢复 200；developer 调管理接口 403。**1 passed（11.9s）**。

**为什么审核员边界没进 E2E**：管理接口只接受 UUID，夹具里只有 creator 是 UUID，
审核员账号是短 id —— 真实栈造不出「审核员改同级审核员」的组合，所以那部分由假 D1 单测钉住。

---

## 4. 兼容性

- **公开 API 契约**：无改动。没有新增/删除/改名任何路由、字段或错误码。
- **数据库**：无迁移。`npm run check:migrations` 通过。
- **存储结构**：`localStorage` 的 `guandao.os13.v1` 形状不变；
  布局快照 `layout.v2` 对老快照的读取路径不变（`isSnapshot` 仍接受旧形状）。
- **CSP**：`worker/api/csp-hashes.js` 由构建重写，本版无内联脚本改动。

---

## 5. 部署记录

**未部署**（等授权）。当前生产仍是 2.0.5（Version `1aeae3dc-e6fa-4e37-b069-b4f042c0a3e1`）。
上线时按顺序：

1. `git fetch` 确认无冲突，`npm run verify` 全绿；
2. `npx wrangler d1 migrations list guandao-db --remote` → 预期 `No migrations to apply!`；
3. `npx wrangler d1 export guandao-db --remote --output .backups\guandao-db-prod-<时间>.sql`；
4. `npm run cf:deploy`；
5. `/api/health` 应为 `"version":"2.0.6"`，响应头 `x-guandao-version: 2.0.6`，入口包含 `2.0.6`；
6. `npm run qa:prod` → 35/35；
7. `git push`（触发 Cloudflare 自动构建与 CI）。

回滚：Cloudflare 控制台把 Version 回退到 `1aeae3dc…`。

---

## 6. 未做到 / 边界

- **第二轮审计仍有 8 条没修**（都在 §1 末尾列过）：
  - `deletePost` 不结算关联举报，后续 `hide_post` 可能把软删作品改回 `hidden`；
  - `POST /posts/:id/view` 与 `GET /posts/:id/package?count=1` 无鉴权/无去重，可重放刷计数；
  - 审核接口 `approve` 允许 `draft`（且 `restore` 跳过状态校验），可把作者撤回的草稿重新公开；
  - 社区图片上传的存储配额先查后写（`/files` 有 pending 预占行，社区没有），并发可破上限；
  - `consumeReauthTicket` 在 `activeDeletion/activeExport/activeBackup` 前置检查之前消费，
    409 时票据已作废。
  这些都要么动公开计数语义、要么需要新增预占表/迁移，超出「补丁版本不加迁移」的约束，
  记为下一轮候选。
- **E2E 真实栈只覆盖了限制权限的一半**：管理用户接口要求 UUID，而夹具里只有 creator 是 UUID，
  所以 E2E 走「管理员封禁/解除 creator + 非审核员 403」；审核员与同级审核员的边界靠
  `tests/unit/community-restriction-guard.test.ts` 的假 D1 会话。
- **布局、拖拽、强调色、笔记/任务归一化、分页与重试只有单测**：它们要构造真实几何或旧本地数据，
  单测已覆盖判定与归一化；浏览器 E2E 仍只覆盖注入与清空两条链路。
- **没有在真机上验证**：IndexedDB `clear()`、`safeUrl` 的 blob 放行、键盘事件在 Chromium 内核验证，
  Safari/Firefox 未测。

