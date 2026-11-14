/** 二维码生成：只在本地渲染 SVG，不把配对 token 发给第三方服务。 */

export async function qrSvg(text: string): Promise<string> {
  const mod = await import("qrcode");
  const toString = (mod as unknown as { toString: (value: string, options: Record<string, unknown>) => Promise<string> }).toString;
  const svg = await toString(text, {
    type: "svg",
    margin: 1,
    width: 156,
    errorCorrectionLevel: "M",
    color: { dark: "#0b0e15", light: "#ffffff" },
  });
  return svg;
}
