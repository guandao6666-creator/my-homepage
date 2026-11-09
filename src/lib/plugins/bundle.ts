/**
 * Guandao OS 1.7 · 插件包校验与入口装配
 *
 * 安装前必须完成三件事，缺一不可：
 *   1. Manifest / 文件清单通过官方 Schema（shared/plugin-spec.js）
 *   2. filesDigest 与文件内容一致
 *   3. 原始包文本的 SHA-256 与服务端记录一致
 *
 * 通过之后才把入口 HTML 里的本地 CSS / JS / 图片内联成一份自包含文档，
 * 供沙箱 iframe 以 Blob URL 加载。插件本身仍然拿不到宿主任何东西。
 */

import {
  canonicalFilesJson,
  fileMap,
  validateBundle,
  mimeForPath,
  type BundleFile,
  type Manifest,
} from "../../../shared/plugin-spec.js";

export type VerifyResult =
  | {
      ok: true;
      manifest: Manifest;
      files: BundleFile[];
      html: string;
      filesDigest: string;
      packageDigest: string;
      warnings: string[];
    }
  | { ok: false; errors: string[] };

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyBundle(
  raw: string,
  expected: { id: string; type?: string; checksum?: string },
): Promise<VerifyResult> {
  const result = validateBundle(raw, { expectedId: expected.id, expectedType: expected.type });
  if (!result.ok || !result.manifest) {
    return { ok: false, errors: result.errors.map((issue) => `${issue.path}：${issue.message}`) };
  }

  const filesDigest = await sha256Hex(canonicalFilesJson(result.files));
  if (result.declaredFilesDigest && result.declaredFilesDigest !== filesDigest) {
    return { ok: false, errors: ["文件清单摘要与内容不一致，插件包可能被篡改"] };
  }
  const packageDigest = await sha256Hex(raw);
  if (expected.checksum && expected.checksum !== packageDigest) {
    return { ok: false, errors: ["插件包校验值与服务端记录不一致，已阻止安装"] };
  }

  // 主题插件是声明式的，没有入口 HTML；其它类型必须有可装配的入口
  const html =
    result.manifest.type === "theme" && !result.manifest.entry
      ? ""
      : buildEntryHtml(result.manifest, result.files);
  if (result.manifest.type !== "theme" && !html) {
    return { ok: false, errors: ["入口文件无法装配：请确认 entry 指向一个 HTML 文件"] };
  }

  return {
    ok: true,
    manifest: result.manifest,
    files: result.files,
    html,
    filesDigest,
    packageDigest,
    warnings: result.warnings.map((warning) => `${warning.path}：${warning.message}`),
  };
}

/* ============================================================
   入口装配
   ============================================================ */

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function resolvePath(base: string, ref: string): string | null {
  if (!ref) return null;
  if (/^(https?:|data:|blob:|#|mailto:|javascript:)/i.test(ref)) return null;
  if (ref.startsWith("//")) return null;
  const clean = ref.split("#")[0].split("?")[0];
  if (!clean) return null;
  const segments = `${base}/${clean}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function dataUrl(file: BundleFile): string {
  if (file.encoding === "base64") {
    return `data:${mimeForPath(file.path)};base64,${String(file.content).replace(/\s+/g, "")}`;
  }
  return `data:${mimeForPath(file.path)};charset=utf-8,${encodeURIComponent(String(file.content))}`;
}

function textOf(file: BundleFile): string {
  if (file.encoding !== "base64") return String(file.content);
  try {
    return decodeURIComponent(escape(atob(String(file.content).replace(/\s+/g, ""))));
  } catch {
    return "";
  }
}

/**
 * 把入口 HTML 变成自包含文档。
 * 用 DOMParser（不执行脚本）而不是正则，避免把注释里的标签当成资源。
 */
export function buildEntryHtml(manifest: Manifest, files: BundleFile[]): string {
  const map = fileMap(files);
  const entry = map.get(manifest.entry.toLowerCase());
  if (!entry || !/\.html?$/i.test(entry.path)) return "";
  const base = dirOf(entry.path);

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(textOf(entry), "text/html");
  } catch {
    return "";
  }

  doc.querySelectorAll("base").forEach((node) => node.remove());
  doc.querySelectorAll('meta[http-equiv="refresh" i]').forEach((node) => node.remove());

  if (!doc.querySelector("meta[charset]")) {
    const meta = doc.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    doc.head?.prepend(meta);
  }

  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((link) => {
    const path = resolvePath(base, link.getAttribute("href") ?? "");
    const file = path ? map.get(path.toLowerCase()) : null;
    if (!file) return;
    const style = doc.createElement("style");
    style.textContent = textOf(file);
    link.replaceWith(style);
  });

  doc.querySelectorAll<HTMLScriptElement>("script[src]").forEach((script) => {
    const path = resolvePath(base, script.getAttribute("src") ?? "");
    const file = path ? map.get(path.toLowerCase()) : null;
    if (!file) {
      script.remove();
      return;
    }
    const inline = doc.createElement("script");
    for (const attr of Array.from(script.attributes)) {
      if (attr.name === "src") continue;
      inline.setAttribute(attr.name, attr.value);
    }
    inline.textContent = textOf(file);
    script.replaceWith(inline);
  });

  const assetAttrs: Array<[string, string]> = [
    ["img", "src"],
    ["source", "src"],
    ["video", "poster"],
    ["audio", "src"],
  ];
  for (const [tag, attr] of assetAttrs) {
    doc.querySelectorAll<HTMLElement>(`${tag}[${attr}]`).forEach((node) => {
      const value = node.getAttribute(attr) ?? "";
      if (/^(https?:|data:|blob:)/i.test(value)) return;
      const path = resolvePath(base, value);
      const file = path ? map.get(path.toLowerCase()) : null;
      if (file) node.setAttribute(attr, dataUrl(file));
    });
  }

  // 外链（http/https）一律移除：沙箱 CSP 不允许外部图片/样式，
  // 留着只会产生一堆看不见的失败请求与潜在追踪。
  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href^="http"]').forEach((node) => node.remove());
  doc.querySelectorAll<HTMLImageElement>('img[src^="http"]').forEach((node) => node.removeAttribute("src"));

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
