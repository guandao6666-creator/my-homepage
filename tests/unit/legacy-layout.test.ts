/**
 * 1.x → 2.0 布局迁移：不能写 `viewport: {width: 0, height: 0}`。
 *
 * `isSnapshot()` 只看字段是否为真值，0×0 是对象所以会「通过」；
 * `rescaleSnapshot()` 再拿 0 当分母，窗口位置全被压成 0（1.x 布局丢失）。
 */
import { describe, expect, it } from "vitest";
import { isSnapshot, normalizeSnapshot, rescaleSnapshot } from "../../src/lib/core/layout";
import { legacyLayoutSnapshot, legacyLayoutSnapshotForViewport } from "../../src/lib/os20/legacy-layout";

const windows = {
  notes: { left: 120, top: 80, width: 640, height: 420, space: 1 },
  files: { left: 300, top: 200, width: 720, height: 480, space: 2 },
};

describe("legacyLayoutSnapshot", () => {
  it("不写 schemaVersion / viewport，避免被误判成 2.0 快照", () => {
    const payload = legacyLayoutSnapshot(windows, 1_700_000_000_000);
    expect(payload).toEqual({ at: 1_700_000_000_000, windows, legacy: true });
    expect(isSnapshot(payload)).toBe(false);
  });

  it("用真实视口归一化后保留窗口几何", () => {
    const snapshot = legacyLayoutSnapshotForViewport(windows, { width: 1440, height: 900 }, 1_700_000_000_000);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.viewport).toEqual({ width: 1440, height: 900 });
    expect(snapshot.windows.notes).toMatchObject({ left: 120, top: 80, width: 640, height: 420 });
    expect(snapshot.windows.files).toMatchObject({ left: 300, top: 200, width: 720, height: 480, space: 2 });
  });

  it("同视口恢复时位置不漂移（回归：旧的 0×0 快照会把 left/top 压成 0）", () => {
    const fixed = legacyLayoutSnapshotForViewport(windows, { width: 1440, height: 900 });
    const restored = rescaleSnapshot(fixed, { width: 1440, height: 900 });
    expect(restored.windows.notes.left).toBe(120);
    expect(restored.windows.notes.top).toBe(80);

    // 旧形状的回归证据：0×0 视口让 120/80 被乘成 17 万，再被 clamp 到右下角
    const broken = {
      schemaVersion: 2 as const,
      at: Date.now(),
      viewport: { width: 0, height: 0 },
      windows: normalizeSnapshot(windows, { width: 1440, height: 900 }).windows,
    };
    const drifted = rescaleSnapshot(broken, { width: 1440, height: 900 });
    expect(drifted.windows.notes.left).toBe(800);
    expect(drifted.windows.notes.top).toBe(480);
  });
});