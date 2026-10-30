import { getCollection, type CollectionEntry } from "astro:content";
import { readingTime } from "./site";

export type BlogEntry = CollectionEntry<"blog">;

export interface Post {
  slug: string;
  title: string;
  description: string;
  pubDate: Date;
  updatedDate?: Date;
  tags: string[];
  featured: boolean;
  cover?: string;
  minutes: number;
}

/** 统一的 slug 处理：兼容 "a.md" / "a" / "tech/a" */
export function slugOf(entry: BlogEntry): string {
  return entry.id
    .replace(/\\/g, "/")
    .replace(/\.mdx?$/, "")
    .replace(/^\/+/, "");
}

export function toPost(entry: BlogEntry): Post {
  return {
    slug: slugOf(entry),
    title: entry.data.title,
    description: entry.data.description,
    pubDate: entry.data.pubDate,
    updatedDate: entry.data.updatedDate,
    tags: entry.data.tags,
    featured: entry.data.featured,
    cover: entry.data.cover,
    minutes: readingTime(entry.body ?? entry.data.description),
  };
}

/** 所有已发布文章，按时间倒序 */
export async function getAllPosts(): Promise<Post[]> {
  const entries = await getCollection("blog", ({ data }) =>
    import.meta.env.PROD ? data.draft !== true : true,
  );
  return entries
    .map(toPost)
    .sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
}

export async function getAllEntries(): Promise<BlogEntry[]> {
  return getCollection("blog");
}

export interface TagStat {
  tag: string;
  count: number;
  latest: Date;
}

export function collectTags(posts: Post[]): TagStat[] {
  const map = new Map<string, TagStat>();
  for (const post of posts) {
    for (const tag of post.tags) {
      const current = map.get(tag);
      if (current) {
        current.count += 1;
        if (post.pubDate > current.latest) current.latest = post.pubDate;
      } else {
        map.set(tag, { tag, count: 1, latest: post.pubDate });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function postsWithTag(posts: Post[], tag: string): Post[] {
  return posts.filter((post) => post.tags.includes(tag));
}

/** 相邻文章（用于上一篇/下一篇） */
export function neighbours(posts: Post[], slug: string) {
  const index = posts.findIndex((post) => post.slug === slug);
  return {
    prev: index < posts.length - 1 ? posts[index + 1] : undefined,
    next: index > 0 ? posts[index - 1] : undefined,
  };
}

/** 同标签的相关文章 */
export function relatedPosts(posts: Post[], current: Post, limit = 3): Post[] {
  return posts
    .filter((post) => post.slug !== current.slug)
    .map((post) => ({
      post,
      score: post.tags.filter((tag) => current.tags.includes(tag)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.post.pubDate.valueOf() - a.post.pubDate.valueOf())
    .slice(0, limit)
    .map((item) => item.post);
}

/** 为每个标签生成稳定的强调色（无图片封面时使用） */
const TAG_HUES: Record<string, number> = {
  技术: 148,
  前端: 172,
  后端: 205,
  Astro: 148,
  设计: 28,
  生活: 342,
  随笔: 12,
  效率: 262,
  阅读: 44,
  项目复盘: 190,
  部署: 216,
  数据库: 232,
};

export function tagHue(tag: string): number {
  if (TAG_HUES[tag] !== undefined) return TAG_HUES[tag];
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) % 360;
  }
  return hash;
}

export function coverGradient(post: Post): string {
  const hue = tagHue(post.tags[0] ?? "随笔");
  return `linear-gradient(135deg, hsl(${hue} 34% 88%) 0%, hsl(${(hue + 42) % 360} 30% 74%) 55%, hsl(${(hue + 80) % 360} 26% 42%) 100%)`;
}
