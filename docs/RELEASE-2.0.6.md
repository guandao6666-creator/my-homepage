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

---

## 3. 测试证据

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
197 passed (4.8m)
```

比 2.0.5 的 195 条多 2 条（新增 `shell-wallpaper-safety`）。跑前清空本地 `rate_limits`，
否则 e2e-server 造夹具会被 `plugin-upload` 20 次/小时限流挡住。

### 3.4 门禁

```
npm run verify
[version] 一致：2.0.6（package.json / version.ts / worker / sw.js）
Test Files 31 passed / Tests 420 passed
合计 294 处，未审查 0 处
build: 30 page(s)
[csp] 12 个哈希与 31 个 HTML 一致
```

（日志见 `npm run verify` 本机输出；入口包与首屏 CSS 未变，本版只改前端逻辑，不加依赖。）

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

- **布局、拖拽、强调色只有单测，没有浏览器 E2E**：它们要复现真实指针几何与设置面板状态，
  单测已覆盖纯函数判定；E2E 只覆盖了注入与清空两条最容易出事的链路。
- **audit-worker / audit-os14-b 没有交付结论**：一个两次 inactive，一个被停止且没有收尾消息，
  所以本轮 worker 与 os14 的审计**没有新证据**，只有我手工读过的部分（D1 备份文档）。
- **`audit-shell` 的第 4 条（拖拽）判断依赖几何假设**：`pickGridDrop` 用的是中心距离 +
  水平/垂直阈值；如果将来网格改成非均匀列宽，需要重新校准阈值。
- **没有在真机上验证**：IndexedDB `clear()` 与 `safeUrl` 的 blob 放行在 Chromium 内核上验证，
  Safari/Firefox 未测。

