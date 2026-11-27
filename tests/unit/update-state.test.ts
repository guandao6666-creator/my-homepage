/**
 * 2.0.8 · 更新中心「应用更新」按钮判定
 *
 * 复现：服务端更新过一次 → 断网再点「检查更新」→ 失败后旧 server 仍在 state 里，
 * 页面显示「有新版」、按钮可点，但 fetch 失败根本没有新资源，点下去只是重新加载旧页。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canApplyUpdate } from "../../src/lib/os20/apps/update-state";

describe("更新中心按钮判定", () => {
  it("检查成功且服务端更新时才允许应用", () => {
    expect(canApplyUpdate("ready", { version: "2.0.9" }, 1)).toBe(true);
  });

  it("检查中 / 失败 / 离线 / 空闲都不允许", () => {
    const server = { version: "2.0.9" };
    expect(canApplyUpdate("checking", server, 1)).toBe(false);
    expect(canApplyUpdate("failed", server, 1)).toBe(false);
    expect(canApplyUpdate("offline", server, 1)).toBe(false);
    expect(canApplyUpdate("idle", server, 1)).toBe(false);
  });

  it("没有 server、版本相同或更旧都不允许", () => {
    expect(canApplyUpdate("ready", null, 1)).toBe(false);
    expect(canApplyUpdate("ready", { version: "2.0.8" }, 0)).toBe(false);
    expect(canApplyUpdate("ready", { version: "2.0.7" }, -1)).toBe(false);
    expect(canApplyUpdate("ready", { version: "2.0.9" }, null)).toBe(false);
  });
});

describe("updatecenter 接线约束", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/lib/os20/apps/updatecenter.ts", import.meta.url)),
    "utf8",
  );

  it("按钮 disabled 走 canApplyUpdate", () => {
    expect(source).toContain('canApplyUpdate(state.phase, server, comparison()) ? "" : "disabled"');
  });

  it("失败与离线两个分支都清空陈旧 server", () => {
    // 两处赋值：接口返回异常、catch（离线/网络失败）
    expect(source.match(/state\.server = null;/g)?.length).toBe(2);
  });
});