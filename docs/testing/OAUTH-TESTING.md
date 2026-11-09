# OAuth 可重复测试模式（Phase 3.4）

> Phase 3.4 交付物。状态：本地真实 Worker E2E 14/14 通过、`npm run typecheck` 通过；**尚未在生产环境验证**（本阶段不做生产部署）。测试模式默认关闭，生产环境不可用——判据、自动化断言与部署后人工核验步骤见第 7 节，证据等级见第 10 节。

本文档描述 **现在真实存在** 的机制。凡属设计但未实现/未执行的，单独标注「未验证」。

---

## 1. 为什么需要测试模式

改造前，`tests/**` 对认证链路是**零覆盖**：`/api/auth/github` → GitHub 授权页 → `/callback` → Session → `/api/auth/me` 这条主链路没有任何自动化测试。

原因很直接：

| 障碍 | 说明 |
| --- | --- |
| 需要外网 | 授权码兑换要访问 `github.com/login/oauth/access_token`，CI/本地无法稳定复现 |
| 需要真实凭据 | 本地没有 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（`/api/auth/status` 显示 `configured:false`），真实流程走不到 |
| 需要人工授权 | 浏览器登录 GitHub 账号并点「Authorize」，无法无人值守重复执行 |
| 只造 Session 不够 | 直接往 `sessions` 表插 token 只能测下游，无法覆盖 state 校验、PKCE、重复消费、Cookie 属性等回调分支 |

因此需要一个**只在本地/测试环境生效**的开关：让 Worker 在「已设置 env 变量且请求来自本机回环地址」时，把「跳去 GitHub」替换成「跳回自己的 callback」，其余全部流程（state 落库与校验、PKCE verifier、授权码兑换、Session 颁发、Cookie 属性）原样执行。Roadmap 3.4 的验收标准就是「CI 中可跑『回调 → Session → /me』，生产不开启」。

设计目标：

1. 可重复：无外网、无真实 secret、无真实 GitHub 账号；
2. 不碰真实数据：测试身份只落在本地夹具 `qa-p3-*` 行，绝不创建/修改/提权真实账号；
3. **不削弱生产认证**：state 校验、PKCE 生成与持久化、Cookie 属性、限流全部保持原样；测试模式只是「令牌来源」的替身。

---

## 2. 唯一开关：`testMode` 判据

实现：`worker/api/auth/config.js`（第 13、17–25、39–42 行）。

```js
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    // WHATWG URL 会保留 IPv6 的方括号：`http://[::1]:8788/` → `[::1]`
    return LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

const testMode =
  env?.AUTH_TEST_MODE === "1" &&
  isLoopbackOrigin(requestOrigin) &&
  isLoopbackOrigin(origin);
```

三个条件**同时**成立才为 `true`，任何一条不满足（包括异常）都 fail closed 为 `false`：

| 条件 | 含义 | 失败即关闭的原因 |
| --- | --- | --- |
| `env.AUTH_TEST_MODE === "1"` | 只认平台变量，**精确字符串 `"1"`**：未设置、`""`、`"0"`、`"true"`、`"yes"`、`" 1"` 全部为 false | 防止「随手写 true」误开；默认关闭 |
| `isLoopbackOrigin(requestOrigin)` | 浏览器实际访问的 `request.url` origin 必须是回环地址 | 生产域名（`guandao.xin`）永远不命中 |
| `isLoopbackOrigin(origin)` | 派生出的站点 origin（`APP_ORIGIN`，未配置时回退 request origin）也必须是回环地址 | 防「本地 `wrangler dev` 但 `APP_ORIGIN` 指向生产」：此时 `redirect_uri`/state Cookie 都会落到生产域，即便 env 误设为 1 也不进入测试分支 |

补充约束：

- **不接受查询参数、请求头、Cookie、前端开关**。`?test_login=` 只有在 `config.testMode === true` 时才会被读取（`handlers.js:115`），本身不能开启测试模式。
- 回环判断是**整段精确匹配**，不做后缀/子串匹配：`127.0.0.1.nip.io`、`localhost.evil.com` 均返回 false。
- **生产部署从不设置 `AUTH_TEST_MODE`，且生产域名不是回环地址**，所以生产环境 `testMode` 恒为 `false`，测试入口与测试身份兑换在代码层面不可达。

---

## 3. 测试身份链路（服务端写死的 `qa-*` 白名单）

完整链路写在 `worker/api/auth/github.js`，任何一环都不接受「请求方自带的 github_id / login」：

| 环节 | 代码 | 测试模式行为 | 生产行为（`testMode=false`） |
| --- | --- | --- | --- |
| 入口 | `handlers.js:110–145` | 仅 `config.testMode` 时读取 `?test_login=`；值必须匹配 `/^qa-([a-z]+)$/` 且角色在 `{developer,installer,admin,outsider}` 内 | 该分支整体不可达，继续走 `!isOAuthConfigured` → 302 真实 GitHub 授权页 |
| 授权码 | `handlers.js:134–144` | 仍然 `randomToken(32)` 生成 PKCE verifier、写入 D1 state 记录、下发真实 `gauth_state` Cookie；把 `code` 写死为 `qa:<role>`，302 到自己的 callback | 生成同样的 verifier/state，302 到真实 GitHub authorize URL |
| 兑换 | `github.js:77–114` | `testMode` 时只认 `qa:<role>` → 返回进程内令牌 `qa-test-token:<login>`；`qa:` 前缀但角色非法 → 直接 `null`（`oauth_failed`，不联网） | 完全走原 `URLSearchParams + fetch(TOKEN_URL)` 网络逻辑 |
| 取用户 | `github.js:116–120` 起 | `qa-test-token:` 前缀 → 返回 `TEST_PROFILES` 中固定 profile（`github_id` 920000001‥920000004） | 完全走原 `fetch(USER_URL)` 网络逻辑 |

固定身份与本地夹具一一对应（`scripts/e2e-server.mjs` seed，见 `.wrangler/e2e-fixtures.json`）：

| `?test_login=` | GitHub login | `github_id` | 本地用户 id | 角色 |
| --- | --- | --- | --- | --- |
| `qa-developer` | `qa-p3-developer` | 920000001 | `qa-p3-developer` | member |
| `qa-installer` | `qa-p3-installer` | 920000002 | `qa-p3-installer` | member |
| `qa-admin` | `qa-p3-admin` | 920000003 | `qa-p3-admin` | admin |
| `qa-outsider` | `qa-p3-outsider` | 920000004 | `qa-p3-outsider` | member |

测试模式**显式不支持** `mode=join` 与 `reauth=delete`（返回 `test_login_unsupported`），因为它们依赖真实 GitHub 身份与邀请/注销流程。没有管理员时也不会自动放行：仍要求真实的 `INITIAL_ADMIN_SETUP_TOKEN`（长度 ≥ 24，**没有任何默认值**），否则 `setup_disabled`。

---

## 4. 哪些安全逻辑原样保留（没有被测试模式绕过）

| 检查 | 位置 | 测试模式下的状态 |
| --- | --- | --- |
| state Cookie 下发 | `handlers.js:144` | 照发：`HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600`；`Secure` 仍由 origin 是否 https 决定（http 回环不带） |
| state 查询参数与 Cookie 一致性 | `handlers.js:227–229` | **代码零改动**：`if (!code \|\| !state \|\| !cookieState \|\| !timingSafeEqual(state, cookieState))` → `invalid_state` |
| state 一次性消费 | `handlers.js:231–239` | 代码零改动：`getOAuthState`（含过期判断）+ `consumeOAuthState` 原子 `UPDATE … WHERE consumed_at IS NULL` 且要求 `changes === 1` |
| PKCE verifier | `handlers.js:134–138` | 仍随机生成并持久化到 state 记录；callback 兑换时仍传 `codeVerifier` |
| Session 令牌 | `session.js` | 代码零改动：32 随机字节 base64url，DB 只存 `sha256Hex(token)`；Cookie `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` |
| Cookie 属性逻辑 | `cookies.js` | **零改动**：`Secure` 仅当 origin 以 `https://` 开头 |
| 限流 | `ratelimit.js` | 未绕过：auth-start 20 次/分钟、auth-callback 40 次/分钟 |

callback 唯一改动是在 `exchangeCode(...)` 调用处透传一行 `testMode: config.testMode`（`handlers.js:250`）；`testMode=false`（生产）时该参数对兑换逻辑没有影响。

---

## 5. 测试模式不会做的事（实现边界）

1. **不新增/删除/提权账号**：测试身份只能命中已存在的本地 `qa-p3-*` 行；生产 D1 里没有这些行，即便误开也会停在「注销/加入」分支之外。
2. **不返回可复用令牌**：`qa-test-token:` 只存在于 Worker 内存中，交给 `fetchGithubUser` 后即丢弃；不写 D1、不写日志、不进任何响应/Cookie（测试断言见第 9 节）。
3. **不绕过 state / PKCE / 限流**：见第 4 节。
4. **不改变生产分支**：`not_configured`、真实 GitHub authorize URL、真实 token 兑换、真实用户资料抓取全部保留。
5. **不写部署配置**：`--var AUTH_TEST_MODE:1` 只出现在本地脚手架 `scripts/e2e-server.mjs` 的 `wrangler dev` 启动命令里；**没有写进 `wrangler.jsonc`**，也不会进入任何 deploy 产物。
6. **不支持 join / reauth**：测试模式宁可显式报错，也不静默降级成「假身份走真实注册流程」。

---

## 6. 生产后门 8 条路径及对应防护

下表源自 Phase 3.4 的安全审计结论。每条路径都对应本实现的防护与自动化断言：

| # | 后门路径 | 若不防护的后果 | 本实现防护 | 对应测试 |
| --- | --- | --- | --- | --- |
| 1 | **裸 env flag**：只要 set 了环境变量就开测试模式 | 生产误设一个变量，任何人可伪造登录 | 必须同时满足「env 精确 `"1"` + 请求 origin 回环 + 站点 origin 回环」，三缺一关闭；生产域名永不回环 | 「testMode 派生规则」4 个用例 |
| 2 | **遮蔽 `not_configured`**：测试分支放在真实配置检查之前 | 生产未配置 OAuth 时反而进入测试登录，破坏初始化状态机 | 同上：测试分支虽在 `!isOAuthConfigured` 之前，但前提是 `config.testMode`，生产恒 false；生产 origin 下仍返回 `not_configured` 或真实 GitHub 授权页 | 「生产 origin 拒绝测试模式」用例 |
| 3 | **身份取自请求**：从 header/query 直接取 `github_id` 或 `login` | 攻击者一行请求冒充任意用户（含管理员） | 身份只能是服务端 `TEST_PROFILES` 的固定映射；`?test_login=` 仅作白名单 key，且回调 `code` 必须是 `qa:<role>` | 「test_login 只接受 qa-<role> 白名单」「回调 code 被换成 qa:evil」 |
| 4 | **跳过 state / PKCE**：测试入口直接 302 到 callback 或直接发 Session | 登录 CSRF / 会话固定 / 重放 | 入口仍 `createOAuthState` + 下发 state Cookie；callback 的 state 校验与原子消费代码**零改动**；PKCE verifier 仍生成持久化 | 「state 防护」4 个用例 |
| 5 | **夹具自动建 admin**：测试模式为了跑通而自动创建管理员 | 测试身份获得管理员权限；若生产路径复用则提权 | 测试身份只命中 seed 的 `qa-p3-*` 行；无管理员时仍要求真实 `INITIAL_ADMIN_SETUP_TOKEN`；不提供任何建号/提权代码 | 「join / reauth 显式不支持」+ 第 3 节说明（无管理员 → `setup_disabled`） |
| 6 | **Cookie 降级**：测试模式放宽 Secure/SameSite/HttpOnly 方便调试 | 生产监控/配置漂移后 Cookie 被 JS 读取或跨站发送 | `cookies.js` / `session.js` 零改动；测试断言 `HttpOnly`、`SameSite=Lax`、`Path`、`Max-Age` 与生产一致 | 「入口 state Cookie 属性」「正常回调 Cookie 属性」 |
| 7 | **明文 token 泄漏**：测试 token 写 D1/日志/响应 | 攻击者拿到固定令牌直接伪造 Session | `qa-test-token:` 只在内存在用一次，不落库、不返回；测试断言响应头/响应体不含该前缀 | 「正常回调」中的 token 泄漏断言 |
| 8 | **默认 setup token**：为了方便测试给 `INITIAL_ADMIN_SETUP_TOKEN` 一个默认值 | 生产首次初始化窗口被默认值打开，可被接管 | 未改：默认 `""`，长度 < 24 视为无效（fail closed）；测试模式也没有默认值 | 「testMode 派生规则」+ `setup_disabled` 分支 |

---

## 7. 生产环境如何确认测试模式不可用

分三层证据；前两层是**本地实测**，第三层是**部署后人工核验步骤（本阶段未执行）**。

### 7.1 代码判据（静态，可 review）

`worker/api/auth/config.js:39–42` 是唯一开关，生产要同时满足「env = `"1"` + 请求 origin 回环 + 站点 origin 回环」才会开启；生产部署两者都不满足。

配置面核验（本地实测）：

```powershell
# 1) wrangler.jsonc 没有任何 AUTH_TEST_MODE 默认值（无输出）
git grep -n AUTH_TEST_MODE -- wrangler.jsonc

# 2) worker/ 里只有读 env 的门禁，没有赋值/默认值（仅有注释与 config.js:57 的读取）
Get-ChildItem -Recurse -File worker | Select-String AUTH_TEST_MODE

# 3) 开关只出现在本地 e2e 启动命令里（scripts/e2e-server.mjs 为本地脚手架，未纳入版本库）
git status --short scripts/e2e-server.mjs   # → ?? scripts/e2e-server.mjs
```

`wrangler.jsonc` 的 `vars` 只有 `BACKUP_CRON_ENABLED`、`R2_PUBLIC_BASE_URL`、`ACCOUNT_ID`、`DATABASE_ID`、`DATABASE_NAME`，**没有 `AUTH_TEST_MODE`**。

### 7.2 自动化断言（本地真实 Worker 实测）

- 单元级：`authConfig({AUTH_TEST_MODE:"1"}, {url:"https://guandao.xin/api/auth/github"})` → `testMode === false`；
- 单元级：`authConfig({AUTH_TEST_MODE:"1", APP_ORIGIN:"https://guandao.xin"}, loopback 请求)` → `false`；
- 端到端：本地 Worker 加 `Host: guandao.xin` 伪造生产 origin，请求 `?test_login=qa-developer` → 302 到 `http://guandao.xin/?auth_error=not_configured`，**不跳 callback、不发 state Cookie**（本地未配置 OAuth 凭据时的表现；若生产已配置凭据，同一条路径会跳真实 GitHub authorize URL，断言仍要求「不出现 callback、不发 state Cookie」）。

### 7.3 部署后人工核验（设计步骤，未执行）

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://guandao.xin/api/auth/github?test_login=qa-developer'
```

期望结果（二者之一）：

- 已配置 OAuth：`302 https://github.com/login/oauth/authorize?...`；
- 未配置 OAuth：`302 https://guandao.xin/?auth_error=not_configured`。

**任何情况下都不应**出现：`/api/auth/github/callback?code=qa%3A…` 的 `Location`，或 `Set-Cookie: gauth_state=…`（生产 origin 下 `testMode=false`，测试入口不会被读取）。若需要进一步确认部署产物，可执行 `npx wrangler deploy --dry-run` 后检查 bundle 中 `qa-test-token` 仅作为不可达分支存在（**推断，本阶段未执行**）。

---

## 8. 如何运行

前提：本地 8788 端口由 `node scripts/e2e-server.mjs` 启动——它会 `wrangler dev --local` 并在启动命令里注入 `--var AUTH_TEST_MODE:1`（仅本地进程，不写配置、不部署）。**不要直接 `wrangler dev` 跑本 spec 的正例**：`beforeAll` 会探测测试入口并给出明确报错。

```powershell
# 1. 若 8788 未运行，先启动（首次约 60~120s）
node scripts/e2e-server.mjs

# 2. 跑 OAuth E2E（worker project 的 testMatch 已包含 oauth.spec.ts）
npx playwright test --project=worker tests/e2e/oauth.spec.ts

# 3. 同一分钟内反复跑导致 429 时，清本地限流计数
node scripts/e2e-reset-limits.mjs
```

手动探针（PowerShell 5.1 用 `curl.exe`）：

```powershell
curl.exe -sS -o NUL -D - "http://127.0.0.1:8788/api/auth/github?test_login=qa-developer"
# → 302 Location: http://127.0.0.1:8788/api/auth/github/callback?code=qa%3Adeveloper&state=…
#   Set-Cookie: gauth_state=…; Path=/api/auth; SameSite=Lax; HttpOnly; Max-Age=600

curl.exe -sS -o NUL -D - --header "Host: guandao.xin" "http://127.0.0.1:8788/api/auth/github?test_login=qa-developer"
# → 302 Location: http://guandao.xin/?auth_error=not_configured（无 Set-Cookie）
```

注意：

- 本文件的正例依赖 `AUTH_TEST_MODE:1`，**不应在生产地址上运行**；
- 夹具只需 `.wrangler/e2e-fixtures.json` 的 `stage` 为 `accounts` 即可（oauth 用例不依赖插件夹具，`complete` 更稳）；
- 本地未配置 `GITHUB_CLIENT_ID/SECRET` 时 `/api/auth/status` 为 `configured:false`，不影响测试模式正例。

---

## 9. 实测结果（2026-11-07，本地）

| 项目 | 结果 |
| --- | --- |
| `npx playwright test --project=worker tests/e2e/oauth.spec.ts` | **Running 14 tests using 1 worker → 14 passed**（约 1.5s） |
| `npm run typecheck`（`tsc --noEmit`） | **通过，无输出** |
| 入口探针（loopback + `test_login=qa-developer`） | 302 到 `http://127.0.0.1:8788/api/auth/github/callback?code=qa%3Adeveloper&state=…`，下发 `gauth_state`（HttpOnly / SameSite=Lax / Path=/api/auth / Max-Age=600 / 无 Secure） |
| 生产 origin 拒绝探针（`Host: guandao.xin`） | 302 到 `http://guandao.xin/?auth_error=not_configured`，**无 Set-Cookie** |
| 全链路 | 回调 → `/?auth=ok` + `gauth_sid`（HttpOnly / Path=/ / Max-Age=2592000）→ `/api/auth/me` 裸 JSON `authenticated:true`、`user.id=qa-p3-developer` → `POST /api/auth/logout` → `/me` 匿名 |
| state 防护 | 篡改 Cookie / 缺失 query / 缺失 Cookie / D1 无记录 / 同 state 重放 → 全部 `/?auth_error=invalid_state`（重放仅第一次 `auth=ok`） |

14 个用例分布：testMode 派生规则 4、生产 origin 拒绝 1、测试入口与全链路 2、state 防护 3+1（重放）、身份白名单 3。

---

## 10. 证据等级与未验证项

- **本地实测**：上述 14/14、`tsc --noEmit`、两组 curl 探针、本地 D1 夹具下的完整登录/登出链路。
- **未在真实生产环境执行**：本阶段不做生产部署；「生产 origin 拒绝测试模式」是用本地 Worker + 伪造 `Host: guandao.xin` 模拟的（Workerd 用 Host 构造 `request.url`），与生产域名行为等价，但不是对线上实例的探测。
- **设计推断（未实测）**：`wrangler deploy --dry-run` 产物中测试分支不可达的检查；真实 GitHub OAuth 端到端（本地没有真实 client_id/secret，`configured:false`，须在生产/预发验证一次）。
- **明确约束**：任何人在生产/预发环境都**不要**设置 `AUTH_TEST_MODE`；即使误设，`testMode` 也会因生产域名不是回环地址而为 `false`（第 2、7 节）。若误设，删除该变量/Secret 并重新部署即可，本仓库不存在该默认值。