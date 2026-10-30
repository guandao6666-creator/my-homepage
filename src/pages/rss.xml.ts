import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getAllPosts } from "../lib/posts";
import { SITE } from "../lib/site";

export async function GET(context: APIContext) {
  const posts = await getAllPosts();

  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? SITE.url,
    trailingSlash: true,
    items: posts.map((post) => ({
      title: post.title,
      pubDate: post.pubDate,
      description: post.description,
      link: `/blog/${post.slug}/`,
      categories: post.tags,
      author: SITE.email,
    })),
    customData: `<language>zh-CN</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
  });
}
