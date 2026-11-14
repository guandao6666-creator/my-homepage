/**
 * Guandao OS 2.0 · 事件总线
 *
 * 1.x 里 `emit()` 直接 dispatch 到 window，任何监听器抛错都会冒泡到全局，
 * 事件类型也没有约束。2.0 的 Core 需要「一个订阅者出错不影响其他订阅者」，
 * 所以这里实现一个带错误隔离的总线：
 *
 *   - 同步派发，顺序即订阅顺序；
 *   - 单个 handler 抛错只记录，不打断其余 handler（错误隔离）；
 *   - 支持 `*` 通配订阅（诊断中心用）；
 *   - 支持 waitFor(type, timeout) 等待一次性事件；
 *   - 保留最近 N 条事件的环形历史，便于崩溃后回溯；
 *   - 可选桥接到 window 的 `guandao:*` 事件，兼容 1.x 的插件与测试脚本。
 *
 * 这个模块不触碰 DOM（除非显式开启 bridge），可以直接在 Node 里单测。
 */

export type BusMeta = { type: string; at: number; seq: number };

export type BusHandler<T = unknown> = (payload: T, meta: BusMeta) => void;

export type BusErrorInfo = {
  type: string;
  error: unknown;
  handlerIndex: number;
};

export type BusOptions = {
  /** 名字只用于日志与诊断展示 */
  name?: string;
  /** 订阅者抛错时的回调；不传则静默计数（仍然隔离） */
  onError?: (info: BusErrorInfo) => void;
  /** 保留的历史事件条数，默认 50 */
  maxHistory?: number;
  /** 是否把事件同步派发到 window 上的 `guandao:<type>`，默认 false */
  bridgeToWindow?: boolean;
};

type Entry = { handler: BusHandler; once: boolean; label: string };

const now = () => (typeof performance !== "undefined" ? Math.round(performance.now()) : Date.now());

export class EventBus {
  private handlers = new Map<string, Entry[]>();
  private history: Array<{ type: string; payload: unknown; at: number; seq: number }> = [];
  private seq = 0;
  private errorCount = 0;
  private emitted = 0;
  private options: Required<Omit<BusOptions, "onError">> & Pick<BusOptions, "onError">;

  constructor(options: BusOptions = {}) {
    this.options = {
      name: options.name ?? "core",
      onError: options.onError,
      maxHistory: Math.max(0, options.maxHistory ?? 50),
      bridgeToWindow: options.bridgeToWindow ?? false,
    };
  }

  /**
   * 订阅事件。返回取消订阅函数（幂等，可重复调用）。
   * `*` 表示订阅全部事件。
   */
  on<T = unknown>(type: string, handler: BusHandler<T>, opts: { once?: boolean; label?: string } = {}): () => void {
    const list = this.handlers.get(type) ?? [];
    const entry: Entry = {
      handler: handler as BusHandler,
      once: Boolean(opts.once),
      label: opts.label ?? `${type}#${list.length}`,
    };
    list.push(entry);
    this.handlers.set(type, list);

    let active = true;
    // 返回的 off 是幂等的：once 订阅在派发之后也可能被提前取消
    return () => {
      if (!active) return;
      active = false;
      this.removeEntry(type, entry);
    };
  }

  once<T = unknown>(type: string, handler: BusHandler<T>): () => void {
    return this.on(type, handler, { once: true });
  }

  off(type: string, handler: BusHandler): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const next = list.filter((entry) => entry.handler !== (handler as BusHandler));
    if (next.length) this.handlers.set(type, next);
    else this.handlers.delete(type);
  }

  /**
   * 派发事件。返回投递统计，方便调用方判断「有没有人接」。
   * 任何订阅者抛错都不会中断派发。
   */
  emit<T = unknown>(type: string, payload?: T): { delivered: number; errors: number } {
    if (!type) return { delivered: 0, errors: 0 };
    this.seq += 1;
    const seq = this.seq;
    const at = now();
    this.emitted += 1;

    if (this.options.maxHistory > 0) {
      this.history.push({ type, payload, at, seq });
      if (this.history.length > this.options.maxHistory) this.history.shift();
    }

    let delivered = 0;
    let errors = 0;

    const dispatch = (list: Entry[]) => {
      // 复制一份：handler 里可能继续订阅 / 取消订阅
      const snapshot = list.slice();
      let index = 0;
      for (const entry of snapshot) {
        if (entry.once) this.removeEntry(type, entry);
        index += 1;
        try {
          entry.handler(payload, { type, at, seq });
          delivered += 1;
        } catch (error) {
          errors += 1;
          this.errorCount += 1;
          try {
            this.options.onError?.({ type, error, handlerIndex: index - 1 });
          } catch {
            /* onError 自己抛错也不再扩散 */
          }
        }
      }
    };

    const list = this.handlers.get(type);
    if (list?.length) dispatch(list);

    const wildcard = this.handlers.get("*");
    if (wildcard?.length) {
      const wild = this.dispatchWildcard(wildcard, type, payload, at, seq);
      delivered += wild.delivered;
      errors += wild.errors;
    }

    if (this.options.bridgeToWindow) {
      try {
        if (typeof window !== "undefined" && typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent(`guandao:${type}`, { detail: payload }));
        }
      } catch {
        /* 某些测试环境没有 window/CustomEvent */
      }
    }

    return { delivered, errors };
  }

  /**
   * 等待一个事件，超时则 reject。
   * 用于启动流程里「等窗口管理器就绪」这类一次性同步点。
   */
  waitFor<T = unknown>(type: string, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const off = this.once<T>(type, (payload) => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`等待事件 ${type} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        // Node 里不要让等待事件阻止进程退出
        const maybeUnref = timer as unknown as { unref?: () => void };
        if (typeof maybeUnref.unref === "function") maybeUnref.unref();
      }
    });
  }

  /** 最近的事件历史（新的在后） */
  recent(limit = 20): Array<{ type: string; payload: unknown; at: number; seq: number }> {
    return this.history.slice(-Math.max(0, limit));
  }

  stats(): { name: string; types: number; handlers: number; emitted: number; errors: number; history: number } {
    let handlers = 0;
    for (const list of this.handlers.values()) handlers += list.length;
    return {
      name: this.options.name,
      types: this.handlers.size,
      handlers,
      emitted: this.emitted,
      errors: this.errorCount,
      history: this.history.length,
    };
  }

  /** 移除全部订阅（仅用于测试或整体销毁） */
  clear(): void {
    this.handlers.clear();
    this.history = [];
  }

  private removeEntry(type: string, entry: Entry): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this.handlers.delete(type);
  }

  private dispatchWildcard(
    list: Entry[],
    type: string,
    payload: unknown,
    at: number,
    seq: number,
  ): { delivered: number; errors: number } {
    const snapshot = list.slice();
    let delivered = 0;
    let errors = 0;
    for (const entry of snapshot) {
      if (entry.once) this.removeEntry("*", entry);
      try {
        entry.handler({ type, payload }, { type, at, seq });
        delivered += 1;
      } catch (error) {
        errors += 1;
        this.errorCount += 1;
        try {
          this.options.onError?.({ type, error, handlerIndex: -1 });
        } catch {
          /* 忽略 */
        }
      }
    }
    return { delivered, errors };
  }
}

/** 创建总线。Core 只用一个实例，测试里可以自由创建。 */
export const createBus = (options?: BusOptions) => new EventBus(options);