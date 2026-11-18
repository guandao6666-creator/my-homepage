/**
 * Guandao OS 2.5 · 社区模块类型定义。
 *
 * 从 src/lib/os14/community.ts 原样搬出，字段未做任何改动。
 */
import type * as api from "../../community/api";
import type { PostType } from "../../community/api";
import type { Manifest } from "../../community/manifest";

export type Post = api.CommunityPost;
export type Role = api.CommunityRole;

export type ViewState =
  | { kind: "tab"; tab: string }
  | { kind: "detail"; id: string }
  | { kind: "creator"; id: string }
  | { kind: "search"; q: string }
  | { kind: "publish"; editId?: string; versionOf?: string };

export type AssetRef = { id: string; thumbId?: string | null };

export type PublishState = {
  mode: "create" | "edit" | "version";
  type: PostType;
  postId?: string;
  manifest: Manifest | null;
  manifestError: string;
  cover: AssetRef | null;
  previews: AssetRef[];
  wallpapers: AssetRef[];
  previewsChanged: boolean;
  wallpapersChanged: boolean;
  coverChanged: boolean;
};

/** 详情页缓存（闭包内 `detailCache`）；字段同搬迁前一致 */
export type DetailCache = {
  data: Awaited<ReturnType<typeof api.getPost>>;
  manifest: Manifest | null;
  comments: Awaited<ReturnType<typeof api.getComments>> | null;
  commentsPage: number;
};

/** 新版本发布状态（闭包内 `versionState`） */
export type VersionState = { post: Post; manifest: Manifest | null; baseVersion: string };

/** 审核中心的标签页（闭包内 `moderationTab`） */
export type ModerationTab = "queue" | "reports" | "users" | "settings" | "audit";
