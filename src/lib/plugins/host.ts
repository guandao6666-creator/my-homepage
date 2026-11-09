/**
 * Guandao OS 1.7 · 插件沙箱宿主与权限 Broker
 *
 * 安全模型（按重要性排序）：
 *   1. 插件运行在 sandbox="allow-scripts" 的 iframe 里，没有 allow-same-origin，
 *      实际 origin 是 opaque（"null"），读不到主页面的 DOM / Cookie / localStorage；
 *   2. 主页面只认「自己创建的那个 iframe」作为消息来源，绝不使用 event.origin
 *      判断身份（opaque iframe 的 origin 就是 "null"，谁都可以是 "null"）；
 *   3. 建立 MessageChannel 后，会话与端口绑定，插件自报的 pluginId 不予采信；
 *   4. 每个方法都有明确的能力映射，未授权立即返回 PERMISSION_DENIED；
 *   5. 有频率、体积、超时限制，插件卡死只影响自己的 iframe。
 */

import type { Ctx } from "../os14/core";
import { escapeHtml } from "../os14/core";
import { OS_VERSION, SDK_VERSION, PERMISSION_BY_ID } from "../../../shared/plugin-spec.js";
import type { InstallRecord } from "./store";
import {
  appendLog,
  getBundle,
  patchInstall,
  storageClear,
  storageDelete,
  storageGet,
  storageKeys,
  storageSet,
  STATE_KEY,
} from "./store";
import { verifyBundle } from "./bundle";
import { applyTheme, normalizeTheme, saveCustomTheme } from "../os14/themes";
import { createEvent, createNote, listNoteSummaries, listUpcomingEvents, readEvent, readNote } from "./adapters";

// Cloudflare Static Assets 会把 /sandbox/runner.html 307 到无扩展名路径，
// 直接用无扩展名地址，避免每次启动多一次跳转。
const RUNNER_URL = "/sandbox/runner?v=1.7.0";
const SDK_URL = "/sandbox/sdk.js?v=1.7.0";
const RPC_LIMIT = 60;
const RPC_WINDOW = 10_000;
const RPC_TIMEOUT = 8_000;
const MAX_PAYLOAD = 24 * 1024;
const NOTIFY_LIMIT = 5;
const NOTIFY_WINDOW = 60_000;

export type SandboxMode = "app" | "widget" | "command";

type SessionOptions = {
  ctx: Ctx;
  record: InstallRecord;
  mode: SandboxMode;
  container: HTMLElement;
  windowEl?: HTMLElement;
  onStatus?: (status: "running" | "ready" | "failed") => void;
};

type RpcMessage = {
  channel?: string;
  kind?: string;
  pluginId?: string;
  requestId?: string;
  method?: string;
  payload?: unknown;
};

const METHOD_PERMISSION: Record<string, string | null> = {
  "app.context": null,
  "ui.toast": null,
  "ui.notify": "notification.show",
  "ui.dialog": "dialog.open",
  "ui.openApp": "desktop.open_app",
  "ui.setTitle": null,
  "ui.resize": null,
  "ui.close": null,
  "theme.get": "theme.read",
  "theme.apply": "theme.apply",
  "storage.get": "plugin.storage.read",
  "storage.keys": "plugin.storage.read",
  "storage.set": "plugin.storage.write",
  "storage.delete": "plugin.storage.write",
  "storage.clear": "plugin.storage.write",
  "files.pick": "files.pick",
  "files.read": "files.read_selected",
  "network.fetch": "network.fetch",
  "commands.register": "desktop.register_command",
  "widget.setEnabled": "desktop.add_widget",
  // 2.0：SDK 里早就有 widget.setTitle，但 Broker 表里一直没有，
  // 调用必然 UNKNOWN_METHOD。补上映射，权限与「修改桌面组件」一致。
  "widget.setTitle": "desktop.add_widget",
  "calendar.readSelected": "calendar.read_selected",
  "calendar.createEvent": "calendar.create_event",
  "notes.readSelected": "notes.read_selected",
  "notes.create": "notes.create",
  "lifecycle.error": null,
};

const sessions = new Map<string, Set<PluginSandbox>>();

/** 命令注册由 commands.ts 注入，避免 host ↔ commands 的循环依赖。 */
let commandSink:
  | ((pluginId: string, commands: string[], titles: Map<string, string>) => void)
  | null = null;

export function setCommandSink(fn: (pluginId: string, commands: string[], titles: Map<string, string>) => void) {
  commandSink = fn;
}
let sdkPromise: Promise<string> | null = null;
const entryCache = new Map<string, string>();

function loadSdk(): Promise<string> {
  if (!sdkPromise) {
    sdkPromise = fetch(SDK_URL, { credentials: "omit", cache: "force-cache" })
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (!text) throw new Error("SDK 预置脚本加载失败");
        return text;
      })
      .catch((error) => {
        sdkPromise = null;
        throw error;
      });
  }
  return sdkPromise;
}

export async function loadEntryHtml(record: InstallRecord): Promise<string> {
  const cacheKey = `${record.id}@${record.version}`;
  const cached = entryCache.get(cacheKey);
  if (cached) return cached;
  const raw = await getBundle(record.bundleKey);
  if (!raw) throw new Error("本地插件包丢失，请重新安装");
  const verified = await verifyBundle(raw, { id: record.id, type: record.type, checksum: record.packageHash });
  if (!verified.ok) throw new Error(verified.errors[0] || "插件包校验失败");
  entryCache.set(cacheKey, verified.html);
  return verified.html;
}

export function clearEntryCache(id?: string) {
  if (!id) {
    entryCache.clear();
    return;
  }
  for (const key of [...entryCache.keys()]) if (key.startsWith(`${id}@`)) entryCache.delete(key);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function themeSnapshot(ctx: Ctx) {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = ctx.api13.cfg() as Record<string, unknown>;
  } catch {
    cfg = {};
  }
  const appearance = (cfg.appearance ?? {}) as Record<string, unknown>;
  return {
    mode: appearance.mode === "light" ? "light" : "dark",
    accent: String(appearance.accent || "#6f8cff"),
    accent2: String(appearance.accent2 || "#b06eff"),
    material: String(appearance.material || "glass"),
    radius: String(appearance.radius || "round"),
    font: document.body.dataset.font14 || "sans",
    wall: String((cfg.wall as Record<string, unknown> | undefined)?.id || "aurora"),
  };
}

export class PluginSandbox {
  private ctx: Ctx;
  private record: InstallRecord;
  private mode: SandboxMode;
  private container: HTMLElement;
  private windowEl?: HTMLElement;
  private iframe: HTMLIFrameElement;
  private port: MessagePort | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private destroyed = false;
  private mounted = false;
  private hits: number[] = [];
  private notifyHits: number[] = [];
  /** 运行器在 HELLO 里发来的随机数，MOUNT 时带回去，防止被导航后的文档接管端口 */
  private nonce = "";
  private pickedFiles = new Map<string, { file: File; expires: number }>();
  private onStatus?: (status: "running" | "ready" | "failed") => void;

  constructor(options: SessionOptions) {
    this.ctx = options.ctx;
    this.record = options.record;
    this.mode = options.mode;
    this.container = options.container;
    this.windowEl = options.windowEl;
    this.onStatus = options.onStatus;

    this.iframe = document.createElement("iframe");
    this.iframe.className = "gp-frame";
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.setAttribute("title", `${this.record.name} · 插件沙箱`);
    this.iframe.src = RUNNER_URL;
    this.container.appendChild(this.iframe);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    window.addEventListener("message", this.onWindowMessage);
    const set = sessions.get(this.record.id) ?? new Set<PluginSandbox>();
    set.add(this);
    sessions.set(this.record.id, set);
    this.onStatus?.("running");
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  private onWindowMessage = (event: MessageEvent) => {
    if (this.destroyed) return;
    // 只认这个 iframe 实例；opaque origin 的 "null" 不能作为身份依据
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data as RpcMessage;
    if (!data || data.channel !== "guandao.plugin.sandbox") return;
    if (data.kind === "HELLO" && !this.mounted) {
      this.nonce = String((data as { nonce?: string }).nonce || "");
      void this.mount();
      return;
    }
    if (data.kind === "READY") {
      this.onStatus?.("ready");
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (data.kind === "ERROR") {
      this.fail(new Error("插件沙箱报告错误"));
    }
  };

  private async mount() {
    if (this.mounted) return;
    this.mounted = true;
    try {
      const [sdk, html] = await Promise.all([loadSdk(), loadEntryHtml(this.record)]);
      if (this.destroyed) return;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = this.onPortMessage;
      this.port.start();

      const target = this.iframe.contentWindow;
      if (!target) throw new Error("沙箱 iframe 尚未就绪");
      target.postMessage(
        {
          channel: "guandao.plugin.sandbox",
          kind: "MOUNT",
          mountId: `mnt-${Math.random().toString(36).slice(2, 10)}`,
          nonce: this.nonce,
          pluginId: this.record.id,
          html,
          sdk,
          granted: this.record.granted,
          theme: themeSnapshot(this.ctx),
          context: {
            osVersion: OS_VERSION,
            sdkVersion: SDK_VERSION,
            version: this.record.version,
            type: this.record.type,
            mode: this.mode,
          },
        },
        "*",
        [channel.port2],
      );

      window.setTimeout(() => {
        if (this.destroyed || !this.readyResolve) return;
        this.fail(new Error("插件在 12 秒内没有完成启动"));
      }, 12_000);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("插件启动失败"));
    }
  }

  private fail(error: Error) {
    if (this.destroyed) return;
    appendLog(this.record.id, "error", error.message);
    this.ctx.toast(`插件「${this.record.name}」启动失败`);
    this.onStatus?.("failed");
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.destroy();
  }

  private onPortMessage = (event: MessageEvent) => {
    const data = event.data as RpcMessage;
    if (!data || typeof data !== "object") return;

    // READY / ERROR 由运行器通过 MessagePort 回传（不是 window message）
    if (data.kind === "READY") {
      this.onStatus?.("ready");
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (data.kind === "ERROR") {
      this.fail(new Error("插件沙箱报告错误"));
      return;
    }
    // 1.9：沙箱报告「插件把自己的 frame 导航出去了」。
    // 这是唯一能绕过 connect-src 'none' 的外泄通道，必须当作安全事件处理：
    // 立即销毁会话、禁用插件、写入审计日志，而不是只显示一个启动失败。
    if (data.kind === "EVENT" && (data as { event?: string }).event === "sandbox:navigation") {
      appendLog(this.record.id, "error", "插件试图导航出沙箱，已强制禁用");
      this.ctx.toast(`「${this.record.name}」试图跳出安全沙箱，已被禁用`);
      try {
        // 直接改安装记录：禁用 + 标记 blocked，下次启动也会被拦下。
        patchInstall(this.record.id, { enabled: false, blocked: true });
        window.dispatchEvent(new CustomEvent("guandao:plugins-change"));
      } catch {
        /* 持久化失败也要先断开连接 */
      }
      // 2.0：不能只在本地封禁 —— 上报服务端，让审核队列看到真实事件。
      void reportSandboxEscape(this.record.id);
      this.fail(new Error("插件试图跳出沙箱"));
      return;
    }
    if (data.kind !== "RPC") return;
    if (data.pluginId !== this.record.id) return;
    const requestId = String(data.requestId || "");
    const method = String(data.method || "");
    if (!requestId || !method) return;
    void this.handleRpc(requestId, method, data.payload);
  };

  private reply(requestId: string, ok: boolean, result?: unknown, error?: { code: string; message: string }) {
    if (!this.port || this.destroyed) return;
    try {
      this.port.postMessage({ kind: "RESULT", requestId, ok, result, error });
    } catch {
      /* 端口已关闭 */
    }
  }

  private allowed(): boolean {
    return !this.destroyed && Boolean(this.record.enabled);
  }

  private checkRate(kind: "rpc" | "notify"): boolean {
    const now = Date.now();
    const list = kind === "rpc" ? this.hits : this.notifyHits;
    const windowMs = kind === "rpc" ? RPC_WINDOW : NOTIFY_WINDOW;
    const limit = kind === "rpc" ? RPC_LIMIT : NOTIFY_LIMIT;
    while (list.length && now - list[0] > windowMs) list.shift();
    if (list.length >= limit) return false;
    list.push(now);
    return true;
  }

  private async handleRpc(requestId: string, method: string, payload: unknown) {
    if (!this.allowed()) {
      this.reply(requestId, false, undefined, { code: "PLUGIN_DISABLED", message: "插件已禁用或上下文已关闭" });
      return;
    }
    if (!this.checkRate("rpc")) {
      this.reply(requestId, false, undefined, { code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(METHOD_PERMISSION, method)) {
      this.reply(requestId, false, undefined, { code: "UNKNOWN_METHOD", message: `宿主没有提供方法 ${method}` });
      return;
    }
    if (payload !== undefined && payload !== null) {
      try {
        const encoded = JSON.stringify(payload);
        if (encoded.length > MAX_PAYLOAD) {
          this.reply(requestId, false, undefined, { code: "PAYLOAD_TOO_LARGE", message: "参数超过 24 KB" });
          return;
        }
      } catch {
        this.reply(requestId, false, undefined, { code: "INVALID_PAYLOAD", message: "参数无法序列化" });
        return;
      }
    }

    const permission = METHOD_PERMISSION[method];
    if (permission && !this.record.granted.includes(permission)) {
      appendLog(this.record.id, "warn", `拒绝未授权调用 ${method}（需要 ${permission}）`);
      this.reply(requestId, false, undefined, {
        code: "PERMISSION_DENIED",
        message: `缺少权限：${PERMISSION_BY_ID[permission]?.label ?? permission}`,
      });
      return;
    }

    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(Object.assign(new Error("宿主处理超时"), { code: "TIMEOUT" })), RPC_TIMEOUT);
    });

    try {
      const result = await Promise.race([this.dispatch(method, payload), timeout]);
      this.reply(requestId, true, result ?? null);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      this.reply(requestId, false, undefined, {
        code: err?.code || "HANDLER_FAILED",
        message: err?.message || "宿主处理失败",
      });
    }
  }

  private async dispatch(method: string, payload: unknown): Promise<unknown> {
    const input = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    switch (method) {
      case "app.context":
        return {
          pluginId: this.record.id,
          version: this.record.version,
          type: this.record.type,
          mode: this.mode,
          osVersion: OS_VERSION,
          sdkVersion: SDK_VERSION,
          granted: [...this.record.granted],
          sandbox: true,
        };

      case "ui.toast": {
        const text = String(input.text ?? "").slice(0, 200);
        if (!text) throw new Error("提示内容为空");
        this.ctx.toast(text);
        return { ok: true };
      }

      case "ui.notify": {
        if (!this.checkRate("notify")) {
          throw Object.assign(new Error("通知过于频繁（每分钟最多 5 条）"), { code: "NOTIFICATION_RATE_LIMITED" });
        }
        const level = ["info", "success", "warning", "error"].includes(String(input.level)) ? String(input.level) : "info";
        this.ctx.pushNotif({
          icon: level === "error" ? "!" : level === "warning" ? "△" : level === "success" ? "✓" : "◈",
          title: String(input.title ?? this.record.name).slice(0, 80),
          body: String(input.body ?? "").slice(0, 400),
        });
        return { ok: true };
      }

      case "ui.dialog": {
        const actions = Array.isArray(input.actions)
          ? input.actions.slice(0, 3).map((item) => {
              const action = (item ?? {}) as Record<string, unknown>;
              return {
                label: String(action.label ?? "确定").slice(0, 24),
                value: String(action.value ?? "").slice(0, 24),
                primary: Boolean(action.primary),
              };
            })
          : [{ label: "确定", value: "ok", primary: true }];
        const value = await this.openDialog({
          title: String(input.title ?? "确认").slice(0, 80),
          message: String(input.message ?? "").slice(0, 600),
          actions,
        });
        return { action: value ?? null };
      }

      case "ui.openApp": {
        const appId = String(input.appId ?? "");
        if (!/^[a-z0-9:-]{1,48}$/i.test(appId) || !this.ctx.APPS[appId]) {
          throw Object.assign(new Error("应用不存在或不可打开"), { code: "APP_NOT_FOUND" });
        }
        this.ctx.openApp(appId);
        return { ok: true };
      }

      case "ui.setTitle": {
        const title = String(input.title ?? "").trim().slice(0, 60);
        if (!title) throw new Error("标题为空");
        const node = this.windowEl?.querySelector<HTMLElement>(".win-title");
        // 2.0：组件模式没有窗口标题。以前这里找不到节点也返回 ok，
        // 属于「静默成功」，与 SDK 的「不存在静默降级」约定冲突。
        if (!node) throw Object.assign(new Error("组件没有窗口标题，ui.setTitle 在组件模式下不可用"), { code: "UNSUPPORTED" });
        node.textContent = title;
        return { ok: true };
      }

      case "ui.resize": {
        if (!this.windowEl) throw Object.assign(new Error("组件窗口不能调整大小"), { code: "UNSUPPORTED" });
        const width = clamp(Number(input.width) || 0, 360, 1440);
        const height = clamp(Number(input.height) || 0, 260, 900);
        this.windowEl.style.width = `${width}px`;
        this.windowEl.style.height = `${height}px`;
        return { width, height };
      }

      case "ui.close": {
        if (this.mode === "app" && this.windowEl) this.ctx.closeWin(this.windowEl);
        else if (this.mode === "widget") this.ctx.widgets.setEnabled(this.widgetId(), false);
        else this.destroy();
        return { ok: true };
      }

      case "theme.get":
        return themeSnapshot(this.ctx);

      case "theme.apply": {
        if (this.record.type !== "theme" || !this.record.manifest.contributes.theme) {
          throw Object.assign(new Error("这个插件没有主题预设"), { code: "NO_THEME" });
        }
        const preset = this.record.manifest.contributes.theme;
        const theme = normalizeTheme({
          id: this.record.id,
          name: preset.name,
          en: preset.en || "插件",
          author: this.record.author,
          desc: preset.desc,
          style: "插件主题",
          wall: preset.wall,
          mode: preset.mode,
          accent: preset.accent,
          accent2: preset.accent2,
          material: preset.material,
          radius: preset.radius,
          font: preset.font,
          grain: preset.grain,
          tags: ["插件"],
        });
        if (!theme) throw Object.assign(new Error("主题预设不合法"), { code: "INVALID_THEME" });
        saveCustomTheme(theme);
        applyTheme(theme);
        return { ok: true, themeId: theme.id };
      }

      case "storage.get":
      case "storage.keys":
      case "storage.set":
      case "storage.delete":
      case "storage.clear":
        return this.handleStorage(method, input);

      case "files.pick":
        return this.pickFile(input);

      case "files.read":
        return this.readPickedFile(String(input.token ?? ""));

      case "network.fetch":
        return this.proxyNetwork(input);

      case "commands.register": {
        const list = Array.isArray(input.commands) ? input.commands : [];
        const declared = new Map(
          (this.record.manifest.contributes.command ?? []).map((item) => [item.command, item.title]),
        );
        const accepted: string[] = [];
        for (const item of list.slice(0, 8)) {
          const command = String((item as Record<string, unknown>)?.command ?? "");
          if (!declared.has(command)) {
            throw Object.assign(new Error(`命令 ${command} 未在 Manifest 中声明`), { code: "COMMAND_NOT_DECLARED" });
          }
          accepted.push(command);
        }
        if (!commandSink) throw Object.assign(new Error("命令系统尚未就绪"), { code: "COMMANDS_UNAVAILABLE" });
        commandSink(this.record.id, accepted, declared);
        return { registered: accepted };
      }

      case "widget.setEnabled": {
        if (this.record.type !== "widget") throw Object.assign(new Error("这不是组件插件"), { code: "UNSUPPORTED" });
        this.ctx.widgets.setEnabled(this.widgetId(), Boolean(input.enabled));
        return { enabled: Boolean(input.enabled) };
      }

      case "widget.setTitle": {
        // 2.0：补齐 SDK 已经声明、Broker 缺失的方法
        if (this.record.type !== "widget") throw Object.assign(new Error("这不是组件插件"), { code: "UNSUPPORTED" });
        const title = String(input.title ?? "").trim().slice(0, 40);
        if (!title) throw Object.assign(new Error("标题为空"), { code: "INVALID_ARGUMENT" });
        const widgetId = this.widgetId();
        this.ctx.widgets.titles[widgetId] = title;
        return { title };
      }

      case "calendar.readSelected": {
        const events = listUpcomingEvents();
        if (!events.length) throw Object.assign(new Error("日历里还没有即将到来的日程"), { code: "EMPTY" });
        const picked = await this.pickFromList(
          "选择一个日程",
          events.map((event) => ({
            value: event.id,
            title: `${event.title}`,
            sub: `${event.date} ${event.time}`,
          })),
          "只把这一条日程交给插件，其余内容不会被读取。",
        );
        if (!picked) return { event: null };
        const event = readEvent(picked);
        return {
          event: event
            ? { title: event.title, date: event.date, time: event.time, note: event.note, category: event.category }
            : null,
        };
      }

      case "calendar.createEvent": {
        const event = createEvent({
          title: String(input.title ?? ""),
          date: String(input.date ?? ""),
          time: String(input.time ?? "09:00"),
          note: String(input.note ?? ""),
        });
        this.ctx.toast(`已添加日程：${event.title}`);
        return { id: event.id, title: event.title, date: event.date, time: event.time };
      }

      case "notes.readSelected": {
        const notes = listNoteSummaries();
        if (!notes.length) throw Object.assign(new Error("还没有笔记可以读取"), { code: "EMPTY" });
        const picked = await this.pickFromList(
          "选择一条笔记",
          notes.slice(0, 40).map((note) => ({ value: note.id, title: note.title, sub: new Date(note.updatedAt).toLocaleString("zh-CN") })),
          "只把选中的这一条交给插件，不会读取其它笔记。",
        );
        if (!picked) return { note: null };
        const note = readNote(picked);
        return {
          note: note ? { title: note.title, body: note.body.slice(0, 20000), tags: note.tags } : null,
        };
      }

      case "notes.create": {
        const note = createNote({
          title: String(input.title ?? ""),
          body: String(input.body ?? ""),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        });
        this.ctx.toast(`已创建笔记：${note.title}`);
        return { id: note.id, title: note.title };
      }

      case "lifecycle.error": {
        appendLog(this.record.id, "error", String(input.message ?? "插件报告错误").slice(0, 300));
        return { ok: true };
      }

      default:
        throw Object.assign(new Error("未知方法"), { code: "UNKNOWN_METHOD" });
    }
  }

  private widgetId() {
    return `plugin-widget:${this.record.id}`;
  }

  private handleStorage(method: string, input: Record<string, unknown>) {
    const key = String(input.key ?? "");
    if (method === "storage.get") return { value: storageGet(this.record.id, key) };
    if (method === "storage.keys") return { keys: storageKeys(this.record.id) };
    if (method === "storage.set") {
      const result = storageSet(this.record.id, key, input.value);
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      return { ok: true };
    }
    if (method === "storage.delete") return { deleted: storageDelete(this.record.id, key) };
    storageClear(this.record.id);
    return { ok: true };
  }

  private async pickFile(input: Record<string, unknown>): Promise<unknown> {
    const accept = String(input.accept ?? "").slice(0, 120);
    const file = await new Promise<File | null>((resolve) => {
      const layer = document.createElement("div");
      layer.className = "gp-dialog-layer";
      layer.innerHTML = `
        <div class="gp-dialog" role="dialog" aria-modal="true">
          <p class="gp-dialog-title">选择文件</p>
          <p class="gp-dialog-msg">「${escapeHtml(this.record.name)}」只能读取你在这里主动选择的文件。</p>
          <input class="gp-file-input" type="file" ${accept ? `accept="${escapeHtml(accept)}"` : ""} />
          <div class="gp-dialog-actions">
            <button type="button" class="gp-btn" data-gp="cancel">取消</button>
            <button type="button" class="gp-btn is-primary" data-gp="ok" disabled>交给插件</button>
          </div>
        </div>`;
      const inputEl = layer.querySelector<HTMLInputElement>("input[type=file]");
      const okBtn = layer.querySelector<HTMLButtonElement>('[data-gp="ok"]');
      const close = (value: File | null) => {
        layer.remove();
        resolve(value);
      };
      inputEl?.addEventListener("change", () => {
        if (okBtn) okBtn.disabled = !inputEl.files?.length;
      });
      okBtn?.addEventListener("click", () => close(inputEl?.files?.[0] ?? null));
      layer.querySelector('[data-gp="cancel"]')?.addEventListener("click", () => close(null));
      layer.addEventListener("click", (event) => {
        if (event.target === layer) close(null);
      });
      this.ctx.os.appendChild(layer);
    });

    if (!file) return { file: null };
    const token = `pf-${Math.random().toString(36).slice(2, 12)}`;
    this.pickedFiles.set(token, { file, expires: Date.now() + 10 * 60_000 });
    return {
      file: { token, name: file.name.slice(0, 120), size: file.size, type: file.type || "application/octet-stream" },
    };
  }

  private async readPickedFile(token: string) {
    const entry = this.pickedFiles.get(token);
    if (!entry || entry.expires < Date.now()) {
      throw Object.assign(new Error("文件授权已过期，请重新选择"), { code: "FILE_TOKEN_EXPIRED" });
    }
    if (entry.file.size > 256 * 1024) {
      throw Object.assign(new Error("文件超过 256 KB，暂不支持读取"), { code: "FILE_TOO_LARGE" });
    }
    const buffer = await entry.file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    return { name: entry.file.name, size: entry.file.size, text: text.slice(0, 262144) };
  }

  private async proxyNetwork(input: Record<string, unknown>) {
    const response = await fetch("/api/plugins/net", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        pluginId: this.record.id,
        url: String(input.url ?? ""),
        method: String(input.method ?? "GET"),
        headers: input.headers ?? {},
        body: String(input.body ?? ""),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw Object.assign(new Error(payload?.error?.message || "网络请求失败"), {
        code: payload?.error?.code || "NETWORK_FAILED",
      });
    }
    return payload.data;
  }

  private openDialog(options: {
    title: string;
    message: string;
    actions: Array<{ label: string; value: string; primary?: boolean }>;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "gp-dialog-layer";
      layer.innerHTML = `
        <div class="gp-dialog" role="dialog" aria-modal="true">
          <p class="gp-dialog-title">${escapeHtml(options.title)}</p>
          <p class="gp-dialog-msg">${escapeHtml(options.message)}</p>
          <div class="gp-dialog-actions">
            ${options.actions
              .map(
                (action) =>
                  `<button type="button" class="gp-btn${action.primary ? " is-primary" : ""}" data-value="${escapeHtml(action.value)}">${escapeHtml(action.label)}</button>`,
              )
              .join("")}
          </div>
          <p class="gp-dialog-note">由插件「${escapeHtml(this.record.name)}」发起</p>
        </div>`;
      const done = (value: string | null) => {
        layer.remove();
        resolve(value);
      };
      layer.addEventListener("click", (event) => {
        if (event.target === layer) done(null);
        const button = (event.target as HTMLElement).closest<HTMLElement>("[data-value]");
        if (button) done(button.dataset.value ?? "");
      });
      this.ctx.os.appendChild(layer);
    });
  }

  private pickFromList(
    title: string,
    items: Array<{ value: string; title: string; sub: string }>,
    note: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "gp-dialog-layer";
      layer.innerHTML = `
        <div class="gp-dialog is-wide" role="dialog" aria-modal="true">
          <p class="gp-dialog-title">${escapeHtml(title)}</p>
          <p class="gp-dialog-msg">${escapeHtml(note)}</p>
          <div class="gp-pick-list">
            ${items
              .map(
                (item) =>
                  `<button type="button" class="gp-pick-item" data-value="${escapeHtml(item.value)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.sub)}</span></button>`,
              )
              .join("")}
          </div>
          <div class="gp-dialog-actions">
            <button type="button" class="gp-btn" data-gp-cancel>取消</button>
          </div>
        </div>`;
      const done = (value: string | null) => {
        layer.remove();
        resolve(value);
      };
      layer.addEventListener("click", (event) => {
        if (event.target === layer) done(null);
        const item = (event.target as HTMLElement).closest<HTMLElement>(".gp-pick-item");
        if (item) done(item.dataset.value ?? "");
        if ((event.target as HTMLElement).closest("[data-gp-cancel]")) done(null);
      });
      this.ctx.os.appendChild(layer);
    });
  }

  sendEvent(event: string, payload?: unknown) {
    if (!this.port || this.destroyed) return;
    try {
      this.port.postMessage({ kind: "EVENT", event, payload });
    } catch {
      /* 忽略 */
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener("message", this.onWindowMessage);
    try {
      this.port?.postMessage({ kind: "DESTROY" });
      this.port?.close();
    } catch {
      /* 忽略 */
    }
    this.port = null;
    try {
      this.iframe.remove();
    } catch {
      /* 忽略 */
    }
    // 命令模式下宿主会临时插一个隐藏容器，销毁时一起摘掉，避免每次执行命令都遗留空 div
    if (this.mode === "command") {
      try {
        this.container.remove();
      } catch {
        /* 已被移除 */
      }
    }
    this.pickedFiles.clear();
    const set = sessions.get(this.record.id);
    set?.delete(this);
    if (set && !set.size) sessions.delete(this.record.id);
    this.readyReject?.(new Error("插件上下文已关闭"));
    this.readyResolve = null;
    this.readyReject = null;
  }
}

export function destroySessionsFor(pluginId: string) {
  const set = sessions.get(pluginId);
  if (!set) return;
  for (const session of [...set]) session.destroy();
  sessions.delete(pluginId);
}

/**
 * 沙箱逃逸上报（2.0）。
 *
 * 1.9 只在本地禁用插件，管理员看不到真实发生的逃逸事件。这里补一条服务端记录，
 * 进入插件审核队列；失败静默（离线 / 未登录时不应该阻断本地封禁）。
 */
async function reportSandboxEscape(pluginId: string): Promise<void> {
  try {
    await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/security`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        event: "sandbox:navigation",
        detail: `插件运行时报告 frame 被导航出沙箱（${location.host}）`,
      }),
    });
  } catch {
    /* 离线或未登录：本地封禁已经生效 */
  }
}

/**
 * 跨标签页权限撤销（2.0）。
 *
 * 插件安装在 localStorage（guandao.plugins.v1）里，storage 事件只会在**其他**标签页触发。
 * 收到变更就销毁本页所有插件运行时：下一次打开会重新读取授权，避免
 * 「A 标签页已撤销权限、B 标签页里的插件还在用」。
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STATE_KEY) return;
    for (const pluginId of [...sessions.keys()]) destroySessionsFor(pluginId);
  });
}

export function sessionCount(pluginId: string): number {
  return sessions.get(pluginId)?.size ?? 0;
}

/* ============================================================
   对外挂载入口
   ============================================================ */

export async function mountPluginApp(options: {
  ctx: Ctx;
  record: InstallRecord;
  windowEl: HTMLElement;
  body: HTMLElement;
  onStatus?: (status: "running" | "ready" | "failed") => void;
}): Promise<PluginSandbox> {
  const sandbox = new PluginSandbox({
    ctx: options.ctx,
    record: options.record,
    mode: "app",
    container: options.body,
    windowEl: options.windowEl,
    onStatus: options.onStatus,
  });
  await sandbox.ready;
  return sandbox;
}

export async function mountPluginWidget(options: {
  ctx: Ctx;
  record: InstallRecord;
  host: HTMLElement;
}): Promise<PluginSandbox> {
  const sandbox = new PluginSandbox({
    ctx: options.ctx,
    record: options.record,
    mode: "widget",
    container: options.host,
  });
  await sandbox.ready;
  return sandbox;
}

export async function runPluginCommand(options: {
  ctx: Ctx;
  record: InstallRecord;
  command: string;
}): Promise<void> {
  const layer = document.createElement("div");
  layer.className = "gp-command-host";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const sandbox = new PluginSandbox({
    ctx: options.ctx,
    record: options.record,
    mode: "command",
    container: layer,
  });

  try {
    await sandbox.ready;
    sandbox.sendEvent("command", { command: options.command });
    appendLog(options.record.id, "info", `执行命令 ${options.command}`);
    // 命令插件没有常驻窗口，留 20 秒给异步操作（通知、写存储、打开应用）
    window.setTimeout(() => sandbox.destroy(), 20_000);
  } catch (error) {
    sandbox.destroy();
    throw error;
  }
}

