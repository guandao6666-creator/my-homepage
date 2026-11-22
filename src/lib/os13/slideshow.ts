/**
 * Guandao OS 2.0.6 · 幻灯片计时器
 *
 * 为什么单独抽出来：
 *   图库的幻灯片以前只有一个 `slideTimer` 数字，启动时 `setInterval`，
 *   但关闭灯箱（✕ / Esc / 点背景）时没人清它 —— 4.2 秒后图片又被弹回来，
 *   用户关不掉。把「启动 / 停止 / 是否在跑」收成一个对象，关闭路径只调用
 *   `stop()`，就不会再漏清计时器；也便于用假时钟做单测。
 */
export type Slideshow = {
  start(): void;
  stop(): void;
  running(): boolean;
};

export function createSlideshow(tick: () => void, intervalMs = 4200): Slideshow {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    start() {
      // 先停再开：连点「幻灯片」不会叠出两个计时器
      stop();
      timer = setInterval(tick, intervalMs);
    },
    stop,
    running: () => timer !== null,
  };
}