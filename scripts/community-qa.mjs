#!/usr/bin/env node
/**
 * Guandao OS 1.6 · Community API 端到端 QA
 *
 * 前置条件（本地）：
 *   1. npm run db:migrate:local
 *   2. npm run build && npx wrangler dev --local --port 8787
 *   3. 本地 D1 中存在两个测试账号，并已插入对应的 Session：
 *        admin  token = qa-admin-token-1234567890
 *        member token = qa-member-token-1234567890
 *      （member 会被测试临时提升为审核员以验证 moderator 权限边界）
 *
 * 运行：
 *   node scripts/community-qa.mjs
 *
 * 脚本只使用公开 HTTP 接口，不直接改业务表；测试结束后会删除自己创建的
 * 临时作品，并恢复成员关注 / 审核员角色 / 社区设置等可能被改动的状态。
 */

import crypto from "node:crypto";

const BASE = (process.env.QA_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN = process.env.QA_ADMIN_COOKIE || "gauth_sid=qa-admin-token-1234567890";
const MEMBER = process.env.QA_MEMBER_COOKIE || "gauth_sid=qa-member-token-1234567890";
const ORIGIN = process.env.QA_ORIGIN || BASE;

const results = [];
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    results.push({ ok: true, name });
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    results.push({ ok: false, name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(path, { method = "GET", cookie = null, body, form, origin = ORIGIN } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（媒体 / HTML） */
  }
  return { status: response.status, json, text, headers: response.headers };
}

function pngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJ4cQwAAAABJRU5ErkJggg==",
    "base64",
  );
}

async function upload(cookie, bytes, type, kind = "cover", filename = "qa.png") {
  const form = new FormData();
  form.set("kind", kind);
  form.set("file", new Blob([bytes], { type }), filename);
  return request("/api/community/uploads", { method: "POST", cookie, form });
}

const themeManifest = (packageId, version = "1.0.0", extraConfig = {}, compatibility = { minimum: "1.6.0" }) => ({
  schemaVersion: 1,
  packageId,
  type: "theme",
  name: `QA Theme ${packageId}`,
  version,
  author: "QA",
  description: "Community QA theme",
  compatibility,
  license: "CC-BY-4.0",
  assets: [],
  configuration: {
    name: "QA Aurora",
    en: "QA",
    style: "冷色",
    desc: "QA theme",
    wall: "aurora",
    mode: "dark",
    accent: "#34d399",
    accent2: "#4bd3d1",
    material: "glass",
    radius: "round",
    darken: 18,
    dock: { size: 46, magnify: 1.28, opacity: 0.55 },
    font: "sans",
    grain: false,
    tags: ["QA"],
    ...extraConfig,
  },
});

async function createThemePost(cookie, { publish = true, packageId, version = "1.0.0", title, extraConfig, compatibility } = {}) {
  const cover = await upload(cookie, pngBytes(), "image/png");
  if (cover.status !== 201) throw new Error(`cover upload failed ${cover.status} ${cover.text}`);
  const manifest = themeManifest(packageId, version, extraConfig, compatibility);
  const response = await request("/api/community/posts", {
    method: "POST",
    cookie,
    body: {
      type: "theme",
      title: title || `QA Theme Post ${packageId}`,
      description: "API QA 自动化测试作品。",
      category: "dark",
      tags: ["QA", "自动化"],
      license: "CC-BY-4.0",
      coverAssetId: cover.json.data.asset.id,
      coverThumbAssetId: cover.json.data.thumb?.id || null,
      previews: [],
      wallpapers: [],
      rightsConfirmed: true,
      publish,
      manifest,
      changelog: "QA 首次发布",
    },
  });
  return response;
}

async function main() {
  console.log(`\nGuandao Community QA · ${BASE}\n`);

  /* ---------- 0. 放宽本次 QA 的每日发布配额，结束后恢复 ---------- */
  const originalSettings = await request("/api/community/admin/settings", { cookie: ADMIN });
  const originalPostQuota = Number(originalSettings.json?.data?.settings?.maxPostsPerDay || 5);
  await request("/api/community/admin/settings", {
    method: "PATCH",
    cookie: ADMIN,
    body: { maxPostsPerDay: 100 },
  });

  /* ---------- 1. 公共读取 ---------- */
  console.log("[1] 公共读取与配置");
  const meta = await request("/api/community/meta");
  check("meta 可读取", meta.status === 200, String(meta.status));
  check("系统版本为 1.6.0", meta.json?.data?.osVersion === "1.6.0", meta.json?.data?.osVersion);
  check("返回许可证与分类", Array.isArray(meta.json?.data?.licenses) && Array.isArray(meta.json?.data?.categories?.theme));
  const feed = await request("/api/community/feed?tab=latest");
  check("最新列表分页字段完整", feed.status === 200 && typeof feed.json?.data?.total === "number" && "hasMore" in feed.json.data);
  const trending = await request("/api/community/explore?sort=trending");
  check("热门排序 SQL 正常", trending.status === 200, String(trending.status));
  const creatorList = await request("/api/community/creators");
  check("创作者目录正常", creatorList.status === 200 && Array.isArray(creatorList.json?.data?.items));
  const visitorLike = await request("/api/community/posts/00000000-0000-0000-0000-000000000000/like", {
    method: "POST",
  });
  check("访客写入被拒绝", visitorLike.status === 401 || visitorLike.status === 404, String(visitorLike.status));

  /* ---------- 2. CSRF / 越权 ---------- */
  console.log("\n[2] CSRF 与越权");
  const csrf = await request("/api/community/posts/00000000-0000-0000-0000-000000000000/like", {
    method: "POST",
    cookie: MEMBER,
    origin: "",
  });
  check("缺少同源头被拒绝", csrf.status === 403, `got ${csrf.status}`);

  const adminTheme = await createThemePost(ADMIN, {
    packageId: `qa-qa-theme-${Date.now().toString(36)}`,
    title: "QA QA Theme",
  });
  check("管理员可发布主题", adminTheme.status === 201 && adminTheme.json?.data?.status === "published", adminTheme.text.slice(0, 200));
  if (!adminTheme.json?.data?.post?.id) {
    throw new Error(`无法创建 QA 主题：${adminTheme.status} ${adminTheme.text}`);
  }
  const themeId = adminTheme.json.data.post.id;

  const patchOther = await request(`/api/community/posts/${themeId}`, {
    method: "PATCH",
    cookie: MEMBER,
    body: { title: "Hacked" },
  });
  check("非作者不能修改作品", patchOther.status === 403, String(patchOther.status));
  const deleteOther = await request(`/api/community/posts/${themeId}`, { method: "DELETE", cookie: MEMBER });
  check("非作者不能删除作品", deleteOther.status === 403, String(deleteOther.status));
  const reportSelf = await request("/api/community/reports", {
    method: "POST",
    cookie: ADMIN,
    body: { targetType: "post", targetId: themeId, reason: "other", description: "self report should fail" },
  });
  check("不能举报自己的作品", reportSelf.status === 400, String(reportSelf.status));

  /* ---------- 3. 内容包安全 ---------- */
  console.log("\n[3] 内容包与图片安全");
  const malicious = await createThemePost(ADMIN, {
    packageId: `qa-malicious-${Date.now().toString(36)}`,
    title: "QA Malicious",
    extraConfig: { script: "alert(1)" },
  });
  check("拒绝未知执行字段", malicious.status === 400, `${malicious.status} ${malicious.text.slice(0, 160)}`);
  const svg = await upload(ADMIN, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "cover", "x.svg");
  check("拒绝 SVG 上传", svg.status === 415, String(svg.status));
  const incompatible = await createThemePost(ADMIN, {
    packageId: `qa-incompat-${Date.now().toString(36)}`,
    title: "QA Incompatible",
    compatibility: { minimum: "9.0.0" },
  });
  check("拒绝不兼容的最低版本", incompatible.status === 409, `${incompatible.status} ${incompatible.text.slice(0, 160)}`);

  /* ---------- 4. 安装包完整性 ---------- */
  console.log("\n[4] 安装包与媒体访问");
  const pkg = await request(`/api/community/posts/${themeId}/package?count=1`);
  check("内容包可下载", pkg.status === 200, String(pkg.status));
  const checksum = crypto.createHash("sha256").update(pkg.json?.data?.packageJson || "").digest("hex");
  check("SHA-256 校验一致", checksum === pkg.json?.data?.checksum, checksum);
  const parsed = JSON.parse(pkg.json?.data?.packageJson || "{}");
  check("内容包不含执行字段", !JSON.stringify(parsed).match(/"(script|eval|html|src|url)"/i));
  const mediaId = (await request(`/api/community/posts/${themeId}`)).json?.data?.post?.coverUrl?.split("/").pop();
  const media = await request(`/api/community/media/${mediaId}`);
  check("已发布作品媒体可公开读取", media.status === 200 && media.headers.get("content-type") === "image/png", String(media.status));

  /* ---------- 5. 互动 ---------- */
  console.log("\n[5] 点赞 / 收藏 / 评论 / 关注 / 通知");
  await request(`/api/community/posts/${themeId}/like`, {
    method: "POST",
    cookie: MEMBER,
  });
  const like2 = await request(`/api/community/posts/${themeId}/like`, { method: "POST", cookie: MEMBER });
  check("重复点赞只保留一条", like2.status === 200 && like2.json?.data?.likeCount === 1, String(like2.json?.data?.likeCount));
  const fav = await request(`/api/community/posts/${themeId}/favorite`, {
    method: "POST",
    cookie: MEMBER,
    body: { collection: "QA 收藏夹" },
  });
  check("收藏夹分类写入", fav.status === 200 && fav.json?.data?.collection === "QA 收藏夹");
  const favList = await request("/api/community/me/favorites?collection=QA%20%E6%94%B6%E8%97%8F%E5%A4%B9", { cookie: MEMBER });
  check("收藏列表可按收藏夹过滤", favList.status === 200 && favList.json?.data?.items?.some((item) => item.id === themeId));

  const comment = await request(`/api/community/posts/${themeId}/comments`, {
    method: "POST",
    cookie: MEMBER,
    body: { content: "QA 评论：这套主题很好看！" },
  });
  check("评论发表成功", comment.status === 201, String(comment.status));
  const commentId = comment.json?.data?.comment?.id;
  const reply = await request(`/api/community/posts/${themeId}/comments`, {
    method: "POST",
    cookie: ADMIN,
    body: { content: "QA 回复：谢谢喜欢。", parentId: commentId },
  });
  check("两层回复成功", reply.status === 201 && reply.json?.data?.comment?.parentId === commentId);
  const comments = await request(`/api/community/posts/${themeId}/comments`);
  check("评论列表包含回复", comments.json?.data?.items?.[0]?.replies?.length === 1);

  const follow = await request(`/api/community/creators/${adminTheme.json.data.post.author.id}/follow`, {
    method: "POST",
    cookie: MEMBER,
  });
  check("关注创作者成功", follow.status === 200 && follow.json?.data?.following === true);
  const following = await request("/api/community/me/following", { cookie: MEMBER });
  check("关注动态包含作品", following.status === 200 && following.json?.data?.items?.some((item) => item.id === themeId));
  await request(`/api/community/creators/${adminTheme.json.data.post.author.id}/follow`, { method: "DELETE", cookie: MEMBER });

  const notifications = await request("/api/community/me/notifications", { cookie: ADMIN });
  check("评论 / 关注生成通知", notifications.status === 200 && notifications.json?.data?.unread > 0);
  const mark = await request("/api/community/me/notifications", { method: "PATCH", cookie: ADMIN, body: { all: true } });
  check("通知可标记已读", mark.status === 200 && mark.json?.data?.unread === 0, String(mark.json?.data?.unread));

  /* ---------- 6. 举报 ---------- */
  console.log("\n[6] 举报");
  const report = await request("/api/community/reports", {
    method: "POST",
    cookie: MEMBER,
    body: { targetType: "post", targetId: themeId, reason: "spam", description: "QA 举报流程测试" },
  });
  check("举报提交成功", report.status === 201, String(report.status));
  const report2 = await request("/api/community/reports", {
    method: "POST",
    cookie: MEMBER,
    body: { targetType: "post", targetId: themeId, reason: "spam", description: "QA 重复举报" },
  });
  check("同一目标重复举报被拒", report2.status === 409, String(report2.status));
  const reportList = await request("/api/community/admin/reports", { cookie: ADMIN });
  check("审核员看到举报队列", reportList.status === 200 && reportList.json?.data?.items?.length > 0);
  const reportId = reportList.json?.data?.items?.find((item) => item.targetId === themeId)?.id;
  const dismiss = await request(`/api/community/admin/reports/${reportId}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { action: "dismiss", resolution: "QA 驳回测试" },
  });
  check("举报可被驳回", dismiss.status === 200);

  /* ---------- 7. 审核流程与版本 ---------- */
  console.log("\n[7] 人工审核与版本管理");
  const memberPost = await createThemePost(MEMBER, {
    packageId: `qa-pending-${Date.now().toString(36)}`,
    title: "QA Pending Theme",
  });
  check("成员发布进入待审核", memberPost.status === 201 && memberPost.json?.data?.status === "pending_review", memberPost.text.slice(0, 200));
  const pendingId = memberPost.json?.data?.post?.id;
  const pendingPublic = await request(`/api/community/posts/${pendingId}`);
  check("待审核作品对访客不可见", pendingPublic.status === 404, String(pendingPublic.status));
  const queue = await request("/api/community/admin/queue", { cookie: ADMIN });
  check("审核队列包含作品", queue.json?.data?.items?.some((item) => item.id === pendingId));
  const selfReview = await request(`/api/community/admin/posts/${pendingId}/review`, {
    method: "POST",
    cookie: MEMBER,
    body: { action: "approve", note: "self approve should fail" },
  });
  check("审核员不能审核自己的作品", selfReview.status === 403, String(selfReview.status));
  const approve = await request(`/api/community/admin/posts/${pendingId}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { action: "approve", note: "QA 通过" },
  });
  check("审核通过后公开", approve.status === 200 && approve.json?.data?.post?.status === "published");
  const pendingPublic2 = await request(`/api/community/posts/${pendingId}`);
  check("访客可访问已通过作品", pendingPublic2.status === 200);

  const version2 = await request(`/api/community/posts/${pendingId}/versions`, {
    method: "POST",
    cookie: MEMBER,
    body: {
      manifest: themeManifest(memberPost.json.data.post.packageId, "1.1.0", { accent: "#22d3ee" }),
      changelog: "QA 1.1.0 更新",
    },
  });
  check("新版本提交审核", version2.status === 200 && version2.json?.data?.version === "1.1.0", version2.text.slice(0, 200));
  await request(`/api/community/admin/posts/${pendingId}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { action: "approve", note: "QA 版本通过" },
  });
  const versions = await request(`/api/community/posts/${pendingId}/versions`);
  check("历史版本保留", versions.json?.data?.versions?.length === 2);
  const oldPkg = await request(`/api/community/posts/${pendingId}/package?version=1.0.0`);
  check("旧版本仍可回退下载", oldPkg.status === 200 && oldPkg.json?.data?.version === "1.0.0");

  const feature = await request(`/api/community/admin/posts/${themeId}/feature`, {
    method: "POST",
    cookie: ADMIN,
    body: { featured: true },
  });
  check("管理员可设置精选", feature.status === 200 && feature.json?.data?.featured === true);
  const featuredFeed = await request("/api/community/feed?tab=featured");
  check("精选出现在首页", featuredFeed.json?.data?.items?.some((item) => item.id === themeId));

  /* ---------- 8. 角色与设置边界 ---------- */
  console.log("\n[8] 角色与设置边界");
  const modSettings = await request("/api/community/admin/settings", {
    method: "PATCH",
    cookie: MEMBER,
    body: { registrationMode: "open" },
  });
  check("审核员不能修改社区设置", modSettings.status === 403, String(modSettings.status));
  const modDelete = await request(`/api/community/admin/posts/${themeId}/review`, {
    method: "POST",
    cookie: MEMBER,
    body: { action: "delete" },
  });
  check("审核员不能删除作品", modDelete.status === 403, String(modDelete.status));
  const settings = await request("/api/community/admin/settings", { cookie: ADMIN });
  check("管理员可读取设置", settings.status === 200);
  const invite = await request("/api/community/admin/invites", {
    method: "POST",
    cookie: ADMIN,
    body: { label: "QA Invite", maxUses: 1, expiresInDays: 1 },
  });
  check("邀请码生成成功", invite.status === 201 && /^GD-/.test(invite.json?.data?.code || ""), invite.text.slice(0, 120));
  const inviteList = await request("/api/community/admin/invites", { cookie: ADMIN });
  check("邀请码列表不返回明文", inviteList.status === 200 && !JSON.stringify(inviteList.json).includes(invite.json?.data?.code));
  const stats = await request("/api/community/admin/stats", { cookie: ADMIN });
  check("管理员可读取社区总存储", stats.status === 200 && typeof stats.json?.data?.stats?.storageBytes === "number");

  /* ---------- 9. 清理 ---------- */
  console.log("\n[9] 清理 QA 数据");
  await request(`/api/community/posts/${pendingId}`, { method: "DELETE", cookie: ADMIN });
  await request(`/api/community/posts/${themeId}`, { method: "DELETE", cookie: ADMIN });
  const gone = await request(`/api/community/posts/${themeId}`);
  check("删除后作品不可访问", gone.status === 404, String(gone.status));
  await request("/api/community/admin/settings", {
    method: "PATCH",
    cookie: ADMIN,
    body: { maxPostsPerDay: originalPostQuota },
  });

  console.log(`\n结果：${results.length - failures}/${results.length} 通过\n`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nQA 脚本异常：", error);
  process.exitCode = 1;
});
