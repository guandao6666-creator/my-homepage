---
title: "用内容层给博客做减法：Astro 的内容集合到底解决了什么"
description: "从「每个页面自己读文件」到「一张统一的类型化内容图谱」，聊聊 Astro 内容集合的真实收益与踩坑点。"
pubDate: 2026-10-20
tags: ["Astro", "前端", "架构"]
featured: true
---

最早写博客时，我的页面里到处是这种代码：

```js
const files = fs.readdirSync("posts");
const posts = files.map((file) => {
  const raw = fs.readFileSync(`posts/${file}`, "utf8");
  return { slug: file.replace(".md", ""), raw };
});
```

能用，但每加一个页面（标签页、RSS、搜索），我就要把这套逻辑复制一遍，并且每个副本对"什么是文章"的理解都可能略有不同。

Astro 的内容集合（Content Collections）解决的正是这个问题：**它把"内容"从"页面"里抽出来，变成一份带类型的、全站共享的数据源。**

## 一个 schema 顶十处 if 判断

内容集合的核心是一个 schema 文件：

```ts
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});
```

带来的连锁好处比想象中大：

- 字段缺失或类型错误会在**构建时**报错，而不是在页面上渲染出一个 `undefined`；
- `pubDate` 一定是 `Date` 对象，不用在每个页面里 `new Date(post.data.pubDate)`；
- 默认值让 `tags` 永远不会是 `undefined`，省掉了到处写 `?? []`。

## 页面开始变薄

有了统一数据源，页面就退化成纯展示逻辑：

```astro
---
const posts = (await getCollection("blog"))
  .filter((p) => import.meta.env.PROD ? !p.data.draft : true)
  .sort((a, b) => b.data.pubDate - a.data.pubDate);
---
```

标签统计、相关文章、上一篇下一篇、RSS，全部从同一个数组派生。**没有第二份真相。**

## 动态路由与静态生成

文章详情页用 `getStaticPaths` 在构建期枚举所有 slug：

```astro
export async function getStaticPaths() {
  const entries = await getCollection("blog");
  return entries.map((entry) => ({
    params: { slug: entry.id.replace(/\.md$/, "") },
    props: { entry },
  }));
}
```

每个 slug 都会产出一个独立的 HTML 文件。这意味着：

| 方案 | 首屏 | 部署 | 增量更新 |
| --- | --- | --- | --- |
| 客户端拉数据渲染 | 需要等待 JS | 简单 | 即时 |
| 构建期静态生成 | 直接可用 | 需要重新构建 | 需触发构建 |

个人博客的内容量小、更新不频繁，第二列的劣势基本可以忽略，而第一列的优势是实打实的。

## 几个真实的坑

1. **`id` 和 slug 不是一回事**。用 glob loader 时 `id` 可能带扩展名，统一处理一次比在每个页面 patch 更安全。
2. **`render()` 是异步的**。忘了 `await` 会得到一个 Promise 而不是组件。
3. **构建期过滤草稿**。开发时想看草稿、线上不想暴露，用 `import.meta.env.PROD` 分支，别用两个文件。

内容集合不神奇，它只是把"内容"这件事**收进了一个地方**。而对个人项目来说，能少一处重复，就多活一年。
