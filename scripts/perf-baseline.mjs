/**
 * Guandao OS 6.4 · 构建产物体积基线。
 *
 * Phase 6 的两条预算是硬指标（入口 JS ≤ 450 KB、首屏 CSS ≤ 200 KB），
 * 这里把它们变成可执行门禁：超预算直接 exit 1，避免「文档写了达标、代码悄悄超回去」。
 *
 * 口径与 2.0 审计一致：**未压缩字节**（不是 gzip）。见 docs/AI-BUILD-DECISIONS.md D-003。
 *
 * 用法：
 *   node scripts/perf-baseline.mjs            # 检查 + 打印
 *   node scripts/perf-baseline.mjs --write    # 同时写入 docs/PERF-BASELINE.md
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const BUDGET = { entryJs: 450_000, firstScreenCss: 200_000 };

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("[perf] 找不到 dist/index.html，请先 npm run build");
  process.exit(1);
}

const sizeOf = (file) => fs.statSync(file).size;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** 从首页 HTML 里取出实际首屏加载的入口脚本与样式表（只算真正 <link> 的，不算懒加载 chunk） */
function readEntryAssets() {
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  const resolve = (href) => path.join(DIST, href.replace(/^\//, "").replace(/\?.*$/, ""));
  return {
    // 入口脚本是页面唯一的 module script；带 hash 的静态资源名以 index.astro 开头
    entryScripts: scripts.filter((src) => /index\.astro_astro_type_script/.test(src)).map(resolve),
    styles: styles.map(resolve),
    allScripts: scripts.map(resolve),
  };
}

const { entryScripts, styles } = readEntryAssets();
if (!entryScripts.length) {
  console.error("[perf] 首页没有找到入口脚本，构建产物可能不完整");
  process.exit(1);
}

const entryJs = entryScripts.reduce((sum, file) => sum + sizeOf(file), 0);
const firstScreenCss = styles.reduce((sum, file) => sum + sizeOf(file), 0);
const largestCss = styles.map((f) => sizeOf(f)).sort((a, b) => b - a)[0] ?? 0;

const astroDir = path.join(DIST, "_astro");
const assets = fs.readdirSync(astroDir).filter((name) => /\.(js|css)$/.test(name));
const totalJs = assets.filter((n) => n.endsWith(".js")).reduce((s, n) => s + sizeOf(path.join(astroDir, n)), 0);
const totalCss = assets.filter((n) => n.endsWith(".css")).reduce((s, n) => s + sizeOf(path.join(astroDir, n)), 0);
// dist 未清理时可能残留上一轮的哈希文件，会让「合计」偏大；检测同名不同哈希并提示
const prefixCount = new Map();
for (const name of assets) {
  const key = name.replace(/\.[A-Za-z0-9_-]{8}\.(js|css)$/, ".$1");
  prefixCount.set(key, (prefixCount.get(key) ?? 0) + 1);
}
const stale = [...prefixCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);
if (stale.length) {
  console.log(`[perf] 提示：dist 里有 ${stale.length} 组同名不同哈希的残留（${stale.slice(0, 3).join(", ")}），建议清理 dist 后重测合计值`);
}

const biggest = assets
  .map((name) => ({ name, size: sizeOf(path.join(astroDir, name)) }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 5);

const checks = [
  { id: "entryJs", label: "入口 JS", actual: entryJs, budget: BUDGET.entryJs },
  // 口径：首页 <link rel="stylesheet"> 的实际总和。
  // 注意：Astro 会把异步 chunk 的 CSS 也以 <link> 注入首页（见 AI-BUILD-DECISIONS D-006），
  // 因此「单个样式文件变小」不等于「首屏 CSS 变小」。
  { id: "firstScreenCss", label: "首屏 CSS", actual: firstScreenCss, budget: BUDGET.firstScreenCss },
];

const rows = checks.map((c) => ({
  ...c,
  ok: c.actual <= c.budget,
  used: ((c.actual / c.budget) * 100).toFixed(1),
}));

console.log("Guandao OS · 构建体积基线（未压缩字节）\n");
for (const row of rows) {
  console.log(
    `${row.ok ? "PASS" : "FAIL"}  ${row.label.padEnd(8)} ${kb(row.actual).padStart(10)} / ${kb(row.budget).padStart(10)}  (${row.used}%)`,
  );
}
console.log(`\n合计：JS ${kb(totalJs)} · CSS ${kb(totalCss)} · 资源 ${assets.length} 个`);
console.log(`首屏加载 ${styles.length} 个样式表，其中最大单文件 ${kb(largestCss)}`);
console.log("最大 5 个资源：");
for (const item of biggest) console.log(`  ${kb(item.size).padStart(10)}  ${item.name}`);

if (process.argv.includes("--write")) {
  const at = new Date().toISOString();
  const lines = [
    "# Guandao OS 构建体积基线",
    "",
    `> 由 \`node scripts/perf-baseline.mjs --write\` 生成，不要手改。生成时间：${at}`,
    "> 口径：未压缩字节（与 2.0 审计一致，见 docs/AI-BUILD-DECISIONS.md D-003）。",
    "",
    "| 项 | 实测 | 预算 | 占比 | 结果 |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map((r) => `| ${r.label} | ${kb(r.actual)} | ${kb(r.budget)} | ${r.used}% | ${r.ok ? "通过" : "超标"} |`),
    "",
    `合计：JS ${kb(totalJs)} · CSS ${kb(totalCss)} · 资源 ${assets.length} 个。`,
    "",
    "| 最大资源 | 体积 |",
    "| --- | ---: |",
    ...biggest.map((b) => `| \`${b.name}\` | ${kb(b.size)} |`),
    "",
  ];
  fs.writeFileSync(path.join(ROOT, "docs", "PERF-BASELINE.md"), lines.join("\n"), "utf8");
  console.log("\n[perf] 已写入 docs/PERF-BASELINE.md");
}

const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n[perf] 超出预算：${failed.map((r) => r.label).join(" / ")}`);
  process.exit(1);
}
