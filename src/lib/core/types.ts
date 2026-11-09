/**
 * Guandao OS 2.0 · Core 公共类型
 *
 * 这个文件只放「跨模块共享」的类型，不放实现：
 * 内核、生命周期、权限、应用注册、窗口适配都从这里取类型，
 * 避免模块之间互相 import 造成循环依赖。
 */

/* ============================================================
   生命周期
   ============================================================ */

/** 系统组件 / 插件的统一生命周期阶段（顺序即状态机顺序） */
export type LifecyclePhase = "initialize" | "start" | "activate" | "deactivate" | "suspend" | "dispose";

/** 服务当前状态。registered → initialized → started ⇄ active / suspended → disposed（失败为 failed） */
export type ServiceStatus =
  | "registered"
  | "initializing"
  | "initialized"
  | "starting"
  | "started"
  | "activating"
  | "active"
  | "deactivating"
  | "suspended"
  | "disposing"
  | "disposed"
  | "failed";

/* ============================================================
   权限主体
   ============================================================ */

/** 谁会发起需要权限的调用 */
export type PrincipalKind = "system" | "app" | "plugin" | "user";

export type Principal = {
  kind: PrincipalKind;
  /** 系统组件 id / 应用 id / 插件 id / 账号 id */
  id: string;
  /** 展示名，只用于审计日志 */
  name?: string;
};

/** 权限风险等级：高风险权限默认必须逐项确认 */
export type PermissionRisk = "low" | "mid" | "high";

/** 一次权限检查的结果 */
export type PermissionDecision = {
  allowed: boolean;
  permission: string;
  principal: Principal;
  /** 拒绝原因（allowed=true 时为空） */
  reason?: string;
  /** 命中的策略：system-bypass / granted / default-deny / not-declared / expired */
  via: "system-bypass" | "granted" | "default-deny" | "not-declared" | "blocked";
};

/* ============================================================
   应用状态与来源
   ============================================================ */

/**
 * 统一应用状态（2.0 验收标准 §4.3）。
 * 状态只能由 AppRegistry 迁移，UI 不得伪造。
 */
export type AppState =
  | "registered"
  | "installed"
  | "enabled"
  | "running"
  | "minimized"
  | "suspended"
  | "disabled"
  | "failed";

/** 应用来源：系统内置 / 市场 / 社区 / 插件 / 侧载 */
export type AppSource = "system" | "market" | "community" | "plugin" | "sideload";

/** 信任状态：系统与人工审核过的资源才允许免确认安装 */
export type TrustLevel = "trusted" | "reviewed" | "unverified" | "blocked";

/* ============================================================
   运行模式与云端
   ============================================================ */

/** Local Mode：不登录也能完整使用本地桌面；Cloud Mode：登录后启用同步与云端能力 */
export type CoreMode = "local" | "cloud";

/** 依赖探测结果。unknown 表示「真的不知道」，绝不伪装成 ok */
export type HealthState = "ok" | "degraded" | "down" | "unknown";

export type HealthReport = {
  id: string;
  label: string;
  state: HealthState;
  /** 真实耗时；没有发起探测时为 null */
  latencyMs: number | null;
  /** 探测细节，直接展示给诊断中心 */
  detail: string;
  at: number;
};

/* ============================================================
   启动
   ============================================================ */

export type BootStageId =
  | "config"
  | "storage"
  | "events"
  | "windows"
  | "apps"
  | "device"
  | "auth"
  | "cloud"
  | "layout"
  | "widgets"
  | "shell";

export type BootStageReport = {
  id: BootStageId;
  label: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  /** 该阶段可选的补充说明（例如离线时说明云端被跳过） */
  detail?: string;
};

export type BootReport = {
  version: string;
  mode: CoreMode;
  startedAt: number;
  durationMs: number;
  stages: BootStageReport[];
  offline: boolean;
  degraded: string[];
};

/* ============================================================
   迁移
   ============================================================ */

export type MigrationOutcome = "applied" | "skipped" | "failed" | "verified";

export type MigrationStepReport = {
  id: string;
  from: number;
  to: number;
  outcome: MigrationOutcome;
  durationMs: number;
  detail?: string;
  error?: string;
};

export type MigrationReport = {
  from: number;
  to: number;
  startedAt: number;
  durationMs: number;
  applied: boolean;
  steps: MigrationStepReport[];
  backupKey: string | null;
  errors: string[];
};