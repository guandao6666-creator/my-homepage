/**
 * Guandao OS 2.2 · 旧版应用迁移的类型契约。
 *
 * 目标：让 `src/pages/index.astro` 里的旧版应用能搬到独立模块，
 * 条件是「明确依赖」而不是「依赖闭包里的自由变量」。
 *
 * 这里只声明迁移所需的**最小**能力集合；不要把它做成第二个 Ctx。
 * 完整的外壳能力仍在 `src/lib/os14/core.ts` 的 `Ctx` 里。
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
};

/** 交给 `registerApp` 的规格，字段与 index.astro 的 AppEntry 对齐 */
export type LegacyAppSpec = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph?: string;
  body: () => string;
  init?: (win: HTMLElement) => void | (() => void);
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
};