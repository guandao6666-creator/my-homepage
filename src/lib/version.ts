/**
 * Guandao OS · 单一版本来源（前端）
 *
 * 1.9 之前版本号散落在 6 个地方，社区清单甚至停在 1.6.0，
 * 导致声明 minimum 1.7/1.8 的社区内容在 1.8 系统上被判为「版本过低」而拒绝安装。
 *
 * 现在前端只从这里取版本号；worker 侧用 worker/api/version.js（JS 无法 import TS），
 * 两边由 scripts/check-version.mjs 在 CI 中强制一致。
 */

export const OS_VERSION = "2.0.6";

/** 对外展示的版本代号 */
export const RELEASE_NAME = "The Platform Era";

/** 中文版本名 */
export const RELEASE_NAME_ZH = "平台时代";

/** 数据导出格式版本（与备份 payload 中的 version 字段一致） */
export const EXPORT_FORMAT = "guandao-os/2.0";

/**
 * 构建信息。
 *
 * `__GUANDAO_BUILD_AT__` 与 `__GUANDAO_BUILD_ID__` 由 astro.config.mjs 的
 * vite.define 在构建时注入真实时间戳；本地开发或单测环境没有注入时
 * 显示「开发环境」，不会编造一个假的构建号。
 */
declare const __GUANDAO_BUILD_AT__: string | undefined;
declare const __GUANDAO_BUILD_ID__: string | undefined;

const injected = (read: () => unknown, fallback: string): string => {
  try {
    const value = read();
    return typeof value === "string" && value ? value : fallback;
  } catch {
    return fallback;
  }
};

export const BUILD_INFO = {
  build: `${OS_VERSION}+${injected(() => __GUANDAO_BUILD_ID__, "dev")}`,
  builtAt: injected(() => __GUANDAO_BUILD_AT__, "开发环境"),
  channel: "stable" as "stable" | "preview",
};

/** 2.0 的更新历史（真实发布记录，供更新中心展示；不抓取伪造数据） */
export const RELEASES: Array<{ version: string; name: string; date: string; notes: string[] }> = [
  {
    version: "2.0.6",
    name: "Shell Proof",
    date: "2026-11-22",
    notes: [
      "社区壁纸标题转义：自定义名字来自别人的作品标题，直接拼进设置页 title/alt/文本就是存储型 HTML 注入",
      "1.x 升级布局快照不再写 0×0 viewport：旧写法会让比例计算放大 1440 倍、窗口被夹到右下",
      "「清空本机数据」真正清空 IndexedDB 壁纸库：原来删的是一个不存在的伪键，且刷新没等清理完成",
      "网格图标拖拽按图标中心选落点：原来用左上角阈值判定，第一个图标恒命中，顺序永远插到最前",
      "强调色「自动」可以恢复：只有显式给色才关闭壁纸主色联动，改材质/圆角不再误关",
      "新增 4 个纯函数模块与 19 条单测、2 条真实浏览器 E2E（注入 + 清空），并跑了负向对照",
    ],
  },
  {
    version: "2.0.5",
    name: "Param Budget",
    date: "2026-11-21",
    notes: [
      "通知「标记已读」按 40 条分块：一条 UPDATE 绑定 now + user_id + N 个 id，N=99 就撞 D1 100 参数上限",
      "插件市场 trending 的近 30 天下载聚合按块查询：候选最多 200 行，候选数 ≥99 时旧实现直接 500",
      "新增 worker/api/sql.js 统一 chunkIds / placeholdersFor，深目录删除与同步分块也改用它，避免三份实现漂移",
      "新增假 D1 强校验绑定参数上限的单测：退回单条 IN 立刻失败（负向对照已跑）",
    ],
  },
  {
    version: "2.0.4",
    name: "Quiet Repairs",
    date: "2026-11-21",
    notes: [
      "同步 applyChange 改为条件写：并发 push 不再各自算同一个 revision 后互相覆盖（丢失更新）",
      "抽奖与「存储告警每天一次」改用本地日，UTC 日在东八区会让本地 00:00–08:00 仍算昨天",
      "≥99 个节点的目录树递归删除/永久删除改为分块执行，不再撞 D1 100 参数上限而 500",
      "新增并发冲突、本地日边界单测，并给深目录删除补真实 Worker E2E（120 层 → 409 → 递归 → 清空）",
      "设备配对领取把状态转换当唯一闸门：两个并发轮询只会签发一枚 Session",
      "失败的备份按前缀清理 R2 半成品，避免 size_bytes 为 NULL 的孤儿对象悄悄累积",
      "同步 push 与文件上传的配额检查改成「写语句内条件子查询 / 先占位再复核」，并发不再能突破 5000 实体、2000 墓碑与 5 GiB 上限",
    ],
  },
  {
    version: "2.0.3",
    name: "Silent Ballot",
    date: "2026-11-21",
    notes: [
      "修复 /sb 同源代理误删 Authorization：Supabase 只看到匿名请求，登录用户写入全部被 RLS 拒绝",
      "议会投票、树洞发帖、社交名片共用这条身份链，代理现在只剥离本站 Cookie，保留 Bearer token",
      "新增真实 Worker + 真实 Supabase 的代理回归用例：带 JWT 报 PGRST301，不带报 42501",
    ],
  },
  {
    version: "2.0.2",
    name: "Hard Evidence",
    date: "2026-11-21",
    notes: [
      "社区审核链补上真实浏览器证据：拒绝、重新提交、通过、隐藏、恢复、撤回都能在界面上走完",
      "审核接口的权限与未知动作分支加了真实 Worker 断言（403 / 400 / 404）",
      "sandbox-origin 用例改为按 iframe name 等待导航，消除 CI 偶发「iframe 未出现」",
      "撤掉「页面级插件安装未入 Playwright」的过期结论（该链路已有实跑用例）",
    ],
  },
  {
    version: "2.0.1",
    name: "Steady Clicks",
    date: "2026-11-20",
    notes: [
      "修复社区搜索结果页点作品卡片打不开详情（分页代理误吞点击）",
      "分页只认带数字 data-page 的按钮，外壳写入的 data-page=\"desktop\" 不再参与判定",
      "详情页增加视图目标校验：旧请求返回后不会覆盖已经打开的新视图",
      "社区 App 重复挂载时先卸载旧实例，一次点击不再触发两套监听",
      "新增社区「搜索 → 点卡片 → 详情」端到端回归用例",
    ],
  },
  {
    version: "2.0.0",
    name: "The Platform Era",
    date: "2026-11-05",
    notes: [
      "统一内核 Guandao Core：启动流程、生命周期、事件总线、错误隔离",
      "应用注册中心与统一 Manifest：应用状态不再靠 UI 伪装",
      "统一权限服务：默认拒绝、逐项授权、审计日志",
      "统一 Window Manager：贴靠 / 分屏 / 工作空间快照与跨设备重算",
      "系统设置（System Center）整合八类设置，改动真实生效",
      "首次启动七步引导：Local / Cloud 模式、个性化、设备、应用与工作空间",
      "更新中心：版本、构建信息、兼容性检查与数据保护检查",
      "应用与资源市场：应用 / 插件 / 主题 / 组件 / 壁纸 / 工作空间的统一入口",
      "1.x 数据迁移：先备份、再迁移、幂等可重试、旧键完全保留",
    ],
  },
  {
    version: "1.9.0",
    name: "Polish Before the Next Era",
    date: "2026-11-04",
    notes: ["按需加载应用", "错误边界与资源回收", "诊断中心与性能实验室", "质量门禁 CI"],
  },
  {
    version: "1.8.0",
    name: "Seamless Experience",
    date: "2026-11-04",
    notes: ["自适应外壳（桌面 / 平板 / 手机）", "PWA 与离线页", "接力与配对"],
  },
];