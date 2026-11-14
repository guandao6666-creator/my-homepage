/**
 * Guandao OS 2.5 · 通知文案映射（批次 2 的第一个纯函数模块）。
 *
 * 从 src/lib/os14/community.ts 的 initCommunity 闭包里搬出。
 * 这两个函数本来就不读任何闭包状态，只是被定义在了闭包里；
 * 搬出来之后可以单独测试，行为完全不变。
 */
import type * as api from "../../community/api";

export const notificationTitle = (item: api.NotificationItem) => {
  switch (item.type) {
    case "comment": return "收到新评论";
    case "reply": return "收到回复";
    case "post_review": return "作品审核结果";
    case "post_update": return "关注的作品更新";
    case "follow": return "有新的关注者";
    case "moderation": return "社区管理通知";
    default: return "社区通知";
  }
};

export const notificationBody = (item: api.NotificationItem) => {
  const payload = item.payload || {};
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.excerpt === "string") return `${item.actor?.displayName || "社区成员"}：${payload.excerpt}`;
  if (typeof payload.title === "string") return payload.title;
  if (item.type === "follow") return `${item.actor?.displayName || "一位创作者"} 关注了你`;
  return "查看详情";
};
