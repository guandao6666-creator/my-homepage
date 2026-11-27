/**
 * 文件 · Range / HEAD 协议（2.0.9 回归）
 *
 * 背景：`contentHandler` 直接把 `Range` 透传给 R2。R2 遇到「起点越过文件末尾」的区间
 * 不会报错，而是回整包 200——浏览器/下载器会把这次响应当成续传成功，随后拼接出坏文件；
 * 同时 HEAD 根本没路由，探测大小的客户端只能拿到 404/405。
 *
 * 这里用真实 Worker（wrangler dev + 本地 D1/R2）跑真实路径：
 *   上传 → 200 全量 → 206 区间 → 越界 416 + `Content-Range: bytes *\/size` → HEAD 无 body。
 */
import { expect, test } from "@playwright/test";

import { API_BASE, as, expectStatus, openApi, waitForFixtures } from "./support/worker-api";

const RUN_ID = `r${Date.now().toString(36)}`;

test.describe("文件 · Range/HEAD（2.0.9）", () => {
  test("越界 Range 返回 416，HEAD 只回元数据", async () => {
    const fixtures = await waitForFixtures("accounts");
    const api = await openApi();
    const auth = as(fixtures, "installer");
    const payload = Buffer.from("0123456789".repeat(100), "utf8");
    const size = payload.byteLength;
    let fileId: string | null = null;

    try {
      const upload = await api.post(`/api/files/upload?name=${encodeURIComponent(`range-${RUN_ID}.txt`)}`, {
        headers: { ...auth, "Content-Type": "text/plain" },
        data: payload,
      });
      const body = await expectStatus(upload, 201);
      fileId = (body?.data?.file?.id as string) ?? null;
      expect(fileId, "上传后应返回文件 id").toBeTruthy();

      const url = `${API_BASE}/api/files/${fileId}/content`;

      // 1) 全量。body 由 workerd 改成分块传输（还可能 gzip），content-length 会被运行时清掉，
      // 所以长度以实际字节为准，这里不断言响应头。
      const full = await api.get(url, { headers: auth });
      const fullText = await full.text();
      expect(full.status()).toBe(200);
      expect(full.headers()["accept-ranges"]).toBe("bytes");
      expect(fullText.length).toBe(size);

      // 2) 合法区间：同样只断言区间与内容。
      const part = await api.get(url, { headers: { ...auth, Range: "bytes=0-9" } });
      expect(part.status()).toBe(206);
      expect(part.headers()["content-range"]).toBe(`bytes 0-9/${size}`);
      expect(await part.text()).toBe("0123456789");

      // 3) 越界：旧实现这里回 200 整包。
      const beyond = await api.get(url, { headers: { ...auth, Range: `bytes=${size + 1}-` } });
      expect(beyond.status(), "起点越过末尾应是 416，不是整包 200").toBe(416);
      expect(beyond.headers()["content-range"]).toBe(`bytes */${size}`);

      // 4) HEAD：旧实现没有路由（404/405）。
      const head = await api.fetch(url, { method: "HEAD", headers: auth });
      expect(head.status()).toBe(200);
      expect(head.headers()["accept-ranges"]).toBe("bytes");
      expect((await head.body()).byteLength).toBe(0);
    } finally {
      if (fileId) {
        await api.delete(`/api/files/${fileId}`, { headers: auth }).catch(() => undefined);
        await api.delete(`/api/files/${fileId}/permanent`, { headers: auth }).catch(() => undefined);
      }
      await api.dispose();
    }
  });
});