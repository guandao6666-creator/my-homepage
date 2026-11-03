/**
 * Guandao OS 1.3 · 壁纸库元数据
 *
 * 24 张本地壁纸，全部由项目内资源提供，不依赖任何远程随机图源。
 * accent / accent2 由 scripts/build-wallpapers.mjs 在构建资源时按色相聚类取主色，
 * 再对少数「主色被天空蓝色吃掉」的图做人工校正，保证主题联动有辨识度。
 */
import assets from "./wallpaper-assets.json";

export type WallCategory = "nature" | "city" | "abstract" | "guandao";

export type Wallpaper = {
  id: string;
  name: string;
  en: string;
  cat: WallCategory;
  desc: string;
  accent: string;
  accent2: string;
  lum: number;
  src: string;
  thumb: string;
  w: number;
  h: number;
};

type Asset = { accent: string; accent2: string; luminance: number; w: number; h: number };

const A = assets as Record<string, Asset>;

const META: Array<[string, string, string, WallCategory, string, string, string]> = [
  ["ridge", "云上山脊", "Above the Clouds", "nature", "高山脊线破开云海，晨光落在雪面。", "#477bae", "#6365ba"],
  ["snow", "雪峰蓝调", "Blue Hour Peak", "nature", "孤峰、暮蓝与第一颗星。", "#8fb8f0", "#a9c4ff"],
  ["forest", "雾中针叶林", "Mistveil", "nature", "光柱穿过冷杉，苔藓与湿雾。", "#47ae93", "#63a7ba"],
  ["coast", "海岸曲线", "Coastline", "nature", "绿松石色海浪与白沙的弧线。", "#22abd3", "#4470d9"],
  ["sunset", "落日入海", "Sunfall", "nature", "低垂的太阳把海面染成琥珀色。", "#c97f62", "#d0be84"],
  ["stars", "星河沙丘", "Milky Dunes", "nature", "银河横跨寂静沙丘，星点清晰。", "#8b93ff", "#a9a2ff"],
  ["aurora", "极光之镜", "Aurora Mirror", "nature", "绿色与紫色的极光落在冰湖上。", "#2acb7b", "#4bd3d1"],
  ["lake", "静湖清晨", "Stillwater", "nature", "湖面如镜，薄雾与层叠山影。", "#ddaa7e", "#e0dc99"],

  ["city-night", "雨夜都市", "Neon Rain", "city", "湿润路面反射蓝紫霓虹。", "#4377b2", "#6160be"],
  ["tokyo", "东京小巷", "Tokyo Alley", "city", "雨后小巷，纸灯与自动贩卖机的暖光。", "#b37241", "#bfb65f"],
  ["future-arch", "未来建筑", "Parametric", "city", "白色曲面与精准的光影节奏。", "#4380b2", "#6066be"],
  ["skyline", "城市天际线", "Skyline", "city", "蓝调时刻的天际线与长曝光水面。", "#f0a06a", "#7d94d8"],
  ["arch-min", "极简建筑", "Quiet Arch", "city", "暖色混凝土、深拱与一道斜光。", "#b57740", "#c0bb5d"],

  ["gradient", "流体渐变", "Soft Mesh", "abstract", "靛蓝、紫与珊瑚色的柔和过渡。", "#a78bfa", "#f0a08a"],
  ["fluid", "液态铬", "Liquid Chrome", "abstract", "金属流体折射青与香槟金。", "#9db4ff", "#c9a9ff"],
  ["glass", "玻璃材质", "Frosted", "abstract", "半透明玻璃层叠，光在内部散射。", "#e29b79", "#e4d596"],
  ["geo", "几何构成", "Bauhaus Quiet", "abstract", "圆、半圆与细线，纸张颗粒。", "#2f7f7a", "#c08552"],
  ["digital", "粒子波", "Particle Wave", "abstract", "发光微粒汇成丝绸般的波。", "#38bdf8", "#a78bfa"],
  ["tech", "深色科技", "Carbon", "abstract", "哑光碳纤维与冷色光带。", "#5b8cff", "#8b5cf6"],

  ["space", "Guandao Space", "深空星云", "guandao", "青金气体云与暗尘带，尺度感极大。", "#47ae98", "#e6b878"],
  ["ocean", "Guandao Ocean", "深海光柱", "guandao", "光柱穿过深蓝，远处有鲸的轮廓。", "#1aaadb", "#3e69e0"],
  ["ink", "Guandao Mountain", "水墨群山", "guandao", "水墨与宣纸，留白处的呼吸。", "#b08d5f", "#d0b18b"],
  ["harbor", "Guandao Future", "未来港湾", "guandao", "蓝调时刻的巨型港口与静水倒影。", "#35c6d8", "#f0a86a"],
  ["dunes", "Guandao Minimal", "沙丘极简", "guandao", "沙脊的锐利明暗与暖粉色调。", "#c87758", "#ceba7a"],
];

export const WALLPAPERS: Wallpaper[] = META.map(([id, name, en, cat, desc, accent, accent2]) => {
  const a = A[id];
  return {
    id,
    name,
    en,
    cat,
    desc,
    // 人工校正色优先，缺失时退回构建期取色
    accent: accent || a?.accent || "#6f8cff",
    accent2: accent2 || a?.accent2 || "#b06eff",
    lum: a?.luminance ?? 0.4,
    src: `/wallpapers/${id}.webp`,
    thumb: `/wallpapers/thumbs/${id}.webp`,
    w: a?.w ?? 1600,
    h: a?.h ?? 1067,
  };
});

export const WALL_CATEGORY_LABEL: Record<WallCategory, string> = {
  nature: "自然风景",
  city: "城市与建筑",
  abstract: "艺术与抽象",
  guandao: "Guandao Collection",
};

export const wallpaperById = (id: string) => WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0];
