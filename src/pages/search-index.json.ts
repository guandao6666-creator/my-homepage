import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { slugOf } from "../lib/posts";

/**
 * 全站全文搜索索引。
 *
 * 构建期输出 /search-index.json，前端按需加载后做本地匹配——
 * 站点是纯静态托管的，没有后端可查；把正文压成纯文本一次性下发，
 * 换页和输入都不用再发请求。
 */

/** 把 Markdown 压成可检索的纯文本：去掉语法噪声，保留中文正文 */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/^\s*\|?[-: ]+\|[-: |]*$/gm, " ")
    .replace(/[*_~]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const GET: APIRoute = async () => {
  const entries = await getCollection("blog", ({ data }) => data.draft !== true);

  const items = entries.map((entry) => ({
    slug: slugOf(entry),
    title: entry.data.title,
    description: entry.data.description,
    tags: entry.data.tags,
    date: new Date(entry.data.pubDate).toISOString().slice(0, 10),
    body: plainText(entry.body ?? ""),
  }));

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return new Response(JSON.stringify(items), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
