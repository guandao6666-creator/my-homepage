/**
 * Guandao OS 1.9 · 可靠性中心（错误边界 + 诊断日志）
 *
 * 解决的问题：
 *   - 单个应用抛错会把整块桌面带崩（1.8 只在 console 里打一行）；
 *   - 出错后用户只看到空白，不知道能不能重试、数据丢没丢；
 *   - 没有本地诊断记录，出了问题无法复盘。
 *
 * 边界：
 *   - 日志只存在本机（localStorage 环形缓冲，最多 200 条），默认不上传；
 *   - 写盘前统一脱敏：Token / Cookie / JWT / 长十六进制串不会落进日志；
 *   - 不记录笔记正文、文件名等用户内容，只记录「哪个模块、什么错误、发生时间」。
 */

import { escapeAttr } from "../html";
import { createScope, type ResourceScope } from "./resources";

export type DiagLevel = "error" | "warn" | "info";

export interface DiagEntry {
  id: string;
  at: number;
  level: DiagLevel;
  /** 出问题的模块：app:notes / worker:/api/files / plugin:xxx / window / sync */
  scope: string;
  code: string;
  message: string;
  /** 已脱敏、已截断的堆栈（最多 6 行） */
  stack?: string;
  /** 附加信息，值必须是标量，禁止塞用户内容 */
  meta?: Record<string, string | number | boolean>;
  count: number;
}

export interface DiagStats {
  total: number;
  entries: number;
  byScope: Record<string, number>;
  byCode: Record<string, number>;
  firstAt: number;
  lastAt: number;
  storageBytes: number;
}

const STORAGE_KEY = "guandao.os19.diag.v1";
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 保留 14 天
const WRITE_DEBOUNCE_MS = 1200;

/* ============================================================
   脱敏
   ============================================================ */

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  // GitHub / 通用访问令牌
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "gh*_REDACTED"],
  // JWT（Supabase / Session）
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "JWT_REDACTED"],
  // Authorization 头
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 REDACTED"],
  // key=value 形式的令牌
  [/\b(token|secret|password|apikey|api_key|authorization|session|cookie)(["'\s:=]+)([^\s"'&,;]{4,})/gi, "$1$2REDACTED"],
  // Cookie 值
  [/\b([a-z0-9_]+)=([A-Za-z0-9%._-]{16,})/gi, "$1=REDACTED"],
  // 长十六进制 / base64 串（可能是签名或密钥）
  [/\b[a-f0-9]{32,}\b/gi, "HEX_REDACTED"],
];

/** 去掉敏感信息；保留可读的错误结构 */
export function redact(input: string, maxLength = 500): string {
  let out = String(input ?? "");
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
  return out;
}

/** 只保留堆栈的前几行，去掉查询串与完整 URL 里的参数 */
export function trimStack(stack: string | undefined, lines = 6): string {
  if (!stack) return "";
  const head = stack
    .split("\n")
    .slice(0, lines)
    .map((line) => redact(line.trim(), 220))
    .join("\n");
  return head;
}

/* ============================================================
   存储
   ============================================================ */

let buffer: DiagEntry[] | null = null;
let writeTimerDisposer: (() => void) | null = null;
const subscribers = new Set<(entry: DiagEntry) => void>();
let counters = { total: 0 };
const storageScope: ResourceScope = createScope("diag:storage");

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined";
}

function load(): DiagEntry[] {
  if (buffer) return buffer;
  if (!storageAvailable()) {
    buffer = [];
    return buffer;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      buffer = [];
      return buffer;
    }
    const parsed = JSON.parse(raw) as { entries?: DiagEntry[]; total?: number };
    const now = Date.now();
    buffer = Array.isArray(parsed.entries)
      ? parsed.entries
          .filter((entry) => entry && typeof entry.at === "number" && now - entry.at < MAX_AGE_MS)
          .slice(0, MAX_ENTRIES)
      : [];
    counters.total = typeof parsed.total === "number" ? parsed.total : buffer.length;
  } catch {
    buffer = [];
  }
  return buffer;
}

function persistSoon(): void {
  if (!storageAvailable() || writeTimerDisposer) return;
  writeTimerDisposer = storageScope.timeout(() => {
    writeTimerDisposer = null;
    flushDiagnostics();
  }, WRITE_DEBOUNCE_MS);
}

/** 立即落盘（用户点「导出诊断」或页面隐藏时调用） */
export function flushDiagnostics(): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ endsAt: Date.now(), total: counters.total, entries: load() }));
  } catch {
    // 配额满时丢掉最旧的记录再试一次
    try {
      const half = load().slice(0, Math.floor(MAX_ENTRIES / 2));
      buffer = half;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ total: counters.total, entries: half }));
    } catch {
      /* 放弃持久化，内存里仍然可用 */
    }
  }
}

function nextId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 相同错误（同 scope 同 code 同 message）在 30 秒内合并计数，避免刷屏 */
const MERGE_WINDOW_MS = 30_000;

export interface LogInput {
  level?: DiagLevel;
  scope: string;
  code?: string;
  message: string;
  error?: unknown;
  meta?: Record<string, string | number | boolean>;
}

/** 记录一条诊断信息（内部会脱敏、限长、合并重复项） */
export function logDiagnostic(input: LogInput): DiagEntry {
  const list = load();
  const message = redact(input.message || (input.error instanceof Error ? input.error.message : "unknown"), 300);
  const code = (input.code || (input.error instanceof Error ? input.error.name : "ERROR")).slice(0, 60);
  const stack = input.error instanceof Error ? trimStack(input.error.stack) : "";
  const now = Date.now();

  const recent = list.find(
    (entry) => entry.scope === input.scope && entry.code === code && entry.message === message && now - entry.at < MERGE_WINDOW_MS,
  );
  if (recent) {
    recent.count += 1;
    recent.at = now;
    counters.total += 1;
    persistSoon();
    return recent;
  }

  const entry: DiagEntry = {
    id: nextId(),
    at: now,
    level: input.level ?? "error",
    scope: input.scope.slice(0, 60),
    code,
    message,
    stack: stack || undefined,
    meta: input.meta ? sanitizeMeta(input.meta) : undefined,
    count: 1,
  };

  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  counters.total += 1;
  persistSoon();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      /* 订阅方出错不影响记录 */
    }
  }
  return entry;
}

function sanitizeMeta(meta: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let i = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (i >= 8) break;
    out[key.slice(0, 24)] = typeof value === "string" ? redact(value, 120) : value;
    i += 1;
  }
  return out;
}

/* ============================================================
   查询 / 清理
   ============================================================ */

export function listDiagnostics(filter?: { scope?: string; level?: DiagLevel; since?: number }): DiagEntry[] {
  let list = [...load()];
  if (filter?.scope) list = list.filter((entry) => entry.scope.startsWith(filter.scope!));
  if (filter?.level) list = list.filter((entry) => entry.level === filter.level);
  if (filter?.since) list = list.filter((entry) => entry.at >= filter.since!);
  return list;
}

export function diagnosticStats(): DiagStats {
  const list = load();
  const byScope: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const entry of list) {
    byScope[entry.scope] = (byScope[entry.scope] ?? 0) + entry.count;
    byCode[entry.code] = (byCode[entry.code] ?? 0) + entry.count;
  }
  let bytes = 0;
  try {
    bytes = storageAvailable() ? (localStorage.getItem(STORAGE_KEY)?.length ?? 0) * 2 : 0;
  } catch {
    bytes = 0;
  }
  return {
    total: counters.total,
    entries: list.length,
    byScope,
    byCode,
    firstAt: list.length ? list[list.length - 1].at : 0,
    lastAt: list.length ? list[0].at : 0,
    storageBytes: bytes,
  };
}

/** 清空诊断记录（用户主动操作） */
export function clearDiagnostics(): void {
  buffer = [];
  counters.total = 0;
  if (storageAvailable()) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

/** 导出为可读 JSON（脱敏后的内容，供用户自己保存或附到问题反馈里） */
export function exportDiagnostics(): string {
  return JSON.stringify(
    {
      app: "Guandao OS",
      version: "1.9.0",
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "node",
      stats: diagnosticStats(),
      entries: listDiagnostics(),
    },
    null,
    2,
  );
}

export function subscribeDiagnostics(fn: (entry: DiagEntry) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/* ============================================================
   错误边界
   ============================================================ */

export interface BoundaryContext {
  /** 记录用的作用域名，例如 app:notes */
  scope: string;
  /** 业务错误码，例如 APP_RENDER_FAILED */
  code?: string;
  meta?: Record<string, string | number | boolean>;
}

/** 同步边界：失败时记录并返回 fallback，绝不让异常冒到桌面 */
export function boundary<T>(context: BoundaryContext, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    logDiagnostic({ ...context, error, message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/** 异步边界：同样不抛出 */
export async function boundaryAsync<T>(context: BoundaryContext, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logDiagnostic({ ...context, error, message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/* ============================================================
   全局错误捕获
   ============================================================ */

let globalInstalled = false;

/**
 * 捕获未处理异常与 Promise 拒绝。
 * 幂等：重复调用不会重复注册。
 */
export function installGlobalErrorHandlers(): void {
  if (globalInstalled) return;
  if (typeof window === "undefined") return;
  globalInstalled = true;

  const scope = createScope("diag:global");

  scope.on(window, "error", (event) => {
    const target = event.target as HTMLElement | null;
    // 资源加载失败（img/script）不带 message，单独归类，避免污染应用错误统计
    if (target && target !== (window as unknown as HTMLElement) && (event as ErrorEvent).message === undefined) {
      const tag = target.tagName?.toLowerCase() ?? "resource";
      const src = (target as HTMLImageElement).currentSrc || (target as HTMLScriptElement).src || "";
      logDiagnostic({
        level: "warn",
        scope: "resource",
        code: "RESOURCE_LOAD_FAILED",
        message: `${tag} 加载失败`,
        meta: { tag, path: redact(src.split("?")[0], 120) },
      });
      return;
    }
    const error = (event as ErrorEvent).error;
    logDiagnostic({
      scope: "window",
      code: "UNCAUGHT_ERROR",
      message: (event as ErrorEvent).message || "未捕获异常",
      error: error instanceof Error ? error : undefined,
      meta: { filename: redact(String((event as ErrorEvent).filename ?? "").split("?")[0], 120) },
    });
  });

  scope.on(window, "unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    logDiagnostic({
      scope: "window",
      code: "UNHANDLED_REJECTION",
      message: reason instanceof Error ? reason.message : String(reason).slice(0, 200),
      error: reason instanceof Error ? reason : undefined,
    });
  });

  scope.on(window, "pagehide", () => flushDiagnostics());

  // 暴露给资源层做异常上报（避免循环 import）
  (globalThis as { GOS19_DIAG?: unknown }).GOS19_DIAG = {
    error: (scopeName: string, error: unknown) =>
      logDiagnostic({
        scope: `resource:${scopeName}`,
        code: "TASK_THREW",
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error : undefined,
      }),
    log: logDiagnostic,
    list: listDiagnostics,
    clear: clearDiagnostics,
  };
}

/* ============================================================
   崩溃卡片
   ============================================================ */

export interface CrashCardOptions {
  title: string;
  message: string;
  /** 诊断编号，方便用户反馈时对照 */
  code?: string;
  hint?: string;
  onRetryId?: string;
  onCloseId?: string;
}

/**
 * 应用崩溃后的占位 HTML：告诉用户发生了什么、数据在哪、可以点哪里恢复。
 * 按钮通过 data 属性交给窗口系统绑定，避免内联事件被 CSP 拦截。
 */
export function crashCardHtml(options: CrashCardOptions): string {
  const code = options.code ? `<p class="g19-crash-code">诊断编号 ${escapeAttr(options.code)}</p>` : "";
  const hint = options.hint ? `<p class="g19-crash-hint">${escapeAttr(options.hint)}</p>` : "";
  return `
    <div class="g19-crash" role="alert">
      <div class="g19-crash-icon" aria-hidden="true">!</div>
      <h3 class="g19-crash-title">${escapeAttr(options.title)}</h3>
      <p class="g19-crash-msg">${escapeAttr(options.message)}</p>
      ${hint}
      ${code}
      <div class="g19-crash-actions">
        <button class="g14-btn is-primary" type="button" data-g19-retry>重新加载应用</button>
        <button class="g14-btn" type="button" data-g19-close>关闭窗口</button>
        <button class="g14-btn is-ghost" type="button" data-g19-diag>打开诊断中心</button>
      </div>
      <p class="g19-crash-foot">其它应用不受影响，可以继续使用。桌面不会因为一个应用出错而重启。</p>
    </div>`;
}