/**
 * 系统监视器（monitor）· 对应 index.astro 原 `renderMonitor` / `initMonitor`。
 *
 * 依赖：`desktopFacilities`（窗口数 / 桌面数 / 启动时间 / 应用标题）、
 * `lifecycle`（1.5s 模拟指标、2s 信息刷新）。原实现用 `win.isConnected` 自清。
 */
import type { LegacyAppModule } from "../types";

export const monitorApp: LegacyAppModule = {
  id: "monitor",
  title: "系统监视器",
  width: 420,
  height: 500,
  glyph: "di-mon",
  body: () => `
          <div class="monitor">
            <div class="mon-cards">
              <div class="mon-card"><span class="mon-label">CPU（模拟）</span><b class="mon-val" data-mon-cpu>—</b><div class="mon-bar"><i data-mon-cpu-bar></i></div></div>
              <div class="mon-card"><span class="mon-label">内存（模拟）</span><b class="mon-val" data-mon-mem>—</b><div class="mon-bar"><i data-mon-mem-bar></i></div></div>
            </div>
            <p class="mon-note">CPU/内存为模拟数据，浏览器无法读取真实硬件占用。</p>
            <div class="mon-rows">
              <div class="mon-row"><span>运行窗口</span><b data-mon-win>0</b></div>
              <div class="mon-row"><span>虚拟桌面</span><b data-mon-desks>0</b></div>
              <div class="mon-row"><span>已开启</span><b data-mon-uptime>0 分钟</b></div>
              <div class="mon-row"><span>本地存储（真实）</span><b data-mon-storage>—</b></div>
            </div>
            <p class="mon-label mon-apps-label">运行中的应用</p>
            <div class="mon-apps" data-mon-apps></div>
          </div>`,
  init: (win, { desktopFacilities, lifecycle, escapeHtml }) => {
    const cpuEl = win.querySelector("[data-mon-cpu]");
    const memEl = win.querySelector("[data-mon-mem]");
    const cpuBar = win.querySelector("[data-mon-cpu-bar]") as HTMLElement | null;
    const memBar = win.querySelector("[data-mon-mem-bar]") as HTMLElement | null;
    let cpu = 18;
    let mem = 42;
    const tick = () => {
      cpu = Math.max(4, Math.min(92, cpu + (Math.random() - 0.5) * 16));
      mem = Math.max(28, Math.min(88, mem + (Math.random() - 0.5) * 8));
      if (cpuEl) cpuEl.textContent = `${Math.round(cpu)}%`;
      if (memEl) memEl.textContent = `${Math.round(mem)}%`;
      if (cpuBar) cpuBar.style.width = `${cpu}%`;
      if (memBar) memBar.style.width = `${mem}%`;
    };
    lifecycle.interval(win, tick, 1500);
    tick();

    let bytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || "";
        if (k.startsWith("guandao.")) bytes += (localStorage.getItem(k) || "").length;
      }
    } catch {
      /* 忽略 */
    }
    const storageEl = win.querySelector("[data-mon-storage]");
    if (storageEl) storageEl.textContent = `${(bytes / 1024).toFixed(1)} KB`;

    const update = () => {
      const w = win.querySelector("[data-mon-win]");
      const d = win.querySelector("[data-mon-desks]");
      const u = win.querySelector("[data-mon-uptime]");
      if (w) w.textContent = String(desktopFacilities.openWindowCount());
      if (d) d.textContent = String(desktopFacilities.deskCount());
      if (u) u.textContent = `${Math.max(1, Math.floor((Date.now() - desktopFacilities.bootedAt) / 60000))} 分钟`;
      const appsEl = win.querySelector("[data-mon-apps]");
      if (appsEl) {
        const list = desktopFacilities.openWindowTitles();
        appsEl.innerHTML = list.length
          ? list.map((t) => `<span class="mon-app-chip">${escapeHtml(t)}</span>`).join("")
          : `<span class="mon-note">暂无</span>`;
      }
    };
    lifecycle.interval(win, update, 2000);
    update();
  },
};
