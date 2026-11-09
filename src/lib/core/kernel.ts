/**
 * Guandao OS 2.0 · Kernel（统一内核）
 *
 * Kernel 不负责画界面，它负责「把系统按正确顺序启动起来，并把每个模块的
 * 状态留成可查的证据」。职责边界：
 *
 *   Bus          事件总线（错误隔离）
 *   Storage      命名空间 + 版本信封 + 配额
 *   Settings     带 Schema 的统一设置
 *   Permissions  默认拒绝的权限判定与审计
 *   Registry     应用状态机
 *   Notifications 统一通知入口（复用 1.x 的键）
 *   Device       本地设备档案（不冒充服务端设备）
 *   Cloud        登录 / 离线 / 健康探测
 *   Sync         可插拔同步引擎（无数据域时如实显示未接入）
 *   Services     统一生命周期（initialize/start/activate/…/dispose）
 *
 * 启动顺序（§2.2）：
 *   config → storage → events → windows → apps → device → auth → cloud
 *   → layout → widgets → shell
 *
 * 关键约束：
 *   - 云端不可用不阻塞本地桌面；
 *   - 任何一个阶段失败都不删除本地数据；
 *   - 每个阶段都有超时，坏掉的一个阶段不会把整个启动流程卡死；
 *   - 启动结果是一份 BootReport，诊断中心直接展示。
 *
 * 不依赖 DOM，可单测（阶段由调用方注入）。
 */

import { createBus, type EventBus } from "./bus";
import { createStorage, browserStore, type KeyValueStore, type StorageManager } from "./storage";
import { createSettings, type SettingsManager } from "./settings";
import { createPermissions, type PermissionManager } from "./permissions";
import { createAppRegistry, type AppRegistry } from "./registry";
import { createNotifications, type NotificationManager } from "./notifications";
import { createDeviceManager, type DeviceManager } from "./device";
import { createCloudService, type CloudServiceManager } from "./cloud";
import { createSyncEngine, type SyncEngine } from "./sync";
import { createServiceHost, type HostOptions as ServiceHostOptions, type ServiceHost } from "./service";
import type { BootReport, BootStageId, BootStageReport, CoreMode } from "./types";
import type { WindowManager } from "./windows";
import type { AppRuntime } from "./runtime";

/** 阶段实现可以返回 { skipped: true } 表示「本次不适用」，而不是失败 */
export type StageResult = void | { skipped: true; detail?: string };

export type StageHandler = () => StageResult | Promise<StageResult>;

export type StageDefinition = {
  id: BootStageId;
  label: string;
  /** 该阶段失败是否允许继续（目前全部允许，标记只为报告语义） */
  required?: boolean;
  timeoutMs?: number;
};

export const BOOT_STAGES: StageDefinition[] = [
  { id: "config", label: "初始化核心配置", required: true, timeoutMs: 3000 },
  { id: "storage", label: "初始化本地存储并校验数据", required: true, timeoutMs: 8000 },
  { id: "events", label: "初始化系统事件", required: true, timeoutMs: 2000 },
  { id: "windows", label: "初始化窗口管理器", required: true, timeoutMs: 4000 },
  { id: "apps", label: "初始化应用注册中心", required: true, timeoutMs: 6000 },
  { id: "device", label: "识别本地设备", timeoutMs: 3000 },
  { id: "auth", label: "检查身份与会话", timeoutMs: 5000 },
  { id: "cloud", label: "检查云端服务", timeoutMs: 4000 },
  { id: "layout", label: "恢复桌面布局", timeoutMs: 5000 },
  { id: "widgets", label: "加载已启用的组件", timeoutMs: 5000 },
  { id: "shell", label: "进入 Desktop Shell", required: true, timeoutMs: 6000 },
];

export type KernelOptions = {
  version: string;
  releaseName?: string;
  /** 注入存储（测试用内存实现） */
  store?: KeyValueStore | null;
  /** 是否把事件桥接到 window 的 guandao:* 事件 */
  bridgeToWindow?: boolean;
  /** 诊断日志回调 */
  onLog?: (event: { type: string; message: string; detail?: unknown }) => void;
  /** 生命周期宿主配置 */
  serviceHost?: ServiceHostOptions;
};

const now = () => Date.now();

export class Kernel {
  readonly bus: EventBus;
  readonly storage: StorageManager;
  readonly settings: SettingsManager;
  readonly permissions: PermissionManager;
  readonly registry: AppRegistry;
  readonly notifications: NotificationManager;
  readonly device: DeviceManager;
  readonly cloud: CloudServiceManager;
  readonly sync: SyncEngine;
  readonly services: ServiceHost;
  readonly version: string;
  readonly releaseName: string;

  private windowsRef: WindowManager | null = null;
  private runtimeRef: AppRuntime | null = null;
  private report: BootReport | null = null;
  private phase: "idle" | "booting" | "ready" | "degraded" | "disposed" = "idle";
  private logFn: (event: { type: string; message: string; detail?: unknown }) => void;
  private stageListeners = new Set<(report: BootStageReport, index: number, total: number) => void>();

  constructor(options: KernelOptions) {
    this.version = options.version;
    this.releaseName = options.releaseName ?? "The Platform Era";
    this.logFn = options.onLog ?? (() => undefined);

    const store = options.store === undefined ? browserStore() : options.store;

    this.bus = createBus({
      name: "guandao-core",
      bridgeToWindow: options.bridgeToWindow ?? false,
      onError: (info) => this.log({ type: "bus-error", message: `事件 ${info.type} 的订阅者抛错`, detail: info.error }),
    });

    this.storage = createStorage({
      namespace: "guandao.core",
      store,
      version: 2,
      onWarn: (info) => this.log({ type: "storage-warn", message: `${info.key}：${info.message}` }),
    });

    this.settings = createSettings({
      storage: this.storage,
      emit: (type, payload) => this.bus.emit(type, payload),
    });

    this.permissions = createPermissions({
      storage: this.storage,
      emit: (type, payload) => this.bus.emit(type, payload),
    });

    this.registry = createAppRegistry({
      storage: this.storage,
      emit: (type, payload) => this.bus.emit(type, payload),
      osVersion: this.version,
    });

    const rawStore = this.storage.activeStore;
    // 通知与设备档案沿用 1.x 的键，这样通知中心 / 设备信息不会出现两个版本
    this.notifications = createNotifications({
      store: rawStore,
      isDnd: () => Boolean(this.settings.get("notifications.dnd")),
      onDeliver: (notification) => this.bus.emit("notification:delivered", notification),
      onChange: (list) => this.bus.emit("notification:change", { count: list.length }),
    });

    this.device = createDeviceManager({ store: rawStore });

    this.cloud = createCloudService({
      mode: () => (this.settings.get("system.mode") === "cloud" ? "cloud" : "local"),
      emit: (type, payload) => this.bus.emit(type, payload),
    });

    this.sync = createSyncEngine({ emit: (type, payload) => this.bus.emit(type, payload) });

    this.services = createServiceHost({
      ...(options.serviceHost ?? {}),
      onEvent: (event) => {
        if (event.type === "failed") {
          this.log({ type: "service-failed", message: `${event.id} 失败：${event.error ?? ""}`, detail: event });
        }
        this.bus.emit(`service:${event.type}`, event);
      },
    });

    this.bus.on("permission:denied", (payload) => {
      this.log({ type: "permission-denied", message: "权限请求被拒绝", detail: payload });
    });
  }

  /* ---------------- 依赖注入 ---------------- */

  attachWindows(windows: WindowManager): void {
    this.windowsRef = windows;
  }

  attachRuntime(runtime: AppRuntime): void {
    this.runtimeRef = runtime;
  }

  get windows(): WindowManager | null {
    return this.windowsRef;
  }

  get runtime(): AppRuntime | null {
    return this.runtimeRef;
  }

  /* ---------------- 启动 ---------------- */

  onStage(listener: (report: BootStageReport, index: number, total: number) => void): () => void {
    this.stageListeners.add(listener);
    return () => this.stageListeners.delete(listener);
  }

  /**
   * 执行启动。
   * `handlers` 是调用方提供的阶段实现；没有实现的阶段记为 skipped。
   */
  async boot(handlers: Partial<Record<BootStageId, StageHandler>>, stages: StageDefinition[] = BOOT_STAGES): Promise<BootReport> {
    if (this.phase === "booting") throw new Error("内核已经在启动中");
    const startedAt = now();
    this.phase = "booting";

    const reports: BootStageReport[] = [];
    const degraded: string[] = [];

    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const handler = handlers[stage.id];
      const stageStarted = now();

      if (!handler) {
        const skipped: BootStageReport = {
          id: stage.id,
          label: stage.label,
          status: "skipped",
          durationMs: 0,
          detail: "本次启动未提供该阶段实现",
        };
        reports.push(skipped);
        this.publishStage(skipped, index, stages.length);
        continue;
      }

      this.bus.emit("boot:stage:begin", { id: stage.id, label: stage.label });
      try {
        const outcome = await this.withTimeout<StageResult>(handler(), stage.timeoutMs ?? 8000, stage.label);
        const skipped = Boolean(outcome && typeof outcome === "object" && outcome.skipped);
        const report: BootStageReport = {
          id: stage.id,
          label: stage.label,
          status: skipped ? "skipped" : "ok",
          durationMs: now() - stageStarted,
          ...(skipped && outcome && typeof outcome === "object" && outcome.detail ? { detail: outcome.detail } : {}),
        };
        reports.push(report);
        this.publishStage(report, index, stages.length);
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        const report: BootStageReport = {
          id: stage.id,
          label: stage.label,
          status: "failed",
          durationMs: now() - stageStarted,
          error: message,
        };
        reports.push(report);
        degraded.push(`${stage.label}：${message}`);
        this.log({ type: "boot-stage-failed", message: `${stage.label} 失败`, detail: error });
        this.publishStage(report, index, stages.length);
        // 云端 / 认证类阶段失败不阻塞本地桌面（§2.2）
      }
    }

    const mode: CoreMode = this.settings.get("system.mode") === "cloud" ? "cloud" : "local";
    this.report = {
      version: this.version,
      mode,
      startedAt,
      durationMs: now() - startedAt,
      stages: reports,
      offline: !this.cloud.state().online,
      degraded,
    };
    this.phase = degraded.length ? "degraded" : "ready";
    this.bus.emit("boot:done", this.report);
    return this.report;
  }

  /** 启动结果；还没启动过时返回 null */
  bootReport(): BootReport | null {
    return this.report ? { ...this.report, stages: this.report.stages.map((stage) => ({ ...stage })) } : null;
  }

  status(): {
    phase: string;
    version: string;
    ready: boolean;
    degraded: string[];
    storageAvailable: boolean;
    mode: CoreMode;
    services: ReturnType<ServiceHost["list"]>;
  } {
    return {
      phase: this.phase,
      version: this.version,
      ready: this.phase === "ready" || this.phase === "degraded",
      degraded: this.report?.degraded ?? [],
      storageAvailable: this.storage.available,
      mode: this.settings.get("system.mode") === "cloud" ? "cloud" : "local",
      services: this.services.list(),
    };
  }

  /** 运行时切换模式：只改变云端行为，绝不清理本地数据 */
  setMode(mode: CoreMode): void {
    this.settings.update({ "system.mode": mode });
    this.cloud.setMode(mode);
    this.bus.emit("system:mode", { mode });
  }

  async dispose(): Promise<void> {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    try {
      this.runtimeRef?.dispose();
      this.windowsRef?.dispose();
      this.cloud.dispose();
      await this.services.disposeAll();
    } finally {
      this.bus.emit("kernel:disposed", {});
      this.bus.clear();
    }
  }

  /* ---------------- 内部 ---------------- */

  private publishStage(report: BootStageReport, index: number, total: number): void {
    // 让启动界面能拿到真实阶段进度（index / total 而不是估算值）
    this.bus.emit("boot:stage:done", { ...report, index, total });
    for (const listener of [...this.stageListeners]) {
      try {
        listener(report, index, total);
      } catch {
        /* UI 回调失败不能影响启动 */
      }
    }
  }

  private log(event: { type: string; message: string; detail?: unknown }): void {
    try {
      this.logFn(event);
    } catch {
      /* 忽略 */
    }
  }

  private withTimeout<T>(value: T | Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();
      Promise.resolve(value).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

export const createKernel = (options: KernelOptions) => new Kernel(options);