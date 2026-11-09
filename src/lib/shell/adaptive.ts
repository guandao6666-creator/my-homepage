/**
 * Guandao OS 1.8 · Adaptive Shell
 *
 * 不是「把桌面缩小」，而是按可用空间、输入方式与页面方向选择三套布局：
 *   desktop  完整窗口 / 菜单栏 / Dock / 组件
 *   tablet   触控优先的桌面外壳：更大的点击目标、接近全屏的窗口、可贴靠
 *   mobile   独立移动伴侣（/m/），不加载桌面窗口系统
 *
 * 判断不依赖 User-Agent：只看视口尺寸、pointer 能力与触摸点数。
 * 用户可以在「视图」菜单或移动端「更多」里手动指定，选择会持久化。
 */

export type ShellMode = "desktop" | "tablet" | "mobile";
export type ShellPreference = "auto" | ShellMode;

export const SHELL_KEY = "guandao.os18.shell.v1";
/** 手机上一次会话里主动选择「桌面」的标记（sessionStorage，新标签页自动失效） */
export const DESKTOP_SESSION_KEY = "guandao.shell.desktop-session";
export const SHELL_EVENT = "guandao:shell-change";

const MODES: ShellMode[] = ["desktop", "tablet", "mobile"];
const VALID_PREFS: ShellPreference[] = ["auto", ...MODES];

export function readPreference(): ShellPreference {
  try {
    const raw = localStorage.getItem(SHELL_KEY);
    if (raw && VALID_PREFS.includes(raw as ShellPreference)) return raw as ShellPreference;
  } catch {
    /* 隐私模式 */
  }
  return "auto";
}

export function writePreference(pref: ShellPreference) {
  try {
    localStorage.setItem(SHELL_KEY, pref);
  } catch {
    /* 忽略 */
  }
}

export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

export function detectMode(): ShellMode {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const coarse = isCoarsePointer();

  // 横屏手机的高度很小，按宽度会误判成平板。
  // 触屏设备用「屏幕短边」而不是视口高度：软键盘弹出时 innerHeight 会缩，
  // 不能因此把平板误判成手机并跳转到 /m/。
  const screenShort = Math.min(
    Number(window.screen?.width) || w,
    Number(window.screen?.height) || h,
  );
  if (w < 640) return "mobile";
  if (coarse && screenShort < 500) return "mobile";
  if (w < 1024) return "tablet";
  // 触屏笔记本 / 平板横屏：1280 以下仍按平板处理，避免用鼠标尺寸做触控布局。
  if (coarse && w < 1280) return "tablet";
  return "desktop";
}

export function resolveMode(): ShellMode {
  const detected = detectMode();
  // 手机尺寸：默认永远是手机伴侣。只有本次会话显式点过「桌面」才用桌面布局，
  // 不再让 localStorage 里的旧选择把之后每次打开网址都带进桌面。
  if (detected === "mobile") return wantsDesktopSession() ? "desktop" : "mobile";
  const pref = readPreference();
  return pref === "auto" ? detected : pref;
}

export function wantsDesktopSession(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("desktop") === "1") return true;
    return sessionStorage.getItem(DESKTOP_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberDesktopSession(): void {
  try {
    sessionStorage.setItem(DESKTOP_SESSION_KEY, "1");
  } catch {
    /* 隐私模式 */
  }
}

export function clearDesktopSession(): void {
  try {
    sessionStorage.removeItem(DESKTOP_SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}

export function applyMode(mode: ShellMode = resolveMode()): ShellMode {
  const root = document.documentElement;
  root.dataset.shell = mode;
  root.dataset.pointer = isCoarsePointer() ? "coarse" : "fine";
  root.style.setProperty("--app-vh", `${Math.round(window.innerHeight)}px`);
  document.body?.setAttribute("data-shell", mode);
  window.dispatchEvent(new CustomEvent(SHELL_EVENT, { detail: { mode, preference: readPreference() } }));
  return mode;
}

export function setPreference(pref: ShellPreference, opts: { reload?: boolean } = {}) {
  writePreference(pref);
  if (pref === "desktop") rememberDesktopSession();
  if (pref === "mobile") clearDesktopSession();
  const mode = resolveMode();
  applyMode(mode);
  if (opts.reload !== false) {
    const mobilePage = document.documentElement.dataset.page === "mobile";
    const wantMobile = mode === "mobile";
    if (mobilePage !== wantMobile) {
      window.location.href = wantMobile ? "/m/" : "/";
      return;
    }
  }
}

export function modeLabel(mode: ShellMode): string {
  return { desktop: "桌面", tablet: "平板", mobile: "手机" }[mode];
}

/**
 * 初始化：
 *   * 立即写入 data-shell，CSS 首帧就能用；
 *   * 移动端访问 / 时跳转到 /m/（除非用户手动指定了桌面/平板）；
 *   * 监听尺寸与方向变化，必要时跳转或重排。
 */
export function initAdaptiveShell(page: "desktop" | "mobile"): () => void {
  document.documentElement.dataset.page = page;
  const initial = applyMode();

  const go = (mode: ShellMode) => {
    if (page === "desktop" && mode === "mobile") {
      window.location.replace(`/m/${window.location.search}${window.location.hash}`);
      return true;
    }
    if (page === "mobile" && mode !== "mobile") {
      window.location.replace(`/${window.location.search}${window.location.hash}`);
      return true;
    }
    return false;
  };

  if (go(initial)) return () => undefined;

  let timer = 0;
  let last = initial;
  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const mode = applyMode();
      if (mode !== last) {
        last = mode;
        if (go(mode)) return;
      }
    }, 220);
  };

  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", onResize, { passive: true });
  try {
    window.visualViewport?.addEventListener("resize", onResize, { passive: true });
  } catch {
    /* 旧浏览器 */
  }

  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
    try {
      window.visualViewport?.removeEventListener("resize", onResize);
    } catch {
      /* 忽略 */
    }
  };
}

/** 触屏设备上控制 hover 效果：只在支持悬停的设备启用。 */
export function supportsHover(): boolean {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}
