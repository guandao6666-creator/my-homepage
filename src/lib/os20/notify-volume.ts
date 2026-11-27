/**
 * 通知音量归一化（2.0.8）
 *
 * 为什么需要单独的函数：设置项允许音量 = 0（静音，见 core/settings.ts 的 schema），
 * 旧实现 `Number(value) || 45` 会把 0 当成「没设置」回落成 45，
 * 于是设置里显示 0、系统里实际是 45，用户永远静不了音。
 *
 * 规则：
 *   - 非有限数值（缺省/NaN/Infinity）→ 默认 45；
 *   - 数值钳到 0–100 并取整；
 *   - 0 是合法值，不回落。
 */
export const DEFAULT_NOTIFICATION_VOLUME = 45;

export function normalizeNotificationVolume(
  value: unknown,
  fallback: number = DEFAULT_NOTIFICATION_VOLUME,
): number {
  // 只有「真正缺失」才回落；数字 0 与字符串 "0" 都是合法的静音值。
  // null / 空串 / 布尔值来自损坏的设置，按缺失处理，避免把 false 当成 0。
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}