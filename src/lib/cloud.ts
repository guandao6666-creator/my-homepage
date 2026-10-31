/**
 * 云端能力封装（Supabase：Postgres + Auth + Storage）。
 *
 * 全部通过 REST 直接调用，不引入额外 SDK —— 静态站点也能用。
 * 环境变量（在 .env 中配置，PUBLIC_ 前缀会被打包进前端）：
 *   PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
 *   PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
 *   PUBLIC_SUPABASE_BUCKET=blog-media
 *
 * 未配置时站点仍然可用：文章来自本地 Markdown，媒体放在 public/uploads。
 */

export interface CloudConfig {
  url: string;
  anonKey: string;
  bucket: string;
  table: string;
}

const env = import.meta.env as Record<string, string | undefined>;

export function cloudConfig(): CloudConfig | null {
  const url = env.PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return {
    url: url.replace(/\/$/, ""),
    anonKey,
    bucket: env.PUBLIC_SUPABASE_BUCKET?.trim() || "blog-media",
    table: env.PUBLIC_SUPABASE_TABLE?.trim() || "posts",
  };
}

export const isCloudEnabled = () => cloudConfig() !== null;

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number;
}

const STORAGE_KEY = "guandao.blog.session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.accessToken || parsed.expiresAt < Date.now() + 30_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(session: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

async function authRequest<T>(path: string, body: unknown): Promise<T> {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  const res = await fetch(`${config.url}/auth/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.msg || data?.error_description || `登录失败（${res.status}）`);
  }
  return data as T;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: { email?: string };
}

export async function signIn(email: string, password: string): Promise<Session> {
  const data = await authRequest<TokenResponse>("token?grant_type=password", { email, password });
  const session: Session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: data.user?.email ?? email,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  saveSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  const config = cloudConfig();
  const session = loadSession();
  clearSession();
  if (!config || !session) return;
  await fetch(`${config.url}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` },
  }).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export interface CloudPost {
  id: string;
  slug: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  published: boolean;
  featured: boolean;
  pub_date: string;
  updated_at?: string;
  cover_url?: string | null;
}

async function rest<T>(
  path: string,
  init: RequestInit = {},
  session?: Session | null,
): Promise<T> {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  const token = (session ?? loadSession())?.accessToken;
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token ?? config.anonKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`数据库请求失败（${res.status}）${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function listCloudPosts(): Promise<CloudPost[]> {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  return rest<CloudPost[]>(`${config.table}?select=*&order=pub_date.desc`);
}

export function createCloudPost(post: Partial<CloudPost>) {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  return rest<CloudPost[]>(`${config.table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([post]),
  });
}

export function updateCloudPost(id: string, patch: Partial<CloudPost>) {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  return rest<CloudPost[]>(`${config.table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
}

export function deleteCloudPost(id: string) {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  return rest<void>(`${config.table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

export interface CloudComment {
  id: string;
  post_slug: string;
  author: string;
  body: string;
  created_at: string;
  visible: boolean;
  parent_id?: string | null;
}

/** 登录状态下能拿到全部留言（含被隐藏的） */
export function listCloudComments(): Promise<CloudComment[]> {
  return rest<CloudComment[]>("comments?select=*&order=created_at.desc&limit=200");
}

export function deleteCloudComment(id: string) {
  return rest<void>(`comments?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setCloudCommentVisible(id: string, visible: boolean) {
  return rest<CloudComment[]>(`comments?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ visible }),
  });
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export interface UploadResult {
  path: string;
  url: string;
}

/** 上传图片/附件到云存储，返回公开访问地址 */
export async function uploadToCloud(file: File, folder = "uploads"): Promise<UploadResult> {
  const config = cloudConfig();
  if (!config) throw new Error("尚未配置云端环境变量");
  const session = loadSession();
  if (!session) throw new Error("请先登录");

  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  const base = file.name
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .slice(0, 48) || "file";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).slice(2, 8);
  const path = `${folder}/${stamp}-${base}-${random}.${ext}`;

  const res = await fetch(
    `${config.url}/storage/v1/object/${config.bucket}/${encodeURI(path)}`,
    {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${session.accessToken}`,
        "x-upsert": "true",
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`上传失败（${res.status}）${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }

  return {
    path,
    url: `${config.url}/storage/v1/object/public/${config.bucket}/${encodeURI(path)}`,
  };
}
