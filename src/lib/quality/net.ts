/**
 * Guandao OS 1.9 · 统一网络层
 *
 * 解决的问题：
 *   1. 全站 38 处 fetch 各写各的，没有超时、没有取消、没有重试、错误提示千篇一律；
 *   2. 401 / 403 / 404 / 409 / 429 / 500 / 超时 / 断网 在界面上都显示成「操作失败」；
 *   3. 有副作用的请求（创建、删除、支付、上传）被盲目重试，可能造成重复数据。
 *
 * 原则：
 *   - 只对幂等请求（GET/HEAD）自动重试；带副作用的请求必须显式声明 retryUnsafe 或用幂等键；
 *   - 指数退避 + 抖动，尊重服务端 Retry-After；
 *   - 每个请求都有超时；调用方可以传 signal 取消；
 *   - 错误分类后再交给 UI，用户能知道「发生了什么、数据存没存、要不要重试、要不要重新登录」。
 *
 * 本文件不依赖 DOM，可直接在 Node 里做单元测试。
 */

/* ============================================================
   错误分类
   ============================================================ */

export type NetErrorKind =
  | "offline" // 浏览器报告断网
  | "timeout" // 本地超时
  | "aborted" // 调用方主动取消
  | "unauthorized" // 401
  | "forbidden" // 403
  | "not_found" // 404
  | "conflict" // 409
  | "rate_limited" // 429
  | "server" // 5xx
  | "client" // 其它 4xx
  | "network" // 连接失败（DNS / TLS / CORS / 断流）
  | "parse" // 响应不是期望的 JSON
  | "unknown";

export class NetError extends Error {
  readonly kind: NetErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  readonly attempts: number;
  readonly url: string;
  readonly requestId: string;
  /** 服务端返回的业务错误体（已截断），便于诊断中心记录 */
  readonly body: string;

  constructor(init: {
    kind: NetErrorKind;
    message: string;
    status?: number;
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    attempts?: number;
    url?: string;
    requestId?: string;
    body?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "NetError";
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? init.kind.toUpperCase();
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs ?? 0;
    this.attempts = init.attempts ?? 1;
    this.url = init.url ?? "";
    this.requestId = init.requestId ?? "";
    this.body = init.body ?? "";
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/** HTTP 状态码 → 语义分类 */
export function classifyStatus(status: number): NetErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "unknown";
}

/** 这些状态码值得重试：服务端临时问题或限流，重试通常有效 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isIdempotent(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/* ============================================================
   退避策略
   ============================================================ */

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** 抖动比例 0–0.5，默认 0.2，避免同一时刻大量客户端同时重试 */
  jitter?: number;
  /** 随机源，测试时可注入固定值 */
  random?: () => number;
}

/**
 * 第 n 次重试（n 从 1 开始）的等待时间。
 * 300ms → 600 → 1200 → 2400 … 上限 cap。
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 300;
  const cap = options.capMs ?? 8000;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * factor));
}

/** 解析 Retry-After：支持秒数或 HTTP 日期，无法解析返回 0 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(60_000, Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return 0;
  return Math.max(0, Math.min(60_000, date - now));
}

/* ============================================================
   请求
   ============================================================ */

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** 请求体：普通对象会按 JSON 序列化 */
  body?: unknown;
  /** 超时（毫秒），默认 12s；上传类请求建议显式加大 */
  timeoutMs?: number;
  /** 最大重试次数（不含首次）。默认：幂等请求 2 次，其它 0 次 */
  retries?: number;
  /**
   * 带副作用的请求是否允许重试。
   * 只有确实幂等（例如服务端按 Idempotency-Key 去重）时才应设为 true。
   */
  retryUnsafe?: boolean;
  /** 幂等键：同一个键重复提交，服务端应返回同一结果 */
  idempotencyKey?: string;
  /** 解析方式，默认 json；传 "text" / "blob" 可拿原始响应 */
  parse?: "json" | "text" | "blob" | "none";
  /** 断网时不抛错，直接返回 fallback（用于后台轮询类请求） */
  offlineFallback?: unknown;
  signal?: AbortSignal;
}

export interface RequestResult<T> {
  data: T;
  status: number;
  headers: Headers;
  attempts: number;
  durationMs: number;
}

function currentOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

function makeIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 创建带超时的 fetch；外部 signal 与超时信号合并 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit & { timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const external = init.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, init.timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new NetError({
        kind: "timeout",
        message: `请求超时（${init.timeoutMs} ms）`,
        retryable: true,
        url: input,
        cause: error,
      });
    }
    if (external?.aborted) {
      throw new NetError({ kind: "aborted", message: "请求已取消", retryable: false, url: input, cause: error });
    }
    if (!currentOnline()) {
      throw new NetError({
        kind: "offline",
        message: "当前处于离线状态",
        retryable: true,
        url: input,
        cause: error,
      });
    }
    throw new NetError({
      kind: "network",
      message: error instanceof Error ? error.message : "网络连接失败",
      retryable: true,
      url: input,
      cause: error,
    });
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 发起请求：超时、重试、错误分类、幂等键、取消，全部在这里统一处理。
 * 失败时抛出 NetError（调用方只需要决定怎么提示）。
 */
export async function request<T = unknown>(url: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const idempotent = isIdempotent(method);
  const allowRetry = idempotent || options.retryUnsafe === true;
  const maxRetries = allowRetry ? Math.max(0, options.retries ?? (idempotent ? 2 : 1)) : 0;
  const parse = options.parse ?? "json";

  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData || options.body instanceof Blob || typeof options.body === "string") {
      body = options.body as BodyInit;
      if (typeof options.body === "string" && !headers.has("content-type")) {
        headers.set("content-type", "text/plain;charset=UTF-8");
      }
    } else {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
  }

  // 幂等键：有副作用的请求默认带上，重复提交时服务端可识别
  if (!idempotent && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", options.idempotencyKey || makeIdempotencyKey());
  }

  const startedAt = Date.now();
  let lastError: NetError | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method,
        headers,
        body,
        credentials: options.credentials ?? "same-origin",
        cache: options.cache,
        redirect: options.redirect,
        referrerPolicy: options.referrerPolicy,
        mode: options.mode,
        timeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      const netError =
        error instanceof NetError
          ? error
          : new NetError({ kind: "network", message: "网络请求失败", retryable: true, url, cause: error });
      lastError = new NetError({
        kind: netError.kind,
        message: netError.message,
        status: netError.status,
        retryable: netError.retryable,
        attempts: attempt,
        url,
        cause: netError.cause,
      });
      // 主动取消 / 断网（离线时不反复重试，交给联网事件）
      if (netError.kind === "aborted" || netError.kind === "offline") throw lastError;
      if (attempt <= maxRetries && netError.retryable) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      const kind = classifyStatus(response.status);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const error = new NetError({
        kind,
        message: errorMessageFor(kind, response.status, text),
        status: response.status,
        code: extractCode(text) || kind.toUpperCase(),
        retryable: isRetryableStatus(response.status),
        retryAfterMs: retryAfter,
        attempts: attempt,
        url,
        requestId: response.headers.get("x-request-id") ?? "",
        body: text.slice(0, 400),
      });
      lastError = error;
      if (kind === "unauthorized") throw error; // 鉴权失败重试没有意义
      if (attempt <= maxRetries && error.retryable) {
        await sleep(retryAfter > 0 ? retryAfter : backoffDelay(attempt));
        continue;
      }
      throw error;
    }

    // 204 / HEAD 没有响应体
    if (response.status === 204 || method === "HEAD" || parse === "none") {
      return { data: undefined as T, status: response.status, headers: response.headers, attempts: attempt, durationMs: Date.now() - startedAt };
    }

    if (parse === "blob") {
      return {
        data: (await response.blob()) as unknown as T,
        status: response.status,
        headers: response.headers,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    }

    if (parse === "text") {
      return {
        data: (await response.text()) as unknown as T,
        status: response.status,
        headers: response.headers,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    }

    const text = await safeReadText(response);
    if (!text) {
      return { data: undefined as T, status: response.status, headers: response.headers, attempts: attempt, durationMs: Date.now() - startedAt };
    }
    try {
      return {
        data: JSON.parse(text) as T,
        status: response.status,
        headers: response.headers,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw new NetError({
        kind: "parse",
        message: "服务端返回的内容不是合法 JSON",
        status: response.status,
        attempts: attempt,
        url,
        body: text.slice(0, 200),
        cause: error,
      });
    }
  }

  throw lastError ?? new NetError({ kind: "unknown", message: "请求失败", url });
}

/** 便捷封装：只关心数据 */
export async function requestData<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const result = await request<T>(url, options);
  return result.data;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** 从后端错误体里提取业务错误码（本项目后端返回 { error: { code, message } } 或 { code }） */
export function extractCode(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { code?: string; error?: { code?: string } };
    return parsed.error?.code ?? parsed.code ?? "";
  } catch {
    return "";
  }
}

function errorMessageFor(kind: NetErrorKind, status: number, body: string): string {
  const serverMessage = extractMessage(body);
  switch (kind) {
    case "unauthorized":
      return serverMessage || "登录状态已失效，请重新登录";
    case "forbidden":
      return serverMessage || "没有权限执行这个操作";
    case "not_found":
      return serverMessage || "目标不存在，可能已被删除";
    case "conflict":
      return serverMessage || "数据版本冲突，需要先合并";
    case "rate_limited":
      return serverMessage || "请求过于频繁，请稍后再试";
    case "server":
      return serverMessage || `服务端异常（${status}）`;
    default:
      return serverMessage || `请求失败（${status}）`;
  }
}

function extractMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: { message?: string }; msg?: string };
    return (parsed.error?.message ?? parsed.message ?? parsed.msg ?? "").slice(0, 200);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ============================================================
   用户可读的错误说明
   ============================================================ */

export interface ErrorExplanation {
  title: string;
  message: string;
  /** 是否能安全重试 */
  canRetry: boolean;
  /** 是否需要重新登录 */
  needsLogin: boolean;
  /** 是否存在数据冲突风险 */
  mayConflict: boolean;
  /** 数据是否已经保存（"yes" / "no" / "unknown"） */
  dataSaved: "yes" | "no" | "unknown";
  /** 建议动作 */
  action: "retry" | "login" | "wait" | "resolve-conflict" | "reload" | "none";
}

/** 把任意错误翻译成「发生了什么 / 数据是否保存 / 要不要重试」 */
export function explainError(error: unknown): ErrorExplanation {
  const net = error instanceof NetError ? error : null;
  const kind: NetErrorKind = net?.kind ?? "unknown";

  const base: ErrorExplanation = {
    title: "操作未完成",
    message: net?.message ?? (error instanceof Error ? error.message : "未知错误"),
    canRetry: false,
    needsLogin: false,
    mayConflict: false,
    dataSaved: "unknown",
    action: "retry",
  };

  switch (kind) {
    case "offline":
      return {
        ...base,
        title: "当前离线",
        message: "网络已断开，本地改动仍保留在这台设备上，联网后可以继续同步。",
        canRetry: true,
        dataSaved: "yes",
        action: "wait",
      };
    case "timeout":
      return {
        ...base,
        title: "请求超时",
        message: "服务端在限定时间内没有响应。数据可能已经写入，也可能没有；重试前建议先刷新列表确认。",
        canRetry: true,
        dataSaved: "unknown",
        action: "retry",
      };
    case "aborted":
      return { ...base, title: "请求已取消", message: "操作被取消，没有发出或已中断。", action: "none" };
    case "unauthorized":
      return {
        ...base,
        title: "需要重新登录",
        message: "登录状态已失效。本地数据没有丢失，重新登录后可以继续。",
        needsLogin: true,
        dataSaved: "yes",
        action: "login",
      };
    case "forbidden":
      return {
        ...base,
        title: "没有权限",
        message: "当前账号不允许执行这个操作。如果这是你自己的数据，可能是登录了另一个账号。",
        needsLogin: true,
        dataSaved: "no",
        action: "login",
      };
    case "not_found":
      return {
        ...base,
        title: "内容不存在",
        message: "要操作的记录或文件已经不存在，可能已被删除或在其它设备上移动。",
        dataSaved: "no",
        action: "reload",
      };
    case "conflict":
      return {
        ...base,
        title: "数据有冲突",
        message: "这份数据在别的设备上被改过。你的改动还在本地，可以对比后再合并。",
        mayConflict: true,
        dataSaved: "yes",
        action: "resolve-conflict",
      };
    case "rate_limited":
      return {
        ...base,
        title: "操作太频繁",
        message: "已经触发频率限制，请稍后再试。当前操作没有重复提交。",
        canRetry: true,
        dataSaved: "no",
        action: "wait",
      };
    case "server":
      return {
        ...base,
        title: "服务暂时不可用",
        message: "服务端正在处理异常，数据可能没有保存。可以稍后重试，或到诊断中心查看服务状态。",
        canRetry: true,
        dataSaved: "unknown",
        action: "retry",
      };
    case "network":
      return {
        ...base,
        title: "连接失败",
        message: "没能连上服务器，请检查网络后重试。本地改动没有丢失。",
        canRetry: true,
        dataSaved: "yes",
        action: "retry",
      };
    case "parse":
      return {
        ...base,
        title: "响应格式异常",
        message: "服务端返回的内容无法解析，通常说明中间有代理或网关改写。数据可能已保存。",
        canRetry: true,
        dataSaved: "unknown",
        action: "reload",
      };
    default:
      return {
        ...base,
        title: "操作未完成",
        message:
          base.message ||
          "发生了未分类的错误。可以重试一次；如果反复出现，请到诊断中心导出诊断记录。",
        canRetry: false,
        dataSaved: "unknown",
        action: "retry",
      };
  }
}