/**
 * Guandao OS 1.6 · Guandao Community · 图片上传（批次 4）
 *
 * 由 community.ts 的 initCommunity 闭包迁出；通过 CommunityContext 读写外层状态，
 * 发布表单的 DOM 刷新走 ./publish 的 paintPublishAssetsImpl。
 */
import * as api from "../../community/api";
import { paintPublishAssetsImpl } from "./publish";
import type { CommunityContext } from "./context";

export const pickImageImpl = (ctx: CommunityContext, onFile: (file: File) => Promise<void>) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void onFile(file).catch((error) => ctx.toast(error instanceof Error ? error.message : "上传失败"));
    });
    input.click();
  };

export const handleUploadImpl = async (ctx: CommunityContext, file: File, kind: api.UploadKind) => {
    const publishState = ctx.getPublishState();
    try {
      if (!publishState) return;
      ctx.toast("正在压缩并上传图片…");
      const result = await api.uploadImage(file, kind);
      if (kind === "cover") {
        publishState.cover = { id: result.asset.id, thumbId: result.thumb?.id || null };
        publishState.coverChanged = true;
      }
      paintPublishAssetsImpl(ctx);
      ctx.toast("图片已上传");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "上传失败");
    }
  };

export const handleUploadManyImpl = async (ctx: CommunityContext, files: File[], kind: "preview" | "wallpaper") => {
    const publishState = ctx.getPublishState();
    if (!publishState) return;
    const max = kind === "preview" ? 6 : 8;
    const current = kind === "preview" ? publishState.previews : publishState.wallpapers;
    const room = max - current.length;
    if (room <= 0) {
      ctx.toast(`最多上传 ${max} 张`);
      return;
    }
    try {
      ctx.toast(`正在上传 ${Math.min(room, files.length)} 张图片…`);
      for (const file of files.slice(0, room)) {
        const result = await api.uploadImage(file, kind);
        const ref = { id: result.asset.id, thumbId: result.thumb?.id || null };
        if (kind === "preview") {
          publishState.previews.push(ref);
          publishState.previewsChanged = true;
        } else {
          publishState.wallpapers.push(ref);
          publishState.wallpapersChanged = true;
        }
      }
      paintPublishAssetsImpl(ctx);
      ctx.toast("图片已上传");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "上传失败");
    }
  };
