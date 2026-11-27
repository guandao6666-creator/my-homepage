import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageNav } from "../../src/lib/os14/community/ui";

/**
 * 通知分页的「总数」问题（2.0.6）。
 *
 * 通知接口只返回当前页与 unread，没有 total。旧调用把本页条数当总数，
 * 于是满页时页面写着「共 20 个条通知」，点下一页却是空状态。
 * 现在 total 允许为 null：不知道就不写数量。
 */
describe("社区分页条", () => {
  it("知道总数时显示数量", () => {
    const html = pageNav(2, true, 87);
    expect(html).toContain("第 2 页 · 共 87 个作品");
  });

  it("不知道总数时只显示页码，不编数量", () => {
    const html = pageNav(1, true, null, "条通知");
    expect(html).toContain("第 1 页");
    expect(html).not.toContain("共");
    expect(html).not.toContain("个条通知");
  });

  it("hasMore 决定下一页是否可点", () => {
    expect(pageNav(1, true, 10)).not.toMatch(/data-page="2"[^>]*disabled/);
    expect(pageNav(1, false, 10)).toMatch(/data-page="2"[^>]*disabled/);
  });
});

describe("幻灯片计时器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start 之后按间隔触发，stop 之后不再触发", async () => {
    const { createSlideshow } = await import("../../src/lib/os13/slideshow");
    const tick = vi.fn();
    const show = createSlideshow(tick, 1000);
    show.start();
    vi.advanceTimersByTime(3500);
    expect(tick).toHaveBeenCalledTimes(3);
    show.stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(show.running()).toBe(false);
  });

  it("重复 start 不会叠出两个计时器", async () => {
    const { createSlideshow } = await import("../../src/lib/os13/slideshow");
    const tick = vi.fn();
    const show = createSlideshow(tick, 1000);
    show.start();
    show.start();
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});