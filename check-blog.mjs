import { getCollection } from "astro:content";

const posts = await getCollection("blog");
console.log("识别到的文章数量：", posts.length);
console.log("文章 ID：", posts.map((post) => post.id));
