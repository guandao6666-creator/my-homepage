/**
 * Guandao OS 2.0 · 本地设备档案
 *
 * 注意边界（§9.6：不能创建重复设备系统）：
 *   云端设备身份由服务端 `/api/devices` 生成并绑定当前 Session，
 *   客户端**不能**自己造一个「设备」去注册。
 *
 * 所以这里管的是「这台浏览器的本地档案」：
 *   - 本地偏好与布局需要一个稳定的标识（换账号也不会串台）；
 *   - 首次启动要能设置设备名称（Onboarding Step 4）；
 *   - Local Mode 下也要知道自己是什么设备。
 *
 * 它从不冒充服务端设备，也不会写进 D1。
 */

import type { KeyValueStore } from "./storage";

export type DeviceType = "desktop" | "laptop" | "tablet" | "mobile";

export type DeviceProfile = {
  v: 2;
  /** 本地标识，不是服务端 device_id */
  localId: string;
  name: string;
  type: DeviceType;
  createdAt: number;
  updatedAt: number;
  /** 用户是否明确设置过名称（Onboarding 之后为 true） */
  named: boolean;
};

export type DeviceCapabilities = {
  shell: "desktop" | "tablet" | "mobile" | "unknown";
  type: DeviceType;
  pointer: "coarse" | "fine" | "unknown";
  touch: boolean;
  viewport: { width: number; height: number };
  pixelRatio: number;
  reducedMotion: boolean;
  storageAvailable: boolean;
  online: boolean;
  language: string;
  timeZone: string;
};

const KEY = "device.v1";

const randomId = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 忽略 */
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const detectShell = (): DeviceCapabilities["shell"] => {
  try {
    const value = document.documentElement.dataset.shell;
    if (value === "desktop" || value === "tablet" || value === "mobile") return value;
  } catch {
    /* 忽略 */
  }
  return "unknown";
};

const detectType = (shell: DeviceCapabilities["shell"], coarse: boolean, width: number): DeviceType => {
  if (shell === "mobile") return "mobile";
  if (shell === "tablet") return "tablet";
  if (shell === "desktop") return width < 1440 ? "laptop" : "desktop";
  return coarse && width < 900 ? "tablet" : "desktop";
};

const defaultNameFor = (type: DeviceType): string => {
  if (type === "mobile") return "我的手机";
  if (type === "tablet") return "我的平板";
  if (type === "laptop") return "我的笔记本";
  return "我的桌面";
};

export function detectCapabilities(): DeviceCapabilities {
  let width = 1280;
  let height = 800;
  let pixelRatio = 1;
  let coarse = false;
  let touch = false;
  let reducedMotion = false;
  let online = true;
  let language = "zh-CN";
  let timeZone = "Asia/Shanghai";
  let storageAvailable = false;

  try {
    if (typeof window !== "undefined") {
      width = window.innerWidth || width;
      height = window.innerHeight || height;
      pixelRatio = window.devicePixelRatio || 1;
      touch = (navigator.maxTouchPoints ?? 0) > 0;
      coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    }
    online = typeof navigator === "undefined" || navigator.onLine !== false;
    language = typeof navigator !== "undefined" ? navigator.language || language : language;
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
    if (typeof localStorage !== "undefined") {
      const probe = "__guandao_device_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      storageAvailable = true;
    }
  } catch {
    storageAvailable = false;
  }

  const shell = detectShell();
  return {
    shell,
    type: detectType(shell, coarse, width),
    pointer: coarse ? "coarse" : "fine",
    touch,
    viewport: { width, height },
    pixelRatio,
    reducedMotion,
    storageAvailable,
    online,
    language,
    timeZone,
  };
}

export type DeviceManagerOptions = {
  store: KeyValueStore;
  /** 已经从旧版本迁移过来的设备名（可选） */
  legacyName?: () => string | null;
  now?: () => number;
};

export class DeviceManager {
  private store: KeyValueStore;
  private legacyName?: () => string | null;
  private now: () => number;
  private cache: DeviceProfile | null = null;

  constructor(options: DeviceManagerOptions) {
    this.store = options.store;
    this.legacyName = options.legacyName;
    this.now = options.now ?? (() => Date.now());
  }

  /** 读取本地档案；第一次调用会创建（并写入默认名称） */
  profile(): DeviceProfile {
    if (this.cache) return { ...this.cache };
    let stored: DeviceProfile | null = null;
    try {
      const raw = this.store.getItem(KEY);
      if (raw) stored = JSON.parse(raw) as DeviceProfile;
    } catch {
      stored = null;
    }

    if (stored && stored.localId) {
      this.cache = {
        v: 2,
        localId: String(stored.localId),
        name: String(stored.name || defaultNameFor(detectCapabilities().type)),
        type: (stored.type as DeviceType) ?? detectCapabilities().type,
        createdAt: Number(stored.createdAt) || this.now(),
        updatedAt: Number(stored.updatedAt) || this.now(),
        named: Boolean(stored.named),
      };
      return { ...this.cache };
    }

    const capabilities = detectCapabilities();
    const legacy = this.legacyName?.() ?? "";
    const profile: DeviceProfile = {
      v: 2,
      localId: randomId(),
      name: (legacy || defaultNameFor(capabilities.type)).slice(0, 40),
      type: capabilities.type,
      createdAt: this.now(),
      updatedAt: this.now(),
      named: Boolean(legacy),
    };
    this.cache = profile;
    this.persist(profile);
    return { ...profile };
  }

  capabilities(): DeviceCapabilities {
    return detectCapabilities();
  }

  rename(name: string): DeviceProfile {
    const trimmed = String(name ?? "").trim().slice(0, 40);
    const current = this.profile();
    const next: DeviceProfile = {
      ...current,
      name: trimmed || defaultNameFor(current.type),
      named: Boolean(trimmed),
      updatedAt: this.now(),
    };
    this.cache = next;
    this.persist(next);
    return { ...next };
  }

  setType(type: DeviceType): DeviceProfile {
    const current = this.profile();
    const next: DeviceProfile = { ...current, type, updatedAt: this.now() };
    this.cache = next;
    this.persist(next);
    return { ...next };
  }

  /** 摘要：系统中心 / 关于页展示 */
  summary(): { name: string; type: DeviceType; shell: string; viewport: string; online: boolean } {
    const profile = this.profile();
    const capabilities = this.capabilities();
    return {
      name: profile.name,
      type: profile.type,
      shell: capabilities.shell,
      viewport: `${capabilities.viewport.width}×${capabilities.viewport.height}`,
      online: capabilities.online,
    };
  }

  private persist(profile: DeviceProfile): void {
    try {
      this.store.setItem(KEY, JSON.stringify(profile));
    } catch {
      /* 隐私模式忽略 */
    }
  }
}

export const createDeviceManager = (options: DeviceManagerOptions) => new DeviceManager(options);