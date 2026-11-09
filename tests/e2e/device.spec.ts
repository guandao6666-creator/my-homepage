/**
 * Phase 3.3 · 设备配对 / 跨设备接力 / 剪贴板 E2E（真实 Worker + 本地 D1）
 *
 * 为什么必须是两个真正的 Browser Context：
 *   配对的产品语义是「一台已登录设备把另一台设备接进同一账号」。如果测试复用
 *   storageState，B 端一开始就带着 A 的会话，等于根本没验证「领取独立 Session」。
 *   这里四个身份互不共享 Cookie/存储：
 *     A = 已 seed 的 qa-p3-installer 会话（addCookies 注入，模拟旧设备浏览器）；
 *     B = browser.newContext() 全新上下文（初始零 Cookie），配对后由服务端
 *         Set-Cookie 领取自己的 gauth_sid / gauth_did；
 *     C = 另一台全新上下文，用于「claim 后未确认」的取消 / 未授权路径；
 *     outsider = 另一个账号（qa-p3-outsider）的独立上下文，验证账号隔离。
 *
 * 覆盖（12 个用例，serial 共享 A/B/A2 状态）：
 *   1. 上下文独立性与未认证边界
 *   1b. 已过期配对：过期入口一律 404、claim 后过期轮询/确认 410，且不落设备
 *   2. 配对码契约（6 位数字 / 一次性 token / 10 分钟 TTL）
 *   3. 错误配对码拒绝
 *   3b. 批准边界：同账号其他设备 403 WRONG_DEVICE、其他账号 404、claim 缺 Origin 403、超长 token 400
 *   3c. 设备上限：已满 10 台的账号确认第 11 台 → 409 DEVICE_LIMIT，不落设备
 *   4. 完整配对 happy path（claim → confirm → 轮询领取 Session → 设备出现）
 *   5. 取消配对（cancelled 后轮询 410、确认 409）
 *   6. 接力状态机 pending → delivered → opened → completed + 非目标设备
 *   7. 接力错误码（SELF_TARGET / TARGET_NOT_FOUND / INVALID_TYPE / PAYLOAD_TOO_LARGE / cancel）
 *   8. 剪贴板定向投递、账号隔离、4000 字符上限
 *   9. 撤销设备后新设备 Session 失效
 *
 * 明确未覆盖（见 docs/architecture/DEVICE-PAIRING.md「E2E 实测边界」）：
 *   - 真实 10 分钟 TTL 等待：不睡着等 10 分钟，改为 e2e-server 直插两条**已过期**配对
 *     （1b），覆盖的正是 claim/confirm 的过期判定分支；时钟本身不伪造；
 *   - PAIRING_ATTEMPTS_EXCEEDED：当前实现 markClaimed 后配对不再是 pending，
 *     该 429 经公开 API 不可达（实现问题，测试不伪造通过）；
 *   - INVALID_CLAIM（缺 secret / 缺 id 的 400）属于格式校验，本文件不做断言。
 *
 * 限流：本地按 cf-connecting-ip 分桶。support 层给每个 Actor 分配一次运行内唯一、
 *   跨运行随机的测试地址（生产由 Cloudflare 覆写该头，客户端无法伪造），因此本文件
 *   可以连续重复运行而不会共用上一轮的计数桶；服务端阈值不受影响
 *   （pairing-claim 10 次/10 分钟：单轮共 9 个 claim POST，单个 Actor 最多 8 个；
 *   pairing-create 12 次/小时：单轮 4 个 create POST）。
 *
 * 夹具复位：1b 依赖的两条「已过期配对」会在 createPairing 的 expirePairings 里被
 *   翻成 expired。beforeAll 通过 e2e-server 仅监听 127.0.0.1 的夹具管理端点
 *   `POST /__e2e/reset-expired` 重新播种，因此连续多轮运行都能覆盖真实过期判定分支。
 */
import { expect, test } from "@playwright/test";

import {
  MOBILE_UA,
  QA_DEVICE_PREFIX,
  adoptCookies,
  api,
  cancelContinuity,
  cancelPairing,
  claimPairing,
  cleanupQaPairingDevices,
  completeContinuity,
  confirmPairing,
  continuityHistory,
  continuityInbox,
  cookiesOf,
  createPairing,
  deleteClipboard,
  expectError,
  listClipboard,
  listDevices,
  listPairings,
  newAnonymousActor,
  newSeededActor,
  okData,
  openContinuity,
  pairingCookiesFrom,
  pollPairingClaim,
  reseedExpiredPairings,
  revokeDevice,
  sendClipboard,
  sendContinuity,
  uniqueTag,
  type ApiActor,
  type ClipboardList,
  type ContinuityInbox,
  type PairingClaim,
  type PairingCreated,
  type PairingList,
} from "./support/device-flow";
import { API_BASE, waitForFixtures, type Fixtures } from "./support/worker-api";

let fixtures: Fixtures;

/** 旧设备：qa-p3-installer 的已登录会话。 */
let a: ApiActor;
/** 同一账号的第二台已登录设备：session 有效，但不是配对发起设备（WRONG_DEVICE）。 */
let a2: ApiActor;
/** 新设备：空白 Context，配对成功后拿到独立 Session。 */
let b: ApiActor;
/** 只 claim 不确认的第二台新设备。 */
let c: ApiActor;
/** 隔离账号：验证账号之间互不可见。 */
let outsider: ApiActor;
/** 已占满 MAX_DEVICES=10 的账号：验证设备上限分支。 */
let crowded: ApiActor;

const TAG = uniqueTag();
const DEVICE_NAME = `${QA_DEVICE_PREFIX}${TAG}`;
const A_DEVICE_ID = "qa-p3-installer-device";

let bDeviceId = "";
let outsiderDeviceId = "";
/** T2 创建、T5 复用做取消路径的配对（省一次 create 配额）。 */
let cancelledPairing: PairingCreated;

type ConfirmedResult = {
  status: string;
  device: { id: string; name: string; type: string };
  pairing: { status: string };
};

test.describe("Phase 3.3 · 设备配对 / 跨设备接力 / 剪贴板（真实双 Browser Context）", () => {
  // 共享 A/B 的设备和上下文状态：happy path 之后接力、剪贴板、撤销都跑在 B 上。
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    fixtures = await waitForFixtures("accounts");
    a = await newSeededActor(browser, fixtures, "installer");
    a2 = await newSeededActor(browser, fixtures, "installer2");
    b = await newAnonymousActor(browser, "B-新设备", { userAgent: MOBILE_UA });
    c = await newAnonymousActor(browser, "C-未确认设备", { userAgent: MOBILE_UA });
    outsider = await newSeededActor(browser, fixtures, "outsider");
    crowded = await newSeededActor(browser, fixtures, "crowded");
    // e2e-server 只在启动时清 D1，上一次中断的运行可能留下未撤销的 qa-dp-* 设备。
    // 撤销后的设备不占 MAX_DEVICES=10 名额；这里走公开撤销 API，绝不直接改库。
    await cleanupQaPairingDevices(a);
    // 复位「已过期配对」夹具：上一轮成功的运行里，create 会顺带 expirePairings()，
    // 把夹具中 claimed 的行翻成 expired。仅调用本地 e2e-server 的夹具管理端点，不改生产代码。
    await reseedExpiredPairings(a, fixtures.adminUrl);
  });

  test.afterAll(async () => {
    // 兜底：即使中途失败，也撤销本轮 B 设备，避免污染后续运行。
    if (a && bDeviceId) {
      try {
        await revokeDevice(a, bDeviceId);
      } catch {
        // 已撤销 / 会话已失效：忽略。
      }
    }
    await a?.context.close();
    await a2?.context.close();
    await b?.context.close();
    await c?.context.close();
    await outsider?.context.close();
    await crowded?.context.close();
  });

  test("1. 四个 Context 完全独立：B 初始无 Cookie，未配对设备访问受保护接口一律 401", async () => {
    const aCookies = await cookiesOf(a);
    const bCookies = await cookiesOf(b);
    expect(aCookies.session, "A 必须带已 seed 的 gauth_sid").toBeTruthy();
    expect(bCookies.session, "B 初始必须是空白上下文，绝不能带着 A 的会话").toBeNull();
    expect(bCookies.device, "B 初始也不能有设备 Cookie").toBeNull();

    const aDevices = await listDevices(a);
    expect(aDevices.currentDeviceId).toMatch(/^qa-p3-installer-device/);
    const aCurrent = aDevices.devices.find((device) => device.id === aDevices.currentDeviceId);
    expect(aCurrent, "A 的 GET /api/devices 应包含当前设备").toBeTruthy();
    expect(aCurrent!.isCurrent).toBe(true);
    expect(aCurrent!.status).toBe("active");

    // 未配对的新设备：四个业务面全部 401。
    for (const path of ["/api/devices", "/api/continuity/inbox", "/api/clipboard", "/api/pairing"]) {
      expectError(await api(b, "GET", path), 401, "UNAUTHENTICATED", `空白上下文访问 ${path}`);
    }

    // 另一个账号只能看到自己的设备。
    const outsiderDevices = await listDevices(outsider);
    expect(outsiderDevices.currentDeviceId).toMatch(/^qa-p3-outsider-device/);
    outsiderDeviceId = outsiderDevices.currentDeviceId!;
    expect(
      outsiderDevices.devices.some((device) => device.id === aDevices.currentDeviceId),
      "outsider 的设备列表不能出现 installer 的设备",
    ).toBe(false);
  });

  test("1b. 已过期配对：过期入口一律 404，claim 后过期轮询/确认 410，且不落设备", async () => {
    // 这两条配对由 e2e-server 直插本地 D1，时间戳已过期。必须在任何 create 之前读取：
    // POST /api/pairing/create 会顺带 expirePairings，把 claimed 行翻成 expired，
    // 那样 confirm 会先撞「状态不是 claimed」的 409，覆盖不到真正的过期判定。
    const expired = fixtures.expiredPairing;
    expect(expired, "e2e-server 应预置 expiredPairing 夹具").toBeTruthy();

    const before = await listDevices(a);
    const beforeIds = before.devices.map((device) => device.id).sort();

    // pending 但已过期：码与 token 都匹配不到可用的 pending 行，统一 404（不暴露是否存在）。
    expectError(
      await claimPairing(c, {
        code: expired.pending.code,
        device: { name: `${QA_DEVICE_PREFIX}expired-code-${TAG}`, type: "mobile" },
      }),
      404,
      "PAIRING_NOT_FOUND",
      "过期配对码 claim",
    );
    expectError(
      await claimPairing(c, {
        token: expired.pending.token,
        device: { name: `${QA_DEVICE_PREFIX}expired-token-${TAG}`, type: "mobile" },
      }),
      404,
      "PAIRING_NOT_FOUND",
      "过期配对 token claim",
    );

    // claimed 但已过期：新设备轮询必须 410，旧设备确认也必须 410。
    expectError(
      await pollPairingClaim(c, expired.claimed.id, expired.claimed.claimSecret),
      410,
      "PAIRING_EXPIRED",
      "过期配对轮询",
    );
    expectError(
      await confirmPairing(a, expired.claimed.id),
      410,
      "PAIRING_EXPIRED",
      "过期配对确认",
    );

    // 过期拒绝不能留下设备（也不能顺手创建什么）。
    const after = await listDevices(a);
    expect(after.devices.map((device) => device.id).sort()).toEqual(beforeIds);
  });

  test("2. 创建配对码：6 位数字 + 一次性 token + 10 分钟 TTL", async () => {
    const before = Date.now();
    const created = okData<PairingCreated>(await createPairing(a), 200, "创建配对码");
    const after = Date.now();

    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.token).not.toBe(created.code);
    expect(created.ttl).toBe(600_000);
    expect(created.expiresAt).toBeGreaterThanOrEqual(before + 600_000 - 2_000);
    expect(created.expiresAt).toBeLessThanOrEqual(after + 600_000 + 2_000);
    expect(created.origin).toBe(API_BASE);
    expect(created.qrUrl).toBe(`${API_BASE}/pair/#t=${encodeURIComponent(created.token)}`);

    // 响应里只能是短期配对凭证，不能顺手泄漏任何长期 Cookie。
    const rawCreated = JSON.stringify(created);
    expect(rawCreated).not.toContain("gauth_sid");
    expect(rawCreated).not.toContain("gauth_did");

    const list = okData<PairingList>(await listPairings(a), 200, "读取配对列表");
    const item = list.items.find((row) => row.id === created.pairingId);
    expect(item, "创建后配对必须出现在 GET /api/pairing").toBeTruthy();
    if (!item) throw new Error("配对列表缺少刚创建的配对项");
    expect(item.status).toBe("pending");
    expect(item.attempts).toBe(0);
    expect(item.maxAttempts).toBe(5);
    expect(item.target).toBeNull();
    expect(item.expired).toBe(false);
    expect(item.sourceDeviceId).toBe(A_DEVICE_ID);

    // 真实 10 分钟过期不等待（见文件头部说明与文档），这里只锁定 TTL 契约。
    cancelledPairing = created;
    test.info().annotations.push({
      type: "not-verified",
      description: "真实 10 分钟 TTL 到期未在 E2E 中等待验证；用取消路径 410 覆盖「失效后不能继续」的语义",
    });
  });

  test("3. 错误配对码：404 PAIRING_NOT_FOUND，不区分「不存在」与「已过期」", async () => {
    const result = await claimPairing(c, {
      code: "000000",
      device: { name: `${QA_DEVICE_PREFIX}wrong-${TAG}`, type: "mobile" },
    });
    const error = expectError(result, 404, "PAIRING_NOT_FOUND", "错误配对码");
    // 实现把「不存在 / 已过期」合并成同一句文案，避免暴露配对是否存在。
    expect(error.message).toContain("无效或已过期");
  });

  test("3b. 批准边界：同账号其他设备 403 WRONG_DEVICE、其他账号 404、claim 缺 Origin 403、超长 token 400", async () => {
    const created = okData<PairingCreated>(await createPairing(a), 200, "创建待审批配对");
    const claim = okData<PairingClaim>(
      await claimPairing(c, {
        code: created.code,
        device: { name: `${QA_DEVICE_PREFIX}wrongdev-${TAG}`, type: "mobile" },
      }),
      200,
      "C 认领待审批配对",
    );
    expect(claim.status).toBe("claimed");

    // A2 是同一账号（qa-p3-installer）的第二台已登录设备：session 有效，但不是配对发起设备。
    expectError(
      await confirmPairing(a2, created.pairingId),
      403,
      "WRONG_DEVICE",
      "同账号其他设备确认配对",
    );

    // 其他账号连配对是否存在都不该知道（404 而不是 403，避免泄漏配对 ID 是否有效）。
    expectError(
      await confirmPairing(outsider, created.pairingId),
      404,
      "PAIRING_NOT_FOUND",
      "其他账号确认配对",
    );

    // claim 也要过同源校验（Phase 3 修复的安全缺陷，这里锁住回归）。
    expectError(
      await api(c, "POST", "/api/pairing/claim", {
        body: { code: created.code, device: { name: `${QA_DEVICE_PREFIX}csrf-${TAG}`, type: "mobile" } },
        omitOrigin: true,
      }),
      403,
      "CSRF_REJECTED",
      "claim 缺少 Origin",
    );

    // 超长 token 在查库前就被拒绝（不消耗 attempts、不暴露配对是否存在）。
    expectError(await claimPairing(c, { token: "x".repeat(129) }), 400, "INVALID_TOKEN", "超长配对 token");

    // 收尾：取消后再轮询 410，且不会留下设备。
    okData(await cancelPairing(a, created.pairingId), 200, "取消待审批配对");
    expectError(
      await pollPairingClaim(c, created.pairingId, claim.claimSecret),
      410,
      "PAIRING_CANCELLED",
      "取消后轮询",
    );
  });

  test("3c. 设备上限：已满 10 台的账号确认第 11 台 → 409 DEVICE_LIMIT，不落设备", async () => {
    const before = await listDevices(crowded);
    // 不用 overview.activeDeviceCount：它按 5 分钟在线窗口算 presence，而夹具设备只 seed 一次、
    // 不发心跳；全量套件跑到这里可能已超过窗口。设备上限的判定依据是「未撤销设备数」，用 DB 状态断言。
    expect(before.devices.filter((device) => device.status === "active"), "crowded 夹具应预置 10 台未撤销设备").toHaveLength(10);

    const created = okData<PairingCreated>(await createPairing(crowded), 200, "已满设备账号创建配对");
    const claim = okData<PairingClaim>(
      await claimPairing(c, {
        code: created.code,
        device: { name: `${QA_DEVICE_PREFIX}limit-${TAG}`, type: "mobile" },
      }),
      200,
      "C 认领配对",
    );

    expectError(
      await confirmPairing(crowded, created.pairingId),
      409,
      "DEVICE_LIMIT",
      "超过设备上限确认配对",
    );

    const after = await listDevices(crowded);
    expect(after.devices.filter((device) => device.status === "active")).toHaveLength(10);
    expect(after.devices.some((device) => device.name.includes(`limit-${TAG}`))).toBe(false);

    // 超限拒绝后配对仍可取消，不留下悬挂的 pending / claimed。
    okData(await cancelPairing(crowded, created.pairingId), 200, "取消超限配对");
    expectError(
      await pollPairingClaim(c, created.pairingId, claim.claimSecret),
      410,
      "PAIRING_CANCELLED",
      "超限配对取消后轮询",
    );
  });

  test("4. 完整配对：claim → 确认（批准语义）→ 轮询领取独立 Session → 设备出现在旧设备列表", async () => {
    const created = okData<PairingCreated>(await createPairing(a), 200, "创建配对码");
    expect(created.pairingId).toBeTruthy();

    // 批准语义：没 claim 就 confirm → 409；别人不能 confirm → 404；无 Origin → 403。
    expectError(
      await confirmPairing(a, created.pairingId),
      409,
      "PAIRING_STATE",
      "未 claim 直接确认配对",
    );
    expectError(
      await confirmPairing(outsider, created.pairingId),
      404,
      "PAIRING_NOT_FOUND",
      "其他账号确认别人的配对",
    );
    expectError(
      await api(a, "POST", `/api/pairing/${created.pairingId}/confirm`, { omitOrigin: true }),
      403,
      "CSRF_REJECTED",
      "省略 Origin 确认配对",
    );

    // B 用 6 位码 claim；设备画像（type/browser/os）由 UA 推导。
    const claim = okData<PairingClaim>(
      await claimPairing(b, { code: created.code, device: { name: DEVICE_NAME, type: "mobile" } }),
      200,
      "新设备提交配对码",
    );
    expect(claim.pairingId).toBe(created.pairingId);
    expect(claim.status).toBe("claimed");
    expect(claim.device).toMatchObject({
      name: DEVICE_NAME,
      type: "mobile",
      browser: "Chrome",
      os: "Android",
    });
    expect(claim.source).toMatchObject({ name: "QA installer 设备", type: "desktop" });
    expect(claim.claimSecret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 字节 base64url
    expect(claim.expiresAt).toBe(created.expiresAt);

    // 确认前轮询：claimed / paired:false，此时不应下发任何 Session Cookie。
    const pendingPoll = okData(
      await pollPairingClaim(b, created.pairingId, claim.claimSecret),
      200,
      "确认前轮询",
    );
    expect(pendingPoll).toMatchObject({ status: "claimed", paired: false });

    // A 批准：confirm 绑定 A 自己的 session.deviceId，插入 devices 行。
    const confirmed = okData<ConfirmedResult>(
      await confirmPairing(a, created.pairingId),
      200,
      "旧设备确认配对",
    );
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.pairing.status).toBe("confirmed");
    expect(confirmed.device).toMatchObject({ name: DEVICE_NAME, type: "mobile" });
    bDeviceId = confirmed.device.id;
    expect(bDeviceId).toBeTruthy();

    // 新设备真正进入 A 的设备列表，且标记为受信任、非当前设备。
    const afterConfirm = await listDevices(a);
    const pairedDevice = afterConfirm.devices.find((device) => device.id === bDeviceId);
    expect(pairedDevice, "确认后新设备必须出现在旧设备的 GET /api/devices").toBeTruthy();
    expect(pairedDevice).toMatchObject({
      name: DEVICE_NAME,
      type: "mobile",
      browser: "Chrome",
      os: "Android",
      status: "active",
      trusted: true,
      isCurrent: false,
    });

    // 已确认不能再确认（批准是一次性的）。
    expectError(
      await confirmPairing(a, created.pairingId),
      409,
      "PAIRING_STATE",
      "重复确认配对",
    );

    // B 确认后轮询一次领取 Session（限流：只轮询这一次）。
    const pollResult = await pollPairingClaim(b, created.pairingId, claim.claimSecret);
    const completed = okData<{
      status: string;
      paired: boolean;
      deviceId: string;
      user: { displayName: string; githubUsername: string; avatarUrl: string | null };
    }>(pollResult, 200, "确认后轮询领取 Session");
    expect(completed).toMatchObject({ status: "completed", paired: true, deviceId: bDeviceId });
    expect(completed.user.githubUsername).toBe("qa-p3-installer");

    // 服务端下发的 Cookie 是 B 自己的，不是把 A 的 Cookie 发给 B。
    const bundle = pairingCookiesFrom(pollResult.response);
    expect(bundle.headers["x-pairing-cookie"]).toBe("gauth_sid");
    expect(bundle.headers["x-pairing-device-cookie"]).toBe("gauth_did");
    expect(bundle.setCookies).toHaveLength(2);
    for (const setCookie of bundle.setCookies) {
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("HttpOnly");
    }
    expect(bundle.session).toBeTruthy();
    expect(bundle.session).not.toBe(fixtures.tokens.installer);
    expect(bundle.device).toBe(bDeviceId);

    // 显式让 B Context 接管 Cookie（ctx.request 与浏览器共享 jar，这里动作可幂等重复）。
    await adoptCookies(b, bundle);
    const bCookiesAfter = await cookiesOf(b);
    expect(bCookiesAfter.session).toBe(bundle.session);
    expect(bCookiesAfter.device).toBe(bDeviceId);

    // B 用自己的新 Session 访问（/api/auth/me 不是信封格式，单独断言）。
    const me = await api(b, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.githubUsername).toBe("qa-p3-installer");
    expect(me.body.session.deviceId).toBe(bDeviceId);

    const bDevices = await listDevices(b);
    expect(bDevices.currentDeviceId).toBe(bDeviceId);
    expect(bDevices.devices.find((device) => device.id === bDeviceId)!.isCurrent).toBe(true);

    // 重放轮询：alreadyDelivered，且不重复下发 Cookie（避免 Session 被无限签发）。
    const replay = await pollPairingClaim(b, created.pairingId, claim.claimSecret);
    const replayBody = okData(replay, 200, "重放轮询");
    expect(replayBody).toMatchObject({ status: "completed", paired: true, alreadyDelivered: true });
    expect(
      replay.response.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie"),
    ).toHaveLength(0);

    // 配对码不能重复使用：completed 之后再 claim 同码 → 404。
    expectError(
      await claimPairing(c, {
        code: created.code,
        device: { name: `${QA_DEVICE_PREFIX}reuse-${TAG}`, type: "mobile" },
      }),
      404,
      "PAIRING_NOT_FOUND",
      "已完成配对码重复使用",
    );
  });

  test("5. 取消配对：cancelled 后轮询 410、确认 409，未确认设备收不到接力", async () => {
    // 复用 T2 创建、仍未 claim 的配对（省一个 pairing-create 配额）。
    const created = cancelledPairing;
    expect(created, "T2 应已创建可取消的配对").toBeTruthy();

    const claim = okData<PairingClaim>(
      await claimPairing(c, {
        code: created.code,
        device: { name: `${QA_DEVICE_PREFIX}cancel-${TAG}`, type: "mobile" },
      }),
      200,
      "C 提交待取消的配对码",
    );
    expect(claim.status).toBe("claimed");

    // C 只是 claim 了，还没被 A 批准：不能接收接力，也还没有 Session。
    const cCookies = await cookiesOf(c);
    expect(cCookies.session, "claim 不会下发 Session Cookie").toBeNull();
    expectError(
      await continuityInbox(c),
      401,
      "UNAUTHENTICATED",
      "未批准设备读取接力收件箱",
    );

    const cancelled = okData(await cancelPairing(a, created.pairingId), 200, "取消配对");
    expect(cancelled.cancelled).toBe(true);

    // 取消后轮询：410 PAIRING_CANCELLED（这是「失效后不能继续」的真实路径）。
    expectError(
      await pollPairingClaim(c, created.pairingId, claim.claimSecret),
      410,
      "PAIRING_CANCELLED",
      "取消后轮询",
    );

    // 已取消的配对不能再被确认。
    expectError(
      await confirmPairing(a, created.pairingId),
      409,
      "PAIRING_STATE",
      "确认已取消的配对",
    );
  });

  test("6. 接力状态机：pending → delivered → opened → completed，非目标设备不可操作", async () => {
    const title = `qa-dp-relay-${TAG}`;
    const sent = okData<{
      id: string;
      itemType: string;
      targetDeviceId: string;
      targetName: string;
      ttl: number;
    }>(
      await sendContinuity(a, {
        itemType: "link",
        title,
        payload: { url: "https://example.invalid/qa-dp-relay" },
        targetDeviceId: bDeviceId,
      }),
      201,
      "旧设备发送接力",
    );
    expect(sent).toMatchObject({
      itemType: "link",
      targetDeviceId: bDeviceId,
      targetName: DEVICE_NAME,
      ttl: 72 * 60 * 60 * 1000,
    });
    const itemId = sent.id;

    // 发给 B 的条目不会出现在 A 的收件箱，但会出现在 A 的历史里（outgoing）。
    const aInbox = okData<ContinuityInbox>(await continuityInbox(a), 200, "旧设备收件箱");
    expect(aInbox.items.some((item) => item.id === itemId), "A 的收件箱不应出现发给 B 的条目").toBe(false);
    const aHistoryBefore = okData<ContinuityInbox>(await continuityHistory(a), 200, "旧设备接力历史");
    const historyItem = aHistoryBefore.items.find((item) => item.id === itemId);
    expect(historyItem, "A 的历史应包含刚发出的接力").toBeTruthy();
    expect(historyItem!.status).toBe("pending");
    expect(historyItem!.outgoing).toBe(true);
    expect(historyItem!.sourceDeviceId).toBe(A_DEVICE_ID);

    // 非目标设备 open → 403 NOT_TARGET。
    expectError(await openContinuity(a, itemId), 403, "NOT_TARGET", "源设备打开发给目标的接力");

    // B 的收件箱把 pending 领取成 delivered。
    const bInbox = okData<ContinuityInbox>(await continuityInbox(b), 200, "新设备收件箱");
    const delivered = bInbox.items.find((item) => item.id === itemId);
    expect(delivered, "B 的收件箱应包含发给它的接力").toBeTruthy();
    expect(delivered!.status).toBe("delivered");
    expect(delivered!.deliveredAt).toBeGreaterThan(0);
    expect(delivered!.outgoing).toBe(false);
    expect(delivered!.sourceName).toBe("QA installer 设备");
    expect(delivered!.payload).toEqual({ url: "https://example.invalid/qa-dp-relay" });

    // open → opened。
    const opened = okData<{ item: { status: string; openedAt: number | null } }>(
      await openContinuity(b, itemId),
      200,
      "新设备打开接力",
    );
    expect(opened.item.status).toBe("opened");
    // 注意：open 响应体是「更新前那一行」的映射，openedAt 仍为 null（handler 细节）；
    // 以随后的收件箱读取（真实 DB 行）为准，断言 openedAt 已落库。
    const bInboxOpened = okData<ContinuityInbox>(await continuityInbox(b), 200, "新设备收件箱（已打开）");
    const openedItem = bInboxOpened.items.find((item) => item.id === itemId);
    expect(openedItem, "打开后条目仍应在收件箱").toBeTruthy();
    expect(openedItem!.status).toBe("opened");
    expect(openedItem!.openedAt).toBeGreaterThan(0);

    // complete → completed，且从「待处理」收件箱消失。
    const completed = okData(await completeContinuity(b, itemId), 200, "新设备完成接力");
    expect(completed.completed).toBe(true);
    const bInboxAfterComplete = okData<ContinuityInbox>(
      await continuityInbox(b),
      200,
      "新设备收件箱（已完成）",
    );
    expect(bInboxAfterComplete.items.some((item) => item.id === itemId)).toBe(false);

    const aHistoryAfter = okData<ContinuityInbox>(await continuityHistory(a), 200, "旧设备接力历史（已完成）");
    const completedItem = aHistoryAfter.items.find((item) => item.id === itemId);
    expect(completedItem!.status).toBe("completed");
    expect(completedItem!.completedAt).toBeGreaterThan(0);
  });

  test("7. 接力错误码：SELF_TARGET / TARGET_NOT_FOUND / INVALID_TYPE / PAYLOAD_TOO_LARGE / 取消语义", async () => {
    expectError(
      await sendContinuity(a, { itemType: "note", targetDeviceId: A_DEVICE_ID }),
      400,
      "SELF_TARGET",
      "发送给自己",
    );
    expectError(
      await sendContinuity(a, { itemType: "note", targetDeviceId: outsiderDeviceId }),
      404,
      "TARGET_NOT_FOUND",
      "发送给其他账号的设备",
    );
    // 任务背景写的是 kind，实现字段是 itemType；这里锁定真实契约。
    expectError(
      await sendContinuity(a, { itemType: "kind", targetDeviceId: bDeviceId }),
      400,
      "INVALID_TYPE",
      "非法 itemType",
    );
    expectError(
      await sendContinuity(a, {
        itemType: "note",
        payload: { blob: "x".repeat(33 * 1024) },
        targetDeviceId: bDeviceId,
      }),
      413,
      "PAYLOAD_TOO_LARGE",
      "超大 payload",
    );

    // 取消路径：pending 可取消；取消后 B open 得 410；再次取消得 409。
    const cancellable = okData<{ id: string }>(
      await sendContinuity(a, {
        itemType: "task",
        title: `qa-dp-cancel-relay-${TAG}`,
        targetDeviceId: bDeviceId,
      }),
      201,
      "发送待取消接力",
    );
    const cancelled = okData(await cancelContinuity(a, cancellable.id), 200, "取消接力");
    expect(cancelled.cancelled).toBe(true);
    expectError(await openContinuity(b, cancellable.id), 410, "EXPIRED", "打开已取消的接力");
    expectError(
      await cancelContinuity(a, cancellable.id),
      409,
      "NOT_CANCELLABLE",
      "重复取消接力",
    );

    // C 从未配对成功：收件箱仍是 401（未配对设备不能接收接力）。
    expectError(await continuityInbox(c), 401, "UNAUTHENTICATED", "未配对设备读取接力收件箱");
  });

  test("8. 剪贴板：A→B 定向投递、账号隔离、4000 字符上限", async () => {
    const marker = `qa-clipboard-${TAG}`;
    const sent = okData<{ id: string; ttl: number }>(
      await sendClipboard(a, { content: marker, targetDeviceId: bDeviceId }),
      201,
      "发送剪贴板",
    );
    expect(sent.ttl).toBe(24 * 60 * 60 * 1000);

    // B 能看到，且来源/目标标记正确。
    const bList = okData<ClipboardList>(await listClipboard(b), 200, "新设备剪贴板");
    const entry = bList.items.find((item) => item.content === marker);
    expect(entry, "B 的剪贴板应包含 A 发来的内容").toBeTruthy();
    expect(entry).toMatchObject({
      sourceName: "QA installer 设备",
      outgoing: false,
      targetDeviceId: bDeviceId,
    });

    // A（发送方）和 outsider（另一个账号）都看不到定向内容。
    const aList = okData<ClipboardList>(await listClipboard(a), 200, "旧设备剪贴板");
    expect(aList.items.some((item) => item.content === marker)).toBe(false);
    const outsiderList = okData<ClipboardList>(await listClipboard(outsider), 200, "其他账号剪贴板");
    expect(outsiderList.items.some((item) => item.content === marker)).toBe(false);

    // 其他账号不能删除。
    expectError(await deleteClipboard(outsider, sent.id), 404, "NOT_FOUND", "其他账号删除剪贴板");

    // 4000 字符硬上限（测试文本固定无意义，不写任何真实内容）。
    const longContent = marker.padEnd(4_001, "x");
    expect(longContent.length).toBe(4_001);
    expectError(
      await sendClipboard(a, { content: longContent, targetDeviceId: bDeviceId }),
      413,
      "CONTENT_TOO_LONG",
      "超长剪贴板",
    );
    expectError(
      await sendClipboard(a, { content: "   ", targetDeviceId: bDeviceId }),
      400,
      "EMPTY_CONTENT",
      "空白剪贴板",
    );
    expectError(
      await sendClipboard(a, { content: `${marker}-foreign`, targetDeviceId: outsiderDeviceId }),
      404,
      "TARGET_NOT_FOUND",
      "剪贴板发往其他账号设备",
    );

    // 软删除后 B 也看不到了。
    const deleted = okData(await deleteClipboard(a, sent.id), 200, "删除剪贴板");
    expect(deleted.deleted).toBe(true);
    const bListAfter = okData<ClipboardList>(await listClipboard(b), 200, "新设备剪贴板（已删除）");
    expect(bListAfter.items.some((item) => item.content === marker)).toBe(false);
  });

  test("9. 撤销设备：outsider 无权撤销、当前设备不可撤销、撤销后 B 的请求全部 401", async () => {
    // 不能撤销别人的设备。
    expectError(await revokeDevice(outsider, bDeviceId), 404, "NOT_FOUND", "其他账号撤销设备");
    // 不能撤销自己当前正在使用的设备。
    expectError(
      await revokeDevice(a, A_DEVICE_ID),
      400,
      "CANNOT_REVOKE_CURRENT",
      "撤销当前设备",
    );

    const revoked = okData(await revokeDevice(a, bDeviceId), 200, "旧设备撤销新设备");
    expect(revoked).toMatchObject({ revoked: true, deviceId: bDeviceId });
    expect(revoked.revokedSessions).toBeGreaterThanOrEqual(1);

    // B 的 Session 随设备一起失效：后续受保护请求都是 401。
    // 3.3 起 devices / continuity / clipboard / pairing 共用 guards.sessionFailure，
    // 撤销原因在四个业务面上保持一致（SESSION_REVOKED；设备维度的 DEVICE_REVOKED 作为兜底）。
    const revokedChecks = [
      { path: "/api/devices", codes: ["SESSION_REVOKED", "DEVICE_REVOKED"] },
      { path: "/api/continuity/inbox", codes: ["SESSION_REVOKED", "DEVICE_REVOKED"] },
      { path: "/api/clipboard", codes: ["SESSION_REVOKED", "DEVICE_REVOKED"] },
      { path: "/api/pairing", codes: ["SESSION_REVOKED", "DEVICE_REVOKED"] },
    ];
    for (const { path, codes } of revokedChecks) {
      const result = await api(b, "GET", path);
      expect(result.status, `${path} 应返回 401`).toBe(401);
      expect(codes, `${path} 撤销后的错误码`).toContain(result.body?.error?.code);
    }

    // A 侧能看到 revoked 标记和撤销时间，A 自己不受影响。
    const devicesAfterRevoke = await listDevices(a);
    const revokedDevice = devicesAfterRevoke.devices.find((device) => device.id === bDeviceId);
    expect(revokedDevice).toBeTruthy();
    expect(revokedDevice!.status).toBe("revoked");
    expect(revokedDevice!.revokedAt).not.toBeNull();
    expect(devicesAfterRevoke.currentDeviceId).toBe(A_DEVICE_ID);

    // afterAll 会再次撤销（alreadyRevoked），不影响结果。
  });
});