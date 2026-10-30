#!/usr/bin/env node
/**
 * 构建前把云端数据库里的文章同步为本地 Markdown。
 *
 * 为什么要镜像到本地？
 *   Astro 的内容集合在构建期完成 Markdown 渲染、代码高亮、目录抽取，
 *   把云端数据在构建前落地成本地文件，可以让"云端数据库 + 静态发布"两全：
 *   数据库是唯一事实来源，产物则是纯静态、可 CDN 托管的。
 *
 * 用法：
 *   npm run sync            # 强制同步（缺少环境变量会报错退出）
 *   node scripts/sync-content.mjs --soft   # 缺少环境变量时静默跳过（构建默认行为）
 *
 * 需要的环境变量：
 *   SUPABASE_URL / PUBLIC_SUPABASE_URL
 *   SUPABASE_ANON_KEY / PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_TABLE（默认 posts）
 */

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CONTENT_DIR = path.join(ROOT, "src", "content", "blog");
const MANIFEST = path.join(CONTENT_DIR, ".sync-manifest.json");
const SOFT = process.argv.includes("--soft");

const env = process.env;
const url = (env.SUPABASE_URL || env.PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const key = env.SUPABASE_ANON_KEY || env.PUBLIC_SUPABASE_ANON_KEY || "";
const table = env.SUPABASE_TABLE || env.PUBLIC_SUPABASE_TABLE || "posts";

const log = (...args) => console.log("[sync-content]", ...args);

function skip(reason) {
  if (SOFT) {
    log(`${reason}，跳过云端同步（继续使用本地 Markdown）。`);
    process.exit(0);
  }
  console.error(`[sync-content] ${reason}`);
  process.exit(1);
}

if (!url || !key) {
  skip("未配置 SUPABASE_URL / SUPABASE_ANON_KEY");
}

/* ------------------------------ helpers ------------------------------ */

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function toDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function slugify(input, fallback = "post") {
  const slug = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function frontmatter(post) {
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const lines = [
    "---",
    `title: ${yamlString(post.title)}`,
    `description: ${yamlString(post.description ?? "")}`,
    `pubDate: ${toDateOnly(post.pub_date)}`,
  ];
  if (post.updated_at) lines.push(`updatedDate: ${toDateOnly(post.updated_at)}`);
  lines.push(`tags: [${tags.map(yamlString).join(", ")}]`);
  if (post.featured) lines.push("featured: true");
  if (post.cover_url) lines.push(`cover: ${yamlString(post.cover_url)}`);
  lines.push("source: cloud");
  lines.push("---", "");
  return lines.join("\n");
}

async function readManifest() {
  try {
    const raw = await readFile(MANIFEST, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

async function existingFiles() {
  try {
    return await readdir(CONTENT_DIR);
  } catch {
    return [];
  }
}

/* ------------------------------- main -------------------------------- */

async function main() {
  const endpoint = `${url}/rest/v1/${table}?select=*&published=eq.true&order=pub_date.desc`;
  log(`拉取云端文章：${url}/rest/v1/${table}`);

  let res;
  try {
    res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    skip(`云端请求失败（${error.message}）`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    skip(`云端返回 ${res.status}：${detail.slice(0, 200)}`);
  }

  const posts = await res.json();
  if (!Array.isArray(posts)) skip("云端返回格式异常");

  await mkdir(CONTENT_DIR, { recursive: true });

  const previous = await readManifest();
  const files = await existingFiles();
  const written = [];
  let skipped = 0;

  for (const post of posts) {
    const slug = slugify(post.slug || post.title, `post-${String(post.id).slice(0, 8)}`);
    const filename = `${slug}.md`;
    const target = path.join(CONTENT_DIR, filename);

    // 保护手写文章：同名的本地文件（非云端同步产物）不覆盖
    if (existsSync(target) && !previous.includes(filename)) {
      const head = await readFile(target, "utf8").then((t) => t.slice(0, 400));
      if (!head.includes("source: cloud")) {
        log(`· 跳过 ${filename}（存在同名手写文章）`);
        skipped += 1;
        continue;
      }
    }

    const body = String(post.content ?? post.body ?? "").trim();
    const file = `${frontmatter(post)}${body}\n`;
    await writeFile(target, file, "utf8");
    written.push(filename);
  }

  // 删除上次同步产生、这次已不在云端的文件
  const stale = previous.filter((name) => !written.includes(name));
  for (const name of stale) {
    const target = path.join(CONTENT_DIR, name);
    if (existsSync(target)) {
      await unlink(target).catch(() => undefined);
      log(`· 移除已下线文章 ${name}`);
    }
  }

  await writeFile(MANIFEST, JSON.stringify({ syncedAt: new Date().toISOString(), files: written }, null, 2));

  log(`完成：写入 ${written.length} 篇，跳过 ${skipped} 篇，清理 ${stale.length} 篇。`);
  if (stale.length && files.length) log("提示：本地目录已更新，记得把变更提交到仓库。");
}

main().catch((error) => {
  console.error("[sync-content] 未预期的错误：", error);
  if (!SOFT) process.exit(1);
});
