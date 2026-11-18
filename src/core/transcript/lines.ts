// 显示用的断行：一段字幕是好几行原始字幕并起来的，语音识别的字幕没有标点，并起来就是一大片连着的字。
// 这里按原始字幕的行把每一段在哪几处断开找回来，只给界面分开显示，不改段落、不加标点，导出、检索、分块都不受影响。
// 原文本来就有标点的段落不断开，照原样显示。
import type { TranscriptSegment } from "./segment.ts";

/** 句读标点：一段里有这些就当原文自带标点。 */
const PUNCTUATION = /[，。！？；：、,.!?;:…]/;

export const hasPunctuation = (text: string): boolean => PUNCTUATION.test(text);

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/**
 * 每一段里新的一行从第几个字开始（不含 0）。按顺序把原始字幕逐字对到段落文字上，空白不算；
 * 一行原始字幕可能被切进两段。对不上时说明这份字幕和段落不是一回事，整份都不断开，回空表。
 */
export function lineBreaks(segments: readonly Pick<TranscriptSegment, "id" | "text">[], cues: readonly { readonly text: string }[]): ReadonlyMap<string, readonly number[]> {
  const result = new Map<string, number[]>();
  let cueIndex = 0;
  let carry = "";
  let at = 0;
  const nextCue = (): boolean => {
    while (cueIndex < cues.length) {
      const text = String(cues[cueIndex]?.text ?? "");
      cueIndex += 1;
      if (text.trim()) {
        carry = text;
        at = 0;
        return true;
      }
    }
    return false;
  };
  for (const segment of segments) {
    const text = segment.text;
    const breaks: number[] = [];
    let i = 0;
    while (i < text.length) {
      if (isSpace(text[i])) {
        i += 1;
        continue;
      }
      while (at < carry.length && isSpace(carry[at])) at += 1;
      if (at >= carry.length) {
        if (!nextCue()) return new Map();
        while (at < carry.length && isSpace(carry[at])) at += 1;
        if (i > 0) breaks.push(i);
      }
      if (carry[at] !== text[i]) return new Map();
      at += 1;
      i += 1;
    }
    if (breaks.length) result.set(segment.id, breaks);
  }
  return result;
}

/** 这一段要不要按原始字幕的行分开显示：找得到断处，而且原文没有标点。 */
export function breaksToShow(segment: Pick<TranscriptSegment, "id" | "text">, breaks: ReadonlyMap<string, readonly number[]>): readonly number[] {
  const found = breaks.get(segment.id);
  return found && !hasPunctuation(segment.text) ? found : [];
}

/** 按断处把一串连着的片段（比如搜索高亮切出来的）分成几行，每行里片段的文字拼起来正好是那一行，所有行拼起来就是原文。 */
export function splitRuns<T extends { readonly text: string }>(runs: readonly T[], breaks: readonly number[]): T[][] {
  const lines: T[][] = [[]];
  let offset = 0;
  let next = 0;
  for (const run of runs) {
    let rest = run;
    let start = offset;
    while (next < breaks.length && (breaks[next] ?? Infinity) < start + rest.text.length) {
      const cut = (breaks[next] ?? 0) - start;
      if (cut > 0) lines[lines.length - 1]?.push({ ...rest, text: rest.text.slice(0, cut) });
      rest = { ...rest, text: rest.text.slice(cut) };
      start += cut;
      lines.push([]);
      next += 1;
    }
    if (rest.text) lines[lines.length - 1]?.push(rest);
    offset = start + rest.text.length;
  }
  return lines.filter((line) => line.length > 0);
}
