import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  LIMITS,
  POST_TYPES,
  validateManifest,
  validateTutorialConfig,
} from "../../worker/api/community/validate.js";
import { CATEGORY_LABEL, validateManifestClient } from "../../src/lib/community/manifest";
import { TYPE_LABEL } from "../../src/lib/os14/community/constants";
import { renderMarkdown } from "../../src/lib/os14/core";

/**
 * 教程（tutorial）内容的契约测试。
 *
 * 分层：
 * 1. 服务端 worker/api/community/validate.js 是权威校验（长度、字段白名单、HTML 标签）。
 * 2. 客户端 src/lib/community/manifest.ts 只做发布前即时预检，规则更宽松（服务端兜底）。
 * 3. renderMarkdown 是正文渲染的唯一出口：先整体 escapeHtml，再放行受限 Markdown，
 *    因此 `<script>` / `<img onerror>` / `javascript:` 只能作为文本出现。
 *
 * 这里不引入 jsdom：渲染函数是纯字符串函数，直接断言输出即可。
 */

const TUTORIAL_CONTENT = [
  "## 先清空桌面",
  "",
  "只留下 **显示器**、键盘与一杯水，然后把手机调成 `勿扰`。",
  "",
  "- 第一步：清空桌面",
  "- 第二步：固定桌面壁纸",
  "",
  "> 专注不是意志力，而是环境设计。",
].join("\n");

function makeTutorialManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageId: "tutorial-focus-desk",
    type: "tutorial",
    name: "专注桌面布置指南",
    version: "1.0.0",
    author: "qa-tutorial",
    description: "从零布置一个低干扰的专注桌面。",
    compatibility: { minimum: "1.3.0" },
    license: "CC-BY-4.0",
    assets: [],
    configuration: { content: TUTORIAL_CONTENT },
    ...overrides,
  };
}

describe("教程内容包：服务端权威校验", () => {
  it("合法的 tutorial manifest 通过校验并保留正文", () => {
    const result = validateManifest(makeTutorialManifest(), "tutorial");
    expect(result.manifest.type).toBe("tutorial");
    expect(result.manifest.configuration).toEqual({ content: TUTORIAL_CONTENT });
    expect(result.warnings).toEqual([]);
    expect(JSON.parse(result.canonical)).toMatchObject({
      type: "tutorial",
      configuration: { content: TUTORIAL_CONTENT },
    });
  });

  it("tutorial 类型与作品类型不一致时拒绝", () => {
    expect(() => validateManifest(makeTutorialManifest(), "theme")).toThrow(/类型.*不一致/);
  });

  it("未知 type 被拒绝", () => {
    expect(() => validateManifest(makeTutorialManifest({ type: "lesson" }))).toThrow(/type 必须是/);
  });

  it("未知配置字段被拒绝（configuration 只允许 content）", () => {
    const manifest = makeTutorialManifest({
      configuration: { content: TUTORIAL_CONTENT, extra: "不该出现的字段" },
    });
    expect(() => validateManifest(manifest, "tutorial")).toThrow(/configuration 包含不支持的字段「extra」/);
  });

  it("未知 manifest 顶层字段被拒绝（不允许把 category 混进内容包）", () => {
    const manifest = makeTutorialManifest({ category: "guide" });
    expect(() => validateManifest(manifest, "tutorial")).toThrow(/manifest 包含不支持的字段「category」/);
  });

  it("正文超过 20000 字被拒绝，恰好 20000 字通过", () => {
    const tooLong = makeTutorialManifest({ configuration: { content: "字".repeat(LIMITS.tutorialChars + 1) } });
    expect(() => validateManifest(tooLong, "tutorial")).toThrow(/内容长度不能超过 20000 个字符/);

    const exact = makeTutorialManifest({ configuration: { content: "字".repeat(LIMITS.tutorialChars) } });
    const result = validateManifest(exact, "tutorial");
    expect((result.manifest.configuration as { content: string }).content).toHaveLength(20000);
  });

  it("空正文被拒绝", () => {
    expect(() => validateTutorialConfig({ content: "   \n\t " })).toThrow(/教程正文不能为空/);
  });

  it("正文中的 script/iframe 等 HTML 标签被拒绝", () => {
    for (const tag of ["<script>alert(1)</script>", "<iframe src=\"x\">", "<style>x</style>"]) {
      expect(() => validateTutorialConfig({ content: `前文\n\n${tag}` })).toThrow(/不能包含 HTML 标签/);
    }
  });

  it("教程分类白名单与服务端 CATEGORIES 一致", () => {
    expect(CATEGORIES.tutorial).toEqual(["guide", "tip", "workflow", "other"]);
    expect(CATEGORIES.tutorial).not.toContain("lesson");
    expect(POST_TYPES).toContain("tutorial");
    expect(LIMITS.tutorialChars).toBe(20_000);
  });
});

describe("教程内容包：客户端预检（宽松，仅提升即时反馈）", () => {
  it("合法 tutorial manifest 通过客户端预检", () => {
    const result = validateManifestClient(makeTutorialManifest(), "tutorial");
    expect(result).toMatchObject({ ok: true, errors: [], manifest: expect.objectContaining({ type: "tutorial" }) });
  });

  it("空正文被客户端提前拦下", () => {
    const result = validateManifestClient(
      makeTutorialManifest({ configuration: { content: "  " } }),
      "tutorial",
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("教程正文不能为空");
    expect(result.manifest).toBeNull();
  });

  it("未知 type 被客户端拒绝", () => {
    const result = validateManifestClient(makeTutorialManifest({ type: "lesson" }), "tutorial");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("type 不合法");
  });

  it("客户端不校验 20000 字上限与未知配置字段——由服务端兜底", () => {
    // 记录契约：客户端故意保持宽松，避免两套规则漂移后把可发布内容误拦。
    const overlong = validateManifestClient(
      makeTutorialManifest({ configuration: { content: "字".repeat(LIMITS.tutorialChars + 1) } }),
      "tutorial",
    );
    expect(overlong.ok).toBe(true);

    const extraKey = validateManifestClient(
      makeTutorialManifest({ configuration: { content: TUTORIAL_CONTENT, extra: 1 } }),
      "tutorial",
    );
    expect(extraKey.ok).toBe(true);
  });
});

describe("教程渲染：renderMarkdown 的转义边界", () => {
  it("转义 <script> 原始标签", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("转义 <img onerror> 原始标签，不产生可执行属性", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    // 整个标签退化为文本：尖括号被转义，因此不存在可执行的 img 元素/属性。
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[^>]*onerror/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("javascript: 链接不会生成 <a>，只作为文本保留", () => {
    const html = renderMarkdown("[点我](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[点我](javascript:alert(1))");
  });

  it("只把 http(s) 链接渲染为安全外链", () => {
    const html = renderMarkdown("[官网](https://example.com/a?b=1)");
    expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noreferrer noopener">官网</a>');
  });

  it("正文中的 Markdown 元素仍正常渲染", () => {
    const html = renderMarkdown(TUTORIAL_CONTENT);
    // h2 → h4：renderMarkdown 把 Markdown 标题整体下调两级（h1→h3）。
    expect(html).toContain("<h4>先清空桌面</h4>");
    expect(html).toContain("<strong>显示器</strong>");
    expect(html).toContain("<code>勿扰</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("<script>");
  });
});

describe("教程类型与分类标签", () => {
  it("TYPE_LABEL 包含教程", () => {
    expect(TYPE_LABEL.tutorial).toBe("教程");
  });

  it("教程分类标签为 guide / tip / workflow / other", () => {
    expect(Object.keys(CATEGORY_LABEL.tutorial)).toEqual(["guide", "tip", "workflow", "other"]);
    expect(CATEGORY_LABEL.tutorial.guide).toBe("指南");
    expect(CATEGORY_LABEL.tutorial.other).toBe("其他");
  });
});
