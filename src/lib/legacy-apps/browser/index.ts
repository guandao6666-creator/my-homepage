/**
 * 浏览器（browser）· 对应 index.astro 原 `renderBrowser` / `initBrowser`。
 *
 * 依赖：`escapeHtml`、localStorage `guandao.os.browser.v1`、`window.open`。
 * 无计时器 / 全局监听，不需要 lifecycle。
 */
import type { LegacyAppModule } from "../types";

const BROWSER_HISTORY_KEY = "guandao.os.browser.v1";

export const browserApp: LegacyAppModule = {
  id: "browser",
  title: "浏览器",
  width: 560,
  height: 480,
  glyph: "di-browser",
  body: () => `
          <div class="browser">
            <div class="browser-bar">
              <input class="browser-url" data-browser-url placeholder="输入网址或搜索关键词…" />
              <button class="browser-go" data-browser-go type="button">前往</button>
            </div>
            <div class="browser-home">
              <p class="browser-sec">快捷入口</p>
              <div class="browser-links">
                <a class="browser-link" href="/home/">我的博客</a>
                <a class="browser-link" href="/blog/">文章</a>
                <a class="browser-link" href="/cycling/">骑行</a>
                <a class="browser-link" href="/projects/">作品</a>
                <a class="browser-link" href="/archive/">归档</a>
                <a class="browser-link" href="https://github.com/guandao6666-creator" target="_blank" rel="noreferrer">GitHub</a>
                <a class="browser-link" href="https://www.bilibili.com/" target="_blank" rel="noreferrer">Bilibili</a>
                <a class="browser-link" href="https://www.bing.com/" target="_blank" rel="noreferrer">必应</a>
              </div>
              <p class="browser-tip">外部网站会在新标签页打开，浏览器安全策略不允许嵌入第三方页面。</p>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between">
              <p class="browser-sec">历史记录</p>
              <button class="browser-go" data-browser-clear type="button" style="padding:2px 8px;font-size:11px;opacity:.8">清空</button>
            </div>
            <div class="browser-history" data-browser-history></div>
          </div>`,
  init: (win, { escapeHtml }) => {
    const urlEl = win.querySelector("[data-browser-url]") as HTMLInputElement | null;
    const historyEl = win.querySelector("[data-browser-history]");

    const readHistory = (): { url: string; at: number }[] => {
      try {
        return JSON.parse(localStorage.getItem(BROWSER_HISTORY_KEY) || "[]");
      } catch {
        return [];
      }
    };
    const paint = () => {
      if (!historyEl) return;
      const list = readHistory();
      historyEl.innerHTML = list.length
        ? list.map((h) => `<button class="browser-h-item" data-h="${escapeHtml(h.url)}">${escapeHtml(h.url)}</button>`).join("")
        : `<div class="browser-h-empty">暂无历史</div>`;
    };
    const go = (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      const isUrl = /^(https?:\/\/)/i.test(q) || /^[\w-]+(\.[\w-]+)+/.test(q);
      const url = isUrl ? (/^https?:\/\//i.test(q) ? q : `https://${q}`) : `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      window.open(url, "_blank", "noreferrer");
      const list = readHistory().filter((item) => item.url !== url);
      list.unshift({ url, at: Date.now() });
      try {
        localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
      } catch {
        /* 忽略 */
      }
      paint();
    };
    win.querySelector("[data-browser-go]")?.addEventListener("click", () => go(urlEl?.value ?? ""));
    win.querySelector("[data-browser-clear]")?.addEventListener("click", () => {
      try {
        localStorage.removeItem(BROWSER_HISTORY_KEY);
      } catch {
        /* 忽略 */
      }
      paint();
    });
    urlEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go(urlEl.value);
    });
    historyEl?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-h]");
      if (b) window.open(b.getAttribute("data-h") ?? "", "_blank", "noreferrer");
    });
    paint();
  },
};
