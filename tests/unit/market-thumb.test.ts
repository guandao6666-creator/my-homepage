import { describe, expect, it } from "vitest";
import { marketThumbHtml } from "../../src/lib/os20/market-thumb";

/**
 * 市场封面必须是 <img>，不能回到 style 的 url()。
 *
 * 旧实现：`style="background-image:url('${escapeHtml(preview)}')"`。
 * 浏览器解析属性时会先把 `&#39;` 还原成 `'`，再交给 CSS —— 于是
 * `x');background:url(https://evil/…)` 能闭合 url() 注入声明。
 * 这里钉住三件事：正常 URL 出 img、危险协议不出 img、引号留在属性值里。
 */
describe("市场封面渲染", () => {
  it("http(s) 预览地址渲染为 <img>，并把 URL 放进 src 属性", () => {
    const html = marketThumbHtml("https://cdn.example.com/a.png");
    expect(html).toContain('<img class="os20-mk-cover"');
    expect(html).toContain('src="https://cdn.example.com/a.png"');
  });

  it("data:image 预览允许（清单里的内联封面）", () => {
    const html = marketThumbHtml("data:image/png;base64,iVBORw0KGgo=");
    expect(html).toContain("src=\"data:image/png;base64,iVBORw0KGgo=\"");
  });

  it("javascript: 预览不渲染 img（safeUrl 拒绝协议）", () => {
    expect(marketThumbHtml("javascript:alert(1)")).toBe("");
  });

  it("CSS 注入载荷只留在 src 属性内部（没有 style=，属性值里没有裸引号）", () => {
    const html = marketThumbHtml("https://evil.example/x');background:url(https://evil.example/t)");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("background-image");
    // 关键不是「出现 &#39;」——safeUrl 可能先把引号百分号编码，
    // 而是属性值里不能再有能闭合 src="…" 的裸引号。
    const src = /src="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(src).toBeTruthy();
    expect(src).not.toContain("'");
    expect(html.startsWith('<img class="os20-mk-cover" src="')).toBe(true);
  });
});