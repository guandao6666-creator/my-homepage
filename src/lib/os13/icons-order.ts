/**
 * Guandao OS 2.0.6 · 网格模式图标落点
 *
 * 2.0.5 之前的判定是「左上角阈值」：
 *   `r.left - hostLeft <= drop.x + 24 && r.top - hostTop <= drop.y + 24`
 * 第一个图标总在 (0, 0)，所以任何落点都满足条件 → 永远插入到第一位，
 * `cfg.icons.order` 记下的顺序和用户看到的顺序不一致。
 *
 * 这里改成「按落点距离图标中心最近选目标，再按中心前后决定 before / after」，
 * 并且做成纯函数：几何计算可以单测，不需要真的跑拖拽。
 */

export type IconRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DropPoint = {
  x: number;
  y: number;
};

export type GridDropTarget = {
  /** 目标图标在传入数组里的下标（调用方需先排除被拖动的那个图标） */
  index: number;
  /** true = 插在目标之后，false = 插在目标之前 */
  after: boolean;
};

/**
 * 落点判定。
 *
 * - 没有候选图标（桌面只剩一个）→ `null`，调用方直接 append；
 * - 目标按「中心点最近」选，不按左上角：从右侧拖到第二个图标附近时，
 *   左上角阈值会误判成第一个；
 * - 垂直方向上偏离中心超过 8px 时优先按上下决定前后，否则按左右。
 */
export function pickGridDrop(icons: IconRect[], drop: DropPoint): GridDropTarget | null {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestCenterX = 0;
  let bestCenterY = 0;
  for (let i = 0; i < icons.length; i += 1) {
    const icon = icons[i];
    const centerX = icon.left + icon.width / 2;
    const centerY = icon.top + icon.height / 2;
    const distance = (centerX - drop.x) ** 2 + (centerY - drop.y) ** 2;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
      bestCenterX = centerX;
      bestCenterY = centerY;
    }
  }
  if (best < 0) return null;
  const vertical = drop.y - bestCenterY;
  if (vertical > 8) return { index: best, after: true };
  if (vertical < -8) return { index: best, after: false };
  return { index: best, after: drop.x >= bestCenterX };
}