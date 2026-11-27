/**
 * 壁纸卡片：社区标题是别人可控输入，必须转义后才能拼 HTML。
 *
 * 2.0.5 之前 renderWallGallery 直接拼 `title="${w.name}"` / `<span>${w.name}</span>`，
 * 一批「标题里带 <svg/onload>」的壁纸就能在别人安装后于设置页执行脚本。
 */
import { describe, expect, it } from "vitest";
import { wallCardHtml } from "../../src/lib/os13/wall-card";

const base = (overrides: Partial<{ id: string; name: string; thumb: string; custom: boolean }> = {}) => ({
  id: "custom-abc",
  name: "我的壁纸",
  thumb: "blob:https://guandao.xin/abc",
  custom: true,
  ...overrides,
});

describe("wallCardHtml", () => {
  it("把标题里的标签转义成文本，而不是注入 DOM", () => {
    const html = wallCardHtml(base({ name: `<svg/onload=alert(1)>` }), { active: false, favorite: false });
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg/onload=alert(1)&gt;");
    // title 属性与文本节点两处都要转义
    expect(html).toContain(`title="&lt;svg/onload=alert(1)&gt;"`);
  });

  it("引号会被转义，不能跳出 title 属性", () => {
    const html = wallCardHtml(base({ name: `说"话"的壁纸` }), { active: false, favorite: false });
    expect(html).toContain(`title="说&quot;话&quot;的壁纸"`);
    expect(html).not.toContain(`title="说"话"的壁纸"`);
  });

  it("壁纸 id 也按属性转义，不信任调用方", () => {
    const html = wallCardHtml(base({ id: `x" onmouseover="alert(1)` }), { active: false, favorite: false });
    expect(html).not.toContain(`data-wall-id="x" onmouseover=`);
    expect(html).toContain("&quot;");
  });

  it("自定义壁纸允许 blob: 预览，非法协议被挡成空地址", () => {
    const ok = wallCardHtml(base(), { active: false, favorite: false });
    expect(ok).toContain('src="blob:https://guandao.xin/abc"');
    const bad = wallCardHtml(base({ thumb: "javascript:alert(1)" }), { active: false, favorite: false });
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("wc-void");
  });

  it("状态位决定 class 与操作按钮", () => {
    const html = wallCardHtml(base(), { active: true, favorite: true });
    expect(html).toContain("wall-card is-active");
    expect(html).toContain("wc-fav is-on");
    expect(html).toContain('data-del="custom-abc"');
    const builtin = wallCardHtml({ id: "aurora", name: "极光", thumb: "/wallpapers/aurora.jpg", custom: false }, { active: false, favorite: false });
    expect(builtin).not.toContain("data-del");
    expect(builtin).toContain('src="/wallpapers/aurora.jpg"');
  });
});