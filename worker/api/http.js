/**
 * API 统一响应与错误处理。
 *
 * 设计约束（Guandao OS 1.5）：
 * 1. 所有响应固定 application/json; charset=utf-8，禁止回退到 HTML 错误页；
 * 2. 错误只暴露稳定错误码 + 面向用户的中文文案，内部异常仅写服务端日志；
 * 3. 一律 no-store，健康状态不允许被边缘缓存；
 * 4. 不设置 CORS 头：接口只服务同源页面，避免第三方站点探测后端。
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** 可安全返回给客户端的错误；message 必须是面向用户的文案，不能拼接内部信息。 */
export class ApiError extends Error {
  /**
   * @param {string} code 稳定错误码，例如 SERVICE_UNAVAILABLE
   * @param {string} message 已脱敏的用户文案
   * @param {number} status HTTP 状态码
   * @param {Record<string, unknown> | null} [details] 可选的**结构化**补充信息（只放错误码/枚举，不放凭据或包内容）
   */
  constructor(code, message, status = 500, details = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details && typeof details === "object" ? details : null;
  }
}

/**
 * 读取有上限的 JSON 请求体（1.9）。
 *
 * 只信任 content-length 是不够的：分块传输（chunked）时浏览器/脚本可以完全不带这个头，
 * 于是「上限」形同虚设，任何登录用户都能用超大 body 把 isolate 内存打满。
 * 这里按「先看声明长度，再按实际读取字节数复核」的顺序做双保险。
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
export async function readJsonLimited(request, maxBytes = 1_000_000) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `请求体超过限制（${Math.round(maxBytes / 1024)} KB）`, 413);
  }
  let text;
  try {
    text = await request.text();
  } catch {
    throw new ApiError("INVALID_BODY", "请求体读取失败", 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `请求体超过限制（${Math.round(maxBytes / 1024)} KB）`, 413);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON", "请求格式不是有效的 JSON", 400);
  }
}

/**
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 */
export function json(body, options = {}) {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

/**
 * 统一成功信封：{ success: true, data: {...} }
 * @param {unknown} data
 * @param {{ status?: number, headers?: Record<string, string> }} [options]
 */
export function ok(data, options = {}) {
  return json({ success: true, data }, options);
}

/**
 * 统一失败信封：{ success: false, error: { code, message }, requestId }
 * @param {ApiError} error
 * @param {{ requestId?: string, headers?: Record<string, string> }} [options]
 */
export function fail(error, options = {}) {
  /** @type {Record<string, unknown>} */
  const body = {
    success: false,
    error: { code: error.code, message: error.message },
  };
  // 结构化补充信息：只允许调用方显式给出的枚举/错误码，避免把内部状态透出去。
  if (error.details) body.error.details = error.details;
  if (options.requestId) body.requestId = options.requestId;

  const headers = { ...(options.headers ?? {}) };
  if (options.requestId) headers["x-request-id"] = options.requestId;
  return json(body, { status: error.status, headers });
}

/** 非 ApiError 一律折叠为 500，避免异常细节外泄。 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError("INTERNAL_ERROR", "服务内部错误", 500);
}
