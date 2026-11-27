/**
 * 审核动作 × 作品状态的合法组合。
 *
 * 为什么要单独一张表：
 *   - 审核队列里「通过」按钮只在非 published 时出现，服务端如果只校验“非 published”，
 *     就会把作者主动撤回的 draft 重新公开（2.0.6 审计条目）。draft 是作者意志，
 *     审核员不能替作者做发布决定，必须让作者重新提交。
 *   - restore（恢复）只针对被隐藏的内容；rejected 的重新放行走 approve，
 *     两者分开能让文案和审计动作保持一致。
 */

export const APPROVE_STATUSES = ["pending_review", "rejected"];
export const RESTORE_STATUSES = ["hidden"];

const DRAFT_MESSAGE = "作者已撤回为草稿，需要作者重新提交审核";

/**
 * @param {string} action 审核动作（approve / restore / 其它）
 * @param {string} status
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkReviewTransition(action, status) {
  if (status === "deleted") return { ok: false, message: "作品已删除" };
  if (action === "approve") {
    if (APPROVE_STATUSES.includes(status)) return { ok: true };
    return { ok: false, message: status === "draft" ? DRAFT_MESSAGE : "当前状态不能通过审核" };
  }
  if (action === "restore") {
    if (RESTORE_STATUSES.includes(status)) return { ok: true };
    return { ok: false, message: status === "draft" ? DRAFT_MESSAGE : "只有已隐藏的作品可以恢复" };
  }
  return { ok: true };
}