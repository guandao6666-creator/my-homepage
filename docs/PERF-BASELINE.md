# Guandao OS 构建体积基线

> 由 `node scripts/perf-baseline.mjs --write` 生成，不要手改。生成时间：2026-11-18T08:22:33.763Z
> 口径：未压缩字节（与 2.0 审计一致，见 docs/AI-BUILD-DECISIONS.md D-003）。

| 项 | 实测 | 预算 | 占比 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 入口 JS | 432.1 KB | 439.5 KB | 98.3% | 通过 |
| 首屏 CSS | 180.8 KB | 195.3 KB | 92.6% | 通过 |

合计：JS 1310.0 KB · CSS 586.1 KB · 资源 103 个。

| 最大资源 | 体积 |
| --- | ---: |
| `index.astro_astro_type_script_index_0_lang.BWdiNL36.js` | 432.1 KB |
| `index.DqpE0ncq.css` | 172.8 KB |
| `community.bHZIwRlE.js` | 113.9 KB |
| `m.astro_astro_type_script_index_0_lang.D4IXV7zj.js` | 56.7 KB |
| `community.dIY5I7se.css` | 45.1 KB |
