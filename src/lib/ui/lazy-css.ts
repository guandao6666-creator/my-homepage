/**
 * Guandao OS 6.2 · 应用样式的运行时加载。
 *
 * 为什么需要它：Astro 的静态构建会把页面可达的 CSS 全部提升成首页的
 * `<link rel="stylesheet">`（哪怕它属于一个动态 import 的模块），
 * 因此「把 CSS import 挪进懒加载模块」并不会减少首屏下载量（见 AI-BUILD-DECISIONS D-006）。
 *
 * 做法：CSS 用 `?url` 当资源导入（不会被提升），应用打开时再插入 `<link>`，
 * 并由 `load()` 等 `stylesReady` 完成后再渲染，避免无样式闪烁。
 *
 * 约束：
 * - 同一个 URL 只插一次、只等一次（Map 缓存）；
 * - 加载失败也 resolve：宁可少一点样式，也不能让窗口永远停在骨架屏；
 * - 不删除已插入的 link：应用反复开关不应重复请求。
 */

const pending = new Map<string, Promise<void>>();
const inserted = new Set<string>();

export function ensureCss(href: string): Promise<void> {
  if (typeof document === "undefined" || !href) return Promise.resolve();

  const cached = pending.get(href);
  if (cached) return cached;

  // 用内存集合判断，避免 CSS.escape 兼容性与属性选择器转义问题
  if (inserted.has(href)) {
    const done = Promise.resolve();
    pending.set(href, done);
    return done;
  }
  inserted.add(href);

  const task = new Promise<void>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.gosCss = href;
    // 成功或失败都放行：失败时窗口仍能渲染，只是缺少该应用的专属样式
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(link);
  });

  pending.set(href, task);
  return task;
}
