/**
 * 每日抽奖 · 本地日边界（2.0.4 修复回归）。
 *
 * 2.0.4 之前 `today` 用 `new Date().toISOString().slice(0, 10)`：
 *   - UTC 日 ≠ 东八区日历日，00:00–08:00 会被当成「昨天」，本地零点后能再抽一次；
 *   - `today` 在 `init` 时算一次，窗口跨零点还开着时会把昨天的日期写进存档。
 * 这里既测纯函数的本地日口径，也用源码断言把「写存档时重新取日」钉住。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drawDateKey } from "../../src/lib/legacy-apps/draw";

const source = fs.readFileSync(path.join(process.cwd(), "src/lib/legacy-apps/draw/index.ts"), "utf8");

describe("每日抽奖 · 本地日历日", () => {
  it("本地零点后的时间算作当天（不再回退到 UTC 的昨天）", () => {
    expect(drawDateKey(new Date(2026, 10, 21, 0, 5))).toBe("2026-11-21");
    expect(drawDateKey(new Date(2026, 10, 21, 7, 59))).toBe("2026-11-21");
  });

  it("本地傍晚与深夜仍然算作当天", () => {
    expect(drawDateKey(new Date(2026, 10, 21, 18, 0))).toBe("2026-11-21");
    expect(drawDateKey(new Date(2026, 10, 21, 23, 55))).toBe("2026-11-21");
  });

  it("跨月、跨年、单数字月日补零", () => {
    expect(drawDateKey(new Date(2026, 2, 5, 9, 0))).toBe("2026-03-05");
    expect(drawDateKey(new Date(2025, 11, 31, 23, 59))).toBe("2025-12-31");
    expect(drawDateKey(new Date(2026, 0, 1, 0, 1))).toBe("2026-01-01");
  });

  it("东八区零点后与 UTC 日不同——这正是旧实现多给一次抽奖的窗口", () => {
    const earlyMorning = new Date(2026, 10, 21, 0, 30);
    const utcKey = earlyMorning.toISOString().slice(0, 10);
    // 在 UTC 时区跑测试时两者相同，只有在东半球（本地时间早于 UTC）才有判别力
    if (earlyMorning.getTimezoneOffset() < 0) {
      expect(utcKey).toBe("2026-11-20");
      expect(drawDateKey(earlyMorning)).toBe("2026-11-21");
    }
  });
});

describe("每日抽奖 · 存档日期取「点下去那一刻」", () => {
  it("写存档时重新取本地日，而不是沿用 init 时的 today", () => {
    expect(source).toContain("date: drawDateKey()");
    expect(source).not.toContain("date: today");
  });

  it("源码里不再出现 toISOString 的日期截断", () => {
    // 注释里会提到旧实现，所以要找的是真正的调用写法
    expect(source).not.toContain(".toISOString().slice");
    expect(source).not.toContain("toISOString().slice(0, 10)");
  });
});