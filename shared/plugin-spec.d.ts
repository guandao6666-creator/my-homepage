/**
 * shared/plugin-spec.js 的类型声明。
 * 运行时实现只有一份（JS），这里只补类型，避免 TS 端出现 any 泄漏。
 */

export const OS_VERSION: string;
export const SDK_VERSION: number;
export const MANIFEST_VERSION: number;
export const PLUGIN_FORMAT: string;
export const PLUGIN_FORMAT_VERSION: number;

export const PLUGIN_LIMITS: {
  bundleBytes: number;
  files: number;
  fileBytes: number;
  manifestBytes: number;
  installedPlugins: number;
  storageBytes: number;
  storageKeys: number;
  rpcPayloadBytes: number;
  rpcPerWindow: number;
  rpcWindowMs: number;
  rpcTimeoutMs: number;
  notificationsPerMinute: number;
  commandCount: number;
  networkDomains: number;
  screenshots: number;
  dependencies: number;
  nameLength: number;
  descriptionLength: number;
};

export type PluginType = "application" | "widget" | "command" | "file-handler" | "theme" | "integration";

export const PLUGIN_TYPES: PluginType[];
export const PLUGIN_TYPE_META: Record<PluginType, { label: string; icon: string; desc: string; executable: boolean }>;
export const PLUGIN_CATEGORIES: string[];
export const CATEGORY_LABELS: Record<string, string>;

export type PermissionRisk = "low" | "medium" | "high";

export type PermissionDef = {
  id: string;
  module: string;
  label: string;
  desc: string;
  risk: PermissionRisk;
  sensitive: boolean;
  network: boolean;
};

export const PERMISSIONS: PermissionDef[];
export const PERMISSION_IDS: string[];
export const PERMISSION_BY_ID: Record<string, PermissionDef>;
export const PERMISSION_MODULE_LABELS: Record<string, string>;
export const LICENSES: string[];

export type Manifest = {
  manifestVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: { name: string; url: string };
  type: PluginType;
  entry: string;
  icon: string;
  screenshots: string[];
  category: string;
  license: string;
  homepage: string;
  repository: string;
  changelog: string;
  compatibility: { minimumOSVersion: string; sdkVersion: number };
  permissions: string[];
  networkDomains: string[];
  dependencies: Array<{ id: string; version: string; optional: boolean }>;
  contributes: {
    widget?: { title: string; defaultSize: "s" | "m" | "l"; height: number; description: string };
    command?: Array<{ command: string; title: string; description: string }>;
    fileHandler?: { extensions: string[]; mimeTypes: string[]; actions: string[] };
    theme?: {
      name: string;
      en: string;
      desc: string;
      wall: string;
      mode: "dark" | "light";
      accent: string;
      accent2: string;
      material: "glass" | "frost" | "solid";
      radius: "soft" | "round" | "sharp";
      font: "sans" | "serif" | "mono";
      grain: boolean;
    };
  };
};

export type BundleFile = { path: string; encoding: "utf8" | "base64"; content: string };

export type Bundle = {
  format: string;
  formatVersion: number;
  manifest: Manifest;
  files: BundleFile[];
  filesDigest?: string;
};

export type SpecIssue = { path: string; message: string; code: string };
export type SpecWarning = { path: string; message: string };

export function isPlainObject(value: unknown): value is Record<string, unknown>;
export function byteLength(text: unknown): number;
export function canonicalJson(value: unknown): string;
export function compareSemver(a: string, b: string): number;
export function isSemver(version: string): boolean;
export function isPluginId(id: string): boolean;
export function satisfiesRange(version: string, range: string): boolean;
export function isSafePackagePath(path: string): boolean;
export function isNetworkHost(value: string): boolean;
export function matchesNetworkHost(host: string, allowlist: string[]): boolean;

export function validateManifest(
  raw: unknown,
  options?: { expectedId?: string; expectedType?: string },
): { ok: boolean; errors: SpecIssue[]; warnings: SpecWarning[]; manifest: Manifest | null };

export function canonicalFilesJson(files: BundleFile[]): string;

export function validateBundle(
  raw: string,
  options?: { expectedId?: string; expectedType?: string },
): {
  ok: boolean;
  errors: SpecIssue[];
  warnings: SpecWarning[];
  bundle: Bundle | null;
  manifest: Manifest | null;
  files: BundleFile[];
  declaredFilesDigest?: string;
};

export function fileMap(files: BundleFile[]): Map<string, BundleFile>;
export function decodeFileText(file: BundleFile | undefined): string;
export function mimeForPath(path: string): string;
export function groupPermissions(ids: string[]): Array<{ module: string; label: string; items: PermissionDef[] }>;
export function riskOf(ids: string[]): PermissionRisk;
export function hasSensitivePermission(ids: string[]): boolean;
export function diffPermissions(previous: string[], next: string[]): { added: string[]; removed: string[] };
