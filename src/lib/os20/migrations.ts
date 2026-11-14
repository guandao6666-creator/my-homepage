/**
 * Guandao OS 2.0 · 本地数据迁移
 *
 * 1.9 → 2.0 的客户端迁移原则（§19）：
 *   1. 先备份：把所有 `guandao.*` 键完整写进 IndexedDB 的 backups store；
 *   2. 再迁移：只**新增** 2.0 需要的键，绝不改写 / 删除 1.x 的旧键；
 *   3. 做校验：迁移后确认旧键数量与关键键都还在；
 *   4. 失败不删除任何数据，下次启动继续（幂等）。
 *
 * 老用户升级时：
 *   - 不重新创建账号（Session Cookie 不动）；
 *   - 不丢笔记 / 文件 / 备份 / 主题 / 组件 / 插件配置（旧键完全保留）；
 *   - 首次启动引导直接标记为已完成，不强制重新初始化。
 *
 * 新用户：`initialVersion` 直接等于目标版本，不跑任何步骤。
 */

import type { MigrationStep } from "../core/migrations";
import { idb } from "../os14/core";
import type { StorageManager } from "../core/storage";
import { OS_VERSION } from "../version";

/** 2.0 本地数据 schema 版本 */
export const LOCAL_SCHEMA_VERSION = 2;

const readJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * 判断一份旧数据「是不是用户真的用过」。
 *
 * 这一点很关键：1.x 外壳在每次启动时都会写 `guandao.os.state.v1`、
 * `guandao.os13.v1`、`guandao.os14.apps.v1` 这类**运行态**键，
 * 如果把它们也算作「老用户」，第一次打开 2.0 的新访客永远看不到引导。
 *
 * 所以只看「用户内容」类键：有笔记、任务、日程、文件、插件、备份、
 * 自定义主题或自定义工作空间，才算 1.x 老用户。
 */
const CONTENT_KEYS = [
  "guandao.os.notes.v1",
  "guandao.os14.notes.v1",
  "guandao.os14.tasks.v1",
  "guandao.os14.calendar.v1",
  "guandao.os.fs.v1",
  "guandao.os14.music.v1",
  "guandao.os14.photo.v1",
  "guandao.os14.games.v1",
  "guandao.os14.draw.v1",
  "guandao.os14.focus.v1",
  "guandao.os14.themes.v1",
  "guandao.plugins.v1",
  "guandao.community.installs.v1",
  "guandao.os14.backupmeta.v1",
] as const;

const hasItems = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["list", "items", "docs", "documents", "notes", "tasks", "events", "entries", "installs", "files", "tracks", "photos", "records", "custom"]) {
      const child = record[key];
      if (Array.isArray(child) && child.length > 0) return true;
      if (child && typeof child === "object" && Object.keys(child).length > 0) return true;
    }
    return false;
  }
  return false;
};

/** 是否是从 1.x 升级上来的「真实使用者」 */
export const detectLegacyUser = (storage: StorageManager): boolean => {
  for (const key of CONTENT_KEYS) {
    const raw = storage.legacyStr(key);
    if (!raw) continue;
    if (hasItems(readJson<unknown>(raw, null))) return true;
  }

  // 自定义工作空间：预设之外的才算法（预设本身不算用户内容）
  const workspaces = readJson<{ list?: Array<{ preset?: boolean }> } | null>(
    storage.legacyStr("guandao.os14.ws.v1"),
    null,
  );
  if (workspaces?.list?.some((workspace) => !workspace.preset)) return true;

  // 应用中心里安装过可选应用（gallery / reader）也说明用过
  const installed = readJson<{ installed?: Record<string, unknown> } | null>(
    storage.legacyStr("guandao.os14.apps.v1"),
    null,
  );
  if (installed?.installed && (installed.installed.gallery || installed.installed.reader)) return true;

  // 真的保存过窗口布局（不是默认空布局）
  const state = readJson<{ windows?: Record<string, unknown>; shortcuts?: unknown[] } | null>(
    storage.legacyStr("guandao.os.state.v1"),
    null,
  );
  if (state?.windows && Object.keys(state.windows).length > 0) return true;

  return false;
};

/**
 * 备份 1.x 的全部本地数据。
 * 返回 IndexedDB 里的备份键；失败返回 null（此时迁移会被中止）。
 */
export async function backupLocalData(storage: StorageManager): Promise<string | null> {
  const keys = storage.legacyKeys("guandao.");
  const dump: Record<string, string | null> = {};
  for (const key of keys) dump[key] = storage.legacyStr(key);
  const payload = {
    schema: "guandao-os/local-backup",
    fromVersion: "1.x",
    toVersion: OS_VERSION,
    at: Date.now(),
    keys: dump,
  };
  const key = `pre-2.0-${Date.now()}`;
  try {
    const ok = await idb.put("backups", key, payload);
    return ok ? key : null;
  } catch {
    return null;
  }
}

/** 迁移步骤：全部是「按需新增」，可重复执行 */
export const LOCAL_MIGRATION_STEPS: MigrationStep[] = [
  {
    id: "2.0-core-device",
    from: 1,
    to: 2,
    title: "生成本地设备档案",
    run: (context) => {
      // 设备档案由 DeviceManager 在启动时惰性创建；这里只确保旧设备名可以延续
      const existing = context.storage.read<{ localId?: string } | null>("device.v1", null);
      if (existing?.localId) return;
      const legacyName =
        context.storage.legacyStr("guandao.device.name") ??
        context.storage.legacyStr("guandao.os18.deviceName");
      if (legacyName) {
        try {
          context.storage.write("device.name.seed", String(legacyName).slice(0, 40));
        } catch {
          /* 忽略 */
        }
      }
    },
  },
  {
    id: "2.0-onboarding-skip",
    from: 1,
    to: 2,
    title: "老用户跳过首次启动引导",
    run: (context) => {
      const current = context.storage.read<{ completed?: boolean } | null>("onboarding.v1", null);
      if (current?.completed) return;
      // 老用户已经用过 1.x，强制再走一遍引导等于重新初始化，明确不做
      context.storage.write("onboarding.v1", {
        v: 2,
        completed: true,
        completedAt: Date.now(),
        migrated: true,
        step: "complete",
      });
    },
    verify: (context) => Boolean(context.storage.read<{ completed?: boolean } | null>("onboarding.v1", null)?.completed),
  },
  {
    id: "2.0-settings-seed",
    from: 1,
    to: 2,
    title: "从 1.x 偏好生成 2.0 设置",
    run: (context) => {
      const existing = context.storage.read<Record<string, unknown> | null>("settings.v1", null);
      if (existing) return;
      const prefs = readJson<{ dnd?: boolean; volume?: number; animations?: boolean }>(
        context.storage.legacyStr("guandao.os14.prefs.v1"),
        {},
      );
      const os13 = readJson<{ appearance?: { mode?: string; material?: string; radius?: string }; dock?: { autohide?: boolean; pos?: string } }>(
        context.storage.legacyStr("guandao.os13.v1"),
        {},
      );
      const state = readJson<{ showIcons?: boolean }>(context.storage.legacyStr("guandao.os.state.v1"), {});

      context.storage.write("settings.v1", {
        "appearance.mode": os13.appearance?.mode === "light" ? "light" : "dark",
        "appearance.material": os13.appearance?.material ?? "glass",
        "appearance.radius": os13.appearance?.radius ?? "round",
        "appearance.animations": prefs.animations !== false,
        "desktop.iconLabels": true,
        "desktop.dock.autohide": Boolean(os13.dock?.autohide),
        "desktop.dock.position": os13.dock?.pos ?? "bottom",
        "desktop.widgets.opacity": 100,
        "notifications.dnd": Boolean(prefs.dnd),
        "notifications.volume": Number(prefs.volume) || 45,
        "system.mode": "local",
        "system.updateChannel": "stable",
        "system.diagnosticsRetention": 200,
      });
      // 图标显示状态是 1.0 的 state，不迁移成 2.0 设置，避免与旧开关打架
      void state;
    },
  },
  {
    id: "2.0-layout-snapshot",
    from: 1,
    to: 2,
    title: "保存 1.x 的桌面布局到 2.0 快照",
    run: (context) => {
      const existing = context.storage.read<Record<string, unknown> | null>("layout.v2", null);
      if (existing) return;
      const state = readJson<{ windows?: Record<string, unknown>; space?: number }>(
        context.storage.legacyStr("guandao.os.state.v1"),
        {},
      );
      context.storage.write("layout.v2", {
        schemaVersion: 2,
        at: Date.now(),
        viewport: { width: 0, height: 0 },
        windows: state.windows ?? {},
        legacy: true,
      });
    },
  },
  {
    id: "2.0-registry-seed",
    from: 1,
    to: 2,
    title: "从 1.x 安装状态生成应用注册中心",
    run: (context) => {
      const existing = context.storage.read<{ records?: Record<string, unknown> } | null>("apps.v2", null);
      if (existing?.records && Object.keys(existing.records).length) return;
      // 只写一个标记，真正的注册在 bridge 启动阶段根据 catalog 完成（那里有 Manifest）
      context.storage.write("apps.seeded", { at: Date.now(), from: "1.x" });
    },
  },
  {
    id: "2.0-audit-baseline",
    from: 1,
    to: 2,
    title: "记录迁移基线（诊断用）",
    run: (context) => {
      context.storage.write("migrated.from", {
        version: "1.x",
        to: OS_VERSION,
        at: Date.now(),
        legacyKeys: context.storage.legacyKeys("guandao.").length,
      });
    },
    verify: (context) => {
      const baseline = context.storage.read<{ legacyKeys?: number } | null>("migrated.from", null);
      // 旧键为 0 也合法（例如 1.x 用户只登录过没存东西），只要有基线记录即可
      return Boolean(baseline && typeof baseline.legacyKeys === "number");
    },
  },
];

/** 迁移后校验：关键旧键必须仍然存在 */
export const verifyLegacyPreserved = (storage: StorageManager, before: string[]): string[] => {
  const missing: string[] = [];
  for (const key of before) {
    if (storage.legacyStr(key) == null) missing.push(key);
  }
  return missing;
};

/** 迁移前快照旧键列表，用于迁移后对比 */
export const legacyKeySnapshot = (storage: StorageManager): string[] => storage.legacyKeys("guandao.");