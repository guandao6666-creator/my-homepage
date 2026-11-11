import { describe, expect, it } from "vitest";

import { SettingsManager } from "../../src/lib/core/settings";
import { MemoryStore, createStorage } from "../../src/lib/core/storage";
import {
  DEVICE_ONLY_SETTINGS,
  MAX_PREFERENCES_PAYLOAD_BYTES,
  PREFERENCES_ENTITY_ID,
  SYNC_PREFERENCE_KEYS,
  applyPreferencesPayload,
  buildPreferencesPayload,
  markPreferencesSynced,
  preferencesHash,
  preferencesUpdatedAt,
  readLocalPreferences,
  validatePreferencesPayload,
  type PreferencesSyncKernel,
} from "../../src/lib/sync/preferences";

/**
 * 偏好同步单测：白名单边界（设备级设置永不外发）、类型/范围校验、
 * 容忍式应用与 last-synced updatedAt 语义。
 */

const makeKernel = (): PreferencesSyncKernel => {
  const storage = createStorage({ store: new MemoryStore() });
  const settings = new SettingsManager({ storage });
  return { settings, storage };
};

describe("偏好同步白名单", () => {
  it("只构建白名单内的 13 项，且不含设备级设置", () => {
    const kernel = makeKernel();
    const payload = buildPreferencesPayload(kernel.settings, kernel);

    expect(payload.v).toBe(1);
    expect(Object.keys(payload.values).sort()).toEqual([...SYNC_PREFERENCE_KEYS].sort());
    expect(payload.values["appearance.mode"]).toBe("dark");
    expect(payload.values["desktop.widgets.opacity"]).toBe(100);
    expect(payload.values["notifications.volume"]).toBe(45);
    expect(payload.values["system.updateChannel"]).toBe("stable");

    // 设备级 / 设备身份信息绝不进入 payload
    const flat = JSON.stringify(payload);
    for (const id of DEVICE_ONLY_SETTINGS) expect(flat).not.toContain(id);
    expect(flat).not.toContain("system.mode");
    expect(flat).not.toContain("system.diagnosticsRetention");
    expect(flat).not.toContain("token");
  });

  it("校验：合法 payload 通过，未知键 / 设备级键 / 非法值明确报错", () => {
    const kernel = makeKernel();
    const payload = buildPreferencesPayload(kernel.settings);
    const ok = validatePreferencesPayload(payload);
    expect(ok.ok).toBe(true);

    const device = validatePreferencesPayload({ v: 1, values: { "system.mode": "cloud" } });
    expect(device.ok).toBe(false);
    if (!device.ok) expect(device.error).toContain("设备级设置");

    const retention = validatePreferencesPayload({ v: 1, values: { "system.diagnosticsRetention": 100 } });
    expect(retention.ok).toBe(false);
    if (!retention.ok) expect(retention.error).toContain("设备级设置");

    const unknown = validatePreferencesPayload({ v: 1, values: { "foo.bar": true } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("不在同步白名单");

    const badType = validatePreferencesPayload({ v: 1, values: { "appearance.mode": 3 } });
    expect(badType.ok).toBe(false);

    const outOfRange = validatePreferencesPayload({ v: 1, values: { "desktop.widgets.opacity": 200 } });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error).toContain("值非法");

    const badSelect = validatePreferencesPayload({ v: 1, values: { "appearance.mode": "neon" } });
    expect(badSelect.ok).toBe(false);

    const customAccent = validatePreferencesPayload({ v: 1, values: { "appearance.accent": "#A1B2C3" } });
    expect(customAccent.ok).toBe(true);

    const badAccent = validatePreferencesPayload({ v: 1, values: { "appearance.accent": "red" } });
    expect(badAccent.ok).toBe(false);

    const notJson = validatePreferencesPayload("{坏掉的 payload");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error).toContain("合法 JSON");
  });

  it("payload 超过 32KB 明确拒绝", () => {
    const result = validatePreferencesPayload({ v: 1, values: { "huge.value": "x".repeat(40_000) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_PREFERENCES_PAYLOAD_BYTES));
  });
});

describe("应用远端偏好", () => {
  it("只写白名单字段，设备级/未知/非法值进 rejected 且不抛异常", () => {
    const kernel = makeKernel();
    const result = applyPreferencesPayload(kernel.settings, kernel, {
      v: 1,
      values: {
        "appearance.mode": "light",
        "notifications.volume": 70,
        "system.mode": "cloud",
        "desktop.widgets.opacity": 200,
        "foo.bar": true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.applied.sort()).toEqual(["appearance.mode", "notifications.volume"]);
    expect(result.rejected.sort()).toEqual(["desktop.widgets.opacity", "foo.bar", "system.mode"]);

    expect(kernel.settings.get("appearance.mode")).toBe("light");
    expect(kernel.settings.get("notifications.volume")).toBe(70);
    // 设备级设置保持本机默认值，绝不被云端覆盖
    expect(kernel.settings.get("system.mode")).toBe("local");
    expect(kernel.settings.get("system.diagnosticsRetention")).toBe(200);
  });

  it("非法 payload 不崩：损坏 JSON / 版本不符 / values 缺失", () => {
    const kernel = makeKernel();
    const broken = applyPreferencesPayload(kernel.settings, kernel, "{坏掉的 JSON");
    expect(broken.ok).toBe(false);
    expect(broken.applied).toEqual([]);

    const wrongVersion = applyPreferencesPayload(kernel.settings, kernel, { v: 2, values: { "appearance.mode": "light" } });
    expect(wrongVersion.ok).toBe(false);

    const noValues = applyPreferencesPayload(kernel.settings, kernel, { v: 1 });
    expect(noValues.ok).toBe(false);

    const deviceOnly = applyPreferencesPayload(kernel.settings, kernel, { v: 1, values: { "system.mode": "cloud" } });
    expect(deviceOnly.ok).toBe(true);
    expect(deviceOnly.applied).toEqual([]);
    expect(deviceOnly.rejected).toContain("system.mode");
    expect(deviceOnly.error).toBeTruthy();
  });

  it("内容未变时 updatedAt 保持上次同步值，用户改动后才 bump", () => {
    const kernel = makeKernel();
    expect(preferencesUpdatedAt(kernel)).toBe(0);

    markPreferencesSynced(kernel, 1_234);
    expect(preferencesUpdatedAt(kernel)).toBe(1_234);

    const local = readLocalPreferences(kernel);
    expect(local.id).toBe(PREFERENCES_ENTITY_ID);
    expect(local.updatedAt).toBe(1_234);

    kernel.settings.update({ "appearance.mode": "light" });
    const bumped = preferencesUpdatedAt(kernel);
    expect(bumped).toBeGreaterThan(1_234);

    markPreferencesSynced(kernel, 2_222);
    expect(preferencesUpdatedAt(kernel)).toBe(2_222);

    // 若显式传入旧快照，哈希不同 → 视为已改
    const stale = preferencesHash({ ...kernel.settings.read(), "appearance.mode": "dark" });
    expect(stale).not.toBe(preferencesHash(kernel.settings.read()));
  });

  it("白名单指纹与键顺序无关", () => {
    const hashA = preferencesHash({ "appearance.mode": "dark", "notifications.volume": 45 });
    const hashB = preferencesHash({ "notifications.volume": 45, "appearance.mode": "dark" });
    expect(hashA).toBe(hashB);
    expect(preferencesHash({ "appearance.mode": "light", "notifications.volume": 45 })).not.toBe(hashA);
    expect(hashA).toContain("appearance.mode");
    expect(hashA).toContain("notifications.volume");
    expect(hashA).not.toContain("system.mode");
  });
});
