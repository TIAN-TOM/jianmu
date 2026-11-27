// 卡片上的概览怎么摆：有没有概览、章节按时间排好、默认露几条。纯函数，模型和界面都用。
import type { LearningAnalysis } from "../../core/notes/records.ts";

/** 有章节或金句才算已经有概览；只有一句话结论的，「生成概览」照样留着。 */
export function hasOverview(analysis: LearningAnalysis | null): boolean {
  return Boolean(analysis?.chapters?.length || analysis?.keyQuotes?.length);
}

/** 章节按开始时间排好：收起那一行写「第几章」用，和侧边栏精读顶上那一条同一个顺序。 */
export function chaptersInOrder(analysis: LearningAnalysis | null): readonly { readonly startSec: number; readonly title: string }[] {
  return (analysis?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.timestampSeconds))
    .map((chapter) => ({ startSec: chapter.timestampSeconds, title: typeof chapter.title === "string" ? chapter.title.trim() : "" }))
    .sort((a, b) => a.startSec - b.startSec);
}

/** 章节列表露出几章那么高（其余在列表里滚动）、官方提纲默认露几段：卡片嵌在右栏里，太高会把下面的选集和推荐顶下去。 */
export const CARD_ROWS = 5;

/** 默认露出来的那几条。只多出一条时不藏：为一条去滚动或点「展开全部」不值当。 */
export function cardRows<T>(rows: readonly T[], showAll: boolean): readonly T[] {
  return showAll || rows.length <= CARD_ROWS + 1 ? rows : rows.slice(0, CARD_ROWS);
}
