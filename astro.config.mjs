// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeEnhance from "./src/lib/rehype-enhance.mjs";
import { ogImageIntegration } from "./src/lib/og-image.mjs";

// https://astro.build/config
export default defineConfig({
  site: "https://guandao.xin",
  trailingSlash: "always",
  build: {
    inlineStylesheets: "auto",
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes("/admin"),
    }),
    ogImageIntegration(),
  ],
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark-dimmed",
      },
      defaultColor: false,
      wrap: false,
    },
    rehypePlugins: [
      rehypeSlug,
      [
        rehypeAutolinkHeadings,
        {
          behavior: "append",
          properties: { className: ["heading-anchor"], ariaHidden: "true", tabIndex: -1 },
          content: {
            type: "element",
            tagName: "span",
            properties: {},
            children: [{ type: "text", value: "#" }],
          },
        },
      ],
      // 必须放在最后：此时标题锚点已经生成，不会被误判成外链
      rehypeEnhance,
    ],
  },
});
