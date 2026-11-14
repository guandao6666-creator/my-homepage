/**
 * Guandao OS 2.5 · 社区模块拆分后的兼容性与纯函数测试。
 *
 * 拆分只搬动代码位置，不改变行为：
 * - 公开导出必须仍然是 renderCommunity / initCommunity
 * - 纯渲染层可以脱离 initCommunity 单独调用
 */
import { describe, expect, it } from "vitest";
import * as community from "../../src/lib/os14/community";
import { clampText, esc, bytesText, timeAgo } from "../../src/lib/os14/community/ui";
import { notificationBody, notificationTitle } from "../../src/lib/os14/community/notifications";

describe("社区模块 · 公共导出兼容性", () => {
  it("保留历史导出 renderCommunity / initCommunity", () => {
    expect(typeof community.renderCommunity).toBe("function");
    expect(typeof community.initCommunity).toBe("function");
  });

  it("拆分后没有新增不必要的历史导出", () => {
    // 记录当前导出面，防止以后悄悄扩大公共 API
    expect(Object.keys(community).sort()).toEqual(["initCommunity", "renderCommunity"]);
  });
});

describe("社区模块 · 纯渲染工具", () => {
  it("esc 走统一转义（不引入第二套实现）", () => {
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc('" onmouseover="x')).toBe("&quot; onmouseover=&quot;x");
    expect(esc(null)).toBe("");
    expect(esc(0)).toBe("0");
  });

  it("clampText 去空白并截断", () => {
    expect(clampText("  abcdef  ", 3)).toBe("abc");
    expect(clampText("abc", 10)).toBe("abc");
  });

  it("bytesText 输出可读体积", () => {
    expect(bytesText(0)).toContain("0");
    expect(bytesText(1024)).toMatch(/1/);
  });

  it("timeAgo 对空值返回占位符而不是崩溃", () => {
    expect(typeof timeAgo(null)).toBe("string");
    expect(timeAgo(null).length).toBeGreaterThan(0);
  });
});

describe("社区模块 · 通知文案（批次 2 搬出闭包）", () => {
  const item = (type: string, payload: Record<string, unknown> = {}, actor?: { displayName?: string }) =>
    ({ type, payload, actor }) as never;

  it("按通知类型给出标题", () => {
    expect(notificationTitle(item("comment"))).toBe("收到新评论");
    expect(notificationTitle(item("reply"))).toBe("收到回复");
    expect(notificationTitle(item("follow"))).toBe("有新的关注者");
    expect(notificationTitle(item("moderation"))).toBe("社区管理通知");
  });

  it("未知类型回落到默认标题，不会抛错", () => {
    expect(notificationTitle(item("something_new"))).toBe("社区通知");
    expect(notificationTitle(item("", {}))).toBe("社区通知");
  });

  it("正文优先使用 payload.message", () => {
    expect(notificationBody(item("comment", { message: "你好" }))).toBe("你好");
  });

  it("正文带作者名时才拼接作者名", () => {
    const withActor = notificationBody(item("comment", { excerpt: "片段" }, { displayName: "管道" }));
    expect(withActor).toContain("管道");
    expect(withActor).toContain("片段");
  });

  it("payload 为空时不崩溃", () => {
    expect(typeof notificationBody(item("comment"))).toBe("string");
  });
});