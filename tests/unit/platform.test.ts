/**
 * Guandao OS 2.0 · 平台层单元测试
 *
 * 覆盖：Manifest 校验、权限默认拒绝、应用状态机、窗口布局几何、
 * 同步冲突判定、迁移引擎、通知与云端探测。
 */
import { describe, expect, it, vi } from "vitest";
import { compareVersions, satisfiesMinimum, validateAppManifest } from "../../src/lib/core/manifest";
import { createPermissions, appPrincipal, systemPrincipal } from "../../src/lib/core/permissions";
import { createAppRegistry } from "../../src/lib/core/registry";
import { createStorage, MemoryStore } from "../../src/lib/core/storage";
import { clampRect, rescaleSnapshot, snapRect, splitRects, type WorkspaceSnapshot } from "../../src/lib/core/layout";
import { decide } from "../../src/lib/core/sync";
import { createMigrationEngine, type MigrationStep } from "../../src/lib/core/migrations";
import { createNotifications } from "../../src/lib/core/notifications";
import { createCloudService } from "../../src/lib/core/cloud";

const storage = () => createStorage({ store: new MemoryStore(), namespace: "guandao.core", version: 2 });

const manifest = (patch: Record<string, unknown> = {}) => ({
  appId: "notes-pro",
  name: "Notes Pro",
  version: "1.2.3",
  description: "一个测试应用",
  icon: "di-note",
  category: "productivity",
  entry: "apps/notes-pro",
  minimumOSVersion: "2.0.0",
  permissions: ["storage.read", "storage.write"],
  dependencies: [],
  author: "Test",
  ...patch,
});

describe("Manifest 校验", () => {
  it("合法 Manifest 通过并归一化", () => {
    const result = validateAppManifest(manifest(), { osVersion: "2.0.0" });
    expect(result.ok).toBe(true);
    expect(result.manifest?.appId).toBe("notes-pro");
    expect(result.manifest?.apiVersion).toBe(1);
    expect(result.manifest?.permissions).toEqual(["storage.read", "storage.write"]);
  });

  it("缺少必填字段时逐项报错", () => {
    const result = validateAppManifest({}, { osVersion: "2.0.0" });
    expect(result.ok).toBe(false);
    const paths = result.errors.map((issue) => issue.path);
    expect(paths).toContain("appId");
    expect(paths).toContain("name");
    expect(paths).toContain("version");
    expect(paths).toContain("entry");
  });

  it("系统保留 appId 只允许系统来源注册", () => {
    expect(validateAppManifest(manifest({ appId: "appcenter" }), { osVersion: "2.0.0" }).ok).toBe(false);
    expect(
      validateAppManifest(manifest({ appId: "appcenter" }), { osVersion: "2.0.0", allowReservedIds: true }).ok,
    ).toBe(true);
  });

  it("拒绝外部 URL、路径穿越与未知权限", () => {
    expect(validateAppManifest(manifest({ entry: "https://evil.example/x" }), { osVersion: "2.0.0" }).ok).toBe(false);
    expect(validateAppManifest(manifest({ entry: "../../etc/passwd" }), { osVersion: "2.0.0" }).ok).toBe(false);
    const unknownPermission = validateAppManifest(manifest({ permissions: ["root.everything"] }), { osVersion: "2.0.0" });
    expect(unknownPermission.ok).toBe(false);
    expect(unknownPermission.errors[0].code).toBe("UNKNOWN");
  });

  it("系统版本低于 minimumOSVersion 时拒绝", () => {
    const result = validateAppManifest(manifest({ minimumOSVersion: "2.1.0" }), { osVersion: "2.0.0" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.code === "INCOMPATIBLE")).toBe(true);
  });

  it("依赖不能指向自己，也不能重复", () => {
    const self = validateAppManifest(manifest({ dependencies: [{ appId: "notes-pro" }] }), { osVersion: "2.0.0" });
    expect(self.ok).toBe(false);
    expect(self.errors[0].code).toBe("SELF");

    const duplicate = validateAppManifest(
      manifest({ dependencies: [{ appId: "helper" }, { appId: "helper" }] }),
      { osVersion: "2.0.0" },
    );
    expect(duplicate.ok).toBe(true);
    expect(duplicate.warnings.some((issue) => issue.code === "DUPLICATE")).toBe(true);
  });

  it("版本比较与最低版本判定", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(satisfiesMinimum("2.0.0", "2.0.0")).toBe(true);
    expect(satisfiesMinimum("1.9.0", "2.0.0")).toBe(false);
  });
});

describe("PermissionManager（默认拒绝）", () => {
  const setup = () => createPermissions({ storage: storage() });

  it("未声明的权限一律拒绝", () => {
    const permissions = setup();
    const app = appPrincipal("notes-pro");
    const decision = permissions.check(app, "storage.read");
    expect(decision.allowed).toBe(false);
    expect(decision.via).toBe("default-deny");
  });

  it("声明之后仍然需要显式授予", () => {
    const permissions = setup();
    const app = appPrincipal("notes-pro");
    permissions.declare(app, ["storage.read", "files.read"]);
    expect(permissions.check(app, "storage.read").allowed).toBe(false);

    permissions.grant(app, ["storage.read"]);
    expect(permissions.check(app, "storage.read").allowed).toBe(true);
    expect(permissions.grantsOf(app)).toEqual(["storage.read"]);
  });

  it("不能授予未声明的权限（防提权）", () => {
    const permissions = setup();
    const app = appPrincipal("plugin-x");
    permissions.declare(app, ["storage.read"]);
    const granted = permissions.grant(app, ["storage.read", "cloud.sync"]);
    expect(granted).toEqual(["storage.read"]);
    expect(permissions.check(app, "cloud.sync").via).toBe("not-declared");
  });

  it("撤销立即生效", () => {
    const permissions = setup();
    const app = appPrincipal("app");
    permissions.declare(app, ["storage.write"]);
    permissions.grant(app, ["storage.write"]);
    expect(permissions.check(app, "storage.write").allowed).toBe(true);
    permissions.revoke(app, ["storage.write"]);
    expect(permissions.check(app, "storage.write").allowed).toBe(false);
  });

  it("拉黑来源后所有调用被拒绝", () => {
    const permissions = setup();
    const app = appPrincipal("bad-plugin");
    permissions.declare(app, ["network.request"]);
    permissions.grant(app, ["network.request"]);
    permissions.block(app, true);
    const decision = permissions.check(app, "network.request");
    expect(decision.allowed).toBe(false);
    expect(decision.via).toBe("blocked");
  });

  it("系统主体走 bypass，但也会留审计记录", () => {
    const permissions = setup();
    const decision = permissions.check(systemPrincipal("kernel"), "plugin.manage");
    expect(decision.allowed).toBe(true);
    expect(decision.via).toBe("system-bypass");
    expect(permissions.audit(5)[0].allowed).toBe(true);
  });

  it("审计记录包含拒绝原因，且可导出", () => {
    const permissions = setup();
    const app = appPrincipal("probe");
    permissions.declare(app, ["storage.read"]);
    permissions.check(app, "files.read");
    const entry = permissions.audit(1)[0];
    expect(entry.allowed).toBe(false);
    expect(entry.reason).toBeTruthy();
    const exported = JSON.parse(permissions.exportAudit()) as { entries: unknown[]; version: string };
    expect(exported.version).toBe("guandao-os/2.0");
    expect(exported.entries.length).toBeGreaterThan(0);
  });

  it("断言版本在无权限时抛 PermissionError", () => {
    const permissions = setup();
    expect(() => permissions.assert(appPrincipal("x"), "cloud.sync")).toThrow(/缺少权限/);
  });
});

describe("AppRegistry（状态机）", () => {
  const setup = () => {
    const registry = createAppRegistry({ storage: storage(), osVersion: "2.0.0" });
    registry.register(manifest(), { source: "system", locked: true });
    return registry;
  };

  it("注册即可安装，状态只能按迁移表前进", () => {
    const registry = setup();
    expect(registry.stateOf("notes-pro")).toBe("installed");
    expect(registry.enable("notes-pro")).toBe(true);
    expect(registry.stateOf("notes-pro")).toBe("enabled");
    expect(registry.markRunning("notes-pro")).toBe(true);
    expect(registry.stateOf("notes-pro")).toBe("running");
    expect(registry.markClosed("notes-pro")).toBe(true);
    expect(registry.stateOf("notes-pro")).toBe("enabled");
  });

  it("非法迁移（未安装直接运行）被拒绝", () => {
    const registry = createAppRegistry({ storage: storage(), osVersion: "2.0.0" });
    registry.register(manifest(), { source: "market" });
    expect(registry.stateOf("notes-pro")).toBe("registered");
    expect(registry.markRunning("notes-pro")).toBe(false);
    expect(registry.stateOf("notes-pro")).toBe("registered");
  });

  it("系统应用不能卸载，第三方可以回到未安装", () => {
    const registry = setup();
    expect(registry.uninstall("notes-pro").ok).toBe(false);

    registry.register(manifest({ appId: "third-party" }), { source: "market" });
    registry.install("third-party");
    const result = registry.uninstall("third-party");
    expect(result.ok).toBe(true);
    expect(registry.stateOf("third-party")).toBe("registered");
  });

  it("依赖缺失会被报告", () => {
    const registry = createAppRegistry({ storage: storage(), osVersion: "2.0.0" });
    registry.register(manifest({ dependencies: [{ appId: "helper" }] }), { source: "market" });
    expect(registry.missingDependencies("notes-pro")).toEqual(["helper"]);
  });

  it("状态统计与来源过滤可用", () => {
    const registry = setup();
    const stats = registry.stats();
    expect(stats.installed).toBe(1);
    expect(registry.bySource("system")).toHaveLength(1);
  });

  it("失败的注册不会污染已有的同 id 记录", () => {
    const registry = setup();
    const result = registry.register(manifest({ entry: "https://evil" }), { source: "system", replace: true });
    expect(result.ok).toBe(false);
    expect(registry.get("notes-pro")?.manifest.entry).toBe("apps/notes-pro");
  });
});

describe("窗口布局几何", () => {
  const viewport = { width: 1440, height: 900 };

  it("贴靠矩形在视口内且互不重叠", () => {
    const left = snapRect("left", viewport);
    const right = snapRect("right", viewport);
    expect(left.x).toBeGreaterThanOrEqual(0);
    expect(left.y).toBeGreaterThanOrEqual(0);
    expect(left.x + left.width).toBeLessThanOrEqual(viewport.width);
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(right.x + right.width).toBeLessThanOrEqual(viewport.width);
  });

  it("最大化铺满视口", () => {
    const rect = snapRect("maximize", viewport);
    expect(rect.width).toBe(viewport.width);
    expect(rect.height).toBe(viewport.height);
  });

  it("clampRect 保证最小尺寸与边界", () => {
    const rect = clampRect({ x: -100, y: -50, width: 100, height: 50 }, viewport);
    expect(rect.width).toBeGreaterThanOrEqual(320);
    expect(rect.height).toBeGreaterThanOrEqual(240);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it("分屏把宽度切成等份且不越界", () => {
    const rects = splitRects(3, viewport);
    expect(rects).toHaveLength(3);
    const last = rects[2];
    expect(last.x + last.width).toBeLessThanOrEqual(viewport.width);
    for (const rect of rects) expect(rect.width).toBeGreaterThanOrEqual(320);
  });

  it("跨设备恢复时重新计算尺寸与位置", () => {
    const snapshot: WorkspaceSnapshot = {
      schemaVersion: 2,
      at: 1,
      viewport: { width: 1440, height: 900 },
      windows: {
        notes: { left: 800, top: 200, width: 600, height: 500, minimized: false, maximized: false, space: 1 },
      },
    };
    const mobile = rescaleSnapshot(snapshot, { width: 390, height: 700 });
    const rect = mobile.windows.notes;
    expect(rect.width).toBeGreaterThanOrEqual(320);
    expect(rect.width).toBeLessThanOrEqual(390);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(390);
  });

  it("同视口恢复时保持原来的相对位置", () => {
    const snapshot: WorkspaceSnapshot = {
      schemaVersion: 2,
      at: 1,
      viewport: { width: 1440, height: 900 },
      windows: {
        notes: { left: 120, top: 90, width: 640, height: 480, minimized: false, maximized: false, space: 1 },
      },
    };
    const restored = rescaleSnapshot(snapshot, { width: 1444, height: 902 });
    expect(restored.windows.notes.left).toBe(120);
    expect(restored.windows.notes.top).toBe(90);
  });
});

describe("SyncEngine 冲突判定", () => {
  const local = (updatedAt: number, deleted = false) => ({ id: "a", updatedAt, deleted });
  const remote = (updatedAt: number, deleted = false) => ({ id: "a", updatedAt, deleted });

  it("本地较新则推送，远端较新则拉取", () => {
    expect(decide(local(20), remote(10))).toBe("push");
    expect(decide(local(10), remote(20))).toBe("pull");
  });

  it("删除与修改并发时修改优先（避免误删）", () => {
    expect(decide(undefined, remote(10))).toBe("pull");
    expect(decide(local(10), undefined)).toBe("push");
    expect(decide(local(10, true), remote(30))).toBe("pull");
  });

  it("时间戳相同按内容确定性裁决，两端结果一致", () => {
    const first = decide(local(10), remote(10));
    const second = decide(local(10), remote(10));
    expect(first).toBe(second);
    expect(["keep-local", "keep-remote"]).toContain(first);
  });
});

describe("MigrationEngine", () => {
  const step = (id: string, from: number, to: number, run: () => void): MigrationStep => ({
    id,
    from,
    to,
    title: id,
    run,
  });

  it("全新安装直接从目标版本开始，不跑迁移", async () => {
    const storageManager = storage();
    const engine = createMigrationEngine({
      storage: storageManager,
      steps: [step("s1", 1, 2, () => undefined)],
      targetVersion: 2,
      initialVersion: 2,
      requireBackup: false,
    });
    const report = await engine.run();
    expect(report.applied).toBe(false);
    expect(report.steps).toHaveLength(0);
  });

  it("老用户执行迁移并保留备份键", async () => {
    const storageManager = storage();
    const ran: string[] = [];
    const engine = createMigrationEngine({
      storage: storageManager,
      steps: [step("s1", 1, 2, () => ran.push("s1"))],
      targetVersion: 2,
      initialVersion: 1,
      backup: () => "backup-key",
    });
    const report = await engine.run();
    expect(report.applied).toBe(true);
    expect(report.backupKey).toBe("backup-key");
    expect(ran).toEqual(["s1"]);
    expect(engine.currentVersion()).toBe(2);
  });

  it("备份失败时中止迁移，不修改数据", async () => {
    const storageManager = storage();
    const ran: string[] = [];
    const engine = createMigrationEngine({
      storage: storageManager,
      steps: [step("s1", 1, 2, () => ran.push("s1"))],
      targetVersion: 2,
      initialVersion: 1,
      backup: () => null,
      requireBackup: true,
    });
    const report = await engine.run();
    expect(report.applied).toBe(false);
    expect(ran).toEqual([]);
    expect(report.errors[0]).toContain("备份失败");
    expect(engine.currentVersion()).toBe(1);
  });

  it("步骤失败时保留已完成的部分，下次可重试", async () => {
    const storageManager = storage();
    const second = vi.fn(() => {
      throw new Error("boom");
    });
    const engine = createMigrationEngine({
      storage: storageManager,
      steps: [step("s1", 1, 2, () => undefined), step("s2", 2, 3, second)],
      targetVersion: 3,
      initialVersion: 1,
      backup: () => "key",
    });
    const report = await engine.run();
    expect(report.applied).toBe(false);
    expect(engine.currentVersion()).toBe(2);
    expect(report.steps.map((item) => item.outcome)).toEqual(["applied", "failed"]);
  });

  it("verify 不通过视为失败", async () => {
    const storageManager = storage();
    const engine = createMigrationEngine({
      storage: storageManager,
      steps: [{ ...step("s1", 1, 2, () => undefined), verify: () => false }],
      targetVersion: 2,
      initialVersion: 1,
      backup: () => "key",
    });
    const report = await engine.run();
    expect(report.applied).toBe(false);
    expect(engine.currentVersion()).toBe(1);
  });
});

describe("NotificationManager", () => {
  const make = (dnd = false) => {
    const store = new MemoryStore();
    const delivered: string[] = [];
    const manager = createNotifications({
      store,
      isDnd: () => dnd,
      onDeliver: (notification) => delivered.push(notification.title),
    });
    return { manager, delivered, store };
  };

  it("提交后进入列表且未读", () => {
    const { manager, delivered } = make();
    manager.post({ title: "安装完成", body: "插件已启用" });
    expect(manager.list()).toHaveLength(1);
    expect(manager.unreadCount()).toBe(1);
    expect(delivered).toEqual(["安装完成"]);
  });

  it("勿扰模式仍然入库，但直接标记已读且不弹出", () => {
    const { manager, delivered } = make(true);
    manager.post({ title: "静默", body: "x" });
    expect(manager.list()).toHaveLength(1);
    expect(manager.unreadCount()).toBe(0);
    expect(delivered).toEqual([]);
  });

  it("标记已读与清空", () => {
    const { manager } = make();
    manager.post({ title: "a", body: "1" });
    manager.post({ title: "b", body: "2" });
    expect(manager.markAllRead()).toBe(2);
    expect(manager.unreadCount()).toBe(0);
    manager.clear();
    expect(manager.list()).toHaveLength(0);
  });

  it("沿用 1.x 的存储键，两套界面看到同一份数据", () => {
    const { manager, store } = make();
    manager.post({ title: "共享", body: "x" });
    const raw = store.getItem("guandao.os.notif.v1");
    expect(raw).toContain("共享");
  });
});

describe("CloudServiceManager", () => {
  const make = (fetchImpl: typeof fetch, online = true) => {
    const kernel = { mode: "local" as "local" | "cloud" };
    return createCloudService({
      mode: () => kernel.mode,
      online: () => online,
      fetch: fetchImpl,
    });
  };

  it("健康检查成功时记录真实延迟", async () => {
    const cloud = make(async () => new Response(JSON.stringify({ status: "ok", checks: {} }), { status: 200 }));
    const report = await cloud.probeHealth();
    expect(report.state).toBe("ok");
    expect(report.latencyMs).not.toBeNull();
  });

  it("部分依赖异常标记为 degraded", async () => {
    const cloud = make(
      async () =>
        new Response(JSON.stringify({ status: "degraded", checks: { d1: { status: "error" }, r2: { status: "available" } } }), {
          status: 503,
        }),
    );
    cloud.state();
    const report = await cloud.probeHealth();
    expect(report.state).toBe("down");
  });

  it("网络失败在离线时标记为 unknown，不伪装正常", async () => {
    const cloud = make(async () => {
      throw new Error("network down");
    }, false);
    const report = await cloud.probeHealth();
    expect(report.state).toBe("unknown");
    expect(report.detail).toContain("离线");
  });

  it("会话 401 视为未登录而不是云端故障", async () => {
    const cloud = make(async () => new Response("{}", { status: 401 }));
    await cloud.probeSession();
    expect(cloud.state().authenticated).toBe(false);
  });

  it("切换模式不会清空任何数据（只改状态）", () => {
    const cloud = make(async () => new Response("{}", { status: 200 }));
    cloud.setMode("cloud");
    expect(cloud.state().mode).toBe("cloud");
    cloud.setMode("local");
    expect(cloud.state().mode).toBe("local");
    expect(cloud.state().authenticated).toBe(false);
  });
});