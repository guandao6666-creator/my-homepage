/** 云盘公共工具：文件名、类型、配额、Content-Disposition。 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

export function quotaBytes(env) {
  const value = Number(env?.CLOUD_QUOTA_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUOTA_BYTES;
}

export function sanitizeName(input) {
  if (typeof input !== "string") return null;
  const base = input.split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

export function extensionOf(name) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

export function categoryOf(mime, name = "") {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (
    type === "application/pdf" ||
    type.startsWith("text/") ||
    type.includes("word") ||
    type.includes("excel") ||
    type.includes("presentation")
  ) {
    return "document";
  }
  const ext = extensionOf(name);
  if (["jpg", "jpeg", "png", "webp", "gif", "avif", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (["pdf", "txt", "md", "markdown", "csv"].includes(ext)) return "document";
  return "other";
}

export function isInlineSafe(mime) {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("image/") && type !== "image/svg+xml") return true;
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  if (type === "application/pdf") return true;
  if (type === "text/plain" || type === "text/markdown" || type === "text/csv") return true;
  return false;
}

export function contentDisposition(name, inline) {
  const fallback = (name || "file").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name || "file");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes, length = 16) {
  return String.fromCharCode(...bytes.slice(0, length));
}

/**
 * 根据文件头判断真实类型。声明类型属于图片/音视频/PDF 但内容不符时拒绝，
 * 避免仅依赖浏览器 MIME。
 */
export function detectMime(head, name, declared) {
  const bytes = head || new Uint8Array();
  const prefix = ascii(bytes, 24);
  const ext = extensionOf(name);
  const declaredType = (declared || "").toLowerCase().split(";")[0].trim();

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", category: "image" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", category: "image" };
  if (prefix.startsWith("GIF8")) return { mime: "image/gif", category: "image" };
  if (prefix.startsWith("RIFF") && ascii(bytes.slice(8), 4) === "WEBP") return { mime: "image/webp", category: "image" };
  if (prefix.startsWith("%PDF")) return { mime: "application/pdf", category: "document" };
  if (prefix.startsWith("RIFF") && ascii(bytes.slice(8), 4) === "WAVE") return { mime: "audio/wav", category: "audio" };
  if (prefix.startsWith("OggS")) return { mime: "audio/ogg", category: "audio" };
  if (prefix.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", category: "audio" };
  if (ascii(bytes.slice(4), 4) === "ftyp") {
    const brand = ascii(bytes.slice(8), 4);
    if (brand.startsWith("M4A")) return { mime: "audio/mp4", category: "audio" };
    if (brand.startsWith("qt")) return { mime: "video/quicktime", category: "video" };
    return { mime: "video/mp4", category: "video" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", category: "video" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { mime: "application/zip", category: "other" };

  if (prefix.toLowerCase().includes("<svg")) return { mime: "image/svg+xml", category: "image" };
  if (/^\s*<(?:!doctype html|html)/i.test(prefix)) return { mime: "text/html", category: "other" };

  if (["txt", "md", "markdown", "csv", "json"].includes(ext)) {
    const hasBinary = bytes.some((byte) => byte === 0);
    if (hasBinary) return { mime: null, category: "other", rejected: true };
    const map = { txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json" };
    return { mime: map[ext], category: map[ext].startsWith("text/") ? "document" : "other" };
  }

  // 声明为图片/音视频/PDF，但文件头完全不符：拒绝。
  if (declaredType.startsWith("image/") || declaredType.startsWith("audio/") || declaredType.startsWith("video/") || declaredType === "application/pdf") {
    return { mime: null, category: categoryOf(declaredType, name), rejected: true };
  }

  return { mime: declaredType || "application/octet-stream", category: categoryOf(declaredType || "application/octet-stream", name) };
}

export async function sha256StreamUnavailable() {
  return null;
}
