# Guandao OS 2.0 · 社区 + 应用市场 / 资源安装审计（Part B）

审计对象：`src/lib/os14/community.ts`、`src/lib/community/{api,install,manifest}.ts`、`worker/api/community/*`、`migrations/0009_community.sql`、`src/lib/os14/{appcenter,widgetstore,themes}.ts`、`src/styles/community.css`。
方法：只读逐文件阅读；结论一律以 `文件:行号` 为据；没有读到运行环境（生产 D1 / R2 控制台 / 线上账号）的地方标“无法确认”。文档 `docs/COMMUNITY-1.6.md` 只用于对照宣称，不作为证据。
代码版本：`package.json` 1.9.0 / `src/lib/version.ts:12` = 1.9.0 / `worker/api/version.js` = 1.9.0；但社区模块内仍硬编码 1.6.0（见 §5.4 第 1 条）。

## 1. 功能状态表

状态定义：Implemented = 前后端都真实存在；Tested = `scripts/community-qa.mjs`（51 条断言）**有覆盖**（本次未执行，不代表当前通过）；Partially = 只做了部分路径或缺前端/分页；Broken = 现有代码确实走不通。

| 功能 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| 社区首页（精选/最新/热度/创作者/关注） | Implemented / Tested | `src/lib/os14/community.ts:456-578`；`worker/api/community/handlers.js:316-342`；`scripts/community-qa.mjs:153-157` | 首页 5 个区块全部来自 `getFeed/getCreators/getFollowingFeed`，无写死卡片 |
| 发现 / 分类 / 5 种排序 | Implemented | `community.ts:584-632`；`worker/api/community/store.js:31-43`（`popular/downloads/favorites/likes/trending`） | 排序 SQL 用真实计数列 |
| 搜索（作品 + 创作者） | Implemented（未自动化） | `community.ts:638-689`；`handlers.js:369-397`；`store.js:180-185`（`LIKE ... ESCAPE`） | 无全文索引，量大会慢（文档也承认） |
| 创作者目录 | Implemented / Tested | `community.ts:695-733`；`store.js:437-494` | 只列出“有已发布作品且 visibility=public”的账号（`store.js:438-444`） |
| 创作者主页（作品集/关注/统计/举报） | Implemented（未自动化） | `community.ts:735-802`；`handlers.js:408-460`；`write.js:1285-1316` | 作品集只取第 1 页，前端没有分页（`community.ts:796`，`api.getCreator` 的 page 从未传） |
| 关注 / 关注动态 | Implemented / Tested | `community.ts:3007-3030`；`write.js:1285-1316`；`community-qa.mjs:263-266` | 数据库主键约束防重复关注（`0009_community.sql:299-305`） |
| 主题市场 | Partially Implemented | `community.ts:412-415, 584-632, 600-603` | 没有独立“市场”模块，只是发现页的 `type=theme` 筛选；无榜单、无合集、无评分 |
| 组件市场 | Partially Implemented | `community.ts:412-415`；`community.ts:1342-1354` | 同上；详情只有参数/权限文字，没有实时组件预览 |
| 工作空间分享 | Implemented（未自动化） | `community.ts:1670-1682`；`workspaces.ts:525-610`；`install.ts:228-246` | 发布时用 `captureCurrentWorkspace` 生成配置；导入前写保护性快照（`workspaces.ts:514-520`） |
| 壁纸市场 / 壁纸安装 | Implemented（未自动化） | `community.ts:2490-2505`；`install.ts:262-296`；`os13.ts:667-673` | 走本机现有壁纸引擎，不新建存储 |
| 教程 | Implemented | `community.ts:1122-1123, 1689-1690`；`worker/api/community/validate.js:448-457` | 只读，正文先转义再 Markdown（`community.ts:1177`） |
| 点赞 | Implemented / Tested | `community.ts:1977-2006`；`write.js:1060-1072`；`community-qa.mjs:233` | 不能给自己点赞（`write.js:1063`），计数用 `COUNT(*)` 重算（`store.js:744-754`） |
| 收藏（含收藏夹） | Implemented / Tested | `community.ts:2008-2053`；`write.js:1082-1105`；`community-qa.mjs:239-241` | 收藏为私人数据，只能通过 `/me/favorites` 读（`write.js:1375-1380`） |
| 评论 + 两层回复 | Implemented / Tested | `community.ts:1250-1316`；`write.js:1130-1207`；`community-qa.mjs:248-257` | 三层会被拒（`write.js:1147`）；垃圾词/链接数过滤（`write.js:1116-1128`） |
| 举报（作品/评论/用户） | Implemented（仅作品有自动化） | `community.ts:2203-2227`；`write.js:1238-1283`；`community-qa.mjs:280-295` | 同一举报人同一目标唯一（`migration:329`），重复举报 409（`write.js:1276-1281`） |
| 通知 | Partially Implemented | `community.ts:851-889, 872`；`api.ts:530-531`；`write.js:1477-1494` | “全部已读”可用；单条通知渲染了 `data-notif` 但没有任何点击处理，逐条已读后端有、前端没接 |
| 审核后台（队列/举报/用户/设置/邀请/审计） | Implemented / Tested | `community.ts:1734-1947`；`worker/api/community/admin.js:51-728`；`community-qa.mjs:288-377` | 队列与举报列表前端只显示第 1 页（`community.ts:1750, 1787` 调用时未传 page，后端支持，`admin.js:55, 253`）；用户搜索后端支持 `q`（`admin.js:427`），前端没有搜索框（`community.ts:1828`） |
| 版本管理（发新版本/历史/回退） | Implemented（回退未自动化） | `community.ts:1120-1131, 1218-1231, 2263-2296`；`write.js:947-1023`；`store.js:243-262` | 服务端强制版本递增（`write.js:968-970`）；但“安装旧版本”UI 在详情页只对作者/审核员显示（`community.ts:1226`），已安装列表的“版本 / 回退”对所有人显示（`community.ts:1031, 2285-2296`），同一能力两套门禁 |
| 发布中心（草稿/提交审核/撤回/删除/编辑信息） | Implemented（未自动化） | `community.ts:1399-1728, 3099-3187`；`write.js:414-604, 610-945` | 默认 `require_review=1`（`migration:26`），管理员可直发（`write.js:475-479`） |
| 已安装资源管理（检查更新/更新/回退/重应用/卸载） | Implemented（未自动化） | `community.ts:1006-1040, 2263-2348`；`install.ts:70-103, 380-413` | 记录存 `localStorage`（`install.ts:47`），并派发 `guandao:community-change`（`install.ts:85`） |
| 插件市场入口 | Broken（重复导航） | `community.ts:306-307`（`plugins` 写了两遍）；`community.ts:400-407`（同样的 `if` 写了两遍） | 侧栏会渲染两个“插件市场”按钮；点击后 `ctx.openApp("pmarket")` 切到另一个应用 |
| 审核员“设为精选”/“审核自己作品”按钮 | Broken（越权按钮） | `community.ts:1157-1158, 1774` vs `admin.js:110-117, 224-225` | 精选仅 admin（`admin.js:225`），审核自己的作品被拒（`admin.js:115-117`）；前端对 moderator 仍渲染按钮，点了才 403 |
| 评分 / 短动态 / 私信 / 实时聊天 | Not Implemented | `docs/COMMUNITY-1.6.md:24, 331-332` | 前后端都没有对应表与接口 |
| “安装预览”动作 | Deprecated / 死代码 | `community.ts:2804-2805`（`case "install-post-preview": break;`） | 空分支，无任何入口 |

## 2. 数据真实性核查

### 2.1 逐项来源

| 展示内容 | 来源 | 证据 | 说明 |
| --- | --- | --- | --- |
| 首页 5 类作品数 | 真实 API（D1 COUNT） | `handlers.js:268`；`store.js:781-788`（`overviewCounts`：`status='published' GROUP BY post_type`） | 真实发布数，不是安装数 |
| 编辑精选 | 真实 API（`featured_at`） | `store.js:186`；`admin.js:224-243` | 仅管理员可设，未精选时区块不渲染（`community.ts:497-504`） |
| “真实热度”榜 | 真实计数 + 时间衰减 SQL | `store.js:39-43` | 公式用 like/favorite/comment/download/view，全部是库内计数 |
| 安装数（`downloadCount`，详情页与卡片“⤓”） | 真实字段，但**统计口径错误** | `api.ts:354-358`（`count` 默认 `true`）→ `handlers.js:555-557` 自增；`community.ts:1061` 详情页每次打开都调 `fetchVerifiedPackage`；`install.ts:358` 安装时再调一次 | 只要打开详情页（或进入“发布新版本”页 `community.ts:1411`）`download_count` 就 +1，安装再 +1。因此“安装最多”排序（`store.js:35`）与“安装”数字被浏览行为灌水。这是本次审计最实质的数据失真 |
| 浏览数 | 真实 API，但无服务端去重 | `community.ts:1071-1081`（仅 `sessionStorage` 去重）；`write.js:1044-1057`（无条件 +1） | 换标签页/新会话/直接调接口都会累加；不记录 IP、设备（`migration:377-388`） |
| 点赞 / 收藏 / 评论计数 | 真实 API（写后 `COUNT(*)` 重算） | `store.js:744-754`；`write.js:1069, 1077, 1094, 1158` | 没有前端自增，接口返回重算后的值 |
| 评论数（详情页标题） | 真实但口径与卡片不同 | `store.js:374-379` 只数一级评论；`store.js:749` 的 `comment_count` 数所有 visible（含回复） | 卡片显示含回复，详情“评论（N）”只含一级，两处会不一致 |
| 作者 / 头像 / 头衔 | 真实 API（`users` + `community_profiles`） | `store.js:24-27, 60-71`；`common.js:195-204`（同名 `mapAuthor` 的重复实现） | 不返回 email / github 数字 ID |
| 创作者“获赞/安装/关注者” | 真实 API（SUM/COUNT） | `store.js:410-435` | “安装”继承上面的 download 灌水 |
| 封面 / 预览 / 壁纸图片 | 真实 R2，经私有媒体接口 | `store.js:45-58`；`handlers.js:584-638` | 只有 `status='published'` 的作品媒体才公开（`handlers.js:597-614`） |
| 详情页主题预览大图 | **本地静态资源**，不是作者上传图 | `community.ts:1326`（`/wallpapers/thumbs/${wall}.webp`） | 只是按 manifest 的壁纸 ID 套内置缩略图；ID 非法时回退 `aurora`（`community.ts:149-152`） |
| 社区名称 / 公告 / OS 版本 | 真实 API（`community_settings`） | `handlers.js:287-309` | OS 版本返回 1.6.0（`validate.js:16`），与系统 1.9.0 不一致，首页照抄显示（`community.ts:474`） |
| 首页公告为空时的文案 | 前端兜底文案 | `community.ts:476` | 营销句，不是接口数据 |
| 审核后台概览（账号/作品/待审/举报/存储） | 真实 SQL | `admin.js:715-728`；`store.js:657-677` | 存储字节 = 图片 + 内容包 |
| 邀请码列表 | 真实 API，仅前缀 | `admin.js:621-646`（`code_prefix`）；`0009_community.sql:78-89` | 明文只在创建时返回一次（`admin.js:679-687`） |
| 应用中心“热门应用” | 本地 `localStorage` 打开次数 | `appcenter.ts:37-45, 290, 309-312` | 文案已声明“按这台设备上的打开次数排序”，诚实 |
| 应用中心的应用版本/作者/体积/更新日志 | 前端硬编码 | `catalog.ts:61-110`（community 条目）、`catalog.ts:680-698`（安装态默认值） | 没有远程应用目录，全部是编译进包里的元数据 |
| 主题中心“十套主题” | 前端硬编码 | `themes.ts:55-268`（实际 10 个 `id`） | 数量属实，无下载/收藏数展示 |
| 组件中心（分类/数量/描述） | 前端硬编码 | `widgetstore.ts:987-993`；`widgetstore.ts:1470-1490` | 无热度数据 |
| 插件市场安装/下载统计 | 真实 API（插件后端） | `src/lib/plugins/market.ts:151, 386-387` | 属 Part C 范围，本次未逐行核对 |

### 2.2 是否有“伪造”行为

- **没有种子作品/假作者**：全仓检索 `INSERT INTO community_posts|community_profiles|community_likes|...` 只命中写接口自身（`write.js:492, 1065, 1088, 1153`；`common.js:184`；`admin.js:363, 509`），迁移里没有 demo 数据；`community.ts/api.ts/install.ts` 里没有 `Math.random` 造计数，唯一的 `Date.now().toString(36)` 用于生成 `packageId`（`community.ts:1605`）。
- **没有前端硬编码点赞/评论/用户**：所有卡片计数都来自接口字段（`community.ts:193-223`）。
- **但存在三处“名不副实”**：
  1. `download_count` 被“打开详情页”灌水却对外叫“安装”（见上表），属于**统计口径失真**，不是随机伪造。
  2. manifest 里的 `author` 由客户端填写（`community.ts:1613`），服务端只做 40 字截断、不与账号绑定（`validate.js:478`）。页面显示的作者取自数据库（`store.js:24`），所以“社区页作者”真、“内容包内作者”可伪造成 `Guandao Studio`。
  3. “从当前桌面生成”会把**当前主题**（可能是别人发布的社区主题）原样重新打包（`community.ts:1628-1650`），许可证/署名随发布者走，存在二次发布风险；服务端不比对来源。

### 2.3 宣称与实现的差异（docs 仅对照）

| 文档宣称 | 实际 | 证据 |
| --- | --- | --- |
| “所有数据来自 `/api/community/*`，没有任何写死的点赞、评论或用户”（`community.ts:4-6`） | 计数确实都来自接口，但 `download` 口径错误；主题预览图是静态资源 | `api.ts:354-358`；`community.ts:1326` |
| “兼容性在发布、审核、下载、安装四层检查”（`docs:216`） | 客户端与服务端都调用了检查函数，但两边基线版本不同：服务端停在 1.6.0，客户端是 1.9.0 | `manifest.ts:104-118`；`validate.js:16, 183-188` |
| “组件不能读取未声明权限的数据”（`docs:260`） | 只有天气/音乐组件检查了 `permissions`，其余组件不使用外部数据也没有强制检查 | `widgetstore.ts:1328, 1360` |
| “私密：只有自己和审核员能打开”（UI 文案 `community.ts:992`） | 只隐藏创作者主页，作品仍会出现在首页/发现/关注流 | `handlers.js:415-417`；`store.js:163`（列表不按作者可见性过滤） |
| “Community API 端到端 QA 51/51 通过”（`docs:272`） | 脚本存在且正好 51 条断言，但依赖手工准备的两个本地账号与固定 Cookie，**不在 `npm test` 里**，也不覆盖 UI/非主题类型的安装 | `community-qa.mjs:5-17, 22-25`；`package.json:37` |

## 3. 安装链路时序

### 3.1 从点击“安装”到生效（主题为例，其它类型同构）

```
用户点击 [data-action=install]           community.ts:2484-2485
  └─ installFlow()                       community.ts:2055
       1. 读 detailCache.manifest（详情页已在 community.ts:1061 下载并校验）
       2. compatibilityCheck(manifest.compatibility)     community.ts:2063 → manifest.ts:104
       3. modal() 展示作者/版本/许可证/将要改动的项       community.ts:2083-2096
       4. installFromServer(post, ctx, {applyTheme})      install.ts:350
            ├─ fetchVerifiedPackage(post.id, version)     api.ts:626
            │    ├─ getPackage → GET /api/community/posts/:id/package?count=1   api.ts:354
            │    │    └─ packageHandler                  handlers.js:539
            │    │         ├─ loadPost 可见性闸门         common.js:118
            │    │         ├─ getPackageForPost (当前版/指定版)  store.js:264-301
            │    │         ├─ R2 get(pkg.packageKey)      handlers.js:547
            │    │         ├─ 服务端 SHA-256 对比库内 checksum   handlers.js:550-553
            │    │         ├─ count=1 时 download_count++  handlers.js:555-557
            │    │         └─ 返回 packageJson 文本        handlers.js:559-570
            │    └─ 客户端 SHA-256(packageJson) === response.checksum  api.ts:630-634
            ├─ compatibilityCheck(packageFile.compatibility)  install.ts:369
            └─ installManifest(post, manifest, ctx, opts)     install.ts:302
                 ├─ compatibilityCheck + validateManifestClient  install.ts:308-314
                 ├─ theme     → installTheme                     install.ts:144
                 │               normalizeTheme                  themes.ts:474
                 │               saveCustomTheme                 themes.ts:522
                 │               可选 applyTheme                 themes.ts:348
                 ├─ widget    → installWidget                    install.ts:201
                 │               installCommunityWidgetInstance  widgetstore.ts:1444
                 │               ctx.widgets.register/setEnabled/stack
                 ├─ workspace → installWorkspace                 install.ts:228
                 │               importCommunityWorkspace        workspaces.ts:525
                 │               makeSnapshot（导入前快照）      workspaces.ts:514
                 ├─ wallpaper → getPost → installWallpaperAsset  install.ts:326-329, 262
                 │               fetch(asset.url) → GOS13.importWallpaperFromBlob  os13.ts:2393
                 └─ 成功 → saveRecord（localStorage + 事件）     install.ts:334-346, 93-97
       5. 成功弹窗 / toast，再 loadDetail 刷新               community.ts:2098-2112
```

其它入口：更新 `checkUpdate`（`install.ts:401`）→ `doUpdate`（`community.ts:2338`）→ 同一个 `installFromServer`；回退 `handleInstalledAction("rollback")`（`community.ts:2285`）→ `installVersion`（`community.ts:2115`）→ `installFromServer(...,{version})`；卸载 `uninstallByPost`（`install.ts:380`）→ 四个系统各自的删除函数（`themes.ts:531` / `widgetstore.ts:1457` / `workspaces.ts:612` / `os13.ts:2394`）。

### 3.2 校验矩阵

| 校验项 | 是否校验 | 在哪校验 | 证据 |
| --- | --- | --- | --- |
| Manifest 结构（类型/字段/范围） | 是，双层 | 发布时服务端严格白名单；安装时客户端预检 | `validate.js:463-535`（`strictKeys` + 禁止执行字段 `validate.js:63, 99-113`）；`manifest.ts:124-183`（较弱：不查未知字段） |
| 类型一致性 | 是 | 服务端按作品类型校验配置；客户端 `expectedType` | `validate.js:502-506`；`manifest.ts:137`；`install.ts:311` |
| 版本号 | 是 | semver 解析；发布强制递增；安装按请求版本取包 | `validate.js:155-169`；`write.js:244-246, 968-970`；`store.js:282-301` |
| 兼容性 | 是，但基线不一致 | 客户端用 1.9.0，服务端 `OS_VERSION=1.6.0` | `manifest.ts:104-118`；`validate.js:16, 183-188`；后果：声明 `minimum:1.7.0` 的内容客户端认为可装、服务端发布时判 409（`write.js:469-470, 840`） |
| 来源 | 仅同源 | 包只从 `/api/community/posts/:id/package` 取；壁纸从 `asset.url` 取 | `api.ts:354-358`；`install.ts:271`。**但 `mediaUrl()` 这个“只允许 /api/community/media/ 前缀”的守卫从未被调用**（`api.ts:613-616`），`installWallpaperAsset` 直接用 `asset.url` |
| 哈希 | 是，双算但同源 | 服务端算后再算客户端；没有签名/公钥，checksum 与内容同响应下发 | `handlers.js:550-553`；`api.ts:626-634`。防传输/存储损坏可以，防“服务端被改”不行 |
| 媒体完整性 | 否 | 图片没有 checksum，只有 mime/尺寸白名单与服务端嗅探 | `validate.js:604-628`；`handlers.js:624-631` |
| 权限声明 | 只展示，不强制确认 | 安装弹窗列出 `permissions`，没有类似插件市场的授权步骤 | `community.ts:2074, 2098`；对照插件 `plugins/market.ts:211`（`requestPermissions`）；运行时仅天气/音乐读权限（`widgetstore.ts:1328, 1360`） |
| 作者/许可证 | 展示，不校验归属 | 许可证枚举校验；作者不绑定账号 | `validate.js:480-483`；`community.ts:2086` |

### 3.3 是否有统一安装入口

**没有。当前有 5 条互不复用的安装链：**

1. 社区资源：`installFromServer` → `installManifest`（`install.ts:302-378`），内部再分派到 4 个系统。
2. 应用中心：`sysRef.install(id)` → `system.ts:111`（只登记内置应用，无网络、无 manifest）。
3. 插件市场：`registry.installFromMarket` / `installOfficialPlugin`（`plugins/registry.ts:276, 258`）→ `verifyBundle`（`plugins/bundle.ts:40`）→ iframe 沙箱。
4. 主题中心导入 JSON：`importThemeFile` → `normalizeTheme` → `saveCustomTheme`（`themes.ts:545-559`）。
5. 壁纸引擎本地上传：`os13.ts` 的 `importWallpaper`（`os13.ts:667-673` 间接调用）。

社区内部是统一的（`installManifest` 一个入口 + `uninstallByPost` 一个出口），但跨商店没有抽象层；四种资源各自 `localStorage` 记录：`guandao.community.installs.v1`（`install.ts:47`）、`guandao.plugins.v1`（`plugins/store.ts:16`）、`guandao.os14.apps.v1`（`catalog.ts:680`）。

## 4. 隐私边界

**结论：没有发现“私人笔记/日历/文件/备份默认发布到社区”的代码路径，也没有把本地 IndexedDB 数据上传到社区的路径。** 证据与边界如下。

1. 客户端只有 3 个文件会碰社区接口：`src/lib/community/api.ts`（53 处）、`src/lib/os14/community.ts`（4 处）、`src/lib/account/client.ts`（1 处，仅读 `/api/community/meta` 判角色）。全仓 `src/` 检索 `/api/community` 的结果就是这三处，`notes/calendar/drive/backup/files` 模块没有任何社区上传代码。
2. 上传只有“用户在选择器里挑的图片”：`uploadImage`（`api.ts:411-455`）、封面/预览/壁纸三个 `<input type=file>`（`community.ts:1487-1495`）、头像/主页封面（`community.ts:2787-2803`）。没有 `idb.get` / `openDb` 参与社区上传（`community.ts` 全文无 `idb` 调用）。
3. 社区资源安装只“下载”不“上传”：`installWallpaperAsset` 是 `fetch → Blob → 本机 IndexedDB`（`install.ts:271-278`）；工作空间导入只写 `localStorage`（`workspaces.ts:598-600`）。
4. 工作空间的“从当前桌面生成”确实会采集桌面信息：`captureCurrentWorkspace` 会读窗口几何/应用集合/组件布局（`workspaces.ts:470-490`），但发布时只挑 `name/description/themeId/wallId/dock/shortcuts/openApps/widgets/dnd` 八个字段（`community.ts:1672-1682`），窗口几何被丢弃；服务端 `strictKeys` 也只允许这八个字段（`validate.js:381`）。**风险等级：中低** —— 公开的是“你常用哪些应用、程序坞顺序、组件布局、当前主题”，属于行为偏好，不是笔记/日历内容。
5. 默认可见性是 `public`（发布表单默认选中，`community.ts:1474`；服务端缺省也是 public，`write.js:433`）。工作空间/组件这类“从我的桌面生成”的内容如果不手动改“不公开列出”，默认会进公开列表。**这是默认值层面的隐私债**，建议 2.0 对 workspace 默认 `unlisted`。
6. 私密主页的边界不完整：`visibility='private'` 只拦创作者主页（`handlers.js:415-417`），作品列表不按作者可见性过滤（`store.js:163` 的 WHERE 里没有 `pr.visibility`），头像/封面只要被任何 profile 引用就公开（`handlers.js:603-610`，未判断 profile 是否 private）。UI 文案“只有自己和审核员能打开”（`community.ts:992`）超出了实际能力。
7. 草稿/待审媒体是安全的：媒体可见性由“所在作品 status”决定，猜 UUID 也拿不到未发布封面（`handlers.js:595-614`）。
8. 通知只存摘要：评论通知 payload 只有 `postTitle` 和 `excerpt`（`write.js:1169`），不存 Session/IP；浏览只按 `(post_id, day)` 聚合（`migration:377-388`）。
9. 注销账号会删 `users/{userId}/community` 整个 R2 前缀（`worker/api/privacy/handlers.js:1285-1290`）；但**数据导出不含社区作品正文**（`docs:336` 承认，`privacy/handlers.js` 的导出范围里也没有 community 表），这是“删除有、可携带无”的不对称。
10. 第三方网络请求：装一个 `weather` 社区组件会让浏览器以 `credentials: "omit"` 请求 `api.open-meteo.com`，并把作品里写的城市坐标发出去（`widgetstore.ts:1337-1340`）。这不受社区后端控制，安装前也没有单独的网络提示（只在权限列表里写“通过网络获取天气”，`validate.js:308`）。
11. 社区仓库/构建产物里没有把本地数据写进 manifest 的代码；manifest 仅来自用户表单、当前主题/桌面快照或用户导入的 JSON（`community.ts:1597-1700`、`2860-2885`）。

## 5. 技术债

### 5.1 `community.ts` 巨型单文件（3348 行 / 171 KB）

| 区块 | 行范围 | 约行数 | 子系统 |
| --- | --- | --- | --- |
| 文件头 + import + 类型 + 常量 | 1-143 | 143 | 5 种类型标签、状态、角色、举报原因、排序 |
| 渲染小工具（卡片/导航/骨架/登录门/进度条/chips） | 145-288 | 144 | 展示层组件库（未抽出） |
| `renderCommunity` | 294-330 | 37 | 外壳 + 13 个导航项（含 1 个重复） |
| `initCommunity` 状态与通用工具 | 332-450 | 119 | meta 缓存、视图状态、并发令牌、登录门 |
| 首页 | 456-578 | 123 | 5 个数据源 + 营销区块 |
| 发现 / 搜索 | 584-689 | 106 | 列表、筛选、排序、分页 |
| 创作者目录 / 主页 / 关注 | 695-823 | 129 | 3 个页面 |
| 收藏 / 通知 | 829-909 | 81 | 私人列表 + 通知渲染 |
| 我的作品 / 资料 / 已安装 | 915-1045 | 131 | 3 个 tab + 用量 |
| 作品详情 / 评论 / 预览面板 | 1051-1380 | 330 | 详情、评论树、3 种预览面板 |
| 发布 / 编辑 / 新版本表单 | 1386-1728 | 343 | 4 类表单 + manifest 生成器 |
| 审核中心 | 1734-1947 | 214 | 6 个 tab |
| 互动与安装动作 | 1952-2348 | 397 | 点赞/收藏/安装/更新/回退/卸载/举报/审核/编辑/删除/撤回 |
| 事件代理（2 个 click + change + submit + keydown） | 2363-3317 | 955 | 约 60 个 action 分支 |
| 启动与清理 | 3327-3347 | 21 | 引导 + 事件解绑 |

一句话：一个文件同时是“路由 + 页面 + 表单引擎 + 安装器 UI + 管理后台 + 事件总线”。

### 5.2 重复模块化卡片 / 弹窗代码

- 作者行/头像+名字+角色徽章重复 4 份：卡片 `community.ts:204-208`、首页创作者行 `community.ts:533-538`、搜索创作者 `community.ts:672-676`、创作者卡 `community.ts:715-725`。
- 评论项重复 2 份：一级 `community.ts:1265-1305`，回复内联 `community.ts:1291-1299`（回复没有“回复”按钮、没有回复框）。
- manifest 摘要重复 2 份：发布页 `community.ts:1557-1566` 与版本页 `community.ts:1720` 复用同一函数（这部分还好），但“生成/导入”两套按钮与校验分支各写一遍（`community.ts:2750-2786` vs `community.ts:2850-2891`）。
- 安装入口重复 2 套：`installFlow`（`community.ts:2055`）与 `installVersion`（`community.ts:2115`），后者没有 try/catch。
- 壁纸安装重复 2 条路径：详情主按钮走 `installManifest` 取 `wallpapers[0]`（`install.ts:326-329`），每张图的“下载并应用”走 `installWallpaperAsset`（`community.ts:2490-2505`）；前者永远装第一张。
- 两个 `root.addEventListener("click")`（`community.ts:2363` 与 `2894`）把同一套 UI 动作拆到两个函数里；`[data-tab]`、`[data-post]` 的判定顺序依赖“先注册先执行”，新增 action 时极易漏。
- 三个 `modal()` 菜单/表单模板内联在事件里（`community.ts:2519-2528, 2711-2715, 2288-2294`），样式类 `g14-menu-item` 与 `cx-menu-item` 混用（`community.ts:2291`）。

### 5.3 重复 API 封装

`request<T>()` + `XxxApiError` 在三个模块各写了一份：`src/lib/community/api.ts:215-236`、`src/lib/plugins/api.ts:157-178`、`src/lib/account/client.ts:124`。错误码/超时/重试语义已经开始分叉（社区版把 HTTP 非 2xx 与 `success:false` 合并处理，`api.ts:228-234`）。

### 5.4 事件监听 / 定时器 / 状态

1. **版本号双源**：`validate.js:16` 写死 `OS_VERSION = "1.6.0"`，客户端是 `src/lib/version.ts:12` = 1.9.0；`scripts/check-version.mjs` 只检查 `src/lib/community/manifest.ts` 与 `plugins/registry.ts`，不检查 `worker/api/community/validate.js`，所以 CI 发现不了。QA 脚本还把 `osVersion === "1.6.0"` 断言成“正确”（`community-qa.mjs:150`），等于把 bug 锁死。
2. **全局 1 秒定时器**：`startCommunityTicker` 一旦有社区组件就永久 `setInterval`，每秒遍历所有 `[data-cw-id]` DOM（`widgetstore.ts:1388-1433`）；卸载组件不停止。
3. **永不触发的清理钩子**：天气组件给 widget 元素挂 `guandao:before-close` 来 abort fetch（`widgetstore.ts:1357`），但该事件只在窗口关闭时派发（`src/pages/index.astro:4330`），组件不在窗口里 → `AbortController` 永不 abort。
4. **模块级单例**：`appcenter.ts:34-35` 的 `ctxRef/sysRef`、`themes.ts:565` 的 `ctxRef` 是模块级变量；开两个窗口时后 init 的覆盖前一个的引用（当前 ctx 相同所以暂时无害，但多实例/多工作区会踩）。
5. **社区的清理是干净的**：`initCommunity` 只在 `root`（窗口内元素）上挂 click/change/submit/keydown，窗口关闭后随 DOM 回收；唯一的 `window` 级监听在返回的 cleanup 里解绑（`community.ts:3319-3324, 3343-3346`），而该 cleanup 会被 `index.astro:4765-4772` 存进 `__gosCleanup` 并在关窗时调用（`index.astro:4326-4333`）。所以 community.ts 本身**没有确认的监听泄漏**；泄漏风险集中在 widgetstore。
6. `pickImage` 每次新建一个游离 `<input>` 并挂 change（`community.ts:3043-3052`），未解绑；元素不入 DOM，随闭包回收，影响可忽略。

### 5.5 其它缺陷（按严重度）

1. `download_count` 被详情页灌水（§2.1），影响排序与“安装”展示。
2. 无统一安装入口（§3.3），三套安装记录互不可见。
3. `installFlow` / `installVersion` 没有 try/catch（`community.ts:2055-2120`）：`installManifest` 内部（如 `importCommunityWorkspace` 抛错、二次 `getPost` 失败）会变成未捕获 Promise，用户只看到无反应。
4. 审核队列 / 举报列表忽略后端分页（`community.ts:1750, 1787`），超过 18/18 条后看不到。
5. 评论总数两套口径（§2.1）。
6. `follow` 按钮切换后不刷新关注者数字在创作者卡上的显示（只在 toast 里显示，`community.ts:3018, 3024`），页面重进才更新。
7. 通知点开不置已读（§1）。
8. 死代码/未用导入：`case "install-post-preview"`（`community.ts:2804`）、未使用的 `badge, compareSemver, communityWidgetConfigs, currentWorkspace` 导入（`community.ts:14, 34, 37, 42`）、`api.getMyUsage / mediaUrl / COMMUNITY_EVENT / notifyCommunityChange` 无调用方（`api.ts:398, 613, 644-647`）；`install.ts:85` 又用字符串字面量重复了同一个事件名。
9. 复制粘贴残留：`system.ts:57-64` 与 `136-140` 同一段判断写两遍；`community.ts:306-307`、`400-407` 同样。
10. 测试缺口：`tests/` 里没有任何社区/安装用例；`community-qa.mjs` 只覆盖 theme 类型，workspace/widget/wallpaper/tutorial 安装与全部 UI 无自动化（`community-qa.mjs:76-133` 只造 theme manifest）。
11. 样式：`src/styles/community.css` 3592 行 / 62 KB，466 个选择器、3 条 media query；虽随应用按需加载（`community.ts:12`），但单文件维护成本高，`.cx-*` 与 `.g14-*` 两套命名混用（`community.css` 仅 4 个 `.g14-shell[data-g14=community]` 选择器做桥接）。

### 5.6 前后端能力错位清单（对应问题 5）

- **后端有、前端没接（4 处）**：逐条通知已读（`api.ts:530-531`、`write.js:1477-1494`；UI 只渲染 `data-notif`，`community.ts:872`）；用户搜索（`admin.js:427` 支持 `q`，前端 `community.ts:1828` 不传）；审核队列/举报分页（`admin.js:55, 253` 返回 page，`community.ts:1750, 1787` 固定第 1 页）；`GET /me/favorite-collections`（`handlers.js:200` 有路由，`api.ts` 没有封装，也没调用方）。
- **后端有、前端没有按钮（2 个动作）**：审核 `restore`（`admin.js:114`）、举报处理 `warn_user`（`admin.js:395-406`）。
- **前端有、后端缺失**：未发现。除了空分支 `install-post-preview`（`community.ts:2804-2805`），所有 `data-action` 分支都能在 `handleCommunityRequest` 的路由表里找到落地（`handlers.js:99-255`）。
- **只在 UI 层实现**：未发现。评论、举报、审核的每次写操作都调用真实接口（`community.ts:2567-2627, 2203-2261`），没有“本地假装成功”的分支。
- **有表/类型但无生产者**：通知类型 `like`（`migration:360-362`、`api.ts:183`）在点赞时不产生（`write.js:1060-1072` 只更新计数）。

## 6. 2.0 统一市场方案（增量，不推翻）

### 6.1 原则

- 只新增“路由层 + 适配器 + 统一卡片”，**不改**任何已验证的安装处理器与其校验。
- 保留全部现有 localStorage key 与数据结构；统一市场只做**只读聚合**，不做数据迁移。
- 现有 5 个应用（appcenter / community / pmarket / themes / widgetstore）先变成统一市场的“频道”，入口 URL 与 `ctx.openApp(id)` 不变。

### 6.2 模块边界（新增）

```
src/lib/market/
  types.ts        MarketItem / MarketSource / InstallState / InstallOutcome
  hub.ts          registerSource() + listAll() + installItem() + uninstallItem() + listInstalled()
  adapters/apps.ts       包装 os14/system.ts（内置应用）
  adapters/community.ts  包装 community/install.ts（社区 5 类资源）
  adapters/plugins.ts    包装 plugins/registry.ts（插件）
  adapters/theme-file.ts 包装 os14/themes.ts（JSON 导入/导出）
  ui/cards.ts    从 community.ts:193-223 抽出的唯一卡片渲染器
  ui/market.ts   统一市场外壳（发现/分类/搜索/已安装/更新）
```

`MarketItem` 最小字段：`source`（`"app"|"community"|"plugin"|"theme-file"`）、`id`、`type`、`title`、`author`、`version`、`coverUrl`、`summary`、`installedVersion`、`updateAvailable`、`compat`、`permissions`、`license`、`raw`（保留各源自有的原始对象，供适配器使用）。

### 6.3 适配器 ↔ 复用函数映射（一个都不重写）

| 来源 | 列表 | 安装 | 卸载 | 检查更新 | 复用证据 |
| --- | --- | --- | --- | --- | --- |
| 内置应用 | `CATALOG` | `sys.install(id)` | `sys.uninstall(id)` | `pendingUpdate(id)` | `system.ts:111, 128`；`catalog.ts:743` |
| 社区资源 | `api.getExplore/getFeed` | `installFromServer(post, ctx, opts)` | `uninstallByPost(postId, ctx)` | `checkUpdate(postId)` | `install.ts:350, 380, 401` |
| 插件 | `plugins/api.ts` 列表 | `registry.installFromMarket` / `installOfficialPlugin` | `registry.uninstallPlugin(id, keepData)` | `registry.checkForUpdates` | `plugins/registry.ts:276, 258, 504, 168` |
| 主题 JSON | 本地文件/导出的主题 | `importThemeFile(file)` | `deleteCustomTheme(id)` | — | `themes.ts:545, 531` |

统一安装器签名（新增，内部只做分派与结果归一化）：

```ts
// src/lib/market/hub.ts
export async function installItem(item: MarketItem, ctx: Ctx, opts?: { version?: string; apply?: boolean }): Promise<InstallOutcome>;
```

社区适配器内部**只允许**调用 `installFromServer`，不允许再写一份 manifest/兼容性判断；插件的权限弹窗继续用 `requestPermissions`（`plugins/market.ts:211`），社区的权限展示复用 `meta.widgetPermissions`（`api.ts:93`）+ `detailPermissionText`（`community.ts:287`）。

### 6.4 分阶段落地（每步可独立发布）

1. **抽卡片与列表（纯重构）**：把 `community.ts:193-223` 的 `postCard` 移到 `market/ui/cards.ts`，社区页改为 import；同时把 `appcenter.ts:89-110` 的 `card()` 映射到同一接口（`MarketItem`），不动安装逻辑。
2. **只读聚合“已安装”**：新增 `listInstalled()` 合并三个 key（`install.ts:47` / `plugins/store.ts:16` / `catalog.ts:680`）并统一展示；先只在社区“已安装”页加一个“全部来源”筛选，验证数据一致后再替换页面。
3. **统一入口壳**：新增 `market` 应用，导航 = 发现 / 应用 / 主题 / 组件 / 工作空间 / 壁纸 / 插件 / 已安装；每个频道懒加载现有模块的渲染函数（`renderAppCenter`、`renderCommunity` 的 explore 分支、`renderPluginMarket`），不复制 UI。
4. **入口收敛**：`appcenter`、`pmarket`、`community` 三个应用的“发现”页改为跳 `market` 对应频道；`themes`/`widgetstore` 保留为“管理与应用”页（它们本来就不是商店，`themes.ts:774-782`、`widgetstore.ts:987-993`）。
5. **清理与加固**：删除 `community.ts:306-307` 重复导航与 `400-407` 重复分支；把 `OS_VERSION` 收敛到 `worker/api/version.js`（或新增 `shared/version.js` 供 worker 与前端共用），并让 `check-version.mjs` 校验社区 validate.js。

### 6.5 明确“不改”的清单

`installManifest`、`installTheme`、`installWidget`、`installWorkspace`、`installWallpaperAsset`、`uninstallByPost`、`importCommunityWorkspace`、`installCommunityWidgetInstance`、`normalizeTheme`/`saveCustomTheme`、`GOS13.importWallpaperFromBlob`、`verifyBundle`、`system.install`、`requestPermissions` —— 这些是已经过 QA 或线上验证的处理器（`community-qa.mjs` 覆盖到安装包下载/校验/主题发布路径），统一市场只调用、不内联、不复制。

### 6.6 顺手修的 5 个高性价比缺陷

1. `download` 计数拆成 `count=view` 与 `count=install`：`getPackage` 增加 `count` 参数语义（`api.ts:354`），只有 `installFromServer` 传 `install`（`handlers.js:555` 只在安装时自增）。
2. 社区安装前增加权限确认步骤，直接复用 `requestPermissions` 的 UI 结构（`plugins/market.ts:211`）。
3. 统一 `OS_VERSION`，并把 `community-qa.mjs:150` 的断言改成读版本常量。
4. 修 `installFlow`/`installVersion` 的错误处理（`community.ts:2055, 2115`）。
5. 让 `mediaUrl()`（`api.ts:613`）真正参与 `installWallpaperAsset` 的 URL 校验（`install.ts:271`）。

## 7. 无法确认的点

1. 生产 D1 里社区是否真的“为空/邀请制”、邀请码是否已生成——文档自称（`docs:84, 330`），本地无法验证。
2. R2 bucket 是否真的关闭公共访问（代码只依赖 `FILES` 绑定与 `/api/community/media` 鉴权，`handlers.js:584`）；桶策略在 Cloudflare 控制台，仓库里没有可读配置。
3. 插件市场的 `downloads/installs/rating` 是否全部来自真实行为——`market.ts:151, 386` 只证明前端展示接口值，服务端统计逻辑不在本次范围。
4. 生产环境是否存在 `users.role='admin'` 的账号、`community_settings` 是否被人工改过（默认值只能从 `migration:22-42` 推断）。
5. `community-qa.mjs` 的 51 条断言是否有近期执行记录（脚本不在 `npm test` 链路里，`package.json:37`）。
6. 主题/组件/工作空间/壁纸四类安装的**浏览器内实测**：本次只读代码，未运行 `npm run dev`，无法确认 `ctx.widgets.register` 后组件真实上屏、`applyWorkspace` 的快照恢复体验。
7. 线上是否曾在 1.7/1.8 系统上因 `validate.js:16` 的 1.6.0 基线拒绝过内容包：`scripts/check-version.mjs` 的注释自称修复过同类问题，但当前代码仍存在双源，历史执行结果无法确认。