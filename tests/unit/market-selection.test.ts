/**
 * 2.0.8 · 市场搜索后选中项与详情栏的一致性
 *
 * 复现：选中作品 A → 在搜索框输入只匹配 B 的关键词 → 列表只剩 B，
 * 右侧仍画 A 的详情，「安装」按钮用的却是已被清空的 id，点下去没有反应。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSelection } from "../../src/lib/os20/apps/market-selection";

describe("选中项解析", () => {
  it("仍然可见就保留", () => {
    expect(resolveSelection("p-1", ["p-1", "p-2"])).toBe("p-1");
  });

  it("被过滤掉就清空", () => {
    expect(resolveSelection("p-1", ["p-2"])).toBe("");
  });

  it("本来没选、或列表为空，都返回空", () => {
    expect(resolveSelection("", ["p-1"])).toBe("");
    expect(resolveSelection("p-1", [])).toBe("");
  });
});

describe("market 接线约束", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/lib/os20/apps/market.ts", import.meta.url)),
    "utf8",
  );

  it("refreshData 用 resolveSelection 决定是否清空", () => {
    expect(source).toContain("state.selected = resolveSelection(current, list.map(keyOf));");
  });

  it("搜索过滤后同时重绘列表与详情栏", () => {
    expect(source).toContain('host.querySelector<HTMLElement>(".os20-mk-detail")');
    expect(source).toContain("detailHost.outerHTML = item ? detail(item) : emptyDetail();");
  });

  it("空详情只有一个来源", () => {
    expect(source.match(/const emptyDetail = \(\) =>/g)?.length).toBe(1);
  });
});