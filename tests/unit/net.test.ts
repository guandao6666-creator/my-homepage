/**
 * 统一网络层单元测试（1.9）
 *
 * 覆盖：状态码分类、可重试判定、指数退避、Retry-After 解析、
 * 错误说明（用户可读文案 + 数据是否保存 + 是否需要重新登录）。
 */
import { describe, expect, it } from "vitest";
import {
  NetError,
  backoffDelay,
  classifyStatus,
  explainError,
  extractCode,
  isIdempotent,
  isRetryableStatus,
  parseRetryAfter,
} from "../../src/lib/quality/net";

describe("classifyStatus", () => {
  it("把常见状态码映射成稳定语义", () => {
    expect(classifyStatus(401)).toBe("unauthorized");
    expect(classifyStatus(403)).toBe("forbidden");
    expect(classifyStatus(404)).toBe("not_found");
    expect(classifyStatus(409)).toBe("conflict");
    expect(classifyStatus(429)).toBe("rate_limited");
    expect(classifyStatus(500)).toBe("server");
    expect(classifyStatus(503)).toBe("server");
    expect(classifyStatus(418)).toBe("client");
    expect(classifyStatus(200)).toBe("unknown");
  });
});

describe("重试策略", () => {
  it("只有幂等方法默认自动重试", () => {
    expect(isIdempotent("GET")).toBe(true);
    expect(isIdempotent("head")).toBe(true);
    expect(isIdempotent("POST")).toBe(false);
    expect(isIdempotent("DELETE")).toBe(false);
  });

  it("仅对临时性状态码允许重试", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("退避按指数增长并受上限约束", () => {
    const noJitter = { random: () => 0.5, jitter: 0 };
    expect(backoffDelay(1, noJitter)).toBe(300);
    expect(backoffDelay(2, noJitter)).toBe(600);
    expect(backoffDelay(3, noJitter)).toBe(1200);
    expect(backoffDelay(10, noJitter)).toBe(8000);
  });

  it("抖动让等待时间落在合理区间内", () => {
    const low = backoffDelay(3, { random: () => 0, jitter: 0.2 });
    const high = backoffDelay(3, { random: () => 1, jitter: 0.2 });
    expect(low).toBe(960); // 1200 * 0.8
    expect(high).toBe(1440); // 1200 * 1.2
  });

  it("解析 Retry-After 的秒数与日期两种形式", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:20 GMT", now)).toBe(20_000);
    expect(parseRetryAfter("", now)).toBe(0);
    expect(parseRetryAfter("not-a-date", now)).toBe(0);
    // 上限 60 秒，避免服务端给出离谱值把请求挂死
    expect(parseRetryAfter("9999", now)).toBe(60_000);
  });
});

describe("错误体解析", () => {
  it("从后端约定结构里取出错误码", () => {
    expect(extractCode(JSON.stringify({ error: { code: "QUOTA_EXCEEDED" } }))).toBe("QUOTA_EXCEEDED");
    expect(extractCode(JSON.stringify({ code: "RATE_LIMITED" }))).toBe("RATE_LIMITED");
    expect(extractCode("not json")).toBe("");
    expect(extractCode("")).toBe("");
  });
});

describe("explainError", () => {
  it("401 明确要求重新登录，并说明本地数据没丢", () => {
    const info = explainError(new NetError({ kind: "unauthorized", message: "登录已过期", status: 401 }));
    expect(info.needsLogin).toBe(true);
    expect(info.dataSaved).toBe("yes");
    expect(info.action).toBe("login");
  });

  it("409 提示冲突而不是泛泛的失败", () => {
    const info = explainError(new NetError({ kind: "conflict", message: "版本冲突", status: 409 }));
    expect(info.mayConflict).toBe(true);
    expect(info.action).toBe("resolve-conflict");
  });

  it("离线时说明本地改动仍然保留", () => {
    const info = explainError(new NetError({ kind: "offline", message: "离线" }));
    expect(info.canRetry).toBe(true);
    expect(info.dataSaved).toBe("yes");
    expect(info.action).toBe("wait");
  });

  it("429 提示等待，且不会被当成已提交", () => {
    const info = explainError(new NetError({ kind: "rate_limited", message: "太频繁", status: 429 }));
    expect(info.dataSaved).toBe("no");
    expect(info.canRetry).toBe(true);
  });

  it("非 NetError 也能给出可读文案", () => {
    const info = explainError(new Error("随便什么错误"));
    // 不把未知异常笼统显示成「操作失败」：保留原始信息并给出下一步
    expect(info.title).toBe("操作未完成");
    expect(info.message).toBe("随便什么错误");
    expect(info.action).toBe("retry");
  });
});