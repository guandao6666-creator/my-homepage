/**
 * Guandao OS 2.0 · 通知管理器
 *
 * 1.x 的通知直接写 localStorage（`guandao.os.notif.v1`）再调一个 render 函数。
 * 2.0 需要：
 *   - 一个统一入口（应用 / 插件 / 系统事件都走这里）；
 *   - 勿扰模式真的生效；
 *   - 未读数与历史可查；
 *   - 与 1.x 的通知中心共用同一份数据，避免两套通知。
 *
 * 所以这里**复用旧键**，不新建存储：写回原来的数组格式，
 * 这样通知中心 / 菜单栏红点看到一个一致的世界。
 *
 * 不依赖 DOM：UI 刷新通过注入的 `onChange` 完成。
 */

import type { KeyValueStore } from "./storage";

export const LEGACY_NOTIF_KEY = "guandao.os.notif.v1";
const MAX_ITEMS = 40;

export type Notification = {
  id: string;
  icon: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
  /** 2.0：来源，用于排序与「只清理应用通知」 */
  source?: string;
  /** 2.0：点击后打开的应用 */
  appId?: string;
};

export type NotificationInput = {
  title: string;
  body: string;
  icon?: string;
  source?: string;
  appId?: string;
  /** 高优先级会忽略部分静默策略（但勿扰仍然优先） */
  priority?: "normal" | "high";
};

export type NotificationManagerOptions = {
  /** 直接给底层存储，便于测试；浏览器里传 localStorage 的包装 */
  store: KeyValueStore;
  /** 通知提交后回调（UI 刷新 / 红点） */
  onChange?: (list: Notification[]) => void;
  /** 勿扰模式判定；返回 true 时通知仍然入库但标记已读、不回调 onDeliver */
  isDnd?: () => boolean;
  /** 「弹出」回调：桌面实现里对应 pushNotif 的视觉提示 */
  onDeliver?: (notification: Notification) => void;
  now?: () => number;
};

const uid = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 忽略 */
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

export class NotificationManager {
  private store: KeyValueStore;
  private onChange?: (list: Notification[]) => void;
  private isDnd: () => boolean;
  private onDeliver?: (notification: Notification) => void;
  private now: () => number;
  private cache: Notification[] | null = null;

  constructor(options: NotificationManagerOptions) {
    this.store = options.store;
    this.onChange = options.onChange;
    this.isDnd = options.isDnd ?? (() => false);
    this.onDeliver = options.onDeliver;
    this.now = options.now ?? (() => Date.now());
  }

  list(): Notification[] {
    if (this.cache) return this.cache.map((item) => ({ ...item }));
    let parsed: unknown = null;
    try {
      const raw = this.store.getItem(LEGACY_NOTIF_KEY);
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      parsed = [];
    }
    const list = Array.isArray(parsed) ? (parsed as Notification[]).filter((item) => item && typeof item === "object") : [];
    this.cache = list.slice(0, MAX_ITEMS).map((item) => ({
      id: String(item.id ?? uid()),
      icon: String(item.icon ?? "•"),
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      at: Number(item.at) || this.now(),
      read: Boolean(item.read),
      ...(item.source ? { source: String(item.source) } : {}),
      ...(item.appId ? { appId: String(item.appId) } : {}),
    }));
    return this.cache.map((item) => ({ ...item }));
  }

  /**
   * 提交一条通知。
   * 勿扰模式下依然记录（不丢信息），但标记为已读并且不触发弹出回调。
   */
  post(input: NotificationInput): Notification {
    const dnd = this.safeDnd();
    const notification: Notification = {
      id: uid(),
      icon: input.icon ?? "•",
      title: input.title.slice(0, 80),
      body: input.body.slice(0, 240),
      at: this.now(),
      read: dnd,
      ...(input.source ? { source: input.source.slice(0, 40) } : {}),
      ...(input.appId ? { appId: input.appId.slice(0, 64) } : {}),
    };

    const list = [notification, ...this.list()].slice(0, MAX_ITEMS);
    this.write(list);

    if (!dnd) {
      try {
        this.onDeliver?.(notification);
      } catch {
        /* 视觉提示失败不能影响通知入库 */
      }
    }
    return { ...notification };
  }

  markAllRead(): number {
    const list = this.list();
    const unread = list.filter((item) => !item.read).length;
    if (!unread) return 0;
    this.write(list.map((item) => ({ ...item, read: true })));
    return unread;
  }

  markRead(id: string): void {
    const list = this.list();
    if (!list.some((item) => item.id === id && !item.read)) return;
    this.write(list.map((item) => (item.id === id ? { ...item, read: true } : item)));
  }

  remove(id: string): void {
    const list = this.list().filter((item) => item.id !== id);
    this.write(list);
  }

  clear(): void {
    this.write([]);
  }

  unreadCount(): number {
    return this.list().filter((item) => !item.read).length;
  }

  bySource(source: string): Notification[] {
    return this.list().filter((item) => item.source === source);
  }

  /** 数据导出 / 诊断用 */
  stats(): { total: number; unread: number; sources: number; newestAt: number | null } {
    const list = this.list();
    return {
      total: list.length,
      unread: list.filter((item) => !item.read).length,
      sources: new Set(list.map((item) => item.source ?? "system")).size,
      newestAt: list[0]?.at ?? null,
    };
  }

  /* ---------------- 内部 ---------------- */

  private safeDnd(): boolean {
    try {
      return Boolean(this.isDnd());
    } catch {
      return false;
    }
  }

  private write(list: Notification[]): void {
    this.cache = list.slice(0, MAX_ITEMS);
    try {
      this.store.setItem(LEGACY_NOTIF_KEY, JSON.stringify(this.cache));
    } catch {
      /* 隐私模式 / 配额满：内存里仍然可用 */
    }
    try {
      this.onChange?.(this.list());
    } catch {
      /* 忽略 */
    }
    // 1.x 的桌面红点监听的是这个事件
    try {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("guandao:notif-change"));
    } catch {
      /* 忽略 */
    }
  }
}

export const createNotifications = (options: NotificationManagerOptions) => new NotificationManager(options);