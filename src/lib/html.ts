/**
 * Guandao OS 2.3 · 统一 HTML 转义与 URL 校验。
 *
 * 这个模块只负责三件事，别往里塞别的东西：
 *   1. `escapeHtml` —— 把不可信值放进 **HTML 文本节点** 或 **带引号的属性值** 时转义；
 *   2. `escapeAttr` —— 与上者同规则，仅用于表达「我这是属性上下文」的意图；
 *   3. `safeUrl`   —— 校验 URL 协议，**这不是转义能替代的事**。
 *
 * 明确不支持（用错了也不会救你）：
 *   - 未加引号的属性值、`href="javascript:..."` 这类协议问题 → 用 `safeUrl`；
 *   - `<script>` 内部、内联事件属性、CSS 字符串 → 需要各自的编码器，本模块不提供；
 *   - 不可信富文本 → 必须走经过审查的 sanitizer，`escapeHtml` 只保证「当文本显示」。
 *
 * 设计约束：
 *   - 单趟正则替换，绝不链式多轮 replace（链式替换一旦顺序写错就会双重转义）；
 *   - `null` / `undefined` 明确返回空串，而不是 "null" / "undefined"；
 *   - 不碰 Unicode：只替换 5 个 ASCII 危险字符，中文/Emoji 原样通过。
 */

/** HTML 文本与带引号属性值里需要转义的 5 个字符 */
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_RE = /[&<>"']/g;

/**
 * 转义为 HTML 可以安全承载的文本。
 *
 * 适用于：
 *   - `<p>${escapeHtml(userText)}</p>`（文本节点）
 *   - `<a title="${escapeHtml(userText)}">`（双引号或单引号属性）
 *
 * 不适用于：URL、JS 字符串、CSS、未加引号的属性。
 *
 * 单引号也会被转成 `&#39;`：项目里属性都用双引号，但多转义一个字符
 * 对文本渲染没有影响，却能挡住「用单引号拼属性」这种未来写法。
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/**
 * 属性值转义。
 *
 * 当前与 `escapeHtml` 规则**完全一致**：带引号的属性值只需要处理
 * `&` 和对应的引号字符，而 `escapeHtml` 两种引号都处理了。
 * 保留独立名字是为了让调用点表达上下文，而不是提供更强的保证。
 *
 * 不要用它处理 URL —— 那需要 `safeUrl`。
 */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

/** `safeUrl` 允许的协议（导航与资源都适用） */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export type SafeUrlOptions = {
  /** 允许 `data:`（仅用于内联图片/音频，不要用于链接） */
  allowData?: boolean;
  /** 允许 `blob:`（对象 URL，多为用户刚选择的本地文件） */
  allowBlob?: boolean;
};

/** 提取协议：`javascript:` / `data:` / `https:` … 没有协议则返回 null */
function schemeOf(url: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return match ? `${match[1].toLowerCase()}:` : null;
}

/**
 * 判断 URL 是否安全（协议白名单）。
 *
 * 为什么需要它：`escapeHtml("javascript:alert(1)")` 返回的还是
 * `javascript:alert(1)` —— 里面没有任何需要转义的字符。
 * **HTML 转义不能代替协议校验。**
 */
export function isSafeUrl(value: unknown, options: SafeUrlOptions = {}): boolean {
  // 只接受字符串：对象会被 String() 变成 "[object Object]"，
  // 那既不是有效 URL，也说明调用点传错了东西，宁可返回空串。
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!raw) return false;

  // 控制字符（含换行/制表）可以被用来把 `java\nscript:` 拆开绕过检查
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "");
  const scheme = schemeOf(cleaned);

  // 没有协议：相对路径、锚点、查询串、协议相对 `//host`
  if (!scheme) return true;

  if (SAFE_SCHEMES.has(scheme)) return true;
  if (scheme === "data:") return options.allowData === true;
  if (scheme === "blob:") return options.allowBlob === true;
  return false;
}

/**
 * 校验并转义 URL，用于 `href` / `src` 等属性。
 *
 * 不安全时返回空串（属性变成 `href=""`），而不是抛错——
 * 一个坏链接不应该让整个界面崩掉。
 */
export function safeUrl(value: unknown, options: SafeUrlOptions = {}): string {
  if (!isSafeUrl(value, options)) return "";
  const cleaned = (value as string).trim().replace(/[\u0000-\u001F\u007F]/g, "");
  return escapeAttr(cleaned);
}