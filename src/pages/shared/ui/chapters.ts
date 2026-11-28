// 章节列表的规则：哪几章是重点、章节小标题怎么写。
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

const validLength = (seconds: number | null | undefined): seconds is number => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;

/**
 * 每一章有多长：到下一章开始为止，最后一章到 endSec（给了的话）或视频结束；章节要按开始时间排好。
 * 某一章给了自己的 endSec 就用它（卡片只摆前几章时，最后摆出来的那一章照样到下一章为止）。算不出来的是 null。
 */
export function chapterLengths(chapters: readonly (ChapterStart & { readonly endSec?: number | undefined })[], totalSec: number | null | undefined): (number | null)[] {
  return chapters.map((chapter, index) => {
    const end = chapter.endSec ?? chapters[index + 1]?.startSec ?? (validLength(totalSec) ? totalSec : undefined);
    if (end === undefined) return null;
    const length = end - chapter.startSec;
    return validLength(length) ? length : null;
  });
}

/** 每一章的时长占最长一章的几成（0 到 1），时长条按它画宽；算不出时长的是 0。 */
export function lengthShares(lengths: readonly (number | null)[]): number[] {
  const longest = Math.max(0, ...lengths.map((length) => length ?? 0));
  return lengths.map((length) => (length && longest > 0 ? length / longest : 0));
}

/** 视频总时长能用：是正的有限数。 */
export const knownLength = validLength;

/** 「全长 56:00」。 */
export function totalLengthText(time: string, lang: UiLang): string {
  return sharedTextOf(lang).chapters.total(time);
}

/** 「章节 6，重点 2」，没有重点时只写「章节 6」。 */
export function chapterHeading(count: number, keyCount: number, lang: UiLang): string {
  return sharedTextOf(lang).chapters.heading(count, keyCount);
}
