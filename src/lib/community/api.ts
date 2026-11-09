/**
 * Guandao OS 1.6 · Community 客户端 API
 *
 * 只负责同源 fetch、类型与错误封装；权限与校验全部在服务端。
 * 这个模块不会接触 Session Token（HttpOnly Cookie），也不会执行社区内容。
 */

export type CommunityRole = "visitor" | "member" | "moderator" | "admin";
export type PostType = "theme" | "widget" | "workspace" | "wallpaper" | "tutorial";
export type PostStatus = "draft" | "pending_review" | "published" | "hidden" | "rejected" | "deleted";

export type CommunityAuthor = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  creatorTitle: string;
  role: CommunityRole;
};

export type CommunityPost = {
  id: string;
  type: PostType;
  title: string;
  description: string;
  category: string;
  tags: string[];
  license: string;
  licenseNote: string;
  status: PostStatus;
  visibility: "public" | "unlisted";
  version: string;
  compatibility: { minimum?: string; maximum?: string };
  packageId: string | null;
  featured: boolean;
  featuredAt: number | null;
  likeCount: number;
  favoriteCount: number;
  commentCount: number;
  downloadCount: number;
  viewCount: number;
  reportCount: number;
  viewer: { liked: boolean; favorited: boolean; following: boolean };
  author: CommunityAuthor;
  coverUrl: string | null;
  coverThumbUrl: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  moderationNote?: string;
  rightsConfirmed?: boolean;
  draftManifest?: Record<string, unknown> | null;
  favoriteCollection?: string;
};

export type CommunityAsset = {
  id: string;
  kind: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  parentAssetId: string | null;
  sortOrder: number;
};

export type CommunityViewer = {
  id: string | null;
  role: CommunityRole;
  staff: boolean;
  admin: boolean;
  displayName?: string;
  avatarUrl?: string | null;
  visibility?: "public" | "private";
  restriction?: string;
  unreadNotifications?: number;
};

export type CommunityMeta = {
  communityName: string;
  announcement: string;
  osVersion: string;
  registrationMode: "closed" | "invite" | "open";
  requireReview: boolean;
  memberLogin: boolean;
  allowPublishing: boolean;
  counts: Partial<Record<PostType, number>>;
  viewer: CommunityViewer | null;
  unreadNotifications: number;
  licenses: string[];
  categories: Record<PostType, string[]>;
  widgetTypes: string[];
  widgetPermissions: Record<string, string>;
  limits: {
    maxUploadBytes: number;
    maxPostsPerDay: number;
    maxCommentsPerDay: number;
    maxPackagesPerUser: number;
    maxUserStorageBytes: number;
  };
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
};

export type FeedResult = PageResult<CommunityPost> & {
  tab: string;
  viewer: CommunityViewer;
};

export type CreatorProfile = {
  id: string;
  displayName: string;
  bio: string;
  creatorTitle: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  visibility: "public" | "private";
  role: CommunityRole;
  joinedAt: number;
  isSelf: boolean;
  isFollowing: boolean;
  canFollow: boolean;
  canModerate: boolean;
  stats: {
    posts: number;
    likes: number;
    favorites: number;
    downloads: number;
    followers: number;
    following: number;
  };
};

export type CreatorSummary = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  creatorTitle: string;
  bio: string;
  role: CommunityRole;
  postCount: number;
  followerCount: number;
  featuredCount: number;
  joinedAt: number;
  isFollowing: boolean;
};

export type CommunityComment = {
  id: string;
  postId: string;
  parentId: string | null;
  content: string;
  status: "visible" | "hidden" | "deleted";
  canDelete: boolean;
  author: CommunityAuthor | null;
  createdAt: number;
  updatedAt: number;
  replies: CommunityComment[];
};

export type PackageFile = {
  postId: string;
  packageId: string;
  type: string;
  version: string;
  license: string;
  compatibility: { minimum?: string; maximum?: string };
  checksum: string;
  sizeBytes: number;
  packageJson: string;
  postVersion: string;
};

export type NotificationItem = {
  id: string;
  type: "comment" | "reply" | "post_review" | "post_update" | "follow" | "like" | "moderation";
  actor: { id: string; displayName: string; avatarUrl: string | null } | null;
  postId: string | null;
  postTitle: string;
  postType: PostType | null;
  commentId: string | null;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: number;
};

export type UserUsage = {
  assetCount: number;
  assetBytes: number;
  packageCount: number;
  packageBytes: number;
  postCount: number;
  totalBytes: number;
};

export class CommunityApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "UNKNOWN", status = 0) {
    super(message);
    this.name = "CommunityApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new CommunityApiError("网络请求失败，请检查连接后重试", "NETWORK_ERROR");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new CommunityApiError(
      payload?.error?.message || `请求失败（${response.status}）`,
      payload?.error?.code || "UNKNOWN",
      response.status,
    );
  }
  return payload.data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/* ============================================================
   读取
   ============================================================ */

export const getMeta = () => get<CommunityMeta>("/api/community/meta");

export const getFeed = (params: { tab?: string; type?: string; page?: number; limit?: number }) => {
  const q = new URLSearchParams();
  if (params.tab) q.set("tab", params.tab);
  if (params.type) q.set("type", params.type);
  if (params.page) q.set("page", String(params.page));
  if (params.limit) q.set("limit", String(params.limit));
  return get<FeedResult>(`/api/community/feed?${q.toString()}`);
};

export const getExplore = (params: {
  type?: string;
  category?: string;
  tag?: string;
  sort?: string;
  page?: number;
  limit?: number;
}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, String(value));
  }
  return get<PageResult<CommunityPost> & { typeCounts: Partial<Record<PostType, number>> }>(
    `/api/community/explore?${q.toString()}`,
  );
};

export const getSearch = (params: {
  q: string;
  type?: string;
  category?: string;
  sort?: string;
  page?: number;
  limit?: number;
}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, String(value));
  }
  return get<PageResult<CommunityPost> & { query: string; creators: CreatorSummary[] }>(
    `/api/community/search?${q.toString()}`,
  );
};

export const getCreators = (params: { sort?: string; q?: string; page?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, String(value));
  }
  return get<PageResult<CreatorSummary>>(`/api/community/creators?${q.toString()}`);
};

export const getCreator = (id: string, params: { type?: string; sort?: string; page?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, String(value));
  }
  return get<{
    creator: CreatorProfile;
    featured: CommunityPost[];
    posts: CommunityPost[];
    total: number;
    page: number;
    hasMore: boolean;
  }>(`/api/community/creators/${encodeURIComponent(id)}?${q.toString()}`);
};

export const getPost = (id: string) =>
  get<{
    post: CommunityPost;
    previews: CommunityAsset[];
    wallpapers: CommunityAsset[];
    versions: Array<{
      id: string;
      version: string;
      changelog: string;
      compatibility: Record<string, unknown>;
      checksum: string;
      sizeBytes: number;
      createdAt: number;
      publishedAt: number | null;
    }>;
    package: {
      version: string;
      type: string;
      checksum: string;
      sizeBytes: number;
      license: string;
      compatibility: Record<string, unknown>;
    } | null;
    viewer: CommunityViewer & { isOwner: boolean; canModerate: boolean };
    thumbsByParent: Record<string, string>;
  }>(`/api/community/posts/${encodeURIComponent(id)}`);

export const getComments = (id: string, page = 1, limit = 12) =>
  get<PageResult<CommunityComment> & { viewer: CommunityViewer }>(
    `/api/community/posts/${encodeURIComponent(id)}/comments?page=${page}&limit=${limit}`,
  );

export const getVersions = (id: string) =>
  get<{ versions: Array<{ version: string; changelog: string; checksum: string; sizeBytes: number; createdAt: number; publishedAt: number | null }> }>(
    `/api/community/posts/${encodeURIComponent(id)}/versions`,
  );

/**
 * 读取内容包。
 *
 * 2.0：`count` 默认改为 false。
 * 1.x 默认 true，而每次打开作品详情页都会 fetchVerifiedPackage →
 * download_count 被「浏览详情」灌水，安装数/热门排序都失真。
 * 现在只有真正执行安装时才传 count=true，计数语义 = 安装下载。
 */
export const getPackage = (id: string, version?: string, count = false) => {
  const q = new URLSearchParams();
  if (version) q.set("version", version);
  if (count) q.set("count", "1");
  return get<PackageFile>(`/api/community/posts/${encodeURIComponent(id)}/package?${q.toString()}`);
};

export const getMyCreations = (params: { status?: string; type?: string; sort?: string; page?: number } = {}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
  return get<PageResult<CommunityPost> & { byStatus: Record<string, number> }>(`/api/community/me/creations?${q.toString()}`);
};

export const getMyFavorites = (params: { collection?: string; page?: number } = {}) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
  return get<PageResult<CommunityPost> & { collections: Array<{ name: string; count: number }> }>(
    `/api/community/me/favorites?${q.toString()}`,
  );
};

export const getMyProfile = () =>
  get<{
    profile: {
      id: string;
      displayName: string;
      bio: string;
      creatorTitle: string;
      avatarUrl: string | null;
      coverUrl: string | null;
      visibility: "public" | "private";
      restriction: string;
      createdAt: number;
      role: CommunityRole;
    };
    stats: CreatorProfile["stats"];
    usage: UserUsage;
  }>("/api/community/me/profile");

export const getMyNotifications = (page = 1) =>
  get<{ items: NotificationItem[]; unread: number; page: number; limit: number }>(
    `/api/community/me/notifications?page=${page}`,
  );

export const getMyUsage = () => get<{ usage: UserUsage; limits: CommunityMeta["limits"] }>("/api/community/me/usage");

export const getFollowingFeed = (page = 1) =>
  get<PageResult<CommunityPost> & { page: number; viewer: CommunityViewer }>(
    `/api/community/me/following?page=${page}`,
  );

/* ============================================================
   写入
   ============================================================ */

export type UploadKind = "avatar" | "cover" | "preview" | "wallpaper";

export async function uploadImage(
  file: File,
  kind: UploadKind,
  options: { postId?: string; order?: number } = {},
): Promise<{ asset: CommunityAsset; thumb: CommunityAsset | null }> {
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
    throw new CommunityApiError("只支持 JPG / PNG / WebP / GIF 图片", "UNSUPPORTED_IMAGE");
  }
  if (file.size > 24 * 1024 * 1024) {
    throw new CommunityApiError("图片不能超过 24 MB", "FILE_TOO_LARGE");
  }

  const limits: Record<UploadKind, number> = {
    avatar: 512,
    cover: 1600,
    preview: 1600,
    wallpaper: 3200,
  };
  const max = limits[kind];
  const main = kind === "avatar" ? await resizeImage(file, max, 0.9) : await resizeImage(file, max, 0.88);
  const thumb = kind === "avatar" ? null : await resizeImage(file, 640, 0.8);

  const form = new FormData();
  form.set("kind", kind);
  if (options.postId) form.set("postId", options.postId);
  if (options.order != null) form.set("order", String(options.order));
  form.set("file", main, `upload.${main.name.split(".").pop() || "webp"}`);
  if (thumb) form.set("thumb", thumb, `thumb.${thumb.name.split(".").pop() || "webp"}`);

  const response = await fetch("/api/community/uploads", {
    method: "POST",
    body: form,
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new CommunityApiError(
      payload?.error?.message || "图片上传失败",
      payload?.error?.code || "UPLOAD_FAILED",
      response.status,
    );
  }
  return payload.data as { asset: CommunityAsset; thumb: CommunityAsset | null };
}

async function resizeImage(file: File, max: number, quality: number): Promise<File> {
  if (file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_200_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${name}.webp`, { type: "image/webp" });
  } catch {
    return file;
  }
}

export const createPost = (body: Record<string, unknown>) => post<{ post: CommunityPost; status: string; message: string }>("/api/community/posts", body);
export const patchPost = (id: string, body: Record<string, unknown>) =>
  patch<{ post: CommunityPost; message: string }>(`/api/community/posts/${encodeURIComponent(id)}`, body);
export const deletePost = (id: string) => del<{ deleted: boolean }>(`/api/community/posts/${encodeURIComponent(id)}`);
export const publishPost = (id: string, body: Record<string, unknown> = {}) =>
  post<{ post: CommunityPost; message: string }>(`/api/community/posts/${encodeURIComponent(id)}/publish`, body);
export const withdrawPost = (id: string) =>
  post<{ post: CommunityPost; message: string }>(`/api/community/posts/${encodeURIComponent(id)}/withdraw`);
export const createVersion = (id: string, body: Record<string, unknown>) =>
  post<{ post: CommunityPost; version: string; message: string }>(
    `/api/community/posts/${encodeURIComponent(id)}/versions`,
    body,
  );

export const likePost = (id: string) =>
  post<{ liked: boolean; likeCount: number }>(`/api/community/posts/${encodeURIComponent(id)}/like`);
export const unlikePost = (id: string) =>
  del<{ liked: boolean; likeCount: number }>(`/api/community/posts/${encodeURIComponent(id)}/like`);
export const favoritePost = (id: string, collection = "default") =>
  post<{ favorited: boolean; favoriteCount: number; collection: string }>(
    `/api/community/posts/${encodeURIComponent(id)}/favorite`,
    { collection },
  );
export const unfavoritePost = (id: string) =>
  del<{ favorited: boolean; favoriteCount: number }>(`/api/community/posts/${encodeURIComponent(id)}/favorite`);

export const addComment = (id: string, content: string, parentId: string | null = null) =>
  post<{ comment: CommunityComment; commentCount: number }>(
    `/api/community/posts/${encodeURIComponent(id)}/comments`,
    { content, parentId },
  );
export const removeComment = (id: string) =>
  del<{ deleted: boolean; commentCount: number }>(`/api/community/comments/${encodeURIComponent(id)}`);

export const reportContent = (body: { targetType: string; targetId: string; reason: string; description?: string }) =>
  post<{ reported: boolean; message: string }>("/api/community/reports", body);
export const reportComment = (id: string, reason: string, description = "") =>
  post<{ reported: boolean; message: string }>(`/api/community/comments/${encodeURIComponent(id)}/report`, {
    reason,
    description,
  });

export const followCreator = (id: string) =>
  post<{ following: boolean; followerCount: number }>(`/api/community/creators/${encodeURIComponent(id)}/follow`);
export const unfollowCreator = (id: string) =>
  del<{ following: boolean; followerCount: number }>(`/api/community/creators/${encodeURIComponent(id)}/follow`);

export const viewPost = (id: string) =>
  post<{ viewCount: number; counted: boolean }>(`/api/community/posts/${encodeURIComponent(id)}/view`);

export const updateMyProfile = (body: Record<string, unknown>) =>
  patch<{ profile: Record<string, unknown>; message: string }>("/api/community/me/profile", body);
export const markNotifications = (body: { all?: boolean; ids?: string[] }) =>
  patch<{ unread: number }>("/api/community/me/notifications", body);

/* ============================================================
   管理
   ============================================================ */

export const adminGetQueue = (status = "pending_review") =>
  get<PageResult<CommunityPost> & { byStatus: Record<string, number>; status: string }>(
    `/api/community/admin/queue?status=${encodeURIComponent(status)}`,
  );
export const adminReviewPost = (id: string, action: string, note = "") =>
  post<{ post: CommunityPost; message: string }>(`/api/community/admin/posts/${encodeURIComponent(id)}/review`, {
    action,
    note,
  });
export const adminFeaturePost = (id: string, featured: boolean) =>
  post<{ featured: boolean; message: string }>(`/api/community/admin/posts/${encodeURIComponent(id)}/feature`, {
    featured,
  });

export const adminGetReports = (status = "open") =>
  get<{
    items: Array<{
      id: string;
      reporterId: string;
      reporterName: string;
      targetType: string;
      targetId: string;
      reason: string;
      description: string;
      status: string;
      resolution: string;
      createdAt: number;
      reviewedAt: number | null;
      target: Record<string, unknown>;
    }>;
    byStatus: Record<string, number>;
    status: string;
  }>(`/api/community/admin/reports?status=${encodeURIComponent(status)}`);
export const adminReviewReport = (id: string, action: string, resolution = "", restriction = "limited") =>
  post<{ message: string }>(`/api/community/admin/reports/${encodeURIComponent(id)}/review`, {
    action,
    resolution,
    restriction,
  });

export const adminGetUsers = (q = "") =>
  get<{ items: Array<Record<string, unknown>> }>(`/api/community/admin/users?q=${encodeURIComponent(q)}`);
export const adminSetUserRole = (id: string, role: string) =>
  patch<{ role: string; message: string }>(`/api/community/admin/users/${encodeURIComponent(id)}/role`, { role });
export const adminSetUserStatus = (id: string, status: string) =>
  patch<{ status: string; message: string }>(`/api/community/admin/users/${encodeURIComponent(id)}/status`, { status });
export const adminSetRestriction = (id: string, restriction: string, reason = "") =>
  patch<{ restriction: string; message: string }>(
    `/api/community/admin/users/${encodeURIComponent(id)}/restriction`,
    { restriction, reason },
  );

export const adminGetSettings = () =>
  get<{ settings: CommunityMeta["limits"] & { communityName: string; announcement: string }; raw: Record<string, unknown> }>(
    "/api/community/admin/settings",
  );
export const adminSaveSettings = (body: Record<string, unknown>) =>
  patch<{ settings: Record<string, unknown>; message: string }>("/api/community/admin/settings", body);

export const adminGetInvites = () =>
  get<{ items: Array<Record<string, unknown>>; registrationMode: string }>("/api/community/admin/invites");
export const adminCreateInvite = (body: { label?: string; maxUses?: number; expiresInDays?: number }) =>
  post<{ code: string; maxUses: number; message: string }>("/api/community/admin/invites", body);
export const adminRevokeInvite = (id: string) =>
  del<{ revoked: boolean; message: string }>(`/api/community/admin/invites/${encodeURIComponent(id)}`);

export const adminGetAudit = (page = 1) =>
  get<{ items: Array<Record<string, unknown>>; page: number; limit: number }>(
    `/api/community/admin/audit?page=${page}`,
  );
export const adminGetStats = () => get<{ stats: Record<string, number> }>("/api/community/admin/stats");

/* ============================================================
   工具
   ============================================================ */

export function mediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url.startsWith("/api/community/media/") ? url : "";
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchVerifiedPackage(
  postId: string,
  version?: string,
  count = false,
): Promise<{ file: PackageFile; manifest: Record<string, unknown> }> {
  const file = await getPackage(postId, version, count);
  const digest = await sha256Hex(file.packageJson);
  if (digest !== file.checksum) {
    throw new CommunityApiError("内容包校验失败，已阻止安装", "CHECKSUM_MISMATCH");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(file.packageJson) as Record<string, unknown>;
  } catch {
    throw new CommunityApiError("内容包不是有效的 JSON", "INVALID_PACKAGE");
  }
  return { file, manifest };
}

export const COMMUNITY_EVENT = "guandao:community-change";
export const notifyCommunityChange = (detail: Record<string, unknown> = {}) => {
  window.dispatchEvent(new CustomEvent(COMMUNITY_EVENT, { detail }));
};
