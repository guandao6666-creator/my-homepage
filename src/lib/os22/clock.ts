/**
 * Guandao OS 2.2 · Clock Studio（时光）
 *
 * 按需懒加载内置应用，三个分页：
 *   - 世界时钟：基于 Intl.DateTimeFormat 的多时区时钟，可增删城市，显示与本地时差
 *   - 秒表：performance.now() 精确计时 + 分圈记录（最多 99 圈）
 *   - 倒数日：自定义纪念日 / 目标日，显示「还有 N 天 / 已过 N 天」
 *
 * 数据保存在 localStorage（guandao.os22.clock.v1），纯本地、零网络请求。
 * 所有用户输入在写入 innerHTML 前都经过 escapeHtml；关闭窗口时释放全部定时器。
 */
import { escapeHtml, ls, uid, type Ctx } from "../os14/core";

const STORAGE_KEY = "guandao.os22.clock.v1";

type Countdown = { id: string; title: string; date: string };
type ClockPersist = { v: 1; zones: string[]; countdowns: Countdown[]; tab: Tab };
type Tab = "world" | "stopwatch" | "countdown";

/** 可选城市（时区 ID → 中文名）。只列 IANA 标准时区，避免浏览器不支持。 */
export const ZONES: Array<[string, string]> = [
  ["Asia/Shanghai", "北京"],
  ["Asia/Hong_Kong", "香港"],
  ["Asia/Taipei", "台北"],
  ["Asia/Tokyo", "东京"],
  ["Asia/Seoul", "首尔"],
  ["Asia/Singapore", "新加坡"],
  ["Asia/Bangkok", "曼谷"],
  ["Asia/Kolkata", "新德里"],
  ["Asia/Dubai", "迪拜"],
  ["Europe/Moscow", "莫斯科"],
  ["Europe/Berlin", "柏林"],
  ["Europe/Paris", "巴黎"],
  ["Europe/London", "伦敦"],
  ["America/Sao_Paulo", "圣保罗"],
  ["America/New_York", "纽约"],
  ["America/Chicago", "芝加哥"],
  ["America/Denver", "丹佛"],
  ["America/Los_Angeles", "洛杉矶"],
  ["Pacific/Honolulu", "檀香山"],
  ["Australia/Sydney", "悉尼"],
  ["Pacific/Auckland", "奥克兰"],
];
const ZONE_NAME: Record<string, string> = Object.fromEntries(ZONES);

const DEFAULTS: ClockPersist = {
  v: 1,
  zones: ["Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"],
  countdowns: [
    { id: "cd-newyear-2027", title: "2027 元旦", date: "2027-01-01" },
    { id: "cd-spring-2027", title: "2027 春节", date: "2027-02-06" },
  ],
  tab: "world",
};

const readPersist = (): ClockPersist => {
  const raw = ls.get<Partial<ClockPersist>>(STORAGE_KEY, DEFAULTS);
  const zones = Array.isArray(raw.zones) ? raw.zones.filter((z) => typeof z === "string" && ZONE_NAME[z]) : DEFAULTS.zones;
  const countdowns = Array.isArray(raw.countdowns)
    ? raw.countdowns.filter((c) => c && typeof c.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)))
    : DEFAULTS.countdowns;
  const tab: Tab = raw.tab === "stopwatch" || raw.tab === "countdown" ? raw.tab : "world";
  return { v: 1, zones, countdowns, tab };
};

const writePersist = (data: ClockPersist) => ls.set(STORAGE_KEY, data);

/** 计算某个时区相对 UTC 的分钟偏移（不依赖 timeZoneName 的非标准输出） */
export const zoneOffsetMinutes = (zone: string, at: Date = new Date()): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
};

/** 距离目标日期的整天数（按本地自然日计算，今天为 0） */
export const daysUntil = (date: string, now: Date = new Date()): number => {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(y, (m || 1) - 1, d || 1).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86400000);
};

/** 秒表时间格式：mm:ss.cc，超过一小时显示 h:mm:ss.cc */
export const fmtStopwatch = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000) % 60;
  const h = Math.floor(total / 360000);
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}.${p(cs)}` : `${p(m)}:${p(s)}.${p(cs)}`;
};

const fmtDiff = (mins: number) => {
  if (mins === 0) return "与本地相同";
  const sign = mins > 0 ? "快" : "慢";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `比本地${sign} ${h} 小时${m ? ` ${m} 分` : ""}`;
};

const BOX = "border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);border-radius:12px";
const INPUT =
  "padding:7px 10px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font:inherit;font-size:13px;outline:none";

export const renderClockStudio = () => `
  <div class="os22-clock" style="display:grid;grid-template-rows:auto 1fr auto;gap:12px;height:100%;padding:16px 18px;box-sizing:border-box;color:inherit">
    <div style="display:flex;gap:6px" role="tablist" aria-label="Clock Studio 分页">
      <button type="button" class="g14-btn is-primary" role="tab" data-cs-tab="world">世界时钟</button>
      <button type="button" class="g14-btn is-ghost" role="tab" data-cs-tab="stopwatch">秒表</button>
      <button type="button" class="g14-btn is-ghost" role="tab" data-cs-tab="countdown">倒数日</button>
    </div>

    <div style="min-height:0;overflow:auto">
      <section data-cs-panel="world" style="display:grid;gap:10px">
        <div data-cs-zones style="display:grid;gap:8px"></div>
        <div style="display:flex;gap:8px;align-items:center">
          <select data-cs-zone-pick aria-label="选择要添加的城市" style="${INPUT};flex:1"></select>
          <button type="button" class="g14-btn" data-cs-zone-add>添加城市</button>
        </div>
      </section>

      <section data-cs-panel="stopwatch" hidden style="display:none;gap:14px;justify-items:center;padding-top:8px">
        <div data-cs-sw-time style="font-family:var(--font-mono,monospace);font-size:46px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:0.02em">00:00.00</div>
        <div style="display:flex;gap:10px">
          <button type="button" class="g14-btn is-primary" data-cs-sw-toggle style="min-width:96px">开始</button>
          <button type="button" class="g14-btn is-ghost" data-cs-sw-lap disabled>分圈</button>
          <button type="button" class="g14-btn is-ghost" data-cs-sw-reset disabled>重置</button>
        </div>
        <ol data-cs-sw-laps style="list-style:none;margin:0;padding:0;width:min(360px,100%);display:grid;gap:6px"></ol>
      </section>

      <section data-cs-panel="countdown" hidden style="display:none;gap:10px">
        <div data-cs-cds style="display:grid;gap:8px"></div>
        <form data-cs-cd-form style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" data-cs-cd-title maxlength="24" placeholder="事件名称，如：生日" aria-label="事件名称" required style="${INPUT};flex:1;min-width:140px" />
          <input type="date" data-cs-cd-date aria-label="目标日期" required style="${INPUT}" />
          <button type="submit" class="g14-btn">添加</button>
        </form>
      </section>
    </div>

    <div style="display:flex;justify-content:space-between;gap:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;opacity:0.75">
      <span data-cs-local>本地时间 --:--:--</span>
      <span style="opacity:0.7">Guandao OS 2.2 · Clock Studio</span>
    </div>
  </div>`;

export const initClockStudio = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const q = <T extends Element>(sel: string) => win.querySelector<T>(sel);
  const tabBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-cs-tab]"));
  const panels = Array.from(win.querySelectorAll<HTMLElement>("[data-cs-panel]"));
  const zonesEl = q<HTMLElement>("[data-cs-zones]");
  const zonePick = q<HTMLSelectElement>("[data-cs-zone-pick]");
  const zoneAdd = q<HTMLButtonElement>("[data-cs-zone-add]");
  const localEl = q<HTMLElement>("[data-cs-local]");
  const swTime = q<HTMLElement>("[data-cs-sw-time]");
  const swToggle = q<HTMLButtonElement>("[data-cs-sw-toggle]");
  const swLap = q<HTMLButtonElement>("[data-cs-sw-lap]");
  const swReset = q<HTMLButtonElement>("[data-cs-sw-reset]");
  const swLaps = q<HTMLOListElement>("[data-cs-sw-laps]");
  const cdsEl = q<HTMLElement>("[data-cs-cds]");
  const cdForm = q<HTMLFormElement>("[data-cs-cd-form]");
  const cdTitle = q<HTMLInputElement>("[data-cs-cd-title]");
  const cdDate = q<HTMLInputElement>("[data-cs-cd-date]");

  let persist = readPersist();
  let tick: number | null = null;
  let swTimer: number | null = null;
  let swStart = 0;
  let swElapsed = 0;
  let swRunning = false;
  let laps: number[] = [];
  let lastDay = new Date().getDate();

  /* ---------- 世界时钟 ---------- */
  const timeFmt = new Map<string, Intl.DateTimeFormat>();
  const dateFmt = new Map<string, Intl.DateTimeFormat>();
  const fmtFor = (zone: string) => {
    if (!timeFmt.has(zone)) {
      timeFmt.set(zone, new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
      dateFmt.set(zone, new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "long", day: "numeric", weekday: "short" }));
    }
    return { time: timeFmt.get(zone)!, date: dateFmt.get(zone)! };
  };

  const renderZones = () => {
    if (!zonesEl) return;
    if (!persist.zones.length) {
      zonesEl.innerHTML = `<p style="margin:0;padding:18px;text-align:center;opacity:0.6;font-size:13px">还没有城市，从下方添加一个吧</p>`;
    } else {
      zonesEl.innerHTML = persist.zones
        .map(
          (z) => `
        <div data-cs-zone="${escapeHtml(z)}" style="${BOX};display:flex;align-items:center;gap:12px;padding:10px 14px">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600">${escapeHtml(ZONE_NAME[z] ?? z)}</div>
            <div data-cs-zone-meta style="font-size:11.5px;opacity:0.6;margin-top:2px"></div>
          </div>
          <div data-cs-zone-time style="font-family:var(--font-mono,monospace);font-size:24px;font-weight:650;font-variant-numeric:tabular-nums">--:--:--</div>
          <button type="button" class="g14-btn is-ghost" data-cs-zone-del="${escapeHtml(z)}" aria-label="移除 ${escapeHtml(ZONE_NAME[z] ?? z)}" style="min-height:26px;padding:0 8px">✕</button>
        </div>`,
        )
        .join("");
    }
    if (zonePick) {
      const left = ZONES.filter(([z]) => !persist.zones.includes(z));
      zonePick.innerHTML = left.length
        ? left.map(([z, name]) => `<option value="${escapeHtml(z)}">${escapeHtml(name)}（${escapeHtml(z)}）</option>`).join("")
        : `<option value="">已添加全部城市</option>`;
      zonePick.disabled = !left.length;
      if (zoneAdd) zoneAdd.disabled = !left.length;
    }
    paintZones();
  };

  const paintZones = () => {
    const now = new Date();
    const localOffset = -now.getTimezoneOffset();
    zonesEl?.querySelectorAll<HTMLElement>("[data-cs-zone]").forEach((row) => {
      const zone = row.dataset.csZone || "";
      try {
        const f = fmtFor(zone);
        const t = row.querySelector<HTMLElement>("[data-cs-zone-time]");
        const meta = row.querySelector<HTMLElement>("[data-cs-zone-meta]");
        if (t) t.textContent = f.time.format(now);
        if (meta) meta.textContent = `${f.date.format(now)} · ${fmtDiff(zoneOffsetMinutes(zone, now) - localOffset)}`;
      } catch {
        /* 极旧浏览器不支持该时区：保持占位符 */
      }
    });
    if (localEl) localEl.textContent = `本地时间 ${now.toLocaleTimeString("zh-CN", { hour12: false })}`;
  };

  zonesEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cs-zone-del]");
    if (!btn) return;
    persist = { ...persist, zones: persist.zones.filter((z) => z !== btn.dataset.csZoneDel) };
    writePersist(persist);
    renderZones();
  });

  zoneAdd?.addEventListener("click", () => {
    const zone = zonePick?.value;
    if (!zone || !ZONE_NAME[zone] || persist.zones.includes(zone)) return;
    persist = { ...persist, zones: [...persist.zones, zone].slice(0, 12) };
    writePersist(persist);
    renderZones();
    ctx.toast(`已添加 ${ZONE_NAME[zone]}`);
  });

  /* ---------- 秒表 ---------- */
  const swNow = () => (swRunning ? swElapsed + (performance.now() - swStart) : swElapsed);

  const paintStopwatch = () => {
    if (swTime) swTime.textContent = fmtStopwatch(swNow());
  };

  const paintLaps = () => {
    if (!swLaps) return;
    if (!laps.length) {
      swLaps.innerHTML = "";
      return;
    }
    const splits = laps.map((t, i) => t - (laps[i - 1] ?? 0));
    const best = splits.length > 1 ? Math.min(...splits) : -1;
    const worst = splits.length > 1 ? Math.max(...splits) : -1;
    swLaps.innerHTML = splits
      .map((split, i) => {
        const color = split === best ? "color:#7fe3a0" : split === worst ? "color:#ff9b9b" : "";
        return `<li style="${BOX};display:flex;justify-content:space-between;padding:7px 12px;font-size:13px;font-variant-numeric:tabular-nums;${color}">
          <span>第 ${i + 1} 圈</span><span>${fmtStopwatch(split)}</span><span style="opacity:0.6">${fmtStopwatch(laps[i])}</span>
        </li>`;
      })
      .reverse()
      .join("");
  };

  const paintSwButtons = () => {
    if (swToggle) swToggle.textContent = swRunning ? "暂停" : swElapsed > 0 ? "继续" : "开始";
    if (swLap) swLap.disabled = !swRunning || laps.length >= 99;
    if (swReset) swReset.disabled = swRunning || swElapsed === 0;
  };

  swToggle?.addEventListener("click", () => {
    if (swRunning) {
      swElapsed += performance.now() - swStart;
      swRunning = false;
      if (swTimer != null) window.clearInterval(swTimer);
      swTimer = null;
    } else {
      swStart = performance.now();
      swRunning = true;
      swTimer = window.setInterval(paintStopwatch, 47);
    }
    paintStopwatch();
    paintSwButtons();
  });

  swLap?.addEventListener("click", () => {
    if (!swRunning || laps.length >= 99) return;
    laps = [...laps, swNow()];
    paintLaps();
    paintSwButtons();
  });

  swReset?.addEventListener("click", () => {
    if (swRunning) return;
    swElapsed = 0;
    laps = [];
    paintStopwatch();
    paintLaps();
    paintSwButtons();
  });

  /* ---------- 倒数日 ---------- */
  const renderCountdowns = () => {
    if (!cdsEl) return;
    if (!persist.countdowns.length) {
      cdsEl.innerHTML = `<p style="margin:0;padding:18px;text-align:center;opacity:0.6;font-size:13px">还没有倒数日，添加一个值得期待的日子吧</p>`;
      return;
    }
    const sorted = [...persist.countdowns].sort((a, b) => {
      const da = daysUntil(a.date);
      const db = daysUntil(b.date);
      if ((da >= 0) !== (db >= 0)) return da >= 0 ? -1 : 1;
      return Math.abs(da) - Math.abs(db);
    });
    cdsEl.innerHTML = sorted
      .map((c) => {
        const d = daysUntil(c.date);
        const label = d > 0 ? "还有" : d < 0 ? "已过" : "";
        const num = d === 0 ? "就是今天" : `${Math.abs(d)}`;
        return `
        <div style="${BOX};display:flex;align-items:center;gap:12px;padding:10px 14px">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.title)}</div>
            <div style="font-size:11.5px;opacity:0.6;margin-top:2px">${escapeHtml(c.date)}</div>
          </div>
          <div style="text-align:right;${d < 0 ? "opacity:0.55" : ""}">
            <span style="font-size:11.5px;opacity:0.7">${label}</span>
            <span style="font-family:var(--font-mono,monospace);font-size:${d === 0 ? "16" : "24"}px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent,#6f8cff)">${num}</span>
            ${d !== 0 ? `<span style="font-size:11.5px;opacity:0.7">天</span>` : ""}
          </div>
          <button type="button" class="g14-btn is-ghost" data-cs-cd-del="${escapeHtml(c.id)}" aria-label="删除 ${escapeHtml(c.title)}" style="min-height:26px;padding:0 8px">✕</button>
        </div>`;
      })
      .join("");
  };

  cdsEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cs-cd-del]");
    if (!btn) return;
    persist = { ...persist, countdowns: persist.countdowns.filter((c) => c.id !== btn.dataset.csCdDel) };
    writePersist(persist);
    renderCountdowns();
  });

  cdForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = (cdTitle?.value || "").trim().slice(0, 24);
    const date = cdDate?.value || "";
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ctx.toast("请填写事件名称和日期");
      return;
    }
    persist = { ...persist, countdowns: [...persist.countdowns, { id: uid(), title, date }].slice(-30) };
    writePersist(persist);
    if (cdTitle) cdTitle.value = "";
    if (cdDate) cdDate.value = "";
    renderCountdowns();
    ctx.toast(`已添加倒数日：${title}`);
  });

  /* ---------- 分页 ---------- */
  const showTab = (tab: Tab) => {
    persist = { ...persist, tab };
    writePersist(persist);
    tabBtns.forEach((btn) => {
      const on = btn.dataset.csTab === tab;
      btn.classList.toggle("is-primary", on);
      btn.classList.toggle("is-ghost", !on);
      btn.setAttribute("aria-selected", String(on));
    });
    panels.forEach((p) => {
      // 面板自带内联 display:grid，会压过 [hidden] 的 UA 样式，因此同时切换 display
      const on = p.dataset.csPanel === tab;
      p.hidden = !on;
      p.style.display = on ? "grid" : "none";
    });
  };

  tabBtns.forEach((btn) =>
    btn.addEventListener("click", () => {
      const tab = btn.dataset.csTab as Tab | undefined;
      if (tab) showTab(tab);
    }),
  );

  renderZones();
  renderCountdowns();
  paintStopwatch();
  paintSwButtons();
  showTab(persist.tab);

  tick = window.setInterval(() => {
    if (document.hidden) return;
    paintZones();
    const day = new Date().getDate();
    if (day !== lastDay) {
      lastDay = day;
      renderCountdowns();
    }
  }, 1000);

  return () => {
    if (tick != null) window.clearInterval(tick);
    if (swTimer != null) window.clearInterval(swTimer);
    tick = null;
    swTimer = null;
  };
};
