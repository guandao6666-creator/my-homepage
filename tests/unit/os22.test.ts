import { describe, expect, it } from "vitest";
import { gridLayout } from "../../src/lib/os21/tiling";
import { weeklyMinutes } from "../../src/lib/os21/focus";
import { daysUntil, fmtStopwatch, zoneOffsetMinutes } from "../../src/lib/os22/clock";

const area = { x: 10, y: 42, w: 1000, h: 600, gap: 8 };

describe("2.2 · 窗口网格平铺", () => {
  it("0 个窗口不产生布局", () => {
    expect(gridLayout(0, area)).toEqual([]);
  });

  it("1 个窗口占满工作区", () => {
    expect(gridLayout(1, area)).toEqual([{ x: 10, y: 42, w: 1000, h: 600 }]);
  });

  it("3 个窗口：2 列 2 行，最后一行拉宽填满", () => {
    const cells = gridLayout(3, area);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toEqual({ x: 10, y: 42, w: 496, h: 296 });
    expect(cells[1]).toEqual({ x: 514, y: 42, w: 496, h: 296 });
    expect(cells[2]).toEqual({ x: 10, y: 346, w: 1000, h: 296 });
  });

  it("所有格子都落在工作区内且互不重叠", () => {
    for (let n = 1; n <= 10; n++) {
      const cells = gridLayout(n, area);
      for (const c of cells) {
        expect(c.x).toBeGreaterThanOrEqual(area.x);
        expect(c.y).toBeGreaterThanOrEqual(area.y);
        expect(c.x + c.w).toBeLessThanOrEqual(area.x + area.w);
        expect(c.y + c.h).toBeLessThanOrEqual(area.y + area.h);
      }
      for (let i = 0; i < cells.length; i++)
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i];
          const b = cells[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
    }
  });
});

describe("2.2 · Clock Studio", () => {
  it("倒数日按本地自然日计算", () => {
    const now = new Date(2026, 10, 27, 23, 59);
    expect(daysUntil("2026-11-27", now)).toBe(0);
    expect(daysUntil("2026-11-28", now)).toBe(1);
    expect(daysUntil("2027-01-01", now)).toBe(35);
    expect(daysUntil("2026-11-20", now)).toBe(-7);
  });

  it("秒表格式化", () => {
    expect(fmtStopwatch(0)).toBe("00:00.00");
    expect(fmtStopwatch(61_234)).toBe("01:01.23");
    expect(fmtStopwatch(3_723_450)).toBe("1:02:03.45");
    expect(fmtStopwatch(-5)).toBe("00:00.00");
  });

  it("时区偏移", () => {
    const winter = new Date(Date.UTC(2026, 0, 15, 12));
    const summer = new Date(Date.UTC(2026, 6, 15, 12));
    expect(zoneOffsetMinutes("Asia/Shanghai", winter)).toBe(480);
    expect(zoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
    expect(zoneOffsetMinutes("America/New_York", summer)).toBe(-240);
    expect(zoneOffsetMinutes("Europe/London", winter)).toBe(0);
  });
});

describe("2.2 · Focus Studio 周统计", () => {
  it("返回含今天在内的 7 天并按天汇总", () => {
    const now = new Date(2026, 10, 27, 10);
    const week = weeklyMinutes(
      [
        { day: "2026-11-27", min: 25 },
        { day: "2026-11-27", min: 25 },
        { day: "2026-11-21", min: 25 },
        { day: "2026-11-20", min: 25 },
      ],
      now,
    );
    expect(week).toHaveLength(7);
    expect(week[0].day).toBe("2026-11-21");
    expect(week[0].min).toBe(25);
    expect(week[6]).toEqual({ day: "2026-11-27", label: "今天", min: 50 });
    expect(week.reduce((s, d) => s + d.min, 0)).toBe(75);
  });
});
