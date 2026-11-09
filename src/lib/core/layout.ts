/**
 * Guandao OS 2.0 · 窗口布局（纯几何）
 *
 * 2.0 的窗口系统要支持 Free / Split / Snap / Fullscreen / Restore，
 * 还要在「跨设备恢复」时重新计算尺寸与位置（§5.2）。
 * 这些计算与 DOM 无关，所以单独放在这里，可以在 Node 里单测。
 *
 * 约定：坐标相对窗口内容区左上角；viewport 是可用区域（已扣除菜单栏 / 程序坞）。
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type Viewport = { width: number; height: number };

export const MIN_WINDOW_WIDTH = 320;
export const MIN_WINDOW_HEIGHT = 240;

/** 贴靠区域。命名沿用 1.x 的 snap-zone 语义，方便直接对接拖动预览 */
export type SnapZone =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "maximize"
  | "center";

const GAP = 10;

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

/** 把窗口约束在可视区内，并保证不小于最小尺寸 */
export function clampRect(rect: Rect, viewport: Viewport): Rect {
  const maxWidth = Math.max(MIN_WINDOW_WIDTH, viewport.width);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, viewport.height);
  const width = clampNumber(rect.width, MIN_WINDOW_WIDTH, maxWidth);
  const height = clampNumber(rect.height, MIN_WINDOW_HEIGHT, maxHeight);
  const x = clampNumber(rect.x, 0, Math.max(0, viewport.width - width));
  const y = clampNumber(rect.y, 0, Math.max(0, viewport.height - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** 等比缩小到视口内（只缩不放），用于「从大屏恢复到小屏」 */
export function fitRect(rect: Rect, viewport: Viewport): Rect {
  const scale = Math.min(1, viewport.width / Math.max(1, rect.width), viewport.height / Math.max(1, rect.height));
  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(rect.width * scale));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(rect.height * scale));
  return clampRect({ x: rect.x, y: rect.y, width, height }, viewport);
}

/**
 * 贴靠矩形。
 * left/right 占一半宽度，四角各占一半，top/bottom 全宽半高，maximize 铺满。
 */
export function snapRect(zone: SnapZone, viewport: Viewport): Rect {
  const w = Math.max(MIN_WINDOW_WIDTH, viewport.width - GAP * 2);
  const h = Math.max(MIN_WINDOW_HEIGHT, viewport.height - GAP * 2);
  const halfW = Math.max(MIN_WINDOW_WIDTH, Math.floor((w - GAP) / 2));
  const halfH = Math.max(MIN_WINDOW_HEIGHT, Math.floor((h - GAP) / 2));
  const rightW = Math.max(MIN_WINDOW_WIDTH, w - halfW - GAP);
  const bottomH = Math.max(MIN_WINDOW_HEIGHT, h - halfH - GAP);

  switch (zone) {
    case "left":
      return { x: GAP, y: GAP, width: halfW, height: h };
    case "right":
      return { x: GAP + halfW + GAP, y: GAP, width: rightW, height: h };
    case "top":
      return { x: GAP, y: GAP, width: w, height: halfH };
    case "bottom":
      return { x: GAP, y: GAP + halfH + GAP, width: w, height: bottomH };
    case "top-left":
      return { x: GAP, y: GAP, width: halfW, height: halfH };
    case "top-right":
      return { x: GAP + halfW + GAP, y: GAP, width: rightW, height: halfH };
    case "bottom-left":
      return { x: GAP, y: GAP + halfH + GAP, width: halfW, height: bottomH };
    case "bottom-right":
      return { x: GAP + halfW + GAP, y: GAP + halfH + GAP, width: rightW, height: bottomH };
    case "center":
      return clampRect(
        {
          x: Math.round((viewport.width - Math.min(960, w)) / 2),
          y: Math.round((viewport.height - Math.min(680, h)) / 2),
          width: Math.min(960, w),
          height: Math.min(680, h),
        },
        viewport,
      );
    case "maximize":
    default:
      return { x: 0, y: 0, width: Math.max(MIN_WINDOW_WIDTH, viewport.width), height: Math.max(MIN_WINDOW_HEIGHT, viewport.height) };
  }
}

/**
 * 分屏：把视口横向（或纵向）切成 count 份。
 * 2.0 的 Split Layout 只支持 2 / 3 屏，再多就不如用贴靠。
 */
export function splitRects(count: 2 | 3, viewport: Viewport, direction: "horizontal" | "vertical" = "horizontal"): Rect[] {
  const total = direction === "horizontal" ? Math.max(MIN_WINDOW_WIDTH, viewport.width - GAP * 2) : Math.max(MIN_WINDOW_HEIGHT, viewport.height - GAP * 2);
  const usable = total - GAP * (count - 1);
  const base = Math.floor(usable / count);
  const out: Rect[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = index === count - 1 ? usable - base * (count - 1) : base;
    if (direction === "horizontal") {
      out.push({
        x: GAP + index * (base + GAP),
        y: GAP,
        width: Math.max(MIN_WINDOW_WIDTH, size),
        height: Math.max(MIN_WINDOW_HEIGHT, viewport.height - GAP * 2),
      });
    } else {
      out.push({
        x: GAP,
        y: GAP + index * (base + GAP),
        width: Math.max(MIN_WINDOW_WIDTH, viewport.width - GAP * 2),
        height: Math.max(MIN_WINDOW_HEIGHT, size),
      });
    }
  }
  return out;
}

/* ============================================================
   工作空间快照（跨设备恢复）
   ============================================================ */

export type WindowState = {
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  space: number;
  /** 2.0：贴靠状态，恢复时优先按 zone 重算，而不是硬套旧坐标 */
  zone?: SnapZone;
};

export type WorkspaceSnapshot = {
  schemaVersion: 2;
  at: number;
  /** 记录快照时的视口，用于判断是否需要缩放 */
  viewport: Viewport;
  windows: Record<string, WindowState>;
};

export const isSnapshot = (value: unknown): value is WorkspaceSnapshot => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  return snapshot.schemaVersion === 2 && Boolean(snapshot.windows) && Boolean(snapshot.viewport);
};

/** 读取 1.x 的窗口快照格式并升级成 2.0 结构（不丢字段） */
export function normalizeSnapshot(raw: unknown, viewport: Viewport): WorkspaceSnapshot {
  const now = Date.now();
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const windowsSource = (source.windows && typeof source.windows === "object" ? source.windows : source) as Record<
    string,
    unknown
  >;
  const windows: Record<string, WindowState> = {};
  for (const [appId, value] of Object.entries(windowsSource)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const width = Number(entry.width);
    const height = Number(entry.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    windows[appId] = {
      left: Number(entry.left) || 0,
      top: Number(entry.top) || 0,
      width,
      height,
      minimized: Boolean(entry.minimized),
      maximized: Boolean(entry.maximized),
      space: Number(entry.space) || 1,
    };
  }
  return {
    schemaVersion: 2,
    at: Number(source.at) || now,
    viewport: {
      width: Number((source.viewport as Viewport | undefined)?.width) || viewport.width,
      height: Number((source.viewport as Viewport | undefined)?.height) || viewport.height,
    },
    windows,
  };
}

/**
 * 跨设备恢复：重新计算窗口尺寸与位置。
 *
 * 规则：
 *   1. 视口几乎一样（±8px）→ 只做边界收敛，保持原位；
 *   2. 视口不同 → 宽高按较小比例缩放，位置按比例平移；
 *   3. 贴靠窗口优先按新区间的 zone 重算，避免半屏窗口在手机上变成 1px；
 *   4. 连续恢复多个窗口时做级联偏移，避免完全重叠（同位置窗口只偏移一次）。
 */
export function rescaleSnapshot(
  snapshot: WorkspaceSnapshot,
  target: Viewport,
  options: { cascade?: boolean } = {},
): WorkspaceSnapshot {
  const sameViewport =
    Math.abs(snapshot.viewport.width - target.width) <= 8 && Math.abs(snapshot.viewport.height - target.height) <= 8;
  const ratioW = target.width / Math.max(1, snapshot.viewport.width);
  const ratioH = target.height / Math.max(1, snapshot.viewport.height);
  const ratio = Math.min(1, Math.max(0.35, Math.min(ratioW, ratioH)));

  const windows: Record<string, WindowState> = {};
  const seen = new Set<string>();
  let cascade = 0;

  for (const [appId, state] of Object.entries(snapshot.windows)) {
    let rect: Rect;
    if (state.zone && !sameViewport) {
      rect = snapRect(state.zone, target);
    } else if (sameViewport) {
      rect = { x: state.left, y: state.top, width: state.width, height: state.height };
    } else {
      rect = {
        x: state.left * ratioW,
        y: state.top * ratioH,
        width: state.width * ratio,
        height: state.height * ratio,
      };
    }
    rect = clampRect(rect, target);

    if (options.cascade !== false) {
      const key = `${rect.x}:${rect.y}`;
      if (seen.has(key)) {
        cascade += 1;
        rect = clampRect({ ...rect, x: rect.x + cascade * 26, y: rect.y + cascade * 26 }, target);
      }
      seen.add(`${rect.x}:${rect.y}`);
    }

    windows[appId] = {
      ...state,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  return { schemaVersion: 2, at: Date.now(), viewport: { ...target }, windows };
}