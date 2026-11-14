/**
 * Guandao OS 2.4 · ResourceScope 生命周期契约测试。
 *
 * 这些测试只验证「作用域是否真的把资源释放掉」，
 * 不依赖浏览器（Node 自带 EventTarget / timers）。
 */
import { describe, expect, it, vi } from "vitest";
import { createScope, resourceStats } from "../../src/lib/quality/resources";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ResourceScope · 释放语义", () => {
  it("dispose 会执行登记过的清理函数", () => {
    const scope = createScope("t-basic");
    const cleanup = vi.fn();
    scope.add(cleanup);
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("dispose 幂等：重复调用不会重复清理", () => {
    const scope = createScope("t-idempotent");
    const cleanup = vi.fn();
    scope.add(cleanup);
    scope.dispose();
    scope.dispose();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("同一个 disposer 手动执行后，dispose 不会再执行一次", () => {
    const scope = createScope("t-manual");
    const cleanup = vi.fn();
    const off = scope.add(cleanup);
    off();
    off();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("某个清理函数抛错不影响其它资源释放", () => {
    const scope = createScope("t-throw");
    const second = vi.fn();
    scope.add(() => {
      throw new Error("boom");
    });
    scope.add(second);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => scope.dispose()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("按逆序释放（后注册的先清理）", () => {
    const scope = createScope("t-order");
    const order: number[] = [];
    scope.add(() => order.push(1));
    scope.add(() => order.push(2));
    scope.add(() => order.push(3));
    scope.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("子域随父域一起释放，且子域自己也能单独释放", () => {
    const parent = createScope("t-parent");
    const child = parent.child("c1");
    const childCleanup = vi.fn();
    child.add(childCleanup);
    parent.dispose();
    expect(childCleanup).toHaveBeenCalledTimes(1);
    expect(child.disposed).toBe(true);
  });

  it("已释放的域再注册资源会立即清理，不会泄漏", () => {
    const scope = createScope("t-closed");
    scope.dispose();
    const cleanup = vi.fn();
    scope.add(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.size).toBe(0);
  });
});

describe("ResourceScope · 事件监听", () => {
  it("手动 off 之后不再触发，且计数回落", () => {
    const scope = createScope("t-listen-off");
    const target = new EventTarget();
    const before = resourceStats().listeners;
    const handler = vi.fn();

    const off = scope.on(target, "ping", handler);
    expect(resourceStats().listeners).toBe(before + 1);

    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(resourceStats().listeners).toBe(before);
  });

  it("scope 释放后监听器被移除", () => {
    const scope = createScope("t-listen-dispose");
    const target = new EventTarget();
    const handler = vi.fn();
    scope.on(target, "ping", handler);
    scope.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("once 监听器触发后自动回收计数（不留活动残留）", () => {
    const scope = createScope("t-once");
    const target = new EventTarget();
    const before = resourceStats().listeners;

    const handler = vi.fn();
    scope.on(target, "ping", handler, { once: true });
    expect(resourceStats().listeners).toBe(before + 1);
    expect(scope.size).toBe(1);

    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);

    // 关键断言：浏览器已自动移除，计数与登记也必须同步消失
    expect(resourceStats().listeners).toBe(before);
    expect(scope.size).toBe(0);

    // 再触发一次不会重复执行
    target.dispatchEvent(new Event("ping"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("dispose 不会把已触发的 once 监听器再清理一次", () => {
    const scope = createScope("t-once-dispose");
    const target = new EventTarget();
    const before = resourceStats().listeners;
    scope.on(target, "ping", () => undefined, { once: true });
    target.dispatchEvent(new Event("ping"));
    scope.dispose();
    // 不能被扣成负数
    expect(resourceStats().listeners).toBe(before);
  });
});

describe("ResourceScope · 定时器", () => {
  it("timeout 执行后自动从计数里移除", async () => {
    const scope = createScope("t-timeout");
    const before = resourceStats().timeouts;
    const fn = vi.fn();

    scope.timeout(fn, 5);
    expect(resourceStats().timeouts).toBe(before + 1);

    await wait(30);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(resourceStats().timeouts).toBe(before);
  });

  it("timeout 主动取消后不再执行", async () => {
    const scope = createScope("t-timeout-cancel");
    const before = resourceStats().timeouts;
    const fn = vi.fn();

    const off = scope.timeout(fn, 10);
    off();
    await wait(40);
    expect(fn).not.toHaveBeenCalled();
    expect(resourceStats().timeouts).toBe(before);
  });

  it("interval 在 scope 释放后停止", async () => {
    const scope = createScope("t-interval");
    const before = resourceStats().intervals;
    const fn = vi.fn();

    scope.interval(fn, 5);
    expect(resourceStats().intervals).toBe(before + 1);

    await wait(20);
    scope.dispose();
    const calls = fn.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(resourceStats().intervals).toBe(before);

    await wait(30);
    expect(fn.mock.calls.length).toBe(calls);
  });

  it("dispose 之后创建的 timer 不会真的排进队列", async () => {
    const scope = createScope("t-timeout-closed");
    scope.dispose();
    const fn = vi.fn();
    scope.timeout(fn, 1);
    scope.interval(fn, 1);
    await wait(20);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("ResourceScope · Observer 与其它资源", () => {
  it("observer 在 scope 释放时 disconnect", () => {
    const scope = createScope("t-observer");
    const fake = { disconnect: vi.fn() };
    const before = resourceStats().observers;

    scope.observer(fake);
    expect(resourceStats().observers).toBe(before + 1);

    scope.dispose();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(resourceStats().observers).toBe(before);
  });

  it("已释放的 scope 收到 observer 时立即 disconnect，不登记", () => {
    const scope = createScope("t-observer-closed");
    scope.dispose();
    const fake = { disconnect: vi.fn() };
    scope.observer(fake);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(scope.size).toBe(0);
  });

  it("abortController 在释放时 abort", () => {
    const scope = createScope("t-abort");
    const controller = scope.abortController();
    expect(controller.signal.aborted).toBe(false);
    scope.dispose();
    expect(controller.signal.aborted).toBe(true);
  });

  it("存活资源域计数随创建与释放对称变化", () => {
    const before = resourceStats().scopes;
    const a = createScope("t-scope-count-a");
    const b = a.child("b");
    expect(resourceStats().scopes).toBe(before + 2);
    a.dispose();
    expect(resourceStats().scopes).toBe(before);
    b.dispose(); // 已经随父域释放，再调用不应把计数扣成负数
    expect(resourceStats().scopes).toBe(before);
  });
});