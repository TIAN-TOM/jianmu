// 概览的分块请求：每块一次模型请求，几个视频同时生成时共用一道并发闸门；部分块失败多半是偶发的超时或限流，
// 静默补一轮，确定性失败（配置、拒答、硬超时、响应过大、额度用完）不补，重跑只会再付一遍钱。
// 长视频每完成一块就把已完成的块合并成一份临时概览广播出去，只给界面先看，不落库。
import { analysisTimingVariables, estimateOutputTokens, mergeAnalyses, truncatedChunkRanges, withTruncatedRanges, type AnalysisChunk } from "../../../core/ai/chunking.ts";
import { parseLooseJson } from "../../../core/ai/parse.ts";
import { extractPromptSection, type PromptVariables } from "../../../core/ai/prompt.ts";
import { ANALYSIS_CHUNK } from "../../../core/ai/schemas.ts";
import { aiErrorResponse, throwIfTaskCanceled, type RetryNotice, type TransportError } from "../../../core/ai/transport/index.ts";
import { validateAnalysis, type Analysis } from "../../../core/ai/validate.ts";
import { mapWithConcurrency, type Limiter } from "../../../core/concurrency.ts";
import type { LearningAnalysis } from "../../../core/notes/markdown.ts";
import { formatTimestamp, type TranscriptSegment } from "../../../core/transcript/segment.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { TaskAi } from "../../ai.ts";
import type { TaskRun } from "../../tasks.ts";

export type Chunk = AnalysisChunk<TranscriptSegment>;

/** 一块的结果：章节和金句，正文被截断、靠补齐读出来时带标记。 */
export type ChunkPart = Analysis & { readonly truncated?: true };

/** 每块都要用的视频信息。 */
export interface PromptCommon {
  readonly videoTitle: string;
  readonly ownerName: string;
  readonly videoDescription: string;
}

/** 分块请求的错误：码给界面和补轮判断，noAutoRetry 是传输层已经为这一块重发过。 */
export type ChunkError = TransportError;

// 重跑也救不了的失败：配置、权限、拒绝回答、响应过大，以及硬超时（同样大小的块多半还会超时，被掐断的那次可能已经计费）。
const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  "TASK_CANCELED",
  "NO_AI_CONFIG",
  "NO_DATA_CONSENT",
  "NEED_HOST_PERMISSION",
  "INVALID_BASE_URL",
  "AI_REFUSED",
  "AI_RESPONSE_TOO_LARGE",
  "AI_REDIRECT_BLOCKED",
  "ANTHROPIC_WORKSPACE_REQUIRED",
  "AI_HARD_TIMEOUT",
]);
// 空响应里这几种成因，传输层已经按能自愈的办法试过（加码到顶、脱掉 JSON 模式），再调一次只是把同样的花费重付一遍。
const DETERMINISTIC_EMPTY: ReadonlySet<string> = new Set(["TRUNCATED", "REASONING_ONLY", "CONTENT_FILTERED", "PROTOCOL_MISMATCH", "NO_CHOICES", "NO_OUTPUT"]);

/** 失败块值不值得自动补一轮：只补可能是偶发的（限流、过载、5xx、空闲超时、连不上、读不出、这一段没产出有效条目）。 */
export function isTransientChunkFailure(error: unknown): boolean {
  const failure = (error ?? {}) as ChunkError;
  if (failure.noAutoRetry) return false;
  if (failure.code !== undefined && DETERMINISTIC_CODES.has(failure.code)) return false;
  if (failure.code === "EMPTY_AI_RESPONSE" && failure.reason !== undefined && DETERMINISTIC_EMPTY.has(failure.reason)) return false;
  const status = Number(failure.status);
  return !(status >= 400 && status < 500 && status !== 408 && status !== 429);
}

function coded(code: string, message: string, sends: number): ChunkError {
  const error: ChunkError = Object.assign(new Error(message), { code });
  // 传输层已经为这一块重发过（加码、脱掉 JSON 模式）：额度用掉了，补轮不再发。
  if (sends > 1) error.noAutoRetry = true;
  return error;
}

/** 失败块的原因：和整份失败同一套说法，记进失败区间，事后能查。 */
export function describeChunkFailure(error: unknown): string {
  return aiErrorResponse(error).message || (error instanceof Error ? error.message : "");
}

/** 提示词的两段：系统提示词和用户提示词。 */
export function promptMessages(markdown: string, variables: PromptVariables) {
  return [
    { role: "system" as const, content: extractPromptSection(markdown, "系统提示词", variables) },
    { role: "user" as const, content: extractPromptSection(markdown, "用户提示词", variables) },
  ];
}

export interface ChunkDeps {
  readonly ai: TaskAi;
  readonly prompt: string;
  readonly gate: Limiter;
  readonly concurrency: number;
  readonly log: Log;
}

interface ChunkRequest {
  readonly signal: AbortSignal;
  readonly onRetry: (notice: RetryNotice) => void;
  /** 自动补轮里的那一次：这一块的重试额度已经用在上一轮，传输层不再自己重发。 */
  readonly retryRound: boolean;
}

// 时长相关变量按本块区间算，好让模型只覆盖这一段。前情只当上下文，产出靠起点秒数限定在本块区间内。
async function analyzeChunk(deps: ChunkDeps, chunk: Chunk, chunkCount: number, common: PromptCommon, request: ChunkRequest): Promise<ChunkPart> {
  const timing = analysisTimingVariables(chunk.text, chunk.endSeconds);
  const rangeNote =
    chunkCount > 1
      ? `注意：这是长视频切分后的第 ${chunk.index + 1} / ${chunkCount} 段，覆盖 ${formatTimestamp(chunk.startSeconds)} 到 ` +
        `${formatTimestamp(chunk.endSeconds)}。只为这一段产出章节与金句，不要涉及其它时间段。`
      : "";
  const contextNote = chunk.contextText
    ? `\n前情回顾（上一段的结尾，只用来理解本段承接什么，不要为它开章节或挑金句）：\n${chunk.contextText}\n`
    : "";
  const variables = {
    ...common,
    ...timing,
    rangeNote,
    contextNote,
    startFormatted: formatTimestamp(chunk.startSeconds),
    minTimestampSeconds: chunk.startSeconds,
    transcriptText: chunk.text,
  };
  const { text, truncated, sends } = await deps.ai.requestAiCompletion({
    selfRetry: !request.retryRound,
    // 概览是摘要，产出远小于原文；按正文长度估算，前情只进输入不进输出。
    maxTokens: estimateOutputTokens(chunk.text.length, { ratio: 0.5, floor: 2048 }),
    responseFormat: ANALYSIS_CHUNK,
    signal: request.signal,
    onRetry: request.onRetry,
    messages: promptMessages(deps.prompt, variables),
  });
  let parsed: unknown;
  try {
    parsed = parseLooseJson(text);
  } catch {
    throw coded("ANALYSIS_PARSE_FAILED", "模型没有按要求返回结构化的概览，结果读不出来。", sends);
  }
  // 越界条目会被滤掉；滤完一条不剩不能算成功，否则这一段就悄悄缺了。记成失败块，自动补一轮，补不上就如实标出缺口。
  const result = validateAnalysis(parsed, timing.maxTimestampSeconds, chunk.startSeconds);
  if (!result.chapters.length && !result.keyQuotes.length) throw coded("EMPTY_CHUNK", "这一段没有产出有效的章节或金句。", sends);
  return truncated ? { ...result, truncated: true } : result;
}

export interface PlannedRun {
  readonly run: Pick<TaskRun, "signal" | "progress">;
  /** 进度条上的说法。 */
  readonly label: (done: number, total: number) => string;
  readonly phase: string;
  /** true：整份全军覆没时不补（多半是配置错误）；用户点「补失败块」时即使这一轮全失败也再给一次机会。 */
  readonly retryPartialOnly: boolean;
  readonly onChunkDone?: ((chunk: Chunk, part: ChunkPart) => void) | undefined;
}

/** 按块并发请求，偶发失败自动补一轮。停止时不抛：已经完成、付过费的块交回调用方保存。 */
export async function analyzePlannedChunks(
  deps: ChunkDeps,
  chunks: readonly Chunk[],
  chunkCount: number,
  common: PromptCommon,
  { run, label, phase, retryPartialOnly, onChunkDone }: PlannedRun,
): Promise<PromiseSettledResult<ChunkPart>[]> {
  const { signal } = run;
  // 限流或过载时传输层会等几秒重发一次：进度条说清在等什么，块数照旧。
  const onRetry = (notice: RetryNotice): void => run.progress({ message: notice.message });
  const analyzeOne = async (chunk: Chunk, retryRound: boolean): Promise<ChunkPart> => {
    // 排队中的块也认取消：用户点停止后立刻出队，不必等别的请求让出名额。
    const part = await deps.gate(
      deps.concurrency,
      () => {
        throwIfTaskCanceled(signal);
        return analyzeChunk(deps, chunk, chunkCount, common, { signal, onRetry, retryRound });
      },
      { signal },
    );
    try {
      onChunkDone?.(chunk, part);
    } catch (error) {
      // 临时概览只是给人先看，出错也不能把这块算成失败。
      deps.log.warn("临时概览广播失败", errorLabel(error));
    }
    return part;
  };
  const results = await mapWithConcurrency(chunks, deps.concurrency, (chunk) => analyzeOne(chunk, false), (done, total) =>
    run.progress({ done, total, phase, message: label(done, total) }),
  );
  if (signal.aborted) return results;

  const rejected = results.filter((result) => result.status === "rejected").length;
  const failedIndexes = results.flatMap((result, index) => (result.status === "rejected" && isTransientChunkFailure(result.reason) ? [index] : []));
  if (!failedIndexes.length || (retryPartialOnly && rejected >= chunks.length)) return results;
  run.progress({ done: chunks.length - rejected, total: chunks.length, phase: "retrying", message: `正在重试 ${failedIndexes.length} 个失败分块` });
  const retried = await mapWithConcurrency(
    failedIndexes.map((index) => chunks[index] as Chunk),
    deps.concurrency,
    (chunk) => analyzeOne(chunk, true),
  );
  failedIndexes.forEach((chunkIndex, i) => {
    const again = retried[i];
    if (again?.status === "fulfilled") results[chunkIndex] = again;
  });
  return results;
}

/** 成功的块。 */
export const partsOf = (results: readonly PromiseSettledResult<ChunkPart>[]): ChunkPart[] =>
  results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

/** 合并成一份概览：按时间排好、去重，被截断的块标出区间。 */
export function mergeChunks(chunks: readonly Chunk[], results: readonly PromiseSettledResult<ChunkPart>[], totalDuration: number): LearningAnalysis {
  return withTruncatedRanges(mergeAnalyses(partsOf(results), totalDuration), truncatedChunkRanges(chunks, results));
}

/** 长视频每完成一块，就把到目前为止完成的块按时间合并广播一份。只有一块的视频不发：它的临时概览就是最终结果。 */
export function previewReporter(
  chunks: readonly Chunk[],
  totalDuration: number,
  signal: AbortSignal,
  send: (analysis: LearningAnalysis, done: number, total: number) => void,
): ((chunk: Chunk, part: ChunkPart) => void) | undefined {
  if (chunks.length < 2) return undefined;
  const finished = new Map<number, { readonly chunk: Chunk; readonly part: ChunkPart }>();
  return (chunk, part) => {
    // 停止之后到的块不再广播，免得界面上又冒出新章节。
    if (signal.aborted) return;
    finished.set(chunk.index, { chunk, part });
    const done = [...finished.values()].sort((left, right) => left.chunk.index - right.chunk.index);
    const settled = done.map((entry) => ({ status: "fulfilled" as const, value: entry.part }));
    send(mergeChunks(done.map((entry) => entry.chunk), settled, totalDuration), finished.size, chunks.length);
  };
}
