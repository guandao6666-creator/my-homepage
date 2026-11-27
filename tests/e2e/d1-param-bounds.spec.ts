/**
 * 2.0.5 · D1 绑定参数上限回归（真实 Worker + 真实 D1）
 *
 * 缺陷回顾：
 *   - `worker/api/community/write.js` 的 `markNotifications` 把最多 100 个 id
 *     展开进一条 `UPDATE ... IN (?, …, ?)`，加上 `now` 与 `user_id` 后 99 个 id
 *     就已经是 101 个绑定参数 → D1 报错 → 500。
 *   - `worker/api/plugins/store.js` 的 trending 一次取 200 行候选，再把
 *     `since + 200 个 id` 塞进一条聚合查询（201 个参数）→ 500。
 *
 * 这里用**真实 Worker**验证修复后的行为：120 个 id（远超旧实现的 100 上限）
 * 仍返回 200，且 `unread` 是数字；trending 列表的 `recentDownloads` 全部是数字
 * （分块查询合并后不会漏成 undefined）。
 *
 * 注：本用例不要求真的存在 120 条通知 —— D1 的参数上限在绑定阶段就会触发，
 * 与命中多少行无关；所以不需要造 99+ 数据，也不会碰上传限流。
 */
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

import { API_BASE, waitForFixtures } from "./support/worker-api";

type ApiResult = { status: number; body: any };

/** 独立 context + 夹具 session cookie（服务端只认 gauth_sid）。 */
async function sessionContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "gauth_sid", value: token, url: API_BASE }]);
  return context;
}

async function call(
  context: BrowserContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  data?: unknown,
): Promise<ApiResult> {
  const response = await context.request.fetch(`${API_BASE}${path}`, {
    method,
    headers: { Origin: API_BASE, Accept: "application/json" },
    data: data === undefined ? undefined : data,
    timeout: 20_000,
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status(), body };
}

function bulkNotificationIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const tail = String(index + 1).padStart(12, "0");
    return `11111111-2222-4333-8444-${tail}`;
  });
}

test.describe("D1 参数上限 · 真实 Worker 回归（2.0.5）", () => {
  test("通知标记已读：120 个 id 不再撞 100 参数上限", async ({ browser }) => {
    const fixtures = await waitForFixtures("accounts");
    const context = await sessionContext(browser, fixtures.tokens.installer);
    try {
      const ids = bulkNotificationIds(120);
      const result = await call(context, "PATCH", "/api/community/me/notifications", { ids });
      expect(result.status, JSON.stringify(result.body).slice(0, 500)).toBe(200);
      expect(result.body?.success).toBe(true);
      // 修复前这里会是 500 INTERNAL_ERROR（D1 参数超限）。
      expect(typeof result.body?.data?.unread).toBe("number");
    } finally {
      await context.close();
    }
  });

  test("插件市场 trending：分块聚合后每条都有数字 recentDownloads", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const result = await call(context, "GET", "/api/plugins?tab=trending&sort=trending&limit=30");
      expect(result.status, JSON.stringify(result.body).slice(0, 500)).toBe(200);
      const items = result.body?.data?.items ?? [];
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) {
        expect(typeof item.recentDownloads, `插件的 recentDownloads 应是数字：${item?.id}`).toBe("number");
      }
    } finally {
      await context.close();
    }
  });
});