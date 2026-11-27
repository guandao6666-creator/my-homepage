import { describe, expect, it } from "vitest";
import { contentHandler, parseByteRange } from "../../worker/api/files/handlers.js";

/**
 * 2.0.9 的 Range/HEAD 修复用真实 Response 断言。
 *
 * 为什么用假 R2 而不是 E2E：`R2 对不可满足区间回整包 200` 这件事在 miniflare 里可复现，
 * 但 E2E 只能看到状态码；这里直接断言「416 + Content-Range: bytes *\/size」
 * 与「HEAD 不读 body」，能锁住协议细节。
 */

function fakeEnv(options: { ignoreRange?: boolean } = {}) {
  const calls: Array<{ key: string; opts: unknown }> = [];
  const env = {
    FILES: {
      async get(key: string, opts?: unknown) {
        calls.push({ key, opts });
        const ranged = Boolean(opts) && !options.ignoreRange;
        return {
          body: new Blob(["0123456789"]).stream(),
          size: 1024,
          httpEtag: '"etag-1"',
          range: ranged ? { offset: 100, length: 100 } : undefined,
        };
      },
    },
  };
  return { env, calls };
}

const file = {
  id: "f-1",
  status: "ready",
  r2_key: "users/u1/files/f-1",
  name: "range.txt",
  display_name: "range.txt",
  mime_type: "text/plain",
  size_bytes: 1024,
  etag: '"etag-1"',
};

function request(headers: Record<string, string>, method = "GET") {
  return new Request("https://example.com/api/files/f-1/content", { method, headers });
}

describe("parseByteRange", () => {
  it("起点越过末尾判为不可满足", () => {
    expect(parseByteRange("bytes=1024-", 1024)).toEqual({ unsatisfiable: true });
    expect(parseByteRange("bytes=999999-1000000", 1024)).toEqual({ unsatisfiable: true });
  });

  it("合法区间截到文件末尾", () => {
    expect(parseByteRange("bytes=100-199", 1024)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange("bytes=100-", 1024)).toEqual({ start: 100, end: 1023 });
    expect(parseByteRange("bytes=100-99999", 1024)).toEqual({ start: 100, end: 1023 });
  });

  it("后缀区间从末尾倒数", () => {
    expect(parseByteRange("bytes=-100", 1024)).toEqual({ start: 924, end: 1023 });
  });

  it("多区间/畸形头返回 null（按 RFC 允许忽略）", () => {
    expect(parseByteRange("bytes=0-1,4-5", 1024)).toBeNull();
    expect(parseByteRange("items=0-1", 1024)).toBeNull();
    expect(parseByteRange(null, 1024)).toBeNull();
    expect(parseByteRange("bytes=0-", 0)).toBeNull();
  });
});

describe("contentHandler Range/HEAD", () => {
  it("不可满足的 Range 返回 416 且不读 R2", async () => {
    const { env, calls } = fakeEnv();
    const response = await contentHandler(env, request({ range: "bytes=999999-" }), file, false);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1024");
    expect(response.headers.get("content-length")).toBe("0");
    expect(calls).toHaveLength(0);
  });

  it("HEAD 返回元数据但不带 body", async () => {
    const { env } = fakeEnv();
    const response = await contentHandler(env, request({}, "HEAD"), file, false, true);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("1024");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("HEAD + Range 返回 206、区间长度、仍然没有 body", async () => {
    const { env } = fakeEnv();
    const response = await contentHandler(env, request({ range: "bytes=100-199" }, "HEAD"), file, false, true);
    expect(response.status).toBe(206);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1024");
    expect(response.headers.get("content-length")).toBe("100");
  });

  it("GET + Range 仍走 206 并回 body", async () => {
    const { env } = fakeEnv();
    const response = await contentHandler(env, request({ range: "bytes=100-199" }), file, false);
    expect(response.status).toBe(206);
    expect(response.body).not.toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1024");
  });

  it("R2 忽略 Range 时退回 200 整包（不伪造 206）", async () => {
    const { env } = fakeEnv({ ignoreRange: true });
    const response = await contentHandler(env, request({ range: "bytes=100-199" }), file, false);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
  });
});