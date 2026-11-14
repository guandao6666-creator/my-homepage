/**
 * 沙箱独立 Origin · 本地两源隔离实测（Phase 3.2 / 3.3 审计后补齐）
 *
 * 背景：当前生产布局里，插件宿主 iframe 与沙箱 runner 都来自同一站点，靠
 * `sandbox="allow-scripts"` 得到不透明 Origin。本文档用**两个真实浏览器 Origin**
 * 验证「独立 Sandbox Origin」方案的隔离效果：
 *   - 宿主页：`http://127.0.0.1:8788`（真实 Worker，本地 D1/R2）
 *   - 沙箱源：`http://127.0.0.1:4399`（dist/ 静态服务器，由 Playwright webServer 启动）
 * 两个 Origin 端口不同 → 浏览器按不同 Origin 处理（Cookie、localStorage、IndexedDB、
 * postMessage 的 event.origin 全部独立）。这是真实浏览器行为验证，不是 mock。
 *
 * 生产环境若采用方案 B（真正独立 Sandbox Origin），需要额外 DNS/Worker/域名资源，
 * 本阶段**没有创建**；本 spec 只证明隔离语义，不等同于生产部署。
 */

import { expect, test, type Frame } from "@playwright/test";

import { API_BASE } from "./support/worker-api";

const HOST_ORIGIN = API_BASE.replace(/\/+$/, "");
const SANDBOX_ORIGIN = (process.env.E2E_SANDBOX_ORIGIN || "http://127.0.0.1:4399").replace(/\/+$/, "");
const MARKER = "host-storage-marker";
const RUNNER_PATH = "/sandbox/runner";

type Probe = {
  /** `window.origin`：不透明 Origin 会序列化为 "null"（`location.origin` 仍返回 URL 的源）。 */
  origin: string;
  locationOrigin: string;
  cookie: string;
  cookieError: string | null;
  localStorageValue: string | null;
  localStorageError: string | null;
  parentStorage: string | null;
  parentDocument: string | null;
  fetchHost: string;
};

async function probeFrame(frame: Frame): Promise<Probe> {
  return frame.evaluate(async (host: string) => {
    const result: Record<string, unknown> = {
      origin: window.origin,
      locationOrigin: location.origin,
      cookie: "",
      cookieError: null,
      localStorageValue: null,
      localStorageError: null,
      parentStorage: null,
      parentDocument: null,
      fetchHost: "",
    };
    try {
      // 不透明 Origin 的沙箱文档连读取 document.cookie 都会抛 SecurityError。
      result.cookie = document.cookie;
    } catch (error) {
      result.cookieError = (error as Error).name;
    }
    try {
      result.localStorageValue = localStorage.getItem("host-storage-marker");
    } catch (error) {
      result.localStorageError = (error as Error).name;
    }
    try {
      result.parentStorage = (parent as WindowProxy & { localStorage: Storage }).localStorage.getItem(
        "host-storage-marker",
      );
    } catch (error) {
      result.parentStorage = `ERR:${(error as Error).name}`;
    }
    try {
      result.parentDocument = (parent as WindowProxy & { document: Document }).document.title || "(empty)";
    } catch (error) {
      result.parentDocument = `ERR:${(error as Error).name}`;
    }
    try {
      const response = await fetch(`${host}/api/auth/me`, { credentials: "include" });
      result.fetchHost = `status:${response.status}`;
    } catch (error) {
      result.fetchHost = `ERR:${(error as Error).name}`;
    }
    return result as unknown as Probe;
  }, HOST_ORIGIN);
}

async function waitForFrame(page: import("@playwright/test").Page, prefix: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      () => {
        found = page.frames().find((frame) => frame.url().startsWith(prefix));
        return Boolean(found);
      },
      { timeout: 20_000, message: `等待 frame：${prefix}` },
    )
    .toBe(true);
  if (!found) throw new Error(`frame 未出现：${prefix}`);
  return found;
}

test.describe("沙箱独立 Origin 隔离（本地两源真实浏览器实测）", () => {
  test("独立 Origin 与同源沙箱的隔离效果可被真实浏览器证明", async ({ page }) => {
    expect(new URL(SANDBOX_ORIGIN).origin, "宿主与沙箱源必须是两个 Origin").not.toBe(
      new URL(HOST_ORIGIN).origin,
    );

    // 宿主页用 /api/health（JSON，不带 CSP），保证 Origin 是真实 Worker 源且能创建跨源 iframe。
    await page.goto(`${HOST_ORIGIN}/api/health`);
    await page.evaluate((marker) => {
      localStorage.setItem(marker, "host-secret");
      document.cookie = `host_cookie=${marker}; path=/`;
      (window as unknown as { __probeMessages: unknown[] }).__probeMessages = [];
      window.addEventListener("message", (event) => {
        (window as unknown as { __probeMessages: unknown[] }).__probeMessages.push({
          data: event.data,
          origin: event.origin,
        });
      });
    }, MARKER);
    const hostCookies = await page.evaluate(() => document.cookie);
    expect(hostCookies).toContain(`host_cookie=${MARKER}`);

    // 对照组：同源 srcdoc iframe（不加 sandbox）必须能读到宿主 localStorage；
    // 否则说明探针本身无效，后面的 SecurityError 不能作为隔离证据。
    await page.evaluate((marker) => {
      const control = document.createElement("iframe");
      control.id = "control";
      control.srcdoc =
        "<script>window.addEventListener('load', function () {" +
        "var value; try { value = parent.localStorage.getItem(" +
        JSON.stringify(marker) +
        "); } catch (e) { value = 'ERR:' + e.name; }" +
        "parent.postMessage({ kind: 'control', value: value, sameOrigin: parent.location.href }, '*');" +
        "});<" +
        "/script>";
      document.body.appendChild(control);
    }, MARKER);
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as unknown as { __probeMessages: Array<{ data?: { kind?: string; value?: string } }> }).__probeMessages.find(
              (item) => item.data?.kind === "control",
            ),
          ),
        { timeout: 10_000, message: "同源对照组 iframe 未响应" },
      )
      .toBeTruthy();
    const control = await page.evaluate(() =>
      (window as unknown as { __probeMessages: Array<{ data?: { kind?: string; value?: string; sameOrigin?: string } }> }).__probeMessages.find(
        (item) => item.data?.kind === "control",
      ),
    );
    expect(control?.data?.value, "同源未沙箱 iframe 应能读取宿主 localStorage").toBe("host-secret");

    // 创建三个 iframe：
    //   1) 当前生产模型（宿主同源 + sandbox="allow-scripts"）
    //   2) 独立沙箱源，**故意不加 sandbox**（验证纵深防御：Origin 隔离本身是否足够）
    //   3) 独立沙箱源 + sandbox="allow-scripts"（目标形态）
    await page.evaluate(
      ({ host, sandbox, path }) => {
        const add = (id: string, src: string, sandboxAttr: string | null) => {
          const frame = document.createElement("iframe");
          frame.id = id;
          frame.src = src;
          if (sandboxAttr) frame.setAttribute("sandbox", sandboxAttr);
          frame.style.width = "360px";
          frame.style.height = "240px";
          document.body.appendChild(frame);
        };
        add("host-sandboxed", `${host}${path}`, "allow-scripts");
        add("sandbox-plain", `${sandbox}${path}`, null);
        add("sandbox-sandboxed", `${sandbox}${path}`, "allow-scripts");
      },
      { host: HOST_ORIGIN, sandbox: SANDBOX_ORIGIN, path: RUNNER_PATH },
    );

    const hostFrame = await waitForFrame(page, `${HOST_ORIGIN}${RUNNER_PATH}`);
    const plainFrame = await waitForFrame(page, `${SANDBOX_ORIGIN}${RUNNER_PATH}`);
    const sandboxedFrame = page
      .frames()
      .filter((frame) => frame.url().startsWith(`${SANDBOX_ORIGIN}${RUNNER_PATH}`))
      .at(-1);
    if (!sandboxedFrame) throw new Error("第二个沙箱源 iframe 未出现");

    // ---- 1) 当前生产模型：同源 iframe + sandbox="allow-scripts"（不透明 Origin）----
    const hostProbe = await probeFrame(hostFrame);
    expect(hostProbe.origin, "沙箱化同源 iframe 的 window.origin 必须是不透明 Origin").toBe("null");
    expect(hostProbe.locationOrigin, "location.origin 只反映 URL 的源，不能用来判定沙箱").toBe(
      new URL(HOST_ORIGIN).origin,
    );
    expect(hostProbe.localStorageError, "不透明 Origin 访问 localStorage 必须抛 SecurityError").toBe(
      "SecurityError",
    );
    expect(hostProbe.cookie, "不透明 Origin 读不到宿主 Cookie").toBe("");
    expect(hostProbe.cookieError, "不透明 Origin 连读取 document.cookie 都会被拒").toBe("SecurityError");
    expect(hostProbe.parentStorage).toMatch(/^ERR:SecurityError$/);
    expect(hostProbe.parentDocument).toMatch(/^ERR:SecurityError$/);
    expect(hostProbe.fetchHost, "沙箱帧不能直接调用宿主 API").toMatch(/^ERR:/);

    // ---- 2) 独立沙箱源 + 故意不加 sandbox：纵深防御 ----
    const plainProbe = await probeFrame(plainFrame);
    expect(plainProbe.origin, "未沙箱的独立源 iframe 是正常的沙箱源 Origin").toBe(new URL(SANDBOX_ORIGIN).origin);
    expect(plainProbe.localStorageValue, "不同 Origin 的 localStorage 互相不可见").toBeNull();
    expect(plainProbe.localStorageError, "独立源自身 localStorage 可用，只是内容为空").toBeNull();
    // 重要发现：Cookie 的作用域是 host（RFC 6265 忽略端口），仅换端口不会隔离 Cookie。
    // 生产若要求 Cookie 级隔离，必须使用不同 host（例如 sandbox.guandao.xin），见 PLUGIN-SANDBOX.md。
    expect(plainProbe.cookie, "同 host 不同端口仍然共享 Cookie（端口不隔离 Cookie）").toBe(
      `host_cookie=${MARKER}`,
    );
    expect(plainProbe.cookieError, "未沙箱帧可以正常读取自己的 Cookie").toBeNull();
    expect(plainProbe.parentStorage).toMatch(/^ERR:SecurityError$/);
    expect(plainProbe.parentDocument).toMatch(/^ERR:SecurityError$/);
    expect(plainProbe.fetchHost, "即使丢失 sandbox 属性，跨源读取宿主 API 仍被浏览器 CORS 拦截").toMatch(/^ERR:/);

    // ---- 3) 独立沙箱源 + sandbox="allow-scripts"：目标形态 ----
    const sandboxedProbe = await probeFrame(sandboxedFrame);
    expect(sandboxedProbe.origin).toBe("null");
    expect(sandboxedProbe.localStorageError).toBe("SecurityError");
    expect(sandboxedProbe.cookieError).toBe("SecurityError");
    expect(sandboxedProbe.parentStorage).toMatch(/^ERR:SecurityError$/);
    expect(sandboxedProbe.fetchHost).toMatch(/^ERR:/);

    // ---- 4) postMessage 的 event.origin 语义 ----
    await plainFrame.evaluate(() => {
      parent.postMessage({ kind: "origin-probe", from: "plain" }, "*");
    });
    await sandboxedFrame.evaluate(() => {
      parent.postMessage({ kind: "origin-probe", from: "sandboxed" }, "*");
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as { __probeMessages: Array<{ data?: { kind?: string; from?: string }; origin: string }> }).__probeMessages.filter(
              (item) => item.data?.kind === "origin-probe",
            ).length,
          ),
        { timeout: 10_000 },
      )
      .toBe(2);
    const origins = await page.evaluate(() =>
      (window as unknown as { __probeMessages: Array<{ data?: { kind?: string; from?: string }; origin: string }> }).__probeMessages
        .filter((item) => item.data?.kind === "origin-probe")
        .map((item) => ({ from: item.data?.from, origin: item.origin })),
    );
    const plainMessage = origins.find((item) => item.from === "plain");
    const sandboxedMessage = origins.find((item) => item.from === "sandboxed");
    expect(plainMessage?.origin, "独立源 iframe 的消息 origin 是真实沙箱源").toBe(new URL(SANDBOX_ORIGIN).origin);
    expect(sandboxedMessage?.origin, "沙箱化 iframe 的消息 origin 只能序列化为 null").toBe("null");
  });
});