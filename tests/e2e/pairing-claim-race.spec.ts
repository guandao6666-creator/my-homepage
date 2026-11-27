/**
 * 2.0.4 · 设备配对：并发领取只能签发一个 Session
 *
 * 旧实现里 `confirmed → completed` 是无条件 UPDATE，两个并发的领取请求会各自
 * `createSessionRow`，随后都写 completed。结果同一组配对码换出两枚 Session，
 * 其中一枚永远留在会话表里没人使用（也扩大了泄漏面）。
 *
 * 修法把状态转换当成唯一闸门（`WHERE status='confirmed'` + 检查 meta.changes），
 * 落败的请求直接回 `alreadyDelivered: true`。这个 spec 用真实 Worker + 真实 D1
 * 并发打两次领取接口来守这条不变量。
 */
import { expect, test } from "@playwright/test";

import { API_BASE, as, expectStatus, openApi, waitForFixtures } from "./support/worker-api";

const SESSION_COOKIE = "gauth_sid";

test.describe("设备配对 · 并发领取（2.0.4）", () => {
  test("两个并发领取请求只换出一枚 Session", async ({ request }) => {
    const fixtures = await waitForFixtures("complete");
    const auth = as(fixtures, "installer");
    const api = await openApi();
    void request;
    let pairingId = "";

    try {
      // ① 发起配对（必须是绑定设备的已登录会话）
      const created = await api.post("/api/pairing/create", { headers: auth, data: {} });
      const createdBody = await expectStatus(created, 200);
      pairingId = createdBody.data.pairingId;
      const code = createdBody.data.code;
      expect(pairingId).toBeTruthy();
      expect(code).toMatch(/^\d{6}$/);

      // ② 新设备认领配对码
      const claimed = await api.post("/api/pairing/claim", {
        headers: { Origin: API_BASE, "Content-Type": "application/json" },
        data: { code, device: { name: "并发领取设备", type: "mobile", browser: "Chrome", os: "Android" } },
      });
      const claimedBody = await expectStatus(claimed, 200);
      const claimSecret = claimedBody.data.claimSecret;
      expect(claimSecret).toBeTruthy();

      // ③ 原设备确认（只有 source device 的会话能确认）
      const confirmed = await api.post(`/api/pairing/${pairingId}/confirm`, { headers: auth, data: {} });
      await expectStatus(confirmed, 200);

      // ④ 新设备同时轮询两次：只有一次应该拿到 Session
      const claimUrl = `/api/pairing/claim/${pairingId}?secret=${encodeURIComponent(claimSecret)}`;
      const [first, second] = await Promise.all([api.get(claimUrl), api.get(claimUrl)]);
      const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

      expect(first.status()).toBe(200);
      expect(second.status()).toBe(200);

      const responses = [first, second];
      const bodies = [firstBody, secondBody];
      const withSession = responses.filter((response) => String(response.headers()["set-cookie"] ?? "").includes(`${SESSION_COOKIE}=`));
      const alreadyDelivered = bodies.filter((body) => body?.data?.alreadyDelivered === true);

      // 恰好一次签发：另一枚 Session 从未存在过。
      expect(withSession).toHaveLength(1);
      expect(alreadyDelivered).toHaveLength(1);
      // 落败方也必须能明确知道「已经领取过」，而不是收到错误。
      expect(bodies.filter((body) => body?.data?.paired === true)).toHaveLength(2);
    } finally {
      if (pairingId) {
        await api.post(`/api/pairing/${pairingId}/cancel`, { headers: auth, data: {} }).catch(() => undefined);
      }
      await api.dispose();
    }
  });
});