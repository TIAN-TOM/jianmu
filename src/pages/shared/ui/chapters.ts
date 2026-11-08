// 章节列表和时间轨共用的规则：哪几章是重点、章节小标题怎么写。
// 重点只按起始秒精确匹配现有章节，对不上的直接忽略，不猜最近的一章。

export interface ChapterStart {
  readonly startSec: number;
}

/** 合法的重点起始秒。没有这个字段、或者里面混着不是数的值，都按没有处理。 */
export function keyStartSet(keyStarts: readonly number[] | null | undefined): ReadonlySet<number> {
  return new Set((keyStarts ?? []).filter((start) => typeof start === "number" && Number.isFinite(start) && start >= 0));
}

/** 每一章是不是重点，和 chapters 一一对应。 */
export function keyFlags(chapters: readonly ChapterStart[], keyStarts: readonly number[] | null | undefined): boolean[] {
  const keys = keyStartSet(keyStarts);
  return chapters.map((chapter) => keys.has(chapter.startSec));
}

/** 「章节 6，重点 2」，没有重点时只写「章节 6」。 */
export function chapterHeading(count: number, keyCount: number): string {
  return keyCount > 0 ? `章节 ${count}，重点 ${keyCount}` : `章节 ${count}`;
}
