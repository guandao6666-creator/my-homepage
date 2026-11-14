#!/usr/bin/env node
/**
 * Guandao OS Phase 5 · Community 发布链与审核闭环 QA（自包含 / 可重复）
 *
 * 由 `npm run qa:community`（scripts/qa-local-run.mjs community）拉起：
 *   - 自动迁移本地 D1 并 seed 固定身份（admin 复用唯一管理员，creator/other 为社区专用成员）
 *   - 用 wrangler dev --local --test-scheduled 启动 Worker（Origin = QA_ORIGIN）
 *   - 覆盖：草稿可见性 → 上传安全 → 发布/审核链 → 公开 feed/search/详情/计数 → 举报闭环
 *           → 版本链 → 教程内容包转义 → 审计 → 清理（qa-cleanup 四重校验 + scheduled 清 R2 + SQL 复核）
 *
 * 清理原则：只删除本次 RUN_ID 归属的数据；账号为固定 QA 夹具（保留），删除条件必须同时命中
 * 本次作品 id / QA 用户 id / 审核产生的 report id，绝不无条件 DELETE。
 *
 * 退出码：0 全绿；1 有失败或清理未通过。禁止在生产环境运行（仅本地 wrangler --local）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QA_TOKENS, QA_COMMUNITY_TOKENS } from "./seed-qa-local.mjs";
import {
  QaCleanupError,
  assertQaCleanupTarget,
  assertCleanupResourceCounts,
  assertDeleteCount,
  buildQaChildDeleteSql,
} from "./lib/qa-cleanup.mjs";

/* ============================================================================
 * 运行上下文
 * ========================================================================== */

const ROOT = process.cwd();
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
const BASE = (process.env.QA_BASE || process.env.BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ORIGIN = (process.env.QA_ORIGIN || BASE).replace(/\/+$/, "");
const RUN_ID = Date.now().toString(36);
const RUN_TAG = `QA-C ${RUN_ID}`;
const MARKER = "qa-community";
const STARTED_AT = Date.now();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CREATOR = {
  id: "qa-community-creator",
  email: "qa-community-creator@example.test",
  token: QA_COMMUNITY_TOKENS.creator,
};
const OTHER = {
  id: "qa-community-other",
  email: "qa-community-other@example.test",
  token: QA_COMMUNITY_TOKENS.other,
};
const ADMIN_COOKIE = `gauth_sid=${QA_TOKENS.admin}`;
const CREATOR_COOKIE = `gauth_sid=${CREATOR.token}`;
const OTHER_COOKIE = `gauth_sid=${OTHER.token}`;

const D1_ENV = {
  ...process.env,
  TEMP: TMP_DIR,
  TMP: TMP_DIR,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};

/* ============================================================================
 * 断言 / 请求 / D1 基础设施
 * ========================================================================== */

const results = [];
const skipped = [];
let failures = 0;

function check(name, ok, detail = "") {
  const passed = Boolean(ok);
  results.push({ name, ok: passed, detail: passed ? "" : String(detail).slice(0, 500) });
  if (passed) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}  ${detail ? `-> ${String(detail).slice(0, 300)}` : ""}`);
  }
  return passed;
}

/** 明确记录因本地夹具不满足而跳过的子链路（不计入通过/失败，汇总中单列）。 */
function skip(name, reason = "") {
  skipped.push({ name, reason: String(reason || "").slice(0, 300) });
  console.log(`SKIP  ${name}${reason ? `  -> ${reason}` : ""}`);
}

function must(ok, name, detail = "") {
  check(name, ok, detail);
  if (!ok) throw new Error(`前置校验失败：${name}`);
}

function dataOf(res) {
  return res?.json?.data;
}

function errCode(res) {
  return res?.json?.error?.code || "";
}

async function request(path, opts = {}) {
  const { method = "GET", cookie, body, form, origin = ORIGIN, headers = {} } = opts;
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function expectStatus(name, res, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  check(name, allowed.includes(res.status), `status=${res.status} body=${res.text.slice(0, 240)}`);
  return res;
}

function mustStatus(name, res, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  must(allowed.includes(res.status), name, `status=${res.status} body=${res.text.slice(0, 240)}`);
  return res;
}

function expectError(name, res, status, code) {
  const ok = res.status === status && (!code || errCode(res) === code);
  check(name, ok, `status=${res.status} code=${errCode(res)} body=${res.text.slice(0, 240)}`);
  return res;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/* ---------------------------- D1（本地） ---------------------------------- */

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inList(values) {
  return values.length ? values.map((value) => sqlQuote(value)).join(", ") : "NULL";
}

const TRANSIENT_D1 = /session commit token|internal error|database is locked|SQLITE_BUSY/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function d1Raw(sql, { attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(
      process.execPath,
      [WRANGLER, "d1", "execute", "guandao-db", "--local", "--json", "--command", sql],
      { cwd: ROOT, env: D1_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${String(result.stderr || "")}\n${String(result.stdout || "")}`;
    if (result.status === 0) {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        lastError = new Error(`d1 execute JSON 解析失败：${String(result.stdout).slice(0, 300)}`);
        if (attempt < attempts && TRANSIENT_D1.test(output)) {
          sleepSync(400 * attempt);
          continue;
        }
        throw lastError;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const failed = list.find((entry) => entry?.success !== true);
      if (!failed) return list;
      lastError = new Error(`d1 执行未成功：${JSON.stringify(failed).slice(0, 400)}`);
      if (attempt < attempts && TRANSIENT_D1.test(`${JSON.stringify(failed)}${output}`)) {
        sleepSync(400 * attempt);
        continue;
      }
      throw lastError;
    }
    lastError = new Error(`d1 execute 失败（exit=${result.status}）：${output.trim().slice(0, 500)}`);
    // wrangler dev 与 d1 execute 并发写同一本地 D1 时偶发 session commit token 错误，短暂退避后重试。
    if (attempt < attempts && TRANSIENT_D1.test(output)) {
      sleepSync(400 * attempt);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

function d1Rows(sql) {
  return d1Raw(sql)[0]?.results || [];
}

function d1Count(sql) {
  const row = d1Rows(sql)[0];
  return Number(row?.n ?? row?.total ?? 0);
}

function d1Write(statements) {
  return d1Raw(statements.join(";\n"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================================
 * 测试数据构造（内容包 manifest 必须通过 worker/api/community/validate.js）
 * ========================================================================== */

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#34d399"/></svg>',
  "utf8",
);

function themeConfig(name, extra = {}) {
  return {
    name,
    en: "QA Theme",
    style: "QA 自动化主题",
    desc: "Guandao QA 自动生成的主题内容包",
    wall: "aurora",
    mode: "dark",
    accent: "#34d399",
    accent2: "#4bd3d1",
    material: "glass",
    radius: "round",
    darken: 18,
    dock: { size: 46, magnify: 1.2, opacity: 0.55 },
    font: "sans",
    grain: false,
    tags: ["qa"],
    ...extra,
  };
}

function themeManifest({ packageId, version = "1.0.0", name, config }) {
  return {
    schemaVersion: 1,
    packageId,
    type: "theme",
    name,
    version,
    author: "QA Bot",
    description: "Guandao QA 自动化主题内容包",
    compatibility: { minimum: "2.0.0" },
    license: "CC-BY-4.0",
    assets: [],
    configuration: themeConfig(name, config),
  };
}

function tutorialManifest({ packageId, version = "1.0.0", name, content }) {
  return {
    schemaVersion: 1,
    packageId,
    type: "tutorial",
    name,
    version,
    author: "QA Bot",
    description: "Guandao QA 自动化教程内容包",
    compatibility: { minimum: "2.0.0" },
    license: "CC-BY-4.0",
    assets: [],
    configuration: { content },
  };
}

function upload(cookie, bytes, { type = "image/png", kind = "cover", filename = "qa.png" } = {}) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", new Blob([bytes], { type }), filename);
  return request("/api/community/uploads", { method: "POST", cookie, form });
}

function createPost(cookie, body, opts = {}) {
  return request("/api/community/posts", { method: "POST", cookie, body, ...opts });
}

/* ============================================================================
 * 本轮状态（清理只依赖这里记录的 id + 数据库归属复核）
 * ========================================================================== */

const state = {
  adminId: null,
  posts: {}, // key -> postId
  postTitles: {}, // key -> title
  assets: {}, // key -> assetId
  comments: {},
  reports: {}, // key -> {id, targetId}
  invite: null, // {id, prefix}
  counter: { download0: 0, view0: 0 },
  baseline: { assetCount: 0, postCount: 0 },
  cleanup: { r2Verified: false, identityVerified: false, residueVerified: false },
};

function trackAsset(key, assetId) {
  state.assets[key] = assetId;
  return assetId;
}

function trackPost(key, postId, title) {
  state.posts[key] = postId;
  state.postTitles[key] = title;
  return postId;
}

/* ============================================================================
 * 主测试流程
 * ========================================================================== */

async function runTests() {
  console.log(`\n[qa-community] RUN_ID=${RUN_ID} BASE=${BASE}`);
  console.log("[qa-community] 1) 元数据 / 固定身份");

  const metaGuest = await request("/api/community/meta");
  mustStatus("meta: 访客 200", metaGuest, 200);
  must(dataOf(metaGuest)?.osVersion === "2.0.0", "meta: osVersion 2.0.0", JSON.stringify(dataOf(metaGuest)?.osVersion));
  check("meta: 许可证与分类", Array.isArray(dataOf(metaGuest)?.licenses) && Array.isArray(dataOf(metaGuest)?.categories?.theme));
  const metaCreator = await request("/api/community/meta", { cookie: CREATOR_COOKIE });
  must(metaCreator.status === 200 && dataOf(metaCreator)?.viewer?.id === CREATOR.id, "meta: creator 身份");
  check("meta: creator 初始为 member", dataOf(metaCreator)?.viewer?.role === "member");
  const metaOther = await request("/api/community/meta", { cookie: OTHER_COOKIE });
  must(metaOther.status === 200 && dataOf(metaOther)?.viewer?.id === OTHER.id, "meta: other 身份");
  const metaAdmin = await request("/api/community/meta", { cookie: ADMIN_COOKIE });
  must(metaAdmin.status === 200 && dataOf(metaAdmin)?.viewer?.role === "admin", "meta: admin 身份");
  state.adminId = dataOf(metaAdmin).viewer.id;
  check("meta: 管理员 id 可用于归属复核", typeof state.adminId === "string" && state.adminId.length > 0, state.adminId);

  const usage0 = await request("/api/community/me/usage", { cookie: CREATOR_COOKIE });
  mustStatus("me/usage: creator 基线", usage0, 200);
  state.baseline.postCount = Number(dataOf(usage0)?.usage?.postCount || 0);
  state.baseline.assetCount = Number(dataOf(usage0)?.usage?.assetCount || 0);
  check(
    "me/usage: 返回上限字段",
    Number(dataOf(usage0)?.limits?.maxUploadBytes) > 0 && Number(dataOf(usage0)?.limits?.maxPostsPerDay) > 0,
    JSON.stringify(dataOf(usage0)?.limits),
  );

  /* ---------------------- 2) 上传安全（PNG / SVG / 超大 / 非图片） -------- */
  console.log("[qa-community] 2) 上传安全与孤儿检查");

  const cover1 = await upload(CREATOR_COOKIE, PNG_1PX, { kind: "cover" });
  mustStatus("upload: creator 封面1 201", cover1, 201);
  trackAsset("cover1", dataOf(cover1)?.asset?.id);
  check(
    "upload: 封面1 资源字段",
    dataOf(cover1)?.asset?.kind === "cover" && String(dataOf(cover1)?.asset?.url || "").includes("/api/community/media/"),
    JSON.stringify(dataOf(cover1)?.asset || {}).slice(0, 200),
  );

  const cover2 = await upload(CREATOR_COOKIE, PNG_1PX, { kind: "cover" });
  mustStatus("upload: creator 封面2 201", cover2, 201);
  trackAsset("cover2", dataOf(cover2)?.asset?.id);

  const cover3 = await upload(ADMIN_COOKIE, PNG_1PX, { kind: "cover" });
  mustStatus("upload: admin 封面3 201", cover3, 201);
  trackAsset("cover3", dataOf(cover3)?.asset?.id);

  const usageAfterUploads = await request("/api/community/me/usage", { cookie: CREATOR_COOKIE });
  const assetCountAfterUploads = Number(dataOf(usageAfterUploads)?.usage?.assetCount || 0);
  check("upload: 两张封面计入 creator 用量", assetCountAfterUploads === state.baseline.assetCount + 2, `${state.baseline.assetCount} -> ${assetCountAfterUploads}`);

  const svgRes = await upload(CREATOR_COOKIE, SVG_BYTES, { type: "image/svg+xml", filename: "qa.svg" });
  expectError("upload: SVG 拒绝 415", svgRes, 415, "UNSUPPORTED_IMAGE");

  const textRes = await upload(CREATOR_COOKIE, Buffer.from("this is not an image at all", "utf8"), {
    type: "image/png",
    filename: "fake.png",
  });
  expectError("upload: 伪装 PNG 的非图片拒绝 415", textRes, 415, "UNSUPPORTED_IMAGE");

  const oversize = Buffer.concat([PNG_1PX, Buffer.alloc(9 * 1024 * 1024, 0)]);
  const oversizeRes = await upload(CREATOR_COOKIE, oversize, { kind: "cover", filename: "huge.png" });
  expectError("upload: 超大文件拒绝 413", oversizeRes, 413, "FILE_TOO_LARGE");

  const usageAfterFailed = await request("/api/community/me/usage", { cookie: CREATOR_COOKIE });
  check(
    "upload: 失败上传不产生孤儿资源",
    Number(dataOf(usageAfterFailed)?.usage?.assetCount || 0) === assetCountAfterUploads,
    `before=${assetCountAfterUploads} after=${dataOf(usageAfterFailed)?.usage?.assetCount}`,
  );

  /* ---------------------- 3) 内容包校验失败（不落库） -------------------- */
  console.log("[qa-community] 3) 内容包安全校验");

  const themePkgA = `qa-c-${RUN_ID}-theme-a`;
  const themePkgB = `qa-c-${RUN_ID}-theme-b`;
  const themePkgAdmin = `qa-c-${RUN_ID}-theme-admin`;
  const tutorialPkg = `qa-c-${RUN_ID}-tutorial`;

  const noManifest = await createPost(CREATOR_COOKIE, {
    type: "theme",
    title: `${RUN_TAG} 无内容包`,
    category: "dark",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: true,
  });
  expectError("create: 发布缺内容包 400", noManifest, 400, "INVALID_INPUT");

  const badConfig = await createPost(CREATOR_COOKIE, {
    type: "theme",
    title: `${RUN_TAG} 恶意字段`,
    category: "dark",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: false,
    manifest: themeManifest({
      packageId: themePkgA,
      version: "1.0.0",
      name: "QA 恶意字段",
      config: { script: "alert(1)" },
    }),
  });
  expectError("create: manifest 夹带 script 字段 400", badConfig, 400, "INVALID_MANIFEST");

  const badTutorial = await createPost(CREATOR_COOKIE, {
    type: "tutorial",
    title: `${RUN_TAG} 恶意教程`,
    category: "guide",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: false,
    manifest: tutorialManifest({
      packageId: tutorialPkg,
      version: "1.0.0",
      name: "QA 恶意教程",
      content: '<script>alert("xss")</script> 教程正文',
    }),
  });
  expectError("create: 教程正文 <script> 拒绝 400", badTutorial, 400, "INVALID_MANIFEST");

  const incompatible = await createPost(CREATOR_COOKIE, {
    type: "theme",
    title: `${RUN_TAG} 不兼容`,
    category: "dark",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: true,
    coverAssetId: state.assets.cover1,
    manifest: (() => {
      const m = themeManifest({ packageId: themePkgA, version: "1.0.0", name: "QA 不兼容" });
      m.compatibility = { minimum: "9.0.0" };
      return m;
    })(),
  });
  expectError("create: 不兼容最低版本 409", incompatible, 409, "INCOMPATIBLE");

  const noCover = await createPost(CREATOR_COOKIE, {
    type: "theme",
    title: `${RUN_TAG} 无封面`,
    category: "dark",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: true,
    manifest: themeManifest({ packageId: themePkgA, version: "1.0.0", name: "QA 无封面" }),
  });
  expectError("create: 发布缺封面 400", noCover, 400, "INVALID_INPUT");

  const csrf = await createPost(
    CREATOR_COOKIE,
    {
      type: "theme",
      title: `${RUN_TAG} CSRF`,
      category: "dark",
      license: "CC-BY-4.0",
      rightsConfirmed: true,
      publish: false,
      manifest: themeManifest({ packageId: themePkgA, version: "1.0.0", name: "QA CSRF" }),
    },
    { origin: null },
  );
  // 已登录但缺少 Origin/sec-fetch-site：社区写接口应被 CSRF 防护拒绝
  must(csrf.status === 403 && errCode(csrf) === "CSRF_REJECTED", "create: 缺少 Origin 被 CSRF 拒绝 403", `status=${csrf.status} code=${errCode(csrf)}`);

  const guestCreate = await createPost(undefined, {
    type: "theme",
    title: `${RUN_TAG} 访客`,
    category: "dark",
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    publish: false,
  });
  expectError("create: 访客 401", guestCreate, 401, "UNAUTHENTICATED");

  const usageAfterBad = await request("/api/community/me/usage", { cookie: CREATOR_COOKIE });
  check(
    "create: 失败创建不新增作品",
    Number(dataOf(usageAfterBad)?.usage?.postCount || 0) === state.baseline.postCount,
    `before=${state.baseline.postCount} after=${dataOf(usageAfterBad)?.usage?.postCount}`,
  );

  /* ---------------------- 4) 草稿创建与可见性 ---------------------------- */
  console.log("[qa-community] 4) 草稿创建与可见性");

  const themeTitle = `${RUN_TAG} 主题作品`;
  const tutorialTitle = `${RUN_TAG} 教程作品`;
  const tutorialContentSafe = [
    `# ${RUN_TAG} 教程`,
    "",
    "正常 Markdown：**粗体**、`inline code`、[外链](https://example.com/qa)。",
    "",
    "行内 HTML 会被前端 renderMarkdown 整体转义：<b>不该被当作标签</b> <img src=x onerror=alert(1)>",
  ].join("\n");

  const draftTheme = await createPost(CREATOR_COOKIE, {
    type: "theme",
    title: themeTitle,
    description: `${RUN_TAG} 草稿主题描述`,
    category: "dark",
    tags: ["qa", RUN_ID],
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    coverAssetId: state.assets.cover1,
    previews: [],
    wallpapers: [],
    publish: false,
    manifest: themeManifest({ packageId: themePkgA, version: "1.0.0", name: themeTitle }),
    changelog: "QA 首版",
  });
  mustStatus("draft: 主题草稿 201", draftTheme, 201);
  check("draft: 状态 draft", dataOf(draftTheme)?.status === "draft", JSON.stringify(dataOf(draftTheme)?.status));
  trackPost("theme", dataOf(draftTheme)?.post?.id, themeTitle);
  must(UUID_RE.test(String(state.posts.theme || "")), "draft: 主题作品 id 为 UUID", String(state.posts.theme));

  const draftTutorial = await createPost(CREATOR_COOKIE, {
    type: "tutorial",
    title: tutorialTitle,
    description: `${RUN_TAG} 草稿教程描述`,
    category: "guide",
    tags: ["qa", RUN_ID],
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    coverAssetId: state.assets.cover2,
    publish: false,
    manifest: tutorialManifest({ packageId: tutorialPkg, version: "1.0.0", name: tutorialTitle, content: tutorialContentSafe }),
    changelog: "QA 教程首版",
  });
  mustStatus("draft: 教程草稿 201", draftTutorial, 201);
  trackPost("tutorial", dataOf(draftTutorial)?.post?.id, tutorialTitle);

  const guestDraftDetail = await request(`/api/community/posts/${state.posts.theme}`);
  expectError("draft: 访客详情 404", guestDraftDetail, 404, "NOT_FOUND");
  const otherDraftDetail = await request(`/api/community/posts/${state.posts.theme}`, { cookie: OTHER_COOKIE });
  expectError("draft: 其他成员详情 404", otherDraftDetail, 404, "NOT_FOUND");
  const ownerDraftDetail = await request(`/api/community/posts/${state.posts.theme}`, { cookie: CREATOR_COOKIE });
  mustStatus("draft: 作者本人可见 200", ownerDraftDetail, 200);
  check("draft: 作者详情 status=draft", dataOf(ownerDraftDetail)?.post?.status === "draft");

  const otherPatch = await request(`/api/community/posts/${state.posts.theme}`, {
    method: "PATCH",
    cookie: OTHER_COOKIE,
    body: { title: "越权修改" },
  });
  // 草稿对非作者不可见：接口统一返回 404（不暴露存在性），发布后的非作者 403 在审核段验证。
  expectError("draft: 非作者修改 404", otherPatch, 404, "NOT_FOUND");
  const otherDelete = await request(`/api/community/posts/${state.posts.theme}`, { method: "DELETE", cookie: OTHER_COOKIE });
  expectError("draft: 非作者删除 404", otherDelete, 404, "NOT_FOUND");
  const otherPublish = await request(`/api/community/posts/${state.posts.theme}/publish`, {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { rightsConfirmed: true },
  });
  expectError("draft: 非作者发布 404", otherPublish, 404, "NOT_FOUND");

  const searchDraft = await request(`/api/community/search?q=${encodeURIComponent(RUN_TAG)}`);
  mustStatus("draft: 搜索接口 200", searchDraft, 200);
  check(
    "draft: 搜索不返回草稿",
    !(dataOf(searchDraft)?.items || []).some((item) => item.id === state.posts.theme),
  );
  const feedDraft = await request("/api/community/feed?tab=latest&limit=48");
  check(
    "draft: feed 不返回草稿",
    !(dataOf(feedDraft)?.items || []).some((item) => item.id === state.posts.theme),
  );

  const mediaDraftGuest = await request(`/api/community/media/${state.assets.cover1}`);
  expectError("draft: 封面访客不可见 404", mediaDraftGuest, 404, "NOT_FOUND");
  const mediaDraftOther = await request(`/api/community/media/${state.assets.cover1}`, { cookie: OTHER_COOKIE });
  expectError("draft: 封面其他成员不可见 404", mediaDraftOther, 404, "NOT_FOUND");
  const mediaDraftOwner = await request(`/api/community/media/${state.assets.cover1}`, { cookie: CREATOR_COOKIE });
  mustStatus("draft: 封面作者可见 200", mediaDraftOwner, 200);
  check(
    "draft: 封面 content-type image/png",
    String(mediaDraftOwner.headers.get("content-type") || "").startsWith("image/png") &&
      String(mediaDraftOwner.headers.get("x-content-type-options") || "") === "nosniff",
    `${mediaDraftOwner.headers.get("content-type")} / ${mediaDraftOwner.headers.get("x-content-type-options")}`,
  );

  const myDrafts = await request("/api/community/me/creations?status=draft", { cookie: CREATOR_COOKIE });
  mustStatus("draft: 我的草稿 200", myDrafts, 200);
  check(
    "draft: 我的草稿含两件",
    (dataOf(myDrafts)?.items || []).some((item) => item.id === state.posts.theme) &&
      (dataOf(myDrafts)?.items || []).some((item) => item.id === state.posts.tutorial),
  );

  /* ---------------------- 5) 发布 / 提交审核 ----------------------------- */
  console.log("[qa-community] 5) 发布 / 提交审核 / 队列");

  const publishTheme = await request(`/api/community/posts/${state.posts.theme}/publish`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { rightsConfirmed: true },
  });
  mustStatus("publish: 成员发布 200", publishTheme, 200);
  check("publish: 成员发布进入 pending_review", dataOf(publishTheme)?.post?.status === "pending_review", JSON.stringify(dataOf(publishTheme)?.post?.status));
  check("publish: 首次写内容包 wroteNewVersion", dataOf(publishTheme)?.wroteNewVersion === true);

  const publishAgain = await request(`/api/community/posts/${state.posts.theme}/publish`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { rightsConfirmed: true },
  });
  expectStatus("publish: 重复提交幂等 200", publishAgain, 200);
  check(
    "publish: 重复提交不重复写版本",
    dataOf(publishAgain)?.wroteNewVersion === false && dataOf(publishAgain)?.post?.status === "pending_review",
    JSON.stringify({ wrote: dataOf(publishAgain)?.wroteNewVersion, status: dataOf(publishAgain)?.post?.status }),
  );

  const publishTutorial = await request(`/api/community/posts/${state.posts.tutorial}/publish`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { rightsConfirmed: true },
  });
  mustStatus("publish: 教程提交审核 200", publishTutorial, 200);
  check("publish: 教程 pending_review", dataOf(publishTutorial)?.post?.status === "pending_review");

  const guestPendingDetail = await request(`/api/community/posts/${state.posts.theme}`);
  expectError("publish: 待审详情访客 404", guestPendingDetail, 404, "NOT_FOUND");
  const feedPending = await request("/api/community/feed?tab=latest&limit=48");
  check(
    "publish: 待审作品不进 feed",
    !(dataOf(feedPending)?.items || []).some((item) => item.id === state.posts.theme),
  );

  const queue = await request("/api/community/admin/queue?status=pending_review", { cookie: ADMIN_COOKIE });
  mustStatus("queue: 管理员 200", queue, 200);
  const queueIds = (dataOf(queue)?.items || []).map((item) => item.id);
  check(
    "queue: 待审队列含两份提交",
    queueIds.includes(state.posts.theme) && queueIds.includes(state.posts.tutorial),
    `queue=${queueIds.length}`,
  );
  const guestQueue = await request("/api/community/admin/queue");
  expectError("queue: 访客 401", guestQueue, 401, "UNAUTHENTICATED");
  const memberQueue = await request("/api/community/admin/queue", { cookie: CREATOR_COOKIE });
  expectError("queue: 普通成员 403", memberQueue, 403, "FORBIDDEN");

  /* ---------------------- 6) 审核员权限（临时 moderator） ----------------- */
  console.log("[qa-community] 6) 审核员权限边界");

  // 本地 QA 账号 id 非 UUID，admin 用户管理接口按 UUID 校验会 404；这里直接落一行
  // community_roles 作为测试夹具（仅本地 D1，清理阶段删除），用于验证审核员边界。
  d1Write([
    `INSERT INTO community_roles (user_id, role, granted_by, created_at)
     VALUES ('${CREATOR.id}', 'moderator', ${sqlQuote(state.adminId)}, ${Date.now()})
     ON CONFLICT (user_id) DO UPDATE SET role = 'moderator', granted_by = excluded.granted_by`,
  ]);
  const metaModerator = await request("/api/community/meta", { cookie: CREATOR_COOKIE });
  must(
    metaModerator.status === 200 && dataOf(metaModerator)?.viewer?.role === "moderator" && dataOf(metaModerator)?.viewer?.staff === true,
    "moderator: creator 临时具备审核员身份",
    JSON.stringify(dataOf(metaModerator)?.viewer),
  );
  const selfReview = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { action: "approve" },
  });
  expectError("moderator: 审核自己的作品 403", selfReview, 403, "FORBIDDEN");
  const moderatorDelete = await request(`/api/community/admin/posts/${state.posts.tutorial}/review`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { action: "delete" },
  });
  expectError("moderator: 删除作品需 admin 403", moderatorDelete, 403, "FORBIDDEN");
  const moderatorSettings = await request("/api/community/admin/settings", {
    method: "PATCH",
    cookie: CREATOR_COOKIE,
    body: { allowPublishing: false },
  });
  expectError("moderator: 修改设置需 admin 403", moderatorSettings, 403, "FORBIDDEN");
  const moderatorQueue = await request("/api/community/admin/queue?status=pending_review", { cookie: CREATOR_COOKIE });
  expectStatus("moderator: 可读审核队列 200", moderatorQueue, 200);
  const moderatorFeature = await request(`/api/community/admin/posts/${state.posts.theme}/feature`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { featured: true },
  });
  expectError("moderator: 精选需 admin 403", moderatorFeature, 403, "FORBIDDEN");

  d1Write([`DELETE FROM community_roles WHERE user_id = '${CREATOR.id}'`]);
  const metaBackMember = await request("/api/community/meta", { cookie: CREATOR_COOKIE });
  check(
    "moderator: 角色恢复 member",
    dataOf(metaBackMember)?.viewer?.role === "member" && dataOf(metaBackMember)?.viewer?.staff === false,
  );

  /* ---------------------- 7) 管理员审核闭环 --------------------------------- */
  console.log("[qa-community] 7) 管理员审核闭环");

  const approveTheme = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "approve", note: `${RUN_TAG} 通过` },
  });
  mustStatus("review: approve 200", approveTheme, 200);
  check("review: 主题 published", dataOf(approveTheme)?.post?.status === "published");
  check("review: 主题版本 1.0.0", dataOf(approveTheme)?.post?.version === "1.0.0");

  // 已发布作品对非作者可见，但写操作必须 403（owner 校验而非存在性隐藏）。
  const otherPatchPublished = await request(`/api/community/posts/${state.posts.theme}`, {
    method: "PATCH",
    cookie: OTHER_COOKIE,
    body: { title: "越权修改已发布作品" },
  });
  expectError("review: 已发布作品非作者修改 403", otherPatchPublished, 403, "FORBIDDEN");
  const otherDeletePublished = await request(`/api/community/posts/${state.posts.theme}`, {
    method: "DELETE",
    cookie: OTHER_COOKIE,
  });
  expectError("review: 已发布作品非作者删除 403", otherDeletePublished, 403, "FORBIDDEN");
  const otherPublishPublished = await request(`/api/community/posts/${state.posts.theme}/publish`, {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { rightsConfirmed: true },
  });
  expectError("review: 已发布作品非作者发布 403", otherPublishPublished, 403, "FORBIDDEN");

  const approveAgain = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "approve" },
  });
  expectError("review: 重复 approve 400", approveAgain, 400, "INVALID_INPUT");

  const rejectTutorial = await request(`/api/community/admin/posts/${state.posts.tutorial}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "reject", note: `${RUN_TAG} 驳回` },
  });
  mustStatus("review: reject 200", rejectTutorial, 200);
  check("review: 教程 rejected", dataOf(rejectTutorial)?.post?.status === "rejected");
  const guestRejectedDetail = await request(`/api/community/posts/${state.posts.tutorial}`);
  expectError("review: rejected 详情访客 404", guestRejectedDetail, 404, "NOT_FOUND");
  const feedRejected = await request("/api/community/feed?tab=latest&limit=48");
  check(
    "review: rejected 不进 feed",
    !(dataOf(feedRejected)?.items || []).some((item) => item.id === state.posts.tutorial),
  );
  const rejectAgain = await request(`/api/community/admin/posts/${state.posts.tutorial}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "reject", note: `${RUN_TAG} 再次驳回` },
  });
  expectStatus("review: 重复 reject 幂等 200", rejectAgain, 200);
  const rejectedQueue = await request("/api/community/admin/queue?status=rejected", { cookie: ADMIN_COOKIE });
  check(
    "review: 驳回队列含教程",
    (dataOf(rejectedQueue)?.items || []).some((item) => item.id === state.posts.tutorial),
  );

  const restoreTutorial = await request(`/api/community/admin/posts/${state.posts.tutorial}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "restore", note: `${RUN_TAG} 恢复` },
  });
  mustStatus("review: restore 200", restoreTutorial, 200);
  check("review: 教程恢复 published", dataOf(restoreTutorial)?.post?.status === "published");
  const guestRestoredDetail = await request(`/api/community/posts/${state.posts.tutorial}`);
  mustStatus("review: rejected 恢复后公开可见 200", guestRestoredDetail, 200);

  const hideTheme = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "hide", note: `${RUN_TAG} 下架` },
  });
  mustStatus("review: hide 200", hideTheme, 200);
  check("review: 主题 hidden", dataOf(hideTheme)?.post?.status === "hidden");
  const guestHiddenDetail = await request(`/api/community/posts/${state.posts.theme}`);
  expectError("review: hidden 详情访客 404", guestHiddenDetail, 404, "NOT_FOUND");
  const hiddenFeed = await request("/api/community/feed?tab=latest&limit=48");
  check(
    "review: hidden 不进 feed",
    !(dataOf(hiddenFeed)?.items || []).some((item) => item.id === state.posts.theme),
  );
  const restoreTheme = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "restore", note: `${RUN_TAG} 恢复上架` },
  });
  mustStatus("review: hidden 恢复 200", restoreTheme, 200);
  check("review: 主题恢复 published", dataOf(restoreTheme)?.post?.status === "published");
  const invalidAction = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "nope" },
  });
  expectError("review: 未知审核动作 400", invalidAction, 400, "INVALID_INPUT");
  const guestReview = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    body: { action: "approve" },
  });
  expectError("review: 访客审核 401", guestReview, 401, "UNAUTHENTICATED");
  const memberReview = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { action: "approve" },
  });
  expectError("review: 普通成员审核 403", memberReview, 403, "FORBIDDEN");

  /* ---------------------- 8) 管理员直发 + 精选 ----------------------------- */
  console.log("[qa-community] 8) 管理员直发与精选");

  const adminTitle = `${RUN_TAG} 管理员直发主题`;
  const directPost = await createPost(ADMIN_COOKIE, {
    type: "theme",
    title: adminTitle,
    description: `${RUN_TAG} 管理员直发描述`,
    category: "dark",
    tags: ["qa", RUN_ID],
    license: "CC-BY-4.0",
    rightsConfirmed: true,
    coverAssetId: state.assets.cover3,
    publish: true,
    manifest: themeManifest({ packageId: themePkgAdmin, version: "1.0.0", name: adminTitle }),
    changelog: "QA 管理员直发",
  });
  mustStatus("admin-direct: 管理员直发 201", directPost, 201);
  check("admin-direct: 直接 published", dataOf(directPost)?.status === "published", JSON.stringify(dataOf(directPost)?.status));
  check("admin-direct: 内容包已写入", dataOf(directPost)?.packageWritten === true);
  trackPost("admin", dataOf(directPost)?.post?.id, adminTitle);
  const guestAdminDetail = await request(`/api/community/posts/${state.posts.admin}`);
  mustStatus("admin-direct: 访客详情 200", guestAdminDetail, 200);

  const feature = await request(`/api/community/admin/posts/${state.posts.admin}/feature`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { featured: true },
  });
  mustStatus("feature: 精选 200", feature, 200);
  check("feature: featured=true", dataOf(feature)?.featured === true);
  const featuredFeed = await request("/api/community/feed?tab=featured&limit=48");
  check(
    "feature: 精选 feed 含管理员作品",
    (dataOf(featuredFeed)?.items || []).some((item) => item.id === state.posts.admin),
  );
  const guestFeature = await request(`/api/community/admin/posts/${state.posts.admin}/feature`, {
    method: "POST",
    body: { featured: true },
  });
  expectError("feature: 访客 401", guestFeature, 401, "UNAUTHENTICATED");
  const featureOff = await request(`/api/community/admin/posts/${state.posts.admin}/feature`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { featured: false },
  });
  expectStatus("feature: 取消精选 200", featureOff, 200);

  /* ---------------------- 9) 公开 feed / search / 详情 / 计数 -------------- */
  console.log("[qa-community] 9) 公开列表、详情与计数");

  const feed = await request("/api/community/feed?tab=latest&limit=48");
  mustStatus("public: feed 200", feed, 200);
  const feedTitles = (dataOf(feed)?.items || []).map((item) => item.title);
  check("public: feed 含主题作品", feedTitles.includes(themeTitle));
  check("public: feed 含教程作品", feedTitles.includes(tutorialTitle));
  check("public: feed 含管理员直发", feedTitles.includes(adminTitle));

  const explore = await request("/api/community/explore?sort=latest");
  mustStatus("public: explore 200", explore, 200);
  check(
    "public: explore 含主题作品",
    (dataOf(explore)?.items || []).some((item) => item.id === state.posts.theme),
  );

  const search = await request(`/api/community/search?q=${encodeURIComponent(RUN_TAG)}`);
  mustStatus("public: search 200", search, 200);
  const searchIds = (dataOf(search)?.items || []).map((item) => item.id);
  check(
    "public: search 命中两件作品",
    searchIds.includes(state.posts.theme) && searchIds.includes(state.posts.tutorial),
    `items=${searchIds.length}`,
  );
  check(
    "public: search 含创作者",
    Array.isArray(dataOf(search)?.creators),
  );

  const creators = await request("/api/community/creators");
  mustStatus("public: creators 200", creators, 200);
  check(
    "public: creators 含 creator 且带关注数",
    (dataOf(creators)?.items || []).some(
      (item) => item.id === CREATOR.id && typeof item.followerCount === "number",
    ),
    JSON.stringify((dataOf(creators)?.items || []).find((item) => item.id === CREATOR.id) || {}).slice(0, 200),
  );

  const detail = await request(`/api/community/posts/${state.posts.theme}`);
  mustStatus("public: 详情 200", detail, 200);
  check("public: 详情 author 正确", dataOf(detail)?.post?.author?.id === CREATOR.id);
  check("public: 详情 status published", dataOf(detail)?.post?.status === "published");
  const download0 = Number(dataOf(detail)?.post?.downloadCount || 0);
  const view0 = Number(dataOf(detail)?.post?.viewCount || 0);
  state.counter.download0 = download0;
  state.counter.view0 = view0;

  const detailAgain = await request(`/api/community/posts/${state.posts.theme}`);
  check(
    "count: 浏览详情不涨 download_count",
    Number(dataOf(detailAgain)?.post?.downloadCount || 0) === download0,
    `${download0} -> ${dataOf(detailAgain)?.post?.downloadCount}`,
  );
  check(
    "count: 浏览详情不涨 view_count（view 单独计数）",
    Number(dataOf(detailAgain)?.post?.viewCount || 0) === view0,
    `${view0} -> ${dataOf(detailAgain)?.post?.viewCount}`,
  );

  const pkgNoCount = await request(`/api/community/posts/${state.posts.theme}/package`);
  mustStatus("package: 下载 200", pkgNoCount, 200);
  const pkgNoCountData = dataOf(pkgNoCount) || {};
  check(
    "package: sha256 与 checksum 一致",
    typeof pkgNoCountData.packageJson === "string" && sha256(pkgNoCountData.packageJson) === pkgNoCountData.checksum,
  );
  let manifestParsed = null;
  try {
    manifestParsed = JSON.parse(pkgNoCountData.packageJson || "{}");
  } catch {
    manifestParsed = null;
  }
  check(
    "package: 内容包 JSON 结构正确且不含可执行字段",
    manifestParsed?.schemaVersion === 1 &&
      manifestParsed?.type === "theme" &&
      manifestParsed?.packageId === themePkgA &&
      !JSON.stringify(manifestParsed || {}).includes('"script"'),
    JSON.stringify(manifestParsed).slice(0, 200),
  );
  const detailAfterNoCount = await request(`/api/community/posts/${state.posts.theme}`);
  check(
    "count: 不传 count 不涨 download_count",
    Number(dataOf(detailAfterNoCount)?.post?.downloadCount || 0) === download0,
    `${download0} -> ${dataOf(detailAfterNoCount)?.post?.downloadCount}`,
  );

  const pkgCount1 = await request(`/api/community/posts/${state.posts.theme}/package?count=1`);
  mustStatus("count: package?count=1 200", pkgCount1, 200);
  const detailCount1 = await request(`/api/community/posts/${state.posts.theme}`);
  check(
    "count: count=1 使 download_count +1",
    Number(dataOf(detailCount1)?.post?.downloadCount || 0) === download0 + 1,
    `${download0} -> ${dataOf(detailCount1)?.post?.downloadCount}`,
  );
  await request(`/api/community/posts/${state.posts.theme}/package?count=1`);
  const detailCount2 = await request(`/api/community/posts/${state.posts.theme}`);
  check(
    "count: 重复 count=1 继续累加（无去重）",
    Number(dataOf(detailCount2)?.post?.downloadCount || 0) === download0 + 2,
    `${download0} -> ${dataOf(detailCount2)?.post?.downloadCount}`,
  );

  const viewRes = await request(`/api/community/posts/${state.posts.theme}/view`, { method: "POST" });
  mustStatus("count: POST view 200", viewRes, 200);
  check("count: view 返回 counted=true", dataOf(viewRes)?.counted === true);
  const detailAfterView = await request(`/api/community/posts/${state.posts.theme}`);
  check(
    "count: view_count 单独 +1 且不影响 download_count",
    Number(dataOf(detailAfterView)?.post?.viewCount || 0) === view0 + 1 &&
      Number(dataOf(detailAfterView)?.post?.downloadCount || 0) === download0 + 2,
    `view=${dataOf(detailAfterView)?.post?.viewCount} download=${dataOf(detailAfterView)?.post?.downloadCount}`,
  );
  const pendingView = await request(`/api/community/posts/${state.posts.theme}/view`, { method: "POST" });
  check("count: published 才计数（重复 view 仍 200）", pendingView.status === 200);

  const mediaPublic = await request(`/api/community/media/${state.assets.cover1}`);
  mustStatus("media: 发布后访客可见 200", mediaPublic, 200);
  check(
    "media: 缓存与安全头",
    String(mediaPublic.headers.get("etag") || "").length > 2 &&
      String(mediaPublic.headers.get("x-content-type-options") || "") === "nosniff",
    `etag=${mediaPublic.headers.get("etag")} nosniff=${mediaPublic.headers.get("x-content-type-options")}`,
  );
  const mediaDownload = await request(`/api/community/media/${state.assets.cover1}?download=1`);
  check(
    "media: download=1 返回附件",
    mediaDownload.status === 200 && /attachment/i.test(String(mediaDownload.headers.get("content-disposition") || "")),
    `${mediaDownload.status} ${mediaDownload.headers.get("content-disposition")}`,
  );
  const mediaMissing = await request(`/api/community/media/00000000-0000-4000-8000-000000000000`);
  expectStatus("media: 不存在资源 404", mediaMissing, 404);

  /* 教程公开与内容包往返（详情转义由前端 renderMarkdown 保证，这里断言 API 只返回 JSON 数据） */
  const tutorialDetail = await request(`/api/community/posts/${state.posts.tutorial}`);
  mustStatus("tutorial: 公开详情 200", tutorialDetail, 200);
  check(
    "tutorial: 详情响应为 JSON 而非 HTML",
    String(tutorialDetail.headers.get("content-type") || "").includes("application/json") &&
      !tutorialDetail.text.includes("<h4>") &&
      !tutorialDetail.text.includes("<script"),
    tutorialDetail.headers.get("content-type"),
  );
  const tutorialPkgRes = await request(`/api/community/posts/${state.posts.tutorial}/package`);
  mustStatus("tutorial: 内容包 200", tutorialPkgRes, 200);
  const tutorialPkgData = dataOf(tutorialPkgRes) || {};
  let tutorialManifestParsed = null;
  try {
    tutorialManifestParsed = JSON.parse(tutorialPkgData.packageJson || "{}");
  } catch {
    tutorialManifestParsed = null;
  }
  check(
    "tutorial: 正文安全往返（Markdown 原样保存）",
    tutorialManifestParsed?.type === "tutorial" &&
      tutorialManifestParsed?.configuration?.content === tutorialContentSafe &&
      sha256(tutorialPkgData.packageJson || "") === tutorialPkgData.checksum,
  );
  check(
    "tutorial: 内容包不含未转义 <script>",
    !JSON.stringify(tutorialManifestParsed || {}).includes("<script"),
  );
  // 前端渲染层静态守卫（真实转义由 renderMarkdown 单测覆盖）
  const coreSource = readFileSync(join(ROOT, "src", "lib", "os14", "core.ts"), "utf8");
  check(
    "tutorial: renderMarkdown 先整体转义",
    coreSource.includes("export const renderMarkdown") && coreSource.includes("let s = escapeHtml(text)"),
  );
  const communitySource = readFileSync(join(ROOT, "src", "lib", "os14", "community.ts"), "utf8");
  check(
    "tutorial: 详情正文经 renderMarkdown 渲染",
    /renderMarkdown\(String\(\(manifest\.configuration as Record<string, unknown>\)\?\.content/.test(communitySource),
  );

  /* ---------------------- 10) 版本链 --------------------------------------- */
  console.log("[qa-community] 10) 版本链与历史内容包");

  const versionUp = await request(`/api/community/posts/${state.posts.theme}/versions`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: {
      manifest: themeManifest({ packageId: themePkgA, version: "1.1.0", name: themeTitle }),
      changelog: `${RUN_TAG} 升级 1.1.0`,
      rightsConfirmed: true,
    },
  });
  mustStatus("version: 创建 1.1.0 200", versionUp, 200);
  check("version: 成员升级进入 pending_review", dataOf(versionUp)?.post?.status === "pending_review", JSON.stringify(dataOf(versionUp)?.post?.status));
  const guestPendingVersion = await request(`/api/community/posts/${state.posts.theme}`);
  expectError("version: 升级待审期间访客 404", guestPendingVersion, 404, "NOT_FOUND");
  const approveVersion = await request(`/api/community/admin/posts/${state.posts.theme}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "approve", note: `${RUN_TAG} 批准 1.1.0` },
  });
  mustStatus("version: approve 1.1.0 200", approveVersion, 200);
  check("version: 作品版本 1.1.0", dataOf(approveVersion)?.post?.version === "1.1.0");
  const publicDetail = await request(`/api/community/posts/${state.posts.theme}`);
  check("version: 公开详情版本 1.1.0", dataOf(publicDetail)?.post?.version === "1.1.0");
  const versions = await request(`/api/community/posts/${state.posts.theme}/versions`);
  mustStatus("version: 历史版本列表 200", versions, 200);
  check(
    "version: 历史版本 2 个",
    Array.isArray(dataOf(versions)?.versions) && dataOf(versions)?.versions?.length === 2,
    JSON.stringify((dataOf(versions)?.versions || []).map((item) => item.version)),
  );
  const oldPkg = await request(`/api/community/posts/${state.posts.theme}/package?version=1.0.0`);
  mustStatus("version: 旧版本 1.0.0 可下载", oldPkg, 200);
  check("version: 旧包版本正确", dataOf(oldPkg)?.version === "1.0.0");
  const versionLower = await request(`/api/community/posts/${state.posts.theme}/versions`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: {
      manifest: themeManifest({ packageId: themePkgA, version: "1.0.0", name: themeTitle }),
      changelog: `${RUN_TAG} 版本回退`,
      rightsConfirmed: true,
    },
  });
  expectError("version: 版本回退拒绝 409", versionLower, 409, "VERSION_NOT_INCREASED");

  /* ---------------------- 11) 互动 / 通知 / 关注 --------------------------- */
  console.log("[qa-community] 11) 互动、通知与关注");

  const like = await request(`/api/community/posts/${state.posts.theme}/like`, { method: "POST", cookie: OTHER_COOKIE });
  mustStatus("interact: 点赞 200", like, 200);
  check("interact: 点赞计数 1", dataOf(like)?.liked === true && Number(dataOf(like)?.likeCount) >= 1);
  const likeAgain = await request(`/api/community/posts/${state.posts.theme}/like`, { method: "POST", cookie: OTHER_COOKIE });
  check("interact: 重复点赞不重复计数", Number(dataOf(likeAgain)?.likeCount) === Number(dataOf(like)?.likeCount));
  const selfLike = await request(`/api/community/posts/${state.posts.theme}/like`, { method: "POST", cookie: CREATOR_COOKIE });
  expectError("interact: 不能点赞自己的作品 400", selfLike, 400, "INVALID_INPUT");
  const guestLike = await request(`/api/community/posts/${state.posts.theme}/like`, { method: "POST" });
  expectStatus("interact: 访客点赞 401", guestLike, 401);
  const unlike = await request(`/api/community/posts/${state.posts.theme}/like`, { method: "DELETE", cookie: OTHER_COOKIE });
  mustStatus("interact: 取消点赞 200", unlike, 200);

  const favorite = await request(`/api/community/posts/${state.posts.theme}/favorite`, {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { collection: "default" },
  });
  mustStatus("interact: 收藏 200", favorite, 200);
  check("interact: 收藏成功", dataOf(favorite)?.favorited === true);
  await request(`/api/community/posts/${state.posts.theme}/favorite`, { method: "POST", cookie: OTHER_COOKIE });
  const favorites = await request("/api/community/me/favorites?collection=default", { cookie: OTHER_COOKIE });
  mustStatus("interact: 我的收藏 200", favorites, 200);
  check(
    "interact: 收藏列表含作品",
    (dataOf(favorites)?.items || []).some((item) => item.id === state.posts.theme),
  );
  const collections = await request("/api/community/me/favorite-collections", { cookie: OTHER_COOKIE });
  check(
    "interact: 收藏夹集合含 default",
    (dataOf(collections)?.collections || []).some((entry) => entry.name === "default"),
  );
  const unfavorite = await request(`/api/community/posts/${state.posts.theme}/favorite`, { method: "DELETE", cookie: OTHER_COOKIE });
  mustStatus("interact: 取消收藏 200", unfavorite, 200);

  const comment = await request(`/api/community/posts/${state.posts.theme}/comments`, {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { content: `${RUN_TAG} 评论内容` },
  });
  mustStatus("interact: 评论 201", comment, 201);
  const commentId = dataOf(comment)?.comment?.id;
  state.comments.root = commentId;
  check("interact: 评论 id 返回", UUID_RE.test(String(commentId || "")));
  const reply = await request(`/api/community/posts/${state.posts.theme}/comments`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { content: `${RUN_TAG} 作者回复`, parentId: commentId },
  });
  mustStatus("interact: 回复评论 201", reply, 201);
  state.comments.reply = dataOf(reply)?.comment?.id;
  const commentList = await request(`/api/community/posts/${state.posts.theme}/comments`);
  mustStatus("interact: 评论列表 200", commentList, 200);
  const rootComment = (dataOf(commentList)?.items || []).find((item) => item.id === commentId);
  check(
    "interact: 评论两级结构",
    rootComment && Array.isArray(rootComment.replies) && rootComment.replies.length === 1,
    JSON.stringify(rootComment?.replies?.length),
  );

  // 关注链路只对 UUID 创作者有效（followCreator 强校验 UUID；本地 QA 身份是 qa-* 字符串 id）。
  // 本地库若有其他演示/QA 的 UUID 创作者则覆盖正向链路，否则如实跳过并在汇总中标注。
  const creatorsForFollow = await request("/api/community/creators");
  mustStatus("interact: 创作者列表 200", creatorsForFollow, 200);
  const followTarget = (dataOf(creatorsForFollow)?.items || []).find(
    (item) => UUID_RE.test(String(item.id || "")) && item.id !== CREATOR.id && item.id !== OTHER.id,
  );
  if (followTarget) {
    const follow = await request(`/api/community/creators/${followTarget.id}/follow`, {
      method: "POST",
      cookie: OTHER_COOKIE,
    });
    mustStatus("interact: 关注创作者 200", follow, 200);
    check("interact: following=true", dataOf(follow)?.following === true);
    check("interact: 关注数返回 number", typeof dataOf(follow)?.followerCount === "number");
    const followingFeed = await request("/api/community/me/following", { cookie: OTHER_COOKIE });
    mustStatus("interact: 关注动态 200", followingFeed, 200);
    check(
      "interact: 关注动态含被关注创作者作品",
      (dataOf(followingFeed)?.items || []).some((item) => item.author?.id === followTarget.id),
    );
    const unfollow = await request(`/api/community/creators/${followTarget.id}/follow`, {
      method: "DELETE",
      cookie: OTHER_COOKIE,
    });
    mustStatus("interact: 取消关注 200", unfollow, 200);
  } else {
    skip(
      "interact: 关注/关注动态链路",
      "本地无 UUID 创作者夹具（qa-* 身份不能作为关注目标，followCreator 强制 UUID）",
    );
  }
  const notifications = await request("/api/community/me/notifications", { cookie: CREATOR_COOKIE });
  mustStatus("interact: 通知列表 200", notifications, 200);
  check("interact: 有未读通知", Number(dataOf(notifications)?.unread || 0) > 0, JSON.stringify(dataOf(notifications)?.unread));
  const markRead = await request("/api/community/me/notifications", {
    method: "PATCH",
    cookie: CREATOR_COOKIE,
    body: { all: true },
  });
  mustStatus("interact: 全部已读 200", markRead, 200);
  check("interact: 已读后 unread=0", Number(dataOf(markRead)?.unread || 0) === 0);
  const myProfile = await request("/api/community/me/profile", { cookie: CREATOR_COOKIE });
  mustStatus("interact: 我的社区资料 200", myProfile, 200);
  check("interact: 资料统计 posts>=2", Number(dataOf(myProfile)?.stats?.posts || 0) >= 2);
  const unfollow = await request(`/api/community/creators/${CREATOR.id}/follow`, { method: "DELETE", cookie: OTHER_COOKIE });
  mustStatus("interact: 取消关注 200", unfollow, 200);

  /* ---------------------- 12) 举报闭环 ------------------------------------- */
  console.log("[qa-community] 12) 举报与审核处理");

  const report1 = await request("/api/community/reports", {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { targetType: "post", targetId: state.posts.theme, reason: "inappropriate", description: `${RUN_TAG} 举报主题` },
  });
  mustStatus("report: 举报主题 201", report1, 201);
  check("report: 首次举报成功", dataOf(report1)?.reported === true);
  const report1Dup = await request("/api/community/reports", {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { targetType: "post", targetId: state.posts.theme, reason: "spam" },
  });
  expectError("report: 重复举报 409", report1Dup, 409, "ALREADY_REPORTED");
  const selfReport = await request("/api/community/reports", {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { targetType: "post", targetId: state.posts.theme, reason: "spam" },
  });
  expectError("report: 举报自己作品 400", selfReport, 400, "INVALID_INPUT");
  const report2 = await request("/api/community/reports", {
    method: "POST",
    cookie: OTHER_COOKIE,
    body: { targetType: "post", targetId: state.posts.tutorial, reason: "spam", description: `${RUN_TAG} 举报教程` },
  });
  mustStatus("report: 举报教程 201", report2, 201);
  const report3 = await request("/api/community/reports", {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { targetType: "post", targetId: state.posts.tutorial, reason: "harassment", description: `${RUN_TAG} 管理员举报` },
  });
  mustStatus("report: 管理员举报 201", report3, 201);

  const guestReports = await request("/api/community/admin/reports");
  expectError("report: 访客看队列 401", guestReports, 401, "UNAUTHENTICATED");
  const memberReports = await request("/api/community/admin/reports", { cookie: CREATOR_COOKIE });
  expectError("report: 成员看队列 403", memberReports, 403, "FORBIDDEN");

  const openReports = await request("/api/community/admin/reports?status=open", { cookie: ADMIN_COOKIE });
  mustStatus("report: 举报队列 200", openReports, 200);
  const openItems = dataOf(openReports)?.items || [];
  const findReport = (targetId, reporterId) =>
    openItems.find((item) => item.targetId === targetId && item.reporterId === reporterId);
  const r1 = findReport(state.posts.theme, OTHER.id);
  const r2 = findReport(state.posts.tutorial, OTHER.id);
  const r3 = findReport(state.posts.tutorial, state.adminId);
  check(
    "report: 队列含三笔举报",
    Boolean(r1?.id && r2?.id && r3?.id),
    JSON.stringify({ r1: r1?.id, r2: r2?.id, r3: r3?.id }),
  );
  state.reports.r1 = r1?.id;
  state.reports.r2 = r2?.id;
  state.reports.r3 = r3?.id;

  const dismiss = await request(`/api/community/admin/reports/${r1.id}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "dismiss", resolution: `${RUN_TAG} 未违规` },
  });
  mustStatus("report: dismiss 200", dismiss, 200);
  const dismissed = await request("/api/community/admin/reports?status=dismissed", { cookie: ADMIN_COOKIE });
  check(
    "report: 驳回队列含举报",
    (dataOf(dismissed)?.items || []).some((item) => item.id === r1.id),
  );
  const dismissAgain = await request(`/api/community/admin/reports/${r1.id}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "dismiss" },
  });
  expectStatus("report: 重复 dismiss 幂等 200", dismissAgain, 200);

  const hidePost = await request(`/api/community/admin/reports/${r2.id}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "hide_post", resolution: `${RUN_TAG} 下架教程` },
  });
  mustStatus("report: hide_post 200", hidePost, 200);
  const guestTutorialHidden = await request(`/api/community/posts/${state.posts.tutorial}`);
  expectError("report: hide_post 后访客 404", guestTutorialHidden, 404, "NOT_FOUND");
  const resolved = await request("/api/community/admin/reports?status=resolved", { cookie: ADMIN_COOKIE });
  check(
    "report: hide_post 举报 resolved",
    (dataOf(resolved)?.items || []).some((item) => item.id === r2.id),
  );
  const restoreTutorial2 = await request(`/api/community/admin/posts/${state.posts.tutorial}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "restore", note: `${RUN_TAG} 恢复教程` },
  });
  mustStatus("report: 恢复被下架教程 200", restoreTutorial2, 200);

  const removePost = await request(`/api/community/admin/reports/${r3.id}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "delete_post", resolution: `${RUN_TAG} 删除作品` },
  });
  mustStatus("report: delete_post 200", removePost, 200);
  const guestTutorialDeleted = await request(`/api/community/posts/${state.posts.tutorial}`);
  expectError("report: delete_post 后访客 404", guestTutorialDeleted, 404, "NOT_FOUND");
  const feedAfterDelete = await request("/api/community/feed?tab=latest&limit=48");
  check(
    "report: 删除后公开 feed 不可见",
    !(dataOf(feedAfterDelete)?.items || []).some((item) => item.id === state.posts.tutorial),
  );
  const reportMissing = await request(`/api/community/admin/reports/00000000-0000-4000-8000-000000000000/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "dismiss" },
  });
  expectStatus("report: 处理不存在举报 404", reportMissing, 404);
  const memberProcess = await request(`/api/community/admin/reports/${r1.id}/review`, {
    method: "POST",
    cookie: CREATOR_COOKIE,
    body: { action: "dismiss" },
  });
  expectError("report: 成员处理举报 403", memberProcess, 403, "FORBIDDEN");

  /* ---------------------- 13) 审计 / 设置 / 统计 / 邀请码 ------------------ */
  console.log("[qa-community] 13) 审计、设置、统计与邀请码");

  const settings = await request("/api/community/admin/settings", { cookie: ADMIN_COOKIE });
  mustStatus("settings: 管理员读取 200", settings, 200);
  check("settings: requireReview 为 boolean", typeof dataOf(settings)?.raw?.requireReview === "boolean");
  const memberSettings = await request("/api/community/admin/settings", { cookie: CREATOR_COOKIE });
  expectError("settings: 成员 403", memberSettings, 403, "FORBIDDEN");

  const stats = await request("/api/community/admin/stats", { cookie: ADMIN_COOKIE });
  mustStatus("stats: 200", stats, 200);
  check("stats: storageBytes 为数字", typeof dataOf(stats)?.stats?.storageBytes === "number");
  check("stats: pendingReview 为数字", typeof dataOf(stats)?.stats?.pendingReview === "number");

  const userList = await request("/api/community/admin/users", { cookie: ADMIN_COOKIE });
  mustStatus("admin/users: 200", userList, 200);
  check("admin/users: 列表为数组", Array.isArray(dataOf(userList)?.items));

  const inviteCreate = await request("/api/community/admin/invites", {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { label: `${RUN_TAG} 邀请`, maxUses: 1 },
  });
  mustStatus("invite: 创建 201", inviteCreate, 201);
  const inviteCode = String(dataOf(inviteCreate)?.code || "");
  check("invite: 邀请码 GD- 前缀", /^GD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(inviteCode), inviteCode.slice(0, 16));
  const inviteList = await request("/api/community/admin/invites", { cookie: ADMIN_COOKIE });
  mustStatus("invite: 列表 200", inviteList, 200);
  const inviteItem = (dataOf(inviteList)?.items || []).find((item) => item.label === `${RUN_TAG} 邀请`);
  check("invite: 列表按前缀显示且不回传明文", Boolean(inviteItem) && !JSON.stringify(inviteItem).includes(inviteCode));
  if (inviteItem?.id) state.invite = { id: inviteItem.id, prefix: String(inviteItem.prefix || inviteCode.slice(0, 8)) };
  else state.invite = { id: null, prefix: inviteCode.slice(0, 8) };

  /* ---------------------- 14) 管理员删除 + 404 ---------------------------- */
  console.log("[qa-community] 14) 管理员删除与幂等");

  const deleteAdminPost = await request(`/api/community/admin/posts/${state.posts.admin}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "delete", note: `${RUN_TAG} 删除管理员作品` },
  });
  mustStatus("admin-delete: review delete 200", deleteAdminPost, 200);
  check("admin-delete: 状态 deleted", dataOf(deleteAdminPost)?.post?.status === "deleted");
  const guestDeletedAdmin = await request(`/api/community/posts/${state.posts.admin}`);
  expectError("admin-delete: 访客详情 404", guestDeletedAdmin, 404, "NOT_FOUND");
  const deleteAgain = await request(`/api/community/admin/posts/${state.posts.admin}/review`, {
    method: "POST",
    cookie: ADMIN_COOKIE,
    body: { action: "delete" },
  });
  expectStatus("admin-delete: 重复删除 404", deleteAgain, 404);

  // 审计断言放在所有审核/举报/精选/邀请动作完成之后拉取，避免顺序依赖。
  const audit = await request("/api/community/admin/audit?limit=80", { cookie: ADMIN_COOKIE });
  mustStatus("audit: 审计列表 200", audit, 200);
  const auditItems = dataOf(audit)?.items || [];
  const auditHas = (action, targetId) =>
    auditItems.some((item) => item.action === action && item.targetId === targetId);
  check("audit: post.approve 记录", auditHas("post.approve", state.posts.theme));
  check("audit: post.reject 记录", auditHas("post.reject", state.posts.tutorial));
  check("audit: post.hide 记录", auditHas("post.hide", state.posts.theme));
  check("audit: report.dismiss 记录", auditHas("report.dismiss", r1.id));
  check("audit: report.hide_post 记录", auditHas("report.hide_post", r2.id));
  check("audit: report.delete_post 记录", auditHas("report.delete_post", r3.id));
  check("audit: post.feature 记录", auditHas("post.feature", state.posts.admin));
  check("audit: post.delete_moderator 记录", auditHas("post.delete_moderator", state.posts.admin));
  check(
    "audit: invite.create 记录（prefix）",
    state.invite ? auditHas("invite.create", state.invite.prefix) : false,
    JSON.stringify(state.invite),
  );
  const guestAudit = await request("/api/community/admin/audit");
  expectError("audit: 访客 401", guestAudit, 401, "UNAUTHENTICATED");
  const memberAudit = await request("/api/community/admin/audit", { cookie: CREATOR_COOKIE });
  expectError("audit: 成员 403", memberAudit, 403, "FORBIDDEN");
}

/* ============================================================================
 * 清理：qa-cleanup 四重校验 + scheduled 维护清 R2 + SQL 复核残留 0
 * ========================================================================== */

async function cleanupRun() {
  console.log("\n[cleanup] ===== 清理本轮社区数据（固定身份保留，仅删 RUN_ID 归属内容） =====");
  const postIds = Object.values(state.posts).filter(Boolean);
  const assetIds = Object.values(state.assets).filter(Boolean);
  const users = [CREATOR.id, OTHER.id];
  const usersIn = inList(users);
  const postsIn = inList(postIds);
  const assetsIn = inList(assetIds);
  const now = Date.now();

  const checkSoftDelete = (key, result) => {
    check(`cleanup: HTTP 软删 ${key}`, result.status === 200 || result.status === 404, `status=${result.status}`);
  };
  for (const [key, postId] of Object.entries(state.posts)) {
    if (!postId) continue;
    checkSoftDelete(key, await request(`/api/community/posts/${postId}`, { method: "DELETE", cookie: ADMIN_COOKIE }));
  }

  // 1) 归属复核：作品只允许是本次 RUN_ID + QA 三个身份之一
  if (postIds.length) {
    const postRows = d1Rows(
      `SELECT id, author_id, title, status FROM community_posts WHERE id IN (${postsIn})`,
    );
    const allowedAuthors = new Set([CREATOR.id, OTHER.id, state.adminId]);
    const badPost = postRows.find(
      (row) => !allowedAuthors.has(row.author_id) || !String(row.title || "").includes(RUN_ID),
    );
    check(
      "cleanup: 作品归属复核（RUN_ID + QA 作者）",
      postRows.length === postIds.length && !badPost,
      badPost ? JSON.stringify(badPost) : `rows=${postRows.length}/${postIds.length}`,
    );
    if (postRows.length !== postIds.length || badPost) throw new Error("作品归属复核失败，停止清理");
  }

  if (assetIds.length) {
    const assetRows = d1Rows(`SELECT id, user_id, post_id FROM community_assets WHERE id IN (${assetsIn})`);
    const allowedUsers = new Set([CREATOR.id, OTHER.id, state.adminId]);
    const allowedPosts = new Set(postIds);
    const badAsset = assetRows.find(
      (row) => !allowedUsers.has(row.user_id) || (row.post_id && !allowedPosts.has(row.post_id)),
    );
    check(
      "cleanup: 资源归属复核（QA 用户 + 本次作品）",
      assetRows.length === assetIds.length && !badAsset,
      badAsset ? JSON.stringify(badAsset) : `rows=${assetRows.length}/${assetIds.length}`,
    );
    if (assetRows.length !== assetIds.length || badAsset) throw new Error("资源归属复核失败，停止清理");
  }

  const packageIds = postIds.length
    ? d1Rows(`SELECT id FROM community_packages WHERE post_id IN (${postsIn})`).map((row) => row.id)
    : [];
  const reportIds = d1Rows(
    `SELECT id FROM community_reports WHERE target_id IN (${postsIn}) OR reporter_id IN (${usersIn})`,
  ).map((row) => row.id);

  // 2) 标记资产/内容包待清理，然后触发 scheduled 维护任务删除 R2 对象
  const markStatements = [];
  if (assetIds.length) {
    markStatements.push(
      `UPDATE community_assets SET status = 'deleting', post_id = NULL, delete_attempts = 0
       WHERE id IN (${assetsIn}) AND status IN ('ready', 'deleting')`,
    );
  }
  if (packageIds.length) {
    markStatements.push(
      `UPDATE community_packages SET status = 'deleted', delete_attempts = 0, updated_at = ${now}
       WHERE id IN (${inList(packageIds)}) AND status = 'active'`,
    );
  }
  if (markStatements.length) d1Write(markStatements);

  const scheduled = await request(
    `/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`,
    { method: "POST", origin: null },
  );
  check("cleanup: 触发 scheduled 维护任务", scheduled.status === 200, `status=${scheduled.status} body=${scheduled.text.slice(0, 120)}`);

  const packageIdsIn = inList(packageIds);
  let pending = { assets: assetIds.length, packageKeys: packageIds.length, versionKeys: packageIds.length };
  let triggered = 1;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    pending = {
      assets: assetIds.length
        ? d1Count(`SELECT COUNT(*) AS n FROM community_assets WHERE id IN (${assetsIn}) AND status <> 'deleted'`)
        : 0,
      packageKeys: packageIds.length
        ? d1Count(
            `SELECT COUNT(*) AS n FROM community_packages WHERE id IN (${packageIdsIn}) AND (manifest_object_key <> '' OR package_object_key <> '')`,
          )
        : 0,
      versionKeys: packageIds.length
        ? d1Count(
            `SELECT COUNT(*) AS n FROM package_versions WHERE package_id IN (${packageIdsIn}) AND (manifest_object_key <> '' OR package_object_key <> '')`,
          )
        : 0,
    };
    if (pending.assets === 0 && pending.packageKeys === 0 && pending.versionKeys === 0) break;
    await sleep(500);
    if (triggered < 3 && Date.now() + 8000 > deadline - 20000 + triggered * 4000) {
      await request(`/__scheduled?cron=${encodeURIComponent("*/15 * * * *")}`, { method: "POST", origin: null });
      triggered += 1;
    }
  }
  state.cleanup.r2Verified = pending.assets === 0 && pending.packageKeys === 0 && pending.versionKeys === 0;
  check(
    "cleanup: scheduled 已清理 R2（资产删除 + 对象 key 清空）",
    state.cleanup.r2Verified,
    JSON.stringify(pending),
  );
  if (!state.cleanup.r2Verified) throw new Error("R2 对象清理未完成，保留 D1 行以便排查（不退化删除）");

  // 3) qa-cleanup 四重身份校验 + 关联资源上限
  for (const user of [CREATOR, OTHER]) {
    try {
      const rows = d1Rows(
        `SELECT id, email, github_username, created_at FROM users WHERE id = ${sqlQuote(user.id)} AND email = ${sqlQuote(user.email)}`,
      );
      assertQaCleanupTarget({
        enabled: true,
        marker: MARKER,
        expectedMarker: MARKER,
        runId: RUN_ID,
        expectedRunId: RUN_ID,
        userId: user.id,
        email: user.email,
        expectedUserId: user.id,
        expectedEmail: user.email,
        rows,
        expectedUsername: user.id,
      });
      check(`cleanup: ${user.id} 四重身份校验`, true);
    } catch (error) {
      check(`cleanup: ${user.id} 四重身份校验`, false, error.message);
      throw error;
    }
    try {
      const counts = {
        posts: d1Count(`SELECT COUNT(*) AS n FROM community_posts WHERE author_id = ${sqlQuote(user.id)}`),
        assets: d1Count(`SELECT COUNT(*) AS n FROM community_assets WHERE user_id = ${sqlQuote(user.id)}`),
        packages: d1Count(`SELECT COUNT(*) AS n FROM community_packages WHERE author_id = ${sqlQuote(user.id)}`),
        comments: d1Count(`SELECT COUNT(*) AS n FROM community_comments WHERE user_id = ${sqlQuote(user.id)}`),
        likes: d1Count(`SELECT COUNT(*) AS n FROM community_likes WHERE user_id = ${sqlQuote(user.id)}`),
        favorites: d1Count(`SELECT COUNT(*) AS n FROM community_favorites WHERE user_id = ${sqlQuote(user.id)}`),
        reports: d1Count(`SELECT COUNT(*) AS n FROM community_reports WHERE reporter_id = ${sqlQuote(user.id)}`),
        notifications: d1Count(`SELECT COUNT(*) AS n FROM community_notifications WHERE user_id = ${sqlQuote(user.id)}`),
        follows: d1Count(
          `SELECT COUNT(*) AS n FROM community_follows WHERE follower_id = ${sqlQuote(user.id)} OR following_id = ${sqlQuote(user.id)}`,
        ),
        audit: d1Count(`SELECT COUNT(*) AS n FROM community_audit_logs WHERE actor_id = ${sqlQuote(user.id)}`),
      };
      assertCleanupResourceCounts(counts);
      check(`cleanup: ${user.id} 关联资源计数合法`, true);
    } catch (error) {
      check(`cleanup: ${user.id} 关联资源计数合法`, false, error.message);
      throw error;
    }
  }
  state.cleanup.identityVerified = true;

  // 4) 严格 WHERE 删除（复用 qa-cleanup 白名单 SQL；其余按本次 post/report/audit 归属）
  const statements = [];
  for (const user of users) {
    for (const table of [
      "community_notifications",
      "community_comments",
      "community_likes",
      "community_favorites",
      "community_assets",
      "community_roles",
      "community_profiles",
    ]) {
      statements.push(buildQaChildDeleteSql(table, user));
    }
  }
  if (postIds.length) {
    statements.push(
      `DELETE FROM community_notifications WHERE post_id IN (${postsIn})`,
      // 关注/评论通知的接收者可能是第三方 UUID 账号，按 actor（QA 身份）归属删除，避免污染他人通知。
      `DELETE FROM community_notifications WHERE actor_id IN (${usersIn})`,
      `DELETE FROM community_comments WHERE post_id IN (${postsIn})`,
      `DELETE FROM community_likes WHERE post_id IN (${postsIn})`,
      `DELETE FROM community_favorites WHERE post_id IN (${postsIn})`,
      `DELETE FROM community_view_daily WHERE post_id IN (${postsIn})`,
    );
  } else {
    statements.push(`DELETE FROM community_notifications WHERE actor_id IN (${usersIn})`);
  }
  // 上传资源按本次登记的 asset id 删除（admin 直发封面的 user 不在 QA 两个身份内）。
  statements.push(`DELETE FROM community_assets WHERE id IN (${assetsIn})`);
  statements.push(
    `DELETE FROM community_reports WHERE target_id IN (${postsIn}) OR reporter_id IN (${usersIn})`,
  );
  if (reportIds.length) {
    const reportIdsIn = inList(reportIds);
    statements.push(
      `DELETE FROM community_audit_logs WHERE target_type = 'report' AND target_id IN (${reportIdsIn})`,
    );
  }
  statements.push(
    `DELETE FROM community_audit_logs
      WHERE (target_type = 'post' AND target_id IN (${postsIn}))
         OR (target_type = 'user' AND target_id IN (${usersIn}))
         OR (target_type = 'invite' AND target_id IN (${state.invite?.prefix ? sqlQuote(state.invite.prefix) : "NULL"}))`,
    `DELETE FROM community_audit_logs WHERE actor_id IN (${usersIn})`,
  );
  if (packageIds.length) {
    statements.push(`DELETE FROM package_versions WHERE package_id IN (${packageIdsIn})`);
  }
  statements.push(
    `DELETE FROM community_packages WHERE post_id IN (${postsIn}) OR author_id IN (${usersIn})`,
  );
  statements.push(
    `DELETE FROM community_posts WHERE id IN (${postsIn}) AND author_id IN (${inList([...users, state.adminId])}) AND title LIKE ${sqlQuote(`%${RUN_ID}%`)}`,
    // 兜底：若某个测试请求产生了未登记到 state 的 RUN_ID 作品（例如断言前中止），同样按标题归属清掉。
    `DELETE FROM community_posts WHERE author_id IN (${inList([...users, state.adminId])}) AND title LIKE ${sqlQuote(`%${RUN_ID}%`)}`,
    `DELETE FROM community_follows WHERE follower_id IN (${usersIn}) OR following_id IN (${usersIn})`,
  );
  const inviteIds = state.invite?.id ? [state.invite.id] : [];
  if (inviteIds.length) {
    statements.push(
      `DELETE FROM community_join_intents WHERE invite_id IN (${inList(inviteIds)})`,
      `DELETE FROM community_invites WHERE id IN (${inList(inviteIds)})`,
    );
  } else if (state.invite?.prefix) {
    statements.push(
      `DELETE FROM community_invites WHERE created_by = ${sqlQuote(state.adminId)} AND code_prefix = ${sqlQuote(state.invite.prefix)}`,
    );
  }
  if (statements.length) d1Write(statements);

  // 5) SQL 残留复核（全部必须为 0；账号夹具保留）
  const residue = {
    posts: d1Count(
      `SELECT COUNT(*) AS n FROM community_posts
        WHERE id IN (${postsIn})
           OR (author_id IN (${inList([...users, state.adminId])}) AND title LIKE ${sqlQuote(`%${RUN_ID}%`)})`,
    ),
    packages: d1Count(
      `SELECT COUNT(*) AS n FROM community_packages WHERE post_id IN (${postsIn}) OR author_id IN (${usersIn})`,
    ),
    versions: packageIds.length
      ? d1Count(`SELECT COUNT(*) AS n FROM package_versions WHERE package_id IN (${packageIdsIn})`)
      : 0,
    assets: d1Count(`SELECT COUNT(*) AS n FROM community_assets WHERE id IN (${assetsIn}) OR user_id IN (${usersIn})`),
    reports: d1Count(
      `SELECT COUNT(*) AS n FROM community_reports WHERE target_id IN (${postsIn}) OR reporter_id IN (${usersIn})`,
    ),
    comments: d1Count(
      `SELECT COUNT(*) AS n FROM community_comments WHERE post_id IN (${postsIn}) OR user_id IN (${usersIn})`,
    ),
    likes: d1Count(
      `SELECT COUNT(*) AS n FROM community_likes WHERE post_id IN (${postsIn}) OR user_id IN (${usersIn})`,
    ),
    favorites: d1Count(
      `SELECT COUNT(*) AS n FROM community_favorites WHERE post_id IN (${postsIn}) OR user_id IN (${usersIn})`,
    ),
    views: d1Count(`SELECT COUNT(*) AS n FROM community_view_daily WHERE post_id IN (${postsIn})`),
    notifications: d1Count(
      `SELECT COUNT(*) AS n FROM community_notifications WHERE post_id IN (${postsIn}) OR user_id IN (${usersIn}) OR actor_id IN (${usersIn})`,
    ),
    follows: d1Count(
      `SELECT COUNT(*) AS n FROM community_follows WHERE follower_id IN (${usersIn}) OR following_id IN (${usersIn})`,
    ),
    roles: d1Count(`SELECT COUNT(*) AS n FROM community_roles WHERE user_id IN (${usersIn})`),
    profiles: d1Count(`SELECT COUNT(*) AS n FROM community_profiles WHERE user_id IN (${usersIn})`),
    audit: d1Count(
      `SELECT COUNT(*) AS n FROM community_audit_logs
        WHERE (target_type = 'post' AND target_id IN (${postsIn}))
           OR (target_type = 'report' AND target_id IN (${inList(reportIds)}))
           OR (target_type = 'user' AND target_id IN (${usersIn}))
           OR (target_type = 'invite' AND target_id IN (${state.invite?.prefix ? sqlQuote(state.invite.prefix) : "NULL"}))
           OR actor_id IN (${usersIn})`,
    ),
    invites: inviteIds.length ? d1Count(`SELECT COUNT(*) AS n FROM community_invites WHERE id IN (${inList(inviteIds)})`) : 0,
    joinIntents: inviteIds.length
      ? d1Count(`SELECT COUNT(*) AS n FROM community_join_intents WHERE invite_id IN (${inList(inviteIds)})`)
      : 0,
    inviteAuditByPrefix: state.invite?.prefix
      ? d1Count(
          `SELECT COUNT(*) AS n FROM community_audit_logs WHERE target_type = 'invite' AND target_id = ${sqlQuote(state.invite.prefix)}`,
        )
      : 0,
  };
  let residueFailures = 0;
  for (const [label, count] of Object.entries(residue)) {
    try {
      assertDeleteCount(count, 0, `community ${label}`);
      check(`cleanup: 残留复核 ${label}=0`, true);
    } catch (error) {
      residueFailures += 1;
      check(`cleanup: 残留复核 ${label}=0`, false, error.message);
    }
  }
  const fixturesRemaining = d1Count(`SELECT COUNT(*) AS n FROM users WHERE id IN (${usersIn})`);
  check("cleanup: 固定 QA 账号保留（2）", fixturesRemaining === 2, `remaining=${fixturesRemaining}`);
  state.cleanup.residueVerified = residueFailures === 0;
  if (residueFailures > 0) throw new Error(`清扫后仍有 ${residueFailures} 项残留，见上方失败项`);
}

/* ============================================================================
 * 入口
 * ========================================================================== */

function printSummary() {
  const total = results.length;
  const passed = results.filter((item) => item.ok).length;
  const failed = total - passed;
  const seconds = ((Date.now() - STARTED_AT) / 1000).toFixed(1);
  console.log("\n================ QA-C 结果 ================");
  if (failed > 0) {
    console.log("[failed checks]");
    for (const item of results) {
      if (!item.ok) console.log(`  FAIL ${item.name}${item.detail ? `  ${item.detail}` : ""}`);
    }
  }
  if (skipped.length) {
    console.log("[skipped checks]");
    for (const item of skipped) console.log(`  SKIP ${item.name}${item.reason ? `  ${item.reason}` : ""}`);
  }
  console.log(`RUN_ID=${RUN_ID}`);
  console.log(`项数=${total} 通过=${passed} 失败=${failed} 跳过=${skipped.length} 耗时=${seconds}s`);
  console.log(`清理: R2=${state.cleanup.r2Verified ? "OK" : "NOT-RUN"} 身份=${state.cleanup.identityVerified ? "OK" : "NOT-RUN"} 残留=${state.cleanup.residueVerified ? "0" : "FAIL"}`);
  console.log("==========================================");
  return failed;
}

async function main() {
  let fatal = null;
  try {
    await runTests();
  } catch (error) {
    fatal = error;
    check("主测试流程未抛错", false, error?.message || String(error));
  } finally {
    try {
      await cleanupRun();
    } catch (error) {
      fatal = fatal || error;
      check("清理流程未抛错", false, error?.message || String(error));
    }
  }
  const failed = printSummary();
  if (fatal) console.error(`[qa-community] 致命错误：${fatal.message || fatal}`);
  process.exitCode = failed === 0 && !fatal ? 0 : 1;
}

main().catch((error) => {
  console.error("[qa-community] 未捕获错误：", error);
  process.exitCode = 1;
});
