/**
 * 插件沙箱安全检查（1.9）
 *
 * 直接加载 /sandbox/runner.html，验证 1.9 新增的握手校验：
 *   1. 没有 nonce 的 MOUNT 必须被拒绝（不会创建插件 iframe，也不会交出端口）；
 *   2. 带正确 nonce 的 MOUNT 才能挂载；
 *   3. 插件文档的策略里没有网络出口（CSP 由 worker 注入，这里只校验
 *      runner 发出的注入配置与 iframe 的 sandbox 属性）。
 *
 * 说明：这套测试不需要 Worker，因为 runner 本身是静态资源。
 */
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __sandboxEvents: Array<{ kind?: string; nonce?: string }>;
  }
}

/** 载入 runner，并收集它发回宿主的消息 */
async function loadRunner(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/sandbox/runner.html", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__sandboxEvents = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { kind?: string; nonce?: string };
      if (data && typeof data === "object") window.__sandboxEvents.push(data);
    });
  });
  // HELLO 会在脚本执行时立即发出，刷新后可能错过；等待页面里的 iframe 计数稳定即可
  await page.waitForTimeout(200);
}

test.describe("插件沙箱", () => {
  test("缺少 nonce 的 MOUNT 被拒绝", async ({ page }) => {
    await loadRunner(page);
    const frames = await page.evaluate(async () => {
      const channel = new MessageChannel();
      const html = "<!doctype html><html><body><p id='p'>plugin</p></body></html>";
      window.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          pluginId: "com.example.test",
          html,
          sdk: "window.__sdk = 1;",
          granted: [],
        },
        "*",
        [channel.port2],
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      return document.querySelectorAll("iframe").length;
    });
    expect(frames).toBe(0);
  });

  test("带正确 nonce 的 MOUNT 才会创建插件 iframe", async ({ page }) => {
    await page.goto("/sandbox/runner.html", { waitUntil: "domcontentloaded" });
    // 从 runner 自己的 HELLO 里拿 nonce：重载后监听最早的一条消息
    const nonce = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve(""), 2000);
          window.addEventListener("message", (event) => {
            const data = event.data as { kind?: string; nonce?: string };
            if (data?.kind === "HELLO" && data.nonce) {
              clearTimeout(timer);
              resolve(String(data.nonce));
            }
          });
        }),
    );
    // 如果 HELLO 在监听器挂上之前就发出了，直接读页面里的实现细节是不可行的；
    // 这种情况下用一次可控的重新触发：重新加载页面并在 DOMContentLoaded 前注入监听。
    const resolved = nonce || (await readNonceByReload(page));
    expect(resolved).not.toBe("");

    const mounted = await page.evaluate(async (handshake) => {
      const channel = new MessageChannel();
      const html = "<!doctype html><html><body><p>ok</p></body></html>";
      const ready = new Promise<boolean>((resolve) => {
        channel.port1.onmessage = (event) => {
          const data = event.data as { kind?: string };
          if (data?.kind === "READY") resolve(true);
        };
        setTimeout(() => resolve(false), 3000);
      });
      channel.port1.start();
      window.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          pluginId: "com.example.test",
          nonce: handshake,
          html,
          sdk: "window.__sdk = 1;",
          granted: [],
        },
        "*",
        [channel.port2],
      );
      const ok = await ready;
      return { ok, frames: document.querySelectorAll("iframe").length };
    }, resolved);

    expect(mounted.ok).toBe(true);
    expect(mounted.frames).toBe(1);
  });

  test("插件 iframe 使用 sandbox=allow-scripts，且没有 allow-same-origin", async ({ page }) => {
    // 直接检查 runner 生成的 iframe 属性：通过带 nonce 的挂载流程
    await page.goto("/sandbox/runner.html", { waitUntil: "domcontentloaded" });
    const nonce = await readNonceByReload(page);
    expect(nonce).not.toBe("");

    const attributes = await page.evaluate(async (handshake) => {
      const channel = new MessageChannel();
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = () => resolve();
        setTimeout(resolve, 3000);
      });
      channel.port1.start();
      window.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          pluginId: "com.example.attrs",
          nonce: handshake,
          html: "<!doctype html><html><body>attrs</body></html>",
          sdk: "window.__sdk = 1;",
          granted: [],
        },
        "*",
        [channel.port2],
      );
      await ready;
      const frame = document.querySelector("iframe");
      return frame ? frame.getAttribute("sandbox") : null;
    }, nonce);

    expect(attributes).toBe("allow-scripts");
    expect(attributes).not.toContain("allow-same-origin");
  });

  /* ---------------------------------------------------------------------- */
  /* 以下为 Phase 3.2 补充的静态 / 运行时断言（不依赖 Worker）                  */
  /* ---------------------------------------------------------------------- */

  test("runner 源码里的插件 CSP 没有任何网络出口，并包含导航逃逸处理", async ({ page }) => {
    const response = await page.request.get("http://127.0.0.1:4399/sandbox/runner.html");
    expect(response.status()).toBe(200);
    const source = await response.text();

    // 插件文档 CSP：默认拒绝、无网络、无表单、无 <base>、无子 frame
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("frame-src 'none'");
    expect(source).toContain("base-uri 'none'");
    expect(source).toContain("form-action 'none'");

    // 导航逃逸只能事后检测：第二次 load 上报告并强制终止
    expect(source).toContain("sandbox:navigation");
    expect(source).toContain('location.replace("about:blank")');
    expect(source).toContain("沙箱握手校验失败");
  });

  test("runner 只给插件 iframe 授予 allow-scripts，不授予其余 allow-* 能力", async ({ page }) => {
    const response = await page.request.get("http://127.0.0.1:4399/sandbox/runner.html");
    const source = await response.text();
    const sandboxValues = Array.from(source.matchAll(/setAttribute\(\s*["']sandbox["']\s*,\s*["']([^"']*)["']\s*\)/g)).map(
      (match) => match[1],
    );
    expect(sandboxValues.length).toBeGreaterThan(0);
    for (const value of sandboxValues) expect(value).toBe("allow-scripts");

    // 注释里为了解释原因提到过 allow-same-origin，这里只检查可执行代码
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const token of [
      "allow-same-origin",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-top-navigation",
      "allow-downloads",
    ]) {
      expect(code).not.toContain(token);
    }
  });

  test("插件文档在运行时是 opaque origin：localStorage / Cookie / 父文档都不可访问", async ({ page }) => {
    await page.goto("/sandbox/runner.html", { waitUntil: "domcontentloaded" });
    const nonce = await readNonceByReload(page);
    expect(nonce).not.toBe("");

    await page.evaluate(async (handshake) => {
      const channel = new MessageChannel();
      const ready = new Promise<boolean>((resolve) => {
        channel.port1.onmessage = () => resolve(true);
        setTimeout(() => resolve(false), 3000);
      });
      channel.port1.start();
      window.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          pluginId: "com.example.isolation",
          nonce: handshake,
          html: "<!doctype html><html><body><p>isolation</p></body></html>",
          sdk: "window.__sdk = 1;",
          granted: [],
        },
        "*",
        [channel.port2],
      );
      await ready;
    }, nonce);

    const isPluginFrame = (url: string) => url.startsWith("blob:") || url === "about:srcdoc";
    await expect
      .poll(() => page.frames().filter((frame) => frame !== page.mainFrame() && isPluginFrame(frame.url())).length, {
        timeout: 10_000,
        message: "插件 iframe 未出现",
      })
      .toBe(1);
    const pluginFrame = page.frames().find((frame) => frame !== page.mainFrame() && isPluginFrame(frame.url()))!;

    const isolation = await pluginFrame.evaluate(() => {
      const attempt = (fn: () => unknown): { ok: boolean; name?: string } => {
        try {
          fn();
          return { ok: true };
        } catch (error) {
          return { ok: false, name: (error as { name?: string }).name ?? "Error" };
        }
      };
      return {
        origin: window.origin,
        localStorage: attempt(() => window.localStorage.getItem("guandao.plugins.v1")),
        cookie: attempt(() => document.cookie),
        parentDocument: attempt(() => window.parent.document.documentElement.outerHTML.slice(0, 16)),
        prelude: (window as unknown as { __sdk?: unknown }).__sdk,
      };
    });

    // iframe 是 opaque origin（sandbox 没有 allow-same-origin），读宿主存储/Cookie/父文档都会抛 SecurityError
    expect(isolation.origin).toBe("null");
    expect(isolation.localStorage.ok).toBe(false);
    expect(isolation.localStorage.name).toBe("SecurityError");
    expect(isolation.cookie.ok).toBe(false);
    expect(isolation.cookie.name).toBe("SecurityError");
    expect(isolation.parentDocument.ok).toBe(false);
    expect(isolation.parentDocument.name).toBe("SecurityError");
    // SDK 预置脚本仍然注入成功（这里用 window.__sdk 标记），说明隔离的是 DOM/存储而不是 API 通道
    expect(isolation.prelude).toBe(1);
  });
});

/**
 * 重新加载页面并在脚本执行前注册监听，拿到 runner 发出的 nonce。
 * 用 addInitScript 保证监听在页面脚本之前生效。
 */
async function readNonceByReload(page: import("@playwright/test").Page): Promise<string> {
  await page.addInitScript(() => {
    (window as unknown as { __nonce?: string }).__nonce = undefined;
    window.addEventListener("message", (event) => {
      const data = event.data as { kind?: string; nonce?: string };
      if (data?.kind === "HELLO" && data.nonce) (window as unknown as { __nonce?: string }).__nonce = String(data.nonce);
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((window as unknown as { __nonce?: string }).__nonce), null, { timeout: 5000 });
  return page.evaluate(() => (window as unknown as { __nonce?: string }).__nonce ?? "");
}