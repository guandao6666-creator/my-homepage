/**
 * Guandao OS 2.0 · 应用 Manifest 与校验
 *
 * 2.0 要求「应用注册前校验 Manifest」（§4.1）。这里定义唯一的 Schema，
 * 系统应用、市场应用、社区应用、插件应用全部使用同一份：
 *
 *   appId / name / version / description / icon / category / entry /
 *   minimumOSVersion / permissions / dependencies / author
 *
 * 校验是纯函数，不读 DOM、不联网，因此可以在 Node 里单测，
 * 也可以在构建期对内置应用做静态校验。
 */

import type { AppSource, TrustLevel } from "./types";

export const APP_CATEGORIES = [
  "productivity",
  "study",
  "fun",
  "system",
  "creative",
  "network",
  "lab",
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];

/** 2.0 统一权限标识（应用侧的子集；插件有自己更细的权限表） */
export const APP_PERMISSIONS = [
  "storage.read",
  "storage.write",
  "files.read",
  "files.write",
  "clipboard.read",
  "clipboard.write",
  "notifications.post",
  "network.request",
  "window.control",
  "desktop.modify",
  "theme.apply",
  "cloud.sync",
  "account.read",
  "plugin.manage",
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];

export type AppDependency = {
  appId: string;
  /** 可选依赖：缺失时应用仍可启动，只是相关功能不可用 */
  optional?: boolean;
  /** 最低版本要求（semver 字符串） */
  minimumVersion?: string;
};

export type AppManifest = {
  appId: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  category: AppCategory;
  /** 模块入口标识（例如 `os14/notes`），不允许 http(s): 或路径穿越 */
  entry: string;
  minimumOSVersion: string;
  permissions: AppPermission[];
  dependencies: AppDependency[];
  author: string;
  /** SDK 契约版本，2.0 起固定为 1 */
  apiVersion?: number;
  /** 来源与信任状态由系统在注册时写入，Manifest 不影响安全判断 */
  source?: AppSource;
  trust?: TrustLevel;
  /** 内容校验值（市场 / 社区资源） */
  checksum?: string;
  homepage?: string;
  license?: string;
  /** 资源大小（字节，仅用于展示） */
  sizeBytes?: number;
};

export type ManifestIssue = {
  /** JSON 路径，例如 permissions[2] */
  path: string;
  code: string;
  message: string;
};

export type ManifestValidation = {
  ok: boolean;
  manifest: AppManifest | null;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
};

export const SDK_API_VERSION = 1;

/** 系统应用可以使用的保留 id；第三方应用不允许占用 */
export const RESERVED_APP_IDS = new Set([
  "appcenter",
  "systemcenter",
  "onboarding",
  "updatecenter",
  "market",
  "diagnostics",
  "perflab",
  "settings",
  "control",
  "terminal",
  "about",
]);

/**
 * appId 规则：小写字母开头，允许数字、中划线与点分隔。
 * 点用于插件应用的命名空间（例如 `official.music`、`plugin.official.music`），
 * 中划线用于普通应用（例如 `notes-app`）。
 */
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 比较两个 semver。只比较前三段数字，预发布版本视为小于正式版。
 * 返回 -1 / 0 / 1。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [main] = String(value ?? "").trim().split("+");
    const [core, pre] = main.split("-");
    const nums = core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? "" };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] > right.nums[i]) return 1;
    if (left.nums[i] < right.nums[i]) return -1;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre === right.pre) return 0;
  return left.pre > right.pre ? 1 : -1;
}

/** 当前系统版本是否满足最小版本要求 */
export const satisfiesMinimum = (currentVersion: string, minimumVersion: string): boolean =>
  compareVersions(currentVersion, minimumVersion) >= 0;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Manifest 校验。
 *
 * - `osVersion`：当前系统版本；缺失时跳过兼容性检查（构建期静态校验可以传）
 * - `allowReservedIds`：系统应用注册时传 true
 * - `strictEntry`：第三方资源必须提供 entry；系统内置应用允许省略
 */
export function validateAppManifest(
  raw: unknown,
  options: { osVersion?: string; allowReservedIds?: boolean } = {},
): ManifestValidation {
  const errors: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];
  const source = asRecord(raw);

  const fail = (path: string, code: string, message: string) => errors.push({ path, code, message });
  const warn = (path: string, code: string, message: string) => warnings.push({ path, code, message });

  const appId = asString(source.appId ?? source.id);
  if (!appId) {
    fail("appId", "MISSING", "缺少 appId");
  } else if (!ID_PATTERN.test(appId) || appId.length > 64) {
    fail("appId", "FORMAT", "appId 只能是小写字母、数字、中划线或点，且以字母开头（≤64 字符）");
  } else if (RESERVED_APP_IDS.has(appId) && !options.allowReservedIds) {
    fail("appId", "RESERVED", `appId「${appId}」是系统保留标识`);
  }

  const name = asString(source.name);
  if (!name) fail("name", "MISSING", "缺少 name");
  else if (name.length > 48) fail("name", "TOO_LONG", "name 不能超过 48 个字符");

  const version = asString(source.version);
  if (!version) fail("version", "MISSING", "缺少 version");
  else if (!SEMVER_PATTERN.test(version)) fail("version", "FORMAT", "version 必须是 x.y.z 形式");

  const description = asString(source.description);
  if (!description) warn("description", "MISSING", "缺少 description，市场里会显示为空");
  else if (description.length > 600) fail("description", "TOO_LONG", "description 不能超过 600 个字符");

  const icon = asString(source.icon);
  if (!icon) warn("icon", "MISSING", "缺少 icon，将使用默认图标");
  else if (icon.length > 240) fail("icon", "TOO_LONG", "icon 不能超过 240 个字符");

  const category = asString(source.category) as AppCategory;
  if (!category) fail("category", "MISSING", "缺少 category");
  else if (!(APP_CATEGORIES as readonly string[]).includes(category)) {
    fail("category", "UNKNOWN", `category 必须是 ${APP_CATEGORIES.join(" / ")} 之一`);
  }

  const entry = asString(source.entry);
  if (!entry) fail("entry", "MISSING", "缺少 entry");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(entry) || entry.startsWith("//")) {
    fail("entry", "EXTERNAL", "entry 不允许是外部 URL，必须是系统内的模块标识");
  } else if (entry.includes("..") || entry.startsWith("/") || entry.includes("\\")) {
    fail("entry", "TRAVERSAL", "entry 不允许绝对路径或向上穿越");
  } else if (entry.length > 160) {
    fail("entry", "TOO_LONG", "entry 过长");
  }

  const minimumOSVersion = asString(source.minimumOSVersion) || "1.0.0";
  if (!SEMVER_PATTERN.test(minimumOSVersion)) {
    fail("minimumOSVersion", "FORMAT", "minimumOSVersion 必须是 x.y.z 形式");
  } else if (options.osVersion && !satisfiesMinimum(options.osVersion, minimumOSVersion)) {
    fail(
      "minimumOSVersion",
      "INCOMPATIBLE",
      `该应用要求 Guandao OS ${minimumOSVersion} 或更高，当前是 ${options.osVersion}`,
    );
  }

  const rawPermissions = Array.isArray(source.permissions) ? source.permissions : [];
  const permissions: AppPermission[] = [];
  rawPermissions.forEach((item, index) => {
    const id = asString(item) as AppPermission;
    if (!(APP_PERMISSIONS as readonly string[]).includes(id)) {
      fail(`permissions[${index}]`, "UNKNOWN", `未定义的权限：${String(item)}`);
      return;
    }
    if (!permissions.includes(id)) permissions.push(id);
  });
  if (rawPermissions.length !== permissions.length && errors.length === 0) {
    warn("permissions", "DUPLICATE", "权限列表里有重复项，已去重");
  }

  const rawDeps = Array.isArray(source.dependencies) ? source.dependencies : [];
  const dependencies: AppDependency[] = [];
  rawDeps.forEach((item, index) => {
    const dep = asRecord(item);
    const depId = asString(dep.appId ?? dep.id);
    if (!depId || !ID_PATTERN.test(depId)) {
      fail(`dependencies[${index}]`, "FORMAT", "依赖项必须有合法的 appId");
      return;
    }
    if (depId === appId) {
      fail(`dependencies[${index}]`, "SELF", "应用不能依赖自己");
      return;
    }
    const minimumVersion = asString(dep.minimumVersion);
    if (minimumVersion && !SEMVER_PATTERN.test(minimumVersion)) {
      fail(`dependencies[${index}].minimumVersion`, "FORMAT", "依赖版本必须是 x.y.z 形式");
      return;
    }
    if (dependencies.some((existing) => existing.appId === depId)) {
      warn(`dependencies[${index}]`, "DUPLICATE", `重复依赖 ${depId}`);
      return;
    }
    dependencies.push({ appId: depId, optional: Boolean(dep.optional), ...(minimumVersion ? { minimumVersion } : {}) });
  });

  const author = asString(source.author);
  if (!author) warn("author", "MISSING", "缺少 author");

  const apiVersionRaw = source.apiVersion;
  const apiVersion = typeof apiVersionRaw === "number" ? apiVersionRaw : Number(apiVersionRaw ?? SDK_API_VERSION);
  if (!Number.isFinite(apiVersion) || apiVersion < 1) {
    fail("apiVersion", "FORMAT", "apiVersion 必须是不小于 1 的整数");
  } else if (apiVersion > SDK_API_VERSION) {
    fail("apiVersion", "TOO_NEW", `apiVersion ${apiVersion} 高于系统支持的 ${SDK_API_VERSION}`);
  }

  if (errors.length) return { ok: false, manifest: null, errors, warnings };

  const manifest: AppManifest = {
    appId,
    name,
    version,
    description,
    icon,
    category,
    entry,
    minimumOSVersion,
    permissions,
    dependencies,
    author,
    apiVersion: Math.floor(apiVersion),
  };

  const optionalStrings: Array<[keyof AppManifest, string, number]> = [
    ["checksum", "checksum", 128],
    ["homepage", "homepage", 300],
    ["license", "license", 60],
  ];
  for (const [field, key, max] of optionalStrings) {
    const value = asString(source[key]);
    if (!value) continue;
    if (value.length > max) {
      warn(key, "TOO_LONG", `${key} 过长，已忽略`);
      continue;
    }
    if (key === "homepage" && !/^https:\/\//i.test(value)) {
      warn(key, "INSECURE", "homepage 必须是 https:// 链接，已忽略");
      continue;
    }
    (manifest as unknown as Record<string, unknown>)[field as string] = value;
  }

  if (typeof source.sizeBytes === "number" && Number.isFinite(source.sizeBytes) && source.sizeBytes >= 0) {
    manifest.sizeBytes = Math.floor(source.sizeBytes);
  }

  return { ok: true, manifest, errors, warnings };
}

/** 把校验结果压成一行可展示的错误文案 */
export const manifestErrorText = (validation: ManifestValidation): string =>
  validation.errors.map((issue) => `${issue.path}：${issue.message}`).join("；");