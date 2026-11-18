# Guandao OS 构建体积基线

> 由 `node scripts/perf-baseline.mjs --write` 生成，不要手改。生成时间：2026-11-18T08:14:45.205Z
> 口径：未压缩字节（与 2.0 审计一致，见 docs/AI-BUILD-DECISIONS.md D-003）。

| 项 | 实测 | 预算 | 占比 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 入口 JS | 432.0 KB | 439.5 KB | 98.3% | 通过 |
| 首屏 CSS | 199.5 KB | 195.3 KB | 102.1% | 超标 |

合计：JS 1309.5 KB · CSS 585.6 KB · 资源 101 个。

| 最大资源 | 体积 |
| --- | ---: |
| `index.astro_astro_type_script_index_0_lang.DiXcO0GY.js` | 432.0 KB |
| `index.C2OS75Kh.css` | 191.6 KB |
| `community.CtMu_A9O.js` | 113.9 KB |
| `m.astro_astro_type_script_index_0_lang.D4IXV7zj.js` | 56.7 KB |
| `community.dIY5I7se.css` | 45.1 KB |
