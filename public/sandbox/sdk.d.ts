/**
 * Guandao SDK 1.x · TypeScript 声明
 *
 * 与 `docs/SDK-1.md` 对应，适用于 Guandao OS 2.x。
 * 插件页面里通过 `<script src="/sandbox/sdk.js"></script>` 加载后，
 * `window.guandao` 即符合下列接口。
 *
 * 注意：这是沙箱内的**代理 API**，不是 Node / 浏览器原生能力；
 * 所有调用都经过宿主 Broker 的权限判定。
 */

export as namespace Guandao;

/** 宿主返回的错误统一是 Error + 稳定错误码 */
export type GuandaoErrorCode =
  | "INVALID_PAYLOAD"
  | "PAYLOAD_TOO_LARGE"
  | "TIMEOUT"
  | "CHANNEL_CLOSED"
  | "PERMISSION_DENIED"
  | "PERMISSION_NOT_DECLARED"
  | "UNKNOWN_METHOD"
  | "UNSUPPORTED"
  | "SERVICE_UNAVAILABLE"
  | "APP_NOT_FOUND"
  | "NOTIFICATION_RATE_LIMITED"
  | "INVALID_KEY"
  | "STORAGE_QUOTA"
  | "STORAGE_QUOTA_GLOBAL"
  | "STORAGE_WRITE_FAILED"
  | "FILE_TOKEN_EXPIRED"
  | "FILE_TOO_LARGE"
  | "EMPTY"
  | "COMMAND_NOT_DECLARED"
  | "COMMANDS_UNAVAILABLE"
  | "NO_THEME"
  | "NETWORK_FAILED"
  | "INVALID_URL"
  | "METHOD_NOT_ALLOWED"
  | "DOMAIN_NOT_ALLOWED"
  | "REDIRECT_BLOCKED"
  | (string & {});

export interface GuandaoError extends Error {
  code: GuandaoErrorCode;
}

export type NotifyLevel = "info" | "success" | "warning" | "error";

export interface AppContext {
  pluginId: string;
  version: string;
  type: "application" | "widget" | "command" | "theme" | "integration" | "file-handler" | (string & {});
  mode: "app" | "widget" | "command" | (string & {});
  osVersion: string;
  sdkVersion: 1;
  granted: string[];
  /** 沙箱内恒为 true */
  sandbox: true;
}

export interface ThemeSnapshot {
  mode: "light" | "dark";
  accent: string;
  accent2: string;
  material: string;
  radius: string;
  font: string;
  wall: string;
}

export interface PickedFile {
  token: string;
  name: string;
  size: number;
  type: string;
}

export interface ReadFileResult {
  name: string;
  size: number;
  /** UTF-8 文本，最多 256 KB */
  text: string;
}

export interface NetworkResult {
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface DeviceInfo {
  platform: string;
  language: string;
  online: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  reducedMotion: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  note: string;
}

export interface NoteSummary {
  title: string;
  body: string;
  tags: string[];
}

export interface UiApi {
  toast(text: string): Promise<{ ok: true }>;
  notify(options: { title?: string; body?: string; level?: NotifyLevel }): Promise<{ ok: true }>;
  dialog(options: {
    title?: string;
    message?: string;
    actions?: Array<{ label: string; value: string; primary?: boolean }>;
  }): Promise<string | null>;
  openApp(appId: string): Promise<{ ok: true }>;
  /** 组件模式下会以 UNSUPPORTED 拒绝 */
  setTitle(title: string): Promise<{ ok: true }>;
  /** 组件模式下会以 UNSUPPORTED 拒绝 */
  resize(size: { width: number; height: number }): Promise<{ width: number; height: number }>;
  close(): Promise<{ ok: true }>;
}

export interface StorageApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true }>;
  keys(): Promise<string[]>;
  clear(): Promise<{ ok: true }>;
}

export interface NotificationsApi {
  show(options: { title?: string; body?: string; level?: NotifyLevel }): Promise<{ ok: true }>;
  success(text: string): Promise<{ ok: true }>;
  warning(text: string): Promise<{ ok: true }>;
  error(text: string): Promise<{ ok: true }>;
}

export interface FilesApi {
  pick(options?: { accept?: string }): Promise<{ file: PickedFile | null }>;
  read(token: string): Promise<ReadFileResult>;
}

export interface ThemeApi {
  get(): Promise<ThemeSnapshot>;
  apply(): Promise<{ ok: true }>;
}

export interface CommandsApi {
  register(commands: Array<{ command: string }>): Promise<{ ok: true }>;
}

export interface CalendarApi {
  readSelected(): Promise<{ event: CalendarEvent | null }>;
  createEvent(input: {
    title: string;
    date: string;
    time?: string;
    note?: string;
  }): Promise<{ id: string; title: string; date: string; time: string }>;
}

export interface NotesApi {
  readSelected(): Promise<{ note: NoteSummary | null }>;
  create(input: { title: string; body?: string; tags?: string[] }): Promise<{ id: string; title: string }>;
}

export interface NetworkApi {
  fetch(
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<NetworkResult>;
}

export interface DeviceApi {
  info(): Promise<DeviceInfo>;
}

export interface LifecycleApi {
  ready(): Promise<{ ok: true }>;
  on(event: "ready", handler: (payload: { pluginId: string; granted: string[] }) => void): () => void;
  on(event: "theme-change", handler: (payload: ThemeSnapshot) => void): () => void;
  on(event: "command", handler: (payload: { command: string }) => void): () => void;
  on(event: string, handler: (payload: unknown) => void): () => void;
  reportError(error: Error | string): Promise<void>;
}

export interface AppApi {
  context(): Promise<AppContext>;
  lifecycle: LifecycleApi;
}

export interface GuandaoSdk {
  readonly sdkVersion: 1;
  readonly pluginId: string;
  readonly granted: string[];
  has(permission: string): boolean;

  context(): Promise<AppContext>;

  ui: UiApi;
  storage: StorageApi;
  notifications: NotificationsApi;
  /** @deprecated 使用 notifications.show */
  notify(options: { title?: string; body?: string; level?: NotifyLevel }): Promise<{ ok: true }>;
  files: FilesApi;
  theme: ThemeApi;
  commands: CommandsApi;
  calendar: CalendarApi;
  notes: NotesApi;
  network: NetworkApi;
  device: DeviceApi;
  lifecycle: LifecycleApi;
  app: AppApi;
}

declare global {
  interface Window {
    guandao: GuandaoSdk;
  }
}

export {};