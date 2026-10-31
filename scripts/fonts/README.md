# 字体

分享图渲染需要一份支持中文的字体文件，satori 不支持 woff2，所以这里放 OTF。

| 文件 | 来源 | 协议 |
| --- | --- | --- |
| `NotoSansSC-Regular.otf` | [googlefonts/noto-cjk](https://github.com/googlefonts/noto-cjk) `Sans/SubsetOTF/SC` | SIL Open Font License 1.1 |

约 8 MB，只在构建期读取，不会进入前端产物。

换字体时保持文件名不变，或者同时改 `src/lib/og-image.mjs` 里的 `FONT_PATH`。
建议用思源黑体 / Noto Sans SC 这类字重齐全、字形规范的开源字体，
避免把商业字体提交进仓库。
