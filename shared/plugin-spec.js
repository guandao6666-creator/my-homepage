/**
 * Guandao OS 1.7 · 插件规范（唯一事实来源）
 *
 * 这个文件同时被三处使用：
 *   1. Worker（服务端校验：上传、审核、市场返回）
 *   2. 浏览器运行时（安装前复核、权限展示）
 *   3. CLI（build / validate / package）
 *
 * 约束：
 *   - 纯 ESM、零依赖、不触碰 window / document / node:*
 *   - 不做 I/O，不读环境变量；所有校验都是纯函数
 *   - 归一化顺序必须稳定（数组排序），否则同一份 Manifest 会算出不同摘要
 */

export const OS_VERSION = "2.0.0";
export const SDK_VERSION = 1;
export const MANIFEST_VERSION = 1;
export const PLUGIN_FORMAT = "guandao-plugin";
export const PLUGIN_FORMAT_VERSION = 1;

export const PLUGIN_LIMITS = Object.freeze({
  bundleBytes: 2 * 1024 * 1024,
  files: 48,
  fileBytes: 512 * 1024,
  manifestBytes: 32 * 1024,
  installedPlugins: 24,
  storageBytes: 256 * 1024,
  storageKeys: 128,
  rpcPayloadBytes: 24 * 1024,
  rpcPerWindow: 60,
  rpcWindowMs: 10_000,
  rpcTimeoutMs: 8_000,
  notificationsPerMinute: 5,
  commandCount: 8,
  networkDomains: 8,
  screenshots: 4,
  dependencies: 8,
  nameLength: 48,
  descriptionLength: 2000,
});

export const PLUGIN_TYPES = Object.freeze([
  "application",
  "widget",
  "command",
  "file-handler",
  "theme",
  "integration",
]);

export const PLUGIN_TYPE_META = Object.freeze({
  application: { label: "应用插件", icon: "▣", desc: "在独立窗口中运行的应用", executable: true },
  widget: { label: "组件插件", icon: "▦", desc: "添加到桌面的小组件", executable: true },
  command: { label: "命令插件", icon: "⌘", desc: "向命令面板注册受控命令", executable: true },
  "file-handler": { label: "文件处理", icon: "⌸", desc: "预览、编辑或转换指定类型文件", executable: true },
  theme: { label: "主题扩展", icon: "◑", desc: "声明式配色与材质预设，不执行脚本", executable: false },
  integration: { label: "集成插件", icon: "⇄", desc: "与已声明域名的外部服务交互", executable: true },
});

export const PLUGIN_CATEGORIES = Object.freeze([
  "productivity",
  "system",
  "entertainment",
  "education",
  "creative",
  "developer",
  "other",
]);

export const CATEGORY_LABELS = Object.freeze({
  productivity: "效率",
  system: "系统工具",
  entertainment: "娱乐",
  education: "教育",
  creative: "创意",
  developer: "开发工具",
  other: "其他",
});

/* ============================================================
   权限目录
   ------------------------------------------------------------
   risk        low | medium | high
   sensitive   是否涉及用户私人数据（安装界面必须单独提示）
   network     是否发起外部网络请求（必须列出域名）
   ============================================================ */

export const PERMISSIONS = Object.freeze([
  {
    id: "window.open",
    module: "ui",
    label: "打开插件窗口",
    desc: "允许插件在自己的窗口里显示界面，不能操作其它窗口。",
    risk: "medium",
    sensitive: false,
    network: false,
  },
  {
    id: "notification.show",
    module: "ui",
    label: "发送系统通知",
    desc: "在通知中心显示消息，每分钟最多 5 条。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "dialog.open",
    module: "ui",
    label: "请求确认对话框",
    desc: "就具体操作向用户提问，插件拿不到对话框以外的内容。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "plugin.storage.read",
    module: "storage",
    label: "读取自己的存储",
    desc: "只读取本插件命名空间下的数据，无法读取其它插件。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "plugin.storage.write",
    module: "storage",
    label: "写入自己的存储",
    desc: "在本插件命名空间写入配置，默认上限 256 KB。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "theme.read",
    module: "theme",
    label: "读取当前外观",
    desc: "读取深浅模式、强调色与材质，用于让插件界面跟随系统。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "theme.apply",
    module: "theme",
    label: "应用主题预设",
    desc: "切换系统主题到插件提供的声明式配色，不会执行任意代码。",
    risk: "medium",
    sensitive: false,
    network: false,
  },
  {
    id: "files.pick",
    module: "files",
    label: "选择文件",
    desc: "打开系统文件选择器，只能拿到用户主动选中的文件。",
    risk: "medium",
    sensitive: true,
    network: false,
  },
  {
    id: "files.read_selected",
    module: "files",
    label: "读取已选文件",
    desc: "读取用户刚才明确选中的文件内容（单次授权，最多 256 KB）。",
    risk: "high",
    sensitive: true,
    network: false,
  },
  {
    id: "network.fetch",
    module: "network",
    label: "访问外部网络",
    desc: "只能请求清单里逐个列出的域名，请求经系统代理转发，不带 Cookie。",
    risk: "high",
    sensitive: false,
    network: true,
  },
  {
    id: "desktop.add_widget",
    module: "desktop",
    label: "添加桌面组件",
    desc: "把本插件的组件放到桌面，用户仍可随时移除。",
    risk: "medium",
    sensitive: false,
    network: false,
  },
  {
    id: "desktop.open_app",
    module: "desktop",
    label: "打开其它应用",
    desc: "按应用 ID 打开系统中已安装的应用，不能传入任意 URL。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "desktop.register_command",
    module: "desktop",
    label: "注册命令",
    desc: "在命令面板注册受控命令，最多 8 条，执行前由系统校验权限。",
    risk: "low",
    sensitive: false,
    network: false,
  },
  {
    id: "calendar.read_selected",
    module: "calendar",
    label: "读取选中的日程",
    desc: "只读取用户在选择器里点选的日程条目，不会批量导出日历。",
    risk: "high",
    sensitive: true,
    network: false,
  },
  {
    id: "calendar.create_event",
    module: "calendar",
    label: "创建日程",
    desc: "向 Guandao Calendar 写入一条日程，标题与时间会明确显示。",
    risk: "medium",
    sensitive: false,
    network: false,
  },
  {
    id: "notes.read_selected",
    module: "notes",
    label: "读取选中的笔记",
    desc: "只读取用户在选择器里点选的笔记，不会遍历全部笔记。",
    risk: "high",
    sensitive: true,
    network: false,
  },
  {
    id: "notes.create",
    module: "notes",
    label: "创建笔记",
    desc: "在 Guandao Notes 中新建一条笔记。",
    risk: "medium",
    sensitive: false,
    network: false,
  },
]);

export const PERMISSION_IDS = Object.freeze(PERMISSIONS.map((p) => p.id));
export const PERMISSION_BY_ID = Object.freeze(
  Object.fromEntries(PERMISSIONS.map((p) => [p.id, p])),
);

export const PERMISSION_MODULE_LABELS = Object.freeze({
  ui: "界面",
  storage: "存储",
  theme: "外观",
  files: "文件",
  network: "网络",
  desktop: "桌面",
  calendar: "日历",
  notes: "笔记",
});

export const LICENSES = Object.freeze([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "GPL-3.0",
  "MPL-2.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "Unlicense",
  "proprietary",
]);

/* ============================================================
   基础工具
   ============================================================ */

const ID_RE = /^[a-z0-9]([a-z0-9-]{1,38})?(\.[a-z0-9]([a-z0-9-]{1,38})?){1,4}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,19})?$/;
const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const COMMAND_RE = /^[a-z0-9]+(\.[a-z0-9-]+){1,3}$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/;

/** 禁止进入插件包的文件名后缀：任何可能在服务端或本机执行的东西 */
const FORBIDDEN_EXT = new Set([
  "php", "phtml", "asp", "aspx", "jsp", "cgi", "pl", "py", "rb",
  "exe", "msi", "dll", "so", "dylib", "node", "wasm", "bin", "jar",
  "sh", "bash", "zsh", "bat", "cmd", "ps1", "vbs", "scr", "htaccess",
]);

const ALLOWED_EXT = new Set([
  "html", "htm", "css", "js", "mjs", "json", "svg", "png", "jpg", "jpeg",
  "webp", "gif", "avif", "woff", "woff2", "ttf", "otf", "txt", "md", "csv",
]);

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function byteLength(text) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(String(text)).byteLength;
  return unescape(encodeURIComponent(String(text))).length;
}

/** 稳定序列化：对象键排序，数组顺序保持原样。用于计算摘要。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function parseSemver(version) {
  const text = String(version ?? "").trim();
  if (!SEMVER_RE.test(text)) return null;
  const [core, pre = ""] = text.split("-");
  return { nums: core.split(".").map(Number), pre };
}

export function isSemver(version) {
  return SEMVER_RE.test(String(version ?? ""));
}

/** 插件 ID 的独立校验入口，开发者创建草稿时先于 Manifest 使用。 */
export function isPluginId(id) {
  const text = String(id ?? "").trim();
  return ID_RE.test(text) && text.length <= 80;
}

/**
 * 依赖版本范围。只支持四种写法，避免自己实现一套 npm semver：
 *   1.2.3        精确
 *   ^1.2.3       同主版本，且不低于
 *   ~1.2.3       同次版本，且不低于
 *   >=1.2.3      不低于
 */
export function satisfiesRange(version, range) {
  const target = parseSemver(version);
  if (!target) return false;
  const text = String(range ?? "").trim();
  if (isSemver(text)) return compareSemver(version, text) === 0;
  if (text.startsWith("^") && isSemver(text.slice(1))) {
    const base = parseSemver(text.slice(1));
    return target.nums[0] === base.nums[0] && compareSemver(version, text.slice(1)) >= 0;
  }
  if (text.startsWith("~") && isSemver(text.slice(1))) {
    const base = parseSemver(text.slice(1));
    return target.nums[0] === base.nums[0] && target.nums[1] === base.nums[1] &&
      compareSemver(version, text.slice(1)) >= 0;
  }
  if (text.startsWith(">=") && isSemver(text.slice(2))) {
    return compareSemver(version, text.slice(2)) >= 0;
  }
  return false;
}

export function isSafePackagePath(path) {
  const text = String(path ?? "");
  if (!text || text.length > 120) return false;
  if (text.startsWith("/") || text.startsWith("\\")) return false;
  if (text.includes("\\") || text.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(text)) return false;
  if (text.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(text)) return false;
  const ext = text.split(".").pop()?.toLowerCase() ?? "";
  if (FORBIDDEN_EXT.has(ext)) return false;
  if (!ALLOWED_EXT.has(ext)) return false;
  return true;
}

export function isNetworkHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!host || host.length > 253) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false;
  if (host.startsWith("*.")) return HOST_RE.test(host.slice(2));
  return HOST_RE.test(host);
}

export function matchesNetworkHost(host, allowlist) {
  const target = String(host ?? "").toLowerCase();
  return (Array.isArray(allowlist) ? allowlist : []).some((entry) => {
    const rule = String(entry).toLowerCase();
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      return target === base || target.endsWith(`.${base}`);
    }
    return target === rule;
  });
}

/* ============================================================
   Manifest 校验
   ============================================================ */

function issue(list, path, message, code = "INVALID") {
  list.push({ path, message, code });
}

function readHttpsUrl(value) {
  if (value == null || value === "") return "";
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return null;
    return url.toString().slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * 校验并归一化 Manifest。
 * @param {unknown} raw
 * @param {{ expectedId?: string, expectedType?: string }} [options]
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string,code:string}>, warnings: Array<{path:string,message:string}> , manifest: any|null }}
 */
export function validateManifest(raw, options = {}) {
  const errors = [];
  const warnings = [];
  const data = isPlainObject(raw) ? raw : null;

  if (!data) {
    issue(errors, "manifest", "Manifest 必须是一个 JSON 对象");
    return { ok: false, errors, warnings, manifest: null };
  }

  const manifestBytes = byteLength(JSON.stringify(data));
  if (manifestBytes > PLUGIN_LIMITS.manifestBytes) {
    issue(errors, "manifest", `Manifest 超过 ${Math.round(PLUGIN_LIMITS.manifestBytes / 1024)} KB 上限`);
  }

  if (data.manifestVersion !== MANIFEST_VERSION) {
    issue(errors, "manifestVersion", `仅支持 manifestVersion = ${MANIFEST_VERSION}`);
  }

  const id = String(data.id ?? "").trim();
  if (!ID_RE.test(id) || id.length > 80) {
    issue(errors, "id", "插件 ID 必须是 2–5 段小写反向域名，例如 com.example.tool");
  } else if (options.expectedId && id !== options.expectedId) {
    issue(errors, "id", `插件包内的 ID（${id}）与目标插件（${options.expectedId}）不一致`);
  }

  const name = String(data.name ?? "").trim();
  if (name.length < 2 || name.length > PLUGIN_LIMITS.nameLength) {
    issue(errors, "name", `名称长度需在 2–${PLUGIN_LIMITS.nameLength} 字符之间`);
  }

  const version = String(data.version ?? "").trim();
  if (!isSemver(version)) issue(errors, "version", "版本号必须符合 SemVer，例如 1.0.0");

  const description = String(data.description ?? "").trim();
  if (description.length < 10 || description.length > PLUGIN_LIMITS.descriptionLength) {
    issue(errors, "description", `介绍需在 10–${PLUGIN_LIMITS.descriptionLength} 字符之间`);
  }

  const authorRaw = isPlainObject(data.author) ? data.author : null;
  const authorName = String(authorRaw?.name ?? "").trim().slice(0, 48);
  if (!authorName) issue(errors, "author.name", "必须提供作者名称");
  const authorUrl = readHttpsUrl(authorRaw?.url);
  if (authorUrl === null) issue(errors, "author.url", "作者主页必须使用 https");

  const type = String(data.type ?? "").trim();
  if (!PLUGIN_TYPES.includes(type)) {
    issue(errors, "type", `类型必须是 ${PLUGIN_TYPES.join(" / ")} 之一`);
  } else if (options.expectedType && type !== options.expectedType) {
    issue(errors, "type", `插件类型（${type}）与已登记的 ${options.expectedType} 不一致`);
  }

  const entry = String(data.entry ?? "").trim();
  if (type !== "theme" || entry) {
    if (!entry) issue(errors, "entry", "必须声明入口文件");
    else if (!isSafePackagePath(entry)) issue(errors, "entry", "入口文件路径不合法");
    else if (!/\.html?$/i.test(entry)) issue(errors, "entry", "入口文件必须是 .html");
  }

  const icon = String(data.icon ?? "").trim();
  if (icon) {
    if (!isSafePackagePath(icon)) issue(errors, "icon", "图标路径不合法");
    else if (!/\.(svg|png|webp|jpe?g)$/i.test(icon)) issue(errors, "icon", "图标必须是 SVG / PNG / WebP / JPEG");
  }

  const screenshotsRaw = Array.isArray(data.screenshots) ? data.screenshots : [];
  const screenshots = [];
  for (const [index, item] of screenshotsRaw.entries()) {
    const path = String(item ?? "").trim();
    if (!isSafePackagePath(path)) issue(errors, `screenshots[${index}]`, "预览图路径不合法");
    else if (!/\.(png|webp|jpe?g)$/i.test(path)) issue(errors, `screenshots[${index}]`, "预览图必须是 PNG / WebP / JPEG");
    else screenshots.push(path);
  }
  if (screenshots.length > PLUGIN_LIMITS.screenshots) {
    issue(errors, "screenshots", `最多 ${PLUGIN_LIMITS.screenshots} 张预览图`);
  }

  const compatibility = isPlainObject(data.compatibility) ? data.compatibility : {};
  const minimumOSVersion = String(compatibility.minimumOSVersion ?? "1.7.0").trim();
  if (!isSemver(minimumOSVersion)) {
    issue(errors, "compatibility.minimumOSVersion", "最低系统版本必须是 SemVer");
  }
  const sdkVersion = Number(compatibility.sdkVersion ?? 0);
  if (!Number.isInteger(sdkVersion) || sdkVersion < 1) {
    issue(errors, "compatibility.sdkVersion", "必须声明 SDK 版本（当前为 1）");
  } else if (sdkVersion > SDK_VERSION) {
    issue(errors, "compatibility.sdkVersion", `该插件需要 SDK ${sdkVersion}，当前系统只支持到 ${SDK_VERSION}`);
  }

  const permissionsRaw = Array.isArray(data.permissions) ? data.permissions : [];
  const permissions = [];
  for (const item of permissionsRaw) {
    const permission = String(item ?? "").trim();
    if (!PERMISSION_BY_ID[permission]) {
      issue(errors, "permissions", `未知权限：${permission || "(空)"}。未知权限一律拒绝。`, "UNKNOWN_PERMISSION");
      continue;
    }
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  if (new Set(permissionsRaw).size !== permissionsRaw.length) {
    warnings.push({ path: "permissions", message: "权限列表存在重复项，已自动去重" });
  }
  if (permissions.length > 16) issue(errors, "permissions", "权限数量超过 16 项");

  const domainsRaw = Array.isArray(data.networkDomains) ? data.networkDomains : [];
  const networkDomains = [];
  for (const item of domainsRaw) {
    const host = String(item ?? "").trim().toLowerCase();
    if (!isNetworkHost(host)) {
      issue(errors, "networkDomains", `域名不合法：${host || "(空)"}。只能填写主机名，不能带协议、端口或 IP。`);
      continue;
    }
    if (!networkDomains.includes(host)) networkDomains.push(host);
  }
  if (networkDomains.length > PLUGIN_LIMITS.networkDomains) {
    issue(errors, "networkDomains", `最多声明 ${PLUGIN_LIMITS.networkDomains} 个域名`);
  }
  if (permissions.includes("network.fetch") && networkDomains.length === 0) {
    issue(errors, "networkDomains", "申请 network.fetch 时必须列明允许访问的域名");
  }
  if (networkDomains.length > 0 && !permissions.includes("network.fetch")) {
    warnings.push({ path: "networkDomains", message: "声明了域名但未申请 network.fetch，网络请求不会被放行" });
  }

  const dependenciesRaw = Array.isArray(data.dependencies) ? data.dependencies : [];
  const dependencies = [];
  for (const [index, item] of dependenciesRaw.entries()) {
    if (!isPlainObject(item)) {
      issue(errors, `dependencies[${index}]`, "依赖项必须是对象");
      continue;
    }
    const depId = String(item.id ?? "").trim();
    const depRange = String(item.version ?? "").trim();
    if (!ID_RE.test(depId)) issue(errors, `dependencies[${index}].id`, "依赖插件 ID 不合法");
    else if (depId === id) issue(errors, `dependencies[${index}].id`, "插件不能依赖自身");
    else if (!satisfiesRange("0.0.0", depRange) && !/^[\^~]?\d+\.\d+\.\d+$|^>=\d+\.\d+\.\d+$/.test(depRange)) {
      issue(errors, `dependencies[${index}].version`, "依赖版本范围不合法");
    } else {
      dependencies.push({ id: depId, version: depRange, optional: Boolean(item.optional) });
    }
  }
  if (dependencies.length > PLUGIN_LIMITS.dependencies) {
    issue(errors, "dependencies", `最多 ${PLUGIN_LIMITS.dependencies} 个依赖`);
  }

  const contributesRaw = isPlainObject(data.contributes) ? data.contributes : {};
  const contributes = {};

  if (type === "widget") {
    const widget = isPlainObject(contributesRaw.widget) ? contributesRaw.widget : null;
    if (!widget) issue(errors, "contributes.widget", "组件插件必须声明 contributes.widget");
    else {
      contributes.widget = {
        title: String(widget.title ?? name).trim().slice(0, 32) || name,
        defaultSize: ["s", "m", "l"].includes(String(widget.defaultSize)) ? String(widget.defaultSize) : "m",
        height: Math.max(80, Math.min(480, Number(widget.height) || 160)),
        description: String(widget.description ?? "").trim().slice(0, 120),
      };
    }
  }

  if (type === "command") {
    const list = Array.isArray(contributesRaw.command) ? contributesRaw.command : [];
    const commands = [];
    for (const [index, item] of list.entries()) {
      if (!isPlainObject(item)) continue;
      const command = String(item.command ?? "").trim();
      const title = String(item.title ?? "").trim().slice(0, 40);
      if (!COMMAND_RE.test(command)) issue(errors, `contributes.command[${index}].command`, "命令 ID 必须是点分小写标识");
      else if (!title) issue(errors, `contributes.command[${index}].title`, "命令必须有标题");
      else commands.push({ command, title, description: String(item.description ?? "").trim().slice(0, 80) });
    }
    if (!commands.length) issue(errors, "contributes.command", "命令插件至少需要注册 1 条命令");
    if (commands.length > PLUGIN_LIMITS.commandCount) {
      issue(errors, "contributes.command", `最多注册 ${PLUGIN_LIMITS.commandCount} 条命令`);
    }
    contributes.command = commands;
  }

  if (type === "file-handler") {
    const handler = isPlainObject(contributesRaw.fileHandler) ? contributesRaw.fileHandler : null;
    if (!handler) issue(errors, "contributes.fileHandler", "文件处理插件必须声明 contributes.fileHandler");
    else {
      const extensions = (Array.isArray(handler.extensions) ? handler.extensions : [])
        .map((v) => String(v ?? "").trim().toLowerCase().replace(/^\./, ""))
        .filter((v) => /^[a-z0-9]{1,10}$/.test(v))
        .slice(0, 8);
      const mimeTypes = (Array.isArray(handler.mimeTypes) ? handler.mimeTypes : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter((v) => MIME_RE.test(v))
        .slice(0, 8);
      const actions = (Array.isArray(handler.actions) ? handler.actions : ["preview"])
        .map((v) => String(v ?? "").trim())
        .filter((v) => ["preview", "edit", "convert", "import"].includes(v));
      if (!extensions.length && !mimeTypes.length) {
        issue(errors, "contributes.fileHandler", "至少要声明一个扩展名或 MIME 类型");
      }
      contributes.fileHandler = { extensions, mimeTypes, actions: actions.length ? actions : ["preview"] };
    }
  }

  if (type === "theme") {
    const theme = isPlainObject(contributesRaw.theme) ? contributesRaw.theme : null;
    if (!theme) issue(errors, "contributes.theme", "主题扩展必须声明 contributes.theme");
    else {
      const accent = String(theme.accent ?? "").trim();
      const accent2 = String(theme.accent2 ?? "").trim();
      if (!HEX_RE.test(accent) || !HEX_RE.test(accent2)) {
        issue(errors, "contributes.theme", "主题必须提供 accent / accent2 两个 6 位十六进制颜色");
      }
      contributes.theme = {
        name: String(theme.name ?? name).trim().slice(0, 24) || name,
        en: String(theme.en ?? "").trim().slice(0, 16),
        desc: String(theme.desc ?? description).trim().slice(0, 120),
        wall: String(theme.wall ?? "aurora").trim().slice(0, 40),
        mode: theme.mode === "light" ? "light" : "dark",
        accent,
        accent2,
        material: ["glass", "frost", "solid"].includes(String(theme.material)) ? String(theme.material) : "glass",
        radius: ["soft", "round", "sharp"].includes(String(theme.radius)) ? String(theme.radius) : "round",
        font: ["sans", "serif", "mono"].includes(String(theme.font)) ? String(theme.font) : "sans",
        grain: Boolean(theme.grain),
      };
      if (theme.wall && !/^[a-z0-9-]{1,40}$/.test(String(theme.wall))) {
        warnings.push({ path: "contributes.theme.wall", message: "壁纸 ID 格式可疑，运行时可能回退到默认壁纸" });
      }
    }
  }

  if (type === "integration" && !permissions.includes("network.fetch")) {
    issue(errors, "permissions", "集成插件必须申请 network.fetch");
  }

  const license = String(data.license ?? "").trim() || "MIT";
  if (!LICENSES.includes(license)) {
    issue(errors, "license", `许可证必须是 ${LICENSES.join(" / ")} 之一`);
  }

  const category = String(data.category ?? data.categoryId ?? "other").trim();
  if (!PLUGIN_CATEGORIES.includes(category)) {
    warnings.push({ path: "category", message: "未知分类，已归入 other" });
  }

  const homepage = readHttpsUrl(data.homepage);
  const repository = readHttpsUrl(data.repository);
  if (homepage === null) issue(errors, "homepage", "主页必须使用 https");
  if (repository === null) issue(errors, "repository", "仓库地址必须使用 https");

  const changelog = String(data.changelog ?? "").trim().slice(0, 4000);

  if (permissions.includes("files.read_selected") && !permissions.includes("files.pick")) {
    warnings.push({ path: "permissions", message: "没有 files.pick 时，files.read_selected 无法获得用户选中的文件" });
  }

  if (errors.length) return { ok: false, errors, warnings, manifest: null };

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    id,
    name,
    version,
    description,
    author: { name: authorName, url: authorUrl || "" },
    type,
    entry: type === "theme" && !entry ? "" : entry,
    icon: icon || "",
    screenshots,
    category: PLUGIN_CATEGORIES.includes(category) ? category : "other",
    license,
    homepage: homepage || "",
    repository: repository || "",
    changelog,
    compatibility: { minimumOSVersion, sdkVersion },
    permissions: [...permissions].sort(),
    networkDomains: [...networkDomains].sort(),
    dependencies: dependencies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    contributes,
  };

  return { ok: true, errors, warnings, manifest };
}

/* ============================================================
   插件包校验
   ============================================================ */

/** 文件清单的稳定表示：按路径排序，只保留 path/encoding/content。 */
export function canonicalFilesJson(files) {
  const normalized = (Array.isArray(files) ? files : [])
    .map((file) => ({
      path: String(file?.path ?? ""),
      encoding: file?.encoding === "base64" ? "base64" : "utf8",
      content: String(file?.content ?? ""),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return canonicalJson(normalized);
}

/**
 * 校验插件包结构。
 * 注意：这个函数不计算 SHA-256（需要 WebCrypto，服务端与浏览器各算一次），
 * 只负责结构与内容规则；摘要由调用方用 canonicalFilesJson 计算。
 */
export function validateBundle(raw, options = {}) {
  const errors = [];
  const warnings = [];

  if (typeof raw !== "string" || !raw.trim()) {
    issue(errors, "bundle", "插件包必须是 JSON 文本");
    return { ok: false, errors, warnings, bundle: null, manifest: null, files: [] };
  }
  if (byteLength(raw) > PLUGIN_LIMITS.bundleBytes) {
    issue(errors, "bundle", `插件包超过 ${Math.round(PLUGIN_LIMITS.bundleBytes / 1024 / 1024)} MB 上限`);
    return { ok: false, errors, warnings, bundle: null, manifest: null, files: [] };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    issue(errors, "bundle", "插件包不是有效的 JSON");
    return { ok: false, errors, warnings, bundle: null, manifest: null, files: [] };
  }

  if (!isPlainObject(data)) {
    issue(errors, "bundle", "插件包根节点必须是对象");
    return { ok: false, errors, warnings, bundle: null, manifest: null, files: [] };
  }
  if (data.format !== PLUGIN_FORMAT) issue(errors, "format", `format 必须是 ${PLUGIN_FORMAT}`);
  if (data.formatVersion !== PLUGIN_FORMAT_VERSION) {
    issue(errors, "formatVersion", `仅支持 formatVersion = ${PLUGIN_FORMAT_VERSION}`);
  }

  const manifestResult = validateManifest(data.manifest, options);
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);
  const manifest = manifestResult.manifest;

  const rawFiles = Array.isArray(data.files) ? data.files : null;
  if (!rawFiles) {
    issue(errors, "files", "插件包必须包含 files 数组");
    return { ok: false, errors, warnings, bundle: null, manifest, files: [] };
  }
  if (rawFiles.length === 0) issue(errors, "files", "插件包不能为空");
  if (rawFiles.length > PLUGIN_LIMITS.files) {
    issue(errors, "files", `文件数量超过 ${PLUGIN_LIMITS.files} 个上限`);
  }

  const files = [];
  const seen = new Set();
  let total = 0;

  for (const [index, item] of rawFiles.entries()) {
    if (!isPlainObject(item)) {
      issue(errors, `files[${index}]`, "文件项必须是对象");
      continue;
    }
    const path = String(item.path ?? "");
    if (!isSafePackagePath(path)) {
      issue(errors, `files[${index}].path`, `文件路径不合法或类型不允许：${path || "(空)"}`, "UNSAFE_PATH");
      continue;
    }
    const lower = path.toLowerCase();
    if (seen.has(lower)) {
      issue(errors, `files[${index}].path`, `文件路径重复：${path}`);
      continue;
    }
    seen.add(lower);

    const encoding = item.encoding === "base64" ? "base64" : "utf8";
    const content = typeof item.content === "string" ? item.content : "";
    const size = encoding === "base64" ? Math.floor((content.length * 3) / 4) : byteLength(content);
    if (size > PLUGIN_LIMITS.fileBytes) {
      issue(errors, `files[${index}]`, `单文件超过 ${Math.round(PLUGIN_LIMITS.fileBytes / 1024)} KB：${path}`);
      continue;
    }
    if (encoding === "base64" && !/^[A-Za-z0-9+/=\s]*$/.test(content)) {
      issue(errors, `files[${index}].content`, `base64 内容包含非法字符：${path}`);
      continue;
    }
    total += size;
    files.push({ path, encoding, content });
  }

  if (total > PLUGIN_LIMITS.bundleBytes) {
    issue(errors, "files", "解包后总体积超过插件包上限");
  }

  if (manifest) {
    if (manifest.entry && !seen.has(manifest.entry.toLowerCase())) {
      issue(errors, "entry", `入口文件不存在于插件包中：${manifest.entry}`, "ENTRY_MISSING");
    }
    if (manifest.icon && !seen.has(manifest.icon.toLowerCase())) {
      issue(errors, "icon", `图标文件不存在于插件包中：${manifest.icon}`);
    }
    for (const shot of manifest.screenshots) {
      if (!seen.has(shot.toLowerCase())) issue(errors, "screenshots", `预览图不存在于插件包中：${shot}`);
    }
    for (const dep of manifest.dependencies) {
      if (dep.id === manifest.id) issue(errors, "dependencies", "插件不能依赖自身");
    }
    if (manifest.type === "widget" && !manifest.contributes.widget) {
      issue(errors, "contributes.widget", "组件插件缺少组件声明");
    }
  }

  const declaredDigest = String(data.filesDigest ?? "").trim().toLowerCase();
  if (declaredDigest && !/^[a-f0-9]{64}$/.test(declaredDigest)) {
    issue(errors, "filesDigest", "filesDigest 必须是 64 位十六进制 SHA-256");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    bundle: errors.length === 0 ? data : null,
    manifest,
    files,
    declaredFilesDigest: declaredDigest || "",
  };
}

/** 把文件列表转成 path → file 的映射，路径大小写不敏感。 */
export function fileMap(files) {
  const map = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.path) continue;
    map.set(String(file.path).toLowerCase(), file);
  }
  return map;
}

export function decodeFileText(file) {
  if (!file) return "";
  if (file.encoding === "base64") {
    try {
      const binary = atob(file.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }
  return String(file.content ?? "");
}

export function mimeForPath(path) {
  const ext = String(path ?? "").split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      html: "text/html; charset=utf-8",
      htm: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      mjs: "text/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      md: "text/markdown; charset=utf-8",
      txt: "text/plain; charset=utf-8",
      csv: "text/csv; charset=utf-8",
    }[ext] ?? "application/octet-stream"
  );
}

/** 权限分组，供安装对话框按模块展示 */
export function groupPermissions(ids) {
  const groups = new Map();
  for (const id of Array.isArray(ids) ? ids : []) {
    const permission = PERMISSION_BY_ID[id];
    if (!permission) continue;
    if (!groups.has(permission.module)) groups.set(permission.module, []);
    groups.get(permission.module).push(permission);
  }
  return [...groups.entries()].map(([module, items]) => ({
    module,
    label: PERMISSION_MODULE_LABELS[module] ?? module,
    items,
  }));
}

export function riskOf(ids) {
  let level = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const risk = PERMISSION_BY_ID[id]?.risk;
    level = Math.max(level, risk === "high" ? 3 : risk === "medium" ? 2 : 1);
  }
  return level === 3 ? "high" : level === 2 ? "medium" : "low";
}

export function hasSensitivePermission(ids) {
  return (Array.isArray(ids) ? ids : []).some((id) => PERMISSION_BY_ID[id]?.sensitive);
}

/** 比较两个权限集合：返回新增与移除 */
export function diffPermissions(previous, next) {
  const before = new Set(Array.isArray(previous) ? previous : []);
  const after = new Set(Array.isArray(next) ? next : []);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  };
}
