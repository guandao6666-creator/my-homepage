/**
 * 「我用什么」清单。
 *
 * 想换工具就改这里；每组控制在 3–5 项，条目写「为什么用它」而不是参数表。
 */

export interface UseItem {
  name: string;
  note: string;
  href?: string;
}

export interface UseGroup {
  title: string;
  caption?: string;
  items: UseItem[];
}

export const USES: UseGroup[] = [
  {
    title: "写代码",
    caption: "每天打开时间最长的几个窗口",
    items: [
      { name: "VS Code", note: "主力编辑器。扩展装得不多，尽量让启动保持快。" },
      { name: "Git Bash", note: "终端习惯用 Unix 命令，比 PowerShell 顺手。" },
      { name: "Git", note: "所有项目都进仓库，习惯走命令行，提交信息尽量说人话。" },
      { name: "Node.js 22 LTS", note: "本地构建脚本、同步脚本都靠它跑。" },
    ],
  },
  {
    title: "做网站",
    caption: "这个站就是这几个东西拼起来的",
    items: [
      { name: "Astro", note: "静态输出，页面是纯 HTML + CSS，几乎没有客户端 JavaScript。" },
      { name: "TypeScript", note: "能标类型就标，省得回头靠猜。" },
      { name: "Supabase", note: "文章、评论、点赞、笔记都存在这里，Postgres 加行级安全。" },
      { name: "Cloudflare Workers", note: "托管静态资源，全球节点，个人站的免费额度完全够。" },
    ],
  },
  {
    title: "用 AI",
    caption: "当作一起干活的，不是替我拿主意的",
    items: [
      { name: "ChatGPT", note: "查资料、理思路、把一段话改得更准确。" },
      { name: "Codex", note: "写代码时它在旁边看，改 bug、补边界情况。" },
      { name: "WorkBuddy", note: "这个站的大部分改动，是它陪我一步步做出来的。" },
    ],
  },
  {
    title: "骑车",
    caption: "长途和爬坡",
    items: [
      { name: "喜德盛 RC500", note: "公路车，碳架。主要用来跑长途和爬坡。" },
      { name: "头盔与前后灯", note: "夜骑一定开灯。这件事没有例外。" },
      { name: "码表", note: "看均速和里程。爬坡时尽量不低头看它。" },
    ],
  },
  {
    title: "其他",
    caption: "不上班的时候",
    items: [
      { name: "Autodesk Inventor", note: "工程制图课要用，画零件和三视图。" },
      { name: "网易云音乐", note: "写东西的时候必须有背景音。" },
      { name: "维多利亚 3 / 钢铁雄心 4", note: "Paradox 的策略游戏，一局能坐一晚上。" },
    ],
  },
];
