# Guandao OS 构建体积基线

> 由 `node scripts/perf-baseline.mjs --write` 生成，不要手改。生成时间：2026-11-18T07:43:51.277Z
> 口径：未压缩字节（与 2.0 审计一致，见 docs/AI-BUILD-DECISIONS.md D-003）。

| 项 | 实测 | 预算 | 占比 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 入口 JS | 432.2 KB | 439.5 KB | 98.4% | 通过 |
| 首屏 CSS | 452.2 KB | 195.3 KB | 231.5% | 超标 |

合计：JS 2111.5 KB · CSS 572.5 KB · 资源 111 个。

| 最大资源 | 体积 |
| --- | ---: |
| `index.astro_astro_type_script_index_0_lang.BXLxUiE1.js` | 432.2 KB |
| `index.astro_astro_type_script_index_0_lang.ItAS7GRc.js` | 432.2 KB |
| `index.C2OS75Kh.css` | 191.6 KB |
| `community.DU7DIWxE.js` | 113.8 KB |
| `community.Dv05163g.js` | 113.8 KB |
