import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * 文章集合。
 *
 * 数据可以来自两个地方：
 * 1. 本地 Markdown（src/content/blog/*.md）—— 默认，开箱即用；
 * 2. 云端数据库（Supabase）—— 通过 `npm run sync` 在构建前同步为本地 Markdown，
 *    数据库始终是唯一事实来源。详见 scripts/sync-content.mjs 与 README。
 */
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(120),
    description: z.string().max(300),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    /** 置顶/推荐 */
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    /** 封面在云存储中的地址；留空则使用自动生成的渐变封面 */
    cover: z.string().optional(),
    lang: z.string().default("zh"),
    source: z.enum(["local", "cloud"]).default("local"),
  }),
});

export const collections = { blog };
