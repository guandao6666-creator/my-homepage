import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readLimitedBody } from "../../worker/api/plugins/handlers.js";

/**
 * 2.0.9：`/api/plugins/net` 不再 `arrayBuffer()` 整包。
 *
 * 为什么单测够：真实外部大响应没法在离线 CI 里复现，而这里要证明的是
 * 「读到上限就停 + 取消上游连接 + 不多读一字节」，纯流行为可以直接造假流。
 */

function streamOfChunks(chunks: Uint8Array[], onCancel?: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      onCancel?.();
    },
  });
}

function responseOf(stream: ReadableStream<Uint8Array> | null) {
  return { body: stream } as unknown as Response;
}

describe("readLimitedBody", () => {
  it("超过上限时只保留 256 KiB 并取消上游", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const response = responseOf(streamOfChunks([chunk, chunk, chunk, chunk, chunk], () => (cancelled = true)));
    const result = await readLimitedBody(response, 256 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.bytes.byteLength).toBe(256 * 1024);
    expect(result.bytes[0]).toBe(7);
    expect(cancelled).toBe(true);
  });

  it("小响应原样读完、不取消", async () => {
    let cancelled = false;
    const text = new TextEncoder().encode('{"ok":true}');
    const response = responseOf(streamOfChunks([text.subarray(0, 3), text.subarray(3)], () => (cancelled = true)));
    const result = await readLimitedBody(response, 256 * 1024);
    expect(result.truncated).toBe(false);
    expect(new TextDecoder().decode(result.bytes)).toBe('{"ok":true}');
    expect(cancelled).toBe(false);
  });

  it("没有 body 时返回空且不崩", async () => {
    const result = await readLimitedBody(responseOf(null), 1024);
    expect(result.truncated).toBe(false);
    expect(result.bytes.byteLength).toBe(0);
  });

  it("源码里不再出现整包读取的实现", () => {
    const source = readFileSync("worker/api/plugins/handlers.js", "utf8");
    expect(source).toContain("readLimitedBody(response, 256 * 1024)");
    // 注释里会提到旧实现，所以只断言旧代码行本身不存在
    expect(source).not.toContain("const buffer = await response.arrayBuffer()");
  });
});