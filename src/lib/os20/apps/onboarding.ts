/**
 * Guandao OS 2.0 · 首次启动引导（First Launch）
 *
 * 七步（§14）：欢迎 → 选择模式 → 个性化 → 设备 → 应用 → 工作空间 → 完成。
 *
 * 设计原则：
 *   - 非必要步骤都可以跳过，跳过也要能正常进桌面；
 *   - 每一步的选择都会真的落盘（主题 / 壁纸 / 程序坞 / 设备名 / 应用安装）；
 *   - 完成状态持久化，刷新后不会重复弹出；
 *   - 1.x 升级用户不进入引导（迁移步骤已把 onboarding 标记为完成）。
 */

import type { Kernel } from "../../core/kernel";
import type { Ctx } from "../../os14/core";
import type { Sys } from "../../os14/system";
import { escapeHtml } from "../../os14/core";
import { CATALOG, isInstalled, type AppMeta } from "../../os14/catalog";
import { THEMES, applyTheme, themeById } from "../../os14/themes";
import { WALLPAPERS, wallpaperById } from "../../wallpapers";
import { workspaceList, applyWorkspace } from "../../os14/workspaces";
import { OS_VERSION, RELEASE_NAME_ZH } from "../../version";

type StepId = "welcome" | "mode" | "personalize" | "device" | "apps" | "workspace" | "complete";

const STEPS: Array<{ id: StepId; title: string; hint: string }> = [
  { id: "welcome", title: "欢迎", hint: "认识你的数字世界" },
  { id: "mode", title: "模式", hint: "Local 或 Cloud" },
  { id: "personalize", title: "个性化", hint: "主题、壁纸与程序坞" },
  { id: "device", title: "设备", hint: "给这台设备起个名字" },
  { id: "apps", title: "应用", hint: "挑几个常用的" },
  { id: "workspace", title: "工作空间", hint: "默认从哪套场景开始" },
  { id: "complete", title: "完成", hint: "进入桌面" },
];

const STATE_KEY = "onboarding.v1";

export type OnboardingState = {
  v: 2;
  completed: boolean;
  completedAt: number | null;
  step: StepId;
  migrated?: boolean;
  choices?: Record<string, unknown>;
};

const readState = (kernel: Kernel): OnboardingState =>
  kernel.storage.read<OnboardingState>(STATE_KEY, {
    v: 2,
    completed: false,
    completedAt: null,
    step: "welcome",
  });

const writeState = (kernel: Kernel, patch: Partial<OnboardingState>) => {
  const next: OnboardingState = { ...readState(kernel), ...patch, v: 2 };
  kernel.storage.write(STATE_KEY, next);
  return next;
};

/** 是否需要展示引导：没完成过、且不是从 1.x 迁移上来的用户 */
export const shouldShowOnboarding = (kernel: Kernel): boolean => {
  const state = readState(kernel);
  if (state.migrated) return false;
  return !state.completed;
};

type CtxWithApi = Ctx;

const themeOptions = () =>
  THEMES.filter((theme) => theme.id !== "default")
    .slice(0, 8)
    .map(
      (theme) => `
      <button class="os20-onb-tile" type="button" data-theme="${escapeHtml(theme.id)}" aria-pressed="false">
        <span class="os20-onb-swatch" style="--a:${escapeHtml(theme.accent)};--b:${escapeHtml(
          theme.accent2 || theme.accent,
        )};background-image:url('${escapeHtml(wallpaperById(theme.wall)?.thumb || wallpaperById(theme.wall)?.src || "")}')"></span>
        <b>${escapeHtml(theme.name)}</b>
        <i>${escapeHtml(theme.style || "主题")}</i>
      </button>`,
    )
    .join("");

const wallpaperOptions = () =>
  WALLPAPERS.slice(0, 8)
    .map(
      (wall) => `
      <button class="os20-onb-tile is-wall" type="button" data-wall="${escapeHtml(wall.id)}" aria-pressed="false">
        <span class="os20-onb-swatch" style="background-image:url('${escapeHtml(wall.src)}')"></span>
        <b>${escapeHtml(wall.name)}</b>
      </button>`,
    )
    .join("");

/** 步骤五展示的应用：已安装、且值得放到桌面的常用应用 */
const SHORTCUT_EXCLUDE = new Set([
  "appcenter",
  "systemcenter",
  "updatecenter",
  "market",
  "control",
  "themes",
  "widgetstore",
  "workspaces",
  "datacenter",
  "security",
  "backup",
  "devices",
  "drive",
  "community",
  "pm",
  "pmarket",
  "pdev",
  "continuity",
  "diagnostics",
  "perflab",
  "about",
  "settings",
  "achievements",
]);

const appOptions = (): AppMeta[] =>
  CATALOG.filter((meta) => isInstalled(meta.id) && !SHORTCUT_EXCLUDE.has(meta.id)).slice(0, 12);

const appGrid = (sys: Sys) =>
  appOptions()
    .map((meta) => {
      const onDesktop = sys.hasShortcut(meta.id);
      return `
      <label class="os20-onb-check" data-app="${escapeHtml(meta.id)}">
        <input type="checkbox" ${onDesktop ? "checked" : ""} />
        <span class="di-glyph ${escapeHtml(meta.glyph)}"></span>
        <span><b>${escapeHtml(meta.name)}</b><i>${onDesktop ? "已在桌面" : escapeHtml(meta.tagline)}</i></span>
      </label>`;
    })
    .join("");

const workspaceOptions = () =>
  workspaceList()
    .slice(0, 6)
    .map(
      (workspace) => `
      <button class="os20-onb-tile is-ws" type="button" data-ws="${escapeHtml(workspace.id)}" aria-pressed="false">
        <span class="os20-onb-ws" aria-hidden="true"></span>
        <b>${escapeHtml(workspace.name)}</b>
        <i>${escapeHtml(workspace.theme ?? "场景")}</i>
      </button>`,
    )
    .join("");

const defaultChoices = () => ({
  theme: "default",
  wallpaper: "",
  dock: "bottom",
  iconLabels: true,
  clockSeconds: false,
  mode: "local",
  deviceName: "",
  apps: [] as string[],
  workspace: "",
});

export type OnboardingInput = { kernel: Kernel; ctx: CtxWithApi; sys: Sys };

/**
 * 打开引导。返回 Promise，完成或跳过时 resolve。
 * `ctx` 不需要提前初始化，所有效果都通过 1.x 已验证的 API 落地。
 */
export function openOnboarding(input: OnboardingInput): Promise<{ completed: boolean }> {
  const { kernel, ctx, sys } = input;
  const previous = readState(kernel);
  const choices = { ...defaultChoices(), ...(previous.choices ?? {}) };
  // 2.0 修复：引导的默认值不能覆盖用户已有的选择。
  // 之前无论当前设置是什么，choices.mode 都是 "local"，跳过引导会把
  // 已登录的 Cloud Mode 静默切回 Local Mode（E2E 在生产上复现到）。
  if (!previous.choices?.mode) {
    choices.mode = kernel.settings.get("system.mode") === "cloud" ? "cloud" : "local";
  }
  if (!previous.choices?.dock) choices.dock = kernel.settings.get("desktop.dock.position");
  if (previous.choices?.iconLabels === undefined) choices.iconLabels = kernel.settings.get("desktop.iconLabels");
  if (previous.choices?.clockSeconds === undefined) {
    choices.clockSeconds = kernel.settings.get("desktop.clockSeconds");
  }
  // 用户是否在本轮真正点过「运行模式」。跳过引导时如果没点过，就不写 system.mode。
  let modeTouched = false;
  // 「桌面应用」步骤的初始勾选 = 当前桌面已有的快捷方式，避免一进一出一键清空桌面
  if (!Array.isArray(choices.apps) || choices.apps.length === 0) {
    choices.apps = appOptions()
      .filter((meta) => sys.hasShortcut(meta.id))
      .map((meta) => meta.id);
  }
  let stepIndex = Math.max(0, STEPS.findIndex((step) => step.id === previous.step));
  if (stepIndex < 0) stepIndex = 0;

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "os20-onb";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "Guandao OS 首次启动引导");
    host.dataset.step = STEPS[stepIndex].id;

    const rail = STEPS.map(
      (step, index) => `
      <li class="os20-onb-step ${index === stepIndex ? "is-current" : ""} ${index < stepIndex ? "is-done" : ""}" data-step-index="${index}">
        <span>${index + 1}</span>
        <b>${escapeHtml(step.title)}</b>
        <i>${escapeHtml(step.hint)}</i>
      </li>`,
    ).join("");

    host.innerHTML = `
      <div class="os20-onb-card">
        <aside class="os20-onb-rail">
          <div class="os20-onb-brand"><span>管</span><div><b>Guandao OS ${OS_VERSION}</b><i>${escapeHtml(RELEASE_NAME_ZH)}</i></div></div>
          <ol class="os20-onb-steps">${rail}</ol>
          <p class="os20-onb-note">所有设置随时可以在「系统设置」里修改。</p>
        </aside>
        <section class="os20-onb-main">
          <div class="os20-onb-body" data-onb-body></div>
          <footer class="os20-onb-foot">
            <button class="g14-btn is-ghost" type="button" data-onb-skip>跳过引导</button>
            <div class="os20-onb-nav">
              <button class="g14-btn" type="button" data-onb-back>上一步</button>
              <button class="g14-btn is-primary" type="button" data-onb-next>下一步</button>
            </div>
          </footer>
        </section>
      </div>`;

    document.body.appendChild(host);

    const body = host.querySelector<HTMLElement>("[data-onb-body]");
    const nextButton = host.querySelector<HTMLButtonElement>("[data-onb-next]");
    const backButton = host.querySelector<HTMLButtonElement>("[data-onb-back]");
    const skipButton = host.querySelector<HTMLButtonElement>("[data-onb-skip]");

    const deviceNameInput = () => host.querySelector<HTMLInputElement>("[data-onb-device]");

    const paint = () => {
      const step = STEPS[stepIndex];
      host.dataset.step = step.id;
      host.querySelectorAll<HTMLElement>(".os20-onb-step").forEach((node, index) => {
        node.classList.toggle("is-current", index === stepIndex);
        node.classList.toggle("is-done", index < stepIndex);
      });
      if (backButton) backButton.disabled = stepIndex === 0;
      if (nextButton) nextButton.textContent = step.id === "complete" ? "进入桌面" : stepIndex === STEPS.length - 2 ? "完成设置" : "下一步";
      if (skipButton) skipButton.hidden = step.id === "complete";

      if (!body) return;
      if (step.id === "welcome") {
        body.innerHTML = `
          <div class="os20-onb-hero">
            <span class="os20-onb-logo" aria-hidden="true">管</span>
            <p class="os20-onb-kicker">The Platform Era</p>
            <h1>你的数字世界，<br/>现在是一整套平台。</h1>
            <p class="os20-onb-lead">统一的桌面、应用、插件、云端与社区。先花一分钟把它调成你的样子，这些选择之后都能改。</p>
            <ul class="os20-onb-points">
              <li><b>本地优先</b><span>不登录也能完整使用；数据默认只存在这台设备。</span></li>
              <li><b>默认拒绝</b><span>应用与插件要用的权限，必须你逐项同意。</span></li>
              <li><b>不丢数据</b><span>升级到 2.0 会先备份旧数据，迁移失败也不会删除。</span></li>
            </ul>
          </div>`;
        return;
      }

      if (step.id === "mode") {
        body.innerHTML = `
          <p class="os20-onb-kicker">Step 2 · 运行模式</p>
          <h2>先决定这台设备怎么用</h2>
          <p class="os20-onb-lead">两种模式都能使用完整的本地桌面。Cloud Mode 只是额外启用账号、同步与云端文件。</p>
          <div class="os20-onb-cards">
            <button class="os20-onb-card-btn ${choices.mode === "local" ? "is-active" : ""}" type="button" data-mode="local">
              <b>Local Mode</b>
              <span>不需要账号。笔记、任务、日历、文件、主题全部保存在这台设备上，不会自动上传。</span>
              <i>推荐给只想要一个属于自己桌面的人</i>
            </button>
            <button class="os20-onb-card-btn ${choices.mode === "cloud" ? "is-active" : ""}" type="button" data-mode="cloud">
              <b>Cloud Mode</b>
              <span>用 GitHub 登录 Guandao Account，启用云盘、备份、设备管理与社区。本地数据不会被覆盖。</span>
              <i>推荐给有多台设备的人</i>
            </button>
          </div>
          <p class="os20-onb-hint">可以随时切换；切换模式不会清空或覆盖本地内容。</p>`;
        return;
      }

      if (step.id === "personalize") {
        body.innerHTML = `
          <p class="os20-onb-kicker">Step 3 · 个性化</p>
          <h2>先挑一个顺眼的样子</h2>
          <div class="os20-onb-field">
            <span class="os20-onb-label">主题</span>
            <div class="os20-onb-grid">${themeOptions()}</div>
          </div>
          <div class="os20-onb-field">
            <span class="os20-onb-label">壁纸</span>
            <div class="os20-onb-grid is-wall">${wallpaperOptions()}</div>
          </div>
          <div class="os20-onb-row">
            <div class="os20-onb-field">
              <span class="os20-onb-label">程序坞位置</span>
              <div class="g14-seg" data-onb-seg="dock">
                <button type="button" data-dock="bottom" class="${choices.dock === "bottom" ? "is-active" : ""}">底部</button>
                <button type="button" data-dock="left" class="${choices.dock === "left" ? "is-active" : ""}">左侧</button>
                <button type="button" data-dock="right" class="${choices.dock === "right" ? "is-active" : ""}">右侧</button>
              </div>
            </div>
            <div class="os20-onb-field">
              <span class="os20-onb-label">时间显示</span>
              <div class="g14-seg" data-onb-seg="clock">
                <button type="button" data-clock="0" class="${!choices.clockSeconds ? "is-active" : ""}">时:分</button>
                <button type="button" data-clock="1" class="${choices.clockSeconds ? "is-active" : ""}">时:分:秒</button>
              </div>
            </div>
            <label class="os20-onb-switch">
              <input type="checkbox" data-onb-labels ${choices.iconLabels ? "checked" : ""} />
              <span>显示桌面图标文字</span>
            </label>
          </div>`;
        return;
      }

      if (step.id === "device") {
        const profile = kernel.device.profile();
        body.innerHTML = `
          <p class="os20-onb-kicker">Step 4 · 设备</p>
          <h2>这台设备叫什么</h2>
          <p class="os20-onb-lead">只保存在本地，用于多设备列表与布局区分。云端设备身份由服务端单独生成，不会和这里混用。</p>
          <label class="os20-onb-input">
            <span>设备名称</span>
            <input type="text" maxlength="40" data-onb-device value="${escapeHtml(choices.deviceName || profile.name)}" placeholder="例如：卧室的笔记本" />
          </label>
          <p class="os20-onb-hint">检测到：${escapeHtml(profile.type)} · ${escapeHtml(kernel.device.capabilities().shell)} · ${escapeHtml(
            `${kernel.device.capabilities().viewport.width}×${kernel.device.capabilities().viewport.height}`,
          )}</p>`;
        return;
      }

      if (step.id === "apps") {
        body.innerHTML = `
          <p class="os20-onb-kicker">Step 5 · 桌面</p>
          <h2>把常用的应用放到桌面</h2>
          <p class="os20-onb-lead">勾选的应用会出现在桌面图标栏；之后随时可以在应用中心或文件管理器里调整。</p>
          <div class="os20-onb-apps">${appGrid(sys)}</div>`;
        return;
      }

      if (step.id === "workspace") {
        body.innerHTML = `
          <p class="os20-onb-kicker">Step 6 · 工作空间</p>
          <h2>默认从哪套场景开始</h2>
          <p class="os20-onb-lead">工作空间会记住壁纸、主题、组件与窗口布局，之后可以一键切换。</p>
          <div class="os20-onb-grid is-ws">${workspaceOptions()}</div>`;
        return;
      }

      body.innerHTML = `
        <div class="os20-onb-hero">
          <span class="os20-onb-logo" aria-hidden="true">✓</span>
          <p class="os20-onb-kicker">Step 7 · 完成</p>
          <h1>准备好了。</h1>
          <p class="os20-onb-lead">${choices.mode === "cloud" ? "进入桌面后可以在菜单栏用 GitHub 登录，启用云端能力。" : "你现在处于 Local Mode：不需要账号，所有内容都留在这台设备上。"}</p>
          <ul class="os20-onb-points">
            <li><b>系统设置</b><span>外观、应用、插件、云端、设备与隐私都收在「系统设置」里。</span></li>
            <li><b>更新中心</b><span>2.0 是静态网站部署：更新会先检查兼容性并保护本地数据。</span></li>
            <li><b>首次启动可重看</b><span>在系统设置 → 系统 → 关于 里可以重新打开引导。</span></li>
          </ul>
        </div>`;
    };

    /** 把当前选择落到系统上（跳过时也执行，保证「跳过」不是「什么都没发生」） */
    const commitChoices = async (completed: boolean) => {
      try {
        if (choices.theme && choices.theme !== "default") {
          const theme = themeById(choices.theme);
          if (theme) applyTheme(theme, { silent: true });
        }
        if (choices.wallpaper) ctx.api13.setWallpaper(choices.wallpaper);
        ctx.api13.applyLook({
          dock: { pos: choices.dock as "bottom" | "left" | "right", autohide: false },
          preset: "custom",
        });
        const patch: Record<string, unknown> = {
          "desktop.dock.position": choices.dock,
          "desktop.iconLabels": choices.iconLabels,
          "desktop.clockSeconds": choices.clockSeconds,
        };
        // 只有「完成引导」或用户主动点过模式卡片时才写 system.mode；
        // 直接跳过不应该改变现有运行模式（尤其是已登录的 Cloud Mode）。
        if (completed || modeTouched) patch["system.mode"] = choices.mode;
        kernel.settings.update(patch as Parameters<typeof kernel.settings.update>[0]);
        document.documentElement.dataset.clockSeconds = choices.clockSeconds ? "1" : "0";
        const icons = document.querySelector<HTMLElement>(".desk-icons");
        icons?.classList.toggle("os20-no-labels", !choices.iconLabels);

        // 先套工作空间（它会恢复一整套快捷方式），再应用用户在第 5 步的显式选择，
        // 否则「我勾的图标」会被场景快照覆盖掉。
        if (choices.workspace) {
          await applyWorkspace(choices.workspace, ctx, { silent: true });
        }
        for (const appId of choices.apps) {
          if (!sys.hasShortcut(appId)) sys.addShortcut(appId);
        }
        // 取消勾选的从桌面移除（只动桌面图标，不卸载应用、不删数据）
        for (const appId of appOptions().map((meta) => meta.id)) {
          if (!choices.apps.includes(appId) && sys.hasShortcut(appId)) sys.removeShortcut(appId);
        }
      } catch (error) {
        kernel.bus.emit("onboarding:apply-failed", { error: error instanceof Error ? error.message : String(error) });
      }
    };

    const finish = async (completed: boolean) => {
      await commitChoices(completed);
      writeState(kernel, {
        completed,
        completedAt: completed ? Date.now() : null,
        step: "complete",
        choices: choices as unknown as Record<string, unknown>,
      });
      host.classList.add("is-leaving");
      window.setTimeout(() => host.remove(), 260);
      kernel.bus.emit("onboarding:done", { completed });
      resolve({ completed });
    };

    host.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const themeButton = target.closest<HTMLElement>("[data-theme]");
      if (themeButton) {
        choices.theme = themeButton.dataset.theme ?? "default";
        host.querySelectorAll("[data-theme]").forEach((node) => node.classList.toggle("is-active", node === themeButton));
        const theme = themeById(choices.theme);
        if (theme) applyTheme(theme, { silent: true });
        return;
      }

      const wallButton = target.closest<HTMLElement>("[data-wall]");
      if (wallButton) {
        choices.wallpaper = wallButton.dataset.wall ?? "";
        host.querySelectorAll("[data-wall]").forEach((node) => node.classList.toggle("is-active", node === wallButton));
        ctx.api13.setWallpaper(choices.wallpaper);
        return;
      }

      const dockButton = target.closest<HTMLElement>("[data-dock]");
      if (dockButton) {
        choices.dock = dockButton.dataset.dock ?? "bottom";
        host.querySelectorAll("[data-dock]").forEach((node) => node.classList.toggle("is-active", node === dockButton));
        ctx.api13.applyLook({ dock: { pos: choices.dock as "bottom" | "left" | "right" }, preset: "custom" });
        return;
      }

      const clockButton = target.closest<HTMLElement>("[data-clock]");
      if (clockButton) {
        choices.clockSeconds = clockButton.dataset.clock === "1";
        host.querySelectorAll("[data-clock]").forEach((node) => node.classList.toggle("is-active", node === clockButton));
        document.documentElement.dataset.clockSeconds = choices.clockSeconds ? "1" : "0";
        return;
      }

      const modeButton = target.closest<HTMLElement>("[data-mode]");
      if (modeButton) {
        choices.mode = modeButton.dataset.mode === "cloud" ? "cloud" : "local";
        modeTouched = true;
        host.querySelectorAll("[data-mode]").forEach((node) => node.classList.toggle("is-active", node === modeButton));
        return;
      }

      const wsButton = target.closest<HTMLElement>("[data-ws]");
      if (wsButton) {
        choices.workspace = wsButton.dataset.ws ?? "";
        host.querySelectorAll("[data-ws]").forEach((node) => node.classList.toggle("is-active", node === wsButton));
        return;
      }

      if (target.closest("[data-onb-skip]")) {
        void finish(true);
        return;
      }
      if (target.closest("[data-onb-next]")) {
        if (STEPS[stepIndex].id === "complete") {
          void finish(true);
          return;
        }
        // 设备名在离开该步时保存
        const deviceInput = deviceNameInput();
        if (deviceInput && STEPS[stepIndex].id === "device") {
          const name = deviceInput.value.trim();
          choices.deviceName = name;
          kernel.device.rename(name);
        }
        stepIndex = Math.min(STEPS.length - 1, stepIndex + 1);
        writeState(kernel, { step: STEPS[stepIndex].id });
        paint();
        return;
      }
      if (target.closest("[data-onb-back]")) {
        stepIndex = Math.max(0, stepIndex - 1);
        writeState(kernel, { step: STEPS[stepIndex].id });
        paint();
        return;
      }
    });

    host.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.matches("[data-onb-labels]")) {
        choices.iconLabels = target.checked;
        document.querySelector<HTMLElement>(".desk-icons")?.classList.toggle("os20-no-labels", !target.checked);
        return;
      }
      if (target.type === "checkbox" && target.closest("[data-app]")) {
        const id = target.closest<HTMLElement>("[data-app]")?.dataset.app ?? "";
        if (!id) return;
        choices.apps = target.checked
          ? [...new Set([...choices.apps, id])]
          : choices.apps.filter((item) => item !== id);
      }
    });

    // 键盘：Esc 跳过（明确告知「跳过」的语义）
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void finish(true);
    };
    document.addEventListener("keydown", onKey);

    const observer = new MutationObserver(() => {
      if (!host.isConnected) {
        observer.disconnect();
        document.removeEventListener("keydown", onKey);
      }
    });
    observer.observe(document.body, { childList: true });

    paint();
    report(`引导已打开：第 ${stepIndex + 1} 步`);
  });
}

const report = (message: string) => {
  try {
    // 延迟 import 会让首屏多一个请求，这里直接用 console + dataset
    document.documentElement.dataset.onboarding = message;
  } catch {
    /* 忽略 */
  }
};