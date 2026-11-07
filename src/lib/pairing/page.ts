/**
 * /pair · 新设备配对页
 *
 * 这个页面不要求登录：它只持有一个短期配对 token / 6 位配对码。
 * 提交后等待「已在账号里的设备」批准，批准后服务端才签发 Session。
 * 页面不显示账号信息，也不会把 token 写入 localStorage。
 */

import { escapeHtml } from "../html";
import { pairingApi, type ClaimResult } from "../continuity/client";
import { detectMode } from "../shell/adaptive";

const rootEl = document.getElementById("pair-root");
if (!rootEl) throw new Error("pair root missing");
// 保留非空类型：下面多个函数在闭包里引用 root，收窄无法跨闭包传播
const root: HTMLElement = rootEl;

type Status = "idle" | "claiming" | "waiting" | "paired" | "error";

let status: Status = "idle";
let message = "";
let claim: ClaimResult | null = null;
let poll = 0;
let tokenFromUrl = "";

function tokenFromLocation(): string {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const fromHash = params.get("t") || params.get("token");
  if (fromHash) return fromHash;
  return new URLSearchParams(location.search).get("t") || "";
}

function paint() {
  if (!root) return;
  const queued = Boolean(tokenFromUrl);
  root.innerHTML = `
    <div class="pair-card">
      <div class="pair-brand"><span>管</span><div><b>Guandao OS</b><i>Device Pairing</i></div></div>
      ${
        status === "paired"
          ? `<div class="pair-state is-ok"><span>✓</span><h1>配对完成</h1><p>这台设备已经加入你的账号，正在打开…</p></div>`
          : status === "waiting"
            ? `<div class="pair-state"><span class="pair-spin"></span><h1>等待确认</h1>
                <p>请在「${escapeHtml(claim?.source.name || "已登录设备")}」上打开设备中心，批准这台设备。</p>
                <div class="pair-device">
                  <b>${escapeHtml(claim?.device.name || "这台设备")}</b>
                  <span>${escapeHtml(claim?.device.browser || "")} · ${escapeHtml(claim?.device.os || "")}</span>
                </div>
                <p class="pair-note">配对码 10 分钟内有效；旧设备不批准，这台设备不会获得任何登录凭证。</p>
                <button class="pair-btn ghost" type="button" data-pair="reset">取消</button>
              </div>`
            : status === "error"
              ? `<div class="pair-state is-error"><span>!</span><h1>没有完成配对</h1><p>${escapeHtml(message)}</p>
                  <button class="pair-btn" type="button" data-pair="reset">重新输入</button></div>`
              : `<div class="pair-state">
                  <h1>连接这台设备</h1>
                  <p>用另一台已登录的 Guandao OS 设备生成配对码，或直接扫描二维码。</p>
                  ${queued ? `<p class="pair-note">已读取配对链接，确认后开始连接。</p><button class="pair-btn primary" type="button" data-pair="claim-token">开始配对</button>` : ""}
                  <div class="pair-divider"><span>或输入 6 位配对码</span></div>
                  <form data-pair-form>
                    <input class="pair-code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" placeholder="000000" aria-label="6 位配对码" />
                    <button class="pair-btn primary" type="submit" ${status === "claiming" ? "disabled" : ""}>${status === "claiming" ? "正在提交…" : "继续"}</button>
                  </form>
                  <p class="pair-note">配对码只能用一次。配对不会把长期密码或 GitHub Token 放进二维码。</p>
                </div>`
      }
      <footer class="pair-foot">
        <a href="/">返回 Guandao OS</a>
        <span>·</span>
        <a href="/m/">手机版</a>
      </footer>
    </div>`;
}

// 2.3.1：统一使用 src/lib/html.ts 的实现（此处原有一份 4 字符本地副本）

async function submit(codeOrToken: { token?: string; code?: string }) {
  status = "claiming";
  message = "";
  paint();
  try {
    const result = await pairingApi.claim({
      ...codeOrToken,
      device: {
        type: detectMode(),
        name: defaultDeviceName(),
      },
    });
    claim = result;
    status = "waiting";
    paint();
    startPolling(result.pairingId, result.claimSecret);
  } catch (error) {
    status = "error";
    message = (error as Error).message || "配对失败，请重新生成配对码";
    paint();
  }
}

function defaultDeviceName(): string {
  const mode = detectMode();
  if (mode === "mobile") return "My Phone";
  if (mode === "tablet") return "My Tablet";
  return "New Device";
}

function startPolling(id: string, secret: string) {
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    try {
      const result = await pairingApi.claimStatus(id, secret);
      if (result.paired) {
        window.clearInterval(poll);
        status = "paired";
        paint();
        window.setTimeout(() => {
          location.replace(detectMode() === "mobile" ? "/m/" : "/");
        }, 900);
      }
    } catch (error) {
      window.clearInterval(poll);
      status = "error";
      message = (error as Error).message || "配对已失效，请重新生成";
      paint();
    }
  }, 2000);
}

root.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-pair]")?.dataset.pair;
  if (!action) return;
  if (action === "claim-token" && tokenFromUrl) {
    void submit({ token: tokenFromUrl });
    return;
  }
  if (action === "reset") {
    window.clearInterval(poll);
    claim = null;
    status = "idle";
    message = "";
    paint();
  }
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = (root.querySelector<HTMLInputElement>('input[name="code"]')?.value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    status = "error";
    message = "配对码是 6 位数字";
    paint();
    return;
  }
  void submit({ code });
});

async function boot() {
  tokenFromUrl = tokenFromLocation();
  // 已登录设备不需要配对；避免把当前设备误绑成「新设备」。
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin", headers: { accept: "application/json" } });
    const me = (await response.json()) as { authenticated?: boolean; user?: { displayName?: string; githubUsername?: string } };
    if (me.authenticated) {
      root.innerHTML = `<div class="pair-card"><div class="pair-brand"><span>管</span><div><b>Guandao OS</b><i>Device Pairing</i></div></div>
        <div class="pair-state is-ok"><span>✓</span><h1>这台设备已经登录</h1>
        <p>当前账号：${escapeHtml(me.user?.displayName || me.user?.githubUsername || "")}</p>
        <p class="pair-note">已登录设备无需配对。要添加新设备，请在设备中心生成配对码。</p>
        <a class="pair-btn primary" href="/">进入桌面</a>
        <a class="pair-btn ghost" href="/m/">进入手机版</a></div></div>`;
      return;
    }
  } catch {
    /* 网络失败时仍允许输入配对码 */
  }
  paint();
  if (tokenFromUrl) void submit({ token: tokenFromUrl });
}

void boot();
