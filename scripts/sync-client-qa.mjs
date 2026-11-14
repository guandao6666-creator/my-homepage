#!/usr/bin/env node
/**
 * Guandao OS 2.0 · 云同步「真浏览器 + 真 Worker」联调
 *
 * 与 sync-qa.mjs 的分工：
 *   - sync-qa.mjs 验证 API 语义（乐观锁 / 墓碑 / 用户隔离）；
 *   - 本脚本验证客户端：内核启动 → 云模式 → 登录态 → 注册三个数据域 →
 *     本地笔记被推送 → 另一台「设备」（全新 localStorage）拉取后能看到。
 *
 * 依赖：本机 Chrome、wrangler dev --local、本地 D1 已迁移。
 * 不接触线上资源；测试用户与数据在结束时删除。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const WRANGLER = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const PORT = Number(process.env.SYNC_UI_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "guandao-db";
const TOKEN = randomBytes(32).toString("base64url");
const USER = "qa-sync-ui-user";
const NOTE_ID = "n-e2e-sync";
const NOTE_TITLE = "E2E 同步笔记";

const results = [];
let failures = 0;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (pass) console.log(`  ok   ${name}${detail ? ` · ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function d1(sql) {
  execFileSync(process.execPath, [WRANGLER, "d1", "execute", DB, "--local", "--command", sql], {
    stdio: "ignore",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });
}

function seed() {
  const now = Date.now();
  d1(
    `INSERT OR REPLACE INTO users (id, email, display_name, status, created_at, updated_at, github_id, github_username, avatar_url, role, last_login_at)
     VALUES ('${USER}', 'qa-sync-ui@example.test', 'QA Sync UI', 'active', ${now}, ${now}, 910000003, 'qa-sync-ui', NULL, 'member', ${now});
     INSERT OR REPLACE INTO sessions (id, user_id, token_hash, device_id, user_agent, expires_at, created_at, last_used_at)
     VALUES ('qa-sync-ui-session', '${USER}', '${sha256(TOKEN)}', NULL, 'sync-ui-qa', ${now + 3600_000}, ${now}, ${now});`,
  );
}

function cleanup() {
  try {
    d1(
      `DELETE FROM sync_entities WHERE user_id = '${USER}' AND user_id LIKE 'qa-%';
       DELETE FROM sessions WHERE user_id = '${USER}' AND user_id LIKE 'qa-%';
       DELETE FROM users WHERE id = '${USER}'
         AND id LIKE 'qa-%' AND email LIKE 'qa-%@example.test';`,
    );
  } catch (error) {
    console.warn("[sync-ui] 清理失败：", error?.message ?? error);
  }
}

async function waitForWorker(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(1000);
  }
  return false;
}

async function apiIndex() {
  const response = await fetch(`${BASE}/api/sync/index?domain=notes`, {
    headers: { accept: "application/json", cookie: `gauth_sid=${TOKEN}` },
  });
  const payload = await response.json().catch(() => null);
  return payload?.data?.entities ?? [];
}

const settingsSeed = {
  v: 2,
  at: Date.now(),
  data: { "system.mode": "cloud", "privacy.analytics": false },
};

const notesSeed = (now) => ({
  v: 1,
  folders: [{ id: "inbox", name: "收集箱" }],
  notes: [
    {
      id: NOTE_ID,
      title: NOTE_TITLE,
      body: "# E2E 同步笔记\n\n这条笔记用来验证 2.0 云同步。",
      folder: "inbox",
      tags: ["e2e"],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  ui: { folder: "all", noteId: NOTE_ID, mode: "edit" },
});

async function main() {
  console.log("[sync-ui] 准备测试账号…");
  seed();

  console.log(`[sync-ui] 启动 wrangler dev --local（:${PORT}）…`);
  const child = spawn(process.execPath, [WRANGLER, "dev", "--local", "--port", String(PORT)], {
    stdio: "ignore",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });

  const browser = await chromium.launch({ channel: "chrome" });
  try {
    if (!(await waitForWorker())) throw new Error("Worker 未在 90 秒内就绪");

    const cookie = {
      name: "gauth_sid",
      value: TOKEN,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    };

    /* ---------- 设备 1：有本地笔记，应该被推送上去 ---------- */
    const context1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context1.addCookies([cookie]);
    await context1.addInitScript(
      ({ settings, notes }) => {
        localStorage.setItem("guandao.core.settings.v1", JSON.stringify(settings));
        localStorage.setItem("guandao.os14.notes.v1", JSON.stringify(notes));
      },
      { settings: settingsSeed, notes: notesSeed(Date.now()) },
    );
    const page1 = await context1.newPage();
    await page1.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page1.waitForFunction(() => Boolean(window.GOS20_READY), null, { timeout: 30_000 });
    const boot1 = await page1.evaluate(() => window.GOS20_READY);
    check("设备 1 内核启动", Boolean(boot1?.stages?.length), `${boot1?.stages?.length ?? 0} 个阶段`);

    const domains = await page1.evaluate(() => window.GOS20.syncDomains?.() ?? []);
    check("客户端注册了三个同步域", domains.length === 3, domains.join(","));

    // 等推送完成：服务端索引里出现这条笔记
    let pushed = false;
    for (let i = 0; i < 40 && !pushed; i += 1) {
      await sleep(500);
      pushed = (await apiIndex()).some((entity) => entity.id === NOTE_ID && !entity.deleted);
    }
    check("本地笔记被推送到服务端", pushed);

    const status = await page1.evaluate(() => window.GOS20.sync?.domains?.().find((item) => item.id === "notes") ?? null);
    check("客户端同步状态为 ok", status?.state === "ok", `state=${status?.state}`);

    await page1.evaluate(() => window.GOS14.ctx.openApp("systemcenter"));
    await page1.waitForSelector('.window[data-app="systemcenter"] .g14-nav[data-tab="cloud"]');
    await page1.locator('.window[data-app="systemcenter"] .g14-nav[data-tab="cloud"]').click();
    await page1.waitForTimeout(500);
    const cloudText = await page1.locator('.window[data-app="systemcenter"]').innerText();
    check("系统设置显示 Notes 已同步", /Notes[\s\S]{0,40}(已同步|待同步)/.test(cloudText));
    await context1.close();

    /* ---------- 设备 2：空 localStorage，应该拉到同一条笔记 ---------- */
    const context2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context2.addCookies([cookie]);
    await context2.addInitScript(
      (settings) => localStorage.setItem("guandao.core.settings.v1", JSON.stringify(settings)),
      settingsSeed,
    );
    const page2 = await context2.newPage();
    await page2.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page2.waitForFunction(() => Boolean(window.GOS20_READY), null, { timeout: 30_000 });

    let pulled = false;
    for (let i = 0; i < 40 && !pulled; i += 1) {
      await sleep(500);
      pulled = await page2.evaluate(
        (id) => {
          try {
            const raw = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}");
            return Array.isArray(raw.notes) && raw.notes.some((note) => note.id === id);
          } catch {
            return false;
          }
        },
        NOTE_ID,
      );
    }
    check("新设备拉取到同一篇笔记", pulled);

    const title = await page2.evaluate((id) => {
      const raw = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}");
      return raw.notes?.find((note) => note.id === id)?.title ?? "";
    }, NOTE_ID);
    check("笔记内容一致", title === NOTE_TITLE, title);

    const count = await page2.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}");
      return (raw.notes ?? []).filter((note) => note.id === "n-e2e-sync").length;
    });
    check("没有重复插入", count === 1, `${count} 条`);
    await context2.close();
  } finally {
    await browser.close();
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已退出 */
    }
    cleanup();
  }

  console.log("");
  if (failures) {
    console.error(`[sync-ui] ${results.length} 项中 ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log(`[sync-ui] 全部 ${results.length} 项通过`);
  }
}

main().catch((error) => {
  console.error("[sync-ui] 失败：", error?.message ?? error);
  process.exitCode = 1;
});