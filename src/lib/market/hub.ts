/**
 * Guandao OS 2.0 · 统一市场（聚合层）
 *
 * 目标（§7）：用户不再需要在「应用中心 / 主题中心 / 组件中心 / 插件市场 / 社区」
 * 之间来回找东西。2.0 提供一个统一入口，但**不重写**任何一个已验证的安装处理器：
 *
 *   应用      → sys.install（1.4 的安装/卸载）
 *   主题      → applyTheme / saveCustomTheme（1.4 主题引擎）
 *   组件      → ctx.widgets.setEnabled（1.0–1.4 的组件系统）
 *   壁纸      → api13.setWallpaper（1.3 壁纸引擎）
 *   工作空间  → applyWorkspace（1.4 工作空间）
 *   插件      → plugins/registry.installFromMarket（1.7 插件注册中心）
 *   社区资源  → community/install.installFromServer（1.6 社区安装器）
 *
 * 这里只负责「列出来、搜索、分类、把安装请求交给 UnifiedInstaller」。
 */

import type { Kernel } from "../core/kernel";
import type { Ctx } from "../os14/core";
import type { Sys } from "../os14/system";
import { CATALOG, META_BY_ID, isInstalled as catalogInstalled, installedVersion } from "../os14/catalog";
import { allThemes, applyTheme, themeById } from "../os14/themes";
import { workspaceList, applyWorkspace } from "../os14/workspaces";
import { WALLPAPERS, wallpaperById } from "../wallpapers";
import { OS_VERSION } from "../version";
import { createInstaller, type InstallConsent, type MarketItem, type ResourceKind, type UnifiedInstaller } from "./install";
import { MANIFEST_BY_ID } from "../os20/manifests";
import { CATEGORIES } from "../os14/catalog";

export type HubCategory = "all" | ResourceKind;

export type Hub = {
  installer: UnifiedInstaller;
  items: (kind?: HubCategory) => MarketItem[];
  search: (query: string, kind?: HubCategory) => MarketItem[];
  refreshRemote: () => Promise<{ plugins: number; community: number; errors: string[] }>;
  counts: () => Record<HubCategory, number>;
  uninstall: (item: MarketItem) => Promise<{ ok: boolean; message: string }>;
};

const manifestPermissions = (appId: string): string[] => MANIFEST_BY_ID[appId]?.permissions ?? [];

export function createHub(ctx: Ctx, sys: Sys, kernel: Kernel): Hub {
  const remote: MarketItem[] = [];
  let remoteLoaded = false;
  const installer = createInstaller({ kernel, ctx, sys });

  /* ---------------- 处理器 ---------------- */

  installer.register({
    kind: "app",
    install: async (item) => {
      const appId = String(item.manifest?.appId ?? item.id);
      const manifest = (MANIFEST_BY_ID[appId] ?? item.manifest) as import("../core/manifest").AppManifest | undefined;
      if (!manifest) return { ok: false, message: "Manifest 缺失" };

      const record = kernel.registry.get(appId);
      if (!record) {
        const registered = kernel.registry.register(manifest, { source: "system", trust: "trusted", locked: false });
        if (!registered.ok) return { ok: false, message: registered.errors.join("；") };
      }
      const state = kernel.registry.stateOf(appId);
      if (state === "registered") {
        const installed = kernel.runtime?.install(appId);
        if (installed && !installed.ok) return { ok: false, message: installed.message ?? "安装失败" };
      } else {
        sys.install(appId);
        kernel.registry.enable(appId);
      }
      // 权限：系统应用直接授予声明过的能力（高风险项在安装前已经过用户确认）
      kernel.runtime?.grant(appId, [...manifest.permissions], "system");
      return { ok: true, message: `已安装「${manifest.name}」`, installedId: appId };
    },
    uninstall: async () => ({ ok: false, message: "系统应用不能从这里卸载，请到应用中心" }),
    isInstalled: (item) => catalogInstalled(item.id),
  });

  installer.register({
    kind: "theme",
    install: async (item) => {
      const theme = allThemes().find((entry) => entry.id === item.id) ?? themeById(item.id);
      if (!theme) return { ok: false, message: "主题不存在" };
      applyTheme(theme);
      return { ok: true, message: `已应用主题「${theme.name}」`, installedId: theme.id };
    },
    uninstall: async () => ({ ok: false, message: "主题不支持卸载；切换到别的主题即可" }),
    isInstalled: (item) => {
      const state = document.documentElement.dataset.osTheme;
      void state;
      return false;
    },
  });

  installer.register({
    kind: "wallpaper",
    install: async (item) => {
      ctx.api13.setWallpaper(item.id);
      return { ok: true, message: `已应用壁纸「${item.name}」`, installedId: item.id };
    },
    uninstall: async () => ({ ok: false, message: "壁纸不支持卸载" }),
    isInstalled: (item) => {
      const cfg = ctx.api13.cfg() as { wall?: { id?: string } };
      return cfg.wall?.id === item.id;
    },
  });

  installer.register({
    kind: "widget",
    install: async (item) => {
      if (!ctx.widgets.ids.includes(item.id)) return { ok: false, message: "组件不存在" };
      ctx.widgets.setEnabled(item.id, true);
      return { ok: true, message: `已添加组件「${item.name}」`, installedId: item.id };
    },
    uninstall: async (item) => {
      ctx.widgets.setEnabled(item.id, false);
      return { ok: true, message: "已从桌面移除该组件" };
    },
    isInstalled: (item) => ctx.widgets.on(item.id),
  });

  installer.register({
    kind: "workspace",
    install: async (item) => {
      const workspace = workspaceList().find((entry) => entry.id === item.id);
      if (!workspace) return { ok: false, message: "工作空间不存在" };
      await applyWorkspace(item.id, ctx, { silent: false });
      return { ok: true, message: `已切换到「${workspace.name}」`, installedId: item.id };
    },
    uninstall: async () => ({ ok: false, message: "工作空间请在场景管理里删除" }),
    isInstalled: () => false,
  });

  installer.register({
    kind: "plugin",
    download: async (item) => {
      const api = await import("../plugins/api");
      const detail = (item.extra?.detail ?? (await api.getPlugin(item.id))) as Awaited<ReturnType<typeof api.getPlugin>>;
      return { detail, pkg: await api.getPackage(item.id, item.version) };
    },
    verify: async (item, payload) => {
      const data = payload as { pkg?: { packageJson?: string; checksum?: string } } | null;
      if (!data?.pkg?.packageJson) return { ok: false, message: "插件包为空" };
      const { verifyBundle } = await import("../plugins/bundle");
      const verified = await verifyBundle(data.pkg.packageJson, {
        id: item.id,
        type: (item.extra?.type as string) ?? "application",
        checksum: data.pkg.checksum,
      });
      return verified.ok
        ? { ok: true, message: `包摘要一致 · ${verified.filesDigest.slice(0, 12)}…` }
        : { ok: false, message: verified.errors[0] ?? "插件包校验失败" };
    },
    install: async (item, payload, consent) => {
      const data = payload as { detail: Awaited<ReturnType<typeof import("../plugins/api").getPlugin>> } | null;
      if (!data?.detail) return { ok: false, message: "插件信息缺失" };
      const registry = await import("../plugins/registry");
      const record = await registry.installFromMarket(data.detail, consent.permissions);
      return { ok: true, message: `已安装「${record.name}」v${record.version}`, installedId: record.id, record };
    },
    uninstall: async (item) => {
      const registry = await import("../plugins/registry");
      await registry.uninstallPlugin(item.id, true);
      return { ok: true, message: "已卸载插件，本地数据保留" };
    },
    isInstalled: (item) => {
      try {
        const records = JSON.parse(localStorage.getItem("guandao.plugins.v1") ?? "{}") as {
          installs?: Record<string, unknown>;
        };
        return Boolean(records.installs?.[item.id]);
      } catch {
        return false;
      }
    },
  });

  installer.register({
    kind: "community",
    download: async (item) => {
      const post = item.extra?.post;
      if (!post) throw new Error("缺少社区作品信息");
      return post;
    },
    install: async (item, payload) => {
      const { installFromServer } = await import("../community/install");
      const post = payload as Awaited<Parameters<typeof installFromServer>[0]>;
      const result = await installFromServer(post, ctx, {
        applyTheme: true,
        ...(item.version ? { version: item.version } : {}),
      });
      return result.ok
        ? { ok: true, message: result.message ?? "已安装社区资源", installedId: result.localId }
        : { ok: false, message: result.message ?? "安装失败" };
    },
    uninstall: async (item) => {
      const install = await import("../community/install");
      const ok = await install.uninstallByPost(item.id, ctx);
      return { ok, message: ok ? "已卸载社区资源" : "没有找到安装记录" };
    },
    isInstalled: (item) => {
      try {
        const store = JSON.parse(localStorage.getItem("guandao.community.installs.v1") ?? "{}") as Record<string, unknown>;
        return Boolean(store[item.id]);
      } catch {
        return false;
      }
    },
  });

  /* ---------------- 条目聚合 ---------------- */

  const appItems = (): MarketItem[] =>
    CATALOG.filter((meta) => Boolean(MANIFEST_BY_ID[meta.id])).map((meta) => {
      const manifest = MANIFEST_BY_ID[meta.id];
      return {
        id: meta.id,
        kind: "app" as const,
        name: meta.name,
        version: installedVersion(meta.id) || manifest.version,
        author: manifest.author,
        description: meta.desc,
        icon: meta.glyph,
        tags: [CATEGORIES.find((category) => category.id === meta.category)?.name ?? meta.category, ...(meta.builtin ? ["系统"] : [])],
        source: "system" as const,
        permissions: manifest.permissions,
        manifest,
        installed: catalogInstalled(meta.id),
        installable: true,
        updatedAt: Date.parse(meta.release) || undefined,
      };
    });

  const themeItems = (): MarketItem[] =>
    allThemes().map((theme) => ({
      id: theme.id,
      kind: "theme" as const,
      name: theme.name,
      version: OS_VERSION,
      author: theme.author,
      description: theme.desc,
      icon: "di-themes",
      preview: wallpaperById(theme.wall)?.thumb || wallpaperById(theme.wall)?.src || undefined,
      tags: [theme.style, ...(theme.tags ?? [])],
      source: "system" as const,
      permissions: [],
      installed: false,
      installable: true,
    }));

  const widgetItems = (): MarketItem[] =>
    ctx.widgets.ids.map((id) => ({
      id,
      kind: "widget" as const,
      name: ctx.widgets.titles[id] ?? id,
      version: OS_VERSION,
      author: "Guandao Studio",
      description: ctx.widgets.desc[id] ?? "",
      icon: "di-widgets",
      tags: ["组件"],
      source: "system" as const,
      permissions: [],
      installed: ctx.widgets.on(id),
      installable: true,
    }));

  const wallpaperItems = (): MarketItem[] =>
    WALLPAPERS.map((wall) => ({
      id: wall.id,
      kind: "wallpaper" as const,
      name: wall.name,
      version: OS_VERSION,
      author: "Guandao Studio",
      description: wall.desc || wall.name,
      icon: "di-gallery",
      preview: wall.thumb || wall.src,
      tags: [wall.cat ?? "壁纸"],
      source: "system" as const,
      permissions: [],
      installed: false,
      installable: true,
    }));

  const workspaceItems = (): MarketItem[] =>
    workspaceList().map((workspace) => ({
      id: workspace.id,
      kind: "workspace" as const,
      name: workspace.name,
      version: OS_VERSION,
      author: "Guandao Studio",
      description: `${workspace.openApps.length} 个应用 · ${Object.keys(workspace.widgets).length} 个组件`,
      icon: "di-space",
      tags: ["工作空间", workspace.preset ? "预设" : "自定义"],
      source: "system" as const,
      permissions: [],
      installed: false,
      installable: true,
    }));

  const allLocal = () => [...appItems(), ...themeItems(), ...widgetItems(), ...wallpaperItems(), ...workspaceItems()];

  const items = (kind: HubCategory = "all"): MarketItem[] => {
    const list = kind === "all" ? [...allLocal(), ...remote] : [...allLocal().filter((item) => item.kind === kind), ...remote.filter((item) => item.kind === kind)];
    return list.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, "zh"));
  };

  const search = (query: string, kind: HubCategory = "all"): MarketItem[] => {
    const q = query.trim().toLowerCase();
    if (!q) return items(kind);
    return items(kind).filter((item) =>
      `${item.name} ${item.description} ${item.author} ${item.tags.join(" ")}`.toLowerCase().includes(q),
    );
  };

  const refreshRemote = async (): Promise<{ plugins: number; community: number; errors: string[] }> => {
    const errors: string[] = [];
    let pluginCount = 0;
    let communityCount = 0;
    if (remoteLoaded) return { plugins: remote.filter((item) => item.kind === "plugin").length, community: remote.filter((item) => item.kind === "community").length, errors };
    remoteLoaded = true;

    try {
      const api = await import("../plugins/api");
      const result = await api.listPlugins({ sort: "featured", page: 1, limit: 24 });
      for (const plugin of result.items ?? []) {
        remote.push({
          id: plugin.id,
          kind: "plugin",
          name: plugin.name,
          version: plugin.version,
          author: plugin.author?.name ?? "未知作者",
          description: plugin.description ?? "",
          icon: plugin.iconUrl || "di-widgets",
          tags: ["插件", plugin.category ?? ""],
          source: "market",
          permissions: plugin.permissions ?? [],
          installed: Boolean(plugin.installed),
          installable: Boolean(plugin.security?.audited),
          updatedAt: plugin.updatedAt || undefined,
          extra: { type: plugin.type, detail: plugin },
        });
        pluginCount += 1;
      }
    } catch (error) {
      errors.push(`插件市场：${(error as Error)?.message ?? "无法读取"}`);
    }

    try {
      const community = await import("../community/api");
      const feed = await community.getFeed({ tab: "popular", limit: 18 });
      for (const post of feed.items ?? []) {
        remote.push({
          id: post.id,
          kind: "community",
          name: post.title,
          version: post.version ?? "1.0.0",
          author: post.author?.displayName ?? "社区创作者",
          description: post.description ?? "",
          icon: "di-community",
          preview: post.coverThumbUrl ?? post.coverUrl ?? undefined,
          tags: ["社区", post.type, ...(post.tags ?? [])],
          source: "community",
          permissions: [],
          installed: false,
          installable: post.status === "published",
          updatedAt: post.updatedAt || undefined,
          extra: { post, type: post.type },
        });
        communityCount += 1;
      }
    } catch (error) {
      errors.push(`社区：${(error as Error)?.message ?? "无法读取"}`);
    }

    return { plugins: pluginCount, community: communityCount, errors };
  };

  const counts = (): Record<HubCategory, number> => {
    const list = items("all");
    const out = { all: list.length } as Record<HubCategory, number>;
    for (const kind of ["app", "plugin", "theme", "widget", "wallpaper", "workspace", "community"] as ResourceKind[]) {
      out[kind] = list.filter((item) => item.kind === kind).length;
    }
    return out;
  };

  return {
    installer,
    items,
    search,
    refreshRemote,
    counts,
    uninstall: (item) => installer.uninstall(item),
  };
}

export type { MarketItem, ResourceKind, InstallConsent };