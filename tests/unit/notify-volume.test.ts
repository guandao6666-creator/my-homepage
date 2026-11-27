/**
 * 2.0.8 · 通知音量 0 不能再被 `|| 45` 吞掉
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_VOLUME,
  normalizeNotificationVolume,
} from "../../src/lib/os20/notify-volume";

describe("通知音量归一化", () => {
  it("0 是合法值（静音），不能被回落成默认 45", () => {
    expect(normalizeNotificationVolume(0)).toBe(0);
    expect(normalizeNotificationVolume("0")).toBe(0);
  });

  it("正常数值原样通过并取整", () => {
    expect(normalizeNotificationVolume(45)).toBe(45);
    expect(normalizeNotificationVolume(33.6)).toBe(34);
    expect(normalizeNotificationVolume(100)).toBe(100);
  });

  it("缺省、NaN、Infinity 回落默认值", () => {
    expect(normalizeNotificationVolume(undefined)).toBe(DEFAULT_NOTIFICATION_VOLUME);
    expect(normalizeNotificationVolume(null)).toBe(DEFAULT_NOTIFICATION_VOLUME);
    expect(normalizeNotificationVolume("abc")).toBe(DEFAULT_NOTIFICATION_VOLUME);
    expect(normalizeNotificationVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_NOTIFICATION_VOLUME);
  });

  it("越界钳到 0–100", () => {
    expect(normalizeNotificationVolume(-5)).toBe(0);
    expect(normalizeNotificationVolume(150)).toBe(100);
  });
});