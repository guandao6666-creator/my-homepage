/**
 * PWA 注册与更新提示。
 *
 * 边界：
 *   * Service Worker 只缓存静态外壳与公开图片，从不缓存 /api/*；
 *   * 更新提示由 waiting worker 触发，用户点击后才 reload；
 *   * 没有注册成功时静默降级，不影响桌面使用。
 */

const UPDATE_EVENT = "guandao:pwa-update";

function showUpdateToast(onReload: () => void) {
  if (document.getElementById("pwa-update")) return;
  const node = document.createElement("div");
  node.id = "pwa-update";
  node.className = "pwa-update";
  node.innerHTML = `
    <div class="pwa-update-text"><b>新版本已就绪</b><span>刷新后使用最新的 Guandao OS。</span></div>
    <button type="button" data-pwa-reload>立即刷新</button>
    <button type="button" class="pwa-update-close" data-pwa-close aria-label="稍后">×</button>`;
  document.body.appendChild(node);
  node.querySelector("[data-pwa-reload]")?.addEventListener("click", onReload);
  node.querySelector("[data-pwa-close]")?.addEventListener("click", () => node.remove());
}

export function initPwa() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    // SW 只在安全上下文注册；本地 http 预览没有 SW 属于预期。
    return;
  }

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

      const prompt = (worker: ServiceWorker | null) => {
        if (!worker) return;
        window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
        showUpdateToast(() => {
          worker.postMessage({ type: "SKIP_WAITING" });
          window.setTimeout(() => window.location.reload(), 120);
        });
      };

      if (registration.waiting && navigator.serviceWorker.controller) prompt(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) prompt(worker);
        });
      });

      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        // 首次安装也会触发 controllerchange，只有已有 controller 时才刷新。
        if (sessionStorage.getItem("guandao.pwa.reloaded") === "1") return;
        sessionStorage.setItem("guandao.pwa.reloaded", "1");
      });

      // 每小时检查一次更新，不轮询页面内容。
      window.setInterval(() => void registration.update().catch(() => undefined), 60 * 60 * 1000);

      // 1.9：把「这一次真正加载过的 js/css」交给 SW 缓存。
      // 否则首次安装后立刻断网，外壳 HTML 在缓存里、模块脚本却不在，页面会白屏。
      void primeOfflineShell();
    } catch (error) {
      console.warn("[pwa] 注册失败（不影响使用）", error);
    }
  });
}

/**
 * 收集当前页面用到的同源脚本/样式，发给 SW 预缓存。
 * 只发路径，不发内容；跨域资源一律跳过。
 */
async function primeOfflineShell(): Promise<void> {
  try {
    const worker = navigator.serviceWorker.controller ?? (await navigator.serviceWorker.ready).active;
    if (!worker) return;
    const urls = new Set<string>();
    for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      const path = safePath(entry.name);
      if (path && /\.(?:js|css|mjs)$/.test(path)) urls.add(path);
    }
    // 兼容拿不到 Resource Timing 的环境：直接读 DOM 上的 script/link
    for (const node of Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))) {
      const path = safePath(node.src);
      if (path) urls.add(path);
    }
    for (const node of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
      const path = safePath(node.href);
      if (path) urls.add(path);
    }
    if (!urls.size) return;
    worker.postMessage({ type: "CACHE_URLS", urls: [...urls] });
  } catch {
    /* 预缓存失败不影响使用 */
  }
}

function safePath(raw: string): string {
  try {
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

/**
 * 移动端「更多」里可以手动检查更新，返回是否发现新版本。
 *
 * 2.0 修复竞态：update() 之后立刻读 registration.waiting 经常拿到 null，
 * 因为新的 Service Worker 还没走完 install。这里改为等一小段时间
 * （最多 4 秒），期间出现 waiting 或 installing 就算「有新版本」。
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration) return false;
    if (registration.waiting) return true;
    await registration.update();

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (registration.waiting || registration.installing) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return false;
  } catch {
    return false;
  }
}
