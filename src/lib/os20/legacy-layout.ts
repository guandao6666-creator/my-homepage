/**
 * Guandao OS 2.0.6 · 1.x 布局快照
 *
 * 2.0.5 之前 `2.0-layout-snapshot` 迁移写成：
 *   { schemaVersion: 2, viewport: { width: 0, height: 0 }, windows, legacy: true }
 *
 * 问题在于 `isSnapshot()` 只检查 schemaVersion 与 viewport 是否为真值——
 * `{width: 0, height: 0}` 是对象，检查通过，于是 `rescaleSnapshot()` 拿 0 当分母：
 * 位置被乘成 0（再被 clamp 到边界），窗口全堆在屏幕一角，1.x 的布局等于丢光。
 *
 * 1.x 根本没有可信的视口尺寸，正确做法是**不写** schemaVersion / viewport，
 * 让 `normalizeSnapshot()` 用当前真实视口补全；`legacy: true` 保留下来给诊断用。
 */
import type { WorkspaceSnapshot } from "../core/layout";
import { normalizeSnapshot } from "../core/layout";

export type LegacyLayoutPayload = {
  at: number;
  windows: Record<string, unknown>;
  legacy: true;
};

export function legacyLayoutSnapshot(windows: Record<string, unknown> | undefined, at: number = Date.now()): LegacyLayoutPayload {
  return {
    at,
    windows: windows ?? {},
    legacy: true,
  };
}

/**
 * 迁移时就把 1.x 形状的窗口换算成 2.0 结构，写入前就能发现坏几何。
 * 用真实视口归一化，避免 `rescaleSnapshot` 拿到 0×0。
 */
export function legacyLayoutSnapshotForViewport(
  windows: Record<string, unknown> | undefined,
  viewport: { width: number; height: number },
  at: number = Date.now(),
): WorkspaceSnapshot {
  return normalizeSnapshot(legacyLayoutSnapshot(windows, at), viewport);
}