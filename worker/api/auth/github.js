/**
 * GitHub OAuth（Web Application Flow）+ PKCE S256。
 *
 * 只申请 read:user：
 * - 不申请 repo / gist / workflow 等任何仓库权限；
 * - access token 只在服务端内存中使用一次，不写数据库、不返回前端。
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "GuandaoOS/1.5",
    },
    body,
  });

  if (!response.ok) return null;

  const data = await response.json().catch(() => null);
  if (!data || typeof data.access_token !== "string" || !data.access_token) return null;
  return data.access_token;
}

export async function fetchGithubUser(accessToken) {
  const response = await fetch(USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "GuandaoOS/1.5",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) return null;

  const data = await response.json().catch(() => null);
  if (!data || typeof data.id !== "number" || typeof data.login !== "string") return null;

  return {
    id: data.id,
    login: data.login,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : null,
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}
