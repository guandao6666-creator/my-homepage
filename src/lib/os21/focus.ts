/**
 * Guandao OS 2.1 · Focus Studio（番茄专注）
 *
 * 按需懒加载内置应用：
 *   - 深度专注（25 分钟）/ 短休息（5 分钟）/ 长休息（15 分钟）+ 自定义时长
 *   - SVG 环形进度条 + 等宽大号倒计时
 *   - 纯本地 Web Audio 柔和白噪音与结束提示音（零音频文件下载）
 *   - 今日专注次数、累计分钟数与专注记录保存在 localStorage（guandao.os21.focus.v1）
 *   - 关闭窗口时彻底释放计时器与音频上下文
 */
import { escapeHtml, ls, todayKey, type Ctx } from "../os14/core";

const STORAGE_KEY = "guandao.os21.focus.v1";

type FocusLog = { at: number; min: number; label: string; day: string };
type FocusPersist = { v: 1; logs: FocusLog[]; sound: boolean; ambient: boolean };

const readPersist = (): FocusPersist =>
  ls.get<FocusPersist>(STORAGE_KEY, { v: 1, logs: [], sound: true, ambient: false });

const writePersist = (data: FocusPersist) => ls.set(STORAGE_KEY, data);

type Mode = "focus" | "short" | "long";
const MODE_MINUTES: Record<Mode, number> = { focus: 25, short: 5, long: 15 };
const MODE_LABEL: Record<Mode, string> = { focus: "深度专注", short: "短休息", long: "长休息" };

export const renderFocusStudio = () => `
  <div class="os21-focus" style="display:grid;grid-template-rows:auto 1fr auto;gap:14px;height:100%;padding:18px 20px;box-sizing:border-box;color:inherit">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="display:flex;gap:6px" data-fs-modes>
        <button type="button" class="g14-btn is-primary" data-fs-mode="focus">深度专注 25m</button>
        <button type="button" class="g14-btn is-ghost" data-fs-mode="short">短休息 5m</button>
        <button type="button" class="g14-btn is-ghost" data-fs-mode="long">长休息 15m</button>
      </div>
      <div style="display:flex;gap:6px">
        <button type="button" class="g14-btn is-ghost" data-fs-ambient aria-pressed="false">白噪音：关</button>
        <button type="button" class="g14-btn is-ghost" data-fs-sound aria-pressed="true">提示音：开</button>
      </div>
    </div>

    <div style="display:grid;place-items:center;gap:14px;align-content:center">
      <div style="position:relative;width:196px;height:196px;display:grid;place-items:center">
        <svg viewBox="0 0 120 120" width="196" height="196" style="transform:rotate(-90deg)" aria-hidden="true">
          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="6" />
          <circle data-fs-ring cx="60" cy="60" r="52" fill="none" stroke="var(--accent, #6f8cff)" stroke-width="6" stroke-linecap="round" stroke-dasharray="326.73" stroke-dashoffset="0" style="transition:stroke-dashoffset 0.4s ease" />
        </svg>
        <div style="position:absolute;text-align:center">
          <div data-fs-time style="font-family:var(--font-mono,monospace);font-size:38px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:0.03em">25:00</div>
          <div data-fs-phase style="font-size:12px;opacity:0.65;margin-top:2px">深度专注</div>
        </div>
      </div>

      <input
        type="text"
        data-fs-task
        maxlength="40"
        placeholder="此刻想专注做什么？（可选）"
        style="width:min(320px,100%);padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font:inherit;font-size:13px;text-align:center;outline:none"
      />

      <div style="display:flex;gap:10px;align-items:center">
        <button type="button" class="g14-btn is-primary" data-fs-toggle style="min-width:110px;padding:9px 18px;font-size:13.5px">开始专注</button>
        <button type="button" class="g14-btn is-ghost" data-fs-reset>重置</button>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;opacity:0.8">
      <span data-fs-stats>今日已完成 0 次 · 累计 0 分钟</span>
      <span style="opacity:0.65">Guandao OS 2.1 · Focus Studio</span>
    </div>
  </div>`;

export const initFocusStudio = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const timeEl = win.querySelector<HTMLElement>("[data-fs-time]");
  const phaseEl = win.querySelector<HTMLElement>("[data-fs-phase]");
  const ringEl = win.querySelector<SVGCircleElement>("[data-fs-ring]");
  const toggleBtn = win.querySelector<HTMLButtonElement>("[data-fs-toggle]");
  const resetBtn = win.querySelector<HTMLButtonElement>("[data-fs-reset]");
  const taskInput = win.querySelector<HTMLInputElement>("[data-fs-task]");
  const statsEl = win.querySelector<HTMLElement>("[data-fs-stats]");
  const ambientBtn = win.querySelector<HTMLButtonElement>("[data-fs-ambient]");
  const soundBtn = win.querySelector<HTMLButtonElement>("[data-fs-sound]");
  const modeBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-fs-mode]"));

  const CIRC = 2 * Math.PI * 52;
  let persist = readPersist();
  let mode: Mode = "focus";
  let totalSec = MODE_MINUTES.focus * 60;
  let remainSec = totalSec;
  let running = false;
  let timer: number | null = null;
  let audioCtx: AudioContext | null = null;
  let noiseNode: AudioBufferSourceNode | null = null;
  let noiseGain: GainNode | null = null;

  const stopAmbient = () => {
    try {
      noiseNode?.stop();
    } catch {}
    noiseNode = null;
    noiseGain = null;
  };

  const ensureAudio = () => {
    if (!audioCtx && typeof window.AudioContext === "function") {
      audioCtx = new window.AudioContext();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    return audioCtx;
  };

  const startAmbient = () => {
    stopAmbient();
    const ac = ensureAudio();
    if (!ac) return;
    const bufferSize = ac.sampleRate * 2;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 2.2;
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    const gain = ac.createGain();
    gain.gain.value = 0.08;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    source.start();
    noiseNode = source;
    noiseGain = gain;
  };

  const playChime = () => {
    if (!persist.sound) return;
    const ac = ensureAudio();
    if (!ac) return;
    const now = ac.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, now + idx * 0.14 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.55);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.6);
    });
  };

  const paintStats = () => {
    if (!statsEl) return;
    const today = todayKey();
    const todayLogs = persist.logs.filter((l) => l.day === today);
    const mins = todayLogs.reduce((sum, l) => sum + l.min, 0);
    statsEl.textContent = `今日已完成 ${todayLogs.length} 次 · 累计 ${mins} 分钟`;
  };

  const paintAudioBtns = () => {
    if (ambientBtn) {
      ambientBtn.textContent = persist.ambient ? "白噪音：开" : "白噪音：关";
      ambientBtn.setAttribute("aria-pressed", String(persist.ambient));
      ambientBtn.classList.toggle("is-primary", persist.ambient);
      ambientBtn.classList.toggle("is-ghost", !persist.ambient);
    }
    if (soundBtn) {
      soundBtn.textContent = persist.sound ? "提示音：开" : "提示音：关";
      soundBtn.setAttribute("aria-pressed", String(persist.sound));
    }
  };

  const paintClock = () => {
    const m = String(Math.floor(remainSec / 60)).padStart(2, "0");
    const s = String(remainSec % 60).padStart(2, "0");
    if (timeEl) timeEl.textContent = `${m}:${s}`;
    if (phaseEl) phaseEl.textContent = running ? `${MODE_LABEL[mode]}中…` : MODE_LABEL[mode];
    if (ringEl) {
      const ratio = totalSec > 0 ? (totalSec - remainSec) / totalSec : 0;
      ringEl.style.strokeDashoffset = String((CIRC * (1 - ratio)).toFixed(2));
    }
    if (toggleBtn) toggleBtn.textContent = running ? "暂停" : remainSec < totalSec ? "继续专注" : "开始专注";
  };

  const stopTimer = () => {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
    running = false;
    stopAmbient();
    paintClock();
  };

  const switchMode = (next: Mode) => {
    stopTimer();
    mode = next;
    totalSec = MODE_MINUTES[next] * 60;
    remainSec = totalSec;
    modeBtns.forEach((btn) => {
      const on = btn.dataset.fsMode === next;
      btn.classList.toggle("is-primary", on);
      btn.classList.toggle("is-ghost", !on);
    });
    paintClock();
  };

  const complete = () => {
    stopTimer();
    playChime();
    if (mode === "focus") {
      const label = escapeHtml((taskInput?.value || "专注时段").trim().slice(0, 40));
      persist = {
        ...persist,
        logs: [{ at: Date.now(), min: MODE_MINUTES.focus, label, day: todayKey() }, ...persist.logs].slice(0, 120),
      };
      writePersist(persist);
      paintStats();
      ctx.toast("专注完成！休息 5 分钟吧");
      switchMode("short");
    } else {
      ctx.toast("休息结束，准备好进入下一轮专注");
      switchMode("focus");
    }
  };

  toggleBtn?.addEventListener("click", () => {
    if (running) {
      stopTimer();
      return;
    }
    running = true;
    if (persist.ambient) startAmbient();
    paintClock();
    timer = window.setInterval(() => {
      remainSec = Math.max(0, remainSec - 1);
      paintClock();
      if (remainSec <= 0) complete();
    }, 1000);
  });

  resetBtn?.addEventListener("click", () => {
    stopTimer();
    remainSec = totalSec;
    paintClock();
  });

  ambientBtn?.addEventListener("click", () => {
    persist = { ...persist, ambient: !persist.ambient };
    writePersist(persist);
    paintAudioBtns();
    if (persist.ambient && running) startAmbient();
    else stopAmbient();
  });

  soundBtn?.addEventListener("click", () => {
    persist = { ...persist, sound: !persist.sound };
    writePersist(persist);
    paintAudioBtns();
  });

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.fsMode as Mode | undefined;
      if (m && MODE_MINUTES[m]) switchMode(m);
    });
  });

  paintStats();
  paintAudioBtns();
  paintClock();

  return () => {
    stopTimer();
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  };
};
