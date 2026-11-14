/**
 * Guandao OS 1.9 · 统一在线状态
 *
 * 状态模型（两个维度，不要混成一个）：
 *   网络：online / offline / reconnecting
 *   同步：idle / pending / syncing / failed
 *
 * 界面显示的是二者的组合：
 *   Online · 已同步 / Offline · 本地可编辑 / Reconnecting… / Sync Pending / Sync Failed
 *
 * 断网时的约定：
 *   - 本地编辑能力保留，输入不清空；
 *   - 待同步队列不清空；
 *   - 联网后重新触发同步引擎（由 sync 模块订阅 recovered 事件）。
 */

import { createScope } from "./resources";

export type NetworkState = "online" | "offline" | "reconnecting";
export type SyncState = "idle" | "pending" | "syncing" | "failed";

export interface ConnectivitySnapshot {
  network: NetworkState;
  sync: SyncState;
  /** 最近一次网络状态变化时间 */
  changedAt: number;
  /** 最近一次同步失败信息（脱敏后的简述） */
  lastSyncError: string;
  /** 待同步条目数（由同步队列上报） */
  pendingCount: number;
  /** 浏览器是否支持 navigator.onLine 探测 */
  supported: boolean;
  /** 组合后的用户可读标签 */
  label: string;
  description: string;
}

type Listener = (snapshot: ConnectivitySnapshot) => void;

const state = {
  network: "online" as NetworkState,
  sync: "idle" as SyncState,
  changedAt: Date.now(),
  lastSyncError: "",
  pendingCount: 0,
  listening: false,
};

const listeners = new Set<Listener>();
const scope = createScope("connectivity");
let reconnectDisposer: (() => void) | null = null;

function networkSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.onLine === "boolean";
}

export function connectivityLabel(): { label: string; description: string } {
  if (state.network === "offline") {
    return {
      label: state.pendingCount > 0 ? "离线 · 待同步" : "离线",
      description: "本地改动会保留在这台设备上，联网后自动同步。",
    };
  }
  if (state.network === "reconnecting") {
    return { label: "正在重新连接…", description: "网络刚恢复，正在确认服务端可用性。" };
  }
  if (state.sync === "failed") {
    return { label: "同步失败", description: state.lastSyncError || "同步过程中出现问题，本地数据没有丢失。" };
  }
  if (state.sync === "syncing") return { label: "正在同步…", description: "正在把本地改动写入云端。" };
  if (state.sync === "pending" || state.pendingCount > 0) {
    return { label: "待同步", description: `${state.pendingCount || "若干"} 项本地改动等待上传。` };
  }
  return { label: "在线 · 已同步", description: "所有本地改动都已保存。" };
}

export function connectivitySnapshot(): ConnectivitySnapshot {
  const { label, description } = connectivityLabel();
  return {
    network: state.network,
    sync: state.sync,
    changedAt: state.changedAt,
    lastSyncError: state.lastSyncError,
    pendingCount: state.pendingCount,
    supported: networkSupported(),
    label,
    description,
  };
}

function emit(): void {
  const snapshot = connectivitySnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      /* 订阅方异常不影响状态机 */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("guandao:connectivity", { detail: snapshot }));
  }
}

/** 初始化：监听 online / offline，幂等 */
export function initConnectivity(): void {
  if (state.listening || typeof window === "undefined") return;
  state.listening = true;

  state.network = networkSupported() && !navigator.onLine ? "offline" : "online";

  scope.on(window, "offline", () => {
    state.network = "offline";
    state.changedAt = Date.now();
    if (reconnectDisposer) {
      reconnectDisposer();
      reconnectDisposer = null;
    }
    emit();
  });

  scope.on(window, "online", () => {
    // 先标记「重连中」，再让调用方确认服务端可达
    state.network = "reconnecting";
    state.changedAt = Date.now();
    emit();
    if (reconnectDisposer) reconnectDisposer();
    reconnectDisposer = scope.timeout(() => {
      reconnectDisposer = null;
      // 3 秒内没有调用过 confirmOnline，就视为已恢复
      if (state.network === "reconnecting") {
        state.network = "online";
        emit();
      }
    }, 3000);
  });

  emit();
}

/** 主动确认服务端可达（同步成功后调用） */
export function confirmOnline(): void {
  if (state.network === "online") return;
  state.network = "online";
  state.changedAt = Date.now();
  emit();
}

/** 上报同步队列状态 */
export function reportSync(patch: { sync?: SyncState; pendingCount?: number; error?: string }): void {
  let changed = false;
  if (patch.sync && patch.sync !== state.sync) {
    state.sync = patch.sync;
    changed = true;
  }
  if (typeof patch.pendingCount === "number" && patch.pendingCount !== state.pendingCount) {
    state.pendingCount = Math.max(0, patch.pendingCount);
    changed = true;
  }
  if (patch.error !== undefined) {
    state.lastSyncError = patch.error;
    changed = true;
  }
  if (patch.sync === "failed" && !patch.error && !state.lastSyncError) {
    state.lastSyncError = "同步过程中出现问题。";
  }
  if (patch.sync === "idle") state.lastSyncError = "";
  if (changed) {
    state.changedAt = Date.now();
    emit();
  }
}

/** 是否允许发出会写数据的请求（离线时应当只改本地队列） */
export function canReachCloud(): boolean {
  return state.network === "online";
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  listener(connectivitySnapshot());
  return () => listeners.delete(listener);
}

/** 仅用于测试：重置状态机 */
export function resetConnectivity(): void {
  state.network = "online";
  state.sync = "idle";
  state.changedAt = Date.now();
  state.lastSyncError = "";
  state.pendingCount = 0;
  state.listening = false;
  if (reconnectDisposer) {
    reconnectDisposer();
    reconnectDisposer = null;
  }
  listeners.clear();
}