#!/usr/bin/env node
/**
 * 社区发布链的生产验证（P0-2）。
 *
 * 与 qa:prod 的区别：qa:prod 只确认公开 feed 可读，这里真的走一遍
 * 「建草稿 → 发布 →（按 requireReview）审核 → 公开可检索 → 拉包校验 → 清理」。
 *
 * 安全边界：
 *   - 只创建/删除 `qa-prod-*` 前缀的行，所有 DELETE 都带前缀条件；
 *   - 不写 R2（不传封面），只写 D1 的社区表；
 *   - 失败时保留现场（E2E_KEEP=1 可跳过清理），并打印残留计数。
 *
 * 用法：node scripts/prod-community-qa.mjs [--base https://guandao.xin] [--keep]
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("用法：node scripts/prod-community-qa.mjs [--base https://guandao.xin] [--keep]");
  console.log("说明：会真实写入 qa-prod-* 测试账号与一条教程，结束后清理；--keep 保留现场。");
  process.exit(0);
}

const BASE = (() => {
  const index = process.argv.indexOf("--base");
  return index >= 0 ? process.argv[index + 1] : process.env.E2E_BASE || "https://guandao.xin";
})();
const KEEP = process.argv.includes("--keep") || process.env.E2E_KEEP === "1";
const DB = "guandao-db";
const WRANGLER = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

const stamp = Date.now().toString(36);
const AUTHOR_ID = `qa-prod-author-${stamp}`;
const ADMIN_ID = `qa-prod-admin-${stamp}`;
const AUTHOR_TOKEN = randomBytes(32).toString("base64url");
const ADMIN_TOKEN = randomBytes(32).toString("base64url");
const RUN = `qap${stamp}`;

let postId = "";
let failures = 0;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function check(name, pass, detail = "") {
  if (pass) console.log(`  ok   ${name}${detail ? ` · ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  }
}

function d1(sql, json = false) {
  const args = [WRANGLER, "d1", "execute", DB, "--remote"];
  if (json) args.push("--json");
  args.push("--command", sql);
  const out = execFileSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (!json) return out;
  const start = out.indexOf("[");
  return JSON.parse(start >= 0 ? out.slice(start) : out)[0]?.results ?? [];
}

function seed() {
  const now = Date.now();
  const githubId = Number(`91${String(now).slice(-8)}`);
  d1(`
    INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
    VALUES ('${AUTHOR_ID}', '${AUTHOR_ID}@example.test', 'QA Prod Author', 'active', ${now}, ${now}, ${githubId}, 'qa-prod', NULL, 'member', ${now});
    INSERT OR REPLACE INTO community_profiles (user_id, display_name, bio, created_at, updated_at)
    VALUES ('${AUTHOR_ID}', 'QA 生产作者', 'prod-community-qa 专用', ${now}, ${now});
    INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
    VALUES ('${AUTHOR_ID}-session', '${AUTHOR_ID}', '${sha256(AUTHOR_TOKEN)}', NULL, 'prod-community-qa', ${now + 2 * 3600_000}, ${now}, ${now});

    INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
    VALUES ('${ADMIN_ID}', '${ADMIN_ID}@example.test', 'QA Prod Admin', 'active', ${now}, ${now}, ${githubId + 1}, 'qa-prod-admin', NULL, 'admin', ${now});
    INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
    VALUES ('${ADMIN_ID}-session', '${ADMIN_ID}', '${sha256(ADMIN_TOKEN)}', NULL, 'prod-community-qa', ${now + 2 * 3600_000}, ${now}, ${now});
  `);
}

async function api(token, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin: BASE,
      cookie: `gauth_sid=${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function cleanup() {
  d1(`
    DELETE FROM community_follows WHERE follower_id LIKE 'qa-prod-%' OR following_id LIKE 'qa-prod-%';
    DELETE FROM community_notifications WHERE user_id LIKE 'qa-prod-%';
    DELETE FROM community_posts WHERE author_id LIKE 'qa-prod-%';
    DELETE FROM community_profiles WHERE user_id LIKE 'qa-prod-%';
    DELETE FROM sessions WHERE user_id LIKE 'qa-prod-%';
    DELETE FROM devices WHERE user_id LIKE 'qa-prod-%';
    DELETE FROM users WHERE id LIKE 'qa-prod-%';
  `);
}

function residual() {
  const rows = d1(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE id LIKE 'qa-prod-%') AS users,
       (SELECT COUNT(*) FROM community_posts WHERE author_id LIKE 'qa-prod-%') AS posts,
       (SELECT COUNT(*) FROM sessions WHERE user_id LIKE 'qa-prod-%') AS sessions`,
    true,
  );
  return rows[0] ?? { users: 0, posts: 0, sessions: 0 };
}

async function main() {
  console.log(`社区生产发布链 · ${BASE}\n`);
  seed();
  check("夹具账号已写入", true, `${AUTHOR_ID} / ${ADMIN_ID}`);

  const meta = await api(AUTHOR_TOKEN, "GET", "/api/community/meta");
  check("社区 meta 可读", meta.status === 200, `HTTP ${meta.status}`);

  const created = await api(AUTHOR_TOKEN, "POST", "/api/community/posts", {
    type: "tutorial",
    title: `生产链验证 ${RUN}`,
    description: `prod-community-qa ${RUN}`,
    category: "guide",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: false,
    manifest: {
      schemaVersion: 1,
      packageId: `com-qa-prod-${RUN}`,
      type: "tutorial",
      name: `生产链验证 ${RUN}`,
      version: "1.0.0",
      author: "qa-prod",
      description: "prod chain",
      compatibility: { minimum: "1.3.0" },
      license: "CC-BY-4.0",
      configuration: { content: `# 生产验证 ${RUN}\n\n清理中。` },
    },
  });
  postId = created.payload?.data?.post?.id ?? "";
  check("创建草稿", created.status === 201 && Boolean(postId), `HTTP ${created.status}`);

  const published = await api(AUTHOR_TOKEN, "POST", `/api/community/posts/${postId}/publish`, { rightsConfirmed: true });
  check("提交发布", published.status === 200, `HTTP ${published.status}`);

  // 是否需要审核由服务端决定：以详情里的实际状态为准，避免依赖 meta 字段名
  let detail = await api(AUTHOR_TOKEN, "GET", `/api/community/posts/${postId}`);
  if (detail.payload?.data?.post?.status === "pending_review") {
    const approved = await api(ADMIN_TOKEN, "POST", `/api/community/admin/posts/${postId}/review`, { action: "approve" });
    check("管理员审核通过", approved.status === 200, `HTTP ${approved.status}`);
    detail = await api(AUTHOR_TOKEN, "GET", `/api/community/posts/${postId}`);
  } else {
    check("无需审核（直接发布）", true);
  }
  check("详情可读且已发布", detail.status === 200 && detail.payload?.data?.post?.status === "published", String(detail.payload?.data?.post?.status));

  const search = await api(AUTHOR_TOKEN, "GET", `/api/community/search?q=${encodeURIComponent(RUN)}`);
  const hits = JSON.stringify(search.payload ?? "");
  check("可被检索", search.status === 200 && hits.includes(postId), `HTTP ${search.status}`);

  const pkg = await api(AUTHOR_TOKEN, "GET", `/api/community/posts/${postId}/package?version=1.0.0`);
  const checksum = pkg.payload?.data?.checksum ?? "";
  const packageJson = pkg.payload?.data?.packageJson ?? "";
  check("内容包可下载且校验一致", /^[0-9a-f]{64}$/.test(checksum) && sha256(packageJson) === checksum);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`  FAIL 执行异常 · ${error?.message ?? error}`);
} finally {
  if (!KEEP) {
    if (postId) await api(AUTHOR_TOKEN, "DELETE", `/api/community/posts/${postId}`).catch(() => undefined);
    try {
      cleanup();
    } catch (error) {
      console.error(`  WARN 清理失败 · ${error?.message ?? error}`);
    }
    const left = residual();
    check("清理后无 qa-prod 残留", Number(left.users) === 0 && Number(left.posts) === 0 && Number(left.sessions) === 0, JSON.stringify(left));
  } else {
    console.log("  E2E_KEEP=1：保留现场，未清理");
  }
}

console.log(failures === 0 ? "\n生产链验证通过" : `\n生产链验证失败：${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
