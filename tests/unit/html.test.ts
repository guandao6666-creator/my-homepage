/**
 * Guandao OS 2.3 · 统一 HTML 转义与 URL 校验的单元测试。
 *
 * 这里只测「字符串语义」；「插进真实 DOM 会不会被当成 HTML 执行」由
 * tests/e2e/html-security.spec.ts 在真实浏览器里验证（项目没有 jsdom 依赖，
 * 而 Playwright 本来就是这个项目既有的浏览器测试环境）。
 */
import { describe, expect, it } from "vitest";
import { escapeAttr, escapeHtml, isSafeUrl, safeUrl } from "../../src/lib/html";

describe("escapeHtml · 基础 XSS 载荷", () => {
  it("script 标签被转义，输出里不含可解析的尖括号", () => {
    const out = escapeHtml("<script>alert(1)</script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("img onerror 载荷被转义", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("svg onload 载荷被转义", () => {
    expect(escapeHtml("<svg onload=alert(1)>")).toBe("&lt;svg onload=alert(1)&gt;");
  });

  it("iframe / javascript 协议字符串整体被转义为文本", () => {
    expect(escapeHtml('<iframe src="javascript:alert(1)"></iframe>')).toBe(
      "&lt;iframe src=&quot;javascript:alert(1)&quot;&gt;&lt;/iframe&gt;",
    );
  });
});

describe("escapeHtml · 五个字符逐一验证", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("%s → %s", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it("同一字符串里的多个特殊字符各转一次", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("escapeHtml · 边界值", () => {
  it("null → 空串", () => expect(escapeHtml(null)).toBe(""));
  it("undefined → 空串", () => expect(escapeHtml(undefined)).toBe(""));
  it("空串 → 空串", () => expect(escapeHtml("")).toBe(""));
  it("数字 0 保留为 0（不是空串）", () => expect(escapeHtml(0)).toBe("0"));
  it("数字 -1.5", () => expect(escapeHtml(-1.5)).toBe("-1.5"));
  it("布尔 true / false", () => {
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(false)).toBe("false");
  });
  it("NaN / Infinity 按 String 语义", () => {
    expect(escapeHtml(Number.NaN)).toBe("NaN");
    expect(escapeHtml(Infinity)).toBe("Infinity");
  });
});

describe("escapeHtml · Unicode 不被破坏", () => {
  it("中文原样保留", () => expect(escapeHtml("管道的首页")).toBe("管道的首页"));
  it("Emoji 原样保留", () => expect(escapeHtml("骑车 🚴‍♀️ 100km")).toBe("骑车 🚴‍♀️ 100km"));
  it("emoji 不会被拆成代理对", () => {
    const out = escapeHtml("😀");
    expect(out).toBe("😀");
    expect([...out].length).toBe(1);
  });
  it("带音标的拉丁字符", () => expect(escapeHtml("café naïve")).toBe("café naïve"));
  it("中文里的特殊字符照样转义", () => {
    expect(escapeHtml("他说：<b>你好</b>")).toBe("他说：&lt;b&gt;你好&lt;/b&gt;");
  });
});

describe("escapeHtml · 不双重转义", () => {
  it("输入已是实体形式时，& 会被再转义一次（这是正确行为，不做反转义）", () => {
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("已经转义过的文本再转一次会变成可见实体（调用方不应重复调用）", () => {
    const once = escapeHtml("<b>");
    expect(once).toBe("&lt;b&gt;");
    expect(escapeHtml(once)).toBe("&amp;lt;b&amp;gt;");
  });

  it("单次调用不会把 &amp; 再拆成 &amp;amp; 之外的其它形态", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    // 结果中每个 & 都只来自一次替换
    expect(escapeHtml("a & b").match(/&/g)?.length).toBe(1);
  });
});

describe("escapeAttr", () => {
  it("与 escapeHtml 规则一致", () => {
    const samples = ['"', "'", "&", "<", ">", "中文'\"<>&", null, undefined, 0];
    for (const sample of samples) {
      expect(escapeAttr(sample)).toBe(escapeHtml(sample));
    }
  });

  it("双引号不会提前闭合属性", () => {
    const out = escapeAttr('x" onmouseover="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toBe("x&quot; onmouseover=&quot;alert(1)");
  });

  it("单引号也不会闭合单引号包裹的属性", () => {
    expect(escapeAttr("x' onclick='alert(1)")).not.toContain("'");
  });
});

describe("safeUrl · 协议白名单", () => {
  it("拒绝 javascript:（这才是转义救不了的场景）", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(safeUrl("javascript:alert(1)")).toBe("");
  });

  it("javascript: 大小写混写也拒绝", () => {
    expect(isSafeUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(safeUrl("JavaScript:alert(1)")).toBe("");
  });

  it("用控制字符拆开协议也拒绝", () => {
    expect(isSafeUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeUrl("\u0000javascript:alert(1)")).toBe(false);
  });

  it("拒绝 vbscript: / file: / about:", () => {
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("about:blank")).toBe(false);
  });

  it("默认拒绝 data:（可被用作 HTML 载荷）", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("显式 allowData 时才放行 data:", () => {
    expect(isSafeUrl("data:image/png;base64,AAAA", { allowData: true })).toBe(true);
  });

  it("默认拒绝 blob:，显式 allowBlob 放行", () => {
    expect(isSafeUrl("blob:https://guandao.xin/abc")).toBe(false);
    expect(isSafeUrl("blob:https://guandao.xin/abc", { allowBlob: true })).toBe(true);
  });

  it("放行 http / https / mailto / tel", () => {
    for (const url of ["https://guandao.xin/", "http://example.test/a", "mailto:a@b.test", "tel:+8613800000000"]) {
      expect(isSafeUrl(url)).toBe(true);
    }
  });

  it("放行相对路径、锚点、查询串、协议相对地址", () => {
    for (const url of ["/blog/", "./a.png", "../x", "#top", "?q=1", "//cdn.example.test/a.png"]) {
      expect(isSafeUrl(url)).toBe(true);
    }
  });

  it("空值一律不安全", () => {
    for (const value of [null, undefined, "", "   "]) expect(isSafeUrl(value)).toBe(false);
  });

  it("安全的 URL 仍会被转义（& 参数不会被当成实体）", () => {
    expect(safeUrl("https://a.test/?x=1&y=2")).toBe("https://a.test/?x=1&amp;y=2");
  });

  it("拒绝返回空串，而不是抛错", () => {
    expect(() => safeUrl({ evil: true })).not.toThrow();
    expect(safeUrl({ evil: true })).toBe("");
  });
});