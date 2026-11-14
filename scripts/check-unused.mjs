#!/usr/bin/env node
/**
 * 直接依赖体检（Guandao OS 2.0 · Phase 1）。
 *
 * 只回答一个问题：package.json 里的直接依赖，是否在源码/配置里真的被引用？
 * 不做「传递依赖」分析，也不判断运行时是否被 CLI 使用（那类工具放白名单）。
 *
 * 用法：node scripts/check-unused.mjs
 * 退出码：0 = 无未使用；1 = 存在未使用直接依赖。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

/** 通过 CLI / 配置文件名使用、没有 import 语句的工具。 */
const TOOLING = new Set([
  "@playwright/test",
  "@astrojs/check",
  "eslint",
  "eslint-plugin-astro",
  "globals",
  "typescript",
  "typescript-eslint",
  "vitest",
  "wrangler",
  // Astro 7 在配置 markdown.rehypePlugins 时会显式加载它；
  // 移除后 `astro check` / build 直接报错，因此必须保留（Phase 1 实测）。
  "@astrojs/markdown-remark",
]);

const SKIPDIRS = new Set(["node_modules", "dist", ".git", ".astro", ".wrangler", "test-results", ".shots", "audit", "docs"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".astro", ".js", ".mjs", ".cjs", ".json"]);
const EXTRA_FILES = ["astro.config.mjs", "playwright.config.ts", "vitest.config.ts"];

const files = [];
for (const extra of EXTRA_FILES) {
  const full = path.join(root, extra);
  try {
    if (statSync(full).isFile()) files.push(full);
  } catch {
    /* 文件不存在 */
  }
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIPDIRS.has(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full);
    else if (EXTENSIONS.has(path.extname(name))) files.push(full);
  }
}
for (const dir of ["src", "worker", "scripts", "cli", "tests", "shared", "public"]) {
  const full = path.join(root, dir);
  try {
    if (statSync(full).isDirectory()) walk(full);
  } catch {
    /* 目录不存在 */
  }
}

const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isReferenced(name) {
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\bfrom\\s+["']${escaped}(?:/[^"']*)?["']`),
    new RegExp(`\\bimport\\(\\s*["']${escaped}(?:/[^"']*)?["']`),
    new RegExp(`\\brequire\\(\\s*["']${escaped}(?:/[^"']*)?["']`),
    new RegExp(`["']${escaped}(?:/[^"']*)?["']`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

const unused = Object.keys(declared)
  .filter((name) => !TOOLING.has(name))
  .filter((name) => !name.startsWith("@types/"))
  .filter((name) => !isReferenced(name));

if (unused.length) {
  console.error(`[unused] 发现 ${unused.length} 个未使用的直接依赖：`);
  for (const name of unused) console.error(`  - ${name}`);
  console.error("确认没有直接引用后，用 npm uninstall 移除；工具类依赖请加入 scripts/check-unused.mjs 的 TOOLING 白名单。");
  process.exit(1);
}

console.log(`[unused] 通过：${Object.keys(declared).length} 个直接依赖均有引用（工具类已白名单）`);