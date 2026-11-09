/**
 * 生成内联脚本的 CSP 哈希白名单。
 *
 * Astro 会把少量脚本内联进 HTML（启动兜底、站点数据），这些脚本没有固定文件名，
 * 只能按内容哈希放行。每次 build 之后重新计算，写入 worker/api/csp-hashes.js，
 * 由 Worker 在 Content-Security-Policy 里使用。
 *
 * 如果 dist 里没有 HTML（例如只跑 wrangler dev），保留上一次生成的文件不动。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = "dist";
const OUT = "worker/api/csp-hashes.js";

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, files);
    else if (entry.endsWith(".html")) files.push(full);
  }
  return files;
}

const EXECUTABLE_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

function hashInlineScripts(html) {
  const out = [];
  const pattern = /<script(?![^>]*\ssrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (!body.trim()) continue;

    const typeMatch = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const type = (typeMatch?.[1] || "").toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue; // application/ld+json 等数据块不执行，也不需要哈希

    out.push(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.warn("[csp] dist 不存在，跳过（保留现有哈希文件）");
  process.exit(0);
}

const files = walk(DIST);
if (!files.length) {
  console.warn("[csp] 没有找到 HTML，保留现有哈希文件");
  process.exit(0);
}

const hashes = new Set();
for (const file of files) {
  for (const hash of hashInlineScripts(readFileSync(file, "utf8"))) hashes.add(hash);
}

const list = [...hashes].sort();

/**
 * `--check` 模式：只比对、不写文件。
 *
 * 2.0 加的部署护栏：如果直接 `wrangler deploy` 而没有先 `npm run build`，
 * 线上会用**上一版**的哈希白名单去放行**新版**内联脚本 —— 结果是被 CSP 拦掉、
 * 桌面白屏。CI 里跑一次 --check 就能在部署前发现这种漂移。
 */
if (process.argv.includes("--check")) {
  if (!existsSync(OUT)) {
    console.error(`[csp] 校验失败：${OUT} 不存在（先运行 npm run build）`);
    process.exit(1);
  }
  const declared = [...readFileSync(OUT, "utf8").matchAll(/(sha256-[A-Za-z0-9+/=]+)/g)].map((match) => match[1]);
  const declaredSet = new Set(declared);
  const missing = list.filter((hash) => !declaredSet.has(hash));
  const stale = declared.filter((hash) => !hashes.has(hash));
  if (missing.length || stale.length) {
    console.error("[csp] 校验失败：csp-hashes.js 与 dist 不一致");
    if (missing.length) console.error(`  缺少 ${missing.length} 个哈希（新内联脚本会被 CSP 拦掉）`);
    if (stale.length) console.error(`  多出 ${stale.length} 个哈希（对应脚本已不存在）`);
    console.error("  修复：重新运行 npm run build 后再部署");
    process.exit(1);
  }
  console.log(`[csp] 校验通过：${list.length} 个哈希与 ${files.length} 个 HTML 一致`);
  process.exit(0);
}

const content = `/**
 * 自动生成文件 —— 由 scripts/gen-csp.mjs 在 npm run build 之后写入。
 * 不要手工编辑；内联脚本变化后重新构建即可。
 */

export const SCRIPT_HASHES = ${JSON.stringify(list, null, 2)};
`;

writeFileSync(OUT, content, "utf8");
console.log(`[csp] ${relative(process.cwd(), OUT)}: ${list.length} 个内联脚本哈希（扫描 ${files.length} 个 HTML）`);
