/** Guandao OS 1.4 · 全局偏好（勿扰 / 音量 / 动画） */

import { ls } from "./core";

export type Prefs = {
  v: 1;
  dnd: boolean;
  volume: number;
  animations: boolean;
  /** 每次打开桌面时的问候，控制中心可关 */
  greeting: boolean;
};

const KEY = "guandao.os14.prefs.v1";

const defaults = (): Prefs => ({ v: 1, dnd: false, volume: 45, animations: true, greeting: true });

export const readPrefs = (): Prefs => ls.get<Prefs>(KEY, defaults());

export const writePrefs = (p: Prefs) => {
  ls.set(KEY, p);
  window.dispatchEvent(new CustomEvent("guandao:prefs-change", { detail: p }));
};

export const patchPrefs = (patch: Partial<Prefs>) => {
  const next = { ...readPrefs(), ...patch, v: 1 as const };
  writePrefs(next);
  return next;
};
