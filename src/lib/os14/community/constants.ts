/**
 * Guandao OS 2.5 · 社区模块常量表与 localStorage key。
 *
 * 从 src/lib/os14/community.ts 原样搬出，纯数据、无运行时依赖。
 */

export const TYPE_LABEL: Record<string, string> = {
  theme: "主题",
  widget: "组件",
  workspace: "工作空间",
  wallpaper: "壁纸",
  tutorial: "教程",
};

export const TYPE_GLYPH: Record<string, string> = {
  theme: "◑",
  widget: "▦",
  workspace: "▤",
  wallpaper: "▧",
  tutorial: "✎",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_review: "待审核",
  published: "已发布",
  hidden: "已隐藏",
  rejected: "未通过",
  deleted: "已删除",
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  moderator: "审核员",
  member: "创作者",
  visitor: "访客",
};

export const REASON_LABEL: Record<string, string> = {
  copyright: "侵权内容",
  malicious: "恶意资源",
  inappropriate: "不适当内容",
  spam: "垃圾广告",
  impersonation: "冒充他人",
  harassment: "恶意评论 / 骚扰",
  other: "其他违规",
};

export const SEARCH_SORTS = [
  ["latest", "最新发布"],
  ["popular", "最受欢迎"],
  ["downloads", "安装最多"],
  ["favorites", "收藏最多"],
  ["updated", "最近更新"],
];

export const LAYOUT_KEY = "guandao.community.layout.v1";
export const VIEW_KEY = "guandao.community.seen.v1";
