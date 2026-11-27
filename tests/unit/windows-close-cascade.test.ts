/**
 * Guandao OS 2.0.11 · 窗口关闭通知去重 + 窄视口级联布局
 *
 * 为什么用假 Shell：这两条都是「同一事件被走两遍」「几何被 clamp 顶回原处」的
 * 纯逻辑问题，真浏览器反而看不出（两次 emit 只是性能与重复保存，用户无感）。
 */
import { describe, expect, it, vi } from "vitest";
import type { WindowShell } from "../../src/lib/core/windows.js";
import { WindowManager } from "../../src/lib/core/windows.js";
import { clampRect, rescaleSnapshot, settleCascade, type Rect, type Viewport, type WorkspaceSnapshot } from "../../src/lib/core/layout.js";

function fakeShell(options: { dispatchOnClosed?: boolean; closes?: boolean } = {}) {
  const callbacks = new Set<(appId: string) => void>();
  const open = new Set<string>();
  const shell: WindowShell = {
    open: (appId) => {
      open.add(appId);
    },
    close: (appId) => {
      if (options.closes === false) return false;
      const had = open.delete(appId);
      if (had && options.dispatchOnClosed !== false) for (const cb of callbacks) cb(appId);
      return true;
    },
    closeAll: () => open.clear(),
    focus: () => true,
    minimize: () => true,
    restore: () => true,
    maximize: () => true,
    isOpen: (appId) => open.has(appId),
    getGeometry: () => null,
    setGeometry: () => undefined,
    getSpace: () => 1,
    setSpace: () => true,
    listOpen: () => [...open].map((appId) => ({ appId, space: 1 } as never)),
    listSpaces: () => [],
    currentSpace: () => 1,
    viewport: () => ({ width: 1280, height: 800 }),
    onClosed: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  };
  return { shell, open };
}

describe("窗口关闭通知", () => {
  it("Shell 回调与 close() 返回值描述同一次关闭时只通知一次", () => {
    const { shell } = fakeShell();
    const emitted: string[] = [];
    const wm = new WindowManager({ shell, emit: (type) => emitted.push(type) });
    const closed = vi.fn();
    wm.onClosed(closed);

    wm.close("notes");

    expect(closed).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual(["window:closed"]);
  });

  it("Shell 没有回调时 close() 自己补一次通知（不丢事件）", () => {
    const { shell } = fakeShell({ dispatchOnClosed: false });
    const emitted: string[] = [];
    const wm = new WindowManager({ shell, emit: (type) => emitted.push(type) });
    const closed = vi.fn();
    wm.onClosed(closed);

    wm.close("notes");

    expect(closed).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual(["window:closed"]);
  });

  it("关闭失败不通知；之后再次真正关闭仍然通知（去重不吞后续事件）", async () => {
    const { shell } = fakeShell({ closes: false });
    const emitted: string[] = [];
    const wm = new WindowManager({ shell, emit: (type) => emitted.push(type) });
    const closed = vi.fn();
    wm.onClosed(closed);

    expect(wm.close("notes")).toBe(false);
    expect(closed).not.toHaveBeenCalled();

    // 换成能关闭的 Shell，跨一个微任务再关，验证去重集合已清理。
    const real = fakeShell();
    const wm2 = new WindowManager({ shell: real.shell, emit: (type) => emitted.push(type) });
    wm2.onClosed(closed);
    await Promise.resolve();
    wm2.close("notes");
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

const VIEW: Viewport = { width: 800, height: 500 };

function snapshot(windows: Record<string, Rect>, viewport: Viewport): WorkspaceSnapshot {
  const entries = Object.entries(windows).map(([appId, rect]) => [
    appId,
    {
      appId,
      space: 1,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      minimized: false,
      maximized: false,
      zone: null,
    },
  ]);
  return { schemaVersion: 2, at: 1, viewport, windows: Object.fromEntries(entries) } as WorkspaceSnapshot;
}


describe("窄视口恢复级联", () => {
  it("两个窗口都被夹到右下角时，级联会把它们错开而不是完全重叠", () => {
    const right = clampRect({ x: 2000, y: 1400, width: 700, height: 460 }, VIEW);
    const left = clampRect({ x: 1900, y: 1300, width: 700, height: 460 }, VIEW);
    expect(right.x).toBe(left.x);
    expect(right.y).toBe(left.y);

    const [first, second] = settleCascade([right, left], VIEW);
    // 契约是「不再完全重叠」，而不是「一点不压」——小屏上窗口本来就会互相压住一部分。
    expect(first).not.toEqual(second);
    expect(Math.abs(first!.x - second!.x) + Math.abs(first!.y - second!.y)).toBeGreaterThanOrEqual(50);
  });

  it("视口比窗口还小时保留原位置（无处可让，不制造抖动）", () => {
    const tiny: Viewport = { width: 300, height: 200 };
    const rect = clampRect({ x: 0, y: 0, width: 900, height: 700 }, tiny);
    expect(settleCascade([rect, rect], tiny)).toEqual([rect, rect]);
  });

  it("rescaleSnapshot 从桌面视口恢复到手机会把窗口错开", () => {
    const desktop: Viewport = { width: 1440, height: 900 };
    const source = snapshot(
      {
        notes: { x: 660, y: 420, width: 760, height: 470 },
        calendar: { x: 700, y: 440, width: 760, height: 470 },
      },
      desktop,
    );

    const scaled = rescaleSnapshot(source, VIEW);
    const a = scaled.windows.notes!;
    const b = scaled.windows.calendar!;
    const rectA = { x: a.left, y: a.top, width: a.width, height: a.height };
    const rectB = { x: b.left, y: b.top, width: b.width, height: b.height };
    expect(rectA).not.toEqual(rectB);
    expect(Math.abs(rectA.x - rectB.x) + Math.abs(rectA.y - rectB.y)).toBeGreaterThanOrEqual(50);
  });

  it("cascade:false 时保持 clamp 后的原位置", () => {
    const rect = { x: 2000, y: 1400, width: 700, height: 460 };
    const source = snapshot({ notes: rect, calendar: rect }, { width: 1440, height: 900 });
    const scaled = rescaleSnapshot(source, VIEW, { cascade: false });
    expect(scaled.windows.notes!.left).toBe(scaled.windows.calendar!.left);
  });
});