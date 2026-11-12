// 字幕列表的规则：播放到哪一段、导出 SRT 时每段写原文、译文还是双语、划词解释取多长。
import type { TranscriptSegment } from "../../core/transcript/segment.ts";
import { buildSrt } from "../../core/transcript/srt.ts";
import type { CueView } from "../../shared/messages/transcript.ts";
import type { TranscriptMode } from "./translate.ts";

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

/** 一段在当前视图下显示的文字：译文还没到的段落先显示原文。 */
export function linesOf(segment: TranscriptSegment, mode: TranscriptMode, translated: Readonly<Record<string, string>>): { readonly main: string; readonly sub: string } {
  const translation = translated[segment.id] ?? "";
  if (mode === "translated") return { main: translation || segment.text, sub: "" };
  if (mode === "bilingual") return { main: segment.text, sub: translation };
  return { main: segment.text, sub: "" };
}

/** 导出 SRT：内容跟着当前的原文、译文或双语视图。 */
export function srtOf(
  segments: readonly TranscriptSegment[],
  cues: readonly CueView[],
  durationSec: number,
  mode: TranscriptMode,
  translated: Readonly<Record<string, string>>,
): string {
  const items = segments.map((segment) => {
    const { main, sub } = linesOf(segment, mode, translated);
    return { start: segment.start, text: sub ? `${main}\n${sub}` : main };
  });
  return buildSrt(items, { entries: cues, duration: durationSec });
}

/** 划词解释最多交这么长的选区，再长就不弹「解释」。 */
export const MAX_SELECTION = 300;

/** 选中的文字能不能拿去解释：去掉首尾空白后不空、不太长。 */
export function explainable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SELECTION;
}
