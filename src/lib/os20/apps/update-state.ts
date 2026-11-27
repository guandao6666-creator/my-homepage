/**
 * 2.0.8 · 更新中心的「能不能点」判定
 *
 * 旧实现只看「旧 server 的版本号比当前新」就允许点击，检查失败/离线时 server 没被清掉，
 * 于是按钮看起来可点，点下去却仍然加载旧资源 —— 用户会以为更新坏了。
 * 把 phase 也纳入判定，并把失败时清空 server 的行为钉在源码约束里。
 */
export type UpdatePhase = "idle" | "checking" | "ready" | "offline" | "failed";

export interface UpdateServerLike {
  version: string;
}

/**
 * 只有「本轮检查成功（ready）且服务端确实更新」时才允许应用更新。
 * comparison 由 compareVersions(server.version, OS_VERSION) 得到，1 表示服务端更新。
 */
export function canApplyUpdate(
  phase: UpdatePhase,
  server: UpdateServerLike | null,
  comparison: number | null,
): boolean {
  if (phase !== "ready") return false;
  if (!server) return false;
  return comparison === 1;
}