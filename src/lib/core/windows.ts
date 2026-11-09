/**
 * Guandao OS 2.0 · Window Manager
 *
 * 1.x 的窗口系统已经能拖动 / 缩放 / 贴靠，但能力全部锁在桌面脚本的闭包里，
 * 应用只能通过 `ctx.openApp(id)` 这一个入口。2.0 把这些能力收成一个明确的接口：
 *
 *   shell（由 Desktop Shell 实现的适配器）
 *        ↑
 *   WindowManager（统一 API + 错误隔离 + 布局策略）
 *        ↑
 *   应用 / 插件 / 命令面板 / 工作空间
 *
 * 关键点：
 *   - 应用不再自己实现拖动缩放，只调用 `wm.open(appId)`；
 *   - 某一个窗口操作抛错只记录，不影响桌面（§5.3 错误隔离）；
 *   - 贴靠 / 分屏 / 快照恢复由这里计算，Shell 只负责应用几何。
 *
 * 本模块不直接操作 DOM（几何计算在 layout.ts，DOM 交给注入的 shell），可单测。
 */

import {
  clampRect,
  isSnapshot,
  normalizeSnapshot,
  rescaleSnapshot,
  snapRect,
  splitRects,
  type Rect,
  type SnapZone,
  type Viewport,
  type WorkspaceSnapshot,
} from "./layout";

export type OpenWindow = {
  appId: string;
  space: number;
  minimized: boolean;
  maximized: boolean;
  geometry: Rect | null;
};

export type SpaceInfo = { id: number; name: string };

/**
 * Desktop Shell 需要实现的接口。
 * 桌面脚本里用一个很薄的适配器把它接到 1.x 的窗口系统上。
 */
export interface WindowShell {
  open(appId: string): void;
  close(appId: string): boolean;
  closeAll(): void;
  focus(appId: string): boolean;
  minimize(appId: string): boolean;
  restore(appId: string): boolean;
  maximize(appId: string): boolean;
  isOpen(appId: string): boolean;
  getGeometry(appId: string): Rect | null;
  setGeometry(appId: string, rect: Rect): void;
  getSpace(appId: string): number | null;
  setSpace(appId: string, space: number): boolean;
  listOpen(): OpenWindow[];
  listSpaces(): SpaceInfo[];
  currentSpace(): number;
  viewport(): Viewport;
  /** 窗口关闭时回调（Shell 负责在 closeWin 里触发） */
  onClosed(cb: (appId: string) => void): () => void;
}

export type WindowManagerOptions = {
  shell: WindowShell;
  emit?: (type: string, payload?: unknown) => void;
  /** 单次 Shell 调用出错时的日志 */
  onError?: (info: { op: string; appId: string; error: unknown }) => void;
  /** 布局持久化（2.0 用 guandao.core.layout.v2） */
  persist?: (snapshot: WorkspaceSnapshot) => void;
  load?: () => WorkspaceSnapshot | null;
};

export type WindowLayoutKind = "free" | "split" | "snap" | "maximize";

export class WindowManager {
  private shell: WindowShell;
  private emitFn: (type: string, payload?: unknown) => void;
  private onError: (info: { op: string; appId: string; error: unknown }) => void;
  private persistFn?: (snapshot: WorkspaceSnapshot) => void;
  private loadFn?: () => WorkspaceSnapshot | null;
  private errors: Array<{ at: number; op: string; appId: string; message: string }> = [];
  private offClosed: (() => void) | null = null;
  private closedListeners = new Set<(appId: string) => void>();

  constructor(options: WindowManagerOptions) {
    this.shell = options.shell;
    this.emitFn = options.emit ?? (() => undefined);
    this.onError =
      options.onError ??
      (() => {
        /* 默认静默，由 Kernel 接上诊断中心 */
      });
    this.persistFn = options.persist;
    this.loadFn = options.load;
    this.offClosed = this.shell.onClosed((appId) => {
      this.notifyClosed(appId);
      this.emitFn("window:closed", { appId });
    });
  }

  /** 订阅「窗口已关闭」，返回取消函数。应用运行时靠它把状态收敛回 enabled */
  onClosed(cb: (appId: string) => void): () => void {
    this.closedListeners.add(cb);
    return () => this.closedListeners.delete(cb);
  }

  /* ---------------- 基本操作 ---------------- */

  open(appId: string, geometry?: Rect): boolean {
    if (!appId) return false;
    return this.safe("open", appId, () => {
      this.shell.open(appId);
      if (geometry) {
        const rect = clampRect(geometry, this.viewport());
        this.shell.setGeometry(appId, rect);
      }
      this.emitFn("window:opened", { appId });
      return true;
    }, false);
  }

  close(appId: string): boolean {
    return this.safe("close", appId, () => {
      const closed = this.shell.close(appId);
      if (closed) {
        this.notifyClosed(appId);
        this.emitFn("window:closed", { appId });
      }
      return closed;
    }, false);
  }

  focus(appId: string): boolean {
    return this.safe("focus", appId, () => this.shell.focus(appId), false);
  }

  minimize(appId: string): boolean {
    return this.safe("minimize", appId, () => this.shell.minimize(appId), false);
  }

  restore(appId: string): boolean {
    return this.safe("restore", appId, () => this.shell.restore(appId), false);
  }

  toggleMaximize(appId: string): boolean {
    return this.safe("maximize", appId, () => this.shell.maximize(appId), false);
  }

  closeAll(): void {
    this.safe("closeAll", "*", () => {
      this.shell.closeAll();
      return true;
    }, false);
  }

  isOpen(appId: string): boolean {
    return this.safe("isOpen", appId, () => this.shell.isOpen(appId), false);
  }

  listOpen(): OpenWindow[] {
    return this.safe("listOpen", "*", () => this.shell.listOpen(), []);
  }

  spaces(): { spaces: SpaceInfo[]; current: number } {
    return this.safe(
      "spaces",
      "*",
      () => ({ spaces: this.shell.listSpaces(), current: this.shell.currentSpace() }),
      { spaces: [], current: 1 },
    );
  }

  moveToSpace(appId: string, space: number): boolean {
    return this.safe("moveToSpace", appId, () => this.shell.setSpace(appId, space), false);
  }

  viewport(): Viewport {
    return this.safe("viewport", "*", () => this.shell.viewport(), {
      width: 1280,
      height: 800,
    });
  }

  /* ---------------- 布局 ---------------- */

  /** 贴靠：按区域计算矩形并应用 */
  snap(appId: string, zone: SnapZone): boolean {
    return this.safe("snap", appId, () => {
      const rect = snapRect(zone, this.viewport());
      this.shell.setGeometry(appId, rect);
      this.emitFn("window:snapped", { appId, zone, rect });
      return true;
    }, false);
  }

  /** 分屏：把若干窗口铺满横向 / 纵向 */
  split(appIds: string[], direction: "horizontal" | "vertical" = "horizontal"): boolean {
    const ids = appIds.filter(Boolean).slice(0, 3);
    if (ids.length < 2) return false;
    return this.safe("split", ids.join(","), () => {
      const rects = splitRects(ids.length as 2 | 3, this.viewport(), direction);
      ids.forEach((appId, index) => {
        if (!this.shell.isOpen(appId)) this.shell.open(appId);
        this.shell.setGeometry(appId, rects[index]);
      });
      this.emitFn("window:split", { appIds: ids, direction });
      return true;
    }, false);
  }

  layoutOf(appId: string): WindowLayoutKind {
    return this.safe(
      "layoutOf",
      appId,
      () => {
        const geometry = this.shell.getGeometry(appId);
        if (!geometry) return "free";
        const viewport = this.viewport();
        if (geometry.width >= viewport.width - 4 && geometry.height >= viewport.height - 4) return "maximize";
        const half = Math.abs(geometry.width - (viewport.width - 20) / 2) < 24;
        return half ? "snap" : "free";
      },
      "free",
    );
  }

  /* ---------------- 快照 / 恢复 ---------------- */

  snapshot(): WorkspaceSnapshot {
    const viewport = this.viewport();
    const windows: WorkspaceSnapshot["windows"] = {};
    for (const entry of this.listOpen()) {
      const geometry = entry.geometry ?? { x: 80, y: 80, width: 720, height: 520 };
      windows[entry.appId] = {
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        minimized: entry.minimized,
        maximized: entry.maximized,
        space: entry.space,
      };
    }
    const snapshot: WorkspaceSnapshot = { schemaVersion: 2, at: Date.now(), viewport, windows };
    try {
      this.persistFn?.(snapshot);
    } catch (error) {
      this.note("persist", "*", error);
    }
    return snapshot;
  }

  /** 读取持久化的布局；1.x 的旧格式会被升级成 2.0 结构 */
  saved(): WorkspaceSnapshot | null {
    try {
      const loaded = this.loadFn?.() ?? null;
      if (!loaded) return null;
      if (isSnapshot(loaded)) return loaded;
      return normalizeSnapshot(loaded, this.viewport());
    } catch (error) {
      this.note("load", "*", error);
      return null;
    }
  }

  /**
   * 恢复布局：先按当前视口重算几何，再逐个打开。
   * 与 1.x 的 `restoreWindows` 不同，这里不依赖「先关窗再开窗」的时序，
   * 而是把几何直接交给 Shell，避免恢复过程中闪一下。
   */
  async restoreLayout(snapshot?: WorkspaceSnapshot | null, options: { closeExisting?: boolean } = {}): Promise<{
    restored: string[];
    skipped: string[];
  }> {
    const source = snapshot ?? this.saved();
    if (!source) return { restored: [], skipped: [] };
    if (options.closeExisting) this.closeAll();

    const target = rescaleSnapshot(source, this.viewport());
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const [appId, state] of Object.entries(target.windows)) {
      const ok = this.safe(
        "restore",
        appId,
        () => {
          this.shell.open(appId);
          this.shell.setGeometry(appId, { x: state.left, y: state.top, width: state.width, height: state.height });
          if (state.minimized) this.shell.minimize(appId);
          if (state.maximized) this.shell.maximize(appId);
          this.shell.setSpace(appId, state.space);
          return true;
        },
        false,
      );
      if (ok) restored.push(appId);
      else skipped.push(appId);
    }
    this.emitFn("window:restored", { restored, skipped });
    return { restored, skipped };
  }

  /* ---------------- 诊断 ---------------- */

  stats(): {
    open: number;
    minimized: number;
    maximized: number;
    byApp: Record<string, number>;
    errors: number;
    viewport: Viewport;
    space: number;
  } {
    const windows = this.listOpen();
    const byApp: Record<string, number> = {};
    let minimized = 0;
    let maximized = 0;
    for (const entry of windows) {
      byApp[entry.appId] = (byApp[entry.appId] ?? 0) + 1;
      if (entry.minimized) minimized += 1;
      if (entry.maximized) maximized += 1;
    }
    return {
      open: windows.length,
      minimized,
      maximized,
      byApp,
      errors: this.errors.length,
      viewport: this.viewport(),
      space: this.safe("currentSpace", "*", () => this.shell.currentSpace(), 1),
    };
  }

  recentErrors(limit = 10): Array<{ at: number; op: string; appId: string; message: string }> {
    return this.errors.slice(-limit).reverse();
  }

  dispose(): void {
    this.offClosed?.();
    this.offClosed = null;
  }

  /* ---------------- 内部 ---------------- */

  private safe<T>(op: string, appId: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      this.note(op, appId, error);
      return fallback;
    }
  }

  private note(op: string, appId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push({ at: Date.now(), op, appId, message });
    if (this.errors.length > 50) this.errors.shift();
    this.emitFn("window:error", { op, appId, message });
    try {
      this.onError({ op, appId, error });
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  private notifyClosed(appId: string): void {
    for (const cb of [...this.closedListeners]) {
      try {
        cb(appId);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }
}

export const createWindowManager = (options: WindowManagerOptions) => new WindowManager(options);