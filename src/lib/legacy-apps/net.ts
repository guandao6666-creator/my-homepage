/**
 * Guandao OS P1-3 · legacy 应用的无 DOM 网络工具。
 *
 * 为什么单独一份：
 * - 外壳的 `fetchWithTimeout` 在 index.astro 的闭包里，无法单测，也会**覆盖**调用方传入的 signal；
 * - 应用需要「窗口关闭 → 请求取消」，必须让外部 signal 与超时信号合并；
 * - 取消与超时要能区分：取消应静默退出，超时才提示「连不上」。
 *
 * 语义：
 * - 外部 signal 已 abort → 不发起请求，直接抛 AbortError；
 * - 超时 → 抛 TimeoutError（name = "TimeoutError"）；
 * - 其他错误原样抛出，交给调用方现有文案处理。
 */

export class TimeoutError extends Error {
  constructor(message = "请求超时") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** 主动取消（关窗 / 切换视图）。Safari 旧版 name 可能不同，这里做兼容判断。 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: string }).name === "AbortError";
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 7000): Promise<Response> {
  const external = init.signal;
  // 已经取消：连请求都不发（关窗后才返回的回调不该再产生网络流量）
  if (external?.aborted) throw new DOMException("请求已取消", "AbortError");

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new TimeoutError(`请求超时（${ms} ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
