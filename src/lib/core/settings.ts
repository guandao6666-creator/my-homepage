/**
 * Guandao OS 2.0 · 统一设置
 *
 * 1.x 的开关散在三处：1.3 的 `guandao.os13.v1`（外观 / 壁纸 / 托盘）、
 * 1.4 的 `guandao.os14.prefs.v1`（勿扰 / 音量）、1.0 的 `guandao.os.state.v1`
 * （图标 / 窗口几何）。设置项没有 Schema，也没法统一迁移。
 *
 * 2.0 的 SettingsManager 提供：
 *   - 一份带类型、默认值、适用范围、风险标注的 Schema；
 *   - 校验 + 持久化 + 订阅；
 *   - 「立即生效 / 下次启动生效」的诚实标注；
 *   - 与旧键的桥接：写入时同步到 1.x 的键，保证老代码继续工作。
 *
 * 不依赖 DOM，可单测。
 */

import type { StorageManager } from "./storage";

export type SettingGroup =
  | "appearance"
  | "personalization"
  | "desktop"
  | "applications"
  | "plugins"
  | "cloud"
  | "devices"
  | "privacy"
  | "system";

export const SETTING_GROUP_LABEL: Record<SettingGroup, string> = {
  appearance: "外观",
  personalization: "个性化",
  desktop: "桌面",
  applications: "应用",
  plugins: "插件",
  cloud: "云端",
  devices: "设备",
  privacy: "隐私与安全",
  system: "系统",
};

export type SettingValue = boolean | number | string;

export type SettingOption = { value: string; label: string };

export type SettingField = {
  id: string;
  group: SettingGroup;
  label: string;
  desc: string;
  type: "boolean" | "select" | "number";
  default: SettingValue;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** immediate：改完立刻生效；restart：下次启动生效（界面会明确写出） */
  effect: "immediate" | "restart";
  /** 该设置实际作用的系统能力，展示在设置项下方 */
  appliesTo?: string;
};

/**
 * 2.0 设置 Schema。
 *
 * 只放「真的有代码去读」的设置项：每一条都在 `applySettings()` 里有对应实现，
 * 不放那种改了没反应、只用来显得功能很多的假开关。
 */
export const SETTINGS_SCHEMA: SettingField[] = [
  {
    id: "appearance.mode",
    group: "appearance",
    label: "深浅模式",
    desc: "整个桌面、窗口与应用的明暗基调",
    type: "select",
    default: "dark",
    options: [
      { value: "dark", label: "深色" },
      { value: "light", label: "浅色" },
    ],
    effect: "immediate",
    appliesTo: "外观引擎（os13 主题预设）",
  },
  {
    id: "appearance.material",
    group: "appearance",
    label: "窗口材质",
    desc: "玻璃、磨砂或纯色，影响窗口与面板的透明感",
    type: "select",
    default: "glass",
    options: [
      { value: "glass", label: "玻璃" },
      { value: "frost", label: "磨砂" },
      { value: "solid", label: "纯色" },
    ],
    effect: "immediate",
    appliesTo: "窗口背景与材质变量",
  },
  {
    id: "appearance.radius",
    group: "appearance",
    label: "圆角风格",
    desc: "柔和、圆润或利落，统一影响窗口与卡片",
    type: "select",
    default: "round",
    options: [
      { value: "soft", label: "柔和" },
      { value: "round", label: "圆润" },
      { value: "sharp", label: "利落" },
    ],
    effect: "immediate",
    appliesTo: "圆角 Token",
  },
  {
    id: "appearance.accent",
    group: "appearance",
    label: "强调色",
    desc: "按钮、选中态与高亮的主题色",
    type: "select",
    default: "auto",
    options: [
      { value: "auto", label: "跟随壁纸" },
      { value: "#6f8cff", label: "星蓝" },
      { value: "#b06eff", label: "紫罗兰" },
      { value: "#6ee7a8", label: "薄荷" },
      { value: "#ffd479", label: "麦穗" },
      { value: "#ff8f8f", label: "珊瑚" },
    ],
    effect: "immediate",
    appliesTo: "强调色变量",
  },
  {
    id: "appearance.animations",
    group: "appearance",
    label: "界面动画",
    desc: "关闭后减少过渡与粒子效果，降低低配设备负担",
    type: "boolean",
    default: true,
    effect: "immediate",
    appliesTo: "动画与粒子引擎",
  },
  {
    id: "desktop.iconLabels",
    group: "desktop",
    label: "桌面图标文字",
    desc: "隐藏后只显示图标，适合喜欢极简桌面的人",
    type: "boolean",
    default: true,
    effect: "immediate",
    appliesTo: "桌面图标栏",
  },
  {
    id: "desktop.clockSeconds",
    group: "desktop",
    label: "时钟显示秒",
    desc: "菜单栏与桌面时钟是否显示到秒",
    type: "boolean",
    default: false,
    effect: "immediate",
    appliesTo: "菜单栏时钟 / 桌面时钟组件",
  },
  {
    id: "desktop.dock.autohide",
    group: "desktop",
    label: "程序坞自动隐藏",
    desc: "鼠标离开后收起程序坞，桌面更干净",
    type: "boolean",
    default: false,
    effect: "immediate",
    appliesTo: "程序坞",
  },
  {
    id: "desktop.dock.position",
    group: "desktop",
    label: "程序坞位置",
    desc: "程序坞停靠在屏幕的哪一侧",
    type: "select",
    default: "bottom",
    options: [
      { value: "bottom", label: "底部" },
      { value: "left", label: "左侧" },
      { value: "right", label: "右侧" },
    ],
    effect: "immediate",
    appliesTo: "程序坞",
  },
  {
    id: "desktop.widgets.opacity",
    group: "desktop",
    label: "组件透明度",
    desc: "桌面组件整体的不透明度",
    type: "number",
    default: 100,
    min: 30,
    max: 100,
    step: 5,
    unit: "%",
    effect: "immediate",
    appliesTo: "桌面组件渲染",
  },
  {
    id: "notifications.dnd",
    group: "personalization",
    label: "勿扰模式",
    desc: "通知照常记录到通知中心，但不弹出提醒",
    type: "boolean",
    default: false,
    effect: "immediate",
    appliesTo: "通知中心",
  },
  {
    id: "notifications.volume",
    group: "personalization",
    label: "音量",
    desc: "只影响本页播放器与提示音，不改变系统音量",
    type: "number",
    default: 45,
    min: 0,
    max: 100,
    step: 5,
    unit: "%",
    effect: "immediate",
    appliesTo: "应用内播放器",
  },
  {
    id: "system.mode",
    group: "system",
    label: "运行模式",
    desc: "Local Mode 不需要账号；Cloud Mode 启用同步、云盘与备份",
    type: "select",
    default: "local",
    options: [
      { value: "local", label: "Local Mode" },
      { value: "cloud", label: "Cloud Mode" },
    ],
    effect: "restart",
    appliesTo: "云端服务管理器",
  },
  {
    id: "system.updateChannel",
    group: "system",
    label: "更新通道",
    desc: "稳定版只接收正式发布；预览版会更早收到变更",
    type: "select",
    default: "stable",
    options: [
      { value: "stable", label: "稳定版" },
      { value: "preview", label: "预览版" },
    ],
    effect: "restart",
    appliesTo: "更新中心",
  },
  {
    id: "system.diagnosticsRetention",
    group: "system",
    label: "诊断日志保留",
    desc: "保留最近多少条本地诊断记录",
    type: "number",
    default: 200,
    min: 20,
    max: 500,
    step: 20,
    unit: "条",
    effect: "immediate",
    appliesTo: "诊断中心",
  },
];

export const SETTINGS_BY_ID: Record<string, SettingField> = Object.fromEntries(
  SETTINGS_SCHEMA.map((field) => [field.id, field]),
);

export type SettingsValues = Record<string, SettingValue>;

export type SettingsChange = { id: string; previous: SettingValue; value: SettingValue };

export type SettingsOptions = {
  storage: StorageManager;
  schema?: SettingField[];
  emit?: (type: string, payload?: unknown) => void;
};

const STATE_KEY = "settings.v1";

const defaults = (schema: SettingField[]): SettingsValues =>
  Object.fromEntries(schema.map((field) => [field.id, field.default]));

export class SettingsManager {
  private storage: StorageManager;
  private schema: SettingField[];
  private emitFn: (type: string, payload?: unknown) => void;
  private cache: SettingsValues | null = null;
  private listeners = new Set<(values: SettingsValues, changes: SettingsChange[]) => void>();

  constructor(options: SettingsOptions) {
    this.storage = options.storage;
    this.schema = options.schema ?? SETTINGS_SCHEMA;
    this.emitFn = options.emit ?? (() => undefined);
  }

  schemaOf(): SettingField[] {
    return this.schema.slice();
  }

  /** 读取全部设置；缺项用默认值补齐，非法类型回退默认值 */
  read(): SettingsValues {
    if (this.cache) return { ...this.cache };
    const base = defaults(this.schema);
    const stored = this.storage.read<Record<string, unknown>>(STATE_KEY, {});
    const out: SettingsValues = { ...base };
    if (stored && typeof stored === "object") {
      for (const field of this.schema) {
        const value = stored[field.id];
        const coerced = this.coerce(field, value);
        if (coerced !== null) out[field.id] = coerced;
      }
    }
    this.cache = out;
    return { ...out };
  }

  get<T extends SettingValue = SettingValue>(id: string): T {
    const values = this.read();
    return values[id] as T;
  }

  /**
   * 批量更新。非法值会被拒绝并返回失败项，不会写坏存储。
   * 返回 changed 列表，调用方据此决定刷新哪些界面。
   */
  update(patch: SettingsValues): { ok: boolean; changed: SettingsChange[]; rejected: string[] } {
    const current = this.read();
    const changed: SettingsChange[] = [];
    const rejected: string[] = [];

    for (const [id, raw] of Object.entries(patch)) {
      const field = this.schema.find((item) => item.id === id);
      if (!field) {
        rejected.push(id);
        continue;
      }
      const value = this.coerce(field, raw);
      if (value === null) {
        rejected.push(id);
        continue;
      }
      if (value !== current[id]) changed.push({ id, previous: current[id], value });
      current[id] = value;
    }

    if (!changed.length) return { ok: rejected.length === 0, changed, rejected };

    this.cache = current;
    this.storage.write(STATE_KEY, current);
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...current }, changed);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
    for (const change of changed) this.emitFn("settings:change", change);
    return { ok: rejected.length === 0, changed, rejected };
  }

  set(id: string, value: SettingValue): boolean {
    return this.update({ [id]: value }).ok;
  }

  reset(ids?: string[]): SettingsChange[] {
    const current = this.read();
    const patch: SettingsValues = {};
    for (const field of this.schema) {
      if (ids && !ids.includes(field.id)) continue;
      patch[field.id] = field.default;
    }
    const changed: SettingsChange[] = [];
    for (const [id, value] of Object.entries(patch)) {
      if (current[id] !== value) changed.push({ id, previous: current[id], value });
    }
    this.update(patch);
    return changed;
  }

  subscribe(listener: (values: SettingsValues, changes: SettingsChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 导出（数据中心 / 迁移用） */
  export(): string {
    return JSON.stringify({ version: 2, values: this.read() }, null, 2);
  }

  /** 导入：逐项校验，返回被拒绝的键 */
  import(json: string): { ok: boolean; rejected: string[] } {
    try {
      const parsed = JSON.parse(json) as { values?: Record<string, unknown> } | Record<string, unknown>;
      const values = (parsed as { values?: Record<string, unknown> }).values ?? (parsed as Record<string, unknown>);
      const patch: SettingsValues = {};
      const rejected: string[] = [];
      for (const [id, value] of Object.entries(values)) {
        const field = this.schema.find((item) => item.id === id);
        if (!field) {
          rejected.push(id);
          continue;
        }
        const coerced = this.coerce(field, value);
        if (coerced === null) rejected.push(id);
        else patch[id] = coerced;
      }
      this.update(patch);
      return { ok: rejected.length === 0, rejected };
    } catch {
      return { ok: false, rejected: ["<json>"] };
    }
  }

  /* ---------------- 内部 ---------------- */

  private coerce(field: SettingField, raw: unknown): SettingValue | null {
    if (raw === undefined || raw === null) return null;
    if (field.type === "boolean") {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1" || raw === 1) return true;
      if (raw === "false" || raw === "0" || raw === 0) return false;
      return null;
    }
    if (field.type === "number") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) return null;
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      return Math.min(max, Math.max(min, value));
    }
    if (typeof raw !== "string") return null;
    const options = field.options ?? [];
    if (options.length && !options.some((option) => option.value === raw)) {
      // 强调色允许自定义十六进制值
      if (field.id === "appearance.accent" && /^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
      return null;
    }
    return raw;
  }
}

export const createSettings = (options: SettingsOptions) => new SettingsManager(options);