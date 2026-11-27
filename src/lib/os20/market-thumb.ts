/**
 * Guandao OS 2.0.6 · 应用市场封面渲染
 *
 * 为什么单独拆出来：
 *   市场条目的 `preview` 来自远端清单（作者可控）。2.0.5 之前它被拼进
 *   `style="background-image:url('${esc(preview)}')"` —— `escapeHtml` 只做 HTML
 *   实体转义，浏览器解析属性时会先把 `&#39;` 还原成 `'`，再交给 CSS 解析，
 *   于是 `x');background:url(https://evil/…)` 能闭合 `url()` 注入任意声明。
 *
 *   HTML 转义救不了 CSS 上下文（`src/lib/html.ts` 的注释也写明不提供 CSS 编码器），
 *   所以这里不再拼样式，而是返回一个真正的 `<img>`，协议交给 `safeUrl`。
 */
import { escapeAttr, safeUrl } from "../html";

/**
 * 封面图；URL 不安全时返回空串，由调用方回退到图标。
 *
 * 为什么属性值还要再 escapeAttr 一次：
 *   `safeUrl` 只判断协议是否允许（http/https/data:image），不处理 HTML 属性
 *   上下文；URL 本身可能带 `&` 或引号，直接插进 `src="…"` 会让 HTML 解析
 *   提前闭合属性。这里按属性值转义（`html-security` 的 url-interp 规则也
 *   只认可 safeUrl/escapeAttr 包裹的插值）。
 */
export function marketThumbHtml(preview: string): string {
  const src = safeUrl(preview, { allowData: true });
  if (!src) return "";
  return `<img class="os20-mk-cover" src="${escapeAttr(src)}" alt="" loading="lazy" decoding="async" />`;
}