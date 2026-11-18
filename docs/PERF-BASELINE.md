# Guandao OS 构建体积基线

> 由 `node scripts/perf-baseline.mjs --write` 生成，不要手改。生成时间：2026-11-18T07:56:05.183Z
> 口径：未压缩字节（与 2.0 审计一致，见 docs/AI-BUILD-DECISIONS.md D-003）。

| 项 | 实测 | 预算 | 占比 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 入口 JS | 432.2 KB | 439.5 KB | 98.4% | 通过 |
| 首屏 CSS | 407.0 KB | 195.3 KB | 208.4% | 超标 |

合计：JS 1306.6 KB · CSS 572.5 KB · 资源 91 个。

| 最大资源 | 体积 |
| --- | ---: |
| `index.astro_astro_type_script_index_0_lang.Dbg5oLcc.js` | 432.2 KB |
| `index.C2OS75Kh.css` | 191.6 KB |
| `community.D3U3hJG4.js` | 114.3 KB |
| `m.astro_astro_type_script_index_0_lang.dLwPiWDS.js` | 56.7 KB |
| `community.dIY5I7se.css` | 45.1 KB |
