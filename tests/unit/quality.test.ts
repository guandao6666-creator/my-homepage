/**
 * 诊断日志与资源域单元测试（1.9）
 *
 * 重点验证安全属性：令牌、JWT、Cookie 值不能落进日志。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { clearDiagnostics, exportDiagnostics, listDiagnostics, logDiagnostic, redact, trimStack } from "../../src/lib/quality/errors";
import { createScope, resourceStats } from "../../src/lib/quality/resources";

describe("redact（脱敏）", () => {
  it("移除 GitHub 令牌", () => {
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("移除 JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    expect(redact(`Bearer ${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("移除 key=value 形式的令牌与长十六进制串", () => {
    expect(redact("api_key=supersecretvalue123")).toContain("REDACTED");
    expect(redact("a".repeat(40))).toBe("HEX_REDACTED");
  });

  it("保留普通错误文案", () => {
    expect(redact("应用「便签」初始化失败")).toBe("应用「便签」初始化失败");
  });

  it("超长文本被截断", () => {
    expect(redact("x".repeat(600), 100).length).toBeLessThanOrEqual(101);
  });
});

describe("trimStack", () => {
  it("只保留前几行并逐行脱敏", () => {
    const stack = ["Error: boom", "at a (token=abcdef123456)", "at b", "at c", "at d", "at e", "at f", "at g"].join("\n");
    const trimmed = trimStack(stack, 3);
    expect(trimmed.split("\n").length).toBe(3);
    expect(trimmed).not.toContain("abcdef123456");
  });
});

describe("诊断日志", () => {
  beforeEach(() => clearDiagnostics());

  it("记录后可以读回，且消息已脱敏", () => {
    logDiagnostic({
      scope: "app:notes",
      code: "APP_INIT_FAILED",
      message: "请求失败 token=abcdefghijklmnopqrstuvwxyz1234",
    });
    const list = listDiagnostics();
    expect(list.length).toBe(1);
    expect(list[0].scope).toBe("app:notes");
    expect(list[0].message).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
    expect(list[0].message).toContain("REDACTED");
  });

  it("30 秒内的相同错误合并计数而不是刷屏", () => {
    for (let i = 0; i < 5; i += 1) {
      logDiagnostic({ scope: "app:notes", code: "SAME", message: "同一个错误" });
    }
    const list = listDiagnostics();
    expect(list.length).toBe(1);
    expect(list[0].count).toBe(5);
  });

  it("导出内容包含版本与统计，且不含原始令牌", () => {
    logDiagnostic({ scope: "sync", code: "SYNC_FAILED", message: "上传失败 token=abcdefghijklmnop" });
    const json = exportDiagnostics();
    expect(json).toContain("Guandao OS");
    expect(json).toContain("1.9.0");
    expect(json).not.toContain("abcdefghijklmnop");
  });

  it("清理后列表为空", () => {
    logDiagnostic({ scope: "x", code: "Y", message: "z" });
    clearDiagnostics();
    expect(listDiagnostics().length).toBe(0);
  });
});

describe("资源域（ResourceScope）", () => {
  it("dispose 会清掉定时器并回收计数", async () => {
    const before = resourceStats().intervals;
    const scope = createScope("test:interval");
    let ticks = 0;
    scope.interval(() => {
      ticks += 1;
    }, 10);
    expect(resourceStats().intervals).toBe(before + 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    scope.dispose();
    const afterDispose = ticks;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ticks).toBe(afterDispose);
    expect(resourceStats().intervals).toBe(before);
  });

  it("dispose 幂等，重复调用不会重复清理", () => {
    const scope = createScope("test:idempotent");
    let count = 0;
    scope.add(() => {
      count += 1;
    });
    scope.dispose();
    scope.dispose();
    scope.dispose();
    expect(count).toBe(1);
    expect(scope.disposed).toBe(true);
  });

  it("已释放的域再注册资源会立即清理，不会泄漏", () => {
    const scope = createScope("test:after-dispose");
    scope.dispose();
    let cleaned = false;
    scope.add(() => {
      cleaned = true;
    });
    expect(cleaned).toBe(true);
  });

  it("子域随父域一起释放", () => {
    const parent = createScope("test:parent");
    const child = parent.child("child");
    let childCleaned = false;
    child.add(() => {
      childCleaned = true;
    });
    parent.dispose();
    expect(childCleaned).toBe(true);
    expect(child.disposed).toBe(true);
  });

  it("事件监听在释放后被移除", () => {
    const target = new EventTarget();
    const scope = createScope("test:listener");
    let hits = 0;
    scope.on(target, "ping", () => {
      hits += 1;
    });
    target.dispatchEvent(new Event("ping"));
    expect(hits).toBe(1);
    scope.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(hits).toBe(1);
  });
});