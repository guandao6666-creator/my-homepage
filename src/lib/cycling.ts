/**
 * 骑行数据。
 *
 * 所有数字都来自这里，改完重新构建即可，页面不需要动。
 * years 留空时页面只显示总里程，不会画分年柱状图。
 */

export interface RideYear {
  year: number;
  km: number;
  /** 当年骑行次数，可选 */
  rides?: number;
  /** 当年累计爬升（米），可选 */
  climb?: number;
}

export interface RidePhoto {
  src: string;
  caption?: string;
}

export const CYCLING = {
  /** 累计里程（公里） */
  totalKm: 4000,
  /** 单次最远（公里） */
  longestKm: 100,
  /** 爱车 */
  bike: "喜德盛 RC500",
  /** 常驻城市 */
  base: "大连",
  /** 从哪一年开始骑 */
  startedYear: 2024,
  intro:
    "从宿舍到海边，从市区到郊区。骑过的路不算多，但每一段都记得——风大的时候、爬坡的时候、下坡松开刹车的时候。",
  /** 分年里程：录入后自动出现柱状图 */
  years: [] as RideYear[],
  /** 装备清单 */
  kit: ["头盔", "码表", "前后灯", "补胎工具"],
  /** 照片墙：把图片放进 public/cycling/ 再写路径，例如 /cycling/2026-05-01.jpg */
  gallery: [] as RidePhoto[],
};
