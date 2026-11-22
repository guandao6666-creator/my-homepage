/**
 * 2.0.6 · 任务优先级/旧记录的归一化
 *
 * 审计发现两处：`PRIORITY[a.priority].weight` 遇到枚举外的值时直接 TypeError；
 * `applySync` 把服务端 payload 的 `priority` 原样 `as Priority` 落库，别的客户端
 * 或旧版本写进来的任何字符串都能把任务中心整页打崩。这里统一收敛到三档。
 */
export type TaskPriority = "low" | "normal" | "high";

export const TASK_PRIORITIES: TaskPriority[] = ["high", "normal", "low"];

export function normalizePriority(value: unknown): TaskPriority {
  return value === "low" || value === "high" ? value : "normal";
}

export type NormalizedTaskRecord = {
  id: string;
  title: string;
  note: string;
  priority: TaskPriority;
  due: string;
  category: string;
  done: boolean;
  createdAt: number;
  updatedAt?: number;
  doneAt?: number;
  notified?: string;
};

/** 本地存储里读到的任务：缺 id 的丢弃，其余字段强制成渲染能安全使用的形状。 */
export function normalizeTaskRecord(raw: unknown): NormalizedTaskRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  const doneAt = Number(record.doneAt);
  return {
    id,
    title: typeof record.title === "string" && record.title ? record.title.slice(0, 120) : "未命名任务",
    note: typeof record.note === "string" ? record.note.slice(0, 600) : "",
    priority: normalizePriority(record.priority),
    due: typeof record.due === "string" ? record.due : "",
    category: typeof record.category === "string" && record.category ? record.category : "other",
    done: Boolean(record.done),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
    ...(Number.isFinite(doneAt) ? { doneAt } : {}),
    ...(typeof record.notified === "string" ? { notified: record.notified } : {}),
  };
}

export function normalizeTaskRecords(raw: unknown): NormalizedTaskRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((task) => normalizeTaskRecord(task)).filter((task): task is NormalizedTaskRecord => task !== null);
}