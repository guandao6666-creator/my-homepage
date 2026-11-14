/**
 * 移动端数据访问。
 *
 * 账号 / 设备 / 文件来自现有云端接口；笔记、任务、日历来自桌面同一份本地存储。
 * 离线时接力与剪贴板进入 outbox，恢复网络后按顺序补发（不伪造已送达）。
 */

import { continuityApi, clipboardApi, type ClipboardItem, type ContinuityItem, type ContextItem } from "../continuity/client";
import { listDevices, type DeviceOverview } from "../devices/client";

export type AccountUser = {
  id: string;
  displayName: string;
  githubUsername: string | null;
  avatarUrl: string | null;
  role: string;
};

export type AccountState = {
  authenticated: boolean;
  user: AccountUser | null;
  reason?: string;
  deviceId?: string;
};

export async function loadAccount(): Promise<AccountState> {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin", headers: { accept: "application/json" } });
    const payload = (await response.json().catch(() => null)) as
      | { authenticated: boolean; user?: AccountUser; reason?: string; session?: { deviceId?: string } }
      | null;
    if (!payload || !payload.authenticated) {
      return { authenticated: false, user: null, reason: payload?.reason || "unauthenticated" };
    }
    return {
      authenticated: true,
      user: payload.user ?? null,
      deviceId: payload.session?.deviceId,
    };
  } catch {
    return { authenticated: false, user: null, reason: "offline" };
  }
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: "image" | "audio" | "video" | "document" | "other";
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
};

export async function loadFiles(limit = 40): Promise<DriveFile[]> {
  const response = await fetch(`/api/files?limit=${limit}&sort=updated`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "UNAUTHENTICATED" : "FILES_FAILED");
  const payload = (await response.json()) as { data?: { items?: DriveFile[] } };
  return payload.data?.items ?? [];
}

export async function uploadFile(file: File): Promise<DriveFile> {
  const response = await fetch(`/api/files/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: { file: DriveFile } }
    | { success: false; error: { message: string } }
    | null;
  if (!response.ok || !payload || payload.success === false) {
    throw new Error(payload && payload.success === false ? payload.error.message : "上传失败");
  }
  return payload.data.file;
}

export async function loadDevices(): Promise<DeviceOverview | null> {
  try {
    return await listDevices();
  } catch {
    return null;
  }
}

export async function loadInbox(): Promise<{ items: ContinuityItem[]; currentDeviceId: string } | null> {
  try {
    return await continuityApi.inbox();
  } catch {
    return null;
  }
}

export async function loadHistory(): Promise<ContinuityItem[]> {
  try {
    return (await continuityApi.history()).items;
  } catch {
    return [];
  }
}

export async function loadContexts(): Promise<ContextItem[]> {
  try {
    return (await continuityApi.contexts()).items;
  } catch {
    return [];
  }
}

export async function loadClipboard(): Promise<ClipboardItem[]> {
  try {
    return (await clipboardApi.list()).items;
  } catch {
    return [];
  }
}

/* ------------------------------ 离线队列 ------------------------------ */

type OutboxItem = {
  id: string;
  kind: "continuity" | "clipboard";
  at: number;
  attempts?: number;
  body?: Parameters<typeof continuityApi.send>[0];
  content?: string;
  targetDeviceId?: string | null;
};

const OUTBOX_KEY = "guandao.os18.outbox.v1";
/** 最多重试次数：超过后保留在队列里但不再自动重发，避免无限循环 */
const OUTBOX_MAX_ATTEMPTS = 8;

/**
 * 失败分类（纯函数，便于单元测试）。
 * - "needs-login"：401，保留队列并提示重新登录
 * - "drop"：内容或目标确实无效，重发也不会成功
 * - "retain"：超时 / 限流 / 服务端故障 / 网络错误，保留并稍后重试
 */
export function classifyOutboxFailure(status: number): "needs-login" | "drop" | "retain" {
  if (status === 401) return "needs-login";
  if (status === 408 || status === 425 || status === 429) return "retain";
  if (status >= 400 && status < 500) return "drop";
  return "retain";
}

function readOutbox(): OutboxItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(raw) ? (raw as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(0, 30)));
  } catch {
    /* 配额不足时丢弃最旧的 */
  }
}

export const outbox = {
  count: () => readOutbox().length,
  add(item: OutboxItem) {
    const items = readOutbox();
    items.push(item);
    writeOutbox(items);
  },
  /**
   * 补发离线队列。
   *
   * 1.9 修复（数据丢失）：
   * 旧实现把**所有** 4xx 当作「内容无效，重试没意义」直接丢掉，但 401（登录过期）
   * 和 408/425/429（超时 / 限流）都是可恢复的。用户离线写的东西会在重新联网
   * 且会话过期时被静默删除。
   *
   * 现在的规则：
   *   - 400/403/404/409/413/422：内容或目标确实无效 → 丢弃并计数（返回 discarded）
   *   - 401：保留在队列里，提示重新登录，登录后继续补发
   *   - 408/425/429/5xx/网络错误：保留，累计 attempts；超过上限后不再自动重发
   */
  async flush(): Promise<{ sent: number; remaining: number; discarded: number; needsLogin: boolean }> {
    const result = { sent: 0, remaining: 0, discarded: 0, needsLogin: false };
    if (!navigator.onLine) {
      result.remaining = readOutbox().length;
      return result;
    }
    const items = readOutbox();
    if (!items.length) return result;
    const remain: OutboxItem[] = [];
    for (const item of items) {
      try {
        if (item.kind === "continuity" && item.body) await continuityApi.send(item.body);
        else if (item.kind === "clipboard" && typeof item.content === "string")
          await clipboardApi.send(item.content, item.targetDeviceId);
        else {
          // 结构损坏的条目（旧版本写入）无法重发，计为丢弃
          result.discarded += 1;
          continue;
        }
        result.sent += 1;
      } catch (error) {
        const status = (error as { status?: number }).status ?? 0;
        const verdict = classifyOutboxFailure(status);
        if (verdict === "needs-login") {
          result.needsLogin = true;
          remain.push(item);
          continue;
        }
        if (verdict === "drop") {
          result.discarded += 1;
          continue;
        }
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts <= OUTBOX_MAX_ATTEMPTS) remain.push({ ...item, attempts });
        else remain.push(item);
      }
    }
    writeOutbox(remain);
    result.remaining = remain.length;
    return result;
  },
};

export function isOnline() {
  return navigator.onLine !== false;
}
