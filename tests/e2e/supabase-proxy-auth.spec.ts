/**
 * /sb 同源代理 · Authorization 透传（2.0.3 · 议会投票回归）
 *
 * 背景：Supabase 用 `Authorization: Bearer <access_token>` 识别登录用户，RLS 里的
 * `auth.uid()::text = voter` 依赖它。`worker/index.js` 的 /sb 代理在 1.9 安全加固时
 * 把 `Authorization` 和 Cookie 一起删掉了，PostgREST 只能看到 anon：
 * 读请求还有 `apikey` 可用，写请求（议会投票、树洞发帖、社交名片）全部 42501。
 *
 * 这组用例用**真实 Worker + 真实 Supabase** 区分两种失败，不写任何数据：
 *   - 带一个结构合法但签名无效的 JWT → PostgREST 会先报 JWT 解析失败（PGRST301）；
 *   - 不带 Authorization → 只能按 anon 处理，落到 RLS 拒绝（42501）。
 * 如果代理又把 Authorization 删掉，第一个用例会变回 42501，与线上故障同形。
 *
 * 注意：publishable key 是随页面公开下发的（Supabase 的正常用法），这里只用它
 * 让上游走到「校验身份」这一步，不涉及任何权限绕过。
 */

import { expect, test } from "@playwright/test";

const SUPABASE_KEY =
  process.env.E2E_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_swd8og5pj-HV_AvGD087Ag_AIaWr5Yn";

/** 结构合法、签名故意错误的 JWT：header.payload.signature。 */
const FAKE_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6NDEwMjQ0NDgwMH0",
  "fakesignature",
].join(".");

const VOTE_BODY = {
  poll_id: "00000000-0000-4000-8000-000000000000",
  option_index: 0,
  voter: "00000000-0000-4000-8000-000000000000",
};

const upstreamDown = (status: number, body: string) =>
  (status === 502 || status === 503) && body.includes("UPSTREAM_ERROR");

test.describe("Supabase 同源代理 · 身份头透传", () => {
  test("带 Authorization 时，PostgREST 能看到 JWT（签名错误也应报 PGRST301）", async ({ request }) => {
    const res = await request.post("/sb/rest/v1/votes", {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${FAKE_JWT}`,
        Prefer: "return=minimal",
      },
      data: VOTE_BODY,
      timeout: 20_000,
    });

    const body = await res.text();
    test.skip(upstreamDown(res.status(), body), "Supabase 上游暂时不可用，跳过（网络问题，不是代理解析问题）");

    expect(res.status()).toBe(401);
    // 关键：代理把 Authorization 交给了上游，PostgREST 才会尝试解码 JWT。
    expect(body).toContain("PGRST301");
    expect(body).not.toContain("42501");
  });

  test("不带 Authorization 时按匿名处理，被 RLS 拒绝（对照组）", async ({ request }) => {
    const res = await request.post("/sb/rest/v1/votes", {
      headers: { apikey: SUPABASE_KEY, Prefer: "return=minimal" },
      data: VOTE_BODY,
      timeout: 20_000,
    });

    const body = await res.text();
    test.skip(upstreamDown(res.status(), body), "Supabase 上游暂时不可用，跳过");

    expect(res.status()).toBe(401);
    expect(body).toContain("42501");
  });

  test("读请求仍可用（apikey 足够，回归不影响议会议题拉取）", async ({ request }) => {
    const res = await request.get("/sb/rest/v1/polls?select=id,title&limit=1", {
      headers: { apikey: SUPABASE_KEY },
      timeout: 20_000,
    });

    const body = await res.text();
    test.skip(upstreamDown(res.status(), body), "Supabase 上游暂时不可用，跳过");

    expect(res.status()).toBe(200);
    expect(body.startsWith("[")).toBe(true);
  });
});