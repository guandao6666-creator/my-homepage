/**
 * GET /api/health
 *
 * 只做连通性探测，不读写业务数据：
 * - D1：执行只读的 `SELECT 1 AS ok`；
 * - R2：仅检查 put/get/head/delete 四个方法是否存在，不执行任何 I/O。
 *
 * 安全约束：
 * - 不返回 Binding 对象本身，也不返回其可枚举属性；
 * - 不返回 SQL 错误原文、数据库名、bucket 名或任何凭据；
 * - 单元失败只影响本接口的状态码（200 / 503），不影响静态站点。
 */

import { json } from "./http.js";

const D1_TIMEOUT_MS = 2000;
const R2_REQUIRED_METHODS = ["put", "get", "head", "delete"];

/**
 * @param {{ DB?: D1Database, FILES?: R2Bucket }} env
 */
export async function healthHandler({ env }) {
  const startedAt = Date.now();

  const [d1, r2] = await Promise.all([checkD1(env), checkR2(env)]);
  const services = { d1: d1.status, r2: r2.status };
  const healthy = services.d1 === "connected" && services.r2 === "available";

  return json(
    {
      success: healthy,
      status: healthy ? "ok" : "degraded",
      services,
      details: { d1: d1.details, r2: r2.details },
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503 },
  );
}

async function checkD1(env) {
  const db = env?.DB;

  if (!db || typeof db.prepare !== "function") {
    return { status: "unconfigured", details: { reason: "binding_missing" } };
  }

  const startedAt = Date.now();
  try {
    const row = await withTimeout(db.prepare("SELECT 1 AS ok").first(), D1_TIMEOUT_MS);
    const value = row && typeof row === "object" ? row.ok : null;

    if (Number(value) !== 1) {
      console.error("[api/health] d1 returned unexpected result");
      return {
        status: "error",
        details: { latencyMs: Date.now() - startedAt, reason: "unexpected_result" },
      };
    }

    return { status: "connected", details: { latencyMs: Date.now() - startedAt } };
  } catch (error) {
    // 只记录类型与简短信息，完整异常留在服务端日志里。
    console.error("[api/health] d1 query failed:", describe(error));
    return {
      status: "error",
      details: {
        latencyMs: Date.now() - startedAt,
        reason: error?.name === "TimeoutError" ? "timeout" : "query_failed",
      },
    };
  }
}

function checkR2(env) {
  const bucket = env?.FILES;

  if (!bucket) {
    return { status: "unconfigured", details: { reason: "binding_missing" } };
  }

  /** @type {Record<string, boolean>} */
  const capabilities = {};
  const missing = [];

  for (const method of R2_REQUIRED_METHODS) {
    const present = typeof bucket[method] === "function";
    capabilities[method] = present;
    if (!present) missing.push(method);
  }

  if (missing.length > 0) {
    console.error("[api/health] r2 binding missing methods:", missing.join(","));
    return { status: "error", details: { capabilities, missing } };
  }

  return { status: "available", details: { capabilities } };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("d1 timeout");
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return "unknown error";
}
