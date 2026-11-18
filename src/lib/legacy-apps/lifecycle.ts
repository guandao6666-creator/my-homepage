/**
 * Guandao OS 2.2 · legacy 应用的窗口级生命周期登记表。
 *
 * 旧版应用（水族箱 / 系统监视器）以前在外壳闭包里直接 `setInterval`，
 * 靠回调里 `document.body.contains(el)` 自己发现窗口被关掉再停。迁出后
 * 不能再摸外壳的 `closeWin`，于是统一在这里登记：
 *
 * - 应用通过 `LegacyAppContext.lifecycle` 注册计时器 / window 级监听；
 * - `registerLegacyApps` 在 init 返回的清理函数里调用 `dispose(win)`；
 * - `closeWin` 本来就会调用 `win.__gosCleanup`，所以语义与旧实现一致，
 *   但清理是**立即**发生，而不是等下一次 1.5s / 60s 的回调才发现。
 *
 * 这里只做 DOM / 计时器管理，不依赖外壳任何闭包，可以单独单测。
 */

type WindowScope = {
  intervals: Set<number>;
  timeouts: Set<number>;
  /** [事件名, 处理器]，窗口关闭时从 window 上解绑 */
  listeners: Array<[string, EventListener]>;
};

const scopes = new WeakMap<HTMLElement, WindowScope>();

function scopeFor(win: HTMLElement): WindowScope {
  let scope = scopes.get(win);
  if (!scope) {
    scope = { intervals: new Set(), timeouts: new Set(), listeners: [] };
    scopes.set(win, scope);
  }
  return scope;
}

/**
 * 外壳注入给 legacy 应用的实现（见 types.ts 的 `LegacyLifecyclePort`）。
 * 由 `registerLegacyApps` 在 init 包装里调用 `dispose(win)`。
 */
export const legacyWindowLifecycle = {
  interval(win: HTMLElement, handler: () => void, ms: number): number {
    const scope = scopeFor(win);
    const id = window.setInterval(handler, ms);
    scope.intervals.add(id);
    return id;
  },

  timeout(win: HTMLElement, handler: () => void, ms: number): number {
    const scope = scopeFor(win);
    // 触发后从登记表移除，避免反复 setTimeout 让表无限增长
    const id = window.setTimeout(() => {
      scope.timeouts.delete(id);
      handler();
    }, ms);
    scope.timeouts.add(id);
    return id;
  },

  onGlobal(win: HTMLElement, type: string, handler: EventListener): void {
    const scope = scopeFor(win);
    window.addEventListener(type, handler);
    scope.listeners.push([type, handler]);
  },

  dispose(win: HTMLElement): void {
    const scope = scopes.get(win);
    if (!scope) return;
    for (const id of scope.intervals) window.clearInterval(id);
    for (const id of scope.timeouts) window.clearTimeout(id);
    for (const [type, handler] of scope.listeners) window.removeEventListener(type, handler);
    scopes.delete(win);
  },
};
