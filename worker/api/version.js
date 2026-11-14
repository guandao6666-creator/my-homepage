/**
 * Guandao OS · 单一版本来源（Worker 侧）
 *
 * Worker 是纯 JS（不能用 TypeScript），所以版本号在这里再写一次；
 * `scripts/check-version.mjs` 会强制它和 package.json / src/lib/version.ts 一致，
 * 构建前跑一次就能发现漂移。
 */

export const WORKER_VERSION = "2.0.0";
export const RELEASE_NAME = "The Platform Era";

/** 供响应头使用：让任何一次线上响应都能对应到具体版本 */
export const VERSION_HEADER = "x-guandao-version";