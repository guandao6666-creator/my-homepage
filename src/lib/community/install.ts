/**
 * Guandao OS 1.6 · 社区资源安装器
 *
 * 设计原则：不新造第二套主题 / 组件 / 工作空间 / 壁纸系统。
 *   theme     → src/lib/os14/themes.ts（normalizeTheme + saveCustomTheme + applyTheme）
 *   widget    → src/lib/os14/widgetstore.ts（注册为系统 WidgetSpec，声明式渲染）
 *   workspace → src/lib/os14/workspaces.ts（新增工作空间 + 导入前快照）
 *   wallpaper → src/lib/os13.ts（沿用自定义壁纸的压缩 / IndexedDB / 应用链路）
 *
 * 安装包在进入上述系统前会先做 SHA-256 校验与兼容性检查；校验失败直接中止。
 */

import type { Ctx } from "../os14/core";
import {
  applyTheme,
  deleteCustomTheme,
  normalizeTheme,
  readThemeState,
  saveCustomTheme,
  type ThemeDef,
} from "../os14/themes";
import { importCommunityWorkspace, removeCommunityWorkspace } from "../os14/workspaces";
import {
  installCommunityWidgetInstance,
  uninstallCommunityWidgetInstance,
  type CommunityWidgetConfig,
} from "../os14/widgetstore";
import {
  fetchVerifiedPackage,
  getPost,
  getVersions,
  type CommunityAsset,
  type CommunityPost,
  type PackageFile,
} from "./api";
import {
  compatibilityCheck,
  compareSemver,
  validateManifestClient,
  type Manifest,
  type ManifestType,
  type ThemeConfig,
  type WidgetConfig,
  type WorkspaceConfig,
} from "./manifest";

const INSTALL_KEY = "guandao.community.installs.v1";

export type InstallRecord = {
  postId: string;
  postType: CommunityPost["type"];
  title: string;
  author: string;
  version: string;
  localId: string;
  installedAt: number;
  updatedAt: number;
  previousVersion?: string;
};

export type InstallResult = {
  ok: boolean;
  localId: string;
  message: string;
  details?: string[];
};

type InstallStore = Record<string, InstallRecord>;

export const readInstalls = (): InstallStore => {
  try {
    const raw = JSON.parse(localStorage.getItem(INSTALL_KEY) || "{}") as InstallStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
};

const writeInstalls = (store: InstallStore) => {
  try {
    localStorage.setItem(INSTALL_KEY, JSON.stringify(store));
  } catch {
    /* 隐私模式写不进去时，安装本身仍已在系统里生效 */
  }
  window.dispatchEvent(new CustomEvent("guandao:community-change", { detail: { installs: true } }));
};

export const getInstall = (postId: string): InstallRecord | null => readInstalls()[postId] ?? null;

export const installedRecords = (): InstallRecord[] =>
  Object.values(readInstalls()).sort((a, b) => b.updatedAt - a.updatedAt);

const saveRecord = (record: InstallRecord) => {
  const store = readInstalls();
  store[record.postId] = record;
  writeInstalls(store);
};

const removeRecord = (postId: string) => {
  const store = readInstalls();
  delete store[postId];
  writeInstalls(store);
};

const localThemeId = (postId: string) => `custom-com-${postId.slice(0, 8)}`;

/**
 * 判断当前外观是否仍然完全等于这套主题的原始配置。
 * 如果用户应用主题后又调整过强调色 / 材质 / 壁纸，更新时就不应强行覆盖。
 */
function currentLookMatchesTheme(theme: ThemeDef): boolean {
  const api = (window as unknown as {
    GOS13?: { cfg?: () => Record<string, unknown> };
  }).GOS13;
  const cfg = api?.cfg?.() as
    | {
        appearance?: { mode?: string; material?: string; radius?: string; accent?: string; accent2?: string };
        wall?: { id?: string; darken?: number };
        dock?: { size?: number; magnify?: number; opacity?: number };
      }
    | undefined;
  if (!cfg) return true;
  const appearance = cfg.appearance || {};
  const wall = cfg.wall || {};
  const dock = cfg.dock || {};
  return (
    appearance.mode === theme.mode &&
    appearance.material === theme.material &&
    appearance.radius === theme.radius &&
    String(appearance.accent).toLowerCase() === theme.accent.toLowerCase() &&
    String(appearance.accent2).toLowerCase() === theme.accent2.toLowerCase() &&
    wall.id === theme.wall &&
    Number(wall.darken) === theme.darken &&
    Number(dock.size) === theme.dock.size &&
    Number(dock.magnify) === theme.dock.magnify &&
    Number(dock.opacity) === theme.dock.opacity
  );
}

/* ============================================================
   主题
   ============================================================ */

function installTheme(post: CommunityPost, config: ThemeConfig, ctx: Ctx, apply: boolean): InstallResult {
  const raw = {
    id: localThemeId(post.id),
    name: config.name,
    en: config.en || "Community",
    author: post.author.displayName,
    desc: config.desc || post.description.slice(0, 120),
    style: config.style || "社区主题",
    wall: config.wall,
    mode: config.mode,
    accent: config.accent,
    accent2: config.accent2,
    material: config.material,
    radius: config.radius,
    darken: config.darken,
    dock: config.dock,
    font: config.font,
    grain: config.grain,
    tags: config.tags?.length ? config.tags : ["社区"],
    builtin: false,
    createdAt: Date.now(),
  };
  const normalized = normalizeTheme(raw);
  if (!normalized) {
    return { ok: false, localId: "", message: "主题配置未通过本地校验，已中止安装" };
  }
  normalized.id = localThemeId(post.id);
  normalized.author = post.author.displayName.slice(0, 24);
  normalized.desc = (config.desc || post.description).slice(0, 120);
  saveCustomTheme(normalized);

  const wasActive = readThemeState().current === normalized.id;
  const pristine = wasActive ? currentLookMatchesTheme(normalized) : false;
  const applied = Boolean(apply) || (wasActive && pristine);
  if (applied) applyTheme(normalized);

  return {
    ok: true,
    localId: normalized.id,
    message: applied
      ? "主题已安装并应用"
      : wasActive
        ? "主题已更新；检测到你对当前外观做过本地调整，已保留现有设置"
        : apply
          ? "主题已安装并应用"
          : "主题已安装，可在主题中心随时应用",
    details: [
      `主题：${normalized.name}`,
      `壁纸：${normalized.wall}`,
      `强调色：${normalized.accent} / ${normalized.accent2}`,
      `材质：${normalized.material}，圆角：${normalized.radius}`,
      `程序坞：${normalized.dock.size}px`,
      "原始主题配置与你的本地外观调整分开保存",
    ],
  };
}

function installWidget(post: CommunityPost, config: WidgetConfig, ctx: Ctx): InstallResult {
  const id = `com-${post.id.slice(0, 8)}`;
  const widget: CommunityWidgetConfig = {
    id,
    type: config.widgetType,
    title: post.title,
    version: post.version,
    postId: post.id,
    props: config.props ?? {},
    permissions: config.permissions?.length ? config.permissions : ["none"],
    dependencies: config.dependencies ?? [],
  };
  if (!installCommunityWidgetInstance(widget, ctx)) {
    return { ok: false, localId: "", message: "组件注册失败，已中止安装" };
  }
  return {
    ok: true,
    localId: id,
    message: "组件已添加到桌面",
    details: [
      `类型：${config.widgetType}`,
      `权限：${(config.permissions || ["none"]).join(" · ")}`,
      "渲染方式：系统声明式组件，不执行任何社区脚本",
    ],
  };
}

function installWorkspace(post: CommunityPost, config: WorkspaceConfig, ctx: Ctx): InstallResult {
  const result = importCommunityWorkspace(config as unknown as Record<string, unknown>, ctx, {
    postId: post.id,
    packageName: post.title,
  });
  const details = [
    `工作空间：${result.name}`,
    `应用：${result.missingApps.length ? `${result.missingApps.length} 个未安装，已跳过` : "全部可用"}`,
    `组件：${result.missingWidgets.length ? `${result.missingWidgets.length} 个未安装，已跳过` : "全部可用"}`,
    result.themeMissing ? "主题未安装，已保留当前主题" : "主题可用",
    "导入前已为当前工作空间创建保护性快照",
  ];
  return {
    ok: true,
    localId: result.id,
    message: "工作空间已导入，可到工作空间应用切换",
    details,
  };
}

/* ============================================================
   壁纸
   ============================================================ */

type LegacyWallpaperApi = {
  importWallpaperFromBlob?: (blob: Blob, name: string) => Promise<string | null>;
  removeWallpaper?: (id: string) => Promise<void> | void;
};

function wallpaperApi(): LegacyWallpaperApi | null {
  const api = (window as unknown as { GOS13?: LegacyWallpaperApi }).GOS13;
  return api && typeof api.importWallpaperFromBlob === "function" ? api : null;
}

export async function installWallpaperAsset(
  post: CommunityPost,
  asset: CommunityAsset,
  ctx: Ctx | null,
): Promise<InstallResult> {
  const api = wallpaperApi();
  if (!api?.importWallpaperFromBlob) {
    return { ok: false, localId: "", message: "壁纸引擎尚未就绪，请刷新页面后重试" };
  }
  const response = await fetch(asset.url, { credentials: "same-origin" });
  if (!response.ok) return { ok: false, localId: "", message: "壁纸下载失败，请稍后重试" };
  const blob = await response.blob();
  if (!/^image\/(jpeg|png|webp)$/i.test(blob.type)) {
    return { ok: false, localId: "", message: "壁纸不是受支持的图片格式，已阻止应用" };
  }
  const localId = await api.importWallpaperFromBlob(blob, post.title);
  if (!localId) return { ok: false, localId: "", message: "壁纸保存失败，请换一张试试" };

  saveRecord({
    postId: post.id,
    postType: post.type,
    title: post.title,
    author: post.author.displayName,
    version: post.version,
    localId,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return {
    ok: true,
    localId,
    message: "壁纸已下载到本机并应用",
    details: [`尺寸：${asset.width} × ${asset.height}`, `大小：${(asset.sizeBytes / 1024 / 1024).toFixed(2)} MB`],
  };
}

/* ============================================================
   统一安装 / 更新 / 回退 / 卸载
   ============================================================ */

export async function installManifest(
  post: CommunityPost,
  manifest: Manifest,
  ctx: Ctx,
  options: { applyTheme?: boolean } = {},
): Promise<InstallResult> {
  const check = compatibilityCheck(manifest.compatibility);
  if (!check.ok) return { ok: false, localId: "", message: check.reason };

  const validation = validateManifestClient(manifest, post.type as ManifestType);
  if (!validation.ok) {
    return { ok: false, localId: "", message: `内容包校验失败：${validation.errors[0]}` };
  }

  const previous = getInstall(post.id);
  let result: InstallResult;

  if (post.type === "theme") {
    result = installTheme(post, manifest.configuration as ThemeConfig, ctx, Boolean(options.applyTheme));
  } else if (post.type === "widget") {
    result = installWidget(post, manifest.configuration as WidgetConfig, ctx);
  } else if (post.type === "workspace") {
    result = installWorkspace(post, manifest.configuration as WorkspaceConfig, ctx);
  } else if (post.type === "wallpaper") {
    const detail = await getPost(post.id);
    const asset = detail.wallpapers[0];
    if (!asset) return { ok: false, localId: "", message: "壁纸作品缺少图片资源" };
    result = await installWallpaperAsset(post, asset, ctx);
  } else {
    return { ok: false, localId: "", message: "教程作品不需要安装，可直接阅读" };
  }

  if (result.ok) {
    saveRecord({
      postId: post.id,
      postType: post.type,
      title: post.title,
      author: post.author.displayName,
      version: post.version,
      localId: result.localId,
      installedAt: previous?.installedAt ?? Date.now(),
      updatedAt: Date.now(),
      previousVersion: previous && previous.version !== post.version ? previous.version : previous?.previousVersion,
    });
  }
  return result;
}

export async function installFromServer(
  post: CommunityPost,
  ctx: Ctx,
  options: { applyTheme?: boolean; version?: string } = {},
): Promise<InstallResult> {
  let packageFile: PackageFile;
  let manifest: Manifest;
  try {
    // 2.0：只有走到真正安装这一步才计入下载量（详情页预览不再灌水）
    const verified = await fetchVerifiedPackage(post.id, options.version, true);
    packageFile = verified.file;
    manifest = verified.manifest as unknown as Manifest;
  } catch (error) {
    return {
      ok: false,
      localId: "",
      message: error instanceof Error ? error.message : "内容包下载或校验失败",
    };
  }

  const check = compatibilityCheck(packageFile.compatibility);
  if (!check.ok) return { ok: false, localId: "", message: check.reason };

  return installManifest(
    { ...post, version: packageFile.version },
    manifest,
    ctx,
    options,
  );
}

export async function uninstallByPost(postId: string, ctx: Ctx): Promise<boolean> {
  const record = getInstall(postId);
  if (!record) return false;
  if (record.postType === "theme") deleteCustomTheme(record.localId);
  else if (record.postType === "widget") uninstallCommunityWidgetInstance(record.localId, ctx);
  else if (record.postType === "workspace") removeCommunityWorkspace(record.localId);
  else if (record.postType === "wallpaper") {
    const api = wallpaperApi();
    if (api?.removeWallpaper) await api.removeWallpaper(record.localId);
  }
  removeRecord(postId);
  return true;
}

export type UpdateCheck = {
  current: string;
  latest: string | null;
  changelog: string;
  hasUpdate: boolean;
};

export async function checkUpdate(postId: string): Promise<UpdateCheck> {
  const record = getInstall(postId);
  const { versions } = await getVersions(postId);
  const sorted = [...versions].sort((a, b) => compareSemver(b.version, a.version));
  const latest = sorted[0]?.version ?? null;
  const current = record?.version ?? "0.0.0";
  return {
    current,
    latest,
    changelog: sorted[0]?.changelog ?? "",
    hasUpdate: Boolean(latest && compareSemver(latest, current) > 0),
  };
}

export { compareSemver };
