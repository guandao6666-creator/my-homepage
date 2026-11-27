/**
 * 2.0.8 · 市场「选中项是否还在当前过滤结果里」
 *
 * 旧实现把这段判断写死在 refreshData 里，无法单测；而漏掉详情栏重绘后，
 * 搜索会留下一个看不见却仍可被点击的旧详情（安装按钮按空 id 静默失败）。
 * 抽成纯函数，让「选中项是否保留」与「要不要清空」变成可验证的行为。
 */
export function resolveSelection(selected: string, visibleKeys: readonly string[]): string {
  if (!selected) return "";
  return visibleKeys.includes(selected) ? selected : "";
}