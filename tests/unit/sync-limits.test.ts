/**
 * Guandao OS 2.0 · Phase 4 同步限额纯函数
 *
 * 这些常量/函数同时被存储层、HTTP 层、Cron 维护和 QA 脚本引用，属于跨层契约：
 * 上限写错会让客户端以为能推、服务端却 409，或者反过来让墓碑永远清不掉。
 * 所以这里测边界值，不 mock 任何东西。
 */
import { describe, expect, it } from "vitest";

import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_MAX_PER_RUN,
  DEFAULT_PAYLOAD_LIMIT,
  DOMAIN_PAYLOAD_LIMITS,
  MAX_ENTITIES_PER_USER,
  MAX_TOMBSTONES_PER_USER,
  SYNC_DOMAINS,
  TOMBSTONE_TTL_DAYS,
  TOMBSTONE_TTL_MS,
  domainPayloadLimit,
  isSyncDomain,
  isTombstoneExpired,
  tombstoneCutoff,
} from "../../worker/api/sync/limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("同步数据域", () => {
  it("正好是五个域，旧三域在前", () => {
    expect([...SYNC_DOMAINS]).toEqual(["notes", "tasks", "calendar", "workspace", "preferences"]);
    expect(Object.isFrozen(SYNC_DOMAINS)).toBe(true);
  });

  it("isSyncDomain 只认白名单里的字符串", () => {
    for (const domain of SYNC_DOMAINS) expect(isSyncDomain(domain)).toBe(true);
    for (const value of ["passwords", "", "Notes", " notes", null, undefined, 42, {}]) {
      expect(isSyncDomain(value)).toBe(false);
    }
  });
});

describe("payload 上限", () => {
  it("默认 128KB，workspace 128KB，preferences 32KB", () => {
    expect(DEFAULT_PAYLOAD_LIMIT).toBe(128 * 1024);
    expect(domainPayloadLimit("notes")).toBe(128 * 1024);
    expect(domainPayloadLimit("tasks")).toBe(128 * 1024);
    expect(domainPayloadLimit("calendar")).toBe(128 * 1024);
    expect(domainPayloadLimit("workspace")).toBe(128 * 1024);
    expect(domainPayloadLimit("preferences")).toBe(32 * 1024);
  });

  it("未知域回落到默认值（真正的域校验在 HTTP 层）", () => {
    expect(domainPayloadLimit("passwords")).toBe(DEFAULT_PAYLOAD_LIMIT);
    expect(domainPayloadLimit("")).toBe(DEFAULT_PAYLOAD_LIMIT);
  });

  it("覆盖表与函数结果一致", () => {
    expect(DOMAIN_PAYLOAD_LIMITS.workspace).toBe(128 * 1024);
    expect(DOMAIN_PAYLOAD_LIMITS.preferences).toBe(32 * 1024);
    const table: Readonly<Record<string, number>> = DOMAIN_PAYLOAD_LIMITS;
    for (const domain of ["workspace", "preferences"]) {
      expect(domainPayloadLimit(domain)).toBe(table[domain]);
    }
  });
});

describe("配额与清理常量", () => {
  it("实体 5000 条、墓碑 2000 条", () => {
    expect(MAX_ENTITIES_PER_USER).toBe(5000);
    expect(MAX_TOMBSTONES_PER_USER).toBe(2000);
  });

  it("墓碑保留 90 天，单批 200 条、单次 Cron 2000 条", () => {
    expect(TOMBSTONE_TTL_DAYS).toBe(90);
    expect(TOMBSTONE_TTL_MS).toBe(90 * DAY_MS);
    expect(CLEANUP_BATCH_SIZE).toBe(200);
    expect(CLEANUP_MAX_PER_RUN).toBe(2000);
    // 单次上限必须能整除批量，否则 maintenance 的分批循环会留下零头
    expect(CLEANUP_MAX_PER_RUN % CLEANUP_BATCH_SIZE).toBe(0);
  });
});

describe("墓碑 TTL 判定", () => {
  const now = 100 * DAY_MS;

  it("刚过期不算：严格超过 90 天才算过期", () => {
    expect(isTombstoneExpired(now - TOMBSTONE_TTL_MS, now)).toBe(false);
    expect(isTombstoneExpired(now - TOMBSTONE_TTL_MS - 1, now)).toBe(true);
    expect(isTombstoneExpired(now - 10 * DAY_MS, now)).toBe(false);
    expect(isTombstoneExpired(now - 91 * DAY_MS, now)).toBe(true);
  });

  it("无效的时间戳不作过期处理（避免把 NULL/坏数据误删）", () => {
    expect(isTombstoneExpired(null as unknown as number, now)).toBe(false);
    expect(isTombstoneExpired(undefined as unknown as number, now)).toBe(false);
    expect(isTombstoneExpired(0, now)).toBe(false);
    expect(isTombstoneExpired(-1, now)).toBe(false);
    expect(isTombstoneExpired(Number.NaN, now)).toBe(false);
  });

  it("tombstoneCutoff 与过期判定对齐", () => {
    expect(tombstoneCutoff(now)).toBe(now - 90 * DAY_MS);
    expect(tombstoneCutoff(now, 10)).toBe(now - 10 * DAY_MS);
    // deleted_at 恰好等于 cutoff 的墓碑不删（SQL 用 deleted_at < cutoff）
    expect(isTombstoneExpired(tombstoneCutoff(now), now)).toBe(false);
  });
});
