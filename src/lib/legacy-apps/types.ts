/**
 * Guandao OS 2.2 · 旧版应用迁移的类型契约。
 *
 * 目标：让 `src/pages/index.astro` 里的旧版应用能搬到独立模块，
 * 条件是「明确依赖」而不是「依赖闭包里的自由变量」。
 *
 * 这里只声明迁移所需的**最小**能力集合；不要把它做成第二个 Ctx。
 * 完整的外壳能力仍在 `src/lib/os14/core.ts` 的 `Ctx` 里。
 *
 * Phase 2.2 遗留清理（本次）把外壳能力按类别拆成 5 个白名单 port：
 * `shell` / `auth` / `lifecycle` / `achievements` / `desktopFacilities`。
 * 每个字段的注释都写明「哪个应用用、为什么必须暴露」——新增字段前先确认
 * 确实有应用需要，避免把外壳的内部实现顺带泄漏出去。
 */

/** 构建时注入到页面的站点数据（等价于 index.astro 的 `data`） */
export type OsPost = {
  title: string;
  href: string;
  date: string;
  tags: string[];
  minutes: number;
};

export type OsSite = { author: string; host: string };

export type OsSupabase = { url: string; key: string };

export type OsData = {
  posts: OsPost[];
  tracks: { src: string; title: string }[];
  site: OsSite;
  council?: unknown;
  supabase?: Partial<OsSupabase>;
};

/** 登录态（与 index.astro 的 `AuthState` 字段一致） */
export type LegacyAuthState = {
  token: string;
  refresh: string;
  uid: string;
  email: string;
  at: number;
};

/** 时段（与 index.astro 的 `phaseNow()` 返回值一致） */
export type LegacyDayPhase = "dawn" | "day" | "dusk" | "night";

/** 成就定义（与 index.astro 的 `Achievement` 一致） */
export type LegacyAchievement = {
  id: string;
  mark: string;
  name: string;
  desc: string;
};

/** 成就存档（与 index.astro 的 `AchState` 一致） */
export type LegacyAchievementState = {
  unlocked: Record<string, number>;
  visits: number;
  petClicks: number;
  apps: string[];
  reads: number;
};

/**
 * 外壳动作 port：会改变桌面状态的操作。
 *
 * 目前只有「终端」用（theme / wallpaper / exit / 生态扩展命令），
 * 「访客墙」用 `makeId` 生成上传文件名。设置面板仍留在外壳里，
 * 因此这里**不**暴露 Dock / 组件 / 数据导入导出这些能力。
 */
export type LegacyShellPort = {
  /**
   * 关闭当前窗口（终端 `exit`）。
   * 复用外壳 `closeWin`：派发 before-close、执行 `__gosCleanup`、写窗口状态。
   */
  closeWindow(win: HTMLElement): void;
  /**
   * 切换外观主题（终端 `theme`）。
   * 复用外壳 `applyOsTheme`：写 `body.dataset.osTheme` 与 `guandao.os.theme`。
   */
  setTheme(theme: "dark" | "light"): void;
  /**
   * 切换壁纸（终端 `wallpaper`）。
   * 同时更新 `os.dataset.wall` 与窗口状态存储，与设置面板的壁纸按钮行为一致。
   */
  setWallpaper(wall: string): void;
  /**
   * 把未命中的命令交给 os14 生态层（终端隐藏命令）。
   * 没有生态层 / 未注册该命令时返回 null，行为等价于原来的 `window.GOS14?.terminal?.()`。
   */
  runExtensionCommand(name: string): string | null;
  /**
   * 生成一个本地唯一 id（访客墙上转头像文件名）。
   * 复用外壳已有的 `crypto.randomUUID` 兼容实现，避免模块里再抄一份。
   */
  makeId(): string;
};

/**
 * 窗口级生命周期 port：应用自己启动的定时器 / 全局监听必须走这里，
 * 窗口关闭时由注册适配器统一清理（对应 `__gosCleanup`）。
 */
export type LegacyLifecyclePort = {
  /**
   * 注册窗口内 `setInterval`；窗口关闭自动 clear。
   * 应用仍可拿返回值自己 `window.clearInterval(id)` 提前停止（水族箱 / 系统监视器）。
   */
  interval(win: HTMLElement, handler: () => void, ms: number): number;
  /**
   * 注册窗口内 `setTimeout`；窗口关闭自动 clear（还没触发的话）。
   * 水族箱投喂动画、每日抽奖的抖动动画使用。
   */
  timeout(win: HTMLElement, handler: () => void, ms: number): number;
  /**
   * 监听 window 级事件并在窗口关闭时自动解绑。
   * 议会 / 树洞 / 社会网络监听 `guandao:auth-change` 用。
   */
  onGlobal(win: HTMLElement, type: string, handler: EventListener): void;
  /**
   * 只在注册适配器（`registerLegacyApps` 的 init 包装）关窗时调用。
   * 应用模块不要主动调用它——提前 dispose 会顺手清掉本窗口的计时器。
   */
  dispose(win: HTMLElement): void;
};

/**
 * 登录能力 port。
 *
 * 议会 / 树洞 / 社会网络共用：三者的登录表单、token 刷新、登录态变化
 * 都是同一套实现，迁出后不能各写一份。
 */
export type LegacyAuthPort = {
  /** 登录 / 注册表单 HTML（同一份 `authFormHtml`，表单提交仍由外壳 document 级委托处理）。 */
  formHtml(): string;
  /** 读取当前登录态（同一份 `readAuth`；未登录返回 null）。 */
  read(): LegacyAuthState | null;
  /** 确保 token 新鲜（同一份 `ensureFreshToken`；失败返回 null 并清空登录态）。 */
  ensureFreshToken(): Promise<string | null>;
  /** 退出登录（社会网络的「退出」按钮，等价 `writeAuth(null)`）。 */
  signOut(): void;
  /** 登录态变化回调（内部走 lifecycle.onGlobal，窗口关闭自动解绑）。 */
  onChange(win: HTMLElement, handler: () => void): void;
};

/**
 * 成就能力 port。
 *
 * 成就应用读清单与存档；终端（每条命令解锁 `hack`）与每日抽奖（解锁 `draw`）
 * 需要写解锁。宠物点击计数仍在外壳里，不在这里。
 */
export type LegacyAchievementsPort = {
  /** 全部成就定义（成就应用渲染网格）。 */
  list(): readonly LegacyAchievement[];
  /** 已解锁存档（成就应用显示已解锁数量）。 */
  state(): LegacyAchievementState;
  /** 解锁一个成就（写入存储并按原逻辑弹 toast / 通知；silent 不打扰）。 */
  unlock(id: string, silent?: boolean): boolean;
};

/**
 * 桌面设施 port：只读的系统级信息，供「系统类」应用展示。
 *
 * 这些值都是外壳本来就有的状态，但应用不应直接摸 `windows` / `desks` / `APPS`
 * 这些闭包变量，因此以只读方法暴露。终端（neofetch / apps）与系统监视器用。
 */
export type LegacyDesktopFacilitiesPort = {
  /** 当前打开的窗口数（终端 neofetch「运行窗口」；系统监视器的窗口数即 `openWindowTitles().length`）。 */
  openWindowCount(): number;
  /** 当前运行窗口的应用标题（系统监视器「运行中的应用」chips）。 */
  openWindowTitles(): string[];
  /** 虚拟桌面数量（终端 neofetch / 系统监视器）。 */
  deskCount(): number;
  /** 桌面启动时间戳（ms），用于「已开启 N 分钟」。 */
  bootedAt: number;
  /** 全部已注册应用标题（终端 `apps` 命令）。 */
  appTitles(): string[];
  /** 当前时段（水族箱相位；与时钟、自动壁纸共用同一份判定）。 */
  phase(): LegacyDayPhase;
};

/**
 * 旧 Shell 显式交给 legacy 应用的能力。
 *
 * 每一项都是应用真正会调用的东西；新增字段前先确认应用确实需要，
 * 避免把外壳的内部实现顺带泄漏出去。
 */
export type LegacyAppContext = {
  /** 旧 Shell 的 HTML 转义（与 index.astro 同一份实现，避免第 2 套转义） */
  escapeHtml: (text: string) => string;
  /** 构建期数据 */
  data: OsData;
  /** 带超时的 fetch（旧 Shell 的统一实现，7s 默认） */
  fetchWithTimeout: (url: string, init?: RequestInit, ms?: number) => Promise<Response>;
  /** 注册到现有 App Registry（index.astro 的 registerApp） */
  register: (spec: LegacyAppSpec) => void;
  /** 会改变桌面状态的外壳动作（终端 / 访客墙） */
  shell: LegacyShellPort;
  /** 登录态与 token 刷新（议会 / 树洞 / 社会网络） */
  auth: LegacyAuthPort;
  /** 窗口级定时器与全局监听清理（水族箱 / 系统监视器 / 议会 / 树洞 / 社会网络） */
  lifecycle: LegacyLifecyclePort;
  /** 成就读写（成就应用 / 终端 / 每日抽奖） */
  achievements: LegacyAchievementsPort;
  /** 只读桌面设施信息（终端 / 系统监视器 / 水族箱） */
  desktopFacilities: LegacyDesktopFacilitiesPort;
};

/**
 * 懒加载应用在模块下载完成后交给外壳的最小形状。
 *
 * 与 index.astro 的 `LazyAppModule` 完全一致：外壳先渲染骨架屏，
 * 模块到齐后再替换 `.win-body` 并执行 `init`。
 */
export type LegacyLazyAppModule = {
  body: () => string;
  init?: (win: HTMLElement) => void | (() => void);
};

/**
 * 交给 `registerApp` 的规格，字段与 index.astro 的 AppEntry 对齐。
 *
 * 6.1 起 `body` 可选：旧应用统一走 `load()` 按需下载，窗口先显示骨架屏。
 * `body` 仍保留给「必须同步产出首屏」的极端情况，当前没有应用使用。
 */
export type LegacyAppSpec = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph?: string;
  body?: () => string;
  init?: (win: HTMLElement) => void | (() => void);
  /** 按需加载应用实现；外壳负责骨架屏、12 秒超时与崩溃卡片 */
  load?: () => Promise<LegacyLazyAppModule>;
};

/**
 * 一个 legacy 应用模块的统一形状。
 *
 * `body` / `init` 接收 context，而不是读闭包；
 * 未使用的参数可以省略（`body: () => "..."`）。
 */
export type LegacyAppModule = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph?: string;
  body: (ctx: LegacyAppContext) => string;
  /** 返回清理函数时，窗口关闭会调用（见 index.astro 的 __gosCleanup） */
  init?: (win: HTMLElement, ctx: LegacyAppContext) => void | (() => void);
  /** 6.2：本应用的 CSS 就绪 Promise（走 ?url + ensureCss，见 lib/ui/lazy-css） */
  stylesReady?: Promise<void>;
};

/**
 * 懒加载清单条目（6.1）。
 *
 * 元数据必须是**同步可读**的：程序坞、启动台、终端 `apps` 在注册阶段就要拿到标题和图标。
 * 实现放在 `load()` 里，只有窗口真正打开时才会下载对应 chunk。
 * 元数据与模块导出的一致性由单测断言，避免两处各改一半。
 */
export type LegacyAppManifestEntry = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph?: string;
  load: () => Promise<LegacyAppModule>;
};
