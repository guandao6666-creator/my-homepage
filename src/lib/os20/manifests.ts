/**
 * Guandao OS 2.0 · 内建应用 Manifest
 *
 * 2.0 起所有应用都有正式描述文件（§4.1）。这里是系统内置应用的清单：
 * 它们的 appId 与 1.x 的应用 id 保持一致，避免迁移时出现第二套命名。
 *
 * 约定：
 *   - 系统应用版本跟随系统主版本（2.0.0）；
 *   - `minimumOSVersion` 填 2.0.0：这些描述文件本身就是 2.0 才有的；
 *   - 权限只声明真实用到的能力，不多写一个；
 *   - `entry` 是模块标识而不是 URL，防止把外部代码当成应用加载。
 */

import type { AppManifest, AppPermission } from "../core/manifest";
import { OS_VERSION } from "../version";

export const SYSTEM_AUTHOR = "Guandao Studio";

type ManifestInput = {
  appId: string;
  name: string;
  description: string;
  icon: string;
  category: AppManifest["category"];
  entry: string;
  permissions?: AppPermission[];
  dependencies?: AppManifest["dependencies"];
  optional?: boolean;
};

const app = (input: ManifestInput): AppManifest => ({
  appId: input.appId,
  name: input.name,
  version: OS_VERSION,
  description: input.description,
  icon: input.icon,
  category: input.category,
  entry: input.entry,
  minimumOSVersion: "2.0.0",
  permissions: input.permissions ?? [],
  dependencies: input.dependencies ?? [],
  author: SYSTEM_AUTHOR,
  apiVersion: 1,
  source: "system",
  trust: "trusted",
});

/* ============================================================
   2.0 新应用
   ============================================================ */

export const SYSTEM_CENTER_MANIFEST = app({
  appId: "systemcenter",
  name: "系统设置",
  description: "统一设置中心：外观、个性化、应用、插件、云端、设备、隐私与系统。",
  icon: "di-gear",
  category: "system",
  entry: "os20/apps/systemcenter",
  permissions: ["storage.read", "storage.write", "desktop.modify", "theme.apply", "cloud.sync", "plugin.manage"],
});

export const UPDATE_CENTER_MANIFEST = app({
  appId: "updatecenter",
  name: "更新中心",
  description: "版本、更新历史与兼容性检查。静态部署下的更新是网站资源更新 + 客户端数据迁移，不伪装成内核热更新。",
  icon: "di-fresh",
  category: "system",
  entry: "os20/apps/updatecenter",
  permissions: ["storage.read"],
});

export const MARKET_MANIFEST = app({
  appId: "market",
  name: "应用与资源市场",
  description: "应用、插件、组件、主题、壁纸与工作空间的统一入口，全部走同一套安装校验流程。",
  icon: "di-store",
  category: "system",
  entry: "os20/apps/market",
  permissions: ["storage.read", "storage.write", "desktop.modify", "theme.apply", "plugin.manage", "network.request"],
});

export const ONBOARDING_MANIFEST = app({
  appId: "onboarding",
  name: "首次启动引导",
  description: "首次打开时的七步引导：欢迎、模式选择、个性化、设备、应用、工作空间与完成。",
  icon: "di-spark",
  category: "system",
  entry: "os20/apps/onboarding",
  permissions: ["storage.read", "storage.write", "desktop.modify"],
});

/* ============================================================
   1.4+ 系统应用
   ============================================================ */

export const OS20_SYSTEM_MANIFESTS: AppManifest[] = [
  SYSTEM_CENTER_MANIFEST,
  UPDATE_CENTER_MANIFEST,
  MARKET_MANIFEST,
  ONBOARDING_MANIFEST,

  app({
    appId: "appcenter",
    name: "应用中心",
    description: "安装、更新与管理桌面应用。应用本体是系统内置代码，安装只改变登记状态。",
    icon: "di-appcenter",
    category: "system",
    entry: "os14/appcenter",
    permissions: ["storage.read", "storage.write", "desktop.modify"],
  }),
  app({
    appId: "themes",
    name: "主题中心",
    description: "十套完整主题与自定义主题，支持导入导出与校验。",
    icon: "di-themes",
    category: "system",
    entry: "os14/themes",
    permissions: ["storage.read", "storage.write", "theme.apply", "files.write"],
  }),
  app({
    appId: "widgetstore",
    name: "组件中心",
    description: "桌面小组件的添加、尺寸、透明度与布局管理。",
    icon: "di-widgets",
    category: "system",
    entry: "os14/widgetstore",
    permissions: ["storage.read", "storage.write", "desktop.modify", "files.read"],
  }),
  app({
    appId: "workspaces",
    name: "工作空间",
    description: "把壁纸、主题、组件、程序坞与窗口布局保存成可一键切换的场景。",
    icon: "di-space",
    category: "system",
    entry: "os14/workspaces",
    permissions: ["storage.read", "storage.write", "desktop.modify", "window.control"],
  }),
  app({
    appId: "control",
    name: "控制中心",
    description: "快捷开关、系统状态与应用管理；模拟数据会明确标注。",
    icon: "di-control",
    category: "system",
    entry: "os14/control",
    permissions: ["storage.read", "storage.write", "desktop.modify", "window.control"],
  }),
  app({
    appId: "tasks",
    name: "任务与通知",
    description: "任务、优先级、截止日期与通知中心联动。",
    icon: "di-tasks",
    category: "productivity",
    entry: "os14/tasks",
    permissions: ["storage.read", "storage.write", "notifications.post"],
  }),
  app({
    appId: "datacenter",
    name: "数据中心",
    description: "本地数据占用、导出导入、自动备份与恢复。",
    icon: "di-data",
    category: "system",
    entry: "os14/datacenter",
    permissions: ["storage.read", "storage.write", "files.write"],
  }),
  app({
    appId: "notes",
    name: "Guandao Notes",
    description: "多文档、文件夹、Markdown 与标签的本地笔记。",
    icon: "di-note",
    category: "productivity",
    entry: "os14/apps/notes",
    permissions: ["storage.read", "storage.write", "files.write"],
  }),
  app({
    appId: "calendar",
    name: "Guandao Calendar",
    description: "月历、日程、重复规则与提醒。",
    icon: "di-cal",
    category: "productivity",
    entry: "os14/apps/calendar",
    permissions: ["storage.read", "storage.write", "notifications.post"],
  }),
  app({
    appId: "files",
    name: "文件管理器",
    description: "浏览器内的虚拟文件系统：分类、关联、回收站与打包导出。",
    icon: "di-files",
    category: "system",
    entry: "os14/files",
    permissions: ["storage.read", "storage.write", "files.read", "files.write"],
  }),
  app({
    appId: "drive",
    name: "Guandao Cloud Drive",
    description: "云端文件空间：上传、下载、配额与分享；服务端授权，客户端拿不到直链。",
    icon: "di-files",
    category: "network",
    entry: "os14/drive",
    permissions: ["storage.read", "cloud.sync", "network.request", "files.read", "files.write"],
  }),
  app({
    appId: "devices",
    name: "Guandao Devices",
    description: "设备、会话、配对与接力。设备身份由服务端生成，客户端不自造设备。",
    icon: "di-devices",
    category: "network",
    entry: "os14/devices",
    permissions: ["account.read", "cloud.sync", "network.request"],
  }),
  app({
    appId: "backup",
    name: "Guandao Backup",
    description: "云端备份与恢复：生成、校验、历史版本与恢复前保护。",
    icon: "di-backup",
    category: "system",
    entry: "os14/backup",
    permissions: ["storage.read", "cloud.sync", "network.request"],
  }),
  app({
    appId: "security",
    name: "Privacy & Security",
    description: "账号安全、数据导出、数据删除、审计日志与权限总览。",
    icon: "di-security",
    category: "system",
    entry: "os14/security",
    permissions: ["storage.read", "account.read", "cloud.sync", "network.request"],
  }),
  app({
    appId: "community",
    name: "Guandao Community",
    description: "创作者主页、主题/组件/工作空间/插件分享、点赞评论与审核。",
    icon: "di-community",
    category: "network",
    entry: "os14/community",
    permissions: ["storage.read", "network.request", "account.read", "files.read", "notifications.post"],
  }),
  app({
    appId: "continuity",
    name: "接力中心",
    description: "跨设备配对、剪贴板与接力；需要两端在线与有效会话。",
    icon: "di-devices",
    category: "network",
    entry: "continuity/app",
    permissions: ["storage.read", "network.request", "clipboard.read", "clipboard.write", "account.read"],
  }),
  app({
    appId: "pm",
    name: "插件管理器",
    description: "插件安装、权限逐项授权、更新、回退、日志与禁用。",
    icon: "di-widgets",
    category: "system",
    entry: "plugins/manager",
    permissions: ["storage.read", "storage.write", "plugin.manage"],
  }),
  app({
    appId: "pmarket",
    name: "插件市场",
    description: "经过审核的第三方插件；安装前校验包摘要、权限与系统兼容性。",
    icon: "di-appcenter",
    category: "network",
    entry: "plugins/market",
    permissions: ["storage.read", "network.request", "plugin.manage"],
  }),
  app({
    appId: "pdev",
    name: "开发者中心",
    description: "开发者资料、草稿、版本上传、审核状态、安装统计与文档。",
    icon: "di-themes",
    category: "network",
    entry: "plugins/developer",
    permissions: ["storage.read", "network.request", "account.read"],
  }),
  app({
    appId: "music",
    name: "Guandao Music",
    description: "本地音乐与播放列表，音频只保存在浏览器 IndexedDB。",
    icon: "di-music",
    category: "fun",
    entry: "os14/apps/music",
    permissions: ["storage.read", "storage.write", "files.read"],
  }),
  app({
    appId: "gallery",
    name: "Guandao Gallery",
    description: "图片收藏与相册；图片压缩后保存在 IndexedDB，不上传。",
    icon: "di-gallery",
    category: "creative",
    entry: "os14/apps/gallery",
    permissions: ["storage.read", "storage.write", "files.read"],
  }),
  app({
    appId: "reader",
    name: "Guandao Reader",
    description: "TXT 与 Markdown 阅读：进度、字号、夜间模式与书签。",
    icon: "di-reader",
    category: "study",
    entry: "os14/apps/reader",
    permissions: ["storage.read", "storage.write", "files.read"],
  }),
  app({
    appId: "playground",
    name: "游乐场",
    description: "七款小游戏、像素桌宠与彩蛋；分数保存在本地。",
    icon: "di-play",
    category: "fun",
    entry: "os14/playground",
    permissions: ["storage.read", "storage.write"],
  }),
  app({
    appId: "perflab",
    name: "Performance Lab",
    description: "真实测量应用启动、窗口操作与交互延迟；读不到的硬件指标不会伪造。",
    icon: "di-mon",
    category: "lab",
    entry: "quality/perflab",
    permissions: ["storage.read", "storage.write"],
  }),
  app({
    appId: "diagnostics",
    name: "System Diagnostics",
    description: "前端、API、D1、R2、会话、同步、备份与插件状态的真实自检。",
    icon: "di-security",
    category: "lab",
    entry: "quality/diagnostics",
    permissions: ["storage.read", "network.request"],
  }),
];

/* ============================================================
   1.0–1.3 应用
   ============================================================ */

export const OS20_LEGACY_MANIFESTS: AppManifest[] = [
  app({
    appId: "posts",
    name: "文章",
    description: "在桌面里浏览博客文章列表。",
    icon: "di-folder",
    category: "study",
    entry: "legacy/posts",
    permissions: ["storage.read"],
  }),
  app({
    appId: "about",
    name: "关于",
    description: "关于 Guandao OS 与作者。",
    icon: "di-person",
    category: "system",
    entry: "legacy/about",
    permissions: [],
  }),
  app({
    appId: "terminal",
    name: "终端",
    description: "能真正执行命令的本地终端：打开应用、切换主题、查看系统信息。",
    icon: "di-term",
    category: "system",
    entry: "legacy/terminal",
    permissions: ["storage.read", "storage.write", "window.control"],
  }),
  app({
    appId: "settings",
    name: "经典设置",
    description: "1.3 的个性化设置面板，2.0 起由系统设置统一承接。",
    icon: "di-gear",
    category: "system",
    entry: "legacy/settings",
    permissions: ["storage.read", "storage.write"],
  }),
  app({
    appId: "achievements",
    name: "成就",
    description: "在桌面里完成的小目标与进度。",
    icon: "di-ach",
    category: "fun",
    entry: "legacy/achievements",
    permissions: ["storage.read", "storage.write"],
  }),
  app({
    appId: "aquarium",
    name: "水族箱",
    description: "会动的像素水族箱，点击投喂。",
    icon: "di-tank",
    category: "fun",
    entry: "legacy/aquarium",
    permissions: [],
  }),
  app({
    appId: "visitors",
    name: "访客墙",
    description: "基于 Supabase 的访客留言墙，需要网络与账号。",
    icon: "di-wall",
    category: "network",
    entry: "legacy/visitors",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "rank",
    name: "排行榜",
    description: "桌面停留时长排行，数据在云端。",
    icon: "di-rank",
    category: "network",
    entry: "legacy/rank",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "draw",
    name: "每日抽奖",
    description: "每天一次的小惊喜，结果记在本地。",
    icon: "di-draw",
    category: "fun",
    entry: "legacy/draw",
    permissions: ["storage.read", "storage.write"],
  }),
  app({
    appId: "council",
    name: "议会",
    description: "云端投票，每个账号每题一票。",
    icon: "di-vote",
    category: "network",
    entry: "legacy/council",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "treehole",
    name: "树洞",
    description: "匿名留言板，内容存储在云端。",
    icon: "di-hole",
    category: "network",
    entry: "legacy/treehole",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "news",
    name: "新闻联播",
    description: "极简资讯聚合窗口。",
    icon: "di-tv",
    category: "network",
    entry: "legacy/news",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "social",
    name: "社会网络",
    description: "关注与动态时间线，数据在云端。",
    icon: "di-net",
    category: "network",
    entry: "legacy/social",
    permissions: ["storage.read", "network.request"],
  }),
  app({
    appId: "calc",
    name: "计算器",
    description: "支持键盘输入与历史记录的计算器。",
    icon: "di-calc",
    category: "productivity",
    entry: "legacy/calc",
    permissions: ["storage.read"],
  }),
  app({
    appId: "monitor",
    name: "系统监视器",
    description: "窗口数量、运行时间与本地存储占用；不伪造硬件读数。",
    icon: "di-mon",
    category: "system",
    entry: "legacy/monitor",
    permissions: ["storage.read"],
  }),
  app({
    appId: "viewer",
    name: "图片查看器",
    description: "打开本地图片并缩放、旋转、全屏查看。",
    icon: "di-viewer",
    category: "creative",
    entry: "legacy/viewer",
    permissions: ["files.read"],
  }),
  app({
    appId: "browser",
    name: "浏览器",
    description: "地址栏与本地历史记录，外部页面在新标签页打开。",
    icon: "di-browser",
    category: "network",
    entry: "legacy/browser",
    permissions: ["storage.read", "storage.write", "network.request"],
  }),
];

export const ALL_SYSTEM_MANIFESTS: AppManifest[] = [...OS20_SYSTEM_MANIFESTS, ...OS20_LEGACY_MANIFESTS];

export const MANIFEST_BY_ID: Record<string, AppManifest> = Object.fromEntries(
  ALL_SYSTEM_MANIFESTS.map((manifest) => [manifest.appId, manifest]),
);

/** 2.0 新应用（启动时注册为应用中心里可见的条目） */
export const OS20_NEW_APP_IDS = ["systemcenter", "updatecenter", "market", "onboarding"] as const;