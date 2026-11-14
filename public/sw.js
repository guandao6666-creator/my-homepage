/* ============================================================
   Guandao OS 1.9 · Service Worker

   边界：
   - 只缓存同源静态外壳、图片与字体；
   - /api/*、/sb/*、/sandbox/* 一律绕过缓存，避免把私人数据写进公共缓存；
   - 导航请求 network-first，离线时回退缓存或 /offline/；
   - 版本更新需要用户确认后 skipWaiting。

   1.9 的修复：
   1. 页面在注册成功后主动把「这一次真正加载过的 js/css」发给 SW 预先缓存，
      解决「第一次装完就断网 → 外壳 HTML 在、但模块脚本缺失 → 白屏」的问题；
   2. 静态再验证不再在 respondWith 结束之后调用 waitUntil（规范上会被丢弃）；
   3. /music/ 不再进缓存：几 MB 的音频会把真正需要的应用外壳挤出去；
   4. 导航缓存做上限裁剪，避免查询串导致无限增长；
   5. activate 只清理本应用的缓存前缀。
   ============================================================ */

const VERSION = "guandao-2.0.0";
const CACHE_PREFIX = "guandao-";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline/";
/** 导航缓存最多保留多少条（每条是一个 URL + 查询串） */
const SHELL_LIMIT = 40;

const SHELL = [
  // 2.0：桌面首页 "/" 必须在预缓存里。
  // 1.9 只缓存了 /m/，桌面端首次访问后断网会白屏（HTML 没进缓存，回退到 offline 页）。
  "/",
  "/m/",
  "/offline/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/wallpapers/aurora.webp",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* 单个资源失败不影响安装 */
          }
        }),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !key.startsWith(VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  /*
   * 页面加载完成后把实际用到的同源 js/css 发过来缓存。
   * 这样「装完就断网」也能拿到完整的离线外壳，不依赖构建期生成的清单。
   */
  if (data.type === "CACHE_URLS" && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const urls = data.urls.filter((url) => typeof url === "string" && url.startsWith("/")).slice(0, 40);
        await Promise.all(
          urls.map(async (url) => {
            try {
              const existing = await cache.match(url);
              if (existing) return;
              const response = await fetch(url, { cache: "reload" });
              if (response.ok && response.type === "basic") await cache.put(url, response);
            } catch {
              /* 单个失败忽略 */
            }
          }),
        );
      })(),
    );
  }
});

/** 只缓存可以安全共享的静态资源；音乐不在其中 */
const STATIC_PREFIXES = ["/_astro/", "/icons/", "/wallpapers/", "/pet/", "/aquarium/"];

function isStatic(pathname) {
  if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return /\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(pathname);
}

function shouldBypass(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/sb/") ||
    pathname.startsWith("/pair") ||
    pathname.startsWith("/sandbox/") ||
    pathname.startsWith("/music/") ||
    pathname === "/sw.js"
  );
}

/** 导航缓存裁剪：超出上限时删掉最早的条目 */
async function trimShell(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= SHELL_LIMIT) return;
    const excess = keys.slice(0, keys.length - SHELL_LIMIT);
    await Promise.all(excess.map((request) => cache.delete(request)));
  } catch {
    /* 忽略 */
  }
}

async function networkFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // 只缓存同源、成功、非重定向的 HTML
    if (response.ok && response.type === "basic") {
      event.waitUntil(
        (async () => {
          await cache.put(request, response.clone()).catch(() => undefined);
          await trimShell(cache);
        })(),
      );
    }
    return response;
  } catch {
    const cached = (await cache.match(request)) || (await cache.match(OFFLINE_URL));
    if (cached) return cached;
    return new Response("离线，且没有缓存这个页面。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  // 先同步拿到 network promise，再决定 waitUntil 与返回值：
  // 若等 respondWith 结束后才调用 waitUntil，规范上会抛错，写入会被丢弃。
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        try {
          await cache.put(request, response.clone());
        } catch {
          /* 配额满：忽略，下一次再写 */
        }
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  const fresh = await network;
  return fresh || new Response("", { status: 504 });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (shouldBypass(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, event));
    return;
  }

  if (isStatic(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});