/**
 * 接力内容的标准 payload。
 *
 * 桌面端与移动端共用同一套构造器，避免出现「手机发的内容电脑不认识」。
 * 快照只带恢复所需的最小字段，不包含 Token、Cookie、文件二进制。
 */

import type { ContinuityType } from "./client";

export type NotePayload = {
  title: string;
  body: string;
  folder?: string;
  tags?: string[];
  pinned?: boolean;
  updatedAt?: number;
};

export type TaskPayload = {
  title: string;
  note?: string;
  priority?: "low" | "normal" | "high";
  due?: string;
  category?: string;
  done?: boolean;
};

export type EventPayload = {
  title: string;
  date: string;
  time?: string;
  category?: string;
  repeat?: string;
  remind?: number;
  note?: string;
};

export type FilePayload = {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  category?: string;
};

export type LinkPayload = { url: string; title?: string; description?: string };

export type ReadingPayload = { title: string; url?: string; progress?: number };

export type WorkspacePayload = {
  workspace: Record<string, unknown>;
  note?: string;
};

export type AppPayload = {
  appId: string;
  appTitle?: string;
  resourceId?: string;
  resourceTitle?: string;
};

export type PayloadFor<T extends ContinuityType> = T extends "note"
  ? NotePayload
  : T extends "task"
    ? TaskPayload
    : T extends "event"
      ? EventPayload
      : T extends "file"
        ? FilePayload
        : T extends "link"
          ? LinkPayload
          : T extends "workspace"
            ? WorkspacePayload
            : T extends "reading"
              ? ReadingPayload
              : AppPayload;

export const ITEM_META: Record<ContinuityType, { label: string; glyph: string }> = {
  note: { label: "笔记", glyph: "✎" },
  task: { label: "任务", glyph: "✓" },
  event: { label: "日程", glyph: "◷" },
  file: { label: "文件", glyph: "▤" },
  link: { label: "链接", glyph: "↗" },
  workspace: { label: "工作空间", glyph: "▦" },
  reading: { label: "阅读位置", glyph: "◫" },
  app: { label: "应用内容", glyph: "▣" },
};

/** 生成 1–2 行的摘要，避免把整篇笔记塞进通知或列表。 */
export function summarize(type: ContinuityType, payload: Record<string, unknown>): string {
  const text = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  if (type === "note") return text(payload.body).slice(0, 90);
  if (type === "task") return [text(payload.note), payload.due ? `截止 ${text(payload.due)}` : ""].filter(Boolean).join(" · ").slice(0, 90);
  if (type === "event") return [text(payload.date), text(payload.time), text(payload.note)].filter(Boolean).join(" · ").slice(0, 90);
  if (type === "file") return [text(payload.name), text(payload.mimeType)].filter(Boolean).join(" · ").slice(0, 90);
  if (type === "link") return text(payload.url).slice(0, 90);
  if (type === "workspace") return text(payload.note || "工作空间布局").slice(0, 90);
  if (type === "reading") return text(payload.url).slice(0, 90);
  if (type === "app") return text(payload.resourceTitle || payload.appTitle).slice(0, 90);
  return "";
}
