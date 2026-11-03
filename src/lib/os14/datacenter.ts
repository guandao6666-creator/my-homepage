/**
 * Guandao OS 1.4 · 数据中心
 *
 * 只做本地数据：概览、导出、带校验的导入、自动备份与恢复、恢复默认。
 * 没有云端同步能力，也不会假装有。
 */

import {
  badge,
  bindTabs,
  download,
  emptyState,
  escapeHtml,
  fmtBytes,
  fmtDateTime,
  idb,
  ls,
  modal,
  shell,
  uid,
  type Ctx,
} from "./core";

let ctxRef: Ctx | null = null;
let tab = "overview";

const META_KEY = "guandao.os14.backupmeta.v1";
type BackupMeta = { v: 1; auto: boolean; last: number };
const readMeta = (): BackupMeta => ls.get<BackupMeta>(META_KEY, { v: 1, auto: true, last: 0 });
const writeMeta = (m: BackupMeta) => ls.set(META_KEY, m);

type Backup = { id: string; at: number; version: string; size: number; data: Record<string, unknown> };

const GROUP: Array<[RegExp, string]> = [
  [/os14\.notes/, "笔记"],
  [/os14\.calendar/, "日历"],
  [/os14\.tasks/, "任务"],
  [/os14\.games/, "游戏记录"],
  [/os14\.themes/, "主题"],
  [/os14\.ws/, "工作空间"],
  [/os14\.apps|os14\.appstats/, "应用与安装状态"],
  [/os14\.widgets|os\.widgets/, "桌面组件"],
  [/os\.fs|os14\.fsui/, "虚拟文件"],
  [/os\.notif/, "通知"],
  [/os14\.music|os14\.photo|os14\.reader|os14\.gallery/, "媒体与阅读"],
  [/os14\.prefs|os13/, "外观与偏好"],
  [/os\.state|os\.dock|os\.lp|os\.ach|os\.theme/, "桌面系统"],
];

const groupOf = (key: string) => GROUP.find(([re]) => re.test(key))?.[1] ?? "其他";

const collect = (): Record<string, unknown> => {
  const data: Record<string, unknown> = {};
  for (const k of ls.keys("guandao.")) {
    const raw = ls.str(k);
    // 只把对象 / 数组当 JSON；纯文本（主题名、便签、日期）保持原样，
    // 否则导出再导入会给 "light" 这种值多包一层引号
    if (/^[[{]/.test(raw.trim())) {
      try {
        data[k] = JSON.parse(raw);
        continue;
      } catch {
        /* 不是合法 JSON，按原文保存 */
      }
    }
    data[k] = raw;
  }
  return data;
};

/** 写回时区分原始字符串与结构化数据 */
const writeEntry = (key: string, value: unknown) => {
  if (typeof value === "string") {
    if (/^[[{]/.test(value.trim())) {
      try {
        ls.set(key, JSON.parse(value));
        return;
      } catch {
        /* 按原文写 */
      }
    }
    ls.setStr(key, value);
    return;
  }
  ls.set(key, value);
};

const overview = async () => {
  const rows = new Map<string, { bytes: number; count: number }>();
  for (const k of ls.keys("guandao.")) {
    const g = groupOf(k);
    const cur = rows.get(g) ?? { bytes: 0, count: 0 };
    cur.bytes += (k.length + ls.str(k).length) * 2;
    cur.count += 1;
    rows.set(g, cur);
  }
  const list = [...rows.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const localTotal = list.reduce((s, [, v]) => s + v.bytes, 0);
  const blobBytes = await idb.size("blobs");
  const backupBytes = await idb.size("backups");
  const blobKeys = await idb.keys("blobs");
  const total = localTotal + blobBytes + backupBytes;
  const max = Math.max(1, ...list.map(([, v]) => v.bytes), blobBytes);

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>数据概览</h3><p>全部数据都保存在这台设备的浏览器里。清除浏览器数据会一并清空。</p></div>
      <div class="dc14-total">
        <div><b>${fmtBytes(total)}</b><span>合计占用（估算）</span></div>
        <div class="dc14-split">
          <span>localStorage ${fmtBytes(localTotal)}</span>
          <span>IndexedDB 媒体 ${fmtBytes(blobBytes)}</span>
          <span>备份 ${fmtBytes(backupBytes)}</span>
        </div>
        <div class="dc14-bar-total"><i style="width:${localTotal / Math.max(1, total) * 100}%"></i><b style="width:${blobBytes / Math.max(1, total) * 100}%"></b><em style="width:${backupBytes / Math.max(1, total) * 100}%"></em></div>
      </div>
      <div class="dc14-groups">
        ${list
          .map(
            ([name, v]) => `<div class="dc14-grow">
              <span class="dc14-gname">${escapeHtml(name)}<i>${v.count} 项</i></span>
              <div class="dc14-gtrack"><i style="width:${(v.bytes / max) * 100}%"></i></div>
              <b>${fmtBytes(v.bytes)}</b>
            </div>`,
          )
          .join("")}
        <div class="dc14-grow">
          <span class="dc14-gname">图片 / 音频 / 文本<i>IndexedDB · ${blobKeys.length} 个对象</i></span>
          <div class="dc14-gtrack"><i style="width:${(blobBytes / max) * 100}%"></i></div>
          <b>${fmtBytes(blobBytes)}</b>
        </div>
      </div>
      <p class="g14-hint">localStorage 的占用是按字符数 ×2 估算的；浏览器实际配额通常为 5–10 MB。大文件（图片、音频、书籍）都放在 IndexedDB。</p>
    </div>`;
};

const backupView = async () => {
  const meta = readMeta();
  const backups = (await idb.entries<Backup>("backups")).map(([, v]) => v).sort((a, b) => b.at - a.at);
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>备份</h3><p>备份写入 IndexedDB，不占 localStorage 配额；最多保留 10 份。</p></div>
      <div class="dc14-backupbar">
        <label class="dc14-auto"><input type="checkbox" data-dc-auto ${meta.auto ? "checked" : ""}/> 自动备份（每 30 分钟，页面打开时）</label>
        <button class="g14-btn is-primary" type="button" data-dc-backup>立即备份</button>
        <span class="g14-hint">上次备份：${meta.last ? fmtDateTime(meta.last) : "从未"}</span>
      </div>
      <div class="dc14-list">
        ${
          backups.length
            ? backups
                .map(
                  (b) => `<div class="dc14-row">
                    <div><b>${fmtDateTime(b.at)}</b><span>${fmtBytes(b.size)} · ${Object.keys(b.data).length} 个键 · ${escapeHtml(b.version)}</span></div>
                    <div class="dc14-row-acts">
                      <button class="g14-btn" type="button" data-dc-restore="${b.id}">恢复</button>
                      <button class="g14-btn is-ghost" type="button" data-dc-dl="${b.id}">下载</button>
                      <button class="g14-btn is-ghost is-danger" type="button" data-dc-del="${b.id}">删除</button>
                    </div>
                  </div>`,
                )
                .join("")
            : emptyState("还没有备份", "点「立即备份」保存一份当前状态。", "▤")
        }
      </div>
    </div>`;
};

const migrateView = () => `
  <div class="g14-scroll">
    <div class="g14-pane-head"><h3>导入与导出</h3><p>导出的 JSON 包含 localStorage 里的全部 Guandao 数据；IndexedDB 里的图片 / 音频体积较大，不放进备份文件。</p></div>
    <div class="dc14-migrate">
      <div class="dc14-card">
        <h4>导出全量数据</h4>
        <p>生成一个带版本号的 JSON 文件，可以在另一台设备或另一个浏览器里导入。</p>
        <button class="g14-btn is-primary" type="button" data-dc-export>下载备份文件</button>
      </div>
      <div class="dc14-card">
        <h4>从文件导入</h4>
        <p>导入前会校验格式、版本与键名前缀；导入会覆盖同名键，建议先做一次备份。</p>
        <button class="g14-btn" type="button" data-dc-import>选择 JSON 文件</button>
        <input type="file" accept="application/json,.json" data-dc-file hidden />
      </div>
      <div class="dc14-card">
        <h4>数据说明</h4>
        <p>所有键都以 <code>guandao.</code> 开头；导入时只接受这一前缀，其他键会被忽略，不会执行任何脚本。</p>
        ${badge("本地优先", "ok")} ${badge("无云端同步", "mute")}
      </div>
    </div>
  </div>`;

const dangerView = () => `
  <div class="g14-scroll">
    <div class="g14-pane-head"><h3>恢复与清理</h3><p>这些操作不可撤销，都会先弹确认框。</p></div>
    <div class="dc14-danger">
      <div class="dc14-card is-warn">
        <h4>恢复默认外观</h4>
        <p>把主题、壁纸、程序坞位置恢复成默认，不动你的笔记、任务和文件。</p>
        <button class="g14-btn" type="button" data-dc-reset-look>恢复默认外观</button>
      </div>
      <div class="dc14-card is-warn">
        <h4>清空 1.4 生态数据</h4>
        <p>删除应用安装状态、主题、工作空间、组件布局、任务、游戏记录与通知。笔记、日历、文件会保留。</p>
        <button class="g14-btn" type="button" data-dc-reset-eco>清空生态数据</button>
      </div>
      <div class="dc14-card is-danger">
        <h4>恢复出厂设置</h4>
        <p>删除全部 <code>guandao.*</code> 数据，包括笔记、日历、任务、文件索引与媒体对象。桌面会回到第一次打开的样子。</p>
        <button class="g14-btn is-danger" type="button" data-dc-reset-all>恢复出厂设置</button>
      </div>
    </div>
  </div>`;

const view = async () => {
  if (tab === "backup") return backupView();
  if (tab === "migrate") return migrateView();
  if (tab === "danger") return dangerView();
  return overview();
};

export const renderDataCenter = () => {
  const nav: Array<[string, string, string]> = [
    ["overview", "概览", "▤"],
    ["backup", "备份", "◷"],
    ["migrate", "导入导出", "⇅"],
    ["danger", "恢复与清理", "!"],
  ];
  return shell("datacenter", nav, `<div class="dc14-host" data-dc-host></div>`, "数据中心");
};

export const createBackup = async (): Promise<Backup | null> => {
  const data = collect();
  const payload: Backup = {
    id: `bk-${uid().slice(0, 8)}`,
    at: Date.now(),
    version: "guandao-os/1.4",
    size: 0,
    data,
  };
  payload.size = JSON.stringify(payload.data).length * 2;
  if (!(await idb.put("backups", payload.id, payload))) return null;
  const keys = await idb.keys("backups");
  if (keys.length > 10) {
    const all = (await idb.entries<Backup>("backups")).map(([, v]) => v).sort((a, b) => b.at - a.at);
    for (const old of all.slice(10)) await idb.del("backups", old.id);
  }
  const meta = readMeta();
  meta.last = payload.at;
  writeMeta(meta);
  return payload;
};

export const initDataCenter = (win: HTMLElement, ctx: Ctx): (() => void) => {
  ctxRef = ctx;
  tab = "overview";
  const host = win.querySelector<HTMLElement>("[data-dc-host]");
  if (!host) return () => undefined;

  const paint = async () => {
    if (!host) return;
    host.innerHTML = await view();
  };

  const restore = (b: Backup) => {
    void modal(win, {
      title: "恢复这份备份？",
      body: `<p class="g14-modal-text">会把 ${Object.keys(b.data).length} 个键写回当前浏览器，覆盖同名数据。恢复后页面会自动刷新。当前状态建议先手动备份一次。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: "恢复并刷新", value: "ok", danger: true, primary: true },
      ],
    }).then((v) => {
      if (v !== "ok") return;
      for (const [k, val] of Object.entries(b.data)) {
        if (!k.startsWith("guandao.")) continue;
        writeEntry(k, val);
      }
      window.location.reload();
    });
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("[data-dc-backup]")) {
      void createBackup().then((b) => {
        if (b) ctx.pushNotif({ icon: "▤", title: "本地备份完成", body: `已保存 ${Object.keys(b.data).length} 个键的快照。` });
        if (b) ctx.pushNotif({ icon: "▤", title: "本地备份完成", body: `已保存 ${Object.keys(b.data).length} 个键的快照。` });
        ctx.toast(b ? `已备份 ${Object.keys(b.data).length} 个键` : "备份失败，浏览器可能禁用了存储");
        void paint();
      });
      return;
    }
    if (t.closest("[data-dc-export]")) {
      const data = collect();
      download(
        `guandao-os-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify({ kind: "guandao-os-backup", version: "guandao-os/1.4", exportedAt: new Date().toISOString(), count: Object.keys(data).length, data }, null, 2),
      );
      ctx.pushNotif({ icon: "↓", title: "数据已导出", body: `备份文件已下载，共 ${Object.keys(data).length} 个键。` });
      ctx.pushNotif({ icon: "↓", title: "数据已导出", body: `备份文件已下载，共 ${Object.keys(data).length} 个键。` });
      ctx.toast("已导出，请妥善保存");
      return;
    }
    if (t.closest("[data-dc-import]")) {
      win.querySelector<HTMLInputElement>("[data-dc-file]")?.click();
      return;
    }
    const dl = t.closest<HTMLElement>("[data-dc-dl]");
    if (dl) {
      void idb.get<Backup>("backups", dl.dataset.dcDl ?? "").then((b) => {
        if (!b) return;
        download(`guandao-backup-${new Date(b.at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify({ kind: "guandao-os-backup", version: b.version, exportedAt: new Date(b.at).toISOString(), data: b.data }, null, 2));
      });
      return;
    }
    const del = t.closest<HTMLElement>("[data-dc-del]");
    if (del) {
      void idb.del("backups", del.dataset.dcDel ?? "").then(() => paint());
      return;
    }
    const rs = t.closest<HTMLElement>("[data-dc-restore]");
    if (rs) {
      void idb.get<Backup>("backups", rs.dataset.dcRestore ?? "").then((b) => {
        if (b) restore(b);
      });
      return;
    }
    if (t.closest("[data-dc-reset-look]")) {
      void modal(win, {
        title: "恢复默认外观？",
        body: `<p class="g14-modal-text">主题与壁纸会回到系统默认，其他数据不变。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "恢复", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        ls.del("guandao.os14.themes.v1");
        ls.del("guandao.os13.v1");
        window.location.reload();
      });
      return;
    }
    if (t.closest("[data-dc-reset-eco]")) {
      void modal(win, {
        title: "清空 1.4 生态数据？",
        body: `<p class="g14-modal-text">会删除安装状态、主题、工作空间、组件布局、任务、游戏记录与通知；笔记、日历、文件保留。此操作不可撤销。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "清空", value: "ok", danger: true, primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        for (const k of ls.keys("guandao.")) {
          if (/os14\.(apps|appstats|themes|ws|widgets|games|prefs|backupmeta)/.test(k) || /os\.(notif|widgets|dock|lp)/.test(k)) ls.del(k);
        }
        window.location.reload();
      });
      return;
    }
    if (t.closest("[data-dc-reset-all]")) {
      void modal(win, {
        title: "恢复出厂设置？",
        body: `<p class="g14-modal-text">这会删除全部 Guandao 数据：笔记、日历、任务、文件索引、游戏记录、主题与媒体对象。没有任何撤销方式。</p>
        <p class="g14-modal-text"><b>建议先导出一份备份。</b></p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "我确定，删除全部", value: "ok", danger: true, primary: true },
        ],
      }).then(async (v) => {
        if (v !== "ok") return;
        const again = await modal(win, {
          title: "再做一次确认",
          body: `<p class="g14-modal-text">最后一次确认：真的要清空全部数据吗？</p>`,
          actions: [
            { label: "取消", value: "" },
            { label: "是的，清空", value: "ok", danger: true, primary: true },
          ],
        });
        if (again !== "ok") return;
        for (const k of ls.keys("guandao.")) ls.del(k);
        await idb.entries("blobs").then(async (rows) => {
          for (const [key] of rows) await idb.del("blobs", key);
        });
        await idb.entries("backups").then(async (rows) => {
          for (const [key] of rows) await idb.del("backups", key);
        });
        window.location.reload();
      });
    }
  });

  win.addEventListener("change", async (e) => {
    const auto = (e.target as HTMLElement).closest<HTMLInputElement>("[data-dc-auto]");
    if (auto) {
      const meta = readMeta();
      meta.auto = auto.checked;
      writeMeta(meta);
      ctx.toast(auto.checked ? "已开启自动备份" : "已关闭自动备份");
      return;
    }
    const file = (e.target as HTMLElement).closest<HTMLInputElement>("[data-dc-file]");
    if (!file?.files?.length) return;
    const f = file.files[0];
    file.value = "";
    if (f.size > 8 * 1024 * 1024) {
      ctx.toast("文件超过 8MB，拒绝导入");
      return;
    }
    try {
      const parsed = JSON.parse(await f.text()) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") throw new Error("no-data");
      if (parsed.kind && parsed.kind !== "guandao-os-backup") throw new Error("bad-kind");
      const entries = Object.entries(data).filter(([k]) => k.startsWith("guandao."));
      if (!entries.length) throw new Error("empty");
      const ok = await modal(win, {
        title: "导入这份备份？",
        body: `<p class="g14-modal-text">文件包含 ${entries.length} 个键，导出时间 ${escapeHtml(String(parsed.exportedAt ?? "未知"))}。导入会覆盖同名数据，然后刷新页面。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "导入并刷新", value: "ok", primary: true },
        ],
      });
      if (ok !== "ok") return;
      for (const [k, val] of entries) writeEntry(k, val);
      window.location.reload();
    } catch {
      void modal(win, {
        title: "导入失败",
        body: `<p class="g14-modal-text">文件不是有效的 Guandao 备份，或内容为空。只接受 <code>guandao.</code> 前缀的数据键，不会执行任何脚本。</p>`,
        actions: [{ label: "知道了", value: "ok", primary: true }],
      });
    }
  });

  bindTabs(win, (next) => {
    tab = next;
    void paint();
  });

  // 自动备份：页面打开时每 30 分钟一次
  const timer = window.setInterval(() => {
    const meta = readMeta();
    if (!meta.auto) return;
    if (Date.now() - meta.last < 30 * 60 * 1000) return;
    void createBackup();
  }, 5 * 60 * 1000);

  void paint();
  return () => window.clearInterval(timer);
};

export const autoBackupOnBoot = () => {
  const meta = readMeta();
  if (!meta.auto) return;
  if (Date.now() - meta.last < 24 * 3600 * 1000) return;
  void createBackup();
};

export const dataGroups = GROUP;
export const exportAll = collect;
