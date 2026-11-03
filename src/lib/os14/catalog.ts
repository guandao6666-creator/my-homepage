/**
 * Guandao OS 1.4 · 应用目录
 *
 * 这里只存放「应用市场需要展示的元数据」以及安装状态。
 * 应用本体仍是本地代码，安装 / 卸载只改变系统登记状态，
 * 绝不从网络下载并执行任意脚本。
 */

import { emit, ls } from "./core";

export type CategoryId = "productivity" | "study" | "fun" | "system" | "creative" | "network" | "lab";

export type PermissionId = "read" | "write" | "image" | "audio" | "notify" | "link" | "download";

export type AppMeta = {
  id: string;
  name: string;
  glyph: string;
  category: CategoryId;
  version: string;
  author: string;
  tagline: string;
  desc: string;
  features: string[];
  permissions: PermissionId[];
  size: string;
  /** 是否默认未安装（用于演示真实的安装流程） */
  optional?: boolean;
  featured?: boolean;
  isNew?: boolean;
  hot?: number;
  release: string;
  changelog: Array<{ v: string; date: string; items: string[] }>;
  screens: Array<{ name: string; hint: string }>;
  /** 语气：内置系统组件 / 内容型应用 */
  builtin?: boolean;
};

export const CATEGORIES: Array<{ id: CategoryId; name: string; ico: string; desc: string }> = [
  { id: "productivity", name: "效率工具", ico: "◎", desc: "记录、安排、整理日常" },
  { id: "study", name: "学习工具", ico: "✎", desc: "阅读与知识管理" },
  { id: "fun", name: "娱乐游戏", ico: "✦", desc: "放松一下，随时可停" },
  { id: "system", name: "系统工具", ico: "⚙", desc: "桌面与系统的底层能力" },
  { id: "creative", name: "创意工具", ico: "◈", desc: "图片与视觉素材" },
  { id: "network", name: "网络工具", ico: "⇄", desc: "博客、社区与外部链接" },
  { id: "lab", name: "实验性应用", ico: "⚗", desc: "彩蛋与实验特性" },
];

export const PERMISSIONS: Record<PermissionId, { label: string; desc: string; risk: "low" | "mid" | "high" }> = {
  read: { label: "本地数据读取", desc: "读取本应用保存在浏览器里的数据", risk: "low" },
  write: { label: "本地数据写入", desc: "在你的浏览器里保存配置与内容", risk: "low" },
  image: { label: "图片导入", desc: "通过文件选择器读取你主动选中的图片", risk: "mid" },
  audio: { label: "音频导入", desc: "通过文件选择器读取你主动选中的音频", risk: "mid" },
  notify: { label: "通知权限", desc: "在通知中心写入提醒条目（不调用系统推送）", risk: "low" },
  link: { label: "外部链接访问", desc: "可以在新标签页打开外部网址", risk: "mid" },
  download: { label: "导出文件", desc: "把数据保存为本地文件（浏览器下载）", risk: "low" },
};

const A = "Guandao Studio";

export const CATALOG: AppMeta[] = [
  {
    id: "appcenter",
    name: "应用中心",
    glyph: "di-appcenter",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "安装、更新与管理你的桌面应用",
    desc: "Guandao OS 的应用商店。所有应用都是本项目内置的本地代码，安装只是把它登记进系统，不会从网络下载并执行未知脚本。你可以随时卸载、重新安装，或把常用应用固定到程序坞、放到桌面。",
    features: ["按分类浏览与关键词搜索", "应用详情、权限声明与更新日志", "安装 / 卸载 / 更新真实生效", "固定到程序坞、添加桌面快捷方式"],
    permissions: ["read", "write", "download"],
    size: "1.1 MB",
    featured: true,
    builtin: true,
    release: "2026-11-03",
    changelog: [
      { v: "1.4.0", date: "2026-11-03", items: ["应用商店首页与分类", "真实安装 / 卸载流程", "权限声明与详情页"] },
    ],
    screens: [
      { name: "发现", hint: "推荐、最新、热门与最近更新" },
      { name: "分类", hint: "七类应用一键筛选" },
      { name: "详情", hint: "权限、更新日志与截图预览" },
    ],
  },
  {
    id: "themes",
    name: "主题中心",
    glyph: "di-themes",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "十套完整主题，换的不只是壁纸",
    desc: "每套主题都同时定义壁纸、强调色、窗口材质、圆角、程序坞样式、菜单栏与组件观感，而不只是换一张背景图。支持收藏、最近使用、自定义主题，以及配置文件的导入导出。",
    features: ["10 套内置主题 + 即时预览", "一键应用与恢复默认", "收藏与最近使用", "自定义主题、导入导出（带校验）"],
    permissions: ["read", "write", "download"],
    size: "820 KB",
    featured: true,
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["主题商店与完整设计令牌", "自定义主题编辑器", "主题配置导入导出"] }],
    screens: [
      { name: "主题墙", hint: "十套主题的实时缩略预览" },
      { name: "自定义", hint: "自己搭配颜色与材质" },
    ],
  },
  {
    id: "widgetstore",
    name: "组件中心",
    glyph: "di-widgets",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "把桌面布置成你自己的样子",
    desc: "集中管理桌面小组件：相框、倒计时、专注计时、迷你日历、音乐控制、快速便签、每日语录、系统状态、世界时钟。可以添加、删除、拖动、调整尺寸与透明度、锁定位置并保存布局。",
    features: ["9 个新组件 + 原有 11 个组件", "按分类浏览与一键添加", "尺寸、透明度、层级与锁定", "布局保存与恢复"],
    permissions: ["read", "write", "image"],
    size: "640 KB",
    featured: true,
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["组件市场与分类", "新增 9 个桌面组件", "组件布局管理"] }],
    screens: [
      { name: "组件库", hint: "按用途分类的组件卡片" },
      { name: "布局", hint: "尺寸、透明度与锁定" },
    ],
  },
  {
    id: "playground",
    name: "游乐场",
    glyph: "di-play",
    category: "fun",
    version: "1.4.0",
    author: A,
    tagline: "七款小游戏、桌面互动与彩蛋",
    desc: "Guandao OS 的娱乐空间。2048、贪吃蛇、扫雷、记忆翻牌、原创方块、反应测试、数字猜谜都可以实际游玩，分数与最高纪录会保存。另有像素桌宠、点击反馈和若干隐藏彩蛋。",
    features: ["7 款可玩游戏，支持暂停与重开", "统一游戏外壳与最高分记录", "像素桌宠与桌面互动", "彩蛋收集与隐藏入口"],
    permissions: ["read", "write", "notify"],
    size: "1.6 MB",
    featured: true,
    isNew: true,
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["七款小游戏", "像素桌宠", "桌面互动与隐藏彩蛋"] }],
    screens: [
      { name: "游戏中心", hint: "七款游戏与最高分" },
      { name: "桌面互动", hint: "像素小动物与装饰物" },
      { name: "彩蛋", hint: "已发现的秘密" },
    ],
  },
  {
    id: "workspaces",
    name: "工作空间",
    glyph: "di-space",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "一键切换整套桌面场景",
    desc: "Daily、Study、Work、Entertainment 四套预设，每套独立保存壁纸、主题、组件布局、程序坞、快捷方式与窗口布局。工作空间保存的是「一整套场景」，与只管理窗口的虚拟桌面并存但互不干扰。",
    features: ["四套预设场景", "一键切换与快捷键切换", "新建 / 复制 / 重命名 / 删除", "切换动画与配置快照"],
    permissions: ["read", "write"],
    size: "520 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["四套预设工作空间", "场景快照与恢复", "快捷键切换"] }],
    screens: [
      { name: "场景", hint: "四套预设与自定义场景" },
      { name: "快照", hint: "壁纸、组件与窗口布局" },
    ],
  },
  {
    id: "control",
    name: "控制中心",
    glyph: "di-control",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "快捷开关、系统状态与应用管理",
    desc: "把散落在各处的开关收进一个面板：深浅色、勿扰、音量、动画、壁纸、桌面图标、程序坞自动隐藏。系统状态区分真实数据与模拟数据，应用管理支持强制关闭窗口与卸载。",
    features: ["8 组快捷控制", "真实 / 模拟数据明确标注", "运行中窗口管理与强制关闭", "已安装应用列表与卸载"],
    permissions: ["read", "write"],
    size: "460 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["统一控制面板", "系统状态分区", "应用管理"] }],
    screens: [
      { name: "快捷控制", hint: "开关与滑块" },
      { name: "系统状态", hint: "运行时间、存储与窗口" },
      { name: "应用管理", hint: "运行中与已安装" },
    ],
  },
  {
    id: "tasks",
    name: "任务与通知",
    glyph: "di-tasks",
    category: "productivity",
    version: "1.4.0",
    author: A,
    tagline: "任务、提醒与通知在同一个地方",
    desc: "创建任务、设置优先级与截止日期、分类与搜索，并统计完成情况。到期任务、专注计时结束、游戏成就都会写入通知中心，两边共用同一份真实数据。",
    features: ["任务优先级 / 截止日期 / 分类", "完成率统计与逾期提醒", "通知中心与未读管理", "与日历、专注计时联动"],
    permissions: ["read", "write", "notify"],
    size: "380 KB",
    featured: true,
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["任务中心", "通知与任务联动", "完成情况统计"] }],
    screens: [
      { name: "任务", hint: "按状态与优先级整理" },
      { name: "通知", hint: "应用通知与提醒" },
      { name: "统计", hint: "完成率与分类分布" },
    ],
  },
  {
    id: "datacenter",
    name: "数据中心",
    glyph: "di-data",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "看清你的数据，并随时带走",
    desc: "统一查看应用、笔记、日历、任务、布局、主题、游戏记录等数据占用；支持全量导出、带校验的导入、本地自动备份与历史恢复、恢复默认设置。所有数据都在你自己的浏览器里。",
    features: ["存储占用可视化", "全量导出 / 导入（格式与版本校验）", "自动本地备份与备份历史", "恢复默认与危险操作确认"],
    permissions: ["read", "write", "download"],
    size: "420 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["数据概览与占用统计", "备份历史与恢复", "导入校验"] }],
    screens: [
      { name: "概览", hint: "各类数据占用" },
      { name: "备份", hint: "自动备份与历史" },
      { name: "迁移", hint: "导出与导入" },
    ],
  },

  /* ---------------- 1.4 升级的内容型应用 ---------------- */
  {
    id: "notes",
    name: "Guandao Notes",
    glyph: "di-note",
    category: "productivity",
    version: "1.4.0",
    author: A,
    tagline: "多文档、文件夹、Markdown 与标签",
    desc: "从单张便签升级为完整的笔记工具：多文档、文件夹分类、Markdown 编辑与预览、标签、全文搜索、自动保存、导出 Markdown。旧版便签会在首次打开时自动迁移。",
    features: ["文件夹 + 多文档", "Markdown 编辑 / 预览双模式", "标签与全文搜索", "自动保存与 .md 导出"],
    permissions: ["read", "write", "download"],
    size: "260 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [
      { v: "1.4.0", date: "2026-11-03", items: ["多文档与文件夹", "Markdown 编辑与预览", "标签、搜索、自动保存、导出"] },
      { v: "1.0.0", date: "2026-10-20", items: ["单张便签"] },
    ],
    screens: [
      { name: "文档", hint: "左中右三栏结构" },
      { name: "预览", hint: "Markdown 渲染结果" },
    ],
  },
  {
    id: "calendar",
    name: "Guandao Calendar",
    glyph: "di-cal",
    category: "productivity",
    version: "1.4.0",
    author: A,
    tagline: "日历、日程与提醒",
    desc: "月历视图与日程列表、分类颜色标签、提醒、重复事件（每天 / 每周 / 每月）、日程搜索，并与任务中心共享待办数据。",
    features: ["月历 / 日程双视图", "颜色分类与重复规则", "提前提醒写入通知中心", "搜索与任务联动"],
    permissions: ["read", "write", "notify"],
    size: "240 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [
      { v: "1.4.0", date: "2026-11-03", items: ["月历视图与日程面板", "分类颜色 / 重复 / 提醒", "搜索与任务联动"] },
      { v: "1.2.0", date: "2026-10-28", items: ["基础日程记录"] },
    ],
    screens: [
      { name: "月历", hint: "有日程的日期带色点" },
      { name: "日程", hint: "按分类与时间排列" },
    ],
  },
  {
    id: "files",
    name: "文件管理器",
    glyph: "di-files",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "分类、关联、回收站与打包导出",
    desc: "浏览器内的虚拟文件系统，不会访问你电脑上的真实文件。新增文档 / 图片 / 音频 / 视频分类、最近打开、下载内容、回收站与文件关联：Markdown 交给笔记或阅读器，图片交给相册，音频交给音乐。",
    features: ["按类型分类与收藏 / 最近 / 下载", "复制、移动、重命名、回收站恢复", "文件关联与打开方式", "导入、导出与文件夹打包"],
    permissions: ["read", "write", "download"],
    size: "300 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["分类与回收站", "文件关联", "打包导出"] }],
    screens: [
      { name: "文件", hint: "分类侧栏与文件网格" },
      { name: "详情", hint: "大小、类型与打开方式" },
    ],
  },
  {
    id: "music",
    name: "Guandao Music",
    glyph: "di-music",
    category: "fun",
    version: "1.4.0",
    author: A,
    tagline: "本地音乐与播放列表",
    desc: "播放项目内置的音频，也可以导入你自己的本地音频文件（只保存在浏览器 IndexedDB 中，不上传）。支持播放队列、上一首 / 下一首、音量、进度与专辑封面展示。不内置任何未授权的商业音乐。",
    features: ["本地音频导入（浏览器内保存）", "播放 / 暂停 / 上一首 / 下一首", "播放列表、音量与进度", "根据音频生成封面与波形"],
    permissions: ["read", "write", "audio"],
    size: "320 KB",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["本地音频导入", "播放队列与音量", "封面展示"] }],
    screens: [{ name: "播放器", hint: "封面、进度与队列" }],
  },
  {
    id: "gallery",
    name: "Guandao Gallery",
    glyph: "di-gallery",
    category: "creative",
    version: "1.4.0",
    author: A,
    tagline: "你的图片收藏与相册",
    desc: "导入本地图片并按相册分类，支持预览、收藏、搜索和幻灯片播放。图片会压缩后保存在浏览器 IndexedDB 中，不会上传到任何服务器。",
    features: ["导入图片并自动压缩", "相册分类与收藏", "大图预览与键盘翻页", "幻灯片播放"],
    permissions: ["read", "write", "image"],
    size: "280 KB",
    optional: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["图片导入与相册", "预览、收藏、幻灯片"] }],
    screens: [{ name: "相册", hint: "网格浏览与筛选" }, { name: "预览", hint: "大图与幻灯片" }],
  },
  {
    id: "reader",
    name: "Guandao Reader",
    glyph: "di-reader",
    category: "study",
    version: "1.4.0",
    author: A,
    tagline: "把 TXT 与 Markdown 读舒服",
    desc: "导入 TXT 或 Markdown 文本，记住阅读进度，支持字号、行距、夜间模式、书签与最近阅读。文本保存在浏览器 IndexedDB 中。",
    features: ["导入 TXT / Markdown", "阅读进度自动保存", "字号与夜间阅读", "书签与最近阅读"],
    permissions: ["read", "write", "download"],
    size: "220 KB",
    optional: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["导入 TXT / MD", "阅读进度与书签", "夜间阅读"] }],
    screens: [{ name: "书架", hint: "最近阅读与进度" }, { name: "阅读", hint: "字号与夜间模式" }],
  },

  /* ---------------- 1.0–1.3 已有应用 ---------------- */
  {
    id: "posts",
    name: "文章",
    glyph: "di-folder",
    category: "study",
    version: "1.3.0",
    author: A,
    tagline: "博客文章列表",
    desc: "在桌面里直接浏览博客文章，点击后打开阅读页。文章内容来自站点构建时生成的 Markdown。",
    features: ["按时间倒序浏览文章", "标签与阅读时长", "直接跳转文章页面"],
    permissions: ["read"],
    size: "内置",
    builtin: true,
    release: "2026-10-20",
    changelog: [{ v: "1.0.0", date: "2026-09-30", items: ["文章列表窗口"] }],
    screens: [{ name: "列表", hint: "文章与标签" }],
  },
  {
    id: "about",
    name: "关于",
    glyph: "di-person",
    category: "system",
    version: "1.3.0",
    author: A,
    tagline: "关于这个桌面和它的作者",
    desc: "一段简短的自我介绍，以及这个 Guandao OS 是怎么来的。",
    features: ["作者介绍", "版本信息"],
    permissions: ["read"],
    size: "内置",
    builtin: true,
    release: "2026-09-30",
    changelog: [{ v: "1.0.0", date: "2026-09-30", items: ["关于窗口"] }],
    screens: [{ name: "关于", hint: "名片式布局" }],
  },
  {
    id: "terminal",
    name: "终端",
    glyph: "di-term",
    category: "system",
    version: "1.4.0",
    author: A,
    tagline: "命令行里也能逛桌面",
    desc: "一个真的能执行命令的本地终端模拟器：打开应用、切换主题、查看系统信息、列出应用。1.4 增加了若干隐藏命令。",
    features: ["open / ls / apps / version 等命令", "切换外观与壁纸", "1.4 隐藏命令"],
    permissions: ["read", "write", "link"],
    size: "内置",
    builtin: true,
    release: "2026-11-03",
    changelog: [{ v: "1.4.0", date: "2026-11-03", items: ["新增隐藏命令"] }],
    screens: [{ name: "终端", hint: "等宽字体输出" }],
  },
  {
    id: "settings",
    name: "系统设置",
    glyph: "di-gear",
    category: "system",
    version: "1.3.0",
    author: A,
    tagline: "壁纸、外观、程序坞与图标",
    desc: "1.3 的个性化设置：壁纸库、外观材质、强调色、程序坞、图标布局、动画与屏幕布局。",
    features: ["10 个设置分类", "实时预览与持久化"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-30",
    changelog: [{ v: "1.3.0", date: "2026-10-30", items: ["设置 2.0"] }],
    screens: [{ name: "设置", hint: "分类侧栏" }],
  },
  {
    id: "achievements",
    name: "成就",
    glyph: "di-ach",
    category: "fun",
    version: "1.3.0",
    author: A,
    tagline: "在桌面里完成的小目标",
    desc: "记录你打开过哪些应用、养过几次桌宠、读过几篇文章。解锁时会推送一条通知。",
    features: ["成就解锁与进度", "与桌面行为联动"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-20",
    changelog: [{ v: "1.1.0", date: "2026-10-20", items: ["成就系统"] }],
    screens: [{ name: "成就", hint: "已解锁与未解锁" }],
  },
  {
    id: "aquarium",
    name: "水族箱",
    glyph: "di-tank",
    category: "fun",
    version: "1.2.0",
    author: A,
    tagline: "一个会动的像素水族箱",
    desc: "养在桌面里的小鱼缸，鱼会游动、会吃食，点击可以投喂。纯装饰，没有压力。",
    features: ["实时游动动画", "点击投喂"],
    permissions: ["read"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["水族箱"] }],
    screens: [{ name: "水族箱", hint: "Canvas 动画" }],
  },
  {
    id: "visitors",
    name: "访客墙",
    glyph: "di-wall",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "留一句话再走",
    desc: "基于 Supabase 的访客留言墙：登录后可以留下昵称与一句话。需要网络与云端配置，离线时会明确提示。",
    features: ["登录 / 注册", "留言与展示"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["访客墙"] }],
    screens: [{ name: "访客墙", hint: "留言卡片" }],
  },
  {
    id: "rank",
    name: "排行榜",
    glyph: "di-rank",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "在桌面停留了多久",
    desc: "记录访客的停留时长并排行。数据存储在云端，离线时只显示本地状态。",
    features: ["停留时长统计", "排行榜"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["排行榜"] }],
    screens: [{ name: "排行", hint: "名次与时长" }],
  },
  {
    id: "draw",
    name: "每日抽奖",
    glyph: "di-draw",
    category: "fun",
    version: "1.2.0",
    author: A,
    tagline: "每天一次的小惊喜",
    desc: "每天可以抽一次，结果会记录在本地。纯娱乐，没有实际奖励。",
    features: ["每日一次", "结果留存"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["抽奖"] }],
    screens: [{ name: "抽奖", hint: "转盘与结果" }],
  },
  {
    id: "council",
    name: "议会",
    glyph: "di-vote",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "投票决定一些小事",
    desc: "云端投票：每个账号每题一票，结果实时汇总。构建时会把数据内联，避免国内直连超时。",
    features: ["多议题投票", "云端计票"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["议会投票"] }],
    screens: [{ name: "议题", hint: "投票与结果" }],
  },
  {
    id: "treehole",
    name: "树洞",
    glyph: "di-hole",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "说点不方便当面说的",
    desc: "匿名留言板，登录后可发布。内容存储在云端，请勿发布敏感信息。",
    features: ["匿名发布", "列表浏览"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["树洞"] }],
    screens: [{ name: "树洞", hint: "留言列表" }],
  },
  {
    id: "news",
    name: "新闻联播",
    glyph: "di-tv",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "每天几条值得知道的事",
    desc: "一个极简的资讯聚合窗口，内容由本地示例数据与外部链接组成。",
    features: ["列表浏览", "外部链接"],
    permissions: ["read", "link"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["新闻列表"] }],
    screens: [{ name: "新闻", hint: "条目列表" }],
  },
  {
    id: "social",
    name: "社会网络",
    glyph: "di-net",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "桌面里的轻社交",
    desc: "关注与动态的时间线，数据在云端。需要登录后使用。",
    features: ["动态时间线", "登录状态"],
    permissions: ["read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["社会网络"] }],
    screens: [{ name: "动态", hint: "时间线" }],
  },
  {
    id: "calc",
    name: "计算器",
    glyph: "di-calc",
    category: "productivity",
    version: "1.0.0",
    author: A,
    tagline: "键盘也能按的计算器",
    desc: "标准四则运算计算器，支持键盘输入与历史记录。",
    features: ["四则运算", "键盘操作"],
    permissions: ["read"],
    size: "内置",
    builtin: true,
    release: "2026-09-30",
    changelog: [{ v: "1.0.0", date: "2026-09-30", items: ["计算器"] }],
    screens: [{ name: "计算器", hint: "按键网格" }],
  },
  {
    id: "monitor",
    name: "系统监视器",
    glyph: "di-mon",
    category: "system",
    version: "1.3.0",
    author: A,
    tagline: "桌面自己的运行状态",
    desc: "展示 Guandao OS 自己的运行数据：窗口数量、运行时间、本地存储占用。硬件温度、CPU 频率等浏览器无法读取的指标不会伪造。",
    features: ["窗口与存储统计", "运行时间"],
    permissions: ["read"],
    size: "内置",
    builtin: true,
    release: "2026-10-20",
    changelog: [{ v: "1.3.0", date: "2026-10-20", items: ["系统监视器"] }],
    screens: [{ name: "监视器", hint: "数据卡片" }],
  },
  {
    id: "viewer",
    name: "图片查看器",
    glyph: "di-viewer",
    category: "creative",
    version: "1.2.0",
    author: A,
    tagline: "快速看一张图",
    desc: "打开本地图片并缩放、旋转、全屏查看。图片只在当前窗口内有效，关闭后不保留。",
    features: ["打开本地图片", "缩放 / 旋转 / 全屏"],
    permissions: ["image"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["图片查看器"] }],
    screens: [{ name: "查看", hint: "图片与工具栏" }],
  },
  {
    id: "browser",
    name: "浏览器",
    glyph: "di-browser",
    category: "network",
    version: "1.2.0",
    author: A,
    tagline: "桌面里的地址栏",
    desc: "输入网址或关键词，外部页面会在新标签页打开——浏览器安全策略不允许把第三方网站嵌进 iframe。会保留本地历史记录。",
    features: ["地址栏与搜索", "本地历史记录"],
    permissions: ["link", "read", "write"],
    size: "内置",
    builtin: true,
    release: "2026-10-12",
    changelog: [{ v: "1.2.0", date: "2026-10-12", items: ["浏览器窗口"] }],
    screens: [{ name: "浏览器", hint: "地址栏与快捷入口" }],
  },
];

export const META_BY_ID: Record<string, AppMeta> = Object.fromEntries(CATALOG.map((m) => [m.id, m]));

export const categoryName = (id: CategoryId) => CATEGORIES.find((c) => c.id === id)?.name ?? id;

/* ============================================================
   安装状态
   ============================================================ */

const KEY = "guandao.os14.apps.v1";

export type InstallState = {
  v: 1;
  installed: Record<string, { version: string; at: number }>;
  favorites: string[];
  shortcuts: string[];
  updatedAt: number;
};

const defaults = (): InstallState => {
  const installed: InstallState["installed"] = {};
  const now = Date.now();
  for (const meta of CATALOG) {
    if (meta.optional) continue;
    installed[meta.id] = { version: meta.version, at: now };
  }
  return { v: 1, installed, favorites: [], shortcuts: ["appcenter", "themes", "playground"], updatedAt: now };
};

let cache: InstallState | null = null;

export const readInstall = (): InstallState => {
  if (cache) return cache;
  const raw = ls.get<InstallState | null>(KEY, null);
  if (!raw || typeof raw !== "object" || !raw.installed) {
    cache = defaults();
    ls.set(KEY, cache);
    return cache;
  }
  // 合并：新版本新增的内置应用自动补齐为已安装
  const merged: InstallState = {
    v: 1,
    installed: { ...raw.installed },
    favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
    shortcuts: Array.isArray(raw.shortcuts) ? raw.shortcuts : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  cache = merged;
  return merged;
};

export const writeInstall = (next: InstallState) => {
  next.updatedAt = Date.now();
  cache = next;
  ls.set(KEY, next);
  emit("apps-change", { installed: Object.keys(next.installed) });
};

export const isInstalled = (id: string) => Boolean(readInstall().installed[id]);

export const installedVersion = (id: string) => readInstall().installed[id]?.version ?? "";

export const installedCount = () => Object.keys(readInstall().installed).length;

export const pendingUpdate = (id: string) => {
  const meta = META_BY_ID[id];
  if (!meta) return false;
  const cur = readInstall().installed[id];
  return Boolean(cur && cur.version !== meta.version);
};

export const updateInstallCache = () => {
  cache = null;
};
