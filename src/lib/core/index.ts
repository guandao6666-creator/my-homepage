/**
 * Guandao OS 2.0 · Core 公共入口
 *
 * 外部模块（系统应用、插件桥接、诊断、测试）只从这里取 Core 能力，
 * 不直接 import 内部实现文件。这样后续拆分 / 重命名模块时，
 * 调用方只需要跟进一个文件。
 *
 * 稳定性：`core@1`（随 Guandao OS 2.x 保持兼容）。
 */

export { createKernel, Kernel, BOOT_STAGES } from "./kernel";
export type { KernelOptions, StageDefinition, StageHandler, StageResult } from "./kernel";

export { createBus, EventBus } from "./bus";
export type { BusHandler, BusOptions } from "./bus";

export { createServiceHost, ServiceHost } from "./service";
export type { LifecycleHooks, ServiceDefinition, ServiceRecord } from "./service";

export { createStorage, MemoryStore, browserStore } from "./storage";
export type { KeyValueStore, StorageManager, StorageManagerOptions } from "./storage";

export { createSettings, SETTINGS_SCHEMA, SETTINGS_BY_ID } from "./settings";
export type { SettingField, SettingValue, SettingsValues } from "./settings";

export {
  createPermissions,
  CORE_PERMISSIONS,
  PERMISSION_BY_ID,
  PermissionError,
  appPrincipal,
  pluginPrincipal,
  systemPrincipal,
} from "./permissions";
export type { AuditEntry, PermissionDefinition } from "./permissions";

export { createAppRegistry, AppRegistry } from "./registry";
export type { AppRecord, RegisterOptions, RegisterResult } from "./registry";

export { createAppRuntime, AppRuntime } from "./runtime";
export type { LaunchResult } from "./runtime";

export { createWindowManager, WindowManager } from "./windows";
export type { OpenWindow, SpaceInfo, WindowShell } from "./windows";

export {
  clampRect,
  fitRect,
  snapRect,
  splitRects,
  rescaleSnapshot,
  normalizeSnapshot,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from "./layout";
export type { Rect, SnapZone, Viewport, WindowState, WorkspaceSnapshot } from "./layout";

export { createMigrationEngine, MigrationEngine } from "./migrations";
export type { MigrationStep, MigrationContext, MigrationState } from "./migrations";

export { validateAppManifest, compareVersions, satisfiesMinimum, APP_PERMISSIONS, APP_CATEGORIES } from "./manifest";
export type { AppManifest, AppPermission, ManifestIssue, ManifestValidation } from "./manifest";

export { createNotifications, NotificationManager } from "./notifications";
export type { Notification, NotificationInput } from "./notifications";

export { createCloudService, CloudServiceManager } from "./cloud";
export type { CloudSnapshot, CloudUser } from "./cloud";

export { createSyncEngine, SyncEngine, decide } from "./sync";
export type { SyncProvider, SyncItem, DomainStatus } from "./sync";

export { createDeviceManager, DeviceManager, detectCapabilities } from "./device";
export type { DeviceProfile, DeviceCapabilities } from "./device";

export type {
  AppSource,
  AppState,
  BootReport,
  BootStageId,
  BootStageReport,
  CoreMode,
  HealthReport,
  HealthState,
  LifecyclePhase,
  PermissionDecision,
  Principal,
  ServiceStatus,
  TrustLevel,
} from "./types";