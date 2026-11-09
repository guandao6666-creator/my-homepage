/**
 * Guandao OS 2.0 · 统一生命周期
 *
 * 系统组件（Kernel / Storage / Permission / Cloud …）与插件都按同一套阶段运行：
 *
 *   initialize  只读准备：读配置、建索引，不产生副作用
 *   start       开始工作：订阅事件、注册路由
 *   activate    进入前台（窗口可见 / 模式切换为当前）
 *   deactivate  离开前台（窗口隐藏）
 *   suspend     挂起：释放昂贵资源，保留状态
 *   dispose     销毁：取消监听、清定时器、关闭连接
 *
 * 约束：
 *   - 依赖先启动、后销毁（`requires` 拓扑排序）；
 *   - 任何一个组件失败都不阻断其余组件（错误隔离）；
 *   - 标记 `critical` 的组件失败会记入降级列表，由 Kernel 决定是否继续；
 *   - 每个阶段都有超时，卡死的组件不会把整个启动流程拖住。
 *
 * 这个模块不触碰 DOM，可在 Node 里单测。
 */

import type { LifecyclePhase, ServiceStatus } from "./types";

export type LifecycleHooks = {
  initialize?: () => void | Promise<void>;
  start?: () => void | Promise<void>;
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  suspend?: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

export type ServiceDefinition = {
  id: string;
  /** 展示名，诊断中心直接显示 */
  title: string;
  /** 必须先启动的服务 id */
  requires?: string[];
  /**
   * 关键服务：失败时进入 degraded 列表。
   * 非关键服务失败只标记为 failed，不影响桌面启动。
   */
  critical?: boolean;
  hooks: LifecycleHooks;
};

export type ServiceRecord = {
  id: string;
  title: string;
  status: ServiceStatus;
  critical: boolean;
  requires: string[];
  startedAt: number | null;
  durationMs: number | null;
  phaseDurations: Partial<Record<LifecyclePhase, number>>;
  error: string | null;
};

export type HostOptions = {
  /** 单阶段超时（毫秒）。默认 8 秒；超时视为失败。 */
  phaseTimeoutMs?: number;
  /** 日志回调：Kernel 会接上诊断中心 */
  onEvent?: (event: ServiceEvent) => void;
};

export type ServiceEvent = {
  type: "register" | "phase" | "failed" | "disposed";
  id: string;
  phase?: LifecyclePhase;
  durationMs?: number;
  error?: string;
};

const PHASE_TIMEOUT = 8000;

const message = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
};

export class ServiceHost {
  private definitions = new Map<string, ServiceDefinition>();
  private records = new Map<string, ServiceRecord>();
  private options: Required<Omit<HostOptions, "onEvent">> & Pick<HostOptions, "onEvent">;

  constructor(options: HostOptions = {}) {
    this.options = {
      phaseTimeoutMs: options.phaseTimeoutMs ?? PHASE_TIMEOUT,
      onEvent: options.onEvent,
    };
  }

  register(definition: ServiceDefinition): void {
    if (!definition.id) throw new Error("服务必须有 id");
    if (this.definitions.has(definition.id)) throw new Error(`服务 ${definition.id} 已经注册过`);
    this.definitions.set(definition.id, { ...definition, requires: definition.requires ?? [] });
    this.records.set(definition.id, {
      id: definition.id,
      title: definition.title,
      status: "registered",
      critical: Boolean(definition.critical),
      requires: definition.requires ?? [],
      startedAt: null,
      durationMs: null,
      phaseDurations: {},
      error: null,
    });
    this.emit({ type: "register", id: definition.id });
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  status(id: string): ServiceStatus | null {
    return this.records.get(id)?.status ?? null;
  }

  isReady(id: string): boolean {
    const status = this.records.get(id)?.status;
    return status === "started" || status === "active" || status === "suspended";
  }

  list(): ServiceRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      phaseDurations: { ...record.phaseDurations },
    }));
  }

  failures(): ServiceRecord[] {
    return this.list().filter((record) => record.status === "failed");
  }

  /**
   * 按依赖顺序启动全部服务。
   * 依赖不存在 / 成环时只影响相关服务，其余照常启动。
   */
  async startAll(): Promise<{ started: string[]; failed: string[]; skipped: string[] }> {
    const order = this.resolveOrder();
    const started: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    for (const entry of order) {
      if (entry.error) {
        this.markFailed(entry.id, entry.error);
        failed.push(entry.id);
        continue;
      }
      const record = this.records.get(entry.id);
      const definition = this.definitions.get(entry.id);
      if (!record || !definition) continue;

      const blockedBy = definition.requires?.find((dep) => {
        const status = this.records.get(dep)?.status;
        return status === "failed" || status === "disposed";
      });
      if (blockedBy) {
        record.status = "failed";
        record.error = `依赖 ${blockedBy} 启动失败`;
        skipped.push(entry.id);
        this.emit({ type: "failed", id: entry.id, error: record.error });
        continue;
      }

      const at = Date.now();
      record.startedAt = at;
      const ok = await this.runPhase(record, definition, "initialize");
      if (!ok) {
        failed.push(entry.id);
        continue;
      }
      record.status = "initialized";
      if (!(await this.runPhase(record, definition, "start"))) {
        failed.push(entry.id);
        continue;
      }
      record.status = "started";
      record.durationMs = Date.now() - at;
      started.push(entry.id);
    }

    return { started, failed, skipped };
  }

  /** 进入前台；服务未启动时先启动它 */
  async activate(id: string): Promise<boolean> {
    const definition = this.definitions.get(id);
    const record = this.records.get(id);
    if (!definition || !record) return false;
    if (record.status === "disposed" || record.status === "failed") return false;
    if (record.status === "registered") {
      if (!(await this.runPhase(record, definition, "start"))) return false;
      record.status = "started";
    }
    if (!(await this.runPhase(record, definition, "activate"))) return false;
    record.status = "active";
    return true;
  }

  async deactivate(id: string): Promise<boolean> {
    const definition = this.definitions.get(id);
    const record = this.records.get(id);
    if (!definition || !record) return false;
    if (record.status !== "active") return false;
    if (!(await this.runPhase(record, definition, "deactivate"))) return false;
    record.status = "started";
    return true;
  }

  async suspend(id: string): Promise<boolean> {
    const definition = this.definitions.get(id);
    const record = this.records.get(id);
    if (!definition || !record) return false;
    if (record.status === "disposed" || record.status === "failed") return false;
    if (!(await this.runPhase(record, definition, "suspend"))) return false;
    record.status = "suspended";
    return true;
  }

  async dispose(id: string): Promise<boolean> {
    const definition = this.definitions.get(id);
    const record = this.records.get(id);
    if (!definition || !record) return false;
    if (record.status === "disposed") return true;
    record.status = "disposing";
    const ok = await this.runPhase(record, definition, "dispose");
    record.status = "disposed";
    this.emit({ type: "disposed", id, error: ok ? undefined : record.error ?? undefined });
    return ok;
  }

  /** 逆序销毁（依赖者先销毁） */
  async disposeAll(): Promise<string[]> {
    const order = this.resolveOrder()
      .filter((entry) => !entry.error)
      .map((entry) => entry.id)
      .reverse();
    const done: string[] = [];
    for (const id of order) {
      const record = this.records.get(id);
      if (!record || record.status === "registered" || record.status === "disposed") continue;
      await this.dispose(id);
      done.push(id);
    }
    return done;
  }

  /* ---------------- 内部 ---------------- */

  private async runPhase(
    record: ServiceRecord,
    definition: ServiceDefinition,
    phase: LifecyclePhase,
  ): Promise<boolean> {
    const hook = definition.hooks[phase];
    if (!hook) return true;
    const started = Date.now();
    try {
      await this.withTimeout(hook(), this.options.phaseTimeoutMs, `${definition.id}.${phase}`);
      record.phaseDurations[phase] = Date.now() - started;
      record.error = null;
      this.emit({ type: "phase", id: definition.id, phase, durationMs: Date.now() - started });
      return true;
    } catch (error) {
      record.phaseDurations[phase] = Date.now() - started;
      this.markFailed(definition.id, `${phase} 失败：${message(error)}`, phase);
      return false;
    }
  }

  private markFailed(id: string, error: string, phase?: LifecyclePhase): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = "failed";
    record.error = error;
    this.emit({ type: "failed", id, error, phase });
  }

  private withTimeout(value: void | Promise<void>, timeoutMs: number, label: string): Promise<void> {
    if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(value);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();

      Promise.resolve(value).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
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

  /**
   * 拓扑排序。缺失依赖不会整体失败：缺失依赖在启动时按「未启动」处理，
   * 成环则把环上的服务标记为失败，其余服务照常排序。
   */
  private resolveOrder(): Array<{ id: string; error?: string }> {
    const order: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const errors = new Map<string, string>();
    const stack: string[] = [];

    const visit = (id: string): void => {
      const current = state.get(id);
      if (current === "done") return;
      if (current === "visiting") {
        // 成环：把环上的每个成员都标记为失败，避免只标记其中一个
        const start = stack.lastIndexOf(id);
        const cycle = [...stack.slice(start >= 0 ? start : 0), id];
        const message = `依赖成环：${cycle.join(" → ")}`;
        for (const member of cycle) errors.set(member, message);
        return;
      }

      const definition = this.definitions.get(id);
      if (!definition) {
        errors.set(id, `缺少依赖服务 ${id}`);
        return;
      }

      state.set(id, "visiting");
      stack.push(id);
      for (const dep of definition.requires ?? []) visit(dep);
      stack.pop();
      state.set(id, "done");
      if (!errors.has(id)) order.push(id);
    };

    for (const id of this.definitions.keys()) visit(id);

    const out: Array<{ id: string; error?: string }> = order.map((id) => ({ id }));
    for (const [id, error] of errors) out.push({ id, error });
    return out;
  }

  private emit(event: ServiceEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* 日志回调失败不能影响生命周期 */
    }
  }
}

export const createServiceHost = (options?: HostOptions) => new ServiceHost(options);