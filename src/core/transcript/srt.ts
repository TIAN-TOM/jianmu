// SRT 输出：分段只记了开始时间，这里补上结束时间。
import type { CaptionEntries, MaybeCaptionEntry } from "./segment.ts";

export interface SrtItem {
  readonly start?: number | null | undefined;
  readonly text?: string | null | undefined;
}

export interface SrtOptions {
  readonly entries?: CaptionEntries;
  readonly duration?: number | null | undefined;
}

// SRT 的时间是「时:分:秒,毫秒」，各段补零，逗号分隔毫秒。
export function formatSrtTimestamp(seconds: number | null | undefined): string {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const totalSeconds = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(totalSeconds / 3600), 2)}:${pad(Math.floor(totalSeconds / 60) % 60, 2)}:${pad(totalSeconds % 60, 2)},${pad(totalMs % 1000, 3)}`;
}

const SRT_MIN_SECONDS = 0.5;
const SRT_READ_SECONDS_PER_CHAR = 0.25;
const SRT_READ_MIN_SECONDS = 2;
const SRT_READ_MAX_SECONDS = 7;

/**
 * 每段的结束取它覆盖到的原始字幕里最晚的结束，但不越过下一段的开始；原始字幕的时长缺失时退到
 * 下一段的开始。最后一段没有下一段可退，原始字幕也没给结束时，按字数估一个阅读时长（2～7 秒），
 * 并且不超过视频时长。text 可以是多行（双语）；空行会被去掉，否则播放器会把它当成字幕结束。
 */
export function buildSrt(
  items: readonly (SrtItem | null | undefined)[] | null | undefined,
  { entries = [], duration = 0 }: SrtOptions = {},
): string {
  const itemList: readonly (SrtItem | null | undefined)[] = Array.isArray(items) ? items : [];
  const entryList: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  const cues = itemList
    .map((item) => ({
      start: Math.max(0, Number(item?.start) || 0),
      text: String(item?.text ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((cue) => cue.text);
  const lines = entryList.map((entry) => {
    const start = Math.max(0, Number(entry?.start) || 0);
    return { start, end: start + Math.max(0, Number(entry?.duration) || 0) };
  });
  const videoEnd = Number(duration) > 0 ? Number(duration) : Infinity;

  return cues
    .map((cue, index) => {
      const next = cues[index + 1];
      const nextStart = next ? Math.max(cue.start, next.start) : Infinity;
      let end = 0;
      for (const line of lines) {
        if (line.start < nextStart && line.end > cue.start) end = Math.max(end, line.end);
      }
      if (next) {
        end = end > cue.start ? Math.min(end, nextStart) : nextStart;
      } else if (!(end > cue.start)) {
        const reading = Math.min(
          SRT_READ_MAX_SECONDS,
          Math.max(SRT_READ_MIN_SECONDS, cue.text.length * SRT_READ_SECONDS_PER_CHAR),
        );
        end = Math.min(cue.start + reading, videoEnd > cue.start ? videoEnd : Infinity);
      }
      // 两段几乎同时开始时也留出能看清的时长，宁可和下一条略有重叠。
      end = Math.max(end, cue.start + SRT_MIN_SECONDS);
      return `${index + 1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(end)}\n${cue.text}\n`;
    })
    .join("\n");
}
