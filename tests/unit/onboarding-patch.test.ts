/**
 * 2.0.8 · 引导收尾只写「用户点过」的选项
 *
 * 旧实现的三个后果：
 *   1. 跳过引导会 applyLook({ dock: { autohide: false } })，关掉用户开着的自动隐藏；
 *   2. 跳过引导会按 choices.mode 切换 Local/Cloud（可能是上次中止留下的值）；
 *   3. 输入框里按 Esc 会整段跳过引导，刚输入的信息丢失。
 * 这里用纯函数把「写哪些字段」和「Esc 是否要忽略」钉住。
 */
import { describe, expect, it } from "vitest";
import { buildOnboardingPatch, isTypingTarget } from "../../src/lib/os20/apps/onboarding-patch";

const CHOICES = { dock: "left", iconLabels: false, clockSeconds: true, mode: "cloud" as const };

describe("引导收尾补丁", () => {
  it("什么都没点：不写程序坞位置，也不写运行模式", () => {
    const patch = buildOnboardingPatch(CHOICES, { dockTouched: false, modeTouched: false });
    expect(patch).toEqual({
      "desktop.iconLabels": false,
      "desktop.clockSeconds": true,
    });
    expect("desktop.dock.position" in patch).toBe(false);
    expect("system.mode" in patch).toBe(false);
  });

  it("只点过程序坞：写位置，但不动运行模式", () => {
    const patch = buildOnboardingPatch(CHOICES, { dockTouched: true, modeTouched: false });
    expect(patch["desktop.dock.position"]).toBe("left");
    expect("system.mode" in patch).toBe(false);
  });

  it("只点过模式：写模式，但不动程序坞", () => {
    const patch = buildOnboardingPatch(CHOICES, { dockTouched: false, modeTouched: true });
    expect(patch["system.mode"]).toBe("cloud");
    expect("desktop.dock.position" in patch).toBe(false);
  });

  it("两个都点过：各写各的", () => {
    const patch = buildOnboardingPatch(CHOICES, { dockTouched: true, modeTouched: true });
    expect(patch).toMatchObject({
      "desktop.dock.position": "left",
      "system.mode": "cloud",
      "desktop.iconLabels": false,
      "desktop.clockSeconds": true,
    });
  });
});

describe("Esc 的输入态判断", () => {
  const fakeElement = (hit: boolean) => ({
    closest: (selector: string) => (hit && selector.includes("input") ? {} : null),
  });

  it("输入框/文本域里按 Esc 不跳过", () => {
    expect(isTypingTarget(fakeElement(true))).toBe(true);
  });

  it("普通元素/空目标按 Esc 仍然跳过", () => {
    expect(isTypingTarget(fakeElement(false))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });

  it("源码约束：收尾有 in-flight 守卫，且不再传 autohide:false", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(new URL("../../src/lib/os20/apps/onboarding.ts", import.meta.url));
    const source = readFileSync(file, "utf8");
    expect(source).toContain("let finishing = false;");
    expect(source).toContain("if (finishing) return;");
    expect(source).not.toContain("autohide: false");
    expect(source).toContain("buildOnboardingPatch(");
  });
});