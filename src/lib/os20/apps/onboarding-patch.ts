/**
 * 引导收尾时的纯逻辑（2.0.8）
 *
 * 为什么抽出来：跳过引导与正常完成走同一个 finish()，旧实现无条件
 * `applyLook({ dock: { pos, autohide: false } })` 并写 `system.mode`：
 *   - 用户已开启「程序坞自动隐藏」，跳过引导会把它关掉，并与 settings.v1 分叉；
 *   - 跳过引导会按 choices.mode（可能是上次中止留下的 cloud）切换运行模式。
 * 收尾时允许写哪些字段，取决于用户本轮是否真的点过对应选项，而不是「是否完成」。
 */
export interface OnboardingPatchChoices {
  dock: string;
  iconLabels: boolean;
  clockSeconds: boolean;
  mode: "local" | "cloud";
}

export interface OnboardingTouched {
  dockTouched: boolean;
  modeTouched: boolean;
}

/** 只有用户点过的选项才写进系统设置；没点过的保持现状。 */
export function buildOnboardingPatch(
  choices: OnboardingPatchChoices,
  touched: OnboardingTouched,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    "desktop.iconLabels": choices.iconLabels,
    "desktop.clockSeconds": choices.clockSeconds,
  };
  if (touched.dockTouched) patch["desktop.dock.position"] = choices.dock;
  if (touched.modeTouched) patch["system.mode"] = choices.mode;
  return patch;
}

/** 输入态（输入框/文本域/下拉/可编辑区）里按 Esc 不应该触发「跳过引导」。 */
export function isTypingTarget(target: unknown): boolean {
  const node = target as { closest?: (selector: string) => unknown } | null;
  if (!node || typeof node.closest !== "function") return false;
  return Boolean(node.closest("input, textarea, select, [contenteditable='true']"));
}