/**
 * Guandao OS 1.3 · 图标系统
 *
 * 统一规则：
 *   - 48×48 画布，图形落在 10–38 的安全区
 *   - 单色白色图形 + 一处 22% 的暗色内阴影层，不描边不渐变
 *   - 底板由 CSS 提供同一角度的线性渐变（见 index.astro 末尾 .di-* 覆盖）
 *   - 同一套 SVG 在桌面 / 程序坞 / 启动台 / 设置里复用，靠 zoom 缩放
 */

const A = (d: string, o = 1) => `<path d="${d}" fill="currentColor"${o !== 1 ? ` opacity="${o}"` : ""}/>`;

export const ICON_SVG: Record<string, string> = {
  folder: `
    ${A("M17 14h14a3.5 3.5 0 0 1 3.5 3.5V33A3.5 3.5 0 0 1 31 36.5H17a3.5 3.5 0 0 1-3.5-3.5V14Z", 0.45)}
    ${A("M13 11h14a3.5 3.5 0 0 1 3.5 3.5V30A3.5 3.5 0 0 1 27 33.5H13A3.5 3.5 0 0 1 9.5 30V11Z")}
    <path d="M16 18h8M16 23h8M16 28h5" stroke="#0b1020" stroke-opacity=".24" stroke-width="2.2" stroke-linecap="round"/>`,

  person: `
    <circle cx="24" cy="18.5" r="6.2" fill="currentColor"/>
    ${A("M12.8 35.2c1.5-5.6 5.7-8.7 11.2-8.7s9.7 3.1 11.2 8.7c.3 1.1-.5 2.1-1.7 2.1H14.5c-1.2 0-2-1-1.7-2.1Z", 0.92)}`,

  music: `
    ${A("M26.5 12.2c0-.9.6-1.6 1.4-1.9l6.5-1.8c1.2-.3 2.3.6 2.3 1.8v3.7c0 .8-.5 1.5-1.3 1.7l-5.9 1.6v9.4a5.6 5.6 0 1 1-3-4.9V12.2Z")}
    ${A("M14 24.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z", 0.55)}`,

  term: `
    <path d="M14 16.5 20.5 23 14 29.5" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M23.5 30H34" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>`,

  ach: `
    ${A("M15.5 11h17v8.2a8.5 8.5 0 0 1-17 0V11Z")}
    <path d="M15.5 13.5H12a4.8 4.8 0 0 0 4.8 8M32.5 13.5H36a4.8 4.8 0 0 1-4.8 8" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    ${A("M22.4 27.2h3.2v5.4h-3.2z", 0.9)}
    ${A("M16.5 33.6h15a2.2 2.2 0 0 1 0 4.4h-15a2.2 2.2 0 0 1 0-4.4Z")}`,

  tank: `
    ${A("M12 24c4.4-6.2 9.4-9.3 15.2-9.3 4.8 0 8.8 2.7 10.8 6.8.5 1 .5 1.9 0 2.9-2 4.1-6 6.8-10.8 6.8C21.4 31.2 16.4 28.1 12 24Z")}
    ${A("M12.4 24 7.6 18v12l4.8-6Z", 0.62)}
    <circle cx="31.2" cy="21.4" r="1.9" fill="#0b1020" opacity=".34"/>`,

  wall: `
    <rect x="11.5" y="11.5" width="25" height="25" rx="5" stroke="currentColor" stroke-width="2.6" fill="none" opacity=".9"/>
    <circle cx="19.5" cy="20" r="2.7" fill="currentColor"/>
    <circle cx="28.5" cy="20" r="2.7" fill="currentColor" opacity=".5"/>
    <circle cx="19.5" cy="28.5" r="2.7" fill="currentColor" opacity=".5"/>
    <circle cx="28.5" cy="28.5" r="2.7" fill="currentColor"/>`,

  rank: `
    ${A("M11.5 26.5h7v10h-7z", 0.5)}
    ${A("M20.5 18.5h7v18h-7z")}
    ${A("M29.5 23h7v13.5h-7z", 0.75)}`,

  draw: `
    <rect x="11.5" y="11.5" width="25" height="25" rx="6.5" fill="currentColor"/>
    <circle cx="19" cy="19" r="2.1" fill="#0b1020" opacity=".3"/>
    <circle cx="29" cy="19" r="2.1" fill="#0b1020" opacity=".3"/>
    <circle cx="24" cy="24" r="2.1" fill="#0b1020" opacity=".3"/>
    <circle cx="19" cy="29" r="2.1" fill="#0b1020" opacity=".3"/>
    <circle cx="29" cy="29" r="2.1" fill="#0b1020" opacity=".3"/>`,

  vote: `
    ${A("M11 21h26v14a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V21Z", 0.95)}
    ${A("M19.5 24.5h9v2.4h-9z", 0.28)}
    <path d="M16.5 14.2 20.6 18.3 30 8.9" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,

  hole: `
    <circle cx="24" cy="18.5" r="8.2" fill="currentColor" opacity=".95"/>
    <circle cx="16.4" cy="23.4" r="5.6" fill="currentColor" opacity=".72"/>
    <circle cx="31.6" cy="23.4" r="5.6" fill="currentColor" opacity=".72"/>
    ${A("M21.4 26.5h5.2v10.2h-5.2z")}
    <ellipse cx="24" cy="30" rx="2.7" ry="3.4" fill="#0b1020" opacity=".3"/>`,

  tv: `
    <rect x="10.5" y="14" width="27" height="19" rx="4.5" fill="currentColor"/>
    <path d="M21.6 19.4v8.2l7-4.1-7-4.1Z" fill="#0b1020" opacity=".3"/>
    <path d="M20 36.5h8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".6"/>`,

  net: `
    <circle cx="24" cy="13.5" r="4.6" fill="currentColor"/>
    <circle cx="13.8" cy="31.5" r="4.6" fill="currentColor" opacity=".78"/>
    <circle cx="34.2" cy="31.5" r="4.6" fill="currentColor" opacity=".78"/>
    <path d="M21.7 17.4 16 26.4M26.3 17.4 32 26.4M18.4 31.5h11.2" stroke="currentColor" stroke-width="2.3" opacity=".6"/>`,

  calc: `
    <rect x="12.5" y="10.5" width="23" height="27" rx="4.5" fill="currentColor"/>
    <rect x="17" y="14.5" width="14" height="5.6" rx="1.6" fill="#0b1020" opacity=".28"/>
    ${[[19.5, 25.5], [24, 25.5], [28.5, 25.5], [19.5, 31], [24, 31], [28.5, 31]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="#0b1020" opacity=".28"/>`)
      .join("")}`,

  note: `
    ${A("M13 15a3.5 3.5 0 0 1 3.5-3.5h10l8 8v14.5a3.5 3.5 0 0 1-3.5 3.5H16.5A3.5 3.5 0 0 1 13 34V15Z")}
    <path d="M26.5 11.5v6a2.5 2.5 0 0 0 2.5 2.5h6" fill="#0b1020" opacity=".2"/>
    <path d="M18 24h10M18 29h6.5" stroke="#0b1020" stroke-opacity=".26" stroke-width="2.2" stroke-linecap="round"/>`,

  mon: `
    <rect x="10.5" y="13" width="27" height="21" rx="4.5" stroke="currentColor" stroke-width="2.8" fill="none" opacity=".9"/>
    <path d="M15 24h4.4l3.2-6.4 4.2 12 3-5.6h3.2" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,

  cal: `
    ${A("M11.5 15a4 4 0 0 1 4-4h17a4 4 0 0 1 4 4v19.5a4 4 0 0 1-4 4h-17a4 4 0 0 1-4-4V15Z")}
    <path d="M11.5 21.5h25" stroke="#0b1020" stroke-opacity=".2" stroke-width="2.4"/>
    <path d="M18 9.5v5.5M30 9.5v5.5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    ${[[19, 27], [24, 27], [29, 27], [19, 32], [24, 32]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="#0b1020" opacity=".28"/>`)
      .join("")}`,

  viewer: `
    ${A("M11 17a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V17Z")}
    <circle cx="19" cy="21" r="2.8" fill="#0b1020" opacity=".28"/>
    <path d="M14 32l6.8-8 4.8 5.4 4-3.4 5.4 5.4v.6a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V32Z" fill="#0b1020" opacity=".22"/>`,

  browser: `
    <circle cx="24" cy="24" r="12" fill="none" stroke="currentColor" stroke-width="2.8" opacity=".92"/>
    <path d="M30.4 17.6 26.9 25.9 18.6 29.4 22.1 21.1 30.4 17.6Z" fill="currentColor"/>
    <circle cx="24.5" cy="23.5" r="1.5" fill="#0b1020" opacity=".4"/>`,

  files: `
    ${A("M10 18a4.5 4.5 0 0 1 4.5-4.5h5.8l3.4 3.4H33.5A4.5 4.5 0 0 1 38 21.4V32a4.5 4.5 0 0 1-4.5 4.5h-19A4.5 4.5 0 0 1 10 32V18Z")}
    <path d="M10 23.5h28" stroke="#0b1020" stroke-opacity=".16" stroke-width="2.2"/>`,

  gear: `
    <g fill="currentColor">
      ${Array.from({ length: 8 }, (_, i) => `<rect x="21.6" y="6.2" width="4.8" height="7.4" rx="2.4" transform="rotate(${i * 45} 24 24)"/>`).join("")}
    </g>
    <circle cx="24" cy="24" r="10.4" fill="none" stroke="currentColor" stroke-width="3.6"/>
    <circle cx="24" cy="24" r="4.2" fill="none" stroke="currentColor" stroke-width="3.2"/>`,

  home: `
    ${A("M24 10.6 38.4 23.2h-4.9V34a3.4 3.4 0 0 1-3.4 3.4H18a3.4 3.4 0 0 1-3.4-3.4V23.2h-5L24 10.6Z")}
    <rect x="21" y="28.5" width="6" height="8.9" rx="1.5" fill="#0b1020" opacity=".24"/>`,

  /* ---------------- 1.4 ---------------- */

  appcenter: `
    ${A("M13 17.5h22l-2.2 18.2a4.6 4.6 0 0 1-4.6 4.1h-8.4a4.6 4.6 0 0 1-4.6-4.1L13 17.5Z")}
    <path d="M18.4 17.5v-3.2a5.6 5.6 0 0 1 11.2 0v3.2" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    <path d="M20.6 26.2h6.8M24 22.8v6.8" stroke="#0b1020" stroke-opacity=".34" stroke-width="2.6" stroke-linecap="round"/>`,

  themes: `
    ${A("M24 10.8c7.3 0 13.2 5.6 13.2 12.5 0 3.6-2.6 5.5-5.6 5.5h-2.3c-2.2 0-3.4 1.4-3.4 3.1 0 2.2 1.8 2.7 1.8 5.1 0 2-1.7 3.4-4.3 3.4-6.8 0-12.6-5.7-12.6-13.2S16.6 10.8 24 10.8Z")}
    <circle cx="19.2" cy="21.2" r="2.5" fill="#0b1020" opacity=".34"/>
    <circle cx="27.2" cy="18.6" r="2.2" fill="#0b1020" opacity=".26"/>
    <circle cx="16.6" cy="28.8" r="2" fill="#0b1020" opacity=".26"/>`,

  widgets: `
    ${A("M11.5 12.5h10.2v10.2H11.5z", 0.95)}
    ${A("M26.3 12.5h10.2v6.6H26.3z", 0.7)}
    ${A("M26.3 22.7h10.2v12.8H26.3z", 0.95)}
    ${A("M11.5 26.3h10.2v9.2H11.5z", 0.7)}`,

  play: `
    ${A("M14.4 18.2h19.2a5.4 5.4 0 0 1 5.4 5.4v5.6a5.4 5.4 0 0 1-5.4 5.4H14.4A5.4 5.4 0 0 1 9 29.2v-5.6a5.4 5.4 0 0 1 5.4-5.4Z")}
    <circle cx="31.6" cy="23.4" r="2.1" fill="#0b1020" opacity=".34"/>
    <circle cx="35.6" cy="27.4" r="2.1" fill="#0b1020" opacity=".34"/>
    <path d="M16.4 21.6v6.6M13.2 24.9h6.6" stroke="#0b1020" stroke-opacity=".34" stroke-width="2.4" stroke-linecap="round"/>`,

  space: `
    ${A("M24 10.8 40 19l-16 8.2L8 19l16-8.2Z")}
    ${A("M8 25.4 24 33.6l16-8.2v3.4L24 37 8 28.8v-3.4Z", 0.72)}
    ${A("M8 32.8 24 41l16-8.2v3.2L24 44.2 8 36v-3.2Z", 0.45)}`,

  control: `
    <path d="M12 16h24M12 24h24M12 32h24" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".42"/>
    <circle cx="19" cy="16" r="3.6" fill="currentColor"/>
    <circle cx="30" cy="24" r="3.6" fill="currentColor"/>
    <circle cx="17" cy="32" r="3.6" fill="currentColor"/>`,

  tasks: `
    ${A("M13 12.6h22a3.4 3.4 0 0 1 3.4 3.4v16a3.4 3.4 0 0 1-3.4 3.4H13a3.4 3.4 0 0 1-3.4-3.4V16a3.4 3.4 0 0 1 3.4-3.4Z", 0.28)}
    <path d="M16.6 20.2 19.8 23.4 25 18.2" stroke="currentColor" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M28.6 20.8h6.4M16.6 29.6l3.2 3.2 5.2-5.2M28.6 30.2h6.4" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".62"/>`,

  data: `
    <ellipse cx="24" cy="15.4" rx="12.4" ry="4.8" fill="currentColor"/>
    ${A("M11.6 15.4v17.2c0 2.7 5.6 4.8 12.4 4.8s12.4-2.1 12.4-4.8V15.4c0 2.7-5.6 4.8-12.4 4.8S11.6 18.1 11.6 15.4Z", 0.72)}
    <path d="M11.6 24c0 2.7 5.6 4.8 12.4 4.8s12.4-2.1 12.4-4.8" stroke="#0b1020" stroke-opacity=".26" stroke-width="2.2" fill="none"/>`,

  gallery: `
    ${A("M10.5 17.4A3.4 3.4 0 0 1 13.9 14h20.2a3.4 3.4 0 0 1 3.4 3.4v15.2a3.4 3.4 0 0 1-3.4 3.4H13.9a3.4 3.4 0 0 1-3.4-3.4V17.4Z")}
    <circle cx="18.4" cy="21.6" r="2.6" fill="#0b1020" opacity=".32"/>
    <path d="M14.4 32.2l6.6-7.6 4.6 5.2 3.8-3.2 5 5.6v1a2 2 0 0 1-2 2H16.4a2 2 0 0 1-2-2v-1Z" fill="#0b1020" opacity=".24"/>
    <path d="M16 10.8h18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".4"/>`,

  reader: `
    ${A("M11 15.2c4.2-1.8 8.6-1.5 13 1.2v20.4c-4.4-2.7-8.8-3-13-1.2V15.2Z")}
    ${A("M37 15.2c-4.2-1.8-8.6-1.5-13 1.2v20.4c4.4-2.7 8.8-3 13-1.2V15.2Z", 0.72)}
    <path d="M24 16.4v20.4" stroke="#0b1020" stroke-opacity=".3" stroke-width="1.8"/>`,

  community: `
    ${A("M24 9.8a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z")}
    ${A("M12.6 25.4a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Z", 0.72)}
    ${A("M35.4 25.4a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Z", 0.72)}
    <path d="M24 21.4v8.2M24 26.2l-7.2 3.4M24 26.2l7.2 3.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".8"/>`,

  /* 2.0：更新中心 */
  fresh: `
    <path d="M34.6 24a10.6 10.6 0 1 1-3.4-7.7" stroke="currentColor" stroke-width="3.2" fill="none" stroke-linecap="round"/>
    <path d="M34.8 12.4v6.2h-6.2" stroke="currentColor" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${A("M24 18.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z", 0.3)}`,

  /* 2.0：应用与资源市场 */
  store: `
    ${A("M12.4 20.6h23.2l-1.8 12.2a3.2 3.2 0 0 1-3.2 2.8H17.4a3.2 3.2 0 0 1-3.2-2.8L12.4 20.6Z")}
    <path d="M18.4 20.6v-2.4a5.6 5.6 0 0 1 11.2 0v2.4" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    <path d="M19 26.4h10" stroke="#0b1020" stroke-opacity=".28" stroke-width="2.2" stroke-linecap="round"/>`,

  /* 2.0：首次启动引导 */
  spark: `
    ${A("M24 10.6c1.1 5.6 3.4 8 9 9-5.6 1.1-7.9 3.4-9 9-1.1-5.6-3.4-7.9-9-9 5.6-1 7.9-3.4 9-9Z")}
    ${A("M33.4 28.4c.6 3 1.8 4.2 4.8 4.8-3 .6-4.2 1.8-4.8 4.8-.6-3-1.8-4.2-4.8-4.8 3-.6 4.2-1.8 4.8-4.8Z", 0.62)}
    ${A("M14.2 27.2c.4 2.2 1.4 3.1 3.6 3.6-2.2.4-3.1 1.4-3.6 3.6-.4-2.2-1.4-3.1-3.6-3.6 2.2-.4 3.1-1.4 3.6-3.6Z", 0.45)}`,
};

const CLASS_MAP: Record<string, string> = {
  "di-folder": "folder",
  "di-person": "person",
  "di-music": "music",
  "di-term": "term",
  "di-ach": "ach",
  "di-tank": "tank",
  "di-wall": "wall",
  "di-rank": "rank",
  "di-draw": "draw",
  "di-vote": "vote",
  "di-hole": "hole",
  "di-tv": "tv",
  "di-net": "net",
  "di-calc": "calc",
  "di-note": "note",
  "di-mon": "mon",
  "di-cal": "cal",
  "di-viewer": "viewer",
  "di-browser": "browser",
  "di-files": "files",
  "di-gear": "gear",
  "di-home": "home",
  "di-appcenter": "appcenter",
  "di-themes": "themes",
  "di-widgets": "widgets",
  "di-play": "play",
  "di-space": "space",
  "di-control": "control",
  "di-tasks": "tasks",
  "di-data": "data",
  "di-gallery": "gallery",
  "di-reader": "reader",
  "di-community": "community",
  // 2.0
  "di-fresh": "fresh",
  "di-store": "store",
  "di-spark": "spark",
};

const paint = (glyph: HTMLElement) => {
  if (glyph.classList.contains("has-svg")) return;
  const key = Object.keys(CLASS_MAP).find((cls) => glyph.classList.contains(cls));
  if (!key) return;
  const svg = ICON_SVG[CLASS_MAP[key]];
  if (!svg) return;
  glyph.innerHTML = `<svg class="di-svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${svg}</svg>`;
  glyph.classList.add("has-svg");
};

/** 给页面上所有 .di-glyph 注入矢量图形；程序坞重绘 / 启动台重排后自动补齐 */
export function installIcons() {
  let raf = 0;
  const run = () => {
    raf = 0;
    // 1.9：只处理还没画过的图标。旧实现在任何 DOM 变化时都会全量重扫并重绘，
    // 游戏 / 组件的 innerHTML 更新会把它变成每帧一次的全文档查询。
    const pending = document.querySelectorAll<HTMLElement>(".di-glyph:not(.has-svg)");
    for (const glyph of pending) paint(glyph);
  };
  run();
  const mo = new MutationObserver(() => {
    // 页面不可见时不处理：恢复可见后由下一次变更或 visibilitychange 补上
    if (document.hidden) return;
    if (raf) return;
    raf = requestAnimationFrame(run);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 从后台切回前台时补一次，避免后台新增的图标一直空着
  const onVisible = () => {
    if (document.hidden || raf) return;
    raf = requestAnimationFrame(run);
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    mo.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}
