/**
 * 认证配置读取。
 *
 * 所有敏感值都来自 Cloudflare Secrets / 本地 .dev.vars，绝不写入仓库。
 * APP_ORIGIN 未配置时回退到当前请求的 origin（GitHub 会校验 redirect_uri，
 * 因此回退不会造成开放重定向）。
 */

export function authConfig(env, request) {
  const origin = (env?.APP_ORIGIN || new URL(request.url).origin).replace(/\/+$/, "");

  return {
    origin,
    clientId: (env?.GITHUB_CLIENT_ID || "").trim(),
    clientSecret: (env?.GITHUB_CLIENT_SECRET || "").trim(),
    setupToken: (env?.INITIAL_ADMIN_SETUP_TOKEN || "").trim(),
    redirectUri: `${origin}/api/auth/github/callback`,
  };
}

export function isOAuthConfigured(config) {
  return Boolean(config.clientId && config.clientSecret);
}
