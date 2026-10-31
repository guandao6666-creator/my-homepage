/**
 * 每篇文章的社交分享图（OG image）。
 *
 * 构建结束后为每篇文章渲染一张 1200×630 的 PNG，写进 dist/og/。
 * 标题、标签、日期都来自 search-index.json（同一份数据，避免再解析一遍 frontmatter）。
 *
 * 字体缺失时不会让构建失败，只是跳过并给出提示——clone 下来没下字体也能跑。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const FONT_PATH = path.resolve(process.cwd(), "scripts/fonts/NotoSansSC-Regular.otf");

const C = {
  paper: "#fbfaf7",
  ink: "#191b18",
  muted: "#767d71",
  accent: "#3f6b4e",
  accentWash: "#eef3ec",
};

/** 标题越长字号越小，保证三行内放得下 */
function titleSize(length) {
  if (length <= 12) return 82;
  if (length <= 18) return 70;
  if (length <= 26) return 60;
  if (length <= 36) return 52;
  if (length <= 48) return 46;
  return 40;
}

function box(style, children) {
  return { type: "div", props: { style: { display: "flex", ...style }, children } };
}

export function buildCard({ title, tags, date, description }) {
  const tagText = (tags ?? []).slice(0, 3).join(" · ") || "随笔";
  const size = titleSize(title.length);
  const desc = (description ?? "").replace(/\s+/g, " ").trim();

  return {
    type: "div",
    props: {
      style: {
        width: "1200px",
        height: "630px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        position: "relative",
        overflow: "hidden",
        backgroundColor: C.paper,
        fontFamily: "NotoSansSC",
        padding: "76px 84px 62px 92px",
      },
      children: [
        box(
          {
            position: "absolute",
            top: "-190px",
            right: "-150px",
            width: "580px",
            height: "580px",
            borderRadius: "50%",
            background: C.accentWash,
          },
          [],
        ),
        box(
          {
            position: "absolute",
            left: "0",
            top: "0",
            width: "12px",
            height: "630px",
            background: C.accent,
          },
          [],
        ),
        box(
          {
            position: "relative",
            flexDirection: "column",
            marginTop: "34px",
          },
          [
            box(
              {
                fontSize: "23px",
                color: C.accent,
                letterSpacing: "3px",
                marginBottom: "28px",
              },
              tagText,
            ),
            box(
              {
                fontSize: `${size}px`,
                lineHeight: 1.34,
                color: C.ink,
                letterSpacing: "-1px",
                maxHeight: `${Math.round(size * 1.34 * 3)}px`,
                overflow: "hidden",
              },
              title,
            ),
            ...(desc
              ? [
                  box(
                    {
                      marginTop: "24px",
                      fontSize: "23px",
                      lineHeight: 1.6,
                      color: C.muted,
                      maxHeight: "38px",
                      overflow: "hidden",
                    },
                    desc,
                  ),
                ]
              : []),
          ],
        ),
        box({ position: "relative", flexDirection: "column" }, [
          box(
            {
              width: "66px",
              height: "2px",
              background: C.accent,
              opacity: 0.45,
              marginBottom: "24px",
            },
            [],
          ),
          box(
            {
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "21px",
              color: C.muted,
            },
            [box({}, "管道的博客 · 管道"), box({ letterSpacing: "1px" }, date)],
          ),
        ]),
      ],
    },
  };
}

/** 文件名与 URL 共用同一套清理规则，保证两边对得上 */
export function ogSlug(slug) {
  return slug.replace(/[\\/]+/g, "-").replace(/[<>:"|?*#%]+/g, "-").slice(0, 80);
}

export function ogImageIntegration() {
  return {
    name: "guandao-og-image",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        if (!existsSync(FONT_PATH)) {
          logger.warn("未找到中文字体，跳过 OG 图生成（见 scripts/fonts/README）");
          return;
        }

        const font = await readFile(FONT_PATH);
        let items;
        try {
          items = JSON.parse(await readFile(new URL("search-index.json", dir), "utf8"));
        } catch {
          logger.warn("读取 search-index.json 失败，跳过 OG 图");
          return;
        }
        if (!Array.isArray(items) || !items.length) return;

        const outDir = fileURLToPath(new URL("og/", dir));
        await mkdir(outDir, { recursive: true });

        let count = 0;
        for (const item of items) {
          try {
            const svg = await satori(
              buildCard({
                title: item.title,
                tags: item.tags,
                description: item.description,
                date: (item.date ?? "").replace(/-/g, "."),
              }),
              {
                width: 1200,
                height: 630,
                fonts: [{ name: "NotoSansSC", data: font, weight: 400, style: "normal" }],
              },
            );
            const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } })
              .render()
              .asPng();
            await writeFile(path.join(outDir, `${ogSlug(item.slug)}.png`), png);
            count += 1;
          } catch (error) {
            logger.warn(`OG 图生成失败：${item.slug} — ${error.message}`);
          }
        }

        logger.info(`已生成 ${count} 张分享图 → dist/og/`);
      },
    },
  };
}
