#!/usr/bin/env node
/**
 * 粗略判断某个源码模块是否被打进了主包。
 *
 * 做法：从源码里挑出不会出现在别处的中文句子 / 类名前缀，
 * 再到 dist/_astro 的最大 JS 包里搜。只用于性能分析，不参与构建。
 *
 * 用法：node scripts/analyze-bundle.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const astroDir = "dist/_astro";
const bundles = readdirSync(astroDir)
  .filter((n) => n.endsWith(".js"))
  .map((n) => ({ name: n, size: statSync(join(astroDir, n)).size }))
  .sort((a, b) => b.size - a.size);

const main = bundles[0];
if (!main) {
  console.error("找不到构建产物，先执行 npm run build");
  process.exit(1);
}
const code = readFileSync(join(astroDir, main.name), "utf8");

const targets = [
  ["core", "src/lib/os14/core.ts"],
  ["themes", "src/lib/os14/themes.ts"],
  ["widgetstore", "src/lib/os14/widgetstore.ts"],
  ["community", "src/lib/os14/community.ts"],
  ["backup", "src/lib/os14/backup.ts"],
  ["devices", "src/lib/os14/devices.ts"],
  ["security", "src/lib/os14/security.ts"],
  ["drive", "src/lib/os14/drive.ts"],
  ["files", "src/lib/os14/files.ts"],
  ["games", "src/lib/os14/games.ts"],
  ["notes", "src/lib/os14/apps/notes.ts"],
  ["calendar", "src/lib/os14/apps/calendar.ts"],
  ["gallery", "src/lib/os14/apps/gallery.ts"],
  ["music", "src/lib/os14/apps/music.ts"],
  ["reader", "src/lib/os14/apps/reader.ts"],
  ["appcenter", "src/lib/os14/appcenter.ts"],
  ["datacenter", "src/lib/os14/datacenter.ts"],
  ["workspaces", "src/lib/os14/workspaces.ts"],
  ["plugins/registry", "src/lib/plugins/registry.ts"],
  ["plugins/market", "src/lib/plugins/market.ts"],
  ["plugins/developer", "src/lib/plugins/developer.ts"],
  ["plugins/host", "src/lib/plugins/host.ts"],
  ["mobile", "src/lib/mobile/app.ts"],
  ["account", "src/lib/account/client.ts"],
  ["continuity", "src/lib/continuity/app.ts"],
  ["quality/perf", "src/lib/quality/perf.ts"],
  ["quality/net", "src/lib/quality/net.ts"],
];

/** 找源码里最不可能出现在其它模块的字符串字面量 */
function probe(source) {
  const candidates = new Set();
  // 1) 中文长句（>=8 个汉字），要求整句出现
  for (const m of source.matchAll(/"([^"\\\n]{4,60})"/g)) {
    if (/[\u4e00-\u9fa5]/.test(m[1]) && m[1].length >= 8) candidates.add(m[1]);
  }
  // 2) 模板字符串里的中文
  for (const m of source.matchAll(/`([^`\\\n]{8,60})`/g)) {
    if (/[\u4e00-\u9fa5]/.test(m[1]) && !m[1].includes("${")) candidates.add(m[1]);
  }
  return [...candidates].slice(0, 400);
}

const rows = [];
for (const [label, file] of targets) {
  let source = "";
  try {
    source = readFileSync(file, "utf8");
  } catch {
    rows.push({ label, inBundle: "missing", kb: 0 });
    continue;
  }
  const probes = probe(source);
  const hit = probes.find((p) => code.includes(p));
  rows.push({
    label,
    inBundle: hit ? "YES" : "no",
    kb: Math.round(statSync(file).size / 1024),
    sample: hit ? hit.slice(0, 24) : "",
  });
}

console.log(`主包 ${main.name}  ${Math.round(main.size / 1024)} KB`);
console.log("模块是否进入主包（基于唯一中文字面量抽样）\n");
for (const r of rows.sort((a, b) => Number(b.kb) - Number(a.kb))) {
  console.log(`${String(r.kb).padStart(6)} KB  ${r.inBundle.padEnd(6)}  ${r.label}`);
}
const total = bundles.reduce((n, b) => n + b.size, 0);
console.log(`\n全部 JS chunk：${bundles.length} 个，合计 ${Math.round(total / 1024)} KB`);