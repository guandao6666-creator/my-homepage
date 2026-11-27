/**
 * 2.0.8 · 插件版本签名信任闸门的证据
 *
 * 为什么需要：2.0.8 之前只有「首次安装」检查签名状态与密钥是否被撤销，
 * `PATCH /installations/:id`（更新）与 `POST .../rollback` 只看 packageHash。
 * 开发者撤销密钥后，用户仍能把旧包「更新」或「回退」回来，撤销等于装饰。
 *
 * 这里直接跑 `assertVersionTrusted`：假 D1 只实现 publisher_keys 查询，
 * 覆盖 invalid / 未知密钥 / 别人的密钥 / 已撤销 / active / 无签名 六种状态；
 * 再加源码断言保证 install、update、rollback 三条路径都调用同一个闸门
 * （rollback 还要求插件仍是 published，避免下架插件被回退复活）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertVersionTrusted } from "../../worker/api/plugins/handlers.js";
import { ApiError } from "../../worker/api/http.js";

interface FakeEnv {
  DB: {
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => {
        first: () => Promise<Record<string, unknown> | null>;
        run: () => Promise<{ meta: { changes: number } }>;
      };
    };
  };
}

function makeEnv(keyRow: Record<string, unknown> | null): { env: FakeEnv; binds: () => number } {
  let binds = 0;
  const env: FakeEnv = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          binds += 1;
          void args;
          return {
            first: async () => (sql.includes("FROM publisher_keys") ? keyRow : null),
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
      }),
    },
  };
  return { env, binds: () => binds };
}

const PLUGIN = { id: "com.test.plugin", developer_id: "dev-1" };
const VERSION = {
  version: "1.0.0",
  package_sha256: "a".repeat(64),
  signature_status: "valid",
  signature_key_id: "key-1",
};

async function catchError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("期望抛出 ApiError，但调用成功返回了");
}

describe("插件版本签名信任", () => {
  it("签名状态 invalid：拒绝并给出 SIG_INVALID", async () => {
    const { env } = makeEnv({ key_id: "key-1", user_id: "dev-1", status: "active" });
    const error = await catchError(
      assertVersionTrusted(env, { ...VERSION, signature_status: "invalid" }, PLUGIN),
    );
    expect(error.code).toBe("SIGNATURE_INVALID");
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ signatureCode: "SIG_INVALID" });
  });

  it("签名密钥查不到：拒绝并给出 SIG_KEY_UNKNOWN", async () => {
    const { env } = makeEnv(null);
    const error = await catchError(assertVersionTrusted(env, VERSION, PLUGIN));
    expect(error.code).toBe("SIGNATURE_KEY_UNKNOWN");
    expect(error.details).toEqual({ signatureCode: "SIG_KEY_UNKNOWN" });
  });

  it("密钥属于其他开发者：拒绝（不能借用别人的密钥）", async () => {
    const { env } = makeEnv({ key_id: "key-1", user_id: "dev-2", status: "active" });
    const error = await catchError(assertVersionTrusted(env, VERSION, PLUGIN));
    expect(error.code).toBe("SIGNATURE_KEY_UNKNOWN");
  });

  it("密钥已撤销：拒绝并给出 SIG_KEY_REVOKED", async () => {
    const { env } = makeEnv({ key_id: "key-1", user_id: "dev-1", status: "revoked" });
    const error = await catchError(assertVersionTrusted(env, VERSION, PLUGIN));
    expect(error.code).toBe("SIGNATURE_KEY_REVOKED");
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ signatureCode: "SIG_KEY_REVOKED" });
  });

  it("active 密钥：放行并原样返回版本行", async () => {
    const { env } = makeEnv({ key_id: "key-1", user_id: "dev-1", status: "active" });
    const version = { ...VERSION };
    await expect(assertVersionTrusted(env, version, PLUGIN)).resolves.toBe(version);
  });

  it("没有签名密钥的旧版本：放行（不能把历史无签名包全部作废）", async () => {
    const { env, binds } = makeEnv(null);
    const version = { ...VERSION, signature_status: "unsigned", signature_key_id: null };
    await expect(assertVersionTrusted(env, version, PLUGIN)).resolves.toBe(version);
    expect(binds()).toBe(0);
  });

  it("版本行缺失：按 VERSION_NOT_AVAILABLE 拒绝", async () => {
    const { env } = makeEnv(null);
    const error = await catchError(assertVersionTrusted(env, null, PLUGIN));
    expect(error.code).toBe("VERSION_NOT_AVAILABLE");
  });

  it("源码约束：install / update / rollback 共用闸门，rollback 禁止下架插件", () => {
    const file = fileURLToPath(
      new URL("../../worker/api/plugins/handlers.js", import.meta.url),
    );
    const source = readFileSync(file, "utf8");
    const calls = source.match(/await assertVersionTrusted\(env, version, row\);/g) ?? [];
    expect(calls.length).toBe(3);
    // 闸门内的错误码只应定义一次（避免有人再复制一份内联判断）
    expect(source.match(/throw new ApiError\("SIGNATURE_KEY_REVOKED"/g)?.length).toBe(1);
    expect(source).toContain("该插件已被安全下架，不能回退");
  });
});