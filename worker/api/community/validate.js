/**
 * Guandao OS 1.6 · 社区内容包校验
 *
 * 这是社区安全的核心边界：社区资源包永远只是声明式 JSON，不包含可执行代码。
 * 校验分为三层：
 *   1. 结构：严格白名单字段，未知字段直接拒绝（防止偷偷塞入执行字段）；
 *   2. 取值：枚举、数值范围、长度、数量、兼容版本、许可证；
 *   3. 资源：图片只接受服务端嗅探过的位图格式，禁止 SVG/HTML/任意 URL。
 *
 * 该文件不得依赖任何前端模块，所有函数都是纯函数，便于单元测试。
 */

import { ApiError } from "../http.js";

/** 当前系统版本：内容包兼容性以此为基准。 */
export const OS_VERSION = "2.0.0";

export const POST_TYPES = ["theme", "widget", "workspace", "wallpaper", "tutorial"];

export const PACKAGE_TYPE_BY_POST = {
  theme: "theme",
  widget: "widget",
  workspace: "workspace",
  wallpaper: "wallpaper-collection",
  tutorial: "tutorial",
};

export const LICENSE_IDS = [
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "ALL-RIGHTS-RESERVED",
  "CUSTOM",
];

export const CATEGORIES = {
  theme: ["dark", "light", "colorful", "minimal", "retro", "tech", "nature", "other"],
  widget: ["clock", "calendar", "weather", "focus", "quote", "photo", "music", "system", "productivity", "decorative"],
  workspace: ["minimal", "study", "work", "creative", "reading", "entertainment", "other"],
  wallpaper: ["nature", "city", "space", "minimal", "abstract", "architecture", "anime", "photography", "technology"],
  tutorial: ["guide", "tip", "workflow", "other"],
};

export const WALLPAPER_CATEGORIES = CATEGORIES.wallpaper;

/** 与 src/lib/wallpapers.ts 对齐的内置壁纸 ID；主题只能引用这些本地资源。 */
export const BUILTIN_WALLPAPERS = new Set([
  "ridge", "snow", "forest", "coast", "sunset", "stars", "aurora", "lake",
  "city-night", "tokyo", "future-arch", "skyline", "arch-min",
  "gradient", "fluid", "glass", "geo", "digital", "tech",
  "space", "ocean", "ink", "harbor", "dunes",
]);

export const WIDGET_TYPES = CATEGORIES.widget;

const HEX = /^#[0-9a-f]{6}$/i;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TAG = /^[\w\u4e00-\u9fff -]{1,20}$/;
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,20})?$/;

/** 任何层级出现这些键都视为试图夹带可执行内容，直接拒绝。 */
const FORBIDDEN_KEY = /^(script|scripts|html|innerhtml|outerhtml|eval|function|functions|handler|handlers|on[a-z]+|src|url|href|import|imports|wasm|code|exec|execute|js|css|stylecontent|srcdoc)$/i;

const LIMITS = {
  manifestBytes: 128 * 1024,
  title: 80,
  description: 8000,
  licenseNote: 600,
  tags: 8,
  previews: 6,
  wallpaperItems: 12,
  workspaceApps: 40,
  workspaceWidgets: 40,
  tutorialChars: 20_000,
};

/* ============================================================
   基础工具
   ============================================================ */

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(message, code = "INVALID_MANIFEST") {
  throw new ApiError(code, message, 400);
}

export function strictKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path} 包含不支持的字段「${key}」`);
    }
  }
}

/** 递归检查禁止字段与深度；manifest 总量另有上限。 */
export function assertSafeTree(value, path = "manifest", depth = 0) {
  if (depth > 8) fail("内容包嵌套层级过深");
  if (Array.isArray(value)) {
    if (value.length > 200) fail(`${path} 数组过长`);
    value.forEach((item, index) => assertSafeTree(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(`${path} 包含不允许的执行字段「${key}」`);
    }
    assertSafeTree(child, `${path}.${key}`, depth + 1);
  }
}

export function cleanText(value, max, { required = false, allowNewline = true } = {}) {
  let text = typeof value === "string" ? value : "";
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // 去除除换行 / 制表符以外的控制字符
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (!allowNewline) text = text.replace(/[\n\t]/g, " ");
  text = text.trim();
  if (required && !text) fail("必填内容不能为空");
  if (text.length > max) fail(`内容长度不能超过 ${max} 个字符`);
  return text;
}

export function sanitizeTag(value) {
  const tag = cleanText(value, 20, { allowNewline: false });
  if (!tag) return "";
  if (!TAG.test(tag)) fail(`标签「${tag}」只能包含中英文、数字、空格与短横线`);
  return tag;
}

export function canonicalJson(value) {
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (isPlainObject(input)) {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = walk(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

/* ============================================================
   版本与兼容性
   ============================================================ */

export function parseSemver(value) {
  const raw = String(value ?? "").trim();
  if (!SEMVER.test(raw)) fail(`版本号「${raw || "空"}」不是有效的 semver（例如 1.0.0）`);
  const core = raw.split("-")[0].split(".").map((n) => Number(n));
  return { raw, parts: core };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a).parts;
  const pb = parseSemver(b).parts;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** 返回 {ok, minimum, maximum, reason} */
export function checkCompatibility(compatibility, current = OS_VERSION) {
  if (!isPlainObject(compatibility)) fail("compatibility 必须是对象");
  strictKeys(compatibility, ["minimum", "maximum"], "compatibility");
  const minimum = String(compatibility.minimum ?? "1.3.0");
  parseSemver(minimum);
  let maximum = null;
  if (compatibility.maximum != null && compatibility.maximum !== "") {
    maximum = String(compatibility.maximum);
    parseSemver(maximum);
    if (compareSemver(maximum, minimum) < 0) fail("最高兼容版本不能低于最低版本");
  }
  if (compareSemver(minimum, current) > 0) {
    return { ok: false, minimum, maximum, reason: `需要 Guandao OS ${minimum} 或更高版本，当前为 ${current}` };
  }
  if (maximum && compareSemver(maximum, current) < 0) {
    return { ok: false, minimum, maximum, reason: `只兼容到 Guandao OS ${maximum}，当前为 ${current}` };
  }
  return { ok: true, minimum, maximum, reason: "" };
}

/* ============================================================
   主题配置
   ============================================================ */

const FONT_TONES = ["sans", "serif", "mono"];
const MATERIALS = ["glass", "frost", "solid"];
const RADII = ["soft", "round", "sharp"];

export function validateThemeConfig(raw) {
  if (!isPlainObject(raw)) fail("主题 configuration 必须是对象");
  strictKeys(raw, ["name", "en", "style", "desc", "wall", "mode", "accent", "accent2", "material", "radius", "darken", "dock", "font", "grain", "tags"], "configuration");
  const name = cleanText(raw.name, 24, { required: true, allowNewline: false });
  const en = cleanText(raw.en ?? "Community", 16, { allowNewline: false }) || "Community";
  const style = cleanText(raw.style ?? "社区主题", 20, { allowNewline: false }) || "社区主题";
  const desc = cleanText(raw.desc ?? "", 300);
  const wall = String(raw.wall ?? "");
  if (!BUILTIN_WALLPAPERS.has(wall)) fail("主题壁纸必须是 Guandao OS 内置壁纸 ID");
  const accent = String(raw.accent ?? "");
  const accent2 = String(raw.accent2 ?? "");
  if (!HEX.test(accent) || !HEX.test(accent2)) fail("强调色必须是 #RRGGBB 格式");
  const mode = raw.mode === "light" ? "light" : raw.mode === "dark" ? "dark" : fail("mode 必须是 dark 或 light");
  const material = MATERIALS.includes(raw.material) ? raw.material : fail("material 取值不合法");
  const radius = RADII.includes(raw.radius) ? raw.radius : fail("radius 取值不合法");
  const font = FONT_TONES.includes(raw.font) ? raw.font : "sans";
  const darken = Number(raw.darken ?? 20);
  if (!Number.isFinite(darken) || darken < 0 || darken > 80) fail("darken 必须在 0–80 之间");
  const dockRaw = raw.dock ?? {};
  if (!isPlainObject(dockRaw)) fail("dock 必须是对象");
  strictKeys(dockRaw, ["size", "magnify", "opacity"], "configuration.dock");
  const size = Number(dockRaw.size ?? 46);
  const magnify = Number(dockRaw.magnify ?? 1.2);
  const opacity = Number(dockRaw.opacity ?? 0.55);
  if (!Number.isFinite(size) || size < 34 || size > 72) fail("dock.size 必须在 34–72 之间");
  if (!Number.isFinite(magnify) || magnify < 1 || magnify > 1.6) fail("dock.magnify 必须在 1–1.6 之间");
  if (!Number.isFinite(opacity) || opacity < 0.2 || opacity > 1) fail("dock.opacity 必须在 0.2–1 之间");
  const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 5).map(sanitizeTag).filter(Boolean) : [];
  return {
    name,
    en,
    style,
    desc,
    wall,
    mode,
    accent: accent.toLowerCase(),
    accent2: accent2.toLowerCase(),
    material,
    radius,
    darken,
    dock: { size, magnify, opacity },
    font,
    grain: Boolean(raw.grain),
    tags: tags.length ? tags : ["社区"],
  };
}

/* ============================================================
   组件配置：声明式，只允许系统已注册类型的受控属性
   ============================================================ */

const WIDGET_PROP_SCHEMA = {
  clock: {
    style: ["digital", "analog"],
    accent: "hex",
    label: ["text", 24],
    showSeconds: "boolean",
    format: ["24", "12"],
  },
  calendar: {
    accent: "hex",
    label: ["text", 24],
  },
  weather: {
    accent: "hex",
    city: ["text", 24],
    units: ["c", "f"],
  },
  focus: {
    accent: "hex",
    label: ["text", 24],
    minutes: ["number", 5, 120],
  },
  quote: {
    accent: "hex",
    text: ["text", 120],
    author: ["text", 32],
  },
  photo: {
    accent: "hex",
    caption: ["text", 60],
    fit: ["cover", "contain"],
  },
  music: {
    accent: "hex",
    label: ["text", 24],
    showControls: "boolean",
  },
  system: {
    accent: "hex",
    label: ["text", 24],
    showDetails: "boolean",
  },
  productivity: {
    accent: "hex",
    label: ["text", 24],
    mode: ["tasks", "focus", "notes"],
  },
  decorative: {
    accent: "hex",
    pattern: ["grid", "dots", "lines"],
    opacity: ["number", 0.1, 1],
  },
};

export const WIDGET_PERMISSIONS = {
  time: "读取本地时间",
  date: "读取本地日期",
  weather: "通过网络获取天气（open-meteo）",
  photos: "读取你主动选择的本地相册图片",
  music: "读取本地音乐播放状态",
  system: "读取浏览器可见的系统状态（非隐私数据）",
  none: "不需要额外数据",
};

function validateWidgetProp(type, key, value) {
  const rule = WIDGET_PROP_SCHEMA[type]?.[key];
  if (!rule) fail(`组件类型 ${type} 不支持属性「${key}」`);
  if (rule === "hex") {
    if (!HEX.test(String(value))) fail(`属性 ${key} 必须是 #RRGGBB`);
    return String(value).toLowerCase();
  }
  if (rule === "boolean") {
    if (typeof value !== "boolean") fail(`属性 ${key} 必须是布尔值`);
    return value;
  }
  if (Array.isArray(rule)) {
    if (rule[0] === "number") {
      const num = Number(value);
      if (!Number.isFinite(num) || num < rule[1] || num > rule[2]) fail(`属性 ${key} 必须在 ${rule[1]}–${rule[2]} 之间`);
      return num;
    }
    if (rule[0] === "text") return cleanText(value, rule[1], { allowNewline: false });
    if (!rule.includes(String(value))) fail(`属性 ${key} 取值不合法`);
    return String(value);
  }
  fail(`属性 ${key} 校验规则缺失`);
}

export function validateWidgetConfig(raw) {
  if (!isPlainObject(raw)) fail("组件 configuration 必须是对象");
  strictKeys(raw, ["widgetType", "props", "permissions", "dependencies"], "configuration");
  const widgetType = String(raw.widgetType ?? "");
  if (!WIDGET_TYPES.includes(widgetType)) fail("组件类型必须是系统已注册的类型");
  const propsRaw = raw.props ?? {};
  if (!isPlainObject(propsRaw)) fail("props 必须是对象");
  const props = {};
  for (const [key, value] of Object.entries(propsRaw)) props[key] = validateWidgetProp(widgetType, key, value);
  const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
  if (permissions.length > 4) fail("权限声明过多");
  const perms = [];
  for (const permission of permissions) {
    if (!WIDGET_PERMISSIONS[permission]) fail(`未知权限声明「${permission}」`);
    if (!perms.includes(permission)) perms.push(permission);
  }
  const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies.slice(0, 8) : [];
  for (const dep of dependencies) {
    if (!APP_ID.test(String(dep))) fail("依赖项格式不合法");
  }
  return { widgetType, props, permissions: perms.length ? perms : ["none"], dependencies };
}

/* ============================================================
   工作空间配置：只允许布局与外观，绝不包含笔记 / 文件 / 账号数据
   ============================================================ */

function idList(raw, max, label) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail(`${label} 必须是数组`);
  if (raw.length > max) fail(`${label} 数量不能超过 ${max}`);
  const out = [];
  for (const item of raw) {
    const id = String(item ?? "");
    if (!APP_ID.test(id)) fail(`${label} 中包含不合法的 ID`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function validateWorkspaceConfig(raw) {
  if (!isPlainObject(raw)) fail("工作空间 configuration 必须是对象");
  strictKeys(raw, ["name", "description", "themeId", "wallId", "dock", "shortcuts", "openApps", "widgets", "dnd"], "configuration");
  const name = cleanText(raw.name, 24, { required: true, allowNewline: false });
  const description = cleanText(raw.description ?? "", 200);
  const themeId = raw.themeId == null || raw.themeId === "" ? "" : String(raw.themeId);
  if (themeId && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(themeId)) fail("themeId 格式不合法");
  const wallId = raw.wallId == null || raw.wallId === "" ? "" : String(raw.wallId);
  if (wallId && !BUILTIN_WALLPAPERS.has(wallId) && !/^custom:[a-z0-9-]{1,40}$/.test(wallId)) {
    fail("wallId 必须是内置壁纸或本地自定义壁纸");
  }
  const dock = idList(raw.dock, LIMITS.workspaceApps, "dock");
  const shortcuts = idList(raw.shortcuts, LIMITS.workspaceApps, "shortcuts");
  const openApps = idList(raw.openApps, LIMITS.workspaceApps, "openApps");
  const widgetsRaw = raw.widgets ?? {};
  if (!isPlainObject(widgetsRaw)) fail("widgets 必须是对象");
  if (Object.keys(widgetsRaw).length > LIMITS.workspaceWidgets) fail("组件数量过多");
  const widgets = {};
  for (const [id, state] of Object.entries(widgetsRaw)) {
    if (!APP_ID.test(id)) fail("组件 ID 不合法");
    if (!isPlainObject(state)) fail("组件状态必须是对象");
    strictKeys(state, ["enabled", "size", "x", "y"], `configuration.widgets.${id}`);
    const item = {};
    if (state.enabled !== undefined) item.enabled = Boolean(state.enabled);
    if (state.size !== undefined) {
      if (!["s", "m", "l"].includes(state.size)) fail("组件尺寸必须是 s / m / l");
      item.size = state.size;
    }
    for (const axis of ["x", "y"]) {
      if (state[axis] === undefined) continue;
      const num = Number(state[axis]);
      if (!Number.isFinite(num) || Math.abs(num) > 20000) fail("组件坐标超出允许范围");
      item[axis] = Math.round(num);
    }
    widgets[id] = item;
  }
  return {
    name,
    description,
    themeId,
    wallId,
    dock,
    shortcuts,
    openApps,
    widgets,
    dnd: Boolean(raw.dnd),
  };
}

/* ============================================================
   壁纸合集 / 教程
   ============================================================ */

export function validateWallpaperConfig(raw) {
  if (raw == null) raw = {};
  if (!isPlainObject(raw)) fail("壁纸 configuration 必须是对象");
  strictKeys(raw, ["collectionName", "ratio", "items"], "configuration");
  const collectionName = cleanText(raw.collectionName ?? "", 40, { allowNewline: false });
  const ratio = String(raw.ratio ?? "16:9");
  if (!["16:9", "16:10", "21:9", "4:3", "3:2", "9:16", "1:1"].includes(ratio)) fail("图片比例不合法");
  const items = Array.isArray(raw.items) ? raw.items.slice(0, LIMITS.wallpaperItems) : [];
  const clean = items.map((item, index) => {
    if (!isPlainObject(item)) fail("壁纸条目必须是对象");
    strictKeys(item, ["caption"], `configuration.items[${index}]`);
    return { caption: cleanText(item.caption ?? "", 80, { allowNewline: false }) };
  });
  return { collectionName, ratio, items: clean };
}

export function validateTutorialConfig(raw) {
  if (!isPlainObject(raw)) fail("教程 configuration 必须是对象");
  strictKeys(raw, ["content"], "configuration");
  const content = cleanText(raw.content, LIMITS.tutorialChars);
  if (!content) fail("教程正文不能为空");
  if (/<\s*(script|iframe|object|embed|style|link|meta)\b/i.test(content)) {
    fail("教程正文不能包含 HTML 标签（支持 Markdown）");
  }
  return { content };
}

/* ============================================================
   统一 Manifest 校验
   ============================================================ */

export function validateManifest(raw, expectedPostType) {
  assertSafeTree(raw);
  if (!isPlainObject(raw)) fail("内容包必须是 JSON 对象");
  strictKeys(raw, ["schemaVersion", "packageId", "type", "name", "version", "author", "description", "compatibility", "license", "licenseNote", "assets", "configuration"], "manifest");

  if (Number(raw.schemaVersion) !== 1) fail("schemaVersion 必须为 1");
  const packageId = String(raw.packageId ?? "");
  if (!PACKAGE_ID.test(packageId)) fail("packageId 只能使用 3–64 位小写字母、数字与短横线");
  const type = String(raw.type ?? "");
  if (!POST_TYPES.includes(type)) fail("type 必须是 theme / widget / workspace / wallpaper / tutorial");
  if (expectedPostType && type !== expectedPostType) fail(`内容包类型 ${type} 与作品类型 ${expectedPostType} 不一致`);

  const name = cleanText(raw.name, 80, { required: true, allowNewline: false });
  const version = String(raw.version ?? "");
  parseSemver(version);
  const author = cleanText(raw.author ?? "", 40, { allowNewline: false });
  const description = cleanText(raw.description ?? "", 600);
  const license = String(raw.license ?? "");
  if (!LICENSE_IDS.includes(license)) fail("许可证不在支持列表中");
  const licenseNote = cleanText(raw.licenseNote ?? "", LIMITS.licenseNote);
  if (license === "CUSTOM" && licenseNote.length < 10) fail("自定义许可证需要至少 10 个字符的授权说明");

  const compatibility = raw.compatibility ?? { minimum: "1.3.0" };
  const compatCheck = checkCompatibility(compatibility);

  const assetsRaw = raw.assets ?? [];
  if (!Array.isArray(assetsRaw) || assetsRaw.length > 20) fail("assets 必须是数组且不超过 20 项");
  const assets = assetsRaw.map((asset, index) => {
    if (!isPlainObject(asset)) fail("assets 条目必须是对象");
    strictKeys(asset, ["kind", "ref"], `assets[${index}]`);
    const kind = String(asset.kind ?? "");
    if (!["wallpaper-ref", "preview"].includes(kind)) fail("assets.kind 只能是 wallpaper-ref 或 preview");
    const ref = String(asset.ref ?? "");
    if (!PACKAGE_ID.test(ref)) fail("assets.ref 格式不合法");
    return { kind, ref };
  });

  const configuration = raw.configuration ?? {};
  let config;
  if (type === "theme") config = validateThemeConfig(configuration);
  else if (type === "widget") config = validateWidgetConfig(configuration);
  else if (type === "workspace") config = validateWorkspaceConfig(configuration);
  else if (type === "wallpaper") config = validateWallpaperConfig(configuration);
  else config = validateTutorialConfig(configuration);

  const manifest = {
    schemaVersion: 1,
    packageId,
    type,
    name,
    version,
    author,
    description,
    compatibility: {
      minimum: compatCheck.minimum,
      ...(compatCheck.maximum ? { maximum: compatCheck.maximum } : {}),
    },
    license,
    ...(licenseNote ? { licenseNote } : {}),
    assets,
    configuration: config,
  };

  const canonical = canonicalJson(manifest);
  if (byteLength(canonical) > LIMITS.manifestBytes) fail(`内容包超过 ${LIMITS.manifestBytes / 1024} KB 上限`);

  return {
    manifest,
    canonical,
    compatibility: compatCheck,
    warnings: compatCheck.ok ? [] : [compatCheck.reason],
  };
}

/* ============================================================
   图片嗅探：只允许位图，拒绝 SVG / HTML / 伪装扩展名
   ============================================================ */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function imageInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  const startsWith = (sig, offset = 0) => sig.every((v, i) => b[offset + i] === v);

  // PNG
  if (startsWith(PNG_SIG)) {
    if (b.length < 24) return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return { mime: "image/png", ext: "png", width, height };
  }

  // JPEG：扫描 SOF0/1/2 段
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset++; continue; }
      const marker = b[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (b[offset + 2] << 8) | b[offset + 3];
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (b[offset + 5] << 8) | b[offset + 6];
        const width = (b[offset + 7] << 8) | b[offset + 8];
        return { mime: "image/jpeg", ext: "jpg", width, height };
      }
      offset += 2 + length;
    }
    return null;
  }

  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { mime: "image/gif", ext: "gif", width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }

  // WebP（RIFF....WEBP）
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X" && b.length >= 30) {
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { mime: "image/webp", ext: "webp", width, height };
    }
    if (chunk === "VP8 " && b.length >= 30) {
      const width = (b[26] | (b[27] << 8)) & 0x3fff;
      const height = (b[28] | (b[29] << 8)) & 0x3fff;
      return { mime: "image/webp", ext: "webp", width, height };
    }
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { mime: "image/webp", ext: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }

  return null;
}

export function assertImage(bytes, kind) {
  const info = imageInfo(bytes);
  if (!info) {
    throw new ApiError("UNSUPPORTED_IMAGE", "只支持真实的 JPG / PNG / WebP / GIF 图片，SVG 与网页文件不能上传", 415);
  }
  if (!info.width || !info.height) {
    throw new ApiError("INVALID_IMAGE", "图片尺寸读取失败", 415);
  }
  if (info.width > 12_000 || info.height > 12_000 || info.width * info.height > 50_000_000) {
    throw new ApiError("IMAGE_TOO_LARGE", "图片尺寸过大（最大 12000px / 5000 万像素）", 413);
  }
  const caps = {
    avatar: 2 * 1024 * 1024,
    cover: 6 * 1024 * 1024,
    cover_thumb: 2 * 1024 * 1024,
    preview: 8 * 1024 * 1024,
    preview_thumb: 2 * 1024 * 1024,
    wallpaper: 16 * 1024 * 1024,
    wallpaper_thumb: 2 * 1024 * 1024,
  };
  if (bytes.byteLength > (caps[kind] ?? 8 * 1024 * 1024)) {
    throw new ApiError("FILE_TOO_LARGE", "图片文件超过该用途的大小上限", 413);
  }
  return info;
}

/** 资源分类的 Object Key 前缀，与 README 约定一致。 */
export function objectPrefix(kind) {
  switch (kind) {
    case "avatar": return "avatars";
    case "cover":
    case "cover_thumb": return "covers";
    case "preview":
    case "preview_thumb": return "previews";
    case "wallpaper":
    case "wallpaper_thumb": return "wallpapers";
    default: return "assets";
  }
}

export function packageObjectKey(userId, postId, version, name = "package") {
  return `users/${userId}/community/packages/${postId}/${version}/${name}.json`;
}

export { HEX, PACKAGE_ID, APP_ID, LIMITS };
