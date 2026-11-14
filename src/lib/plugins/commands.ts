/**
 * Guandao OS 1.7 · 命令面板
 *
 * 插件命令必须同时满足三件事才会出现：
 *   1. 插件已安装并启用；
 *   2. 用户授予了 desktop.register_command；
 *   3. 命令在 Manifest 的 contributes.command 里声明过（运行期注册也只能是子集）。
 *
 * 执行时拉起一个短生命周期的沙箱上下文，把 command 事件发进去，20 秒后回收。
 * 命令插件没有常驻窗口，也不允许直接操作宿主 DOM。
 */

import { escapeHtml, type Ctx } from "../os14/core";
import { getInstall, listInstalls } from "./store";
import { runPluginCommand, setCommandSink } from "./host";

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle: string;
  kind: "core" | "plugin";
  pluginId?: string;
  run: () => void | Promise<void>;
};

const runtimeCommands = new Map<string, Map<string, string>>();
let ctxRef: Ctx | null = null;
let overlay: HTMLElement | null = null;
let filtered: PaletteCommand[] = [];
let cursor = 0;

export function registerRuntimeCommands(pluginId: string, commands: string[], titles: Map<string, string>) {
  const map = runtimeCommands.get(pluginId) ?? new Map<string, string>();
  for (const command of commands) map.set(command, titles.get(command) ?? command);
  runtimeCommands.set(pluginId, map);
}

export function unregisterPluginCommands(pluginId: string) {
  runtimeCommands.delete(pluginId);
}

export function commandCountFor(pluginId: string): number {
  return runtimeCommands.get(pluginId)?.size ?? 0;
}

function coreCommands(ctx: Ctx): PaletteCommand[] {
  const open = (id: string, title: string) => ({
    id: `core.open.${id}`,
    title: `打开${title}`,
    subtitle: "系统",
    kind: "core" as const,
    run: () => ctx.openApp(id),
  });
  return [
    open("pm", "插件管理器"),
    open("pmarket", "插件市场"),
    open("pdev", "开发者中心"),
    open("appcenter", "应用中心"),
    open("themes", "主题中心"),
    open("widgetstore", "组件中心"),
    open("settings", "系统设置"),
  ];
}

export function listCommands(): PaletteCommand[] {
  const ctx = ctxRef;
  if (!ctx) return [];
  const items = coreCommands(ctx);

  for (const record of listInstalls()) {
    if (!record.enabled) continue;
    if (record.type !== "command" && record.type !== "application") continue;
    if (!record.granted.includes("desktop.register_command")) continue;
    const declared = record.manifest.contributes.command ?? [];
    const runtime = runtimeCommands.get(record.id);
    for (const item of declared) {
      if (record.type === "command" && runtime && !runtime.has(item.command)) continue;
      items.push({
        id: `plugin.${record.id}.${item.command}`,
        title: runtime?.get(item.command) || item.title,
        subtitle: record.name,
        kind: "plugin",
        pluginId: record.id,
        run: async () => {
          const current = getInstall(record.id);
          if (!current || !current.enabled) {
            ctx.toast("插件已禁用");
            return;
          }
          if (current.type === "application" && current.granted.includes("window.open")) {
            // 应用插件的命令直接打开它自己的窗口，避免再起一个隐藏上下文
            ctx.openApp(`plugin:${current.id}`);
            return;
          }
          try {
            await runPluginCommand({ ctx, record: current, command: item.command });
          } catch (error) {
            ctx.toast(error instanceof Error ? error.message : "命令执行失败");
          }
        },
      });
    }
  }
  return items;
}

function paint(query: string) {
  if (!overlay) return;
  const list = overlay.querySelector<HTMLElement>("[data-gp-cmds]");
  if (!list) return;
  const q = query.trim().toLowerCase();
  filtered = listCommands()
    .filter((item) => !q || `${item.title} ${item.subtitle} ${item.id}`.toLowerCase().includes(q))
    .slice(0, 40);
  cursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  list.innerHTML = filtered.length
    ? filtered
        .map(
          (item, index) => `
        <button type="button" class="gp-cmd${index === cursor ? " is-active" : ""}" data-index="${index}">
          <span class="gp-cmd-ico">${item.kind === "plugin" ? "◈" : "⌘"}</span>
          <span class="gp-cmd-text"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.subtitle)}</span></span>
          ${item.kind === "plugin" ? '<span class="gp-cmd-tag">插件</span>' : ""}
        </button>`,
        )
        .join("")
    : `<p class="gp-cmd-empty">没有匹配的命令</p>`;
}

function runCommand(index: number) {
  const item = filtered[index];
  if (!item) return;
  closePalette();
  try {
    void item.run();
  } catch (error) {
    ctxRef?.toast(error instanceof Error ? error.message : "命令执行失败");
  }
}

export function openPalette(initial = "") {
  if (!ctxRef) return;
  if (overlay) {
    closePalette();
    return;
  }
  overlay = document.createElement("div");
  overlay.className = "gp-palette-layer";
  overlay.innerHTML = `
    <div class="gp-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="gp-palette-head">
        <span class="gp-palette-ico">⌘</span>
        <input type="search" data-gp-cmd-input placeholder="搜索命令、插件…" maxlength="60" autocomplete="off" />
        <kbd>Esc</kbd>
      </div>
      <div class="gp-palette-list" data-gp-cmds></div>
      <div class="gp-palette-foot"><span>↑ ↓ 选择</span><span>Enter 执行</span><span>Ctrl / ⌘ + K 打开</span></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>("input");
  paint(initial);
  if (initial) {
    input!.value = initial;
    paint(initial);
  }
  window.setTimeout(() => input?.focus(), 30);

  input?.addEventListener("input", () => {
    cursor = 0;
    paint(input.value);
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closePalette();
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>(".gp-cmd[data-index]");
    if (button) runCommand(Number(button.dataset.index));
  });

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(filtered.length - 1, cursor + 1);
      paint(input?.value ?? "");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
      paint(input?.value ?? "");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runCommand(cursor);
    }
  });
}

export function closePalette() {
  overlay?.remove();
  overlay = null;
  filtered = [];
  cursor = 0;
}

export function initCommandPalette(ctx: Ctx) {
  ctxRef = ctx;
  setCommandSink(registerRuntimeCommands);

  document.addEventListener("keydown", (event) => {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "k") {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        // 输入框里的 Ctrl+K 交给编辑器（比如给链接加标题），不抢
        return;
      }
      event.preventDefault();
      openPalette();
    }
    if (event.key === "Escape" && overlay) closePalette();
  });
}

export function refreshCommands() {
  if (overlay) paint(overlay.querySelector<HTMLInputElement>("input")?.value ?? "");
}
