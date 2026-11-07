/**
 * Guandao OS 1.9 · 资源生命周期管理
 *
 * 目的：让「窗口关闭」「应用卸载」「页面切换」时，定时器、监听器、观察器、
 * Object URL、rAF 循环、Worker 都能被确定性回收，而不是靠刷新页面掩盖泄漏。
 *
 * 用法：
 *   const scope = createScope("notes:win");
 *   scope.interval(tick, 1000);
 *   scope.on(window, "resize", onResize);
 *   scope.rafLoop(frame);            // 返回 false 或调用 stop 即结束
 *   scope.observer(new ResizeObserver(cb));
 *   scope.objectUrl(blob);           // 自动 revoke
 *   scope.dispose();                 // 一次性全清
 *
 * 约定：
 * - dispose 幂等，重复调用不会重复执行清理；
 * - 已 dispose 的 scope 再注册资源会立刻执行清理，不会悄悄泄漏；
 * - 子 scope 随父 scope 一起释放；
 * - 所有计数都是真实的（诊断中心直接读这些数字）。
 */

export type Disposer = () => void;

type TimerKind = "timeout" | "interval" | "raf";

/** 全局计数器：诊断面板显示的是真实存活数量，不是估算 */
const counters = {
  scopes: 0,
  timeouts: 0,
  intervals: 0,
  rafs: 0,
  listeners: 0,
  observers: 0,
  objectUrls: 0,
  workers: 0,
};

let disposedTotal = 0;

const hasWindow = () => typeof window !== "undefined";

/** 有 window 时用 window 的定时器（可被宿主测试环境 mock），否则退回全局 */
const timers = () => (hasWindow() ? window : globalThis);

interface ScopeCounters {
  timeouts: number;
  intervals: number;
  rafs: number;
  listeners: number;
  observers: number;
  objectUrls: number;
  workers: number;
}

const emptyCounters = (): ScopeCounters => ({
  timeouts: 0,
  intervals: 0,
  rafs: 0,
  listeners: 0,
  observers: 0,
  objectUrls: 0,
  workers: 0,
});

let nextScopeId = 1;

export class ResourceScope {
  readonly id: number;
  readonly label: string;
  private disposers = new Set<Disposer>();
  private children = new Set<ResourceScope>();
  private own = emptyCounters();
  private closed = false;
  private parent: ResourceScope | null = null;

  constructor(label = "scope", parent: ResourceScope | null = null) {
    this.id = nextScopeId++;
    this.label = label;
    this.parent = parent;
    counters.scopes += 1;
  }

  get disposed(): boolean {
    return this.closed;
  }

  /** 当前 scope 仍登记着多少项待清理资源 */
  get size(): number {
    return this.disposers.size;
  }

  /** 注册一个清理函数；scope 已释放时立即执行它 */
  add(cleanup: Disposer): Disposer {
    if (this.closed) {
      safeRun(cleanup);
      return cleanup;
    }
    let live = true;
    const wrapped: Disposer = () => {
      if (!live) return;
      live = false;
      this.disposers.delete(wrapped);
      safeRun(cleanup);
    };
    this.disposers.add(wrapped);
    return wrapped;
  }

  child(label = "child"): ResourceScope {
    const scope = new ResourceScope(`${this.label}/${label}`, this);
    if (this.closed) {
      scope.dispose();
      return scope;
    }
    this.children.add(scope);
    this.add(() => {
      this.children.delete(scope);
      scope.dispose();
    });
    return scope;
  }

  timeout(fn: () => void, ms: number): Disposer {
    if (this.closed) return () => undefined;
    const id = timers().setTimeout(() => {
      this.own.timeouts = Math.max(0, this.own.timeouts - 1);
      counters.timeouts = Math.max(0, counters.timeouts - 1);
      runGuarded(fn, this.label);
    }, ms);
    this.own.timeouts += 1;
    counters.timeouts += 1;
    const off = this.add(() => {
      timers().clearTimeout(id);
      this.own.timeouts = Math.max(0, this.own.timeouts - 1);
      counters.timeouts = Math.max(0, counters.timeouts - 1);
    });
    return off;
  }

  interval(fn: () => void, ms: number): Disposer {
    if (this.closed) return () => undefined;
    const id = timers().setInterval(() => runGuarded(fn, this.label), ms);
    this.own.intervals += 1;
    counters.intervals += 1;
    return this.add(() => {
      timers().clearInterval(id);
      this.own.intervals = Math.max(0, this.own.intervals - 1);
      counters.intervals = Math.max(0, counters.intervals - 1);
    });
  }

  /** 单次 rAF；返回的清理函数可提前取消 */
  raf(fn: (time: number) => void): Disposer {
    if (!hasWindow() || typeof window.requestAnimationFrame !== "function") {
      return () => undefined;
    }
    const id = window.requestAnimationFrame((time) => {
      this.own.rafs = Math.max(0, this.own.rafs - 1);
      counters.rafs = Math.max(0, counters.rafs - 1);
      runGuarded(() => fn(time), this.label);
    });
    this.own.rafs += 1;
    counters.rafs += 1;
    return this.add(() => {
      window.cancelAnimationFrame(id);
      this.own.rafs = Math.max(0, this.own.rafs - 1);
      counters.rafs = Math.max(0, counters.rafs - 1);
    });
  }

  /**
   * 自驱 rAF 循环：回调返回 false（或调用 stop）时自动结束。
   * 页面隐藏时默认暂停，恢复可见后继续，避免后台空转耗电。
   */
  rafLoop(frame: (time: number, stop: () => void) => boolean | void, options?: { pauseWhenHidden?: boolean }): Disposer {
    if (!hasWindow()) return () => undefined;
    let cancelled = false;
    let handle: Disposer = () => undefined;
    const stop = () => {
      cancelled = true;
      handle();
    };
    const pauseWhenHidden = options?.pauseWhenHidden !== false;

    const step = (time: number) => {
      if (cancelled || this.closed) return;
      if (pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
        // 挂一个 visibilitychange 等待恢复，不占用 rAF 帧
        const onVisible = () => {
          document.removeEventListener("visibilitychange", onVisible);
          if (!cancelled && !this.closed) step(performance.now());
        };
        document.addEventListener("visibilitychange", onVisible);
        cleanup.push(() => document.removeEventListener("visibilitychange", onVisible));
        return;
      }
      const keep = frame(time, stop);
      if (keep === false || cancelled) return;
      schedule();
    };

    const schedule = () => {
      handle = this.raf(step);
    };

    const cleanup: Disposer[] = [];
    schedule();

    return this.add(() => {
      cancelled = true;
      handle();
      for (const fn of cleanup.splice(0)) safeRun(fn);
    });
  }

  /** 事件监听：自动 removeEventListener，不需要手写配对 */
  on(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions | boolean): Disposer;
  on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): Disposer;
  on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): Disposer;
  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): Disposer;
  on(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): Disposer {
    if (this.closed) return () => undefined;

    // `once: true` 的监听器由浏览器自动移除，但我们这边的计数与登记不会自动消失。
    // 不处理的话：触发后 counters.listeners 仍然算它一份，dispose 还会再跑一次清理。
    // 解决方式是包一层，在首次触发时先把自己回收掉，再执行原处理函数。
    const isOnce = typeof options === "object" && options !== null && options.once === true;
    let off: Disposer = () => undefined;

    const bound: EventListenerOrEventListenerObject = isOnce
      ? (event: Event) => {
          off(); // 回收计数 + 从 disposers 移除（removeEventListener 对已移除的监听是空操作）
          if (typeof handler === "function") handler(event);
          else handler.handleEvent(event);
        }
      : handler;

    target.addEventListener(type, bound, options);
    this.own.listeners += 1;
    counters.listeners += 1;
    off = this.add(() => {
      target.removeEventListener(type, bound, options);
      this.own.listeners = Math.max(0, this.own.listeners - 1);
      counters.listeners = Math.max(0, counters.listeners - 1);
    });
    return off;
  }

  /** MutationObserver / ResizeObserver / IntersectionObserver 统一收口 */
  observer<T extends { disconnect(): void }>(observer: T): T {
    if (this.closed) {
      safeRun(() => observer.disconnect());
      return observer;
    }
    this.own.observers += 1;
    counters.observers += 1;
    this.add(() => {
      safeRun(() => observer.disconnect());
      this.own.observers = Math.max(0, this.own.observers - 1);
      counters.observers = Math.max(0, counters.observers - 1);
    });
    return observer;
  }

  /** 创建 Object URL，scope 释放时 revoke，避免 Blob 常驻内存 */
  objectUrl(source: Blob | MediaSource): string {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
    const url = URL.createObjectURL(source);
    this.own.objectUrls += 1;
    counters.objectUrls += 1;
    this.add(() => {
      safeRun(() => URL.revokeObjectURL(url));
      this.own.objectUrls = Math.max(0, this.own.objectUrls - 1);
      counters.objectUrls = Math.max(0, counters.objectUrls - 1);
    });
    return url;
  }

  /** Worker：创建即登记，dispose 时 terminate */
  worker(worker: Worker): Worker {
    if (this.closed) {
      safeRun(() => worker.terminate());
      return worker;
    }
    this.own.workers += 1;
    counters.workers += 1;
    this.add(() => {
      safeRun(() => worker.terminate());
      this.own.workers = Math.max(0, this.own.workers - 1);
      counters.workers = Math.max(0, counters.workers - 1);
    });
    return worker;
  }

  /** AbortController：scope 释放时 abort，用来取消还挂着的网络请求 */
  abortController(): AbortController {
    const controller = new AbortController();
    this.add(() => controller.abort());
    return controller;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    // 逆序清理：后注册的先释放，符合「先建后拆」的直觉
    const list = [...this.disposers].reverse();
    this.disposers.clear();
    for (const fn of list) safeRun(fn);
    for (const child of [...this.children]) {
      child.dispose();
      this.children.delete(child);
    }
    counters.scopes = Math.max(0, counters.scopes - 1);
    disposedTotal += 1;
    this.parent?.children.delete(this);
    this.parent = null;
  }

  /** 该 scope 自己的存活资源明细（不含子 scope） */
  detail(): { label: string; id: number; disposed: boolean } & ScopeCounters {
    return { label: this.label, id: this.id, disposed: this.closed, ...this.own };
  }
}

function safeRun(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    // 清理阶段抛错不能中断其它资源的释放
    if (typeof console !== "undefined") console.warn("[Guandao OS · resources] cleanup failed", error);
  }
}

function runGuarded(fn: () => void, label: string): void {
  try {
    fn();
  } catch (error) {
    if (typeof console !== "undefined") console.warn(`[Guandao OS · resources] task in "${label}" threw`, error);
    // 交给可靠性中心记录（循环依赖：动态取，取不到就算了）
    const hook = (globalThis as { GOS19_DIAG?: { error: (scope: string, err: unknown) => void } }).GOS19_DIAG;
    hook?.error?.(label, error);
  }
}

export const createScope = (label?: string) => new ResourceScope(label);

/* ============================================================
   窗口级 scope 注册表
   ============================================================ */

const windowScopes = new WeakMap<object, ResourceScope>();

/** 取得某个窗口元素的资源域；不存在则创建 */
export function scopeForWindow(win: object, label = "window"): ResourceScope {
  const existing = windowScopes.get(win);
  if (existing && !existing.disposed) return existing;
  const scope = new ResourceScope(label);
  windowScopes.set(win, scope);
  return scope;
}

/** 窗口关闭时调用：释放该窗口登记过的所有资源 */
export function disposeWindowScope(win: object): void {
  const scope = windowScopes.get(win);
  if (scope) {
    scope.dispose();
    windowScopes.delete(win);
  }
}

/* ============================================================
   全局（桌面级）scope
   ============================================================ */

let rootScope: ResourceScope | null = null;

/** 桌面外壳的资源域：不随窗口关闭释放，只在整个页面卸载时释放 */
export function rootResources(): ResourceScope {
  if (!rootScope || rootScope.disposed) rootScope = new ResourceScope("os:root");
  return rootScope;
}

/* ============================================================
   统计
   ============================================================ */

export type ResourceStats = {
  scopes: number;
  timeouts: number;
  intervals: number;
  rafs: number;
  listeners: number;
  observers: number;
  objectUrls: number;
  workers: number;
  disposedTotal: number;
  windowScopes: number;
};

export function resourceStats(): ResourceStats {
  return {
    scopes: counters.scopes,
    timeouts: counters.timeouts,
    intervals: counters.intervals,
    rafs: counters.rafs,
    listeners: counters.listeners,
    observers: counters.observers,
    objectUrls: counters.objectUrls,
    workers: counters.workers,
    disposedTotal,
    // WeakMap 无法枚举；这里只统计当前存活的窗口 scope 数量
    windowScopes: liveWindowScopes.size,
  };
}

/** 单独维护一份窗口 scope 计数：WeakMap 不可枚举，只能自己记 */
const liveWindowScopes = new Set<ResourceScope>();

export function trackWindowScope(win: object, label: string): ResourceScope {
  const scope = scopeForWindow(win, label);
  liveWindowScopes.add(scope);
  return scope;
}

export function releaseWindowScope(win: object): void {
  const scope = windowScopes.get(win);
  if (scope) liveWindowScopes.delete(scope);
  disposeWindowScope(win);
}

/**
 * 页面上「没有挂到任何 scope」的遗留资源兜底：
 * 页面隐藏 / 卸载时统一释放根 scope，避免刷新才清干净。
 */
export function installRootDisposal(): void {
  if (!hasWindow()) return;
  const dispose = () => {
    rootScope?.dispose();
    rootScope = null;
  };
  window.addEventListener("pagehide", dispose, { once: true });
}