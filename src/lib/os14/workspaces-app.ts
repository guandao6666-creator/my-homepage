/**
 * Guandao OS 1.4 · 工作空间窗口 UI（按需懒加载）
 *
 * 从 workspaces.ts 拆分出来，只在用户打开「工作空间」窗口时下载。
 */
import { safeUrl } from "../html";
import { escapeHtml, modal, shell, uid, type Ctx } from "./core";
import { findTheme } from "./themes";
import { sendToDevice } from "../continuity/ui";
import {
  WORKSPACE_PRESETS,
  applyWorkspace,
  captureCurrentWorkspace,
  cloneWorkspace,
  currentWorkspace,
  readWorkspaceState,
  saveWorkspace,
  writeWorkspaceState,
  type Workspace,
} from "./workspaces";

const previewOf = (ws: Workspace) => {
  const t = findTheme(ws.theme);
  const wall = t?.wall ?? "aurora";
  return `<div class="ws14-prev" style="--wsa:${t?.accent ?? "#6f8cff"};--wsb:${t?.accent2 ?? "#b06eff"}">
    <img src="${safeUrl(`/wallpapers/thumbs/${wall}.webp`)}" alt=""/>
    <span class="ws14-prev-veil"></span>
    <span class="ws14-prev-bar"></span>
    <span class="ws14-prev-win"><i></i><b></b><b></b></span>
    <span class="ws14-prev-widget"></span>
    <span class="ws14-prev-dock"><i></i><i></i><i></i><i></i></span>
  </div>`;
};

const view = () => {
  const st = readWorkspaceState();
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>工作空间</h3><p>每套场景独立保存主题、组件、程序坞、快捷方式与窗口布局。虚拟桌面只管理窗口，两者互不冲突。</p></div>
      <div class="ws14-grid">
        ${st.list
          .map(
            (ws) => `<article class="ws14-card ${ws.id === st.current ? "is-current" : ""}" data-ws="${escapeHtml(ws.id)}">
              ${previewOf(ws)}
              <div class="ws14-body">
                <div class="ws14-head"><h4>${escapeHtml(ws.name)}</h4>${ws.id === st.current ? `<span class="g14-badge is-ok">当前</span>` : ""}</div>
                <p>${escapeHtml(WORKSPACE_PRESETS.find((p) => p.id === ws.id)?.desc ?? `自定义场景 · ${ws.openApps.length} 个应用`)}</p>
                <div class="ws14-meta">
                  <span>${ws.openApps.length} 个应用</span>
                  <span>${Object.values(ws.widgets).filter((w) => w.enabled !== false).length} 个组件</span>
                  <span>${ws.dnd ? "勿扰" : "正常通知"}</span>
                </div>
                <div class="ws14-acts">
                  <button class="g14-btn is-primary" type="button" data-ws-apply="${escapeHtml(ws.id)}">切换</button>
                  <button class="g14-btn" type="button" data-ws-save="${escapeHtml(ws.id)}">保存当前布局</button>
                  <button class="g14-btn is-ghost" type="button" data-ws-menu="${escapeHtml(ws.id)}">⋯</button>
                </div>
              </div>
            </article>`,
          )
          .join("")}
        <button class="ws14-new" type="button" data-ws-new>
          <span>＋</span>
          <b>新建工作空间</b>
          <i>从当前桌面复制一份</i>
        </button>
      </div>
      <p class="g14-hint">快捷键：<kbd>Alt</kbd> + <kbd>1</kbd> ~ <kbd>4</kbd> 依次切换前四套场景（输入框里不会触发）。</p>
    </div>`;
};

export const renderWorkspaces = () => {
  const nav: Array<[string, string, string]> = [["all", "全部场景", "▦"]];
  return shell("workspaces", nav, `<div class="ws14-host" data-ws-host></div>`, "工作空间");
};

export const initWorkspaces = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-ws-host]");
  if (!host) return () => undefined;
  const paint = () => {
    if (host) host.innerHTML = view();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const apply = t.closest<HTMLElement>("[data-ws-apply]");
    if (apply) {
      void applyWorkspace(apply.dataset.wsApply ?? "", ctx).then(paint);
      return;
    }
    const save = t.closest<HTMLElement>("[data-ws-save]");
    if (save) {
      saveWorkspace(save.dataset.wsSave ?? "", ctx);
      paint();
      return;
    }
    const menu = t.closest<HTMLElement>("[data-ws-menu]");
    if (menu) {
      const id = menu.dataset.wsMenu ?? "";
      const ws = readWorkspaceState().list.find((w) => w.id === id);
      if (!ws) return;
      void modal(win, {
        title: ws.name,
        body: `<div class="g14-menu-list">
          <button class="g14-menu-item" data-mm="rename">重命名</button>
          <button class="g14-menu-item" data-mm="copy">复制一份</button>
          <button class="g14-menu-item" data-mm="send">发送到设备</button>
          ${ws.preset ? "" : `<button class="g14-menu-item is-danger" data-mm="del">删除</button>`}
        </div>`,
        actions: [{ label: "关闭", value: "" }],
      }).then((v) => {
        if (v === "rename") {
          void modal(win, {
            title: "重命名工作空间",
            body: `<input class="g14-input" data-modal-input value="${escapeHtml(ws.name)}" maxlength="24"/>`,
            actions: [
              { label: "取消", value: "" },
              { label: "保存", value: "ok", primary: true },
            ],
          }).then((r) => {
            if (r !== "ok") return;
            const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
            if (!name) return;
            const st = readWorkspaceState();
            const target = st.list.find((w) => w.id === id);
            if (target) target.name = name.slice(0, 24);
            writeWorkspaceState(st);
            paint();
          });
        }
        if (v === "send") {
          const base = ws.id === currentWorkspace()?.id ? captureCurrentWorkspace(ctx) : cloneWorkspace(ws);
          const semantic = { ...base, windows: {}, updatedAt: Date.now() };
          void sendToDevice(ctx, {
            itemType: "workspace",
            title: ws.name,
            resourceId: ws.id,
            payload: {
              workspace: semantic,
              note: `${ws.openApps.length} 个应用 · ${Object.keys(ws.widgets).length} 个组件`,
            },
          });
          return;
        }
        if (v === "copy") {
          const st = readWorkspaceState();
          const src = st.list.find((w) => w.id === id);
          if (!src) return;
          const copy: Workspace = {
            ...cloneWorkspace(src),
            id: `ws-${uid().slice(0, 8)}`,
            name: `${src.name} 副本`,
            preset: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          st.list.push(copy);
          writeWorkspaceState(st);
          paint();
          ctx.toast("已复制工作空间");
        }
        if (v === "del") {
          const st = readWorkspaceState();
          st.list = st.list.filter((w) => w.id !== id);
          if (st.current === id) st.current = st.list[0]?.id ?? "daily";
          writeWorkspaceState(st);
          paint();
          ctx.toast("已删除工作空间");
        }
      });
      return;
    }
    if (t.closest("[data-ws-new]")) {
      void modal(win, {
        title: "新建工作空间",
        body: `<input class="g14-input" data-modal-input placeholder="给它起个名字" maxlength="24"/>`,
        actions: [
          { label: "取消", value: "" },
          { label: "创建", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
        if (!name) return;
        const st = readWorkspaceState();
        const base = st.list.find((w) => w.id === st.current) ?? st.list[0];
        const ws: Workspace = {
          ...cloneWorkspace(base),
          id: `ws-${uid().slice(0, 8)}`,
          name: name.slice(0, 24),
          preset: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        st.list.push(ws);
        writeWorkspaceState(st);
        paint();
        ctx.toast("已创建，记得点「保存当前布局」把现在这套存进去");
      });
    }
  });

  paint();
  return () => undefined;
};
