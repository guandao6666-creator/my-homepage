/**
 * P1-3 · legacy 网络工具契约。
 *
 * 只测语义，不测实现：外部取消不发起请求、超时抛 TimeoutError、正常与网络错误原样传递。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, isAbortError, TimeoutError } from "../../src/lib/legacy-apps/net";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("legacy fetchWithTimeout", () => {
  it("外部 signal 已 abort 时不再发起请求", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();

    await expect(fetchWithTimeout("https://example.test/x", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("超时抛 TimeoutError，且不是 AbortError", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;

    const promise = fetchWithTimeout("https://example.test/slow", {}, 50);
    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("正常返回 Response", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout("https://example.test/ok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("网络错误原样抛出（不被改写成 TimeoutError）", async () => {
    const boom = new TypeError("network down");
    globalThis.fetch = (async () => {
      throw boom;
    }) as unknown as typeof fetch;
    await expect(fetchWithTimeout("https://example.test/down")).rejects.toBe(boom);
  });

  it("isAbortError 只认 AbortError", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new TimeoutError())).toBe(false);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
