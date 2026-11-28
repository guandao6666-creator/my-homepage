/**
 * Guandao OS 2.3 · Dev Studio（开发者工具箱）
 *
 * 按需懒加载内置应用，四个分页：
 *   - JSON：格式化（2 空格）、压缩、键排序与语法错误定位
 *   - 编解码：UTF-8 安全的 Base64 与 URL 双向编解码
 *   - 时间戳：Unix 秒 / 毫秒与 ISO / 本地时间双向互转 + 实时当前时间戳
 *   - 哈希与 ID：Web Crypto SHA-256 摘要 + UUID v4 批量生成
 *
 * 纯本机计算，不向任何外部服务上传数据。
 */
import type { Ctx } from "../os14/core";

export const formatJson = (raw: string, sortKeys = false): { ok: true; output: string } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw);
    const reviver = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reviver);
      if (v && typeof v === "object") {
        const entries = Object.entries(v as Record<string, unknown>);
        if (sortKeys) entries.sort(([a], [b]) => a.localeCompare(b));
        return Object.fromEntries(entries.map(([k, val]) => [k, reviver(val)]));
      }
      return v;
    };
    return { ok: true, output: JSON.stringify(reviver(parsed), null, 2) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "JSON 语法错误" };
  }
};

export const minifyJson = (raw: string): { ok: true; output: string } | { ok: false; error: string } => {
  try {
    return { ok: true, output: JSON.stringify(JSON.parse(raw)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "JSON 语法错误" };
  }
};

export const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const base64ToUtf8 = (b64: string): { ok: true; output: string } | { ok: false; error: string } => {
  try {
    const clean = b64.trim().replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ok: true, output: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: "不是合法的 UTF-8 Base64 字符串" };
  }
};

export const parseTimestampInput = (raw: string): { ms: number; sec: number; iso: string; local: string } | null => {
  const s = raw.trim();
  if (!s) return null;
  let ms = NaN;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    // 11 位以内按秒处理，否则按毫秒处理
    ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  } else {
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return {
    ms: Math.trunc(ms),
    sec: Math.trunc(ms / 1000),
    iso: d.toISOString(),
    local: d.toLocaleString("zh-CN", { hour12: false }),
  };
};

export const sha256HexText = async (text: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const BOX = "border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);border-radius:11px";
const INPUT =
  "width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font-family:var(--font-mono,monospace);font-size:12.5px;outline:none";

export const renderDevStudio = () => `
  <div class="os23-dev" style="display:grid;grid-template-rows:auto 1fr auto;gap:12px;height:100%;padding:16px 18px;box-sizing:border-box;color:inherit">
    <div style="display:flex;gap:6px;flex-wrap:wrap" role="tablist" aria-label="Dev Studio 分页">
      <button type="button" class="g14-btn is-primary" role="tab" data-dv-tab="json">JSON 工坊</button>
      <button type="button" class="g14-btn is-ghost" role="tab" data-dv-tab="codec">Base64 / URL</button>
      <button type="button" class="g14-btn is-ghost" role="tab" data-dv-tab="time">时间戳</button>
      <button type="button" class="g14-btn is-ghost" role="tab" data-dv-tab="hash">哈希 & UUID</button>
    </div>

    <div style="min-height:0;overflow:auto">
      <section data-dv-panel="json" style="display:grid;gap:10px">
        <textarea data-dv-json-in rows="7" spellcheck="false" placeholder='粘贴 JSON，例如 {"os":"Guandao","version":2.3}' style="${INPUT};resize:vertical"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" class="g14-btn is-primary" data-dv-json-fmt>格式化</button>
          <button type="button" class="g14-btn" data-dv-json-sort>按键名排序</button>
          <button type="button" class="g14-btn is-ghost" data-dv-json-min>压缩一行</button>
          <button type="button" class="g14-btn is-ghost" data-dv-json-copy>复制结果</button>
          <span data-dv-json-msg style="font-size:12px;opacity:0.8"></span>
        </div>
        <textarea data-dv-json-out rows="7" readonly spellcheck="false" placeholder="格式化或压缩结果将显示在这里…" style="${INPUT};resize:vertical"></textarea>
      </section>

      <section data-dv-panel="codec" hidden style="display:none;gap:10px">
        <textarea data-dv-codec-in rows="5" spellcheck="false" placeholder="输入原始文本或编码后的字符串…" style="${INPUT};resize:vertical"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="g14-btn is-primary" data-dv-b64-enc>Base64 编码</button>
          <button type="button" class="g14-btn" data-dv-b64-dec>Base64 解码</button>
          <button type="button" class="g14-btn" data-dv-url-enc>URL 编码</button>
          <button type="button" class="g14-btn" data-dv-url-dec>URL 解码</button>
          <button type="button" class="g14-btn is-ghost" data-dv-codec-copy>复制输出</button>
        </div>
        <textarea data-dv-codec-out rows="5" readonly spellcheck="false" placeholder="转换结果…" style="${INPUT};resize:vertical"></textarea>
      </section>

      <section data-dv-panel="time" hidden style="display:none;gap:10px">
        <div style="${BOX};padding:11px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:11.5px;opacity:0.65">当前 Unix 时间戳（秒 / 毫秒）</div>
            <div data-dv-now style="font-family:var(--font-mono,monospace);font-size:18px;font-weight:650;margin-top:2px">--</div>
          </div>
          <button type="button" class="g14-btn is-ghost" data-dv-now-fill>填入当前时间</button>
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" data-dv-ts-in placeholder="输入秒/毫秒时间戳，或 2026-11-28 12:00:00" style="${INPUT};flex:1" />
          <button type="button" class="g14-btn is-primary" data-dv-ts-run>解析</button>
        </div>
        <div data-dv-ts-out style="display:grid;gap:8px"></div>
      </section>

      <section data-dv-panel="hash" hidden style="display:none;gap:10px">
        <textarea data-dv-hash-in rows="4" spellcheck="false" placeholder="输入需要计算 SHA-256 摘要的文本…" style="${INPUT};resize:vertical"></textarea>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button type="button" class="g14-btn is-primary" data-dv-hash-run>计算 SHA-256</button>
          <button type="button" class="g14-btn is-ghost" data-dv-hash-copy>复制摘要</button>
        </div>
        <input type="text" data-dv-hash-out readonly placeholder="64 位十六进制 SHA-256…" style="${INPUT}" />
        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;display:grid;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12.5px;font-weight:600">UUID v4 批量生成</span>
            <div style="display:flex;gap:6px">
              <button type="button" class="g14-btn" data-dv-uuid-gen>生成 5 个</button>
              <button type="button" class="g14-btn is-ghost" data-dv-uuid-copy>全部复制</button>
            </div>
          </div>
          <textarea data-dv-uuid-out rows="5" readonly spellcheck="false" style="${INPUT}"></textarea>
        </div>
      </section>
    </div>

    <div style="display:flex;justify-content:space-between;gap:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;opacity:0.75">
      <span>纯本地离线计算 · 零数据外发</span>
      <span>Guandao OS 2.3 · Dev Studio</span>
    </div>
  </div>`;

export const initDevStudio = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const q = <T extends Element>(sel: string) => win.querySelector<T>(sel);
  const tabBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-dv-tab]"));
  const panels = Array.from(win.querySelectorAll<HTMLElement>("[data-dv-panel]"));

  const copyText = (text: string, label = "结果") => {
    if (!text) {
      ctx.toast(`没有可复制的${label}`);
      return;
    }
    void navigator.clipboard?.writeText(text).then(
      () => ctx.toast(`已复制${label}`),
      () => ctx.toast("复制失败，请手动选中复制"),
    );
  };

  const showTab = (tab: string) => {
    tabBtns.forEach((b) => {
      const on = b.dataset.dvTab === tab;
      b.classList.toggle("is-primary", on);
      b.classList.toggle("is-ghost", !on);
    });
    panels.forEach((p) => {
      const on = p.dataset.dvPanel === tab;
      p.hidden = !on;
      p.style.display = on ? "grid" : "none";
    });
  };
  tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.dvTab ?? "json")));

  // JSON
  const jsonIn = q<HTMLTextAreaElement>("[data-dv-json-in]");
  const jsonOut = q<HTMLTextAreaElement>("[data-dv-json-out]");
  const jsonMsg = q<HTMLElement>("[data-dv-json-msg]");
  const runJson = (mode: "fmt" | "sort" | "min") => {
    const raw = jsonIn?.value ?? "";
    const res = mode === "min" ? minifyJson(raw) : formatJson(raw, mode === "sort");
    if (res.ok) {
      if (jsonOut) jsonOut.value = res.output;
      if (jsonMsg) {
        jsonMsg.textContent = `✓ 有效 JSON（${res.output.length} 字符）`;
        jsonMsg.style.color = "#7fe3a0";
      }
    } else {
      if (jsonMsg) {
        jsonMsg.textContent = `✕ ${res.error}`;
        jsonMsg.style.color = "#ff9b9b";
      }
    }
  };
  q("[data-dv-json-fmt]")?.addEventListener("click", () => runJson("fmt"));
  q("[data-dv-json-sort]")?.addEventListener("click", () => runJson("sort"));
  q("[data-dv-json-min]")?.addEventListener("click", () => runJson("min"));
  q("[data-dv-json-copy]")?.addEventListener("click", () => copyText(jsonOut?.value ?? "", " JSON"));

  // Codec
  const codecIn = q<HTMLTextAreaElement>("[data-dv-codec-in]");
  const codecOut = q<HTMLTextAreaElement>("[data-dv-codec-out]");
  q("[data-dv-b64-enc]")?.addEventListener("click", () => {
    if (codecOut) codecOut.value = utf8ToBase64(codecIn?.value ?? "");
  });
  q("[data-dv-b64-dec]")?.addEventListener("click", () => {
    const r = base64ToUtf8(codecIn?.value ?? "");
    if (r.ok) {
      if (codecOut) codecOut.value = r.output;
    } else ctx.toast(r.error);
  });
  q("[data-dv-url-enc]")?.addEventListener("click", () => {
    if (codecOut) codecOut.value = encodeURIComponent(codecIn?.value ?? "");
  });
  q("[data-dv-url-dec]")?.addEventListener("click", () => {
    try {
      if (codecOut) codecOut.value = decodeURIComponent(codecIn?.value ?? "");
    } catch {
      ctx.toast("URL 编码格式不合法");
    }
  });
  q("[data-dv-codec-copy]")?.addEventListener("click", () => copyText(codecOut?.value ?? ""));

  // Timestamp
  const nowEl = q<HTMLElement>("[data-dv-now]");
  const tsIn = q<HTMLInputElement>("[data-dv-ts-in]");
  const tsOut = q<HTMLElement>("[data-dv-ts-out]");
  const paintNow = () => {
    const ms = Date.now();
    if (nowEl) nowEl.textContent = `${Math.floor(ms / 1000)}  /  ${ms}`;
  };
  const renderTs = () => {
    if (!tsOut) return;
    const res = parseTimestampInput(tsIn?.value ?? "");
    tsOut.textContent = "";
    if (!res) {
      const p = document.createElement("p");
      p.textContent = "无法解析该时间或时间戳，请检查格式。";
      p.style.cssText = "margin:0;font-size:12.5px;color:#ff9b9b";
      tsOut.appendChild(p);
      return;
    }
    const rows: Array<[string, string]> = [
      ["本地时间", res.local],
      ["ISO 8601 (UTC)", res.iso],
      ["Unix 秒 (s)", String(res.sec)],
      ["Unix 毫秒 (ms)", String(res.ms)],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.style.cssText = `${BOX};padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px`;
      const label = document.createElement("span");
      label.textContent = k;
      label.style.opacity = "0.65";
      const val = document.createElement("code");
      val.textContent = v;
      val.style.cssText = "font-family:var(--font-mono,monospace);cursor:pointer";
      val.title = "点击复制";
      val.addEventListener("click", () => copyText(v, k));
      row.append(label, val);
      tsOut.appendChild(row);
    }
  };
  q("[data-dv-now-fill]")?.addEventListener("click", () => {
    if (tsIn) tsIn.value = String(Math.floor(Date.now() / 1000));
    renderTs();
  });
  q("[data-dv-ts-run]")?.addEventListener("click", renderTs);

  // Hash & UUID
  const hashIn = q<HTMLTextAreaElement>("[data-dv-hash-in]");
  const hashOut = q<HTMLInputElement>("[data-dv-hash-out]");
  const uuidOut = q<HTMLTextAreaElement>("[data-dv-uuid-out]");
  const genUuids = () => {
    const list = Array.from({ length: 5 }, () => crypto.randomUUID());
    if (uuidOut) uuidOut.value = list.join("\n");
  };
  q("[data-dv-hash-run]")?.addEventListener("click", () => {
    void sha256HexText(hashIn?.value ?? "").then((hex) => {
      if (hashOut) hashOut.value = hex;
    });
  });
  q("[data-dv-hash-copy]")?.addEventListener("click", () => copyText(hashOut?.value ?? "", " SHA-256"));
  q("[data-dv-uuid-gen]")?.addEventListener("click", genUuids);
  q("[data-dv-uuid-copy]")?.addEventListener("click", () => copyText(uuidOut?.value ?? "", " UUID"));

  paintNow();
  if (tsIn) tsIn.value = String(Math.floor(Date.now() / 1000));
  renderTs();
  genUuids();
  const timer = window.setInterval(() => {
    if (!document.hidden) paintNow();
  }, 1000);

  return () => window.clearInterval(timer);
};
