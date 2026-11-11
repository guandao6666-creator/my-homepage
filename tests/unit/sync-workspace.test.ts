import { describe, expect, it } from "vitest";

import type { Viewport } from "../../src/lib/core/layout";
import { MemoryStore, createStorage } from "../../src/lib/core/storage";
import type { Workspace } from "../../src/lib/os14/workspaces";
import {
  MAX_WORKSPACE_ARRAY,
  MAX_WORKSPACE_NAME_CHARS,
  MAX_WORKSPACE_WINDOWS,
  WORKSPACE_KNOWN_KEY,
  WORKSPACE_STATE_KEY,
  applyRemoteWorkspace,
  applyWorkspaceSyncItem,
  buildWorkspacePayload,
  collectWorkspaceSyncItems,
  listCustomWorkspaces,
  readKnownWorkspaces,
  readWorkspaceState,
  readWorkspaceSyncItem,
  removeRemoteWorkspace,
  validateWorkspacePayload,
  writeWorkspaceState,
  type WorkspaceSyncKernel,
} from "../../src/lib/sync/workspace";

/**
 * 工作空间同步单测：注入真实 StorageManager + MemoryStore 与假视口，
 * 覆盖 payload 构建/校验、视口重算、删除传播与已知 id 追踪。
 */

const makeKernel = (viewport: Viewport = { width: 1280, height: 800 }): WorkspaceSyncKernel => {
  const storage = createStorage({ store: new MemoryStore() });
  return { storage, windows: { viewport: () => viewport } };
};

const makeWorkspace = (id: string, overrides: Partial<Workspace> = {}): Workspace => ({
  id,
  name: `工作空间 ${id}`,
  preset: false,
  theme: "aurora",
  wall: "aurora",
  widgets: { clock: { x: 10, y: 20, enabled: true, size: "m" } },
  dock: ["appcenter", "notes"],
  shortcuts: ["notes"],
  windows: {},
  openApps: ["notes"],
  dnd: false,
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const writeState = (kernel: WorkspaceSyncKernel, list: Workspace[], current = ""): void => {
  writeWorkspaceState(kernel, { v: 1, list, current });
};

const validWindow = () => ({ left: 40, top: 30, width: 200, height: 150, minimized: false, maximized: false, space: 1 });

describe("工作空间同步 payload", () => {
  it("只允许自定义工作空间构建 payload", () => {
    expect(() => buildWorkspacePayload(makeWorkspace("p1", { preset: true }))).toThrow(/仅自定义工作空间/);

    const payload = buildWorkspacePayload(makeWorkspace("ws-a"), { width: 1280, height: 800 });
    expect(payload.v).toBe(1);
    expect(payload.workspace.preset).toBe(false);
    expect(payload.workspace.dock).toEqual(["appcenter", "notes"]);
    expect(payload.viewport).toEqual({ width: 1280, height: 800 });
    expect(payload.capturedAt).toBeGreaterThan(0);
  });

  it("校验合法 payload，并明确拒绝内置预设 / 损坏 JSON / 超限字段", () => {
    const payload = buildWorkspacePayload(makeWorkspace("ws-a"), { width: 1280, height: 800 });
    const ok = validateWorkspacePayload(payload);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.bytes).toBeGreaterThan(0);
      expect(ok.payload.workspace.id).toBe("ws-a");
    }

    const presetTrue = validateWorkspacePayload({
      ...payload,
      workspace: { ...payload.workspace, preset: true },
    });
    expect(presetTrue.ok).toBe(false);
    if (!presetTrue.ok) expect(presetTrue.error).toContain("preset:false");

    const badJson = validateWorkspacePayload("{不是合法 payload");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error).toContain("合法 JSON");

    const longName = validateWorkspacePayload({
      ...payload,
      workspace: { ...payload.workspace, name: "长".repeat(MAX_WORKSPACE_NAME_CHARS + 1) },
    });
    expect(longName.ok).toBe(false);
    if (!longName.ok) expect(longName.error).toContain(String(MAX_WORKSPACE_NAME_CHARS));

    const tooManyDock = validateWorkspacePayload({
      ...payload,
      workspace: {
        ...payload.workspace,
        dock: Array.from({ length: MAX_WORKSPACE_ARRAY + 1 }, (_, index) => `app${index}`),
      },
    });
    expect(tooManyDock.ok).toBe(false);
    if (!tooManyDock.ok) expect(tooManyDock.error).toContain(String(MAX_WORKSPACE_ARRAY));

    const tooManyWindows = validateWorkspacePayload({
      ...payload,
      workspace: {
        ...payload.workspace,
        windows: Object.fromEntries(
          Array.from({ length: MAX_WORKSPACE_WINDOWS + 1 }, (_, index) => [`app${index}`, validWindow()]),
        ),
      },
    });
    expect(tooManyWindows.ok).toBe(false);
    if (!tooManyWindows.ok) expect(tooManyWindows.error).toContain(String(MAX_WORKSPACE_WINDOWS));

    const oversized = validateWorkspacePayload({
      ...payload,
      workspace: {
        ...payload.workspace,
        dock: Array.from({ length: 4000 }, () => "a".repeat(40)),
      },
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toContain("131072");
  });
});

describe("工作空间本地状态与远端应用", () => {
  it("读取/写入本地状态，只列出 preset:false 的自定义工作空间", () => {
    const kernel = makeKernel();
    writeState(kernel, [makeWorkspace("ws-b"), makeWorkspace("daily", { preset: true }), makeWorkspace("ws-a")], "ws-b");

    const state = readWorkspaceState(kernel);
    expect(state.v).toBe(1);
    expect(state.current).toBe("ws-b");
    expect(state.list).toHaveLength(3);
    expect(listCustomWorkspaces(kernel).map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("损坏的本地 JSON 退化为空状态，StorageManager 信封可兼容读取", () => {
    const kernel = makeKernel();
    kernel.storage?.activeStore.setItem(WORKSPACE_STATE_KEY, "{坏掉的 JSON");
    expect(readWorkspaceState(kernel)).toEqual({ v: 1, list: [], current: "" });

    kernel.storage?.activeStore.setItem(
      WORKSPACE_STATE_KEY,
      JSON.stringify({ v: 2, at: 1, data: { v: 1, list: [makeWorkspace("ws-env")], current: "ws-env" } }),
    );
    const state = readWorkspaceState(kernel);
    expect(state.current).toBe("ws-env");
    expect(state.list.map((workspace) => workspace.id)).toEqual(["ws-env"]);

    kernel.storage?.activeStore.setItem(
      WORKSPACE_KNOWN_KEY,
      JSON.stringify({ v: 2, at: 1, data: { v: 1, items: { "ws-env": { updatedAt: 42 } } } }),
    );
    expect(readKnownWorkspaces(kernel)["ws-env"]?.updatedAt).toBe(42);
  });

  it("应用远端工作空间时按来源→当前视口重算窗口几何", () => {
    const kernel = makeKernel({ width: 640, height: 400 });
    const source = makeWorkspace("ws-a", {
      windows: {
        notes: { left: 100, top: 100, width: 800, height: 500, minimized: false, maximized: false, space: 1 },
      },
      updatedAt: 5_000,
    });
    const payload = buildWorkspacePayload(source, { width: 1280, height: 800 });

    const first = applyRemoteWorkspace(kernel, payload);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.windows).toBe(1);
    expect(first.viewport).toEqual({ width: 640, height: 400 });

    const saved = readWorkspaceState(kernel).list.find((workspace) => workspace.id === "ws-a");
    expect(saved?.windows.notes).toMatchObject({ left: 50, top: 50, width: 400, height: 250 });
    expect(saved?.viewport).toEqual({ width: 640, height: 400 });

    // 再次应用同 id：整条替换而不是重复插入
    const second = applyRemoteWorkspace(kernel, {
      ...payload,
      workspace: { ...payload.workspace, name: "改过名字的工作空间", updatedAt: 6_000 },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    const list = readWorkspaceState(kernel).list;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("改过名字的工作空间");
  });

  it("来源视口未知时只做边界收敛（不缩放）", () => {
    const kernel = makeKernel({ width: 640, height: 400 });
    const payload = buildWorkspacePayload(
      makeWorkspace("ws-clamp", {
        windows: {
          notes: { left: 5_000, top: 5_000, width: 800, height: 500, minimized: false, maximized: false, space: 1 },
        },
      }),
      null,
    );

    const result = applyRemoteWorkspace(kernel, payload);
    expect(result.ok).toBe(true);
    const saved = readWorkspaceState(kernel).list.find((workspace) => workspace.id === "ws-clamp");
    expect(saved?.windows.notes).toMatchObject({ left: 0, top: 0, width: 640, height: 400 });
  });

  it("拒绝非法 payload / 删除应用无效 id 时不破坏本地状态", () => {
    const kernel = makeKernel();
    writeState(kernel, [makeWorkspace("ws-keep")], "ws-keep");

    const payload = buildWorkspacePayload(makeWorkspace("ws-a"));
    const invalid = applyRemoteWorkspace(kernel, { ...payload, workspace: { ...payload.workspace, preset: true } });
    expect(invalid.ok).toBe(false);
    expect(readWorkspaceState(kernel).list).toHaveLength(1);

    const remove = removeRemoteWorkspace(kernel, "ws-missing");
    expect(remove.removed).toBe(false);
    expect(readWorkspaceState(kernel).list).toHaveLength(1);
  });

  it("远端删除当前工作空间时落回可用项，并记录已知删除", () => {
    const kernel = makeKernel();
    writeState(kernel, [makeWorkspace("ws-a"), makeWorkspace("daily", { preset: true })], "ws-a");

    const result = removeRemoteWorkspace(kernel, "ws-a");
    expect(result.removed).toBe(true);
    const state = readWorkspaceState(kernel);
    expect(state.list.map((workspace) => workspace.id)).toEqual(["daily"]);
    expect(state.current).toBe("daily");
    expect(readKnownWorkspaces(kernel)["ws-a"]?.deletedAt).toBeGreaterThan(0);
  });

  it("collect 会为本地已删除的工作空间合成 deleted 项，云端恢复后撤销", () => {
    const kernel = makeKernel();
    const workspace = makeWorkspace("ws-del", { updatedAt: 5_000 });
    writeState(kernel, [workspace], "ws-del");

    const first = collectWorkspaceSyncItems(kernel);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "ws-del", updatedAt: 5_000 });
    expect(first[0].payload?.workspace.preset).toBe(false);
    expect(readKnownWorkspaces(kernel)["ws-del"]?.updatedAt).toBe(5_000);

    // 模拟本地删除（os14 的删除语义：直接从列表移除，不留墓碑）
    writeState(kernel, [], "");
    const second = collectWorkspaceSyncItems(kernel);
    expect(second).toHaveLength(1);
    expect(second[0].deleted).toBe(true);
    expect(second[0].updatedAt).toBeGreaterThanOrEqual(5_000);
    expect(readKnownWorkspaces(kernel)["ws-del"]?.deletedAt).toBeGreaterThan(0);

    // 云端还有同一 id：重新应用后应撤销删除标记，不会再次合成 deleted
    const payload = buildWorkspacePayload(makeWorkspace("ws-del", { updatedAt: 9_000 }), { width: 1280, height: 800 });
    expect(applyRemoteWorkspace(kernel, payload).ok).toBe(true);
    const third = collectWorkspaceSyncItems(kernel);
    expect(third).toHaveLength(1);
    expect(third[0].deleted).toBeUndefined();
    expect(third[0].updatedAt).toBe(9_000);
    expect(readKnownWorkspaces(kernel)["ws-del"]?.deletedAt).toBeUndefined();
  });

  it("applyWorkspaceSyncItem 与 readWorkspaceSyncItem 覆盖推送/解决路径", () => {
    const kernel = makeKernel();
    const payload = buildWorkspacePayload(makeWorkspace("ws-item", { updatedAt: 3_000 }), null);

    const applied = applyWorkspaceSyncItem(kernel, { id: "ws-item", payload });
    expect(applied.applied).toBe(true);
    if (applied.applied) expect(applied.created).toBe(true);

    const live = readWorkspaceSyncItem(kernel, "ws-item");
    expect(live.deleted).toBeUndefined();
    expect(live.payload?.workspace.id).toBe("ws-item");

    const removed = applyWorkspaceSyncItem(kernel, { id: "ws-item", deleted: true });
    expect(removed.applied).toBe(true);
    if (removed.applied) expect(removed.removed).toBe(true);
    expect(readWorkspaceState(kernel).list).toHaveLength(0);

    const missing = readWorkspaceSyncItem(kernel, "ws-item");
    expect(missing.deleted).toBe(true);
    expect(missing.updatedAt).toBeGreaterThan(0);
  });
});
