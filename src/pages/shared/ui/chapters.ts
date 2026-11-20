// 章节列表和时间轨共用的规则：哪几章是重点、章节小标题怎么写。
// 重点按整秒匹配现有章节（章节起点不足一秒的部分舍去，和结论里记的一样），对不上的直接忽略，不猜最近的一章。
import { sharedTextOf } from "../text.ts";
import type { UiLang } from "../ui-lang.ts";

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
  return chapters.map((chapter) => keys.has(Math.floor(chapter.startSec)));
}

/** 播放到的那一章：开始时间不晚于播放位置的最后一章，章节要按开始时间排好。还没到第一章、没有章节或不知道播放位置时是 -1。 */
export function chapterAt(chapters: readonly ChapterStart[], atSec: number | null): number {
  if (atSec === null || !Number.isFinite(atSec)) return -1;
  let found = -1;
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.startSec > atSec) break;
    found = index;
  }
  return found;
}

/** 「章节 6，重点 2」，没有重点时只写「章节 6」。 */
export function chapterHeading(count: number, keyCount: number, lang: UiLang = "zh"): string {
  return sharedTextOf(lang).chapters.heading(count, keyCount);
}
