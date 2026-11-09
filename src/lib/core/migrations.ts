/**
 * Guandao OS 2.0 · 数据迁移引擎
 *
 * 2.0 最硬的约束是「不能丢用户数据」（§19）。所以迁移不是一段一次性脚本，
 * 而是一个可以重复执行、失败可停、每一步都有证据的引擎：
 *
 *   1. 先备份：备份失败直接中止，一个字节都不改；
 *   2. 再迁移：步骤按 from/to 升序执行，已执行的步骤跳过（幂等）；
 *   3. 做校验：每步可选 verify()，不通过就算失败并保留旧 schemaVersion；
 *   4. 失败不回滚用户数据：只停止后续步骤，旧数据原样保留；
 *   5. 记录 journal：每一步的开始 / 结果 / 耗时都落盘，安全中心可查。
 *
 * schemaVersion 存在 `guandao.core.migrations.v1`，与 1.x 的旧键完全分开。
 * 不依赖 DOM，可单测。
 */

import type { MigrationReport, MigrationStepReport } from "./types";
import type { StorageManager } from "./storage";

export type MigrationContext = {
  /** 只读写 2.0 命名空间；旧键通过 storage.legacyStr 只读 */
  storage: StorageManager;
  /** 结构化日志，Kernel 会接到诊断中心 */
  log: (message: string) => void;
};

export type MigrationStep = {
  id: string;
  from: number;
  to: number;
  title: string;
  /** 必须幂等：重复执行不会重复写入或破坏数据 */
  run: (context: MigrationContext) => void | Promise<void>;
  /** 迁移后校验；返回 false 视为失败 */
  verify?: (context: MigrationContext) => boolean | Promise<boolean>;
};

export type MigrationState = {
  v: 2;
  schemaVersion: number;
  applied: Record<string, { at: number; to: number }>;
  journal: Array<{ at: number; step: string; outcome: string; detail?: string }>;
};

export type MigrationEngineOptions = {
  storage: StorageManager;
  steps: MigrationStep[];
  targetVersion: number;
  /**
   * 首次运行（没有任何迁移记录）时的起始版本。
   * 全新安装应直接等于 targetVersion，避免空跑迁移；
   * 1.x 老用户应由调用方探测出 1，让迁移步骤真正执行。
   */
  initialVersion?: number | (() => number);
  /**
   * 备份实现。返回备份标识（例如 IndexedDB key）；返回 null 表示备份失败。
   * `requireBackup` 为 true 时备份失败会阻止迁移。
   */
  backup?: (from: number, to: number) => Promise<string | null> | string | null;
  requireBackup?: boolean;
  onProgress?: (step: MigrationStep, index: number, total: number) => void;
  /** 记录保留条数 */
  journalLimit?: number;
};

const STATE_KEY = "migrations.v1";

export class MigrationEngine {
  private storage: StorageManager;
  private steps: MigrationStep[];
  private target: number;
  private backupFn?: MigrationEngineOptions["backup"];
  private requireBackup: boolean;
  private onProgress?: MigrationEngineOptions["onProgress"];
  private journalLimit: number;
  private state: MigrationState;

  constructor(options: MigrationEngineOptions) {
    this.storage = options.storage;
    this.steps = [...options.steps].sort((a, b) => a.from - b.from || a.to - b.to);
    this.target = options.targetVersion;
    this.backupFn = options.backup;
    this.requireBackup = options.requireBackup ?? true;
    this.onProgress = options.onProgress;
    this.journalLimit = Math.max(10, options.journalLimit ?? 100);
    const stored = this.storage.read<MigrationState | null>(STATE_KEY, null);
    const initial =
      typeof options.initialVersion === "function" ? options.initialVersion() : (options.initialVersion ?? 1);
    this.state = stored
      ? {
          v: 2,
          schemaVersion: Number(stored.schemaVersion) || 1,
          applied: stored && typeof stored.applied === "object" && stored.applied ? stored.applied : {},
          journal: Array.isArray(stored?.journal) ? stored.journal.slice(-this.journalLimit) : [],
        }
      : {
          v: 2,
          schemaVersion: Math.max(1, Math.min(initial, this.target)),
          applied: {},
          journal: [],
        };
    // 首次运行就把起始版本写盘：下次启动不会重复探测，也不会重复迁移
    if (!stored) this.persist();
  }

  /** 当前数据 schema 版本（不是系统版本） */
  currentVersion(): number {
    return this.state.schemaVersion;
  }

  targetVersion(): number {
    return this.target;
  }

  pending(): MigrationStep[] {
    return this.steps.filter((step) => step.to > this.state.schemaVersion && !this.state.applied[step.id]);
  }

  needsMigration(): boolean {
    return this.state.schemaVersion < this.target;
  }

  journal(limit = 30): MigrationState["journal"] {
    return this.state.journal.slice(-limit).reverse();
  }

  /**
   * 执行迁移。任何一步失败都会停止后续步骤，并保留已经成功的结果
   * （因为每一步都是幂等的，下次启动可以继续）。
   */
  async run(): Promise<MigrationReport> {
    const startedAt = Date.now();
    const from = this.state.schemaVersion;
    const report: MigrationReport = {
      from,
      to: this.target,
      startedAt,
      durationMs: 0,
      applied: false,
      steps: [],
      backupKey: null,
      errors: [],
    };

    if (from >= this.target) {
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    const steps = this.pending();
    if (!steps.length) {
      // 版本落后但没有可执行步骤：说明中间版本被跳过，保持原版本并记录，绝不冒充成功
      report.errors.push(`没有可执行到 ${this.target} 的迁移步骤（当前 ${from}）`);
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    // 1. 备份
    if (this.backupFn) {
      try {
        const key = await this.backupFn(from, this.target);
        report.backupKey = key;
        if (!key && this.requireBackup) {
          report.errors.push("备份失败，已中止迁移（未修改任何用户数据）");
          this.record("backup", "failed", "备份失败");
          report.durationMs = Date.now() - startedAt;
          return report;
        }
        if (!key) this.record("backup", "skipped", "备份不可用，按配置继续");
      } catch (error) {
        report.errors.push(`备份异常：${(error as Error)?.message ?? "未知错误"}`);
        this.record("backup", "failed", report.errors[report.errors.length - 1]);
        if (this.requireBackup) {
          report.durationMs = Date.now() - startedAt;
          return report;
        }
      }
    } else if (this.requireBackup) {
      report.errors.push("未提供备份实现，已中止迁移");
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    const context: MigrationContext = {
      storage: this.storage,
      log: (message) => this.record("log", "info", message),
    };

    // 2. 逐步执行
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const stepStarted = Date.now();
      const stepReport: MigrationStepReport = {
        id: step.id,
        from: step.from,
        to: step.to,
        outcome: "skipped",
        durationMs: 0,
      };
      try {
        this.onProgress?.(step, index, steps.length);
        await step.run(context);
        if (step.verify) {
          const ok = await step.verify(context);
          if (!ok) throw new Error("迁移后校验未通过");
        }
        stepReport.outcome = "applied";
        stepReport.durationMs = Date.now() - stepStarted;
        this.state.applied[step.id] = { at: Date.now(), to: step.to };
        this.state.schemaVersion = Math.max(this.state.schemaVersion, step.to);
        this.record(step.id, "applied", `→ v${step.to}`);
        report.steps.push(stepReport);
        this.persist();
      } catch (error) {
        stepReport.outcome = "failed";
        stepReport.durationMs = Date.now() - stepStarted;
        stepReport.error = (error as Error)?.message ?? "未知错误";
        report.steps.push(stepReport);
        report.errors.push(`${step.id} 失败：${stepReport.error}`);
        this.record(step.id, "failed", stepReport.error);
        this.persist();
        break;
      }
    }

    report.applied =
      this.state.schemaVersion >= this.target && report.steps.every((step) => step.outcome !== "failed");
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  private record(step: string, outcome: string, detail?: string): void {
    this.state.journal.push({ at: Date.now(), step, outcome, ...(detail ? { detail } : {}) });
    if (this.state.journal.length > this.journalLimit) {
      this.state.journal.splice(0, this.state.journal.length - this.journalLimit);
    }
  }

  private persist(): void {
    this.storage.write(STATE_KEY, this.state);
  }
}

export const createMigrationEngine = (options: MigrationEngineOptions) => new MigrationEngine(options);