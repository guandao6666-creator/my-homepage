/**
 * 正文增强插件（构建期）。
 *
 * 1. 图片：首图 eager + high 优先级，其余 lazy + async decoding。
 * 2. 外链：自动 target="_blank" + rel，并打上 .ext-link 以便加箭头图标。
 * 3. 代码块：包一层 .code-block，顶部输出语言标签与复制按钮（按钮事件由前端绑定）。
 *
 * 之所以自己写而不装现成插件：这里只做三件小事，手写可以精确控制节点结构，
 * 也不会和 rehype-slug / autolink-headings 的执行顺序打架。
 */

const SITE_HOST = "guandao.xin";

function isExternal(href) {
  if (typeof href !== "string" || !href) return false;
  if (/^(#|\/|\.\/|\.\.\/|mailto:|tel:|javascript:)/i.test(href)) return false;
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const host = new URL(href).hostname;
    return host !== SITE_HOST && !host.endsWith(`.${SITE_HOST}`);
  } catch {
    return false;
  }
}

function classNameOf(node) {
  const value = node?.properties?.className;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function languageOf(pre) {
  const code = (pre.children ?? []).find(
    (child) => child?.type === "element" && child.tagName === "code",
  );
  const raw = classNameOf(code).find((name) => name.startsWith("language-"));
  if (raw) return raw.slice("language-".length);

  // Shiki 已经处理过时，语言挂在 pre 上；hast 里 data-* 会变成 camelCase
  const props = pre.properties ?? {};
  const dataLang = props["data-language"] ?? props.dataLanguage ?? props.dataLang;
  return typeof dataLang === "string" ? dataLang.trim() : "";
}

function text(value) {
  return { type: "text", value };
}

function el(tagName, properties, children = []) {
  return { type: "element", tagName, properties, children };
}

function codeHead(lang) {
  return el("div", { className: ["code-head"] }, [
    el("span", { className: ["code-lang"] }, [text(lang || "code")]),
    el(
      "button",
      {
        type: "button",
        className: ["code-copy"],
        "data-code-copy": "",
        "aria-label": "复制代码",
      },
      [text("复制")],
    ),
  ]);
}

export default function rehypeEnhance() {
  return (tree) => {
    let imageIndex = 0;
    const blocks = [];

    const visit = (node, parent) => {
      if (!node || typeof node !== "object") return;

      if (node.type === "element") {
        const props = node.properties ?? (node.properties = {});

        if (node.tagName === "img") {
          imageIndex += 1;
          if (imageIndex === 1) {
            // 首图通常就在开头，延迟加载反而会拖慢 LCP
            props.loading = "eager";
            props.fetchpriority = "high";
          } else {
            props.loading = "lazy";
            props.decoding = "async";
          }
        }

        if (node.tagName === "a" && isExternal(props.href)) {
          props.target = "_blank";
          props.rel = "noopener noreferrer";
          const cls = classNameOf(node);
          if (!cls.includes("ext-link")) props.className = [...cls, "ext-link"];
        }

        if (node.tagName === "pre" && parent) {
          blocks.push({ node, parent });
        }
      }

      for (const child of node.children ?? []) visit(child, node);
    };

    visit(tree, null);

    // 倒序替换，避免前面的插入让后面的索引错位
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const { node, parent } = blocks[i];
      const index = parent.children.indexOf(node);
      if (index === -1) continue;
      const lang = languageOf(node);
      parent.children[index] = el(
        "div",
        { className: ["code-block"], "data-lang": lang || "code" },
        [codeHead(lang), node],
      );
    }
  };
}
