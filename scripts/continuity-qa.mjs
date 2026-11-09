/**
 * Guandao OS 1.8 · 跨设备 API 端到端测试
 *
 * 覆盖：配对（创建/提交/越权确认/批准/领取/重放）、接力（发送/收件/越权/完成）、
 * 剪贴板、上下文、CSRF、未登录访问。
 *
 * 用法：
 *   BASE=http://127.0.0.1:8787 node scripts/continuity-qa.mjs
 *
 * 依赖本地已存在的 QA 账号：
 *   laptop  gauth_sid=qa-plugin-dev-token-1234567890       设备 qa-dev-laptop
 *   phone   gauth_sid=qa-continuity-phone-token-1234567890 设备 qa-dev-phone
 *   other   gauth_sid=qa-plugin-other-token-1234567890     另一个账号
 */

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const LAPTOP = process.env.QA_LAPTOP || "qa-plugin-dev-token-1234567890";
const PHONE = process.env.QA_PHONE || "qa-continuity-phone-token-1234567890";
const OTHER = process.env.QA_OTHER || "qa-plugin-other-token-1234567890";

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", cookie, body, origin = BASE } = {}) {
  const headers = { accept: "application/json", origin };
  if (cookie) headers.cookie = `gauth_sid=${cookie}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload, headers: response.headers };
}

function data(result) {
  return result.payload?.data;
}

function errorCode(result) {
  return result.payload?.error?.code;
}

async function createPairing(cookie) {
  return call("/api/pairing/create", { method: "POST", cookie, body: {} });
}

async function main() {
  console.log(`\nGuandao OS 1.8 · Continuity QA @ ${BASE}\n`);

  console.log("[1] 配对创建");
  const created = await createPairing(LAPTOP);
  check("创建配对返回 200", created.status === 200, `${created.status} ${errorCode(created) ?? ""}`);
  const pairing = data(created);
  check("配对码是 6 位数字", /^\d{6}$/.test(pairing?.code || ""), pairing?.code);
  check("二维码只含短期 token", String(pairing?.qrUrl || "").includes("/pair/#t="), pairing?.qrUrl);
  check("二维码不含 Session Cookie", !JSON.stringify(pairing || {}).includes("gauth_sid"));
  check("有效期 10 分钟", Math.round((pairing?.expiresAt - Date.now()) / 60000) <= 10);

  console.log("\n[2] 新设备提交");
  const claimed = await call("/api/pairing/claim", {
    method: "POST",
    body: { token: pairing.token, device: { name: "QA Phone", type: "mobile" } },
  });
  check("提交配对返回 claimed", data(claimed)?.status === "claimed", errorCode(claimed));
  check("返回 claimSecret", typeof data(claimed)?.claimSecret === "string");
  check("来源设备可见", Boolean(data(claimed)?.source?.name), JSON.stringify(data(claimed)?.source));
  check("不泄露账号身份", !JSON.stringify(data(claimed) || {}).includes("Other User"));

  const wrongCode = await call("/api/pairing/claim", {
    method: "POST",
    body: { code: "000001", device: { name: "Evil", type: "desktop" } },
  });
  check("错误配对码被拒绝", wrongCode.status === 404 || wrongCode.status === 410, `${wrongCode.status}`);

  console.log("\n[3] 越权确认");
  const wrongConfirm = await call(`/api/pairing/${pairing.pairingId}/confirm`, {
    method: "POST",
    cookie: PHONE,
    body: {},
  });
  check("非来源设备不能确认", [403, 404, 409].includes(wrongConfirm.status), `${wrongConfirm.status} ${errorCode(wrongConfirm)}`);

  const confirmed = await call(`/api/pairing/${pairing.pairingId}/confirm`, {
    method: "POST",
    cookie: LAPTOP,
    body: {},
  });
  check("来源设备确认成功", confirmed.status === 200, `${confirmed.status} ${errorCode(confirmed)}`);
  check("登记了真实设备", Boolean(data(confirmed)?.device?.id));

  console.log("\n[4] 领取独立 Session");
  const poll = await call(
    `/api/pairing/claim/${pairing.pairingId}?secret=${encodeURIComponent(data(claimed).claimSecret)}`,
  );
  check("领取状态为 completed", data(poll)?.status === "completed" && data(poll)?.paired === true, errorCode(poll));
  const setCookies = poll.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookies.find((line) => line.startsWith("gauth_sid="));
  check("签发独立 Session Cookie", Boolean(sessionCookie));
  check("Cookie 带 HttpOnly", /HttpOnly/i.test(sessionCookie || ""));
  const newToken = sessionCookie?.split(";")[0]?.split("=")[1] || "";
  const me = await call("/api/auth/me", { cookie: newToken });
  check("新设备可读取自己的账号", me.payload?.authenticated === true, JSON.stringify(me.payload?.reason || ""));
  check("新设备获得独立 Session", Boolean(me.payload?.session?.deviceId));

  const replay = await call(
    `/api/pairing/claim/${pairing.pairingId}?secret=${encodeURIComponent(data(claimed).claimSecret)}`,
  );
  check("配对不能重复领取", replay.status === 200 && data(replay)?.alreadyDelivered === true, `${replay.status}`);
  const replayCreate = await call("/api/pairing/claim", {
    method: "POST",
    body: { code: pairing.code, device: { name: "Replay", type: "desktop" } },
  });
  check("配对码不能重复使用", replayCreate.status === 404, `${replayCreate.status}`);

  console.log("\n[5] 接力发送与接收");
  const sendRes = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    body: {
      itemType: "note",
      title: "QA 接力笔记",
      resourceId: "qa-note-1",
      payload: { title: "QA 接力笔记", body: "从 laptop 发到 phone 的内容", tags: ["QA"] },
      targetDeviceId: "qa-dev-phone",
      ttlMs: 3_600_000,
    },
  });
  check("发送接力返回 201", sendRes.status === 201, `${sendRes.status} ${errorCode(sendRes)}`);
  const itemId = data(sendRes)?.id;

  const otherInbox = await call("/api/continuity/inbox", { cookie: OTHER });
  check("其他账号看不到接力", !JSON.stringify(data(otherInbox)?.items || []).includes("QA 接力笔记"));

  const phoneInbox = await call("/api/continuity/inbox", { cookie: PHONE });
  const item = (data(phoneInbox)?.items || []).find((entry) => entry.id === itemId);
  check("目标设备收到接力", Boolean(item), `${phoneInbox.status}`);
  check("状态为 delivered", item?.status === "delivered", item?.status);

  const history = await call("/api/continuity/history", { cookie: LAPTOP });
  const sentItem = (data(history)?.items || []).find((entry) => entry.id === itemId);
  check("发送端看到已送达", sentItem?.status === "delivered" || sentItem?.status === "opened", sentItem?.status);

  const wrongOpen = await call(`/api/continuity/${itemId}/open`, { method: "POST", cookie: LAPTOP, body: {} });
  check("非目标设备不能打开", wrongOpen.status === 403, `${wrongOpen.status} ${errorCode(wrongOpen)}`);

  const openRes = await call(`/api/continuity/${itemId}/open`, { method: "POST", cookie: PHONE, body: {} });
  check("目标设备打开成功", openRes.status === 200 && data(openRes)?.item?.payload?.body?.includes("laptop"), errorCode(openRes));

  const complete = await call(`/api/continuity/${itemId}/complete`, { method: "POST", cookie: PHONE, body: {} });
  check("标记完成成功", complete.status === 200 && data(complete)?.completed === true, errorCode(complete));

  console.log("\n[6] 剪贴板");
  const clipSend = await call("/api/clipboard/send", {
    method: "POST",
    cookie: LAPTOP,
    body: { content: "QA clipboard 文本\n第二行" },
  });
  check("发送剪贴板返回 201", clipSend.status === 201, `${clipSend.status} ${errorCode(clipSend)}`);
  const clipId = data(clipSend)?.id;
  const clipList = await call("/api/clipboard", { cookie: PHONE });
  const clip = (data(clipList)?.items || []).find((entry) => entry.id === clipId);
  check("另一台设备能读取剪贴板", Boolean(clip));
  check("剪贴板保留换行", clip?.content?.includes("\n") === true);

  const otherDelete = await call(`/api/clipboard/${clipId}`, { method: "DELETE", cookie: OTHER });
  check("其他账号不能删除", otherDelete.status === 404, `${otherDelete.status}`);
  const ownDelete = await call(`/api/clipboard/${clipId}`, { method: "DELETE", cookie: LAPTOP });
  check("本人可以删除", ownDelete.status === 200 && data(ownDelete)?.deleted === true, errorCode(ownDelete));

  const empty = await call("/api/clipboard/send", { method: "POST", cookie: LAPTOP, body: { content: "   " } });
  check("空剪贴板被拒绝", empty.status === 400, `${empty.status}`);

  console.log("\n[7] 上下文");
  const saveCtx = await call("/api/continuity/context", {
    method: "PUT",
    cookie: LAPTOP,
    body: { appId: "notes", resourceId: "qa-note-1", resourceTitle: "QA 接力笔记", scroll: 120 },
  });
  check("保存上下文成功", saveCtx.status === 200 && data(saveCtx)?.saved === true, errorCode(saveCtx));
  const ctxPhone = await call("/api/continuity/context", { cookie: PHONE });
  check("另一台设备看到上下文", (data(ctxPhone)?.items || []).some((entry) => entry.deviceId === "qa-dev-laptop" && entry.appId === "notes"));
  const ctxOther = await call("/api/continuity/context", { cookie: OTHER });
  check("其他账号看不到上下文", !(data(ctxOther)?.items || []).some((entry) => entry.deviceId === "qa-dev-laptop"));
  const badCtx = await call("/api/continuity/context", {
    method: "PUT",
    cookie: PHONE,
    body: { appId: "<script>", resourceTitle: "x" },
  });
  check("非法 appId 被拒绝", badCtx.status === 400, `${badCtx.status}`);

  console.log("\n[8] 鉴权与 CSRF");
  const anon = await call("/api/continuity/inbox");
  check("未登录收件箱 401", anon.status === 401, `${anon.status}`);
  const csrf = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    origin: "https://evil.example",
    body: { itemType: "note", title: "x", payload: {} },
  });
  check("跨站写入被拒绝", csrf.status === 403, `${csrf.status} ${errorCode(csrf)}`);

  console.log("\n[9] 参数与边界");
  const badType = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    body: { itemType: "malware", title: "x", payload: {} },
  });
  check("未知类型被拒绝", badType.status === 400, `${badType.status}`);
  const selfTarget = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    body: { itemType: "note", title: "x", payload: {}, targetDeviceId: "qa-dev-laptop" },
  });
  check("不能发给自己", selfTarget.status === 400, `${selfTarget.status}`);
  const foreignTarget = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    body: { itemType: "note", title: "x", payload: {}, targetDeviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  check("不能发给别人的设备", foreignTarget.status === 404, `${foreignTarget.status}`);
  const huge = await call("/api/continuity/send", {
    method: "POST",
    cookie: LAPTOP,
    body: { itemType: "note", title: "x", payload: { body: "a".repeat(40000) } },
  });
  check("超大 payload 被拒绝", huge.status === 413, `${huge.status}`);

  const push = await call("/api/push/status", { cookie: LAPTOP });
  check("Push 状态如实返回未启用", data(push)?.enabled === false && typeof data(push)?.reason === "string", JSON.stringify(data(push)));

  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    console.log(`失败项：${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("测试异常：", error);
  process.exit(1);
});
