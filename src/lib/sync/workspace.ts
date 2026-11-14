/**
 * Guandao OS 2.0 · 工作空间同步域（Phase 4.1）
 *
 * 只同步用户自建的 `preset: false` 工作空间：内置工作空间是产品默认值，
 * 各端本来就有，不占云同步配额。云端只存「语义快照」（主题/壁纸/组件/
 * Dock/快捷方式/窗口几何/通知偏好），窗口几何在应用时按视口重新计算，
 * 不搬运设备级像素。
 *
 * 不改变 os14/workspaces.ts 的删除语义：工作空间仍直接从列表里移除，
 * 这里用「已知 id 追踪」在下次同步时合成 deleted 项完成删除传播。
 */

import { normalizeSnapshot, rescaleSnapshot, type Viewport, type WindowState } from "../core/layout";
import type { StorageManager } from "../core/storage";
import type { Workspace } from "../os14/workspaces";

/** 与 os14/workspaces.ts 保持同一个本地键（裸 JSON，不是 StorageManager 信封） */
export const WORKSPACE_STATE_KEY = "guandao.os14.ws.v1";
/** 同步侧自用：记录已见过的自定义工作空间 id，用来发现本地删除 */
export const WORKSPACE_KNOWN_KEY = "guandao.core.sync.workspaces.known.v1";
/** 单条工作空间 payload 上限：128KB（远小于配额，避免整份快照拖垮同步） */
export const MAX_WORKSPACE_PAYLOAD_BYTES = 128 * 1024;
export const MAX_WORKSPACE_NAME_CHARS = 64;
export const MAX_WORKSPACE_WIDGETS = 64;
export const MAX_WORKSPACE_WINDOWS = 24;
export const MAX_WORKSPACE_ARRAY = 48;
export const MAX_WORKSPACE_ID_CHARS = 128;

/** 只需要 Kernel 的这几项能力，单测可以注入假的 storage / windows */
export type WorkspaceStorageLike = Pick<StorageManager, "legacyStr" | "activeStore"> & {
  read?: <T>(key: string, fallback: T) => T;
};

export type WorkspaceSyncKernel = {
  storage?: WorkspaceStorageLike | null;
  windows?: { viewport?: () => Viewport } | null;
};

export type WorkspaceWindowPayload = {
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  space: number;
};

export type WorkspaceWidgetState = {
  x?: number;
  y?: number;
  enabled?: boolean;
  size?: "s" | "m" | "l";
};

export type WorkspacePayloadWorkspace = {
  id: string;
  name: string;
  preset: false;
  theme: string;
  wall: string;
  widgets: Record<string, WorkspaceWidgetState>;
  dock: string[];
  shortcuts: string[];
  windows: Record<string, WorkspaceWindowPayload>;
  openApps: string[];
  dnd: boolean;
  createdAt: number;
  updatedAt: number;
};

export type WorkspacePayload = {
  v: 1;
  workspace: WorkspacePayloadWorkspace;
  /** 捕获时视口；未知（旧数据）时为 null，应用端只做边界收敛 */
  viewport: Viewport | null;
  capturedAt: number;
};

export type WorkspaceSyncItem = {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  payload?: WorkspacePayload;
};

export type WorkspaceValidation =
  | { ok: true; payload: WorkspacePayload; bytes: number }
  | { ok: false; error: string };

type WsStateLike = { v: 1; list: Workspace[]; current: string };

type KnownEntry = { updatedAt: number; deletedAt?: number };
type KnownMap = Record<string, KnownEntry>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WIDGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const byteLength = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 3;
  }
};

const jsonBytes = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFinite = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/* ============================================================
   存储访问（兼容 StorageManager 的旧键访问层与 localStorage）
   ============================================================ */

const localStorageLike = (): { getItem(key: string): string | null; setItem(key: string, value: string): void } | null => {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* 隐私模式 / Node 环境 */
  }
  return null;
};

const readRaw = (kernel: WorkspaceSyncKernel, key: string): string | null => {
  const storage = kernel.storage;
  try {
    if (storage?.legacyStr) {
      const value = storage.legacyStr(key);
      if (value !== null) return value;
    }
    if (storage?.activeStore) {
      const value = storage.activeStore.getItem(key);
      if (value !== null) return value;
    }
    return localStorageLike()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const writeRaw = (kernel: WorkspaceSyncKernel, key: string, text: string): boolean => {
  const storage = kernel.storage;
  try {
    if (storage?.activeStore) {
      storage.activeStore.setItem(key, text);
      return true;
    }
    const fallback = localStorageLike();
    if (fallback) {
      fallback.setItem(key, text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

/** 当前视口：优先窗口管理器，其次浏览器，最后 1280×800 兜底 */
export const currentViewport = (kernel: WorkspaceSyncKernel): Viewport => {
  try {
    const viewport = kernel.windows?.viewport?.();
    const width = Number(viewport?.width);
    const height = Number(viewport?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  } catch {
    /* 窗口还没挂载 */
  }
  const globalWindow = globalThis as { innerWidth?: number; innerHeight?: number };
  const width = Number(globalWindow.innerWidth);
  const height = Number(globalWindow.innerHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  return { width: 1280, height: 800 };
};

const emptyState = (): WsStateLike => ({ v: 1, list: [], current: "" });

/**
 * 兼容两种落盘形态：os14 写入的裸 JSON，以及 StorageManager 写入的信封
 * （`{ v, at, data }`）。发现外层不是合法状态时尝试解一层 data。
 */
const unwrapEnvelope = (parsed: unknown): unknown => {
  if (!isPlainObject(parsed)) return parsed;
  const direct = parsed as Partial<WsStateLike> & { data?: unknown };
  if (direct.v === 1 && Array.isArray(direct.list)) return direct;
  const inner = direct.data;
  if (isPlainObject(inner) && (inner as Partial<WsStateLike>).v === 1 && Array.isArray((inner as WsStateLike).list)) {
    return inner;
  }
  return parsed;
};


/* ============================================================
   本地状态读写（workespace 列表，裸 JSON）
   ============================================================ */

export function readWorkspaceState(kernel: WorkspaceSyncKernel): WsStateLike {
  const text = readRaw(kernel, WORKSPACE_STATE_KEY);
  if (!text) return emptyState();
  try {
    const parsed = unwrapEnvelope(JSON.parse(text) as unknown);
    if (!isPlainObject(parsed)) return emptyState();
    const state = parsed as Partial<WsStateLike>;
    if (state.v !== 1 || !Array.isArray(state.list)) return emptyState();
    return {
      v: 1,
      list: state.list.filter((item): item is Workspace => isPlainObject(item) && typeof (item as Workspace).id === "string"),
      current: typeof state.current === "string" ? state.current : "",
    };
  } catch {
    return emptyState();
  }
}

export function writeWorkspaceState(kernel: WorkspaceSyncKernel, state: WsStateLike): boolean {
  const list = Array.isArray(state.list) ? state.list : [];
  return writeRaw(
    kernel,
    WORKSPACE_STATE_KEY,
    JSON.stringify({ v: 1, list, current: typeof state.current === "string" ? state.current : "" }),
  );
}

/** 只返回自定义工作空间（preset:false），按 id 排序保证同步顺序稳定 */
export function listCustomWorkspaces(kernel: WorkspaceSyncKernel, state = readWorkspaceState(kernel)): Workspace[] {
  return state.list
    .filter((workspace) => workspace && workspace.preset !== true && typeof workspace.id === "string" && ID_PATTERN.test(workspace.id))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/* ============================================================
   已知 id 追踪（检测本地删除，合成 deleted 项）
   ============================================================ */

export function readKnownWorkspaces(kernel: WorkspaceSyncKernel): KnownMap {
  const text = readRaw(kernel, WORKSPACE_KNOWN_KEY);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) return {};
    // 同样兼容 StorageManager 信封（{ v, at, data: { items } }）
    const record = isPlainObject(parsed.items)
      ? parsed
      : isPlainObject(parsed.data) && isPlainObject((parsed.data as Record<string, unknown>).items)
        ? (parsed.data as Record<string, unknown>)
        : null;
    if (!record) return {};
    const items = record.items;
    if (!isPlainObject(items)) return {};
    const known: KnownMap = {};
    for (const [id, entry] of Object.entries(items)) {
      if (!ID_PATTERN.test(id) || !isPlainObject(entry)) continue;
      const updatedAt = asFinite(entry.updatedAt);
      if (updatedAt === null) continue;
      const deletedAt = asFinite(entry.deletedAt);
      known[id] = { updatedAt: Math.max(0, Math.trunc(updatedAt)), ...(deletedAt !== null ? { deletedAt: Math.max(0, Math.trunc(deletedAt)) } : {}) };
    }
    return known;
  } catch {
    return {};
  }
}

export function writeKnownWorkspaces(kernel: WorkspaceSyncKernel, known: KnownMap): boolean {
  return writeRaw(kernel, WORKSPACE_KNOWN_KEY, JSON.stringify({ v: 1, items: known }));
}

/* ============================================================
   payload 构建 / 校验
   ============================================================ */

const sanitizeWindows = (raw: unknown): Record<string, WorkspaceWindowPayload> => {
  const windows: Record<string, WorkspaceWindowPayload> = {};
  if (!isPlainObject(raw)) return windows;
  for (const [app, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const width = asFinite(value.width);
    const height = asFinite(value.height);
    if (width === null || height === null || width <= 0 || height <= 0) continue;
    windows[app] = {
      left: Math.round(asFinite(value.left) ?? 0),
      top: Math.round(asFinite(value.top) ?? 0),
      width: Math.round(width),
      height: Math.round(height),
      minimized: value.minimized === true,
      maximized: value.maximized === true,
      space: Math.max(1, Math.trunc(asFinite(value.space) ?? 1)),
    };
  }
  return windows;
};

const sanitizeWidgets = (raw: unknown): Record<string, WorkspaceWidgetState> => {
  const widgets: Record<string, WorkspaceWidgetState> = {};
  if (!isPlainObject(raw)) return widgets;
  for (const [id, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const widget: WorkspaceWidgetState = {};
    const x = asFinite(value.x);
    const y = asFinite(value.y);
    if (x !== null) widget.x = Math.round(x);
    if (y !== null) widget.y = Math.round(y);
    if (typeof value.enabled === "boolean") widget.enabled = value.enabled;
    if (value.size === "s" || value.size === "m" || value.size === "l") widget.size = value.size;
    widgets[id] = widget;
  }
  return widgets;
};

const sanitizeStringArray = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64) : [];

/**
 * 从本地工作空间构建可同步 payload。
 * 数组/字段保持原样（不静默截断），长度超限由 validateWorkspacePayload 明确报错。
 */
export function buildWorkspacePayload(workspace: Workspace, viewport?: Viewport | null): WorkspacePayload {
  if (!workspace || workspace.preset !== false) {
    throw new Error("仅自定义工作空间（preset:false）可以同步，内置预设不同步");
  }
  const state = workspace.windows ?? {};
  return {
    v: 1,
    workspace: {
      id: String(workspace.id),
      name: String(workspace.name ?? ""),
      preset: false,
      theme: String(workspace.theme ?? ""),
      wall: String(workspace.wall ?? ""),
      widgets: { ...sanitizeWidgets(workspace.widgets) },
      dock: sanitizeStringArray(workspace.dock),
      shortcuts: sanitizeStringArray(workspace.shortcuts),
      windows: { ...sanitizeWindows(state) },
      openApps: sanitizeStringArray(workspace.openApps),
      dnd: workspace.dnd === true,
      createdAt: Math.max(0, Math.trunc(Number(workspace.createdAt) || 0)),
      updatedAt: Math.max(0, Math.trunc(Number(workspace.updatedAt) || 0)),
    },
    viewport: viewport ? { width: Math.round(viewport.width), height: Math.round(viewport.height) } : null,
    capturedAt: Date.now(),
  };
}

const fail = (error: string): WorkspaceValidation => ({ ok: false, error });

const validateString = (value: unknown, label: string, max: number): string | null => {
  if (typeof value !== "string" || value.length === 0) return `${label} 必须是非空字符串`;
  if (value.length > max) return `${label} 超过 ${max} 字符上限（当前 ${value.length}）`;
  return null;
};

const validateStringArray = (value: unknown, label: string): string | null => {
  if (!Array.isArray(value)) return `${label} 必须是数组`;
  if (value.length > MAX_WORKSPACE_ARRAY) return `${label} 超过 ${MAX_WORKSPACE_ARRAY} 项上限（当前 ${value.length}）`;
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 64) return `${label} 含非法条目`;
  }
  return null;
};

/**
 * 校验远端/本地 payload：
 *   - 只接受 v:1 且 preset:false；
 *   - JSON 序列化后 ≤128KB；
 *   - 名称、数组、窗口、组件数量按上限明确报错（不截断、不静默丢字段）；
 *   - 接受对象或 JSON 字符串（远端 payload 可能已经过 JSON）。
 */
export function validateWorkspacePayload(raw: unknown): WorkspaceValidation {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (error) {
      return fail(`工作空间数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isPlainObject(payload)) return fail("工作空间数据必须是对象");

  const bytes = jsonBytes(payload);
  if (bytes > MAX_WORKSPACE_PAYLOAD_BYTES) {
    return fail(`工作空间数据 ${bytes} 字节，超过 ${MAX_WORKSPACE_PAYLOAD_BYTES} 字节上限`);
  }

  if (payload.v !== 1) return fail("工作空间数据版本不是 v:1");
  const workspace = payload.workspace;
  if (!isPlainObject(workspace)) return fail("缺少 workspace 对象");
  if (workspace.preset !== false) return fail("只同步自定义工作空间（preset:false），内置预设不同步");

  const id = String(workspace.id ?? "");
  if (!ID_PATTERN.test(id) || id.length > MAX_WORKSPACE_ID_CHARS) {
    return fail("workspace.id 非法（需字母数字开头，仅含 A-Za-z0-9._:-，≤128 字符）");
  }
  const nameError = validateString(workspace.name, "workspace.name", MAX_WORKSPACE_NAME_CHARS);
  if (nameError) return fail(nameError);
  const themeError = validateString(workspace.theme, "workspace.theme", 64);
  if (themeError) return fail(themeError);
  const wallError = validateString(workspace.wall, "workspace.wall", 64);
  if (wallError) return fail(wallError);

  if (!isPlainObject(workspace.widgets)) return fail("workspace.widgets 必须是对象");
  const widgetIds = Object.keys(workspace.widgets);
  if (widgetIds.length > MAX_WORKSPACE_WIDGETS) {
    return fail(`workspace.widgets 超过 ${MAX_WORKSPACE_WIDGETS} 项上限（当前 ${widgetIds.length}）`);
  }
  for (const widgetId of widgetIds) {
    if (!WIDGET_ID_PATTERN.test(widgetId) || widgetId.length > 64) return fail(`workspace.widgets 含非法键 ${widgetId}`);
  }

  for (const [label, value] of [
    ["dock", workspace.dock],
    ["shortcuts", workspace.shortcuts],
    ["openApps", workspace.openApps],
  ] as const) {
    const arrayError = validateStringArray(value, `workspace.${label}`);
    if (arrayError) return fail(arrayError);
  }

  if (typeof workspace.dnd !== "boolean") return fail("workspace.dnd 必须是布尔值");
  for (const field of ["createdAt", "updatedAt"] as const) {
    const value = asFinite(workspace[field]);
    if (value === null || value < 0) return fail(`workspace.${field} 必须是非负数字`);
  }

  if (!isPlainObject(workspace.windows)) return fail("workspace.windows 必须是对象");
  const windowIds = Object.keys(workspace.windows);
  if (windowIds.length > MAX_WORKSPACE_WINDOWS) {
    return fail(`workspace.windows 超过 ${MAX_WORKSPACE_WINDOWS} 项上限（当前 ${windowIds.length}）`);
  }
  for (const [app, value] of Object.entries(workspace.windows)) {
    if (!isPlainObject(value)) return fail(`workspace.windows.${app} 必须是对象`);
    const width = asFinite(value.width);
    const height = asFinite(value.height);
    if (width === null || height === null || width <= 0 || height <= 0) {
      return fail(`workspace.windows.${app} 的宽高必须是正数`);
    }
    if (width > 20000 || height > 20000) return fail(`workspace.windows.${app} 的宽高超出合理范围`);
    for (const field of ["left", "top"] as const) {
      if (asFinite(value[field]) === null) return fail(`workspace.windows.${app}.${field} 必须是数字`);
    }
    if (asFinite(value.space) === null) return fail(`workspace.windows.${app}.space 必须是数字`);
    for (const field of ["minimized", "maximized"] as const) {
      if (typeof value[field] !== "boolean") return fail(`workspace.windows.${app}.${field} 必须是布尔值`);
    }
  }

  const viewport = payload.viewport;
  if (viewport !== null) {
    if (!isPlainObject(viewport)) return fail("viewport 必须是对象或 null");
    const width = asFinite(viewport.width);
    const height = asFinite(viewport.height);
    if (width === null || height === null || width <= 0 || height <= 0) return fail("viewport 宽高必须是正数");
    if (width > 20000 || height > 20000) return fail("viewport 宽高超出合理范围");
  }

  const capturedAt = asFinite(payload.capturedAt);
  if (capturedAt === null || capturedAt < 0) return fail("capturedAt 必须是非负数字");

  const normalized: WorkspacePayload = {
    v: 1,
    workspace: {
      id,
      name: String(workspace.name),
      preset: false,
      theme: String(workspace.theme),
      wall: String(workspace.wall),
      widgets: sanitizeWidgets(workspace.widgets),
      dock: sanitizeStringArray(workspace.dock),
      shortcuts: sanitizeStringArray(workspace.shortcuts),
      windows: sanitizeWindows(workspace.windows),
      openApps: sanitizeStringArray(workspace.openApps),
      dnd: workspace.dnd === true,
      createdAt: Math.trunc(asFinite(workspace.createdAt) ?? 0),
      updatedAt: Math.trunc(asFinite(workspace.updatedAt) ?? 0),
    },
    viewport:
      viewport === null
        ? null
        : { width: Math.round(asFinite((viewport as Record<string, unknown>).width) ?? 0), height: Math.round(asFinite((viewport as Record<string, unknown>).height) ?? 0) },
    capturedAt: Math.trunc(capturedAt),
  };
  return { ok: true, payload: normalized, bytes };
}

/* ============================================================
   应用远端变更
   ============================================================ */

const toWindowPayloads = (windows: Record<string, WindowState>): Record<string, WorkspaceWindowPayload> => {
  const result: Record<string, WorkspaceWindowPayload> = {};
  for (const [app, state] of Object.entries(windows)) {
    result[app] = {
      left: Math.round(state.left),
      top: Math.round(state.top),
      width: Math.round(state.width),
      height: Math.round(state.height),
      minimized: state.minimized === true,
      maximized: state.maximized === true,
      space: Math.max(1, Math.trunc(state.space) || 1),
    };
  }
  return result;
};

export type WorkspaceApplyResult =
  | {
      ok: true;
      applied: true;
      id: string;
      created: boolean;
      windows: number;
      viewport: Viewport;
    }
  | { ok: false; applied: false; id?: string; error: string };

/**
 * 应用一条远端工作空间：插入或整条合并，窗口几何按
 * payload.viewport → 当前视口用 layout.normalizeSnapshot + rescaleSnapshot 重算。
 */
export function applyRemoteWorkspace(kernel: WorkspaceSyncKernel, payload: unknown): WorkspaceApplyResult {
  const validation = validateWorkspacePayload(payload);
  if (!validation.ok) return { ok: false, applied: false, error: validation.error };
  const remote = validation.payload;
  const target = currentViewport(kernel);
  const normalized = normalizeSnapshot({ windows: remote.workspace.windows, viewport: remote.viewport }, target);
  const rescaled = rescaleSnapshot(normalized, target, { cascade: false });
  const windows = toWindowPayloads(rescaled.windows);

  const state = readWorkspaceState(kernel);
  const existingIndex = state.list.findIndex((workspace) => workspace?.id === remote.workspace.id);
  const base = existingIndex >= 0 ? state.list[existingIndex] : null;
  const workspace: Workspace = {
    id: remote.workspace.id,
    name: remote.workspace.name,
    preset: false,
    theme: remote.workspace.theme,
    wall: remote.workspace.wall,
    widgets: { ...remote.workspace.widgets },
    dock: remote.workspace.dock.slice(),
    shortcuts: remote.workspace.shortcuts.slice(),
    windows: windows as Workspace["windows"],
    openApps: remote.workspace.openApps.slice(),
    dnd: remote.workspace.dnd,
    createdAt: remote.workspace.createdAt || base?.createdAt || Date.now(),
    updatedAt: remote.workspace.updatedAt,
    viewport: { ...target },
  };

  if (existingIndex >= 0) state.list[existingIndex] = workspace;
  else state.list.push(workspace);
  if (!state.current) state.current = workspace.id;
  writeWorkspaceState(kernel, state);

  const known = readKnownWorkspaces(kernel);
  known[workspace.id] = { updatedAt: workspace.updatedAt };
  writeKnownWorkspaces(kernel, known);

  return { ok: true, applied: true, id: workspace.id, created: existingIndex < 0, windows: Object.keys(windows).length, viewport: target };
}

/** 应用远端删除：移出列表；若删除的是当前工作空间则落回一个可用项 */
export function removeRemoteWorkspace(kernel: WorkspaceSyncKernel, id: string): { removed: boolean; id: string } {
  const state = readWorkspaceState(kernel);
  const index = state.list.findIndex((workspace) => workspace?.id === id);
  if (index < 0) {
    rememberWorkspaceDeleted(kernel, id);
    return { removed: false, id };
  }
  state.list.splice(index, 1);
  if (state.current === id) {
    state.current = state.list.find((workspace) => workspace.preset === true)?.id ?? state.list[0]?.id ?? "";
  }
  writeWorkspaceState(kernel, state);
  rememberWorkspaceDeleted(kernel, id);
  return { removed: true, id };
}

const rememberWorkspaceDeleted = (kernel: WorkspaceSyncKernel, id: string): void => {
  if (!ID_PATTERN.test(id)) return;
  const known = readKnownWorkspaces(kernel);
  const now = Date.now();
  known[id] = { updatedAt: now, deletedAt: now };
  writeKnownWorkspaces(kernel, known);
};

/** 应用一条 SyncItem（payload 或 deleted），供 provider.apply/pull 复用 */
export function applyWorkspaceSyncItem(
  kernel: WorkspaceSyncKernel,
  item: { id: string; deleted?: boolean; payload?: unknown },
): { applied: boolean; created?: boolean; removed?: boolean; error?: string } {
  if (item.deleted) {
    const result = removeRemoteWorkspace(kernel, item.id);
    return { applied: true, removed: result.removed };
  }
  const result = applyRemoteWorkspace(kernel, item.payload);
  if (!result.ok) return { applied: false, error: result.error };
  return { applied: true, created: result.created };
}

/** 当前本地自定义工作空间的可推送项（含已知删除的合成 deleted 项） */
export function collectWorkspaceSyncItems(kernel: WorkspaceSyncKernel): WorkspaceSyncItem[] {
  const state = readWorkspaceState(kernel);
  const custom = listCustomWorkspaces(kernel, state);
  const known = readKnownWorkspaces(kernel);
  const items: WorkspaceSyncItem[] = [];
  const present = new Set<string>();
  let knownChanged = false;
  const viewport = currentViewport(kernel);

  for (const workspace of custom) {
    present.add(workspace.id);
    const entry = known[workspace.id];
    if (entry?.deletedAt) {
      // 本地在删除后又重建了同 id：撤销删除标记
      delete known[workspace.id];
      knownChanged = true;
    }
    if (!known[workspace.id] || known[workspace.id].updatedAt !== workspace.updatedAt) {
      known[workspace.id] = { updatedAt: workspace.updatedAt };
      knownChanged = true;
    }
    items.push({
      id: workspace.id,
      updatedAt: workspace.updatedAt,
      payload: buildWorkspacePayload(workspace, workspace.viewport ?? viewport),
    });
  }

  const now = Date.now();
  for (const [id, entry] of Object.entries(known)) {
    if (present.has(id)) continue;
    if (!entry.deletedAt) {
      // 上次同步时还在，这次没了 → 本地删除
      entry.deletedAt = now;
      knownChanged = true;
    }
    items.push({ id, updatedAt: entry.deletedAt ?? now, deleted: true });
  }

  if (knownChanged) writeKnownWorkspaces(kernel, known);
  return items.sort((left, right) => left.id.localeCompare(right.id));
}

/** resolveSyncConflict 用：取出本地单条实体（不存在则按删除处理） */
export function readWorkspaceSyncItem(kernel: WorkspaceSyncKernel, id: string): WorkspaceSyncItem {
  const state = readWorkspaceState(kernel);
  const workspace = listCustomWorkspaces(kernel, state).find((item) => item.id === id);
  if (workspace) {
    return {
      id,
      updatedAt: workspace.updatedAt,
      payload: buildWorkspacePayload(workspace, workspace.viewport ?? currentViewport(kernel)),
    };
  }
  const known = readKnownWorkspaces(kernel);
  const deletedAt = known[id]?.deletedAt ?? Date.now();
  return { id, updatedAt: deletedAt, deleted: true };
}
