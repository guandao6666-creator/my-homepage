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
  vite: {
    define: {
      // 2.0：构建时间与构建号在编译时注入（更新中心展示真实构建信息，不伪造）
      __GUANDAO_BUILD_AT__: JSON.stringify(new Date().toISOString()),
      __GUANDAO_BUILD_ID__: JSON.stringify(
        `${Date.now().toString(36)}-${process.env.GITHUB_SHA?.slice(0, 7) ?? "local"}`,
      ),
    },
    build: {
      // 降到 es2019：Safari 13 和部分国产浏览器解析不了 ??= 这类 ES2021 语法，
      // 一旦解析失败整段脚本都不执行，页面会永远停在「正在加载」。
      target: "es2019",
    },
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
