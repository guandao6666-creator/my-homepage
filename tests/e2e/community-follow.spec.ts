/**
 * P1-7 · 社区 follow 正向链路（真实 Worker）。
 *
 * 背景：follow 接口要求目标创作者是 UUID（/^[0-9a-f-]{36}$/），qa-p3-* 短 id 会被 400。
 * 夹具里为此新增了固定 UUID 账号 `fixtures.users.creator`。
 *
 * 覆盖：未关注 → 关注 200 → 创作者详情 following=true → following feed 可读 →
 * 取关 200 → following=false。作品内容不在本用例内造（教程链路由 community-tutorial 覆盖）。
 */
import { expect, test } from "@playwright/test";

import { API_BASE, waitForFixtures } from "./support/worker-api";

test.describe("P1-7 · follow 正向链路", () => {
  test("关注 → 状态可见 → 取关，状态回到 false", async ({ browser }) => {
    const fixtures = await waitForFixtures("complete");
    const context = await browser.newContext();
    await context.addCookies([{ name: "gauth_sid", value: fixtures.tokens.installer, url: API_BASE }]);
    const creator = fixtures.users.creator;

    const call = (method: "GET" | "POST" | "DELETE", path: string) =>
      context.request.fetch(`${API_BASE}${path}`, {
        method,
        headers: { Origin: API_BASE, Accept: "application/json" },
      });

    try {
      const before = await (await call("GET", `/api/community/creators/${creator}`)).json();
      expect(JSON.stringify(before)).toContain('"isFollowing":false');

      const follow = await call("POST", `/api/community/creators/${creator}/follow`);
      expect(follow.status(), "关注应返回 200").toBe(200);
      const followed = await (await call("GET", `/api/community/creators/${creator}`)).json();
      expect(JSON.stringify(followed)).toContain('"isFollowing":true');

      const feed = await call("GET", "/api/community/feed?tab=following");
      expect(feed.status(), "following feed 应可读").toBe(200);

      const unfollow = await call("DELETE", `/api/community/creators/${creator}/follow`);
      expect(unfollow.status(), "取关应返回 200").toBe(200);
      const after = await (await call("GET", `/api/community/creators/${creator}`)).json();
      expect(JSON.stringify(after)).toContain('"isFollowing":false');
    } finally {
      await context.close();
    }
  });
});
