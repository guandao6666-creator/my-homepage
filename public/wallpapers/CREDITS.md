# 壁纸资源说明

Guandao OS 1.3 内置 24 张壁纸，全部为项目内图像生成流程的产出，
不包含任何第三方图库素材，也不依赖远程图床。

## 处理流程

1. 生成：1536 × 1024 PNG，右下角带生成标记
2. 裁切：去掉右侧与底部各 7%，移除标记
3. 输出：1600 × 1067 WebP（quality 82）+ 480 × 320 缩略图
4. 取色：按色相聚类计算主色与辅助色，写入 `src/lib/wallpaper-assets.json`
5. 人工校正：对主色被天空蓝主导的图片做强调色校正，保证主题辨识度

## 清单

| 分类 | 文件 |
| --- | --- |
| 自然风景 | ridge, snow, forest, coast, sunset, stars, aurora, lake |
| 城市与建筑 | city-night, tokyo, future-arch, skyline, arch-min |
| 艺术与抽象 | gradient, fluid, glass, geo, digital, tech |
| Guandao Collection | space, ocean, ink, harbor, dunes |

## 使用许可

以上资源随本项目一同分发，仅用于 Guandao OS 界面展示。
如需在其他项目中使用，请自行确认生成模型的服务条款。
