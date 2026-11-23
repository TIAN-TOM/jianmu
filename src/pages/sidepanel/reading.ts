// 字幕列表的规则：播放到哪一段、导出 SRT 时每段写原文、译文还是双语、划词解释取多长。
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { formatTimestamp, type TranscriptSegment } from "../../core/transcript/segment.ts";
import { breaksToShow } from "../../core/transcript/lines.ts";
import { buildSrt } from "../../core/transcript/srt.ts";
import type { CueView } from "../../shared/messages/transcript.ts";
import type { TranscriptMode } from "./translate.ts";

export { chapterAt } from "../shared/ui/chapters.ts";

/** 播放到的那一段：开始时间不晚于播放位置的最后一段。还没到第一段时是 -1。 */
export function activeIndex(segments: readonly Pick<TranscriptSegment, "start">[], atSec: number | null): number {
  if (atSec === null || !Number.isFinite(atSec)) return -1;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((segments[mid]?.start ?? Infinity) <= atSec) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** 一段在当前视图下显示的文字：译文还没到的段落先显示原文；有整理结果时原文用整理后的（tidied 只在用户没切回原始字幕时给）。 */
export function linesOf(
  segment: TranscriptSegment,
  mode: TranscriptMode,
  translated: Readonly<Record<string, string>>,
  tidied: Readonly<Record<string, string>> = {},
): { readonly main: string; readonly sub: string } {
  const translation = translated[segment.id] ?? "";
  const original = tidied[segment.id] || segment.text;
  if (mode === "translated") return { main: translation || original, sub: "" };
  if (mode === "bilingual") return { main: original, sub: translation };
  return { main: original, sub: "" };
}

/** 字幕搜索保留整段。当前显示的两行都没命中时，补上其他版本里命中的文字。 */
export function transcriptRows(
  segments: readonly TranscriptSegment[],
  mode: TranscriptMode,
  translated: Readonly<Record<string, string>>,
  tidied: Readonly<Record<string, string>>,
  showTidied: boolean,
  query: string,
) {
  const needle = query.trim();
  const matches = (line: string): boolean => hasMatch(splitMatches(line, needle));
  const displayedTidy = showTidied ? tidied : {};
  return segments.flatMap((segment, index) => {
    const { main, sub } = linesOf(segment, mode, translated, displayedTidy);
    let extra: string[] = [];
    if (needle && !matches(main) && !matches(sub)) {
      const candidates = new Set([segment.text, translated[segment.id] ?? "", tidied[segment.id] ?? ""]);
      extra = [...candidates].filter((line) => line && line !== main && line !== sub && matches(line));
      if (!extra.length) return [];
    }
    return [{ segment, index, main, sub, extra }];
  });
}

/** 导出 SRT：内容跟着当前的原文（整理过就是整理后的）、译文或双语视图。 */
export function srtOf(
  segments: readonly TranscriptSegment[],
  cues: readonly CueView[],
  durationSec: number,
  mode: TranscriptMode,
  translated: Readonly<Record<string, string>>,
  tidied: Readonly<Record<string, string>> = {},
): string {
  const items = segments.map((segment) => {
    const { main, sub } = linesOf(segment, mode, translated, tidied);
    return { start: segment.start, text: sub ? `${main}\n${sub}` : main };
  });
  return buildSrt(items, { entries: cues, duration: durationSec });
}

/** 复制全部字幕：每段一行「[时间] 主文」，对照视图里有译文的段落紧跟一行不带时间的译文。 */
export function copyTextOf(
  segments: readonly TranscriptSegment[],
  mode: TranscriptMode,
  translated: Readonly<Record<string, string>>,
  tidied: Readonly<Record<string, string>> = {},
): string {
  return segments.map((segment) => {
    const { main, sub } = linesOf(segment, mode, translated, tidied);
    const line = `[${formatTimestamp(segment.start)}] ${main}`;
    return sub ? `${line}\n${sub}` : line;
  }).join("\n");
}

export function selectedNote(raw: string, segment: Pick<TranscriptSegment, "start"> | undefined): { text: string; atSec: number } | null {
  const text = raw.trim();
  return text && segment ? { text, atSec: segment.start } : null;
}

/** 划词解释最多交这么长的选区，再长就不弹「解释」。 */
export const MAX_SELECTION = 300;

/** 选中的文字能不能拿去解释：去掉首尾空白后不空、不太长。 */
export function explainable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SELECTION;
}

/** 一章里的字幕：从这一章开始到下一章开始之前；最后一章到结尾。 */
export function segmentsBetween<T extends Pick<TranscriptSegment, "start">>(segments: readonly T[], startSec: number, endSec: number | null): T[] {
  return segments.filter((segment) => segment.start >= startSec && (endSec === null || segment.start < endSec));
}

/** 主行按原始字幕的哪几处断开：主行显示的是原文才断（原文、双语，或者译文还没到），显示译文时不断。 */
export function mainBreaks(segment: Pick<TranscriptSegment, "id" | "text">, main: string, breaks: ReadonlyMap<string, readonly number[]>): readonly number[] {
  return main === segment.text ? breaksToShow(segment, breaks) : [];
}

/** 「重新读取字幕」点不点名现在这条的语言：导入的字幕和官方总结附带的字幕都不是平台列出的轨，点名语言就读不回来了。 */
export function refreshLang(transcript: { readonly fileName?: string | undefined; readonly ref: { readonly kind: string } }): boolean {
  return !transcript.fileName && transcript.ref.kind !== "official-ai";
}
