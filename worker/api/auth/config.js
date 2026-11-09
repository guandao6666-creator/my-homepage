/**
 * 认证配置读取。
 *
 * 所有敏感值都来自 Cloudflare Secrets / 本地 .dev.vars，绝不写入仓库。
 * APP_ORIGIN 未配置时回退到当前请求的 origin（GitHub 会校验 redirect_uri，
 * 因此回退不会造成开放重定向）。
 */

/**
 * 初始化密钥的最小长度。
 *
 * 2.0 之前只判断「非空」，一个 4 位密钥也能开启初始化窗口；
 * 配合每 IP 5 次 / 10 分钟的限流，分布式爆破仍然可行。
 * 现在配置强度不足时直接判定为「未开启初始化」，失败关闭（fail closed）。
 */
export const SETUP_TOKEN_MIN_LENGTH = 24;

/**
 * 允许启用 OAuth 测试模式的主机名。
 *
 * 只做「整串精确匹配」，不做后缀或子串判断，避免 `localhost.evil.com`、
 * `127.0.0.1.nip.io` 之类的域名伪装成本机。
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * origin 是否本机回环地址；无法解析时一律视为否（fail closed）。
 */
export function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    // WHATWG URL 会保留 IPv6 的方括号：`http://[::1]:8788/` → `[::1]`
    return LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

export function authConfig(env, request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = (env?.APP_ORIGIN || requestOrigin).replace(/\/+$/, "");
  const setupToken = (env?.INITIAL_ADMIN_SETUP_TOKEN || "").trim();

  /**
   * OAuth 测试模式（Phase 3.4）。默认关闭、失败关闭，必须同时满足三点：
   *
   * 1. 平台变量 `AUTH_TEST_MODE` 精确等于 "1"（未设置 → false；查询参数不参与）；
   * 2. 浏览器实际访问的 request origin 是本机回环地址；
   * 3. 派生出的站点 origin（`APP_ORIGIN` 或 request origin）也是本机回环地址。
   *
   * 第 3 条防的是「本地 wrangler dev 但 APP_ORIGIN 指向生产」：这时 redirect_uri
   * 与 state Cookie 都会落在生产域，即使 env 被误设为 1 也不会进入测试分支。
   * 生产部署从不设置 AUTH_TEST_MODE，而且生产域名不可能命中 loopback 白名单，
   * 因此生产环境 testMode 恒为 false —— 测试入口与测试身份兑换都不存在。
   */
  const testMode =
    env?.AUTH_TEST_MODE === "1" &&
    isLoopbackOrigin(requestOrigin) &&
    isLoopbackOrigin(origin);

  return {
    origin,
    clientId: (env?.GITHUB_CLIENT_ID || "").trim(),
    clientSecret: (env?.GITHUB_CLIENT_SECRET || "").trim(),
    setupToken,
    /** 密钥长度达到下限才认为初始化可用 */
    setupTokenValid: setupToken.length >= SETUP_TOKEN_MIN_LENGTH,
    redirectUri: `${origin}/api/auth/github/callback`,
    /** 仅「env 开关 + 双 loopback origin」同时命中才为 true，见上方注释 */
    testMode,
  };
}

export function isOAuthConfigured(config) {
  return Boolean(config.clientId && config.clientSecret);
}
