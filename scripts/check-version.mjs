#!/usr/bin/env node
/**
 * 版本一致性检查（1.9）
 *
 * 1.9 之前版本号有 6 份拷贝，其中社区清单停在 1.6.0，
 * 导致声明 minimum 1.7/1.8 的社区内容在 1.8 系统上被拒绝安装。
 * 现在由这个脚本在 CI 与本地 `npm test` 里强制一致。
 *
 * 检查项：
 *   package.json / src/lib/version.ts / worker/api/version.js / public/sw.js
 */
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

const pkg = JSON.parse(read("package.json"));
const problems = [];

const versionTs = read("src/lib/version.ts");
const tsVersion = /export const OS_VERSION = "([^"]+)"/.exec(versionTs)?.[1];
if (!tsVersion) problems.push("src/lib/version.ts 里找不到 OS_VERSION");
else if (tsVersion !== pkg.version) problems.push(`src/lib/version.ts=${tsVersion} ≠ package.json=${pkg.version}`);

const workerVersion = read("worker/api/version.js");
const workerTs = /export const WORKER_VERSION = "([^"]+)"/.exec(workerVersion)?.[1];
if (!workerTs) problems.push("worker/api/version.js 里找不到 WORKER_VERSION");
else if (workerTs !== pkg.version) problems.push(`worker/api/version.js=${workerTs} ≠ package.json=${pkg.version}`);

const sw = read("public/sw.js");
const swVersion = /const VERSION = "guandao-([^"]+)"/.exec(sw)?.[1];
if (!swVersion) problems.push("public/sw.js 里找不到 VERSION");
else if (swVersion !== pkg.version) problems.push(`public/sw.js=${swVersion} ≠ package.json=${pkg.version}`);

/**
 * 2.0 新增：插件 spec 与社区校验各有一份 OS_VERSION。
 * 1.9 时 shared/plugin-spec.js 停在 1.8.0、community/validate.js 停在 1.6.0，
 * 而 check-version 不覆盖它们，导致 /api/plugins/meta 与社区首页对外报错版本。
 */
const pluginSpec = read("shared/plugin-spec.js");
const pluginSpecVersion = /export const OS_VERSION = "([^"]+)"/.exec(pluginSpec)?.[1];
if (!pluginSpecVersion) problems.push("shared/plugin-spec.js 里找不到 OS_VERSION");
else if (pluginSpecVersion !== pkg.version) {
  problems.push(`shared/plugin-spec.js=${pluginSpecVersion} ≠ package.json=${pkg.version}`);
}

const communityValidate = read("worker/api/community/validate.js");
const communityVersion = /OS_VERSION\s*=\s*"([^"]+)"/.exec(communityValidate)?.[1];
if (!communityVersion) problems.push("worker/api/community/validate.js 里找不到 OS_VERSION");
else if (communityVersion !== pkg.version) {
  problems.push(`worker/api/community/validate.js=${communityVersion} ≠ package.json=${pkg.version}`);
}

/** 构建信息里的构建号不能写死成某个版本号 */
if (!/export const BUILD_INFO/.test(versionTs)) problems.push("src/lib/version.ts 缺少 BUILD_INFO");

/** 打包产物里不应该再出现旧的硬编码版本 */
const legacy = [
  ["src/lib/community/manifest.ts", /OS_VERSION = "1\.[0-8]\.\d"/],
  ["src/lib/plugins/registry.ts", /OS_VERSION = "1\.[0-8]\.\d"/],
  ["scripts/plugins-qa.mjs", /"1\.(7|8|9)\.\d"/],
];
for (const [file, pattern] of legacy) {
  const text = read(file);
  if (pattern.test(text)) problems.push(`${file} 仍然硬编码了旧版本号`);
}

if (problems.length) {
  console.error("[version] 版本号不一致：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`[version] 一致：${pkg.version}（package.json / version.ts / worker / sw.js）`);