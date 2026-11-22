/**
 * Guandao OS 2.0.6 · 外观 look 的强调色语义
 *
 * 2.0.5 之前 `applyLook()` 结尾无条件写 `cfg.appearance.autoAccent = false`，
 * 于是「跟随壁纸取色」被任何一次外观写入永久关掉：
 *   - 用户选固定强调色后再选「跟随壁纸」→ 设置项回到 auto，但取色开关仍是 false；
 *   - 改材质 / 圆角 / 程序坞位置（同样走 applyLook）→ 取色开关也被顺手关掉。
 *
 * 这里把「这次 look 想表达什么」与「当前状态」分开，做成纯函数：
 *   - 显式 `accentAuto` → 打开取色，并按当前壁纸立刻取色；
 *   - 显式 `accent` / `accent2` → 主题自带颜色，关闭取色；
 *   - 两者都没给 → 保持原状态，别做多余的副作用。
 */

const HEX_RE = /^#[0-9a-f]{6}$/i;

export type LookAccentPatch = {
  accent?: string;
  accent2?: string;
  accentAuto?: boolean;
};

export type WallpaperAccentPair = {
  accent: string;
  accent2: string;
};

export type ResolvedLookAccent = {
  autoAccent: boolean;
  accent?: string;
  accent2?: string;
};

export function resolveLookAccent(
  patch: LookAccentPatch,
  currentAutoAccent: boolean,
  wallpaper: WallpaperAccentPair | null,
): ResolvedLookAccent {
  if (patch.accentAuto) {
    return {
      autoAccent: true,
      // 壁纸还没加载好时不要清空现有颜色，否则界面会闪一下默认蓝
      accent: wallpaper?.accent,
      accent2: wallpaper?.accent2,
    };
  }
  const accent = patch.accent && HEX_RE.test(patch.accent) ? patch.accent.toLowerCase() : undefined;
  const accent2 = patch.accent2 && HEX_RE.test(patch.accent2) ? patch.accent2.toLowerCase() : undefined;
  if (accent || accent2) return { autoAccent: false, accent, accent2 };
  return { autoAccent: currentAutoAccent };
}