/**
 * 外观 look 的强调色语义：只有「这次真的谈到了强调色」才改 autoAccent。
 *
 * 2.0.5 前 applyLook 结尾无条件 `autoAccent = false`，导致用户选回
 * 「跟随壁纸」永远不生效，改材质/圆角/程序坞位置也会把取色顺手关掉。
 */
import { describe, expect, it } from "vitest";
import { resolveLookAccent } from "../../src/lib/os13/look";

const wall = { accent: "#123456", accent2: "#abcdef" };

describe("resolveLookAccent", () => {
  it("显式 accentAuto：打开取色并立刻采用壁纸主色", () => {
    expect(resolveLookAccent({ accentAuto: true }, false, wall)).toEqual({
      autoAccent: true,
      accent: "#123456",
      accent2: "#abcdef",
    });
  });

  it("显式 accentAuto 但壁纸还没选：只打开开关，不清空现有颜色", () => {
    expect(resolveLookAccent({ accentAuto: true }, false, null)).toEqual({ autoAccent: true });
  });

  it("显式固定色：关闭取色并写入小写 hex", () => {
    expect(resolveLookAccent({ accent: "#AABBCC" }, true, wall)).toEqual({
      autoAccent: false,
      accent: "#aabbcc",
      accent2: undefined,
    });
  });

  it("非法色值不吞掉当前状态，也不写入", () => {
    expect(resolveLookAccent({ accent: "red" }, true, wall)).toEqual({ autoAccent: true });
  });

  it("只改模式/材质时保持取色开关原状", () => {
    expect(resolveLookAccent({}, true, wall)).toEqual({ autoAccent: true });
    expect(resolveLookAccent({}, false, wall)).toEqual({ autoAccent: false });
  });
});