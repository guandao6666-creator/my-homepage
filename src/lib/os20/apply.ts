/**
 * Guandao OS 2.0 · 把设置真正落到系统上
 *
 * 设置面板最怕「改了没反应」。这里集中实现「设置 id → 真实效果」的映射：
 * 每一项都调用 1.x 已经验证过的能力（外观引擎 / 程序坞 / 通知 / 诊断），
 * 不再另起一套渲染。
 *
 * 只在实际值发生变化时才调用底层，避免每次改一个滑块都把整屏重绘一遍，
 * 也避免把 1.3 的「壁纸自动取色」意外关掉。
 */

import type { Kernel } from "../core/kernel";
import type { Ctx } from "../os14/core";
import { readPrefs, patchPrefs } from "../os14/prefs";

type Api13 = {
  cfg: () => Record<string, unknown>;
  applyLook: (look: Record<string, unknown>) => void;
  openSettings: (tab?: string) => void;
  toast: (msg: string) => void;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export type ApplyResult = {
  applied: string[];
  skipped: string[];
};

/**
 * 应用当前设置。返回真正生效的项。
 * 启动时调用一次，设置变更时再调用（幂等）。
 */
export function applySettings(kernel: Kernel, ctx: Ctx, options: { silent?: boolean } = {}): ApplyResult {
  const api13 = ctx.api13 as unknown as Api13 | undefined;
  const values = kernel.settings.read();
  const applied: string[] = [];
  const skipped: string[] = [];

  /* ---------------- 外观 ---------------- */
  if (api13?.applyLook) {
    const cfg = asRecord(api13.cfg());
    const appearance = asRecord(cfg.appearance);
    const dock = asRecord(cfg.dock);
    const look: Record<string, unknown> = {};

    const mode = String(values["appearance.mode"] ?? "dark");
    if (appearance.mode !== mode) look.mode = mode;

    const material = String(values["appearance.material"] ?? "glass");
    if (appearance.material !== material) look.material = material;

    const radius = String(values["appearance.radius"] ?? "round");
    if (appearance.radius !== radius) look.radius = radius;

    const accent = String(values["appearance.accent"] ?? "auto");
    if (accent !== "auto" && appearance.accent !== accent) {
      look.accent = accent;
    }

    const dockPos = String(values["desktop.dock.position"] ?? "bottom");
    if (dock.pos !== dockPos) look.dock = { ...asRecord(look.dock), pos: dockPos };

    const dockHide = Boolean(values["desktop.dock.autohide"]);
    if (Boolean(dock.autohide) !== dockHide) {
      look.dock = { ...asRecord(look.dock), autohide: dockHide };
    }

    if (Object.keys(look).length) {
      try {
        api13.applyLook({ ...look, preset: "custom" });
        applied.push(...Object.keys(look).filter((key) => key !== "preset"));
      } catch {
        skipped.push("appearance");
      }
    }
  } else {
    skipped.push("appearance");
  }

  /* ---------------- 动画 ---------------- */
  const animations = Boolean(values["appearance.animations"]);
  try {
    document.body.classList.toggle("os-reduce-motion", !animations);
    ctx.writeState({ reduceMotion: !animations });
    applied.push("appearance.animations");
  } catch {
    skipped.push("appearance.animations");
  }

  /* ---------------- 桌面图标文字 ---------------- */
  try {
    const icons = document.querySelector<HTMLElement>(".desk-icons");
    if (icons) {
      icons.classList.toggle("os20-no-labels", !Boolean(values["desktop.iconLabels"]));
      applied.push("desktop.iconLabels");
    }
  } catch {
    skipped.push("desktop.iconLabels");
  }

  /* ---------------- 时钟 ---- */
  try {
    const seconds = Boolean(values["desktop.clockSeconds"]);
    document.documentElement.dataset.clockSeconds = seconds ? "1" : "0";
    applied.push("desktop.clockSeconds");
  } catch {
    skipped.push("desktop.clockSeconds");
  }

  /* ---------------- 组件透明度 ---------------- */
  try {
    const widgets = document.getElementById("widgets");
    if (widgets) {
      const opacity = Math.max(30, Math.min(100, Number(values["desktop.widgets.opacity"]) || 100));
      widgets.style.opacity = String(opacity / 100);
      applied.push("desktop.widgets.opacity");
    }
  } catch {
    skipped.push("desktop.widgets.opacity");
  }

  /* ---------------- 通知偏好 ---------------- */
  try {
    const prefs = readPrefs();
    const nextDnd = Boolean(values["notifications.dnd"]);
    const nextVolume = Math.max(0, Math.min(100, Number(values["notifications.volume"]) || 45));
    if (prefs.dnd !== nextDnd || prefs.volume !== nextVolume) {
      patchPrefs({ dnd: nextDnd, volume: nextVolume });
      applied.push("notifications.dnd", "notifications.volume");
    }
  } catch {
    skipped.push("notifications");
  }

  /* ---------------- 运行模式 ---------------- */
  try {
    const mode = values["system.mode"] === "cloud" ? "cloud" : "local";
    kernel.cloud.setMode(mode);
    applied.push("system.mode");
  } catch {
    skipped.push("system.mode");
  }

  if (!options.silent && applied.length) {
    ctx.toast(`已应用 ${applied.length} 项设置`);
  }

  return { applied, skipped };
}

/** 启动时把版本写到 DOM 上，供样式与诊断使用（不伪造任何数据） */
export function stampVersion(version: string, releaseName: string): void {
  try {
    document.documentElement.dataset.osVersion = version;
    document.documentElement.dataset.osRelease = releaseName;
    const badge = document.getElementById("mb-version");
    if (badge) badge.textContent = version.split(".").slice(0, 2).join(".");
  } catch {
    /* 忽略 */
  }
}