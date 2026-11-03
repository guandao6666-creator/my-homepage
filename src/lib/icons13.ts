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
    document.querySelectorAll<HTMLElement>(".di-glyph").forEach(paint);
  };
  run();
  const mo = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(run);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => mo.disconnect();
}
