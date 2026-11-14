/**
 * Guandao Backup Center · 云端备份与恢复
 *
 * 页面只负责展示与编排：备份对象、校验、恢复执行全部在 Worker 完成。
 * 本地 Notes/Tasks/Calendar/桌面配置由本设备采集快照并上传，恢复时写回本地。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/backup.css";
import { escapeHtml, type Ctx } from "./core";
import {
  BackupError,
  ackRestore,
  applyLocalSnapshot,
  collectSnapshot,
  countLocal,
  createBackup,
  deleteBackup,
  downloadUrl,
  executeRestore,
  getBackup,
  listBackups,
  previewRestore,
  renameBackup,
  runBackupUntilDone,
  runRestoreUntilDone,
  saveSettings,
  verifyBackupUntilDone,
  verifyImportPackage,
  type BackupDomain,
  type BackupRecord,
  type BackupSettings,
  type CronInfo,
  type RestoreMode,
  type RestorePreview,
  type StorageStats,
} from "../backups/client";

type ViewId = "overview" | "backups" | "restore" | "settings";

const NAV: Array<{ id: ViewId; label: string; hint: string; glyph: string }> = [
  { id: "overview", label: "Overview", hint: "备份概览与存储", glyph: "◈" },
  { id: "backups", label: "Backups", hint: "历史恢复点", glyph: "▤" },
  { id: "restore", label: "Restore Center", hint: "预览并恢复", glyph: "↺" },
  { id: "settings", label: "Settings", hint: "自动备份与导入", glyph: "⚙" },
];

const DOMAIN_LABEL: Record<BackupDomain, string> = {
  notes: "Notes",
  tasks: "Tasks",
  calendar: "Calendar",
  desktop: "Desktop",
  workspace: "Workspace",
  drive: "Cloud Drive",
};

const DOMAIN_ICON: Record<BackupDomain, string> = {
  notes: "✎",
  tasks: "✓",
  calendar: "▦",
  desktop: "▣",
  workspace: "◫",
  drive: "☁",
};

const LOCAL_DOMAINS: BackupDomain[] = ["notes", "tasks", "calendar", "desktop", "workspace"];
const ALL_DOMAINS: BackupDomain[] = [...LOCAL_DOMAINS, "drive"];

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "mute" },
  collecting: { label: "收集数据", tone: "accent" },
  uploading: { label: "复制文件", tone: "accent" },
  verifying: { label: "校验中", tone: "warn" },
  completed: { label: "已完成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已删除", tone: "mute" },
};

export const renderBackup = (): string => `
  <div class="gbk" data-backup>
    <aside class="gbk-side">
      <div class="gbk-brand">
        <span class="gbk-brand-logo">⛨</span>
        <div><b>Guandao Backup</b><i>Never Lose Your Digital World</i></div>
      </div>
      <nav class="gbk-nav" data-nav>
        ${NAV.map(
          (item) => `<button type="button" class="gbk-nav-item" data-view="${item.id}">
            <span class="gbk-nav-ico">${item.glyph}</span>
            <span class="gbk-nav-text"><b>${item.label}</b><i>${item.hint}</i></span>
          </button>`,
        ).join("")}
      </nav>
      <div class="gbk-side-foot">
        <p class="gbk-side-label">最近一次备份</p>
        <b data-side-last>—</b>
        <span data-side-sub>尚未创建</span>
        <button type="button" class="gbk-side-action" data-act="create">Create Backup</button>
      </div>
    </aside>

    <section class="gbk-main">
      <header class="gbk-top">
        <div>
          <p class="gbk-eyebrow">GUANDAO OS 1.5 · BACKUP</p>
          <h1 data-title>Overview</h1>
          <p class="gbk-sub" data-sub>正在读取备份状态…</p>
        </div>
        <div class="gbk-top-actions">
          <span class="gbk-chip" data-cron>—</span>
          <button type="button" class="gbk-icon-btn" data-act="refresh" title="刷新" aria-label="刷新">↻</button>
        </div>
      </header>
      <div class="gbk-scroll" data-body>
        <div class="gbk-loading"><span></span><p>正在读取备份…</p></div>
      </div>
    </section>

    <div class="gbk-drawer" data-drawer hidden></div>
    <div class="gbk-overlay" data-overlay hidden></div>
  </div>
`;

export const initBackup = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-backup]");
  if (!root) return () => undefined;

  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const title = root.querySelector<HTMLElement>("[data-title]")!;
  const sub = root.querySelector<HTMLElement>("[data-sub]")!;
  const cronChip = root.querySelector<HTMLElement>("[data-cron]")!;
  const drawer = root.querySelector<HTMLElement>("[data-drawer]")!;
  const overlay = root.querySelector<HTMLElement>("[data-overlay]")!;
  const sideLast = root.querySelector<HTMLElement>("[data-side-last]")!;
  const sideSub = root.querySelector<HTMLElement>("[data-side-sub]")!;

  let view: ViewId = "overview";
  let loading = true;
  let error = "";
  let signedOut = false;
  let busy = false;

  let backups: BackupRecord[] = [];
  let total = 0;
  let settings: BackupSettings | null = null;
  let storage: StorageStats | null = null;
  let cron: CronInfo | null = null;

  let filterType = "";
  let filterStatus = "";
  let filterFailed = false;
  let filterFull = false;
  let search = "";
  let sort = "created";

  let restoreTarget: BackupRecord | null = null;
  let restoreDomains: BackupDomain[] = ["notes", "tasks", "calendar", "drive"];
  let restoreMode: RestoreMode = "copy";
  let preview: RestorePreview | null = null;
  let restoreStage = "";
  let restorePercent = 0;

  const localStamp = (): string => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  };

  const toast = (message: string) => {
    if (ctx?.toast) ctx.toast(message);
    else {
      const node = document.createElement("div");
      node.className = "gbk-toast";
      node.textContent = message;
      root.appendChild(node);
      window.setTimeout(() => node.remove(), 2600);
    }
  };

  /* ------------------------------ 格式化 ------------------------------ */

  const fmtAbs = (ms: number | null): string => {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return "—";
    }
  };

  const fmtDay = (ms: number | null): string => {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(ms),
      );
    } catch {
      return "—";
    }
  };

  const fmtRel = (ms: number | null): string => {
    if (!ms) return "—";
    const delta = Date.now() - ms;
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    return fmtDay(ms);
  };

  const fmtBytes = (bytes: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const typeLabel = (type: string) =>
    type === "auto" ? "Automatic" : type === "protective" ? "Protective" : "Manual";

  /* ------------------------------ 状态与操作 ------------------------------ */

  const statusBadge = (status: string) => {
    const meta = STATUS[status] ?? { label: status, tone: "mute" };
    return `<span class="gbk-badge is-${meta.tone}">${meta.label}</span>`;
  };

  const setOverlay = (html: string | null) => {
    if (!html) {
      overlay.hidden = true;
      overlay.innerHTML = "";
      return;
    }
    overlay.hidden = false;
    overlay.innerHTML = html;
  };

  const progressOverlay = (stage: string, percent: number, detail = "") => {
    setOverlay(`<div class="gbk-progress">
      <p class="gbk-progress-eyebrow">BACKUP TASK</p>
      <h2>${escapeHtml(stage)}</h2>
      <div class="gbk-bar"><span style="width:${Math.min(Math.max(percent, 2), 100)}%"></span></div>
      <p class="gbk-progress-sub">${escapeHtml(detail || `${percent}%`)}</p>
    </div>`);
  };

  const guard = async (task: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (err) {
      const message = err instanceof Error ? err.message : "操作失败";
      toast(message);
      if (err instanceof BackupError && err.status === 401) signedOut = true;
    } finally {
      busy = false;
      setOverlay(null);
    }
  };

  /* ------------------------------ 加载 ------------------------------ */

  const load = async (silent = false): Promise<void> => {
    if (!silent) {
      loading = true;
      render();
    }
    try {
      const data = await listBackups({
        limit: 40,
        type: filterType,
        status: filterStatus,
        failed: filterFailed ? "1" : "",
        scope: filterFull ? "full" : "",
        q: search,
        sort,
      });
      backups = data.backups;
      total = data.total;
      settings = data.settings;
      storage = data.storage;
      cron = data.cron;
      error = "";
      signedOut = false;
    } catch (err) {
      if (err instanceof BackupError && err.status === 401) {
        signedOut = true;
        backups = [];
      } else {
        error = err instanceof Error ? err.message : "加载失败";
      }
    } finally {
      loading = false;
      render();
    }
  };

  /* ------------------------------ 视图 ------------------------------ */

  const statTile = (label: string, value: string, hint: string, tone = "") => `
    <div class="gbk-stat${tone ? ` is-${tone}` : ""}">
      <p>${label}</p><b>${value}</b><span>${hint}</span>
    </div>`;

  const storageBar = () => {
    if (!storage) return "";
    const totalBytes = Math.max(storage.liveFiles.bytes + storage.backups.bytes + storage.trashFiles.bytes, 1);
    const seg = (value: number, cls: string) =>
      `<span class="${cls}" style="width:${(value / totalBytes) * 100}%"></span>`;
    return `<div class="gbk-storage">
      <div class="gbk-storage-head">
        <h2>Storage</h2>
        <p>历史备份占用单独统计，不混进实时文件</p>
      </div>
      <div class="gbk-storage-bar">
        ${seg(storage.liveFiles.bytes, "is-live")}
        ${seg(storage.backups.bytes, "is-backup")}
        ${seg(storage.trashFiles.bytes, "is-trash")}
      </div>
      <div class="gbk-storage-legend">
        <span><i class="is-live"></i>实时文件 ${fmtBytes(storage.liveFiles.bytes)}（${storage.liveFiles.count}）</span>
        <span><i class="is-backup"></i>历史备份 ${fmtBytes(storage.backups.bytes)}（${storage.backups.total}）</span>
        <span><i class="is-trash"></i>回收站 ${fmtBytes(storage.trashFiles.bytes)}（${storage.trashFiles.count}）</span>
      </div>
      <p class="gbk-storage-note">备份上限 ${storage.backupLimit} 个 / 单次文件总量 ${fmtBytes(storage.limitBytes)}。R2 按实际存储与请求计费，不是无限容量。</p>
    </div>`;
  };

  const renderOverview = (): string => {
    const last = backups[0];
    const verified = backups.filter((b) => b.status === "completed" && b.verifiedAt).length;
    const recent = backups.slice(0, 5);

    return `
      <section class="gbk-hero">
        <div>
          <p class="gbk-hero-eyebrow">LAST BACKUP</p>
          <h2>${last ? escapeHtml(last.name) : "还没有备份"}</h2>
          <p>${last ? `${fmtAbs(last.createdAt)} · ${fmtBytes(last.sizeBytes)} · ${last.fileCount} 个文件` : "创建第一个完整备份，保护笔记、任务、日历、桌面与云端文件。"}</p>
          <div class="gbk-hero-badges">
            ${last ? statusBadge(last.status) : '<span class="gbk-badge is-mute">EMPTY</span>'}
            ${last?.checksum ? `<span class="gbk-badge is-sem">SHA-256 ${last.checksum.slice(0, 10)}…</span>` : ""}
          </div>
        </div>
        <div class="gbk-hero-actions">
          <button type="button" class="gbk-btn is-primary" data-act="create">Create Backup</button>
          <button type="button" class="gbk-btn" data-act="goto-restore" ${verified ? "" : "disabled"}>Restore</button>
        </div>
      </section>

      <div class="gbk-stats">
        ${statTile("备份总数", String(storage?.backups.total ?? 0), `${storage?.backups.verified ?? 0} 个已校验`)}
        ${statTile("备份占用", fmtBytes(storage?.backups.bytes ?? 0), "与实时文件分开计算", "accent")}
        ${statTile("最近备份", last ? fmtRel(last.createdAt) : "—", last ? typeLabel(last.type) : "尚未创建")}
        ${statTile("自动备份", settings?.autoEnabled ? settings.frequency.toUpperCase() : "OFF", settings?.lastAutoAt ? `上次 ${fmtRel(settings.lastAutoAt)}` : cron?.configured ? "Cron 已部署" : "Cron 未启用", settings?.autoEnabled ? "ok" : "mute")}
      </div>

      <section class="gbk-section">
        <div class="gbk-section-head"><h2>最近恢复点</h2><p>同步删除不会删除历史备份。</p></div>
        ${
          recent.length
            ? `<div class="gbk-timeline">${recent.map(timelineItem).join("")}</div>`
            : '<div class="gbk-empty-line">还没有备份记录。点击 Create Backup 开始。</div>'
        }
      </section>

      ${storageBar()}

      <section class="gbk-section">
        <div class="gbk-note-card">
          <b>备份与同步是两件事</b>
          <p>Cloud Sync 让多台设备保持一致；Cloud Backup 保存历史状态。实时文件被删除，不会影响备份对象。</p>
          <p>浏览器本地数据（Notes / Tasks / Calendar / 桌面）只有在设备上创建备份时才会上传；Cron 自动备份只覆盖服务端 Cloud Drive。</p>
        </div>
      </section>`;
  };

  const timelineItem = (backup: BackupRecord): string => `
    <div class="gbk-tl-item">
      <span class="gbk-tl-dot is-${STATUS[backup.status]?.tone ?? "mute"}"></span>
      <div class="gbk-tl-main">
        <b>${escapeHtml(backup.name)}</b>
        <span>${fmtAbs(backup.createdAt)} · ${backup.domains.map((d) => DOMAIN_LABEL[d]).join(" / ")}</span>
      </div>
      <div class="gbk-tl-meta">
        ${statusBadge(backup.status)}
        <span>${fmtBytes(backup.sizeBytes)}</span>
      </div>
      <button type="button" class="gbk-btn is-sm" data-act="detail" data-id="${escapeHtml(backup.id)}">详情</button>
    </div>`;

  const renderBackups = (): string => {
    const list = filterFull ? backups.filter((backup) => backup.scope === "full") : backups;
    const tabs = [
      { key: "", label: "All Backups" },
      { key: "manual", label: "Manual" },
      { key: "auto", label: "Automatic" },
      { key: "full", label: "Full" },
      { key: "failed", label: "Failed" },
    ];

    return `
      <div class="gbk-toolbar">
        <label class="gbk-search"><span>⌕</span><input type="search" data-search value="${escapeHtml(search)}" placeholder="搜索备份名称…" /></label>
        <select class="gbk-select" data-sort>
          <option value="created" ${sort === "created" ? "selected" : ""}>最新优先</option>
          <option value="oldest" ${sort === "oldest" ? "selected" : ""}>最早优先</option>
          <option value="size" ${sort === "size" ? "selected" : ""}>按大小</option>
          <option value="name" ${sort === "name" ? "selected" : ""}>按名称</option>
        </select>
        <button type="button" class="gbk-btn is-primary" data-act="create">Create Backup</button>
      </div>

      <div class="gbk-tabs">
        ${tabs
          .map((tab) => {
            const active =
              tab.key === ""
                ? !filterType && !filterFailed && !filterFull
                : tab.key === "failed"
                  ? filterFailed
                  : tab.key === "full"
                    ? filterFull
                    : filterType === tab.key;
            return `<button type="button" class="gbk-tab${active ? " is-active" : ""}" data-filter="${tab.key}">${tab.label}</button>`;
          })
          .join("")}
        <span class="gbk-tab is-disabled" title="第一版只实现完整备份">Incremental · 未实现</span>
      </div>

      ${
        list.length
          ? `<div class="gbk-list">${list.map(backupRow).join("")}</div>`
          : `<div class="gbk-empty"><span>◌</span><p>没有符合条件的备份</p><i>${filterFailed ? "失败的备份会保留错误信息，可删除后重试。" : "创建完整备份后会出现在这里。"}</i></div>`
      }
      <p class="gbk-count">共 ${filterFull ? list.length : total} 个恢复点</p>`;
  };

  const backupRow = (backup: BackupRecord): string => `
    <article class="gbk-row">
      <div class="gbk-row-main">
        <div class="gbk-row-title">
          <b>${escapeHtml(backup.name)}</b>
          ${statusBadge(backup.status)}
          <span class="gbk-badge is-type">${typeLabel(backup.type)}</span>
          ${backup.scope === "full" ? '<span class="gbk-badge is-sem">FULL</span>' : ""}
        </div>
        <p class="gbk-row-sub">${escapeHtml(backup.id)} · ${fmtAbs(backup.createdAt)}</p>
        <div class="gbk-row-domains">
          ${backup.domains.map((domain) => `<span>${DOMAIN_ICON[domain]} ${DOMAIN_LABEL[domain]}</span>`).join("")}
        </div>
        ${backup.errorMessage ? `<p class="gbk-row-error">${escapeHtml(backup.errorMessage)}</p>` : ""}
      </div>
      <div class="gbk-row-stats">
        <div><span>大小</span><b>${fmtBytes(backup.sizeBytes)}</b></div>
        <div><span>条目</span><b>${backup.itemCount}</b></div>
        <div><span>文件</span><b>${backup.fileCount}</b></div>
        <div><span>校验</span><b>${backup.verifiedAt ? "通过" : backup.status === "completed" ? "待校验" : "—"}</b></div>
      </div>
      <div class="gbk-row-actions">
        <button type="button" class="gbk-btn is-sm" data-act="detail" data-id="${escapeHtml(backup.id)}">详情</button>
        ${
          backup.status === "completed" && backup.verifiedAt
            ? `<button type="button" class="gbk-btn is-sm is-primary" data-act="restore-this" data-id="${escapeHtml(backup.id)}">恢复</button>`
            : ""
        }
        ${
          backup.status === "failed" || backup.status === "collecting" || backup.status === "uploading" || backup.status === "verifying"
            ? `<button type="button" class="gbk-btn is-sm" data-act="resume" data-id="${escapeHtml(backup.id)}">继续</button>`
            : ""
        }
        <button type="button" class="gbk-btn is-sm" data-act="download-json" data-id="${escapeHtml(backup.id)}">JSON</button>
        <button type="button" class="gbk-btn is-sm" data-act="download-zip" data-id="${escapeHtml(backup.id)}">ZIP</button>
      </div>
    </article>`;

  const renderRestore = (): string => {
    const candidates = backups.filter((b) => b.status === "completed" && b.verifiedAt);

    if (!restoreTarget) {
      return `<section class="gbk-section">
        <div class="gbk-section-head">
          <h2>选择恢复点</h2>
          <p>只有完成完整性校验的备份才允许恢复。</p>
        </div>
        ${
          candidates.length
            ? `<div class="gbk-list">${candidates
                .map(
                  (backup) => `<article class="gbk-row is-compact">
                    <div class="gbk-row-main">
                      <div class="gbk-row-title"><b>${escapeHtml(backup.name)}</b>${statusBadge(backup.status)}<span class="gbk-badge is-sem">${fmtBytes(backup.sizeBytes)}</span></div>
                      <p class="gbk-row-sub">${fmtAbs(backup.createdAt)} · ${backup.domains.map((d) => DOMAIN_LABEL[d]).join(" / ")}</p>
                    </div>
                    <div class="gbk-row-actions">
                      <button type="button" class="gbk-btn is-sm is-primary" data-act="restore-this" data-id="${escapeHtml(backup.id)}">选择</button>
                    </div>
                  </article>`,
                )
                .join("")}</div>`
            : '<div class="gbk-empty"><span>◌</span><p>没有可恢复的备份</p><i>先创建一个完整备份并完成校验。</i></div>'
        }
      </section>`;
    }

    const target = restoreTarget;
    const counts = preview?.domains ?? [];

    return `
      <section class="gbk-restore-head">
        <div>
          <p class="gbk-eyebrow">RESTORE FROM</p>
          <h2>${escapeHtml(target.name)}</h2>
          <p>${fmtAbs(target.createdAt)} · ${fmtBytes(target.sizeBytes)} · ${target.fileCount} 个文件</p>
        </div>
        <button type="button" class="gbk-btn" data-act="change-target">更换备份</button>
      </section>

      <section class="gbk-section">
        <div class="gbk-section-head"><h2>1 · 选择范围</h2><p>未选中的数据类型不会被改动。</p></div>
        <div class="gbk-domain-grid">
          ${target.domains
            .map((domain) => {
              const item = counts.find((entry) => entry.domain === domain);
              const local = countLocal(domain);
              const checked = restoreDomains.includes(domain);
              return `<label class="gbk-domain${checked ? " is-on" : ""}">
                <input type="checkbox" data-domain="${domain}" ${checked ? "checked" : ""} />
                <span class="gbk-domain-ico">${DOMAIN_ICON[domain]}</span>
                <span class="gbk-domain-text"><b>${DOMAIN_LABEL[domain]}</b>
                  <i>备份 ${item?.backupCount ?? "—"} 条${local !== null ? ` · 当前 ${local} 条` : ""}</i>
                </span>
                ${domain === "desktop" || domain === "workspace" ? '<em class="gbk-mini">只能整体替换</em>' : ""}
              </label>`;
            })
            .join("")}
        </div>
      </section>

      <section class="gbk-section">
        <div class="gbk-section-head"><h2>2 · 恢复模式</h2><p>默认不覆盖较新的数据。</p></div>
        <div class="gbk-modes">
          ${(
            [
              ["copy", "Restore as Copy", "生成新记录，不动当前数据，适合找回误删内容。"],
              ["merge", "Merge", "只补缺失内容，不覆盖现有数据；云盘按内容哈希跳过重复文件。"],
              ["replace", "Replace Selected", "只替换选中的类型，执行前自动创建保护性备份。"],
            ] as Array<[RestoreMode, string, string]>
          )
            .map(
              ([mode, name, desc]) => `<label class="gbk-mode${restoreMode === mode ? " is-on" : ""}">
                <input type="radio" name="gbk-mode" value="${mode}" ${restoreMode === mode ? "checked" : ""} />
                <b>${name}</b><span>${desc}</span>
              </label>`,
            )
            .join("")}
        </div>
      </section>

      <section class="gbk-section">
        <div class="gbk-section-head"><h2>3 · 预览影响</h2><p>预览会重新校验 manifest 与 data.json。</p></div>
        <button type="button" class="gbk-btn" data-act="preview">生成恢复预览</button>
        ${preview ? renderPreview(preview) : ""}
      </section>

      <section class="gbk-section">
        <div class="gbk-restore-actions">
          <button type="button" class="gbk-btn is-danger" data-act="start-restore" ${preview ? "" : "disabled"}>开始恢复</button>
          <p>会先创建保护性备份，再执行恢复。恢复文件失败时不会更新元数据。</p>
        </div>
      </section>`;
  };

  const renderPreview = (data: RestorePreview): string => `
    <div class="gbk-preview">
      <div class="gbk-preview-grid">
        ${data.domains
          .map(
            (item) => `<div class="gbk-preview-item${item.available ? "" : " is-off"}">
              <b>${DOMAIN_LABEL[item.domain]}</b>
              <span>备份 ${item.backupCount} 条${item.currentCount !== null ? ` · 当前 ${item.currentCount} 条` : ""}</span>
            </div>`,
          )
          .join("")}
      </div>
      <p class="gbk-preview-total">备份大小 ${fmtBytes(data.totals.backupBytes)} · 文件 ${data.totals.fileCount} 个 · 本地载荷 ${fmtBytes(data.totals.localPayloadBytes)}</p>
      <ul class="gbk-warnings">${data.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    </div>`;

  const renderSettings = (): string => `
    <section class="gbk-section">
      <div class="gbk-section-head"><h2>自动备份</h2><p>由 Cloudflare Cron Trigger 调度，不依赖浏览器定时器。</p></div>
      <div class="gbk-settings-card">
        <label class="gbk-field"><span>频率</span>
          <select data-setting="frequency">
            <option value="off" ${settings?.frequency === "off" ? "selected" : ""}>关闭</option>
            <option value="daily" ${settings?.frequency === "daily" ? "selected" : ""}>每日</option>
            <option value="weekly" ${settings?.frequency === "weekly" ? "selected" : ""}>每周</option>
          </select>
        </label>
        <label class="gbk-field"><span>保留每日备份</span><input type="number" min="1" max="30" data-setting="retentionDaily" value="${settings?.retentionDaily ?? 7}" /></label>
        <label class="gbk-field"><span>保留每周备份</span><input type="number" min="1" max="16" data-setting="retentionWeekly" value="${settings?.retentionWeekly ?? 4}" /></label>
        <button type="button" class="gbk-btn is-primary" data-act="save-settings">保存设置</button>
      </div>
      <div class="gbk-cron ${cron?.configured ? "is-ok" : "is-warn"}">
        <b>${cron?.configured ? "Cron 已部署" : "Cron 未启用"}</b>
        <p>${escapeHtml(cron?.description ?? "")} · ${escapeHtml(cron?.note ?? "")}</p>
        ${settings?.lastAutoAt ? `<p>上次自动执行：${fmtAbs(settings.lastAutoAt)} · ${escapeHtml(settings.lastAutoStatus ?? "")}</p>` : ""}
        <p class="gbk-cron-warn">自动备份只覆盖服务端 Cloud Drive。浏览器本地 Notes / Tasks / Calendar 必须在设备上手动备份。</p>
      </div>
    </section>

    ${storageBar()}

    <section class="gbk-section">
      <div class="gbk-section-head"><h2>导入备份包</h2><p>只接受由 Guandao Backup 导出的 JSON 包，导入前校验 schemaVersion 与 SHA-256。</p></div>
      <div class="gbk-settings-card">
        <input type="file" accept="application/json,.json" data-import />
        <button type="button" class="gbk-btn" data-act="import">校验并导入本地数据</button>
      </div>
      <p class="gbk-import-note">导入只应用 Notes / Tasks / Calendar / 桌面配置；云端文件需通过 Restore Center 恢复。不会执行文件里的任何脚本。</p>
    </section>

    <section class="gbk-section">
      <div class="gbk-section-head"><h2>危险操作边界</h2></div>
      <div class="gbk-note-card">
        <b>不支持数据库级恢复</b>
        <p>D1 Time Travel 属于运维级灾难恢复，可能影响全部用户，普通 Session 无法触发，也不会出现在这里。</p>
        <p>删除备份只会移除历史恢复点与备份对象，不会删除当前笔记、任务、日历或云端文件。</p>
      </div>
    </section>`;

  /* ------------------------------ 渲染入口 ------------------------------ */

  const render = (): void => {
    const item = NAV.find((entry) => entry.id === view) ?? NAV[0];
    title.textContent = item.label;
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.view === view);
    });

    if (loading && !backups.length && !storage) {
      body.innerHTML = '<div class="gbk-loading"><span></span><p>正在读取备份…</p></div>';
      sub.textContent = "正在读取备份…";
      return;
    }

    if (signedOut) {
      body.innerHTML = `<div class="gbk-empty"><span>⚠</span><p>登录已失效，请重新登录后使用备份。</p><i>备份只对所属账号开放。</i><button type="button" class="gbk-btn is-primary" data-act="login">重新登录</button></div>`;
      sub.textContent = "需要重新登录";
      return;
    }

    if (error && !backups.length) {
      body.innerHTML = `<div class="gbk-empty"><span>⚠</span><p>${escapeHtml(error)}</p><button type="button" class="gbk-btn" data-act="refresh">重试</button></div>`;
      sub.textContent = error;
      return;
    }

    const last = backups[0];
    sideLast.textContent = last ? last.name : "—";
    sideSub.textContent = last ? `${fmtRel(last.createdAt)} · ${fmtBytes(last.sizeBytes)}` : "尚未创建";
    cronChip.textContent = cron?.configured ? "CRON · 每日" : "CRON · 未启用";

    sub.textContent = {
      overview: `${storage?.backups.total ?? 0} 个恢复点 · ${fmtBytes(storage?.backups.bytes ?? 0)}`,
      backups: `${total} 个恢复点 · 完整备份 v1`,
      restore: restoreTarget ? "恢复前会创建保护性备份" : "选择已验证的恢复点",
      settings: "自动备份、存储与导入",
    }[view];

    if (view === "overview") body.innerHTML = renderOverview();
    else if (view === "backups") body.innerHTML = renderBackups();
    else if (view === "restore") body.innerHTML = renderRestore();
    else body.innerHTML = renderSettings();
  };

  /* ------------------------------ 弹窗 ------------------------------ */

  const dialog = (options: {
    title: string;
    body: string;
    actions: Array<{ label: string; value: string; tone?: "primary" | "danger" }>;
    requireText?: string;
  }): Promise<{ action: string; values: Record<string, string> } | null> =>
    new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "gbk-modal";
      wrap.innerHTML = `<div class="gbk-modal-card" role="dialog" aria-modal="true">
        <h2>${escapeHtml(options.title)}</h2>
        <div class="gbk-modal-body">${options.body}</div>
        <div class="gbk-modal-actions">
          ${options.actions
            .map(
              (action) =>
                `<button type="button" class="gbk-btn ${action.tone === "primary" ? "is-primary" : ""} ${action.tone === "danger" ? "is-danger" : ""}" data-dv="${action.value}">${escapeHtml(action.label)}</button>`,
            )
            .join("")}
        </div>
      </div>`;
      root.appendChild(wrap);

      const confirm = wrap.querySelector<HTMLButtonElement>('[data-dv="confirm"]');
      const input = wrap.querySelector<HTMLInputElement>("[data-confirm-text]");
      if (options.requireText && confirm) {
        confirm.disabled = true;
        input?.addEventListener("input", () => {
          confirm.disabled = (input.value || "").trim().toUpperCase() !== options.requireText?.toUpperCase();
        });
      }

      const done = (value: string | null) => {
        const values: Record<string, string> = {};
        wrap.querySelectorAll<HTMLInputElement>("[data-field]").forEach((field) => {
          values[field.dataset.field || ""] = field.value;
        });
        resolve(value ? { action: value, values } : null);
        window.setTimeout(() => wrap.remove(), 0);
      };

      wrap.addEventListener("click", (event) => {
        if (event.target === wrap) return done(null);
        const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-dv]");
        if (btn && !btn.hasAttribute("disabled")) done(btn.dataset.dv ?? "");
      });
      window.setTimeout(() => wrap.querySelector<HTMLInputElement>("[data-autofocus]")?.focus(), 40);
    });

  /* ------------------------------ 创建备份 ------------------------------ */

  const openCreate = async (): Promise<void> => {
    const defaults: BackupDomain[] = ["notes", "tasks", "calendar", "desktop", "workspace", "drive"];
    const result = await dialog({
      title: "创建完整备份",
      body: `<p class="gbk-modal-note">服务端会复制 Cloud Drive 的真实文件；本地数据由这台设备上传快照。</p>
        <label class="gbk-field"><span>备份名称</span><input data-field="name" data-autofocus maxlength="60" value="手动备份 · ${localStamp()}" /></label>
        <div class="gbk-check-grid">
          ${ALL_DOMAINS.map(
            (domain) => `<label class="gbk-check"><input type="checkbox" data-scope="${domain}" ${defaults.includes(domain) ? "checked" : ""} />
              <span>${DOMAIN_ICON[domain]} ${DOMAIN_LABEL[domain]}<i>${countLocal(domain) ?? "服务端"} ${countLocal(domain) !== null ? "条" : ""}</i></span></label>`,
          ).join("")}
        </div>
        <p class="gbk-modal-sub">Cloud Drive 会逐个复制文件并计算 SHA-256；大文件采用流式读写。</p>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "开始备份", value: "confirm", tone: "primary" },
      ],
    });
    if (!result || result.action !== "confirm") return;

    const domains = [
      ...root.querySelectorAll<HTMLInputElement>(".gbk-modal [data-scope]:checked"),
    ].map((input) => input.dataset.scope as BackupDomain);

    if (!domains.length) {
      toast("请至少选择一个范围");
      return;
    }

    const name = (result.values.name || "").trim() || "手动备份";
    await guard(async () => {
      progressOverlay("收集数据", 4, "正在生成结构化快照…");
      const snapshot = collectSnapshot(domains);
      const created = await createBackup({ name, domains, snapshot, type: "manual" });

      const finished = await runBackupUntilDone(created.backup.id, (job, backup) => {
        progressOverlay(
          backup.status === "verifying" ? "校验备份" : "复制文件",
          job?.progress ?? 10,
          `${job?.processed ?? 0} / ${job?.total ?? created.totals.files} 个文件`,
        );
      });

      if (finished.backup.status !== "completed") {
        throw new BackupError(finished.backup.errorMessage || "备份未完成", "BACKUP_FAILED");
      }
      toast("备份完成并通过完整性校验");
      await load(true);
    });
  };

  const resumeBackup = async (id: string): Promise<void> => {
    await guard(async () => {
      progressOverlay("继续备份", 5, "正在从断点恢复…");
      const finished = await runBackupUntilDone(id, (job, backup) => {
        progressOverlay(backup.status === "verifying" ? "校验备份" : "复制文件", job?.progress ?? 10);
      });
      toast(finished.backup.status === "completed" ? "备份已完成" : "备份仍未完成");
      await load(true);
    });
  };

  /* ------------------------------ 详情 ------------------------------ */

  const openDetail = async (id: string): Promise<void> => {
    drawer.hidden = false;
    drawer.innerHTML = '<div class="gbk-drawer-loading">正在读取备份详情…</div>';
    try {
      const detail = await getBackup(id);
      const backup = detail.backup;
      drawer.innerHTML = `<div class="gbk-drawer-panel">
        <header class="gbk-drawer-head">
          <div><h2>${escapeHtml(backup.name)}</h2><p>${escapeHtml(backup.id)}</p></div>
          ${statusBadge(backup.status)}
          <button type="button" class="gbk-icon-btn" data-act="close-detail" aria-label="关闭">×</button>
        </header>
        <div class="gbk-drawer-body">
          <section class="gbk-detail-grid">
            <div><h3>基础信息</h3><dl class="gbk-kv">
              <div><dt>类型</dt><dd>${typeLabel(backup.type)}</dd></div>
              <div><dt>范围</dt><dd>${backup.scope}</dd></div>
              <div><dt>创建</dt><dd>${fmtAbs(backup.createdAt)}</dd></div>
              <div><dt>完成</dt><dd>${fmtAbs(backup.completedAt)}</dd></div>
              <div><dt>校验</dt><dd>${backup.verifiedAt ? fmtAbs(backup.verifiedAt) : "未通过"}</dd></div>
            </dl></div>
            <div><h3>内容</h3><dl class="gbk-kv">
              <div><dt>条目</dt><dd>${backup.itemCount}</dd></div>
              <div><dt>文件</dt><dd>${backup.fileCount}</dd></div>
              <div><dt>大小</dt><dd>${fmtBytes(backup.sizeBytes)}</dd></div>
              <div><dt>Schema</dt><dd>v${backup.schemaVersion}</dd></div>
              <div><dt>校验值</dt><dd title="${escapeHtml(backup.checksum ?? "")}">${backup.checksum ? `${backup.checksum.slice(0, 16)}…` : "—"}</dd></div>
            </dl></div>
          </section>

          <section><h3>数据范围</h3><div class="gbk-chips">${backup.domains.map((domain) => `<span>${DOMAIN_ICON[domain]} ${DOMAIN_LABEL[domain]}</span>`).join("")}</div></section>

          <section><h3>文件对象（${detail.files.length}）</h3>
            ${detail.files.length
              ? `<div class="gbk-file-list">${detail.files
                  .slice(0, 30)
                  .map((file) => `<div><span>${file.id.slice(0, 8)}…</span><b>${fmtBytes(file.sizeBytes)}</b><i>${escapeHtml((file.checksum || "").slice(0, 12))}…</i></div>`)
                  .join("")}</div>`
              : '<p class="gbk-empty-line">这个备份不包含云端文件。</p>'}
          </section>

          ${backup.errorMessage ? `<section><h3>错误信息</h3><p class="gbk-row-error">${escapeHtml(backup.errorMessage)}</p></section>` : ""}
        </div>
        <footer class="gbk-drawer-foot">
          <button type="button" class="gbk-btn" data-act="rename" data-id="${escapeHtml(backup.id)}">重命名</button>
          <button type="button" class="gbk-btn" data-act="verify" data-id="${escapeHtml(backup.id)}" ${backup.status === "completed" ? "" : "disabled"}>重新校验</button>
          <button type="button" class="gbk-btn" data-act="download-json" data-id="${escapeHtml(backup.id)}">下载 JSON</button>
          <button type="button" class="gbk-btn" data-act="download-zip" data-id="${escapeHtml(backup.id)}">下载 ZIP</button>
          ${backup.status === "completed" && backup.verifiedAt ? `<button type="button" class="gbk-btn is-primary" data-act="restore-this" data-id="${escapeHtml(backup.id)}">恢复</button>` : ""}
          <button type="button" class="gbk-btn is-danger" data-act="delete" data-id="${escapeHtml(backup.id)}">删除</button>
        </footer>
      </div>`;
    } catch (err) {
      drawer.innerHTML = `<div class="gbk-drawer-loading">${escapeHtml(err instanceof Error ? err.message : "读取失败")}</div>`;
    }
  };

  const closeDrawer = () => {
    drawer.hidden = true;
    drawer.innerHTML = "";
  };

  /* ------------------------------ 恢复流程 ------------------------------ */

  const startRestore = async (): Promise<void> => {
    if (!restoreTarget || !preview) return;

    const domains = restoreDomains.filter((domain) => restoreTarget?.domains.includes(domain));
    if (!domains.length) {
      toast("请至少选择一个恢复范围");
      return;
    }
    const mode = domains.some((d) => d === "desktop" || d === "workspace") ? "replace" : restoreMode;

    const confirm = await dialog({
      title: "确认恢复",
      body: `<p class="gbk-modal-note">即将从「${escapeHtml(restoreTarget.name)}」恢复 ${domains.map((d) => DOMAIN_LABEL[d]).join(" / ")}。</p>
        <ul class="gbk-warnings">
          <li>会先创建保护性备份，包含当前选中的本地数据${domains.includes("drive") ? "与云端文件" : ""}。</li>
          <li>模式：${mode === "copy" ? "Restore as Copy（生成新记录）" : mode === "merge" ? "Merge（只补缺失内容，不覆盖现有数据）" : "Replace Selected（替换选中类型）"}。</li>
          <li>文件恢复会逐个复制并校验 SHA-256，校验失败立即中止。</li>
        </ul>
        <p class="gbk-modal-sub">输入 RESTORE 以确认。</p>
        <label class="gbk-field"><span>确认短语</span><input data-confirm-text placeholder="RESTORE" autocomplete="off" /></label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "开始恢复", value: "confirm", tone: "danger" },
      ],
      requireText: "RESTORE",
    });
    if (!confirm || confirm.action !== "confirm") return;

    await guard(async () => {
      restoreStage = "创建保护性备份";
      restorePercent = 5;
      progressOverlay(restoreStage, restorePercent, "正在备份当前状态…");

      const localDomains = domains.filter((d) => LOCAL_DOMAINS.includes(d));
      const protectiveDomains: BackupDomain[] = [...localDomains, ...(domains.includes("drive") ? (["drive"] as BackupDomain[]) : [])];
      const snapshot = collectSnapshot(protectiveDomains);
      const protective = await createBackup({
        name: `保护性备份 · ${localStamp()}`,
        domains: protectiveDomains,
        snapshot,
        type: "protective",
      });

      await runBackupUntilDone(protective.backup.id, (job, backup) => {
        progressOverlay("保护性备份", 5 + Math.round((job?.progress ?? 0) * 0.35), `${job?.processed ?? 0} / ${job?.total ?? 0} 个文件`);
        restoreStage = backup.status === "verifying" ? "校验保护性备份" : "复制保护性备份";
      });

      restoreStage = "执行恢复";
      restorePercent = 45;
      progressOverlay(restoreStage, restorePercent, "服务端正在复制文件并校验…");

      const executed = await executeRestore({
        backupId: restoreTarget!.id,
        domains,
        mode,
        protectiveBackupId: protective.backup.id,
        idempotencyKey: crypto.randomUUID(),
      });

      let final = executed;
      if (executed.restore.status !== "completed" && executed.restore.status !== "awaiting_client") {
        final = await runRestoreUntilDone(executed.restore.id, (progress) => {
          progressOverlay("恢复文件", Math.max(45, progress), `${progress}%`);
        });
      }

      restoreStage = "应用本地数据";
      restorePercent = 90;
      progressOverlay(restoreStage, restorePercent, "正在写回 Notes / Tasks / Calendar / 桌面配置…");

      let applied: Record<string, number> = {};
      if (final.localSnapshot) {
        const result = applyLocalSnapshot(final.localSnapshot, domains, mode);
        applied = result.applied;
        if (result.conflicts > 0) {
          toast(`${result.conflicts} 条记录存在冲突，已保留当前版本`);
        }
        await ackRestore(final.restore.id, applied);
      }

      progressOverlay("完成", 100, "恢复完成");
      toast("恢复完成，已记录恢复日志");
      restoreTarget = null;
      preview = null;
      restoreDomains = ["notes", "tasks", "calendar", "drive"];
      restoreMode = "copy";
      await load(true);
      view = "backups";
      render();
    });
  };

  /* ------------------------------ 导入 ------------------------------ */

  const importPackage = async (): Promise<void> => {
    const input = root.querySelector<HTMLInputElement>("[data-import]");
    const file = input?.files?.[0];
    if (!file) {
      toast("请选择一个 JSON 备份包");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast("导入文件过大（上限 12 MB）");
      return;
    }

    await guard(async () => {
      const text = await file.text();
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch {
        throw new BackupError("不是有效的 JSON 文件", "INVALID_IMPORT");
      }

      const check = await verifyImportPackage(pkg);
      if (!check.ok) throw new BackupError(check.reason || "校验失败", "INVALID_IMPORT");

      const domains = (pkg.manifest.domains as BackupDomain[]).filter((domain) => LOCAL_DOMAINS.includes(domain));
      if (!domains.length) throw new BackupError("这个备份包不包含本地数据", "INVALID_IMPORT");

      const result = await dialog({
        title: "导入本地数据",
        body: `<p class="gbk-modal-note">校验通过（SHA-256 与 schemaVersion v${pkg.data.schemaVersion}）。</p>
          <ul class="gbk-warnings">
            <li>将替换本地：${domains.map((d) => DOMAIN_LABEL[d]).join(" / ")}。</li>
            <li>不会执行包内任何脚本；云端文件不会被导入。</li>
            <li>建议先创建一次保护性备份。</li>
          </ul>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "确认导入", value: "confirm", tone: "danger" },
        ],
      });
      if (!result || result.action !== "confirm") return;

      const localPayload: Record<string, unknown> = {};
      for (const domain of domains) {
        const value = (pkg.data.domains as Record<string, any>)?.[domain];
        if (!value) continue;
        localPayload[domain] =
          domain === "desktop" || domain === "workspace" ? value.keys : value.data;
      }
      const applied = applyLocalSnapshot(localPayload, domains, "replace");
      toast(`已导入 ${Object.values(applied.applied).reduce((sum, value) => sum + value, 0)} 条本地记录`);
      render();
    });
  };

  /* ------------------------------ 操作分发 ------------------------------ */

  const handleAction = async (action: string, id?: string): Promise<void> => {
    if (action === "refresh") return load();
    if (action === "login") {
      window.dispatchEvent(new Event("guandao:open-login"));
      return;
    }
    if (action === "create") return openCreate();
    if (action === "goto-restore") {
      view = "restore";
      render();
      return;
    }
    if (action === "close-detail") return closeDrawer();

    if (action === "filter") return;

    if (action === "detail" && id) return openDetail(id);
    if (action === "resume" && id) return resumeBackup(id);
    if (action === "restore-this" && id) {
      const target = backups.find((backup) => backup.id === id);
      if (!target) return;
      restoreTarget = target;
      restoreDomains = target.domains.filter((domain) => domain !== "desktop" && domain !== "workspace");
      restoreMode = "copy";
      preview = null;
      view = "restore";
      closeDrawer();
      render();
      return;
    }
    if (action === "change-target") {
      restoreTarget = null;
      preview = null;
      render();
      return;
    }
    if (action === "download-json" && id) {
      window.open(downloadUrl(id, "json"), "_blank");
      return;
    }
    if (action === "download-zip" && id) {
      window.open(downloadUrl(id, "zip"), "_blank");
      return;
    }
    if (action === "preview") {
      if (!restoreTarget) return;
      await guard(async () => {
        preview = await previewRestore(
          restoreTarget!.id,
          restoreDomains.filter((domain) => restoreTarget!.domains.includes(domain)),
          restoreMode,
        );
        render();
      });
      return;
    }
    if (action === "start-restore") return startRestore();

    if (action === "save-settings") {
      const read = (name: string) =>
        root.querySelector<HTMLInputElement>(`[data-setting="${name}"]`)?.value ?? "";
      await guard(async () => {
        await saveSettings({
          frequency: (read("frequency") || "off") as BackupSettings["frequency"],
          autoEnabled: read("frequency") !== "off",
          retentionDaily: Number(read("retentionDaily") || 7),
          retentionWeekly: Number(read("retentionWeekly") || 4),
          scope: ["drive"],
        });
        toast("自动备份设置已保存");
        await load(true);
      });
      return;
    }

    if (action === "import") return importPackage();

    if (action === "rename" && id) {
      const backup = backups.find((item) => item.id === id);
      const result = await dialog({
        title: "重命名备份",
        body: `<label class="gbk-field"><span>备份名称</span><input data-field="name" data-autofocus maxlength="60" value="${escapeHtml(backup?.name || "")}" /></label>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "保存", value: "confirm", tone: "primary" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        await renameBackup(id, (result.values.name || "").trim());
        toast("已重命名");
        await load(true);
        if (!drawer.hidden) await openDetail(id);
      });
      return;
    }

    if (action === "verify" && id) {
      await guard(async () => {
        progressOverlay("重新校验", 10, "读取 manifest 与文件…");
        await verifyBackupUntilDone(id, (progress) => progressOverlay("重新校验", progress));
        toast("校验通过");
        await load(true);
        if (!drawer.hidden) await openDetail(id);
      });
      return;
    }

    if (action === "delete" && id) {
      const backup = backups.find((item) => item.id === id);
      const result = await dialog({
        title: `删除「${backup?.name || "备份"}」`,
        body: `<p class="gbk-modal-note">删除会丢失这个恢复点，但不会删除当前正常使用的数据。</p>
          <ul class="gbk-warnings"><li>历史备份对象会从 R2 删除。</li><li>实时笔记、任务、日历与云端文件不受影响。</li><li>此操作不可撤销。</li></ul>
          <label class="gbk-field"><span>输入 DELETE 确认</span><input data-confirm-text placeholder="DELETE" autocomplete="off" /></label>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "删除", value: "confirm", tone: "danger" },
        ],
        requireText: "DELETE",
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        await deleteBackup(id);
        closeDrawer();
        toast("备份已删除，实时数据未受影响");
        await load(true);
      });
      return;
    }
  };

  /* ------------------------------ 事件 ------------------------------ */

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const nav = target.closest<HTMLElement>("[data-view]");
    if (nav?.dataset.view) {
      view = nav.dataset.view as ViewId;
      render();
      return;
    }

    const tab = target.closest<HTMLElement>("[data-filter]");
    if (tab) {
      const key = tab.dataset.filter || "";
      if (key === "failed") {
        filterFailed = true;
        filterFull = false;
        filterType = "";
        filterStatus = "";
      } else if (key === "full") {
        filterFull = true;
        filterFailed = false;
        filterType = "";
        filterStatus = "";
      } else {
        filterFull = false;
        filterFailed = false;
        filterType = key;
        filterStatus = "";
      }
      void load();
      return;
    }

    const actionNode = target.closest<HTMLElement>("[data-act]");
    if (actionNode?.dataset.act) {
      void handleAction(actionNode.dataset.act, actionNode.dataset.id);
    }
  });

  root.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;

    if (target.matches("[data-domain]")) {
      const input = target as HTMLInputElement;
      const domain = input.dataset.domain as BackupDomain;
      if (input.checked) restoreDomains = [...new Set([...restoreDomains, domain])];
      else restoreDomains = restoreDomains.filter((item) => item !== domain);
      if (domain === "desktop" || domain === "workspace") {
        if (input.checked) restoreMode = "replace";
      }
      preview = null;
      render();
      return;
    }

    if (target.matches('input[name="gbk-mode"]')) {
      restoreMode = (target as HTMLInputElement).value as RestoreMode;
      if (restoreDomains.some((d) => d === "desktop" || d === "workspace")) restoreMode = "replace";
      preview = null;
      render();
      return;
    }

    if (target.matches("[data-sort]")) {
      sort = (target as HTMLSelectElement).value;
      void load();
    }
  });

  let searchTimer = 0;
  root.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-search]")) {
      search = (target as HTMLInputElement).value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void load(true), 320);
    }
  });

  drawer.addEventListener("click", (event) => {
    // 抽屉在 root 内部：不阻止冒泡会让同一个动作触发两次（两个确认框）。
    event.stopPropagation();
    if (event.target === drawer) closeDrawer();
    const actionNode = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (actionNode?.dataset.act) {
      void handleAction(actionNode.dataset.act, actionNode.dataset.id);
    }
  });

  /* ------------------------------ 启动 ------------------------------ */

  void load();

  return () => {
    window.clearTimeout(searchTimer);
  };
};
