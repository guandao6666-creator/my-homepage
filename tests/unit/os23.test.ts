import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateMath, isLikelyMathQuery } from "../../src/lib/os23/math";
import {
  base64ToUtf8,
  formatJson,
  minifyJson,
  parseTimestampInput,
  sha256HexText,
  utf8ToBase64,
} from "../../src/lib/os23/devtools";
import { buildHeatmap28, calcStreak } from "../../src/lib/os23/habits";
import { contrastRatio, convertUnit, hexToRgb, rgbToHsl } from "../../src/lib/os23/converter";
import { quadrantRect } from "../../src/lib/os21/tiling";
import { clampCustomMinutes } from "../../src/lib/os21/focus";
import { MANIFEST_BY_ID } from "../../src/lib/os20/manifests";

describe("2.3 · 零 eval 算术解析引擎与计算器 CSP 修复", () => {
  it("支持四则运算、括号、一元负号、百分号、幂与数学函数", () => {
    expect(evaluateMath("12 + 8 * 3")).toBe(36);
    expect(evaluateMath("(12 + 8) × 3 ÷ 5")).toBe(12);
    expect(evaluateMath("-5 + 12")).toBe(7);
    expect(evaluateMath("200 * 15%")).toBe(30);
    expect(evaluateMath("2^10")).toBe(1024);
    expect(evaluateMath("sqrt(144) + abs(-6)")).toBe(18);
    expect(evaluateMath("0.1 + 0.2")).toBe(0.3);
  });

  it("除零或非法表达式安全返回 null，不抛异常", () => {
    expect(evaluateMath("10 / 0")).toBeNull();
    expect(evaluateMath("alert(1)")).toBeNull();
    expect(evaluateMath("(1 + 2")).toBeNull();
    expect(evaluateMath("")).toBeNull();
  });

  it("Spotlight 算式启发式判定排除纯数字年份，识别真实算式", () => {
    expect(isLikelyMathQuery("2026")).toBe(false);
    expect(isLikelyMathQuery("notes")).toBe(false);
    expect(isLikelyMathQuery("128 * 24")).toBe(true);
    expect(isLikelyMathQuery("sqrt(256)")).toBe(true);
  });

  it("calc/index.ts 代码中不再包含 new Function 或 eval（严格 CSP 兼容）", () => {
    const codeOnly = readFileSync("src/lib/legacy-apps/calc/index.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    expect(/\bFunction\s*\(/.test(codeOnly)).toBe(false);
    expect(/\beval\s*\(/.test(codeOnly)).toBe(false);
  });
});

describe("2.3 · Dev Studio 工具纯函数", () => {
  it("JSON 格式化、按键名排序与压缩", () => {
    const sorted = formatJson('{"b":1,"a":{"z":2,"m":3}}', true);
    expect(sorted.ok).toBe(true);
    if (sorted.ok) {
      expect(Object.keys(JSON.parse(sorted.output))).toEqual(["a", "b"]);
    }
    const min = minifyJson('{\n  "os": "Guandao",\n  "v": 2.3\n}');
    expect(min).toEqual({ ok: true, output: '{"os":"Guandao","v":2.3}' });
    expect(formatJson("{bad").ok).toBe(false);
  });

  it("UTF-8 Base64 支持中文与 Emoji 往返编解码", () => {
    const raw = "Guandao OS 2.3 · 创想视界 🚀";
    const encoded = utf8ToBase64(raw);
    expect(base64ToUtf8(encoded)).toEqual({ ok: true, output: raw });
    expect(base64ToUtf8("%%%not-base64%%%").ok).toBe(false);
  });

  it("时间戳解析同时支持秒、毫秒与 ISO 字符串，SHA-256 输出标准摘要", async () => {
    const fromSec = parseTimestampInput("1700000000");
    expect(fromSec?.ms).toBe(1700000000000);
    const fromIso = parseTimestampInput("2026-11-28T00:00:00.000Z");
    expect(fromIso?.iso).toBe("2026-11-28T00:00:00.000Z");
    expect(await sha256HexText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("2.3 · Habit Tracker 连续打卡与热力矩阵", () => {
  it("正确计算今天已打卡、昨天已打卡及断签后的 Streak", () => {
    const now = new Date(2026, 10, 28, 12, 0, 0);
    expect(calcStreak(["2026-11-28", "2026-11-27", "2026-11-26"], now)).toBe(3);
    expect(calcStreak(["2026-11-27", "2026-11-26"], now)).toBe(2);
    expect(calcStreak(["2026-11-25"], now)).toBe(0);
  });

  it("生成 28 天热力图并正确计算完成率", () => {
    const now = new Date(2026, 10, 28, 12, 0, 0);
    const cells = buildHeatmap28(
      [
        { id: "1", name: "阅读", color: "#6f8cff", days: ["2026-11-28"], createdAt: 1 },
        { id: "2", name: "运动", color: "#4fbf9a", days: ["2026-11-28", "2026-11-27"], createdAt: 2 },
      ],
      now,
    );
    expect(cells).toHaveLength(28);
    expect(cells[27]).toEqual({ day: "2026-11-28", done: 2, total: 2, ratio: 1 });
    expect(cells[26]).toEqual({ day: "2026-11-27", done: 1, total: 2, ratio: 0.5 });
  });
});

describe("2.3 · Converter 单位换算与 WCAG 对比度", () => {
  it("长度、重量、温度与存储容量换算准确", () => {
    expect(convertUnit("length", 1, "km", "m")).toBe(1000);
    expect(convertUnit("mass", 2, "kg", "jin")).toBe(4);
    expect(convertUnit("temp", 0, "c", "f")).toBe(32);
    expect(convertUnit("temp", 212, "f", "c")).toBe(100);
    expect(convertUnit("data", 2, "gb", "mb")).toBe(2048);
  });

  it("色彩转换与黑白 21:1 对比度计算正确", () => {
    expect(hexToRgb("#6f8cff")).toEqual({ r: 111, g: 140, b: 255 });
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
  });
});

describe("2.3 · 窗口象限贴靠、类名对齐与内核清单注册", () => {
  it("四角 1/4 屏象限互不重叠且完整落在工作区内", () => {
    const area = { x: 10, y: 42, w: 1000, h: 600, gap: 8 };
    const quads = (["tl", "tr", "bl", "br"] as const).map((q) => quadrantRect(q, area));
    for (const r of quads) {
      expect(r.x).toBeGreaterThanOrEqual(area.x);
      expect(r.y).toBeGreaterThanOrEqual(area.y);
      expect(r.x + r.w).toBeLessThanOrEqual(area.x + area.w);
      expect(r.y + r.h).toBeLessThanOrEqual(area.y + area.h);
    }
    expect(quads[0].x).toBeLessThan(quads[1].x);
    expect(quads[0].y).toBeLessThan(quads[2].y);
  });

  it("tiling.ts 使用真实窗口类名 is-minimized / is-maximized 与 .dot-max", () => {
    const src = readFileSync("src/lib/os21/tiling.ts", "utf8");
    expect(src).toContain("is-minimized");
    expect(src).toContain("is-maximized");
    expect(src).toContain(".dot-max");
    expect(src.includes('classList.contains("is-min")')).toBe(false);
    expect(src.includes('classList.remove("is-max")')).toBe(false);
  });

  it("Focus 自定义分钟数限制在 1~120，且 2.1~2.3 全部新应用均已登记到 MANIFEST_BY_ID", () => {
    expect(clampCustomMinutes(0)).toBe(1);
    expect(clampCustomMinutes(180)).toBe(120);
    expect(clampCustomMinutes(50)).toBe(50);
    for (const id of ["focus", "clock", "devtools", "habits", "sketch", "converter"]) {
      expect(MANIFEST_BY_ID[id]?.appId).toBe(id);
    }
  });
});
