# HTML 转义与 URL 安全（HTML Security）

**阶段**：Guandao OS 2.3 / 2.3.1
**状态**：`Verified`（2.3.1 完成全量审计：291 处 HTML 注入点逐项登记，42 处动态 URL 全部收敛，静态检查接入 verify）
**最后核对**：2026-11-07
**分支**：`refactor/2.3-unified-html-escaping`
**统一入口**：`src/lib/html.ts`
**自动检查**：`npm run check:html-security`（AST 扫描 + 白名单 + 数量漂移检测）

---

## 1. 这个模块负责什么

只有三件事，职责边界故意做窄：

| 导出 | 用途 | 用在哪 |
| --- | --- | --- |
| `escapeHtml(value)` | 把不可信值渲染成 **HTML 文本** | `<p>${escapeHtml(x)}</p>` |
| `escapeAttr(value)` | 同上，语义化标明 **属性值** 上下文 | `<a title="${escapeAttr(x)}">` |
| `safeUrl(value, opts?)` | 校验 **URL 协议** 并转义 | `<a href="${safeUrl(x)}">` |
| `isSafeUrl(value, opts?)` | 只判断不转换 | 分支逻辑 |

实现要点：

- **单趟替换**：`/[&<>"']/g` 一次 `replace`，不用链式多轮替换（链式一旦顺序写错就会双重转义）；
- **不破坏 Unicode**：只替换 5 个 ASCII 字符，中文/Emoji 原样通过；
- **null / undefined** 返回空串，而不是 `"null"` / `"undefined"`；
- **不做反转义**：输入 `&lt;script&gt;` 会变成 `&amp;lt;script&amp;gt;`（这是正确行为）；
- `escapeAttr` 与 `escapeHtml` **规则完全一致**：带引号的属性值只需要处理 `&` 和对应引号，而后者两种引号都处理了。保留独立名字是为了让调用点表达上下文，不是更强保证。

---

## 2. 支持的上下文 vs 不支持的上下文

**支持**：HTML 文本节点、双引号属性、单引号属性、URL 属性（配合 `safeUrl`）。

**不支持**（用错了本模块也救不了你）：

| 上下文 | 为什么不能靠 `escapeHtml` | 正确做法 |
| --- | --- | --- |
| `<script>` 内部 | JS 字符串不需要 HTML 实体；`</script>` 会提前闭合 | 用 `JSON.stringify` + 转义 `</`，或干脆不要内联数据 |
| 内联事件属性 `onclick="..."` | 浏览器会先把属性值当 JS 执行 | 不要在 HTML 里写 JS；用 `addEventListener` |
| CSS（`style="..."`、`<style>`） | CSS 有自己的转义与 `url()` 语义 | 只允许白名单值；不要拼接用户输入 |
| 未加引号的属性 | 空格即可分隔新属性 | 永远加引号，或改用 DOM API |
| URL 协议 | `javascript:alert(1)` 里**没有任何字符需要 HTML 转义** | `safeUrl()` |
| 富文本 | 转义后只是「显示成文本」，不是「安全地当 HTML 用」 | 见 §4 |

> 一句话：**HTML 转义 ≠ URL 校验 ≠ JS 编码 ≠ CSS 编码**，这是四个不同的问题。

---

## 3. URL 处理

HTML 有一个反直觉的地方：

```ts
escapeHtml("javascript:alert(1)"); // => "javascript:alert(1)"  —— 什么都没变
```

因为这里根本没有 `<` `>` `"` `'` `&`。**转义对协议注入完全无效**，必须单独校验协议。

`safeUrl` 的规则：

| 输入 | 结果 |
| --- | --- |
| `https:` / `http:` / `mailto:` / `tel:` | 放行 |
| `javascript:` / `vbscript:` / `file:` / `about:` | **清空为 `""`** |
| `data:` | 默认拒绝；`{ allowData: true }` 放行（仅用于 `<img>`） |
| `blob:` | 默认拒绝；`{ allowBlob: true }` 放行 |
| 相对路径 / `#anchor` / `?query` / `//protocol-relative` | 放行 |
| 非字符串（对象、数字等） | **拒绝**（避免 `String({})` → `"[object Object]"` 混进来） |
| 含控制字符（`java\nscript:`） | 先剥离控制字符再判断，因此仍被拒绝 |

不安全时返回空串而不是抛错——一个坏链接不应该让整个界面崩掉。

### 当前应用范围（4 处）

只用在**第三方内容进入可导航位置**的地方，其余按 §8 风险登记：

| 位置 | 内容 | 允许 |
| --- | --- | --- |
| `src/lib/plugins/market.ts` | 插件 `homepage` → `<a href>` | http(s)/相对 |
| `src/lib/plugins/market.ts` | 开发者 `website` → `<a href>` | http(s)/相对 |
| `src/lib/plugins/market.ts` | 插件截图 `shot.url` → `<img src>` | http(s)/相对 |
| `src/lib/plugins/ui-kit.ts` | 插件图标 `iconUrl` → `<img src>` | http(s)/相对/`data:` |

---

## 4. 不可信 HTML（富文本）怎么处理

**结论：本项目当前没有任何富文本渲染，也不需要。**

- 社区帖子、评论、插件描述、开发者说明全部走 `escapeHtml`，即「当纯文本显示」；
- 仓库里没有引入 sanitizer（DOMPurify 等），也没有 `v-html` / `set:html` 式的富文本通道；
- 因此「用户提交的 HTML 被当 HTML 执行」这条路径目前**不存在**。

如果将来要渲染富文本：

1. 不要因为调用了 `escapeHtml` 就认为可以安全执行；
2. 引入经过审查的 sanitizer，并锁定允许的标签/属性白名单；
3. 先写 DOM 测试（见 §7 的「富文本」用例），再上线。

---

## 5. 迁移结果

### 5.1 迁移前

| 位置 | 实现 | 转义字符 | null 行为 |
| --- | --- | --- | --- |
| `src/lib/os14/core.ts` | 链式 5 轮 replace | `& < > " '` | `""` |
| `src/pages/index.astro` | 单趟 4 字符 | `& < > "` | `"null"` |
| `src/pages/home.astro` | 单趟 4 字符 | `& < > "` | `"null"` |
| `src/pages/notes.astro` | 单趟 4 字符 | `& < > "` | `"null"` |
| `src/pages/blog/index.astro` | 单趟 4 字符 | `& < > "` | `"null"` |
| `src/lib/mobile/ui.ts` | `escapeAttr`（委托 escapeHtml 再补一次 `"`） | — | 跟随 |
| `src/lib/quality/errors.ts` | `escapeAttr`（本地第 4 字符实现） | `& < > "` | `"null"` |

### 5.2 迁移后

| 位置 | 处理 |
| --- | --- |
| `src/lib/html.ts` | **唯一实现** |
| `src/lib/os14/core.ts` | `import { escapeHtml } from "../html"` + `export { escapeHtml }`（保持历史调用点不变） |
| `src/lib/mobile/ui.ts` | 删除本地 `escapeAttr`，从 `../html` 导入并 re-export |
| `src/lib/quality/errors.ts` | 删除本地 `escapeAttr`，改为导入 |
| `src/pages/index.astro` | 删除本地实现，模块顶部导入 |
| `src/pages/home.astro` | 同上 |
| `src/pages/notes.astro` | 同上 |
| `src/pages/blog/index.astro` | **保留本地副本**，见 §6 |
| `src/lib/plugins/ui-kit.ts` | `esc` 从包装函数改为 `= escapeHtml` |

### 5.3 `esc` 别名

项目里有 421 处 `esc(...)` 调用。它只是一个短名字：

- `src/lib/plugins/ui-kit.ts` 导出 `esc`（已改为 `escapeHtml` 的别名）；
- `src/lib/os20/apps/{market,systemcenter,updatecenter}.ts` 里是 `const esc = escapeHtml`。

**没有**为它做迁移——它是统一实现之上的别名，不构成第二份实现。

### 5.4 行为变化（有意为之，均已验证）

| 变化 | 影响 | 验证 |
| --- | --- | --- |
| 4 个 Astro 页面开始转义单引号 | 文本里的 `'` 变成 `&#39;`，渲染结果不变 | E2E 全量通过 |
| 4 个 Astro 页面的 `null` 从 `"null"` 变为 `""` | 不再显示 "null" 字符串 | 单元测试 |
| `os14/core` 的 `escapeHtml` 行为不变 | 5 字符 + null 安全，与旧实现一致 | 单元测试 |

---

## 6. 唯一保留的本地实现：`blog/index.astro`

```astro
<script is:inline>
  const escapeHtml = (text) => { /* 与 src/lib/html.ts 同语义 */ };
</script>
```

**为什么不能统一**：

1. `is:inline` 脚本不会被 Vite 处理，**不能使用 ESM `import`**；
2. 改成模块脚本会改变内联脚本集合 → `scripts/gen-csp.mjs` 生成的内联哈希全部变化 → 需要重新生成 CSP，风险与本次范围不符。

**约束**：改转义规则时必须两边同步。该文件的注释里已写明这一点，并有指向本文档的引用。

---

## 7. 测试

### 7.1 单元测试 `tests/unit/html.test.ts`（40 项）

| 分组 | 覆盖 |
| --- | --- |
| 基础 XSS 载荷 | `<script>` / `<img onerror>` / `<svg onload>` / `<iframe javascript:>` |
| 五字符 | `&` `<` `>` `"` `'` 逐一断言 + 多字符组合 |
| 边界值 | `null` / `undefined` / `""` / `0` / `-1.5` / `true` / `false` / `NaN` / `Infinity` |
| Unicode | 中文、Emoji（含代理对不被拆）、带音标拉丁字符 |
| 不双重转义 | `&lt;script&gt;` → `&amp;lt;script&amp;gt;`；再转一次会变成可见实体 |
| `escapeAttr` | 与 `escapeHtml` 逐样本一致；单/双引号都无法闭合属性 |
| `safeUrl` | 协议白名单、大小写混写、控制字符拆解、`data:`/`blob:` 开关、相对路径、非字符串、失败返回空串 |
| **反向用例** | `safeUrl({evil:true})` 必须返回 `""`（这条一开始没通过，暴露了 `String({})` 的漏洞并已修复） |

### 7.2 DOM 测试 `tests/e2e/html-security.spec.ts`（11 项）

在真实浏览器里，用**真实模块的输出**构造 DOM：

| 用例 | 断言 |
| --- | --- |
| **对照组** | 未转义的载荷确实生成 `1` 个 `<img>` + `1` 个 `<script>`（证明检测有效，不是空转） |
| 5 种载荷 × 转义后 | 不产生 script/img/svg/iframe 节点，`alert` 未执行，载荷作为文本出现 |
| 属性上下文（双引号） | 属性数仍为 2，`onmouseover` / `data-pwned` 都没被注入 |
| 属性上下文（单引号） | 同上，`onfocus` 未注入 |
| URL 上下文 | `javascript:` → `href=""`；正常链接原样 |
| Unicode | 中文 + Emoji + 重音字符渲染结果与输入完全一致 |
| 富文本 | 转义后 `<script>` 不执行，标签以文本可见 |

> DOM 测试放在 Playwright 而不是 vitest：项目没有 jsdom/happy-dom 依赖，
> 而 Playwright 本来就是既有浏览器测试环境。测试 spec 直接
> `import { escapeHtml, safeUrl } from "../../src/lib/html"`，测的是真实实现。

---

## 8. 仍然存在的风险（如实记录）

| # | 风险 | 现状 | 说明 |
| --- | --- | --- | --- |
| 1 | **`href`/`src` 大多没有协议校验** | 34 处动态属性插值、22 处直接赋值 | 其中多数是内部路径或构建期数据；第三方来源的 4 处已加 `safeUrl`。社区封面/头像等仍只用 `escapeHtml`，若上游能写入 `javascript:` 链接存在风险 |
| 2 | `a.href = url` 直接赋值 | 5 处（`os13.ts`、`os14/core.ts`、`systemcenter.ts`、`diagnostics.ts`、`index.astro`） | 这些 URL 来自 `URL.createObjectURL` 或内部构造，当前可控；但没有编译期约束 |
| 3 | 268 处 `innerHTML` | 未逐一审计 | 本次没有做 taint 分析；抽样显示绝大多数插值走 `esc`/`escapeHtml` |
| 4 | `blog/index.astro` 的第二份实现 | 保留 | 靠人工同步，规则漂移风险 |
| 5 | 没有 HTML sanitizer | 不需要 | 一旦引入富文本渲染，必须先补 §4 的流程 |
| 6 | CSP 仍是最后一道防线 | 已有 | `check:csp` 校验 12 个内联哈希，但 CSP 不能替代转义 |

> 本次**没有**声称上述风险已修复。它们是 Phase 2.3 范围内记录的技术债，
> 其中 #1 的剩余部分建议在后续安全专项里逐条评估。

---

## 9. 如何新增安全测试

**改转义规则时**：

1. 先在 `tests/unit/html.test.ts` 加断言（字符串语义）；
2. 再到 `tests/e2e/html-security.spec.ts` 加真实插入用例（DOM 行为）；
3. 如果新规则会影响渲染，加一条 E2E 回归到相关页面。

**新增一个「把不可信数据插进 HTML」的位置时**：

- 文本节点 → `escapeHtml`
- 带引号属性 → `escapeAttr`
- URL → `safeUrl`（图片可考虑 `{ allowData: true }`）
- 以上都不是 → **停下来**，先确认这个上下文需要什么编码器

---

## 10. 相关文档

- [`docs/architecture/LEGACY-APPLICATIONS.md`](LEGACY-APPLICATIONS.md)：Phase 2.2 应用迁移
- [`docs/architecture/DESKTOP-CSS.md`](DESKTOP-CSS.md)：Phase 2.1 CSS 拆分
- [`GUANDAO_2_0_AUDIT.md`](../../GUANDAO_2_0_AUDIT.md)：总体审计
- [`docs/ACCEPTANCE-2.0.md`](../ACCEPTANCE-2.0.md)：验收清单

---

# 附录：Phase 2.3.1 全量审计（2026-11-07）

上一轮只覆盖了三处已知实现和 4 个第三方 URL 入口。这一轮把全仓库扫了一遍。
**以下数字全部来自本次 `npm run check:html-security` 的真实输出**，不是旧报告。

## A1. 真实扫描结果

| 类别 | 数量 |
| --- | ---: |
| HTML sink（`innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`） | **268** |
| 动态 URL 属性插值（`href="..."` / `src="..."` 内的 `${}`） | **42** |
| 直接 URL 赋值（`el.href =` / `el.src =`） | **22** |
| 危险协议字面量 | **0** |
| 重复转义实现 | **1**（blog 内联副本，唯一例外） |
| **合计待登记** | **333** |

> 说明：上一轮报告里的 34 / 22 / 268 是用行级正则估的。改成 TypeScript AST 后
> 动态 URL 插值从 34 变成 **42**（正则漏掉了跨行模板与嵌套表达式），
> 同时修掉了两处自身误报（把任意 `.write()` 当成 `document.write`、
> 把 `data-gp-action` 当成 `action` 属性）。

## A2. 动态 URL 审计（42 → 0）

原则：**按用途选策略，不是统一套一个函数**。

| 用途 | 处理 | 处数 |
| --- | --- | ---: |
| 第三方内容：社区封面 / 头像 / 帖子图 / 资产预览 | `safeUrl()` | 15 |
| 插件：主页、开发者网站（`href`）、截图、图标（`src`，允许 `data:`） | `safeUrl()` | 3 |
| 本地对象 URL：云盘预览、组件预览、壁纸缩略图（`blob:`） | `safeUrl(..., { allowBlob: true })` | 7 |
| 云盘 `/api/files/…` 内部路径 | `safeUrl()` | 2 |
| 市场图标（第三方清单） | `safeUrl()` | 1 |
| 文章列表 `post.href`（构建期） | `safeUrl()` | 1 |
| 社交头像常量表 | `safeUrl()` | 3 |
| 壁纸路径 + `safeWallId` 白名单 | `safeUrl(\`…\`)` | 3 |
| 被误报的 `data-gp-action` | 修正扫描器 | 1 |
| 剩余 | **0** | |

## A3. 直接 URL 赋值审计（22）

全部为属性赋值（`el.href = x`），**不经过 HTML 解析**，因此不存在属性逃逸；
风险只剩「协议是否可执行」。

| 来源 | 处数 | 结论 |
| --- | ---: | --- |
| `URL.createObjectURL(blob)` → `blob:` | 12 | Safe：系统生成，生命周期可控 |
| `/api/files/${encodeURIComponent(id)}/download` 等内部路径 | 3 | Safe：同源相对路径 |
| `RUNNER_URL` / `/m/` / `/` 等常量 | 4 | Safe |
| 头像 URL（API 返回，赋给 `img.src`） | 3 | Safe：`javascript:` 在 `img.src` 不执行 |

## A4. HTML Sink 审计（268）

**方法**：对每个 sink 的右值做 AST 展开，检查模板插值是否被
`escapeHtml` / `escapeAttr` / `safeUrl` / 数字格式化 等安全路径包裹。

| 分组 | 文件数 | 结论 |
| --- | ---: | --- |
| 插值 **100% 已包装或字面量** | 26 | Safe（自动检查 0 处未包装） |
| 含未包装插值，逐个复核 | 26 | Safe（见下） |

未包装插值经复核只落在三类，**没有发现新的 XSS 路径**：

1. **数字/计数**：`total`、`idx + 1`、`words`、`list.length`、`control.volume`；
2. **内部渲染函数返回的受控 HTML**：`topBar()`、`tabContent`、`statusBadge()`、
   `options.body`（内部 API，调用方都在仓库内）；
3. **已校验常量**：`safeWallId()` 白名单后的 `wall`、`APP_ICON[id]`。

特别复核：`renderMarkdown()` —— 它先 `escapeHtml(text)` **再做标签替换**，
链接正则只匹配 `https?://`，因此 Markdown 输入无法注入标签或 `javascript:` 链接。

## A5. 本轮修复的问题

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | `src/lib/pairing/page.ts` 有一份**未被上一轮发现**的 `escapeHtml` 副本（4 字符） | 迁移到 `src/lib/html.ts` |
| 2 | `src/pages/admin/index.astro` 同样有一份副本 | 迁移到统一模块 |
| 3 | 42 处动态 URL 中 19 处只用 `esc()`，**无协议校验** | 按用途分别套 `safeUrl` |
| 4 | 静态检查工具自身 2 处误报 | 修正 AST 规则 |

> 第 1、2 项是上一轮用 `escapeHtml\s*=\s*\(` 正则漏掉的（那份写成了
> `function escapeHtml(...)`）。这正是本阶段改用 AST 的理由。

## A6. 保留的兼容实现（1 处）

`src/pages/blog/index.astro` 的内联 `escapeHtml`：

- 原因是 `<script is:inline>` 不能用 ESM import，改成模块脚本会改变 CSP 内联哈希；
- **已加一致性测试**：`tests/unit/html.test.ts` 会把它抽出来求值，
  对 20 组输入（五个特殊字符、null、undefined、数字、中文、Emoji、实体串）
  与 `src/lib/html.ts` 逐项比对，规则漂移会直接让 CI 失败。

## A7. 自动化检查

`npm run check:html-security`（已接入 `npm run verify`）：

- 用 TypeScript 编译器 API 做 AST 扫描，正则只用于属性文本匹配；
- `.astro` 会先抽出 frontmatter 与 `<script>` 块，保留行号偏移；
- 白名单 `scripts/html-security-allowlist.json` 里 **每条必须写 reason**；
- 文件级条目带 `count`：**新增同类代码会让数量不符，检查直接失败**，
  不会因为「这个文件已审查过」而放过新写的 sink。

## A8. 仍然存在的风险

| # | 风险 | 现状 |
| --- | --- | --- |
| 1 | 白名单是「文件级 + 数量」粒度，不是逐行 | 同文件内新增 sink 会被 count 抓住；但对已有 sink **内部**逻辑的改动不会被察觉 |
| 2 | 没有 HTML sanitizer | 当前无富文本渲染通道；引入前必须先补流程 |
| 3 | `img.src` 的 URL 未强制协议校验 | `javascript:` 在 `img.src` 不执行，且多数已是常量/对象 URL |
| 4 | CSP 仍是最后防线 | `check:csp` 校验 12 个内联哈希 |

## A9. 测试数量

| 文件 | 数量 | 内容 |
| --- | ---: | --- |
| `tests/unit/html.test.ts` | **47** | 基础 XSS、五字符、边界、Unicode、双重转义、safeUrl 协议矩阵、blog 一致性 |
| `tests/e2e/html-security.spec.ts` | **26** | 对照组、5 类载荷、属性逃逸、7 种危险 URL、6 类真实字段、窗口标题、回归 |

全量：`npm run verify` **170 单测**；`npx playwright test` **64 项**；`npm run qa:sync` **20/20**。