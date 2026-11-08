// 时间轨的版面：把章节或分块进度、重点、播放位置换算成沿轨道的比例，组件只照着画。
// 数据不够（不知道时长、没有落在时长里的章节）就只剩一根细线，不编分段。
import { keyStartSet } from "./chapters.ts";

export interface RailChapter {
  readonly startSec: number;
  readonly title: string;
}

export type RailBlockState = "pending" | "writing" | "done" | "failed";

/** 分块生成时的一块。 */
export interface RailBlock {
  readonly startSec: number;
  readonly endSec: number;
  readonly state: RailBlockState;
}

export interface RailInput {
  readonly durationSec: number | null | undefined;
  readonly chapters?: readonly RailChapter[] | undefined;
  /** 有分块进度时画分块，不画章节；生成中不显示重点。 */
  readonly blocks?: readonly RailBlock[] | undefined;
  readonly keyStarts?: readonly number[] | undefined;
  /** 悬停或当前章节，按 chapters 里的序号。 */
  readonly focusIndex?: number | null | undefined;
  readonly positionSec?: number | null | undefined;
}

export type RailPieceKind = "chapter" | RailBlockState;

export interface RailPiece {
  /** 在 chapters 或 blocks 里的序号，和章节列表对得上。 */
  readonly index: number;
  readonly kind: RailPieceKind;
  readonly startSec: number;
  /** 起点和长度，占全长的比例。 */
  readonly start: number;
  readonly size: number;
  /** 这一段里已经播过的比例。 */
  readonly played: number;
  readonly key: boolean;
  readonly focus: boolean;
  /** 悬停提示，分块没有。 */
  readonly title: string;
}

export interface RailLayout {
  readonly pieces: readonly RailPiece[];
  /** 播放头的位置，不知道播放位置时是 null。 */
  readonly playhead: number | null;
}

const EMPTY: RailLayout = Object.freeze({ pieces: Object.freeze([]), playhead: null });

const isSecond = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function playedWithin(startSec: number, endSec: number, positionSec: number | null): number {
  if (positionSec === null || endSec <= startSec) return 0;
  return clamp01((positionSec - startSec) / (endSec - startSec));
}

function chapterPieces(input: RailInput, durationSec: number, positionSec: number | null): RailPiece[] {
  const keys = keyStartSet(input.keyStarts);
  const seen = new Set<number>();
  const valid = (input.chapters ?? [])
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => isSecond(chapter?.startSec) && chapter.startSec < durationSec)
    .sort((a, b) => a.chapter.startSec - b.chapter.startSec || a.index - b.index)
    .filter(({ chapter }) => {
      // 同一秒开头的两章只画第一章，不让两段叠在一起。
      if (seen.has(chapter.startSec)) return false;
      seen.add(chapter.startSec);
      return true;
    });
  return valid.map(({ chapter, index }, order) => {
    const endSec = valid[order + 1]?.chapter.startSec ?? durationSec;
    return {
      index,
      kind: "chapter",
      startSec: chapter.startSec,
      start: chapter.startSec / durationSec,
      size: (endSec - chapter.startSec) / durationSec,
      played: playedWithin(chapter.startSec, endSec, positionSec),
      key: keys.has(chapter.startSec),
      focus: input.focusIndex === index,
      title: String(chapter.title ?? ""),
    };
  });
}

function blockPieces(blocks: readonly RailBlock[], durationSec: number, positionSec: number | null): RailPiece[] {
  return blocks.flatMap((block, index) => {
    if (!isSecond(block?.startSec) || !isSecond(block.endSec) || block.startSec >= durationSec) return [];
    const endSec = Math.min(block.endSec, durationSec);
    if (endSec <= block.startSec) return [];
    return [
      {
        index,
        kind: block.state,
        startSec: block.startSec,
        start: block.startSec / durationSec,
        size: (endSec - block.startSec) / durationSec,
        played: block.state === "done" ? playedWithin(block.startSec, endSec, positionSec) : 0,
        key: false,
        focus: false,
        title: "",
      },
    ];
  });
}

export function railLayout(input: RailInput): RailLayout {
  const durationSec = input.durationSec;
  if (!isSecond(durationSec) || durationSec === 0) return EMPTY;
  const positionSec = isSecond(input.positionSec) ? Math.min(input.positionSec, durationSec) : null;
  const pieces = input.blocks?.length
    ? blockPieces(input.blocks, durationSec, positionSec)
    : chapterPieces(input, durationSec, positionSec);
  return { pieces, playhead: positionSec === null ? null : positionSec / durationSec };
}

/** 比例写成样式里的百分数，保留三位小数，长视频里一两秒的段也画得出来。 */
export function percent(fraction: number): string {
  return `${Number((clamp01(fraction) * 100).toFixed(3))}%`;
}
