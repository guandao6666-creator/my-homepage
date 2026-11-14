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

/* ------------------------------------------------------------------ */
/* Phase 3.4 · OAuth 测试模式固定身份（仅本地 E2E 使用）                 */
/* ------------------------------------------------------------------ */

/**
 * 测试模式的完整身份链路，全部写死在服务端：
 *
 *   test_login=qa-<role>  →  entry 生成 `qa:<role>` 授权码
 *                         →  exchangeCode 的 testMode 分支换成 `qa-test-token:<login>` 哨兵
 *                         →  fetchGithubUser 把哨兵映射回下方固定 profile
 *
 * `github_id` 与 `scripts/e2e-server.mjs` seed 的本地 qa-p3-* 行一一对应
 * （920000001..920000004），因此测试登录只会命中这些本地夹具账号；
 * 不存在「请求方自带 github_id / login」的输入通道，也不会创建或修改真实账号。
 *
 * 测试分支只在 `testMode === true` 时生效（见 config.js：env AUTH_TEST_MODE="1"
 * 且请求 origin 与站点 origin 都是 loopback）。生产环境 testMode 恒为 false，
 * 因此 `qa:` / `qa-test-token:` 前缀在生产里永远不会被兑换成身份。
 */
const TEST_CODE_PREFIX = "qa:";
const TEST_TOKEN_PREFIX = "qa-test-token:";
const TEST_ROLES = ["developer", "installer", "admin", "outsider"];

const TEST_PROFILES = {
  developer: { id: 920000001, login: "qa-p3-developer", name: "QA developer", avatarUrl: null },
  installer: { id: 920000002, login: "qa-p3-installer", name: "QA installer", avatarUrl: null },
  admin: { id: 920000003, login: "qa-p3-admin", name: "QA admin", avatarUrl: null },
  outsider: { id: 920000004, login: "qa-p3-outsider", name: "QA outsider", avatarUrl: null },
};

/** `qa-developer` → `developer`；只接受白名单角色，其余返回 null。 */
function testRoleFromLogin(login) {
  if (typeof login !== "string") return null;
  const match = /^qa-([a-z]+)$/.exec(login);
  return match && TEST_ROLES.includes(match[1]) ? match[1] : null;
}

/** 测试入口白名单判断：`test_login` 只能是 `qa-<role>`。 */
export function isKnownTestLogin(login) {
  return testRoleFromLogin(login) !== null;
}

/** `qa:<role>` 授权码 → 测试哨兵 token；非法角色返回 null（不联网、不伪造身份）。 */
function testTokenFromCode(code) {
  if (typeof code !== "string" || !code.startsWith(TEST_CODE_PREFIX)) return null;
  const role = code.slice(TEST_CODE_PREFIX.length);
  if (!TEST_ROLES.includes(role)) return null;
  return `${TEST_TOKEN_PREFIX}${TEST_PROFILES[role].login}`;
}

/** 测试哨兵 token → 固定 profile；非测试 token 一律返回 null，交给真实网络逻辑。 */
function testProfileFromToken(accessToken) {
  if (typeof accessToken !== "string" || !accessToken.startsWith(TEST_TOKEN_PREFIX)) return null;
  const login = accessToken.slice(TEST_TOKEN_PREFIX.length);
  for (const role of TEST_ROLES) {
    const profile = TEST_PROFILES[role];
    if (profile.login === login) return { ...profile };
  }
  return null;
}

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

export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
  testMode = false,
}) {
  // Phase 3.4：测试模式只兑换固定授权码 `qa:<role>`，完全不走网络。
  // 其他任何 code（包括真实 GitHub 回调）都继续走下面的真实网络逻辑；
  // 生产环境 testMode 恒为 false，所以这段分支在生产中不可达。
  if (testMode) {
    const testToken = testTokenFromCode(code);
    if (testToken) return testToken;
    // 形如 `qa:` 但角色不在白名单：直接失败关闭，既不联网也不伪造身份。
    if (typeof code === "string" && code.startsWith(TEST_CODE_PREFIX)) return null;
  }

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

export async function fetchGithubUser(accessToken, { testMode = false } = {}) {
  // 测试哨兵 token 只能由上面 exchangeCode 的 testMode 分支铸造；这里再要求
  // testMode 为真才解析前缀，形成纵深防御：生产环境（testMode 恒为 false）即使
  // 收到一个伪造的 `qa-test-token:` 字符串也不会被当成本地 QA 身份。
  if (testMode) {
    const testProfile = testProfileFromToken(accessToken);
    if (testProfile) return testProfile;
  }

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
