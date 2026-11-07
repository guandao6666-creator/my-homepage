# HTML 转义与 URL 安全（HTML Security）

**阶段**：Guandao OS 2.3
**状态**：`Partially Verified`（转义已统一并有单元/DOM 测试；URL 协议校验只覆盖第三方内容入口，其余按风险登记）
**最后核对**：2026-11-07
**分支**：`refactor/2.3-unified-html-escaping`
**统一入口**：`src/lib/html.ts`

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