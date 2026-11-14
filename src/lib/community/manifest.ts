/**
 * Guandao OS 1.6 · 社区内容包客户端预检
 *
 * 服务端才是权威校验；这里只做发布前的即时反馈，避免用户填完一整页
 * 才收到错误。两边规则保持一致，但任何客户端判断都不能替代服务端。
 */

export type ManifestType = "theme" | "widget" | "workspace" | "wallpaper" | "tutorial";

export type ThemeConfig = {
  name: string;
  en: string;
  style: string;
  desc: string;
  wall: string;
  mode: "dark" | "light";
  accent: string;
  accent2: string;
  material: "glass" | "frost" | "solid";
  radius: "soft" | "round" | "sharp";
  darken: number;
  dock: { size: number; magnify: number; opacity: number };
  font: "sans" | "serif" | "mono";
  grain: boolean;
  tags: string[];
};

export type WidgetConfig = {
  widgetType: string;
  props: Record<string, string | number | boolean>;
  permissions: string[];
  dependencies: string[];
};

export type WorkspaceConfig = {
  name: string;
  description: string;
  themeId: string;
  wallId: string;
  dock: string[];
  shortcuts: string[];
  openApps: string[];
  widgets: Record<string, { enabled?: boolean; size?: "s" | "m" | "l"; x?: number; y?: number }>;
  dnd: boolean;
};

export type Manifest = {
  schemaVersion: 1;
  packageId: string;
  type: ManifestType;
  name: string;
  version: string;
  author: string;
  description: string;
  compatibility: { minimum: string; maximum?: string };
  license: string;
  licenseNote?: string;
  assets: Array<{ kind: string; ref: string }>;
  configuration: ThemeConfig | WidgetConfig | WorkspaceConfig | Record<string, unknown>;
};

import { OS_VERSION } from "../version";

export const LICENSE_OPTIONS: Array<{ id: string; name: string; summary: string; commercial: boolean; modify: boolean; redistribute: boolean }> = [
  { id: "CC0-1.0", name: "CC0 公共领域", summary: "放弃全部权利，任何人可自由使用。", commercial: true, modify: true, redistribute: true },
  { id: "CC-BY-4.0", name: "CC BY 4.0", summary: "允许商用与修改，必须署名作者。", commercial: true, modify: true, redistribute: true },
  { id: "CC-BY-SA-4.0", name: "CC BY-SA 4.0", summary: "允许商用与修改，衍生作品需相同协议。", commercial: true, modify: true, redistribute: true },
  { id: "ALL-RIGHTS-RESERVED", name: "保留所有权利", summary: "仅允许下载与个人使用，禁止再分发。", commercial: false, modify: false, redistribute: false },
  { id: "CUSTOM", name: "自定义授权", summary: "在下方写明具体使用限制。", commercial: false, modify: false, redistribute: false },
];

export const WIDGET_TYPES = ["clock", "calendar", "weather", "focus", "quote", "photo", "music", "system", "productivity", "decorative"];

export const WIDGET_TYPE_LABEL: Record<string, string> = {
  clock: "时钟",
  calendar: "日历",
  weather: "天气",
  focus: "专注",
  quote: "语录",
  photo: "照片",
  music: "音乐",
  system: "系统",
  productivity: "效率",
  decorative: "装饰",
};

export const CATEGORY_LABEL: Record<string, Record<string, string>> = {
  theme: { dark: "深色", light: "浅色", colorful: "彩色", minimal: "极简", retro: "复古", tech: "科技", nature: "自然", other: "其他" },
  widget: { clock: "时钟", calendar: "日历", weather: "天气", focus: "专注", quote: "语录", photo: "照片", music: "音乐", system: "系统", productivity: "效率", decorative: "装饰" },
  workspace: { minimal: "极简", study: "学习", work: "工作", creative: "创意", reading: "阅读", entertainment: "娱乐", other: "其他" },
  wallpaper: { nature: "自然", city: "城市", space: "宇宙", minimal: "极简", abstract: "抽象", architecture: "建筑", anime: "动漫", photography: "摄影", technology: "科技" },
  tutorial: { guide: "指南", tip: "技巧", workflow: "工作流", other: "其他" },
};

export function compareSemver(a: string, b: string): number {
  const pa = String(a).split("-")[0].split(".").map((n) => Number(n) || 0);
  const pb = String(b).split("-")[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

export function compatibilityCheck(compatibility: { minimum?: string; maximum?: string } | null | undefined): {
  ok: boolean;
  label: string;
  reason: string;
} {
  const minimum = compatibility?.minimum || "1.3.0";
  const maximum = compatibility?.maximum;
  if (compareSemver(minimum, OS_VERSION) > 0) {
    return { ok: false, label: "当前系统版本过低", reason: `需要 ${minimum} 或更高，当前 ${OS_VERSION}` };
  }
  if (maximum && compareSemver(maximum, OS_VERSION) < 0) {
    return { ok: false, label: "当前系统版本过高", reason: `只兼容到 ${maximum}，当前 ${OS_VERSION}` };
  }
  return { ok: true, label: "兼容当前系统", reason: "" };
}

const HEX = /^#[0-9a-f]{6}$/i;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function validateManifestClient(raw: unknown, expectedType?: ManifestType): {
  ok: boolean;
  errors: string[];
  manifest: Manifest | null;
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["内容包必须是 JSON 对象"], manifest: null };
  }
  const m = raw as Record<string, unknown>;
  if (Number(m.schemaVersion) !== 1) errors.push("schemaVersion 必须为 1");
  if (!PACKAGE_ID.test(String(m.packageId ?? ""))) errors.push("packageId 需为 3–64 位小写字母、数字或短横线");
  if (!["theme", "widget", "workspace", "wallpaper", "tutorial"].includes(String(m.type))) errors.push("type 不合法");
  if (expectedType && String(m.type) !== expectedType) errors.push(`内容包类型必须为 ${expectedType}`);
  if (!String(m.name ?? "").trim()) errors.push("缺少名称");
  if (!SEMVER.test(String(m.version ?? ""))) errors.push("版本号需为 x.y.z");
  const compatibility = (m.compatibility ?? {}) as Record<string, unknown>;
  const compat = compatibilityCheck({
    minimum: String(compatibility.minimum ?? "1.3.0"),
    maximum: compatibility.maximum ? String(compatibility.maximum) : undefined,
  });
  if (!compat.ok) errors.push(compat.reason);
  if (!["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "ALL-RIGHTS-RESERVED", "CUSTOM"].includes(String(m.license))) {
    errors.push("许可证不在支持列表中");
  }
  if (m.license === "CUSTOM" && String(m.licenseNote ?? "").trim().length < 10) {
    errors.push("自定义许可证需填写至少 10 个字符的说明");
  }

  const config = m.configuration;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    errors.push("缺少 configuration");
  } else if (m.type === "theme") {
    const c = config as Record<string, unknown>;
    if (!String(c.name ?? "").trim()) errors.push("主题缺少名称");
    if (!HEX.test(String(c.accent ?? "")) || !HEX.test(String(c.accent2 ?? ""))) errors.push("强调色需为 #RRGGBB");
    if (!["dark", "light"].includes(String(c.mode))) errors.push("mode 不合法");
    if (!["glass", "frost", "solid"].includes(String(c.material))) errors.push("material 不合法");
    if (!["soft", "round", "sharp"].includes(String(c.radius))) errors.push("radius 不合法");
    if (!String(c.wall ?? "")) errors.push("缺少壁纸 ID");
  } else if (m.type === "widget") {
    const c = config as Record<string, unknown>;
    if (!WIDGET_TYPES.includes(String(c.widgetType))) errors.push("组件类型必须是系统已注册类型");
    if (!c.props || typeof c.props !== "object") errors.push("缺少组件属性");
    if (Array.isArray(c.dependencies) && c.dependencies.some((dep) => !/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(dep)))) {
      errors.push("依赖项格式不合法");
    }
  } else if (m.type === "workspace") {
    const c = config as Record<string, unknown>;
    if (!String(c.name ?? "").trim()) errors.push("工作空间缺少名称");
    for (const key of ["dock", "shortcuts", "openApps"]) {
      if (c[key] !== undefined && !Array.isArray(c[key])) errors.push(`${key} 必须是数组`);
    }
  } else if (m.type === "tutorial") {
    const c = config as Record<string, unknown>;
    if (!String(c.content ?? "").trim()) errors.push("教程正文不能为空");
  }

  return { ok: errors.length === 0, errors, manifest: errors.length ? null : (m as unknown as Manifest) };
}

export async function readManifestFile(file: File): Promise<unknown> {
  if (file.size > 128 * 1024) throw new Error("内容包不能超过 128 KB");
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON");
  }
}

export function slugify(value: string, fallback = "community-package"): string {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function nextVersion(current: string): string {
  const parts = String(current || "1.0.0").split(".").map((n) => Number(n) || 0);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}
