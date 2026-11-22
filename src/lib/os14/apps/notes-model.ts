/**
 * 2.0.6 · 笔记数据的读取归一化
 *
 * 审计发现：`read()` 只校验 `v === 1 && Array.isArray(notes)`，然后首页直接
 * `n.tags.join(" ")`、`note.body.split("\n")`。旧版本/半写坏的本地数据只要少了
 * `tags` 或 `body`，笔记首页就 TypeError（整个应用白屏）。
 *
 * 把归一化抽成纯函数：坏记录要么补默认值，要么丢弃（宁可少一条，也不要整页崩）。
 */
export type NormalizedNote = {
  id: string;
  title: string;
  body: string;
  folder: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** 单条笔记：没有 id 的记录无法定位/编辑，直接丢弃；其余字段缺什么补什么。 */
export function normalizeNote(raw: unknown): NormalizedNote | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asString(record.id).trim();
  if (!id) return null;
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  return {
    id,
    title: asString(record.title),
    body: asString(record.body),
    folder: asString(record.folder).trim() || "inbox",
    // 只保留字符串标签：`tags.join` 不会因为里面混了数字/undefined 而抛。
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
    pinned: Boolean(record.pinned),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** 列表级：保留顺序，丢掉无法修复的记录。 */
export function normalizeNotes(raw: unknown): NormalizedNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((note) => normalizeNote(note)).filter((note): note is NormalizedNote => note !== null);
}