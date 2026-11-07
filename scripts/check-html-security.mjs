#!/usr/bin/env node
/**
 * Guandao OS 2.3.1 · HTML 安全静态检查。
 *
 * 用 TypeScript 编译器 API 做 AST 扫描，不是正则匹配字符串——
 * 因为「字符串里出现 innerHTML」不等于漏洞，必须看它是不是一次真实赋值。
 *
 * 检查项：
 *   1. HTML sink：`el.innerHTML = ...`、`outerHTML =`、`insertAdjacentHTML(...)`、`document.write(...)`
 *   2. 动态 URL 属性插值：模板字符串里 `href="${expr}"` / `src="${expr}"`
 *   3. 直接 URL 赋值：`el.href = ...` / `el.src = ...`
 *   4. 危险协议字面量：`javascript:` / `vbscript:` / `data:text/html`
 *   5. 重复的转义实现：`src/lib/html.ts` 之外的 escapeHtml / escapeAttr 定义
 *
 * 已审查的项登记在 scripts/html-security-allowlist.json，必须写 reason。
 *
 *   node scripts/check-html-security.mjs
 *   node scripts/check-html-security.mjs --json
 *   node scripts/check-html-security.mjs --update-allowlist   # 生成/刷新基线（需人工补 reason）
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = "src";
const ALLOWLIST_PATH = "scripts/html-security-allowlist.json";
const CANONICAL_ESCAPE_FILE = "src/lib/html.ts";

/* ------------------------------------------------------------------ 文件收集 */

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(ROOT, path.relative(ROOT, path.resolve(dir, entry.name)));
    if (entry.isDirectory()) collectFiles(full, out);
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

/**
 * 把 .astro 里的 <script> 块抽出来，保留行号偏移。
 * 前置脚本（---）里的 TypeScript 也一并抽取。
 */
function extractScripts(text) {
  const blocks = [];
  const lines = text.split("\n");

  // frontmatter
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const body = text.slice(3, end);
      const offset = 1; // 跳过首行 ---
      blocks.push({ body, offset });
    }
  }

  // <script ...> ... </script>
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    const offset = before.split("\n").length; // script 标签所在行之后
    blocks.push({ body: match[1], offset });
  }
  return { blocks, lines };
}

/* -------------------------------------------------------------------- AST 扫描 */

const SINK_PROPS = new Set(["innerHTML", "outerHTML"]);
const URL_PROPS = new Set(["href", "src", "action", "formAction", "poster"]);
const URL_SAFE_WRAPPERS = new Set(["safeUrl", "isSafeUrl", "escapeAttr", "escapeHtml", "encodeURIComponent"]);
// 必须带冒号才算协议；否则 "JavaScript" 这种普通单词会误报
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|livescript)\s*:|^\s*data\s*:\s*text\/html/i;

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

function isWrappedBySafeCall(node) {
  // 表达式本身就是安全调用（最常见）：src="${safeUrl(x)}"
  if (ts.isCallExpression(node) && URL_SAFE_WRAPPERS.has(calleeName(node.expression))) return true;
  if (ts.isIdentifier(node) && (node.text === "safeUrl" || node.text === "escapeAttr")) return true;

  // 或者被安全调用包在参数里：src="${encodeURIComponent(...)}" 之外的嵌套情况
  let cur = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur) && URL_SAFE_WRAPPERS.has(calleeName(cur.expression))) return true;
    if (ts.isTemplateExpression(cur) || ts.isStringLiteral(cur)) return false;
    cur = cur.parent;
  }
  return false;
}

function scanSource(file, body, offset) {
  const sf = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = [];

  const push = (kind, node, extra = {}) => {
    hits.push({ kind, file, line: lineOf(sf, node) + offset, ...extra });
  };

  const visit = (node) => {
    // 1) HTML sink 赋值：x.innerHTML = ...
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && SINK_PROPS.has(left.name.text)) {
        push("sink", left, { sink: left.name.text });
      }
      if (ts.isPropertyAccessExpression(left) && URL_PROPS.has(left.name.text)) {
        push("url-assign", left, { prop: left.name.text });
      }
    }

    // 2) sink 调用：insertAdjacentHTML(...) 与 document.write(...)
    //    注意：不能把任意 `.write()` 都算进去（localStorage/stream/文件写入会误报）
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "insertAdjacentHTML") push("sink", node, { sink: name });
      if ((name === "write" || name === "writeln") && ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression.expression;
        if (ts.isIdentifier(target) && target.text === "document") {
          push("sink", node, { sink: `document.${name}` });
        }
      }
    }

    // 3) 模板字符串里的 URL 属性插值
    if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span, i) => {
        const headText = i === 0 ? node.head.text : node.templateSpans[i - 1].literal.text;
        const m = /(?:^|[\s"'`])(href|src|action|poster)\s*=\s*["'][^"']*$/.exec(headText);
        if (!m) return;
        if (isWrappedBySafeCall(span.expression)) return;
        push("url-interp", span.expression, { attr: m[1] });
      });
    }

    // 4) 危险协议字面量
    if (ts.isStringLiteralLike(node) && DANGEROUS_SCHEME.test(node.text)) {
      push("dangerous-scheme", node, { value: node.text.slice(0, 40) });
    }

    // 5) 重复的转义实现
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if ((node.name.text === "escapeHtml" || node.name.text === "escapeAttr") && node.initializer) {
        push("duplicate-escape", node, { name: node.name.text });
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && /^escape(Html|Attr)$/.test(node.name.text)) {
      push("duplicate-escape", node, { name: node.name.text });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits;
}

/* ------------------------------------------------------------------------ 主流程 */

const files = collectFiles(ROOT);
const allHits = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".astro")) {
    const { blocks } = extractScripts(text);
    for (const block of blocks) allHits.push(...scanSource(file, block.body, block.offset));
  } else {
    allHits.push(...scanSource(file, text, 0));
  }
}

// 统一转义模块自身的定义不算重复；同一位置的多条同类型命中合并
const seen = new Set();
const filtered = allHits
  .filter((hit) => !(hit.kind === "duplicate-escape" && hit.file === CANONICAL_ESCAPE_FILE))
  .filter((hit) => {
    const key = `${hit.kind}|${hit.file}|${hit.line}|${hit.sink ?? hit.prop ?? hit.attr ?? hit.name ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

/* --------------------------------------------------------------- 白名单匹配 */

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { entries: [] };
  return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
}

const allowlist = loadAllowlist();
const allowEntries = allowlist.entries ?? [];

/** 每个 (kind, file) 的实际命中数，用于发现「新增了未审查的 sink」 */
const countByFile = new Map();
for (const hit of filtered) {
  const key = `${hit.kind}|${hit.file}`;
  countByFile.set(key, (countByFile.get(key) ?? 0) + 1);
}

const staleCounts = [];

function allowed(hit) {
  const entry = allowEntries.find(
    (e) =>
      e.kind === hit.kind &&
      e.file === hit.file &&
      (e.line === undefined || e.line === hit.line),
  );
  if (!entry) return null;
  // 文件级条目带 count：数量变化说明新增了 sink，必须重新审查
  if (entry.line === undefined && typeof entry.count === "number") {
    const actual = countByFile.get(`${entry.kind}|${entry.file}`) ?? 0;
    if (actual !== entry.count) {
      const key = `${entry.kind}|${entry.file}`;
      if (!staleCounts.some((s) => s.key === key)) {
        staleCounts.push({ key, file: entry.file, kind: entry.kind, expected: entry.count, actual });
      }
      return null;
    }
  }
  return entry;
}

const byKind = new Map();
for (const hit of filtered) {
  if (!byKind.has(hit.kind)) byKind.set(hit.kind, []);
  byKind.get(hit.kind).push(hit);
}

const unreviewed = filtered.filter((hit) => !allowed(hit));
const isJson = process.argv.includes("--json");

if (isJson) {
  console.log(JSON.stringify({ total: filtered.length, unreviewed: unreviewed.length, hits: filtered }, null, 2));
  process.exit(unreviewed.length ? 1 : 0);
}

console.log("Guandao OS · HTML 安全静态检查\n");
const LABEL = {
  sink: "HTML sink",
  "url-interp": "动态 URL 插值",
  "url-assign": "直接 URL 赋值",
  "dangerous-scheme": "危险协议字面量",
  "duplicate-escape": "重复转义实现",
};

for (const [kind, list] of [...byKind.entries()].sort()) {
  const reviewed = list.filter((h) => allowed(h)).length;
  console.log(`${LABEL[kind] ?? kind}: ${list.length} 处（已审查 ${reviewed}，未审查 ${list.length - reviewed}）`);
}

console.log(`\n合计 ${filtered.length} 处，未审查 ${unreviewed.length} 处\n`);

if (unreviewed.length) {
  console.log("未审查项：");
  for (const hit of unreviewed.slice(0, 60)) {
    const detail = hit.sink ?? hit.prop ?? hit.attr ?? hit.name ?? hit.value ?? "";
    console.log(`  ${hit.file}:${hit.line}  [${hit.kind}] ${detail}`);
  }
  if (unreviewed.length > 60) console.log(`  … 另外 ${unreviewed.length - 60} 处`);
  console.log(`\n请逐项审查，并在 ${ALLOWLIST_PATH} 中登记（必须写 reason）。`);
  process.exit(1);
}

if (staleCounts.length) {
  console.log("数量已变化，需要重新审查：");
  for (const s of staleCounts) {
    console.log(`  ${s.file}  [${s.kind}] 登记 ${s.expected} 处，实际 ${s.actual} 处`);
  }
  console.log(`\n请复核后更新 ${ALLOWLIST_PATH} 里的 count 与 reason。`);
  process.exit(1);
}

console.log(`全部 ${filtered.length} 处均已审查登记（${ALLOWLIST_PATH}）。`);
process.exit(0);