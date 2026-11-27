/**
 * 文件 · 深目录递归删除（2.0.4 回归）
 *
 * 背景：`deleteFolderHandler` / `permanentFolderHandler` 早先会把整棵子树的 id 展开进
 * 单个 `IN (?, ?, …)`。D1 单条语句最多 100 个绑定参数，因此节点数 ≥ 99 的目录树
 * 删除会直接 500（用户看到的是「服务内部错误」，且树已被部分改动）。
 *
 * 这里用真实 Worker（wrangler dev + 本地 D1）建一条 120 层的目录链，跑两遍真实路径：
 *   1. 不带 recursive 删除 → 409，且子文件夹计数正确（证明分块 COUNT 生效）；
 *   2. 带 recursive 删除 → 200，再把整组移出回收站（permanent）→ 200。
 *
 * 120 层是有意的：超过 100 参数上限，但仍在 `folders` 表结构与递归 CTE 的承受范围内。
 */
import { expect, test } from "@playwright/test";

import { as, expectStatus, openApi, waitForFixtures } from "./support/worker-api";

const DEPTH = 120;

test.describe("文件 · 深目录递归删除（2.0.4）", () => {
  test(`建 ${DEPTH} 层目录 → 非递归删除 409 → 递归删除 → 永久清空`, async () => {
    const fixtures = await waitForFixtures("accounts");
    const api = await openApi();
    const auth = as(fixtures, "installer");
    let rootId: string | null = null;

    try {
      // 逐层创建，parentId 指向上一层；根目录 parentId 为 null（工作区根）。
      let parentId: string | null = null;
      for (let depth = 0; depth < DEPTH; depth += 1) {
        const created = await api.post("/api/files/folders", {
          headers: { ...auth, "Content-Type": "application/json" },
          data: { name: `deep-${depth}`, parentId },
        });
        const body = await expectStatus(created, 201);
        const id = body?.data?.folder?.id as string | undefined;
        expect(id, `第 ${depth} 层文件夹应有 id`).toBeTruthy();
        if (depth === 0) rootId = id ?? null;
        parentId = id ?? null;
      }
      expect(rootId).toBeTruthy();

      // 1) 非递归删除必须被拒绝，并且计数要穿过整棵子树（> 100 个节点）。
      const refused = await api.delete(`/api/files/folders/${rootId}`, { headers: auth });
      const refusedText = await refused.text();
      expect(refused.status(), `非递归删除应 409，实际 ${refused.status()}：${refusedText.slice(0, 200)}`).toBe(409);
      expect(refusedText).toContain(`${DEPTH - 1} 个子文件夹`);
      expect(refusedText).toContain("FOLDER_NOT_EMPTY");

      // 2) 递归删除：整棵树进回收站（trash_group = 根目录 id）。
      const trashed = await api.delete(`/api/files/folders/${rootId}?recursive=1`, { headers: auth });
      const trashBody = await expectStatus(trashed, 200);
      expect(trashBody?.data).toMatchObject({ trashed: true, files: 0, folders: DEPTH - 1 });

      // 3) 永久删除：这一条语句也是分块的（files + folders 两个 DELETE）。
      const purged = await api.delete(`/api/files/folders/${rootId}/permanent`, { headers: auth });
      const purgeBody = await expectStatus(purged, 200);
      expect(purgeBody?.data?.deleted).toBe(true);
      expect(purgeBody?.data?.files ?? 0).toBe(0);

      // 4) 再删同一个根目录：已经不在了（说明整棵树真的被删空，而不是只删了根）。
      const gone = await api.delete(`/api/files/folders/${rootId}/permanent`, { headers: auth });
      expect(gone.status()).toBe(404);
    } finally {
      // 断言失败时也别把 120 层垃圾留给后续用例：尽力清一次（忽略 404）。
      if (rootId) {
        await api.delete(`/api/files/folders/${rootId}?recursive=1`, { headers: auth }).catch(() => undefined);
        await api.delete(`/api/files/folders/${rootId}/permanent`, { headers: auth }).catch(() => undefined);
      }
      await api.dispose();
    }
  });
});