#!/usr/bin/env node
/**
 * Guandao OS 1.7 · 插件系统 API 端到端测试
 *
 * 前置条件（本地）：
 *   1. npm run db:migrate:local
 *   2. npm run build && npx wrangler dev --port 8787 --local
 *   3. 本地 D1 中存在以下 Session（见 docs/PLUGINS-1.7.md）：
 *        admin  gauth_sid=qa-plugin-admin-token-1234567890
 *        dev    gauth_sid=qa-plugin-dev-token-1234567890
 *        other  gauth_sid=qa-plugin-other-token-1234567890
 *
 * 覆盖：Manifest 与插件包校验、恶意包拒绝、审核、市场、安装/权限/更新/回退/卸载、
 * 审核越权、自审拒绝、网络代理白名单、安全响应头。
 *
 * 脚本只走公开 HTTP 接口，不直接改业务表。结束时会把测试插件下架，市场不会残留。
 */

import crypto from "node:crypto";

const BASE = (process.env.QA_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ORIGIN = process.env.QA_ORIGIN || BASE;
const ADMIN = process.env.QA_ADMIN_COOKIE || "gauth_sid=qa-plugin-admin-token-1234567890";
const DEV = process.env.QA_DEV_COOKIE || "gauth_sid=qa-plugin-dev-token-1234567890";
const OTHER = process.env.QA_OTHER_COOKIE || "gauth_sid=qa-plugin-other-token-1234567890";

const suffix = Date.now().toString(36).slice(-6);
const PLUGIN_ID = `com.qa.tool${suffix}`;
const RUN_TAG = `qa${suffix}`;

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(path, { method = "GET", cookie = null, body, form, origin = ORIGIN, headers: extra = {} } = {}) {
  const headers = { accept: "application/json", ...extra };
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
    /* 非 JSON */
  }
  return { status: response.status, json, text, headers: response.headers };
}

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function buildBundle(options = {}) {
  const version = options.version || "1.0.0";
  const permissions = options.permissions || ["window.open", "notification.show", "plugin.storage.read", "plugin.storage.write"];
  const manifest = {
    manifestVersion: 1,
    id: options.id || PLUGIN_ID,
    name: "QA Toolkit",
    version,
    description: "插件系统端到端测试用的真实插件包，包含一个可运行的 HTML 入口。",
    author: { name: "QA Developer", url: "https://guandao.xin" },
    type: "application",
    entry: options.entry || "index.html",
    icon: "icon.svg",
    screenshots: [],
    category: "developer",
    license: "MIT",
    homepage: "https://guandao.xin",
    repository: "",
    changelog: `QA ${version}`,
    compatibility: { minimumOSVersion: "2.0.0", sdkVersion: 1 },
    permissions,
    networkDomains: options.networkDomains || [],
    dependencies: [],
    contributes: {},
    ...(options.manifest || {}),
  };
  const files = options.files || [
    {
      path: "index.html",
      encoding: "utf8",
      content: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1>QA ${version}</h1><script src="app.js"></script></body></html>`,
    },
    { path: "style.css", encoding: "utf8", content: "body{font:14px sans-serif;background:#0b0e15;color:#eef1f7}" },
    { path: "app.js", encoding: "utf8", content: "document.querySelector('h1').textContent += ' · sandbox';" },
    { path: "icon.svg", encoding: "utf8", content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#6f8cff"/></svg>' },
  ];
  const normalized = files.map((file) => ({ path: file.path, encoding: file.encoding || "utf8", content: file.content }));
  const filesDigest = sha256(canonicalJson(normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
  const bundle = options.omitDigest
    ? { format: "guandao-plugin", formatVersion: 1, manifest, files: normalized }
    : { format: "guandao-plugin", formatVersion: 1, manifest, files: normalized, filesDigest };
  return { text: JSON.stringify(bundle), manifest, filesDigest };
}

async function uploadVersion(cookie, bundle, changelog = "QA 版本", pluginId = PLUGIN_ID) {
  return request(`/api/developer/plugins/${encodeURIComponent(pluginId)}/versions`, {
    method: "POST",
    cookie,
    body: { bundle: typeof bundle === "string" ? bundle : bundle.text, changelog },
  });
}

async function main() {
  console.log("Guandao OS 1.7 · Plugin API QA");
  console.log(`插件 ID：${PLUGIN_ID}\n`);

  console.log("[0] 环境与会话");
  const health = await request("/api/health");
  check("Worker 与 D1 可用", health.status === 200 && health.json?.services?.d1 === "connected");
  const meta = await request("/api/plugins/meta", { cookie: ADMIN });
  check("插件元信息可读", meta.status === 200 && meta.json?.data?.osVersion === "2.0.0");
  check("权限目录完整（17 项）", meta.json?.data?.permissions?.length === 17, String(meta.json?.data?.permissions?.length));
  check(
    "管理员会话被识别",
    meta.json?.data?.viewer?.role === "admin" && meta.json?.data?.viewer?.staff === true,
    JSON.stringify(meta.json?.data?.viewer),
  );

  console.log("\n[1] 创建开发者草稿");
  const create = await request("/api/developer/plugins", {
    method: "POST",
    cookie: DEV,
    body: {
      id: PLUGIN_ID,
      name: "QA Toolkit",
      type: "application",
      category: "developer",
      description: "插件系统端到端测试插件。",
      license: "MIT",
    },
  });
  check("草稿创建成功", create.status === 200 && create.json?.data?.plugin?.id === PLUGIN_ID, create.text.slice(0, 120));
  const duplicate = await request("/api/developer/plugins", {
    method: "POST",
    cookie: DEV,
    body: { id: PLUGIN_ID, name: "Dup", type: "application", category: "developer", description: "重复 ID 测试", license: "MIT" },
  });
  check("重复插件 ID 被拒绝", duplicate.status === 409 && duplicate.json?.error?.code === "ID_TAKEN");

  const otherCreate = await request("/api/developer/plugins", {
    method: "POST",
    cookie: OTHER,
    body: { id: `${PLUGIN_ID}.other`, name: "Other", type: "application", category: "other", description: "非拥有者越权测试", license: "MIT" },
  });
  check("其他开发者可以创建自己的草稿", otherCreate.status === 200);
  const steal = await uploadVersion(OTHER, buildBundle());
  check("非拥有者不能上传版本", steal.status === 404, `status=${steal.status}`);

  console.log("\n[2] 恶意 / 非法插件包");
  const unknown = await uploadVersion(
    DEV,
    buildBundle({ permissions: ["root.everything"] }),
  );
  check(
    "未知权限被拒绝（默认拒绝）",
    unknown.status === 422 && /UNKNOWN_PERMISSION/.test(JSON.stringify(unknown.json)),
    unknown.text.slice(0, 160),
  );

  const traversal = await uploadVersion(
    DEV,
    buildBundle({
      files: [
        { path: "index.html", encoding: "utf8", content: "<!doctype html><html><body>ok</body></html>" },
        { path: "../evil.js", encoding: "utf8", content: "alert(1)" },
      ],
    }),
  );
  check("路径穿越文件被拒绝", traversal.status === 422, traversal.text.slice(0, 160));

  const php = await uploadVersion(
    DEV,
    buildBundle({
      files: [
        { path: "index.html", encoding: "utf8", content: "<!doctype html><html><body>ok</body></html>" },
        { path: "shell.php", encoding: "utf8", content: "<?php echo 1; ?>" },
      ],
    }),
  );
  check("可执行后端文件被拒绝", php.status === 422, php.text.slice(0, 160));

  const noDigest = await uploadVersion(DEV, buildBundle({ omitDigest: true }));
  check(
    "缺少 filesDigest 被拒绝",
    noDigest.status === 422 && /FILES_DIGEST_MISSING/.test(JSON.stringify(noDigest.json)),
    noDigest.text.slice(0, 160),
  );

  const noEntry = await uploadVersion(DEV, buildBundle({ entry: "main.html" }));
  check(
    "入口文件不存在被拒绝",
    noEntry.status === 422 && /ENTRY_MISSING/.test(JSON.stringify(noEntry.json)),
    noEntry.text.slice(0, 160),
  );

  console.log("\n[3] 上传真实版本");
  const first = buildBundle();
  const upload = await uploadVersion(DEV, first);
  check("v1.0.0 上传成功", upload.status === 200 && upload.json?.data?.version?.version === "1.0.0", upload.text.slice(0, 160));
  const checksum = upload.json?.data?.version?.checksum;
  check("返回 64 位包校验值", /^[a-f0-9]{64}$/.test(checksum || ""), String(checksum).slice(0, 16));
  const sameVersion = await uploadVersion(DEV, first);
  check("重复版本号被拒绝", sameVersion.status === 409 && sameVersion.json?.error?.code === "VERSION_EXISTS");

  const beforePublish = await request(`/api/plugins?q=${encodeURIComponent("QA Toolkit")}`);
  check("未审核插件不进入市场", beforePublish.status === 200 && beforePublish.json?.data?.total === 0);

  console.log("\n[4] 提交与审核边界");
  const submit = await request(`/api/developer/plugins/${encodeURIComponent(PLUGIN_ID)}/submit`, {
    method: "POST",
    cookie: DEV,
  });
  check("提交审核成功", submit.status === 200 && submit.json?.data?.status === "pending_review", submit.text.slice(0, 120));

  const selfReview = await request(`/api/plugins/admin/${encodeURIComponent(PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: DEV,
    body: { decision: "approve", version: "1.0.0", note: "self" },
  });
  // 普通成员在角色门禁就被拦下（403 FORBIDDEN），走不到 SELF_REVIEW 分支；
  // 真正的「管理员审核自己」在下面用管理员自建插件单独验证。
  check(
    "开发者（普通成员）不能审核插件",
    selfReview.status === 403 && selfReview.json?.error?.code === "FORBIDDEN",
    selfReview.text.slice(0, 160),
  );

  const memberReview = await request(`/api/plugins/admin/${encodeURIComponent(PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: OTHER,
    body: { decision: "approve", version: "1.0.0", note: "nope" },
  });
  check("普通成员不能审核", memberReview.status === 403);

  const queue = await request("/api/plugins/admin/queue/pending", { cookie: ADMIN });
  check(
    "审核队列出现待审版本",
    queue.status === 200 && queue.json?.data?.items?.some((item) => item.plugin.id === PLUGIN_ID),
  );

  // 管理员自己发布的插件：审核接口必须命中 SELF_REVIEW 分支（不能自己批准自己）。
  const SELF_PLUGIN_ID = `${PLUGIN_ID}.self`;
  const selfCreate = await request("/api/developer/plugins", {
    method: "POST",
    cookie: ADMIN,
    body: {
      id: SELF_PLUGIN_ID,
      name: "QA Self Review",
      type: "application",
      category: "developer",
      description: "管理员自审边界测试插件（邮箱级隔离夹具）。",
      license: "MIT",
    },
  });
  check("管理员可以创建自己的插件草稿", selfCreate.status === 200, selfCreate.text.slice(0, 160));
  const selfUpload = await uploadVersion(ADMIN, buildBundle({ id: SELF_PLUGIN_ID, manifest: { name: "QA Self Review" } }), "QA 自审夹具", SELF_PLUGIN_ID);
  check("管理员插件版本可以上传", selfUpload.status === 200, selfUpload.text.slice(0, 160));
  const selfSubmit = await request(`/api/developer/plugins/${encodeURIComponent(SELF_PLUGIN_ID)}/submit`, {
    method: "POST",
    cookie: ADMIN,
  });
  check("管理员插件可以提交审核", selfSubmit.status === 200, selfSubmit.text.slice(0, 160));
  const selfReviewAdmin = await request(`/api/plugins/admin/${encodeURIComponent(SELF_PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { decision: "approve", version: "1.0.0", note: "self" },
  });
  check(
    "管理员不能审核自己发布的插件",
    selfReviewAdmin.status === 403 && selfReviewAdmin.json?.error?.code === "SELF_REVIEW",
    selfReviewAdmin.text.slice(0, 160),
  );
  const selfCleanup = await request(`/api/plugins/admin/${encodeURIComponent(SELF_PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { decision: "reject", version: "1.0.0", note: "清理自审测试夹具" },
  });
  check("自审夹具可以清理（reject 不影响主流程）", selfCleanup.status === 200, selfCleanup.text.slice(0, 160));

  const approve = await request(`/api/plugins/admin/${encodeURIComponent(PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { decision: "approve", version: "1.0.0", note: "QA 通过" },
  });
  check("管理员审核通过并发布", approve.status === 200 && approve.json?.data?.status === "published", approve.text.slice(0, 120));

  console.log("\n[5] 市场与下载");
  const detail = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}`);
  check(
    "公开详情显示已审核",
    detail.status === 200 && detail.json?.data?.plugin?.security?.audited === true && detail.json?.data?.plugin?.version === "1.0.0",
    detail.text.slice(0, 140),
  );
  check(
    "详情包含完整 Manifest",
    detail.json?.data?.plugin?.manifest?.id === PLUGIN_ID && Array.isArray(detail.json?.data?.plugin?.permissions),
  );

  const anonPackage = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/package`);
  check("未登录不能下载插件包", anonPackage.status === 401);

  const pkg = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/package?version=1.0.0`, { cookie: OTHER });
  const pkgText = pkg.json?.data?.packageJson || "";
  check("登录后可下载插件包", pkg.status === 200 && pkgText.length > 0);
  check("下载包 SHA-256 与服务端记录一致", sha256(pkgText) === checksum);

  const headerCsp = await request("/");
  check("主页面禁止被 iframe 嵌入", headerCsp.headers.get("x-frame-options") === "DENY");
  const sandboxPage = await request("/sandbox/runner.html");
  check("沙箱页允许宿主 iframe 且移除 XFO", sandboxPage.headers.get("x-frame-options") === null);
  const sandboxCsp = sandboxPage.headers.get("content-security-policy") || "";
  check("沙箱 CSP 关闭网络出口", /connect-src 'none'/.test(sandboxCsp), sandboxCsp.slice(0, 120));
  check("沙箱 CSP 只允许内联脚本", /script-src 'unsafe-inline'/.test(sandboxCsp) && !/unsafe-eval/.test(sandboxCsp));

  console.log("\n[6] 安装与权限");
  const installBody = {
    pluginId: PLUGIN_ID,
    version: "1.0.0",
    packageHash: checksum,
    permissions: ["window.open", "notification.show", "plugin.storage.read", "plugin.storage.write"],
  };
  const anonInstall = await request("/api/plugins/install", { method: "POST", body: installBody });
  check("未登录不能安装", anonInstall.status === 401);

  const badHash = await request("/api/plugins/install", {
    method: "POST",
    cookie: OTHER,
    body: { ...installBody, packageHash: "0".repeat(64) },
  });
  check("包校验值不一致被拒绝", badHash.status === 409 && badHash.json?.error?.code === "PACKAGE_INTEGRITY_ERROR");

  const undeclared = await request("/api/plugins/install", {
    method: "POST",
    cookie: OTHER,
    body: { ...installBody, permissions: ["network.fetch"] },
  });
  check("不能授予未声明权限", undeclared.status === 400 && undeclared.json?.error?.code === "PERMISSION_NOT_DECLARED");

  const install = await request("/api/plugins/install", { method: "POST", cookie: OTHER, body: installBody });
  check("安装成功并写入服务端记录", install.status === 200 && install.json?.data?.installation?.version === "1.0.0", install.text.slice(0, 140));

  const installedList = await request("/api/plugins/installed", { cookie: OTHER });
  const installedItem = installedList.json?.data?.items?.find((item) => item.id === PLUGIN_ID);
  check("安装列表返回授权", installedItem && installedItem.granted.length === 4 && installedItem.enabled === true);

  const perms = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/permissions`, { cookie: OTHER });
  check("权限接口返回已授予列表", perms.status === 200 && perms.json?.data?.granted?.includes("notification.show"));

  const revoke = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/permissions/notification.show`, {
    method: "DELETE",
    cookie: OTHER,
  });
  check("撤销单项权限立即生效", revoke.status === 200 && !revoke.json?.data?.granted?.includes("notification.show"));

  const netDenied = await request("/api/plugins/net", {
    method: "POST",
    cookie: OTHER,
    body: { pluginId: PLUGIN_ID, url: "https://api.github.com/zen", method: "GET" },
  });
  check("未授权网络调用被拒绝", netDenied.status === 403 && netDenied.json?.error?.code === "PERMISSION_DENIED");

  const disable = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/disable`, { method: "POST", cookie: OTHER });
  check("禁用后状态持久化", disable.status === 200 && disable.json?.data?.installation?.enabled === false);
  const launchDisabled = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/launch`, { method: "POST", cookie: OTHER });
  check("禁用插件不能上报启动", launchDisabled.status === 409 && launchDisabled.json?.error?.code === "PLUGIN_DISABLED");
  const enable = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/enable`, { method: "POST", cookie: OTHER });
  check("重新启用成功", enable.status === 200 && enable.json?.data?.installation?.enabled === true);

  console.log("\n[7] 评价与举报");
  const review = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/reviews`, {
    method: "POST",
    cookie: OTHER,
    body: { rating: 5, body: "QA 评价：安装流程与权限展示都正常。" },
  });
  check("已安装用户可以评价", review.status === 200);
  const reviews = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/reviews`);
  check("评分聚合来自真实记录", reviews.json?.data?.total === 1 && reviews.json?.data?.distribution?.["5"] === 1);

  const notInstalledReview = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/reviews`, {
    method: "POST",
    cookie: ADMIN,
    body: { rating: 1, body: "没有安装就评价" },
  });
  check("未安装不能评价", notInstalledReview.status === 403);

  const report = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/report`, {
    method: "POST",
    cookie: ADMIN,
    body: { reason: "misleading", detail: "QA 举报流程测试" },
  });
  check("举报进入队列", report.status === 200);
  const reportAgain = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/report`, {
    method: "POST",
    cookie: ADMIN,
    body: { reason: "other", detail: "重复举报" },
  });
  check("重复举报被拒绝", reportAgain.status === 409);

  console.log("\n[8] 更新、权限升级与回退");
  const second = buildBundle({
    version: "1.1.0",
    permissions: [
      "window.open",
      "notification.show",
      "plugin.storage.read",
      "plugin.storage.write",
      "notes.create",
      "network.fetch",
    ],
    networkDomains: ["api.github.com"],
  });
  const upload2 = await uploadVersion(DEV, second, "新增笔记与网络能力");
  check("上传 v1.1.0 成功", upload2.status === 200 && upload2.json?.data?.version?.version === "1.1.0");
  const checksum2 = upload2.json?.data?.version?.checksum;
  const submit2 = await request(`/api/developer/plugins/${encodeURIComponent(PLUGIN_ID)}/submit`, {
    method: "POST",
    cookie: DEV,
  });
  check("已发布插件的新版本进入审核而不是重新上架", submit2.status === 200 && submit2.json?.data?.status === "published");
  await request(`/api/plugins/admin/${encodeURIComponent(PLUGIN_ID)}/review`, {
    method: "POST",
    cookie: ADMIN,
    body: { decision: "approve", version: "1.1.0", note: "QA 通过 1.1.0" },
  });

  const consent = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/update`, {
    method: "POST",
    cookie: OTHER,
    body: { version: "1.1.0", packageHash: checksum2 },
  });
  check(
    "新增权限需要再次确认",
    consent.status === 200 && consent.json?.data?.needsConsent === true && consent.json?.data?.added?.includes("notes.create"),
    consent.text.slice(0, 160),
  );

  const missingConsent = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/update`, {
    method: "POST",
    cookie: OTHER,
    body: {
      version: "1.1.0",
      packageHash: checksum2,
      permissions: ["window.open", "notification.show", "plugin.storage.read", "plugin.storage.write"],
    },
  });
  check("拒绝新增权限时更新被阻止", missingConsent.status === 409 && missingConsent.json?.error?.code === "PERMISSION_CONSENT_REQUIRED");

  const update = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/update`, {
    method: "POST",
    cookie: OTHER,
    body: {
      version: "1.1.0",
      packageHash: checksum2,
      permissions: ["window.open", "notification.show", "plugin.storage.read", "plugin.storage.write", "notes.create", "network.fetch"],
    },
  });
  check("确认新增权限后更新成功", update.status === 200 && update.json?.data?.installation?.version === "1.1.0", update.text.slice(0, 160));

  const netAllowedButDeniedDomain = await request("/api/plugins/net", {
    method: "POST",
    cookie: OTHER,
    body: { pluginId: PLUGIN_ID, url: "https://example.com/", method: "GET" },
  });
  check(
    "网络代理只放行声明域名",
    netAllowedButDeniedDomain.status === 403 && netAllowedButDeniedDomain.json?.error?.code === "DOMAIN_NOT_ALLOWED",
  );
  const netHttp = await request("/api/plugins/net", {
    method: "POST",
    cookie: OTHER,
    body: { pluginId: PLUGIN_ID, url: "http://api.github.com/zen", method: "GET" },
  });
  check("网络代理拒绝非 https", netHttp.status === 400 && netHttp.json?.error?.code === "INVALID_URL");

  const rollback = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/rollback`, {
    method: "POST",
    cookie: OTHER,
    body: { version: "1.0.0", packageHash: checksum },
  });
  check("回退到上一个版本成功", rollback.status === 200 && rollback.json?.data?.installation?.version === "1.0.0", rollback.text.slice(0, 160));
  check("回退会撤销新版本才有的权限", !rollback.json?.data?.permissions?.includes("notes.create"));

  console.log("\n[9] 下架与紧急停止");
  const installedBeforeTakedown = await request("/api/plugins/installed", { cookie: OTHER });
  check(
    "下架前存在安装记录",
    installedBeforeTakedown.json?.data?.items?.some((item) => item.id === PLUGIN_ID && item.installation?.enabled),
  );
  const takedown = await request(`/api/plugins/admin/${encodeURIComponent(PLUGIN_ID)}/takedown`, {
    method: "POST",
    cookie: ADMIN,
    body: { reason: "QA 安全检查：验证紧急下架与用户数据保留" },
  });
  check("管理员可以紧急下架", takedown.status === 200 && takedown.json?.data?.status === "blocked");

  const blockedInstall = await request("/api/plugins/install", {
    method: "POST",
    cookie: DEV,
    body: { pluginId: PLUGIN_ID, version: "1.0.0", packageHash: checksum, permissions: ["window.open"] },
  });
  check("下架插件不能继续安装", blockedInstall.status === 409 && blockedInstall.json?.error?.code === "PLUGIN_BLOCKED");

  const listed = await request("/api/plugins/installed", { cookie: OTHER });
  const blockedItem = listed.json?.data?.items?.find((item) => item.id === PLUGIN_ID);
  check(
    "已安装用户被停止运行但记录保留",
    blockedItem && blockedItem.installation?.status === "blocked" && blockedItem.installation?.enabled === false,
    JSON.stringify(blockedItem?.installation),
  );

  const reviewAfterBlocked = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/reviews`);
  check("下架插件详情不公开", reviewAfterBlocked.status === 404);

  console.log("\n[10] 审计与卸载");
  const audit = await request("/api/plugins/admin/audit", { cookie: ADMIN });
  const actions = (audit.json?.data?.items || []).map((item) => item.action);
  check("审计日志记录了安装与下架", actions.includes("plugin.install") && actions.includes("plugin.takedown"), actions.slice(0, 6).join(","));

  const uninstall = await request(`/api/plugins/${encodeURIComponent(PLUGIN_ID)}/install`, {
    method: "DELETE",
    cookie: OTHER,
  });
  check("用户可以卸载（即使插件被下架）", uninstall.status === 200 && uninstall.json?.data?.ok === true);
  const afterUninstall = await request("/api/plugins/installed", { cookie: OTHER });
  check(
    "卸载后安装记录与授权被清除",
    !afterUninstall.json?.data?.items?.some((item) => item.id === PLUGIN_ID),
  );

  const csrf = await request("/api/plugins/install", {
    method: "POST",
    cookie: OTHER,
    origin: "https://evil.example",
    body: installBody,
  });
  check("跨站写入被拒绝", csrf.status === 403 && csrf.json?.error?.code === "CSRF_REJECTED");

  console.log(`\n${results.length - failures}/${results.length} 项通过`);
  if (failures) {
    console.log("\n失败项：");
    for (const item of results.filter((entry) => !entry.ok)) console.log(` - ${item.name}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("测试中断：", error);
  process.exit(2);
});
