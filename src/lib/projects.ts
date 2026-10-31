/**
 * 作品清单。
 *
 * 想加新作品就往数组里追加一条；href 留空时卡片只展示、不出链接。
 */

export interface Project {
  title: string;
  summary: string;
  tags: string[];
  year: number;
  /** 线上地址或仓库地址，留空则不出链接 */
  href?: string;
  /** 状态标签，例如「在线」「实验中」 */
  status?: string;
}

export const PROJECTS: Project[] = [
  {
    title: "管道的博客",
    summary:
      "你现在看的这个站。Astro 静态生成，内容存在 Supabase，Cloudflare 托管；评论、点赞、写作后台、分享图都是自己搭的。",
    tags: ["Astro", "TypeScript", "Supabase", "Cloudflare"],
    year: 2026,
    href: "https://guandao.xin",
    status: "在线",
  },
  {
    title: "AI 学习 Skill",
    summary:
      "给 Codex 写的一套学习用 Skill，覆盖多个学科，按「先讲清原理再给例子」的顺序组织回答，避免只丢结论。",
    tags: ["AI", "Prompt", "Skill"],
    year: 2026,
  },
];
