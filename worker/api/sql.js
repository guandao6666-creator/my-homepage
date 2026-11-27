/**
 * Guandao OS 2.0.5 · D1 绑定参数分块
 *
 * D1 每条语句最多 100 个绑定参数（Cloudflare 文档与 2.0.4 的深目录删除事故都指向同一上限）。
 * 凡是把「一批 id」展开成 `IN (?, ?, …)` 的地方，都必须自己先分块：
 *   - 分块大小取 40，和 `worker/api/sync/store.js` 的 `ID_CHUNK_SIZE`、`worker/api/files/handlers.js`
 *     的 `FOLDER_TREE_CHUNK` 保持一致，给同一批次里其它绑定（user_id、时间戳等）留余量；
 *   - 计数器/上限判断不能因为分块而丢掉 —— 调用方仍然要自己做总数校验。
 */

/** 与 D1 单条语句的参数上限「保守留余量」一致的值。 */
export const D1_PARAM_LIMIT = 100;

/** 每块 40 个 id：40 + 少量其它绑定，离 100 还有足够余量。 */
export const ID_CHUNK_SIZE = 40;

/**
 * 把列表切成固定大小的块。
 * @template T
 * @param {readonly T[]} list
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunkIds(list, size = ID_CHUNK_SIZE) {
  if (!Array.isArray(list) || list.length === 0) return [];
  // 防御异常 size：0/负数会让 for 循环永远前进不了。
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : ID_CHUNK_SIZE;
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/**
 * 生成 `?, ?, ?` 占位符串，长度与块大小一致。
 * @param {readonly unknown[]} chunk
 * @returns {string}
 */
export function placeholdersFor(chunk) {
  return chunk.map(() => "?").join(", ");
}

/**
 * 断言一条语句的绑定参数不会超过 D1 上限。
 * 只用于测试与本地桩，不进入生产热路径。
 * @param {number} count
 */
export function assertParamBudget(count) {
  if (count > D1_PARAM_LIMIT) {
    throw new Error(`D1 绑定参数超限：${count} > ${D1_PARAM_LIMIT}`);
  }
}