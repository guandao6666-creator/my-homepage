/**
 * 网格图标落点：2.0.5 前按「左上角阈值」判断，第一个图标恒满足条件，
 * 于是无论拖到哪里都插到第一位。这里钉住按中心距离选目标的语义。
 */
import { describe, expect, it } from "vitest";
import { pickGridDrop } from "../../src/lib/os13/icons-order";

const grid = [
  { left: 0, top: 0, width: 100, height: 100 },
  { left: 110, top: 0, width: 100, height: 100 },
  { left: 0, top: 110, width: 100, height: 100 },
];

describe("pickGridDrop", () => {
  it("没有候选图标时返回 null", () => {
    expect(pickGridDrop([], { x: 10, y: 10 })).toBeNull();
  });

  it("拖到第一个图标左侧上半区：插到它之前", () => {
    expect(pickGridDrop(grid, { x: 8, y: 8 })).toEqual({ index: 0, after: false });
  });

  it("拖到第二个图标右侧：插到它之后（旧实现会恒回 index 0）", () => {
    const hit = pickGridDrop(grid, { x: 250, y: 50 });
    expect(hit).toEqual({ index: 1, after: true });
  });

  it("拖到第三行下方：插到第三个之后", () => {
    expect(pickGridDrop(grid, { x: 20, y: 260 })).toEqual({ index: 2, after: true });
  });

  it("落在两图标之间时选中心更近的那个", () => {
    // (105, 50)：距图标 1 中心 (160,50) 55px，距图标 0 中心 (50,50) 55px 打平，方向偏左 → index 0 after
    expect(pickGridDrop(grid, { x: 99, y: 50 })).toEqual({ index: 0, after: true });
  });

  it("同列上下：偏上插前面、偏下插后面", () => {
    expect(pickGridDrop(grid, { x: 50, y: 20 })).toEqual({ index: 0, after: false });
    expect(pickGridDrop(grid, { x: 50, y: 80 })).toEqual({ index: 0, after: true });
  });
});