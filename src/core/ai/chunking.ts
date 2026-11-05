// 概览分块、多块合并、失败补块，章节归类，翻译批次和输出预算。
import { formatTimestamp } from "../transcript/segment.ts";
import { validateAnalysis, type Analysis } from "./validate.ts";

// 元数据里的时长有时缺失或不准，取「元数据时长」与「字幕最后一个时间戳」的较大值。
export function analysisTimingVariables(
  transcriptTextTimestamped: string | null | undefined,
  videoDuration: unknown,
): { maxTimestampSeconds: number; durationFormatted: string; lateThreshold: string } {
  const stamps = String(transcriptTextTimestamped || "").match(/\[(\d+):(\d{2})\]/g) || [];
  let lastTranscriptSeconds = 0;
  const last = stamps[stamps.length - 1]?.match(/\[(\d+):(\d{2})\]/);
  if (last) {
    lastTranscriptSeconds = Number(last[1]) * 60 + Number(last[2]);
  }

  const effectiveSeconds = Math.max(
    Math.floor(Number(videoDuration) || 0),
    lastTranscriptSeconds,
  );

  return {
    maxTimestampSeconds: effectiveSeconds,
    durationFormatted: formatTimestamp(effectiveSeconds),
    // 「最后一章必须晚于 75%」这条硬要求，是逼模型覆盖全片、
    // 而不是把章节全堆在开头最有效的一招。
    lateThreshold: formatTimestamp(Math.floor(effectiveSeconds * 0.75)),
  };
}

export interface OutputBudget {
  readonly ratio?: number;
  readonly floor?: number;
  readonly ceiling?: number;
}

/**
 * 按输入长度估算输出 token 上限（ratio：改写接近 1，摘要远小于 1）。
 * max_tokens 是上限而非配额，给宽不花钱；但超过模型自身上限会被拒，
 * 所以给有余量的估算，不够时由调用方加码重试。
 */
export function estimateOutputTokens(
  inputChars: number,
  { ratio = 1, floor = 1024, ceiling = 8192 }: OutputBudget = {},
): number {
  const chars = Number.isFinite(inputChars) && inputChars > 0 ? inputChars : 0;
  // 中文约一字一 token；固定量留给 JSON 结构、id 和转义字符。
  const estimated = Math.ceil(chars * ratio) + 512;
  return Math.min(ceiling, Math.max(floor, estimated));
}

// 单块目标字数。长视频一次性生成概览容易撞超时；切小之后每次都快，还能并发。
export const ANALYSIS_CHUNK_CHARS = 6000;
// 略高于单块上限：刚过一点就切成两块并不划算，反而多一次往返。
export const ANALYSIS_SINGLE_CHARS = 8000;
// 每块开头附带的上一块结尾字数。横跨切点的话题两边都看得见，
// 边界处才不会各开一个半截章节；只作上下文，不为它产出条目。
export const ANALYSIS_OVERLAP_CHARS = 400;

export interface AnalysisSegment {
  readonly start?: number;
  readonly text: string;
}

export interface ChunkPlanOptions {
  readonly maxChars?: number;
  readonly singleChars?: number;
  readonly overlapChars?: number;
}

export interface AnalysisChunk<T extends AnalysisSegment = AnalysisSegment> {
  index: number;
  segments: T[];
  startSeconds: number;
  endSeconds: number;
  text: string;
  contextText: string;
}

// 按分段边界切块，保证每块内部的时间戳仍然连续可查。
export function planAnalysisChunks<T extends AnalysisSegment>(
  segments: readonly (T | null | undefined)[] | null | undefined,
  {
    maxChars = ANALYSIS_CHUNK_CHARS,
    singleChars = ANALYSIS_SINGLE_CHARS,
    overlapChars = ANALYSIS_OVERLAP_CHARS,
  }: ChunkPlanOptions = {},
): AnalysisChunk<T>[] {
  const source: readonly (T | null | undefined)[] = Array.isArray(segments) ? segments : [];
  const list = source.filter(
    (segment): segment is T => Boolean(segment && typeof segment.text === "string" && segment.text),
  );
  if (!list.length) return [];

  const totalChars = list.reduce((sum, segment) => sum + segment.text.length, 0);
  const groups: T[][] = [];

  if (totalChars <= singleChars) {
    groups.push(list);
  } else {
    let current: T[] = [];
    let chars = 0;
    for (const segment of list) {
      if (current.length && chars + segment.text.length > maxChars) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(segment);
      chars += segment.text.length;
    }
    if (current.length) groups.push(current);
  }

  const withTimestamps = (list: readonly T[]): string =>
    list.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n");

  return groups.map((group, index) => {
    const last = group[group.length - 1];
    return {
      index,
      segments: group,
      startSeconds: Math.floor(group[0]?.start || 0),
      // 末段的结束时间未知，用它的起点兜底；调用方会再跟视频总长取较大值。
      endSeconds: Math.floor(last?.start || 0),
      text: withTimestamps(group),
      contextText: withTimestamps(tailSegments(groups[index - 1], overlapChars)),
    };
  });
}

// 取一组分段末尾约 chars 个字，用作下一块的前情。至少给一段，
// 否则正好卡在边界的那句话反而是最缺上下文的一句。
function tailSegments<T extends AnalysisSegment>(group: readonly T[] | undefined, chars: number): T[] {
  if (!Array.isArray(group) || !group.length || chars <= 0) return [];
  const tail: T[] = [];
  let total = 0;
  for (let i = group.length - 1; i >= 0; i--) {
    tail.unshift(group[i]);
    total += group[i].text.length;
    if (total >= chars) break;
  }
  return tail;
}

export interface ChapterPart {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly timestampSeconds: number;
  readonly timestamp?: unknown;
}

export interface QuotePart {
  readonly quote: string;
  readonly timestampSeconds: number;
  readonly timestamp?: unknown;
}

export interface AnalysisPart {
  readonly chapters?: readonly ChapterPart[] | null;
  readonly keyQuotes?: readonly QuotePart[] | null;
}

// 合并各块概览。相邻块边界容易产出重复条目：章节按秒去重，金句按文本去重。
export function mergeAnalyses(
  parts: readonly (AnalysisPart | null | undefined)[] | null | undefined,
  maxSeconds: unknown,
): Analysis {
  const chapters: ChapterPart[] = [];
  const keyQuotes: QuotePart[] = [];
  const seenChapter = new Set<number>();
  const seenQuote = new Set<string>();

  const list: readonly (AnalysisPart | null | undefined)[] = Array.isArray(parts) ? parts : [];
  for (const part of list) {
    for (const chapter of part?.chapters || []) {
      if (seenChapter.has(chapter.timestampSeconds)) continue;
      seenChapter.add(chapter.timestampSeconds);
      chapters.push(chapter);
    }
    for (const quote of part?.keyQuotes || []) {
      const key = quote.quote.trim();
      if (seenQuote.has(key)) continue;
      seenQuote.add(key);
      keyQuotes.push(quote);
    }
  }

  // 合并后再走一次校验，顺带完成排序与上限裁剪。
  return validateAnalysis({ chapters, keyQuotes }, maxSeconds);
}

export interface ChunkSpan {
  readonly index: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/** 分块的结果，形状和 Promise.allSettled 的一项一样；value 只看截断标记。 */
export interface ChunkResult {
  readonly status?: string;
  readonly reason?: unknown;
  readonly value?: { readonly truncated?: unknown } | null;
}

export interface FailureRange {
  index: number;
  startSeconds: number;
  endSeconds: number;
  reason?: string;
}

export interface TimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/** 存过的区间，字段可能缺或类型不对。 */
export interface StoredRange {
  readonly index?: unknown;
  readonly startSeconds?: unknown;
  readonly endSeconds?: unknown;
}

type Chunks = readonly (ChunkSpan | null | undefined)[] | null | undefined;
type ChunkResults = readonly (ChunkResult | null | undefined)[] | null | undefined;
type StoredRanges = readonly (StoredRange | null | undefined)[] | null | undefined;

/**
 * describe（可选）把失败原因翻译成给人看的一句话，记进区间里。
 * 不记的话，事后只知道哪一段失败了，查不到为什么。
 */
export function chunkFailureRanges(
  chunks: Chunks,
  results: ChunkResults,
  describe?: (reason: unknown) => unknown,
): FailureRange[] {
  const list: readonly (ChunkResult | null | undefined)[] = Array.isArray(results) ? results : [];
  return list
    .map((result, index) => {
      if (result?.status !== "rejected") return null;
      const chunk = chunks?.[index];
      if (!chunk) return null;
      const range: FailureRange = {
        index: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
      };
      if (typeof describe === "function") {
        let reason = "";
        try {
          reason = String(describe(result.reason) || "");
        } catch {
          reason = "";
        }
        const error = result.reason as { readonly message?: unknown } | null | undefined;
        reason = (reason || String(error?.message || "")).trim().slice(0, 200);
        if (reason) range.reason = reason;
      }
      return range;
    })
    .filter((range) => range !== null);
}

/**
 * 正文被截断、靠补齐括号才解析出来的分块：那一段的章节和金句可能缺了尾巴。
 * 记下时间区间随概览保存，界面据此提示「这部分内容可能不完整」。
 * 只看成功的块；截断后一条有效条目都没有的块已经记成失败块了。
 */
export function truncatedChunkRanges(chunks: Chunks, results: ChunkResults): TimeRange[] {
  const list: readonly (ChunkResult | null | undefined)[] = Array.isArray(results) ? results : [];
  return list
    .map((result, index) => {
      if (result?.status !== "fulfilled" || !result.value?.truncated) return null;
      const chunk = chunks?.[index];
      if (!chunk) return null;
      return { startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds };
    })
    .filter((range) => range !== null);
}

/**
 * 把截断区间挂到概览上，没有就不留这个字段；没有这个字段时按没截断处理。
 * 补失败块时先去掉被重试区间里的旧记录，再接上这次重试的结果。
 */
export function withTruncatedRanges<T extends object>(
  analysis: T | null | undefined,
  ranges: readonly StoredRange[] | null | undefined,
  { replacing = [] }: { readonly replacing?: StoredRanges } = {},
): Omit<T, "truncatedRanges"> & { truncatedRanges?: StoredRange[] } {
  const { truncatedRanges: previous, ...rest } = (analysis || {}) as T & { readonly truncatedRanges?: unknown };
  const stored: readonly (StoredRange | null | undefined)[] = Array.isArray(previous) ? previous : [];
  const replaced: readonly (StoredRange | null | undefined)[] = Array.isArray(replacing) ? replacing : [];
  const kept = stored.filter(
    (range): range is StoredRange =>
      Boolean(range) &&
      typeof range === "object" &&
      !replaced.some(
        (chunk) =>
          Number(range?.startSeconds) < Number(chunk?.endSeconds) &&
          Number(range?.endSeconds) > Number(chunk?.startSeconds),
      ),
  );
  const added: readonly StoredRange[] = Array.isArray(ranges) ? ranges : [];
  const merged = [...kept, ...added].sort(
    (left, right) => Number(left.startSeconds) - Number(right.startSeconds),
  );
  return (merged.length ? { ...rest, truncatedRanges: merged } : rest) as Omit<T, "truncatedRanges"> & {
    truncatedRanges?: StoredRange[];
  };
}

export function chunksForFailureRanges<T extends ChunkSpan>(
  chunks: readonly T[] | null | undefined,
  ranges: StoredRanges,
): T[] {
  const list: readonly T[] = Array.isArray(chunks) ? chunks : [];
  const stored: readonly (StoredRange | null | undefined)[] = Array.isArray(ranges) ? ranges : [];
  const fails = stored.filter((range): range is StoredRange => Boolean(range) && typeof range === "object");
  if (!fails.length) return [];
  return list.filter((chunk) =>
    fails.some((range) => {
      if (Number(range.index) === chunk.index && Number(range.startSeconds) === chunk.startSeconds) {
        return true;
      }
      const start = Math.max(0, Number(range.startSeconds) || 0);
      const end = Math.max(start, Number(range.endSeconds) || start);
      // 上界取严格小于：切段允许同一秒内开新块，邻居块的 startSeconds
      // 可能与失败块 endSeconds 相同——包含式判断会把没失败的邻居连带
      // 选中，重试合并时把它的好章节一并删掉。失败块自身命中走上面的
      // 精确分支，不依赖这个区间判断。
      return chunk.startSeconds < end && chunk.endSeconds > start;
    }),
  );
}

function timestampInRanges(seconds: unknown, ranges: StoredRanges): boolean {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return false;
  const list: readonly (StoredRange | null | undefined)[] = Array.isArray(ranges) ? ranges : [];
  return list.some((range) => {
    const start = Math.max(0, Number(range?.startSeconds) || 0);
    const end = Math.max(start, Number(range?.endSeconds) || start);
    // 上界严格小于：区间端点可能与相邻块的起始秒重合，包含式判断会把
    // 没有失败、也没被重试的邻居章节连带删掉。被重试块自己的边界章节
    // 不会被误删——重试结果在 mergeAnalyses 里按精确秒去重。
    return value >= start && value < end;
  });
}

export function mergeRetryIntoAnalysis(
  existing: AnalysisPart | null | undefined,
  incomingParts: readonly (AnalysisPart | null | undefined)[] | null | undefined,
  retriedRanges: StoredRanges,
  maxSeconds: unknown,
): Analysis {
  const current: AnalysisPart = existing && typeof existing === "object" ? existing : {};
  const kept = {
    chapters: (current.chapters || []).filter(
      (item) => !timestampInRanges(item?.timestampSeconds, retriedRanges),
    ),
    keyQuotes: (current.keyQuotes || []).filter(
      (item) => !timestampInRanges(item?.timestampSeconds, retriedRanges),
    ),
  };
  return mergeAnalyses([kept, ...(Array.isArray(incomingParts) ? incomingParts : [])], maxSeconds);
}

interface Timed {
  readonly timestampSeconds?: unknown;
}

/**
 * 把金句按时间戳归入章节，形成「章节 → 金句」的层次结构。
 *
 * 不依赖模型显式给出归属：章节与金句的时间戳都出自同一份字幕、同一个模型，
 * 归类的误差很小；即便偶尔错一档也只是语境偏差，不至于张冠李戴。
 * 章节需按时间升序（validateAnalysis 已保证）。金句落到最后一个
 * start <= 自己时间戳的章节；落在第一章之前的归为 orphan，由调用方
 * 决定怎么展示（单列「其他金句」，比硬塞进最近的章节诚实）。
 */
export function groupQuotesIntoChapters<C extends Timed, Q extends Timed>(
  chapters: readonly (C | null | undefined)[] | null | undefined,
  quotes: readonly (Q | null | undefined)[] | null | undefined,
): { grouped: { chapter: C; quotes: Q[] }[]; orphans: Q[] } {
  const chapterSource: readonly (C | null | undefined)[] = Array.isArray(chapters) ? chapters : [];
  const quoteSource: readonly (Q | null | undefined)[] = Array.isArray(quotes) ? quotes : [];
  const chapterList = chapterSource.filter(
    (chapter): chapter is C => Number.isFinite(Number(chapter?.timestampSeconds)),
  );
  const quoteList = quoteSource.filter(
    (quote): quote is Q => Number.isFinite(Number(quote?.timestampSeconds)),
  );

  const grouped = chapterList.map((chapter) => ({ chapter, quotes: [] as Q[] }));
  const orphans: Q[] = [];

  for (const quote of quoteList) {
    const seconds = Number(quote.timestampSeconds);
    let owner = -1;
    for (let i = 0; i < chapterList.length; i += 1) {
      if (Number(chapterList[i]?.timestampSeconds) <= seconds) owner = i;
      else break;
    }
    if (owner >= 0) grouped[owner]?.quotes.push(quote);
    else orphans.push(quote);
  }

  return { grouped, orphans };
}

// 把字幕分段切成翻译批次送给模型。批次太大模型容易漏条或越译越简，太小则费用上去了；
// 翻译要重新组织整句，所以批次取小。条数和字数双上限：B 站分段长度差异大，只看条数会让某些批次过长。
const TRANSLATION_BATCH_MAX_SEGMENTS = 4;
const TRANSLATION_BATCH_MAX_CHARS = 1200;

export interface TranslationSegment {
  readonly id?: unknown;
  readonly text?: unknown;
}

export interface TranslationItem {
  id: string;
  text: string;
}

export function planTranslationBatches(
  segments: readonly (TranslationSegment | null | undefined)[] | null | undefined,
): TranslationItem[][] {
  const batches: TranslationItem[][] = [];
  let current: TranslationItem[] = [];
  let chars = 0;
  const list: readonly (TranslationSegment | null | undefined)[] = Array.isArray(segments) ? segments : [];

  for (const segment of list) {
    const text = String(segment?.text || "");
    if (!text) continue;

    const wouldOverflow =
      current.length >= TRANSLATION_BATCH_MAX_SEGMENTS ||
      (current.length > 0 && chars + text.length > TRANSLATION_BATCH_MAX_CHARS);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    // 单条就超长时让它自己占一批，而不是被丢掉。
    current.push({ id: String(segment?.id), text });
    chars += text.length;
  }

  if (current.length) batches.push(current);
  return batches;
}
