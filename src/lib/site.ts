/**
 * 站点全局配置：改这里就能改整站文案与信息。
 */
export const SITE = {
  name: "管道的博客",
  author: "管道",
  handle: "guandao",
  role: "大连理工大学 · 学生",
  tagline: "记录好奇，持续创造。",
  description:
    "管道的个人博客 —— 大连理工大学学生，河南固始人。记录日常、学习与思考，也记录骑过的路。",
  url: "https://guandao.xin",
  locale: "zh-CN",
  email: "guandao6666@gmail.com",
  /** Supabase 里站长账号的 user id —— 留言标「站长」而不是「成员」 */
  ownerUserId: "52b489c6-3be5-4f29-8e49-4cb8020560de",
  startYear: 2024,
  nav: [
    { href: "/blog/", label: "文章" },
    { href: "/tags/", label: "标签" },
    { href: "/series/", label: "系列" },
    { href: "/about/", label: "关于" },
    { href: "/rss.xml", label: "RSS", external: true },
  ],
  socials: [
    { href: "https://github.com/", label: "GitHub", icon: "github" },
    { href: "mailto:guandao6666@gmail.com", label: "Email", icon: "mail" },
  ],
} as const;

export const POSTS_PER_PAGE = 8;

/** 每页文章数之外，首页展示的最新文章数量 */
export const HOME_LATEST = 4;

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function formatShortDate(date: Date): string {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

export function isoDate(date: Date): string {
  return new Date(date).toISOString();
}

/** 中文阅读时长：约 350 字/分钟 */
export function readingTime(text: string): number {
  const chars = text.replace(/\s+/g, "").length;
  const codeBlocks = (text.match(/```/g) || []).length / 2;
  const minutes = chars / 350 + codeBlocks * 0.6;
  return Math.max(1, Math.round(minutes));
}
