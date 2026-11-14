/**
 * Guandao Devices · 设备模型
 *
 * 这里集中三件事，避免认证层与设备 API 各写一套：
 *   1. 有限的 User-Agent 解析（浏览器 / 系统 / 设备类型），不做指纹识别；
 *   2. 登录时的设备登记与归属校验；
 *   3. 设备状态推导（活跃 / 最近使用 / 闲置 / 未知 / 已撤销）。
 *
 * 安全边界：
 *   - device_id 由服务端生成，绝不作为认证凭证；
 *   - 客户端传来的 device_id 只有在「属于当前用户且未撤销」时才会复用；
 *   - 已撤销设备再次登录会得到一条全新记录，历史不会被静默复活。
 */

export const DEVICE_TYPES = ["desktop", "laptop", "tablet", "mobile"];

import { logSecurityEvent } from "../privacy/events.js";
/** 只有 5 分钟内有前台心跳，才允许显示「活跃」。 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
/** 24 小时内出现过，算「最近使用」。 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 心跳写库节流：同一设备 60 秒内最多落一次 D1 写入。 */
export const HEARTBEAT_WRITE_INTERVAL_MS = 60 * 1000;
/** 云端数据超过 7 天没成功同步，提示 Needs Sync。 */
export const SYNC_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** 新设备提醒保留 30 天。 */
export const ALERT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDeviceId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

const DEFAULT_NAMES = {
  desktop: "My Desktop",
  laptop: "My Laptop",
  tablet: "My Tablet",
  mobile: "My Phone",
};

/**
 * 只解析到「浏览器名 / 系统名 / 设备类型」三件事。
 * 不读取屏幕、字体、时区、语言等可组合成指纹的信息。
 */
export function describeUserAgent(rawUserAgent) {
  const ua = String(rawUserAgent || "").slice(0, 400);

  const os = /Windows NT/i.test(ua)
    ? "Windows"
    : /iPhone|iPod/i.test(ua)
      ? "iOS"
      : /iPad/i.test(ua)
        ? "iPadOS"
        : /Android/i.test(ua)
          ? "Android"
          : /CrOS/i.test(ua)
            ? "ChromeOS"
            : /Mac OS X|Macintosh/i.test(ua)
              ? "macOS"
              : /Linux/i.test(ua)
                ? "Linux"
                : "未知系统";

  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\/|Opera/i.test(ua)
      ? "Opera"
      : /SamsungBrowser/i.test(ua)
        ? "Samsung Internet"
        : /CriOS/i.test(ua)
          ? "Chrome"
          : /FxiOS|Firefox/i.test(ua)
            ? "Firefox"
            : /Chrome\//i.test(ua)
              ? "Chrome"
              : /Safari\//i.test(ua)
                ? "Safari"
                : "浏览器";

  const tablet =
    /iPad/i.test(ua) ||
    (/Android/i.test(ua) && !/Mobile/i.test(ua)) ||
    (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) ||
    /Tablet/i.test(ua);

  const mobile = !tablet && (/iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua)));

  // UA 无法可靠区分台式机与笔记本：统一按 desktop 登记，用户可自行改为 laptop。
  const type = tablet ? "tablet" : mobile ? "mobile" : "desktop";

  return { type, browser: browser.slice(0, 40), os: os.slice(0, 40), name: DEFAULT_NAMES[type], userAgent: ua };
}

export function defaultDeviceName(type) {
  return DEFAULT_NAMES[type] ?? DEFAULT_NAMES.desktop;
}

/**
 * 登录时绑定设备。
 *
 * @returns {{ deviceId: string, isNew: boolean, replacedRevoked: boolean, info: object }}
 *   deviceId 一定是当前用户可用的设备 ID；旧 ID 属于他人或已撤销时自动换新。
 */
export async function bindDeviceOnLogin(env, { userId, candidateId, userAgent }) {
  const info = describeUserAgent(userAgent);
  const now = Date.now();
  let replacedRevoked = false;
  let existing = null;

  if (isDeviceId(candidateId)) {
    existing = await env.DB.prepare("SELECT id, user_id, revoked_at FROM devices WHERE id = ?")
      .bind(candidateId)
      .first();
  }

  // 别人的设备 ID / 已撤销的设备：一律不复用，换一条新记录。
  if (existing && existing.user_id !== userId) existing = null;
  if (existing && existing.revoked_at) {
    replacedRevoked = true;
    existing = null;
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE devices
          SET last_seen_at = ?, last_active_at = ?,
              browser_name = COALESCE(NULLIF(browser_name, ''), ?),
              os_name = COALESCE(NULLIF(os_name, ''), ?),
              device_type = CASE WHEN device_type IS NULL OR device_type = '' THEN ? ELSE device_type END,
              user_agent = ?
        WHERE id = ? AND user_id = ?`,
    )
      .bind(now, now, info.browser, info.os, info.type, info.userAgent, existing.id, userId)
      .run();

    return { deviceId: existing.id, isNew: false, replacedRevoked, info };
  }

  // 新记录一定是服务端生成的新 UUID：不复用客户端提交的任何值。
  const deviceId = crypto.randomUUID();

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM devices WHERE user_id = ?")
    .bind(userId)
    .first();
  const isFirstDevice = Number(countRow?.total ?? 0) === 0;

  await env.DB.prepare(
    `INSERT INTO devices
       (id, user_id, name, platform, device_type, browser_name, os_name,
        user_agent, last_seen_at, last_active_at, trusted_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(
      deviceId,
      userId,
      info.name,
      info.os,
      info.type,
      info.browser,
      info.os,
      info.userAgent,
      now,
      now,
      // 第一台设备自动确认：否则唯一设备也会被标成「未确认」，属于噪音。
      isFirstDevice ? now : null,
      now,
    )
    .run();

  await logActivity(env, {
    userId,
    deviceId,
    eventType: "registered",
    metadata: { name: info.name, type: info.type, browser: info.browser, os: info.os },
  });

  await logSecurityEvent(env, {
    userId,
    eventType: "new_device_registered",
    deviceId,
    metadata: { browser: info.browser, os: info.os, deviceType: info.type },
  });

  return { deviceId, isNew: true, replacedRevoked, info };
}

export async function logActivity(env, { userId, deviceId, eventType, metadata }) {
  try {
    await env.DB.prepare(
      `INSERT INTO device_activity (id, user_id, device_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        deviceId ?? null,
        eventType,
        metadata ? JSON.stringify(metadata).slice(0, 2000) : null,
        Date.now(),
      )
      .run();
  } catch (error) {
    // 审计写入失败不能阻断正常业务（例如登录），但必须留下服务端日志。
    console.error("[devices] activity log failed:", error?.message ?? error);
  }
}

/** 设备状态：撤销优先，其次看最近一次心跳落在哪个时间窗。 */
export function derivePresence(row, now = Date.now()) {
  if (row.revoked_at || row.status === "revoked") return "revoked";
  const lastSeen = Number(row.last_seen_at || 0);
  if (!lastSeen) return "unknown";
  const delta = now - lastSeen;
  if (delta <= ONLINE_WINDOW_MS) return "active";
  if (delta <= RECENT_WINDOW_MS) return "recent";
  return "idle";
}

export function syncDomainView(row) {
  if (!row) {
    return {
      mode: "local",
      lastSyncAt: null,
      lastAttemptAt: null,
      lastResult: null,
      pendingUp: 0,
      pendingDown: 0,
      conflicts: 0,
      updatedAt: null,
      requestedAt: null,
    };
  }
  return {
    mode: row.mode === "cloud" ? "cloud" : "local",
    lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
    lastAttemptAt: row.last_attempt_at ? Number(row.last_attempt_at) : null,
    lastResult: row.last_result || null,
    pendingUp: Number(row.pending_up || 0),
    pendingDown: Number(row.pending_down || 0),
    conflicts: Number(row.conflicts || 0),
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
    requestedAt: row.sync_requested_at ? Number(row.sync_requested_at) : null,
  };
}

export function publicDevice(row, { currentDeviceId, now = Date.now(), syncRows = [] }) {
  const presence = derivePresence(row, now);
  const syncByDomain = new Map(syncRows.map((item) => [item.domain, item]));
  const driveRow = syncByDomain.get("drive");

  return {
    id: row.id,
    name: row.name,
    type: DEVICE_TYPES.includes(row.device_type) ? row.device_type : "desktop",
    browser: row.browser_name || "未知浏览器",
    os: row.os_name || row.platform || "未知系统",
    createdAt: Number(row.created_at || 0),
    lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
    lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null,
    lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    status: row.revoked_at || row.status === "revoked" ? "revoked" : "active",
    presence,
    trusted: Boolean(row.trusted_at),
    isCurrent: row.id === currentDeviceId,
    sessionCount: Number(row.session_count || 0),
    activeSessionCount: Number(row.active_session_count || 0),
    sync: {
      // 只展示设备自己上报过的成功同步时间；账号级文件活动另放 overview.drive。
      drive: { ...syncDomainView(driveRow), mode: "cloud" },
      notes: syncDomainView(syncByDomain.get("notes")),
      tasks: syncDomainView(syncByDomain.get("tasks")),
      calendar: syncDomainView(syncByDomain.get("calendar")),
    },
  };
}
