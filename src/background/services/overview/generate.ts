// 概览生成和补失败块：取字幕快照、分块请求、合并、落库、写结论。部分块失败照样出结果，如实记下失败区间；
// 全军覆没多半是配置错误，把第一个真实错误交回去。用户点停止时，已经完成、付过费的块照常落库，被停掉的记成失败块，
// 不再写结论；重新生成已有的概览时停下不覆盖原来那份；因为清除本机数据停下的什么也不写。
import { chunkFailureRanges, chunksForFailureRanges, mergeRetryIntoAnalysis, planAnalysisChunks, truncatedChunkRanges, withTruncatedRanges, type ChunkPlanOptions, type FailureRange, type StoredRange } from "../../../core/ai/chunking.ts";
import { throwIfTaskCanceled } from "../../../core/ai/transport/index.ts";
import { isInputTooLong } from "../../../core/ai/too-long.ts";
import { hasAnalysisContent } from "../../../core/ai/verdict.ts";
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import type { Limiter } from "../../../core/concurrency.ts";
import { fail, isErrorCode, ok, type Failure, type Result } from "../../../core/errors.ts";
import type { LearningAnalysis } from "../../../core/notes/markdown.ts";
import { normalizeAnalysisFailures, overviewTranscriptBasis, type Basis, type OverviewPart, type OverviewRecord } from "../../../core/notes/records.ts";
import { genInfo } from "../../../core/tasks.ts";
import { localizePrompt } from "../../../core/ai/prompt.ts";
import { outputLangOf, type OutputLang } from "../../../core/output-lang.ts";
import { parseVideoKey, type VideoKey } from "../../../core/video-ref.ts";
import type { Broadcast } from "../../../shared/messages.ts";
import type { OverviewResultView } from "../../../shared/messages/overview.ts";
import type { TranscriptView } from "../../../shared/messages/transcript.ts";
import { aiFailure } from "../../ai.ts";
import { errorLabel, type Log } from "../../log.ts";
import { progressText } from "../../progress-text.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TaskRun } from "../../tasks.ts";
import type { TranscriptService } from "../transcript/index.ts";
import { analyzePlannedChunks, describeChunkFailure, mergeChunks, partsOf, previewReporter, type Chunk, type ChunkDeps, type ChunkPart, type PromptCommon } from "./chunks.ts";
import { commentStage } from "./comment-stage.ts";
import { concludeOverview, VERDICT_PROMPT } from "./conclude.ts";
import { COMMENT_VERDICT_PROMPT } from "./conclude-comments.ts";
import type { CommentRead } from "../comments.ts";
import type { CommentMaterial } from "../../../core/ai/comments.ts";
import { CLEARED, createPersist, type ChapterWrite, type Saved, type SnapshotFields } from "./persist.ts";

export const ANALYSIS_PROMPT = "skim/chapters.md";
const VERDICT_FEATURE = "verdict";
// 评论区那一步（PRD F23）：关掉开关的构建里连同读评论、带评论区的提示词一起裁掉。
const commentSteps = FEATURE_COMMENTS ? commentStage : null;
const commentPromptFile = FEATURE_COMMENTS ? COMMENT_VERDICT_PROMPT : null;

export interface GenerateDeps {
  readonly transcript: Pick<TranscriptService, "ensure">;
  readonly overviews: Pick<OverviewStore, "find" | "updateRecord">;
  readonly guard: ClearGuard;
  readonly prompt: (file: string) => string;
  /** 概览分块的大小，按设置。 */
  /** 分块大小；whole 是选了「尽量整份」，块太大失败时报错里提示换档。 */
  readonly chunkOptions: () => Promise<ChunkPlanOptions & { readonly whole?: boolean }>;
  /** 几个视频同时生成时共用的并发闸门。 */
  readonly gate: Limiter;
  readonly concurrency: number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
  readonly now: () => number;
  /** 读评论区（PRD F23）；构建开关关着时没有。 */
  readonly comments?: CommentRead | undefined;
}

interface Job {
  readonly run: TaskRun;
  readonly taskId: string;
  readonly video: VideoKey;
  readonly since: ClearEpoch | undefined;
  /** 这次生成要读评论区：卡片、侧边栏点的，打开就出结论。YouTube 经这个标签页读。 */
  readonly comments?: { readonly tabId?: number | undefined } | undefined;
}


/** 生成时依据的：这次读到的那份字幕。 */
type TranscriptBasis = Extract<Basis, { readonly source: "transcript" }>;

const reasonCode = (signal: AbortSignal): unknown => (signal.reason as { readonly code?: unknown } | null | undefined)?.code;

/** 只带失败本身，不带取字幕失败时顺手带回的视频信息、字幕轨这些。 */
const bare = ({ code, detail, retryAfterSec }: Failure): Failure => ({
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail }),
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

// 「尽量整份」的块太大时常见的两种失败：等太久被掐断，或者模型一次装不下。
const TOO_BIG_CODES: ReadonlySet<unknown> = new Set(["AI_HARD_TIMEOUT", "AI_IDLE_TIMEOUT"]);
const tooBig = (error: unknown): boolean => TOO_BIG_CODES.has((error as { readonly code?: unknown } | null)?.code) || isInputTooLong(error);

/**
 * 抛出来的错误换成结果：概览自己的码照用，其余按模型服务的错误归类。
 * 选了「尽量整份」又是块太大的那类失败时，单独报，下一步提示换回别的档。
 */
function failureOf(error: unknown, lang: OutputLang, whole = false): Failure {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (whole && tooBig(error)) return fail("WHOLE_CHUNK_TOO_BIG");
  if (code === "EMPTY_CHUNK") return fail("EMPTY_ANALYSIS");
  if (code === "ANALYSIS_PARSE_FAILED" && isErrorCode(code)) return fail(code);
  return aiFailure(error, lang);
}

function storedView(video: VideoKey, record: OverviewRecord): OverviewResultView {
  const failures = normalizeAnalysisFailures(record.analysisFailures);
  const transcriptBasis = overviewTranscriptBasis(record.parts);
  return { video, analysis: record.analysis, analysisFailures: failures, ...(transcriptBasis ? { transcriptBasis } : {}), fromCache: true, failedChunks: failures.length };
}

function commonOf(view: TranscriptView): PromptCommon {
  return { videoTitle: view.info.title || "未知", ownerName: view.info.author || "未知", videoDescription: view.info.description || "（无简介）" };
}

export function createGenerator(deps: GenerateDeps) {
  const persist = createPersist({ overviews: deps.overviews, now: deps.now, log: deps.log });
  const comments = commentSteps?.(deps.comments);

  // 用户点停止或清除本机数据不是故障：不往日志里报错。
  function logFailure(label: string, error: unknown, signal: AbortSignal): void {
    if ((error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED" || signal.aborted) return;
    deps.log.error(`${label}失败`, errorLabel(error));
  }

  // 清除本机数据时在途任务按这个原因取消，开头记下的代数也变了：已完成的块也不落库，免得把刚清掉的写回去。
  const dataCleared = (job: Job): boolean => reasonCode(job.run.signal) === "LOCAL_DATA_CLEARED" || deps.guard.clearedSince(job.since, "all");

  function chunkDeps(job: Job): ChunkDeps {
    return { ai: job.run.ai, prompt: localizePrompt(deps.prompt(ANALYSIS_PROMPT), outputLangOf(job.run.gen)), gate: deps.gate, concurrency: deps.concurrency, log: deps.log };
  }

  async function snapshotOf(job: Job): Promise<Result<TranscriptView>> {
    const ref = parseVideoKey(job.video);
    if (!ref) return fail("INVALID_REQUEST");
    const snapshot = await deps.transcript.ensure(ref);
    return snapshot.ok ? ok(snapshot.value.view) : bare(snapshot);
  }

  interface Finishing {
    readonly fields: SnapshotFields;
    readonly analysis: LearningAnalysis;
    readonly failures: readonly FailureRange[];
    readonly basis: TranscriptBasis;
    readonly common: PromptCommon;
    readonly totalDuration: number;
    readonly chunkCount: number;
    /** 重新生成已有的概览：章节先写草稿。 */
    readonly regenerating: boolean;
    /** 补失败块一块都没补上时不重写结论。 */
    readonly conclude: boolean;
    /** 这次读的评论，和分块请求同时在读；写结论前等它。 */
    readonly comments?: Promise<CommentMaterial | undefined> | undefined;
  }

  function resultOf(job: Job, saved: Saved, chunkCount: number, extra: Partial<OverviewResultView> = {}): OverviewResultView {
    return {
      video: job.video,
      analysis: saved.analysis,
      analysisFailures: [...saved.analysisFailures],
      ...(saved.transcriptBasis ? { transcriptBasis: saved.transcriptBasis } : {}),
      fromCache: false,
      failedChunks: saved.analysisFailures.length,
      chunkCount,
      ...(saved.saveFailed ? { saveFailed: true } : {}),
      ...extra,
    };
  }

  // 章节先落库，再单独写结论：结论阶段失败或被停，付过费的章节都已经保存。
  async function finish(job: Job, work: Finishing): Promise<Result<OverviewResultView>> {
    const { run, video } = job;
    const part: OverviewPart = { derived: { basis: work.basis, gen: genInfo(run.gen) }, taskCreatedAt: run.createdAt };
    const write: ChapterWrite = { analysis: work.analysis, failures: work.failures, part };
    const first = work.regenerating ? await persist.draft(work.fields, write, job.since) : await persist.chapters(work.fields, write, job.since);
    if (first === CLEARED) return fail("TASK_CANCELED");
    const intended: Saved = { analysis: work.analysis, analysisFailures: [...work.failures] };
    // 草稿写进去了：生效的仍是原来那份；草稿没写进去时交回这次生成的，标明没存上。
    const shown = work.regenerating && first.saveFailed ? { ...intended, saveFailed: true as const } : first;
    // 更晚创建的任务已经写了章节：这次的结论放不上去，不再为它花一次请求。
    if (first.superseded) return ok(resultOf(job, first, work.chunkCount));
    if (!work.regenerating && !first.saveFailed) deps.broadcast({ type: "overview.updated", video, verdictPending: true });
    // 只有金句没有章节的也写结论：重新生成时草稿要靠结论换上，不然这次付过费的内容一直留在草稿里。
    if (!work.conclude || (!work.analysis.chapters?.length && !work.analysis.keyQuotes?.length)) return ok(resultOf(job, shown, work.chunkCount));

    const verdictStage = run.stage(VERDICT_FEATURE);
    const material = work.comments ? await work.comments : undefined;
    const concluded = await concludeOverview(
      {
        ai: verdictStage.ai,
        prompt: deps.prompt(VERDICT_PROMPT),
        // 读到了足够的评论、真要发给模型时才取带评论区的提示词。
        ...(commentPromptFile ? { commentPrompt: () => deps.prompt(commentPromptFile) } : {}),
        outputLang: outputLangOf(verdictStage.gen),
        gate: deps.gate,
        concurrency: deps.concurrency,
        log: deps.log,
      },
      work.analysis,
      work.failures,
      { common: work.common, title: work.fields.title, totalDuration: work.totalDuration, signal: run.signal, progress: (message) => run.progress({ done: 1, total: 1, phase: "verdict", message }), comments: material },
    );
    const chapterStarts = (work.analysis.chapters ?? []).map((chapter) => Number(chapter.timestampSeconds));
    const outcome = comments && "verdict" in concluded ? { verdict: comments.carry(concluded.verdict, work.analysis.verdict, chapterStarts) } : concluded;
    const draftKept = work.regenerating && !first.saveFailed;
    if (!("verdict" in outcome)) {
      const flags = { ...("canceled" in outcome ? { verdictCanceled: true as const } : {}), ...(draftKept ? { draftKept: true as const } : {}) };
      return ok(resultOf(job, shown, work.chunkCount, flags));
    }
    const verdictPart: OverviewPart = { derived: { basis: work.basis, gen: genInfo(verdictStage.gen) }, taskCreatedAt: run.createdAt };
    const verdictWrite = { verdict: outcome.verdict, part: verdictPart, chaptersCreatedAt: run.createdAt, fromDraft: work.regenerating };
    const withVerdict: Saved = { analysis: { ...work.analysis, verdict: outcome.verdict }, analysisFailures: [...work.failures] };
    // 章节那次没存上的，这次连同章节一起写；写上了就不算没存上。
    const second = await persist.verdict(work.fields, verdictWrite, withVerdict, job.since, first.saveFailed ? write : undefined);
    if (second === CLEARED) return fail("TASK_CANCELED");
    if (!second.superseded && !second.saveFailed) deps.broadcast({ type: "overview.updated", video, verdictPending: false });
    return ok(resultOf(job, second, work.chunkCount));
  }

  // 停止时：已经完成的块并进来存下，没完成的（含被停掉的）记成失败块，之后「补失败块」只补剩下的。
  async function savePartial(job: Job, fields: SnapshotFields, analysis: LearningAnalysis, failures: readonly FailureRange[], basis: TranscriptBasis, counts: { saved: number; chunks: number }): Promise<Result<OverviewResultView>> {
    const part: OverviewPart = { derived: { basis, gen: genInfo(job.run.gen) }, taskCreatedAt: job.run.createdAt };
    const saved = await persist.chapters(fields, { analysis, failures, part }, job.since);
    if (saved === CLEARED) return fail("TASK_CANCELED");
    if (!saved.superseded && !saved.saveFailed) deps.broadcast({ type: "overview.updated", video: job.video, verdictPending: false });
    return ok(resultOf(job, saved, counts.chunks, { canceled: true, savedChunks: counts.saved }));
  }

  // 全军覆没：每块都只是没产出有效条目时按空概览报，提示重试；否则抛出第一个真实错误，它比「生成失败」有用得多。
  function allFailed(results: readonly PromiseSettledResult<ChunkPart>[]): Failure {
    const reasons = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    const code = (reason: unknown): unknown => (reason as { readonly code?: unknown } | null)?.code;
    if (reasons.length && reasons.every((reason) => code(reason) === "EMPTY_CHUNK")) return fail("EMPTY_ANALYSIS");
    throw reasons.find((reason) => code(reason) !== "EMPTY_CHUNK") ?? reasons[0] ?? new Error("概览生成失败。");
  }

  const totalOf = (view: TranscriptView, chunks: readonly Chunk[]): number => Math.max(Math.floor(Number(view.info.durationSec) || 0), chunks.at(-1)?.endSeconds ?? 0);
  const basisOf = (view: TranscriptView): TranscriptBasis => ({ source: "transcript", transcript: view.transcript.ref });
  const fieldsOf = (job: Job, view: TranscriptView): SnapshotFields => ({ video: job.video, title: view.info.title, author: view.info.author });

  return {
    async generate(job: Job, fresh: boolean): Promise<Result<OverviewResultView>> {
      // 只有官方总结写的结论、没有章节和金句时，不算已经有概览，照常生成。
      const existing = await deps.overviews.find(job.video);
      if (!fresh && existing && hasAnalysisContent(existing.analysis)) return ok(storedView(job.video, existing));
      const snapshot = await snapshotOf(job);
      if (!snapshot.ok) return snapshot;
      const view = snapshot.value;
      const { run } = job;
      let whole = false;
      try {
        throwIfTaskCanceled(run.signal);
        const options = await deps.chunkOptions();
        whole = options.whole === true;
        const chunks = planAnalysisChunks(view.transcript.segments, options);
        if (!chunks.length) return fail("NO_TRANSCRIPT");
        // 评论和分块请求同时读，写结论之前才等它；不读的任务这里是 undefined。
        const commentsRead = comments?.start({ video: job.video, signal: run.signal, comments: job.comments });
        const common = commonOf(view);
        const totalDuration = totalOf(view, chunks);
        const say = progressText(outputLangOf(run.gen));
        run.progress({ done: 0, total: chunks.length, phase: "generating", message: say.overviewChunk(0, chunks.length) });
        const results = await analyzePlannedChunks(chunkDeps(job), chunks, chunks.length, common, {
          run,
          phase: "generating",
          label: say.overviewChunk,
          retryPartialOnly: true,
          onChunkDone: previewReporter(chunks, totalDuration, run.signal, (analysis, done, total) =>
            deps.broadcast({ type: "overview.preview", video: job.video, taskId: job.taskId, analysis, done, total }),
          ),
        });
        const parts = partsOf(results);
        const remaining = chunkFailureRanges(chunks, results, (reason) => describeChunkFailure(reason, outputLangOf(run.gen)));
        const regenerating = existing !== null && hasAnalysisContent(existing.analysis);
        if (run.signal.aborted) {
          // 重新生成时停下：不拿残缺的结果覆盖原来那份。一块都没完成、因为清除本机数据停下的，什么也不存。
          if (regenerating || !parts.length || dataCleared(job)) return fail("TASK_CANCELED");
          const counts = { saved: parts.length, chunks: chunks.length };
          return await savePartial(job, fieldsOf(job, view), mergeChunks(chunks, results, totalDuration), remaining, basisOf(view), counts);
        }
        if (!parts.length) return allFailed(results);
        run.progress({ done: chunks.length, total: chunks.length, phase: "merging", message: say.merging });
        const analysis = mergeChunks(chunks, results, totalDuration);
        if (!analysis.chapters?.length && !analysis.keyQuotes?.length) return fail("EMPTY_ANALYSIS");
        const finishing = { fields: fieldsOf(job, view), analysis, failures: remaining, basis: basisOf(view), common, totalDuration, chunkCount: chunks.length, regenerating, conclude: true, comments: commentsRead };
        return await finish(job, finishing);
      } catch (error) {
        logFailure("概览生成", error, run.signal);
        return failureOf(error, outputLangOf(run.gen), whole);
      }
    },

    async retryFailed(job: Job): Promise<Result<OverviewResultView>> {
      const existing = await deps.overviews.find(job.video);
      const snapshot = await snapshotOf(job);
      if (!snapshot.ok) return snapshot;
      const view = snapshot.value;
      if (!existing || !hasAnalysisContent(existing.analysis)) return fail("NO_ANALYSIS");
      const stored = normalizeAnalysisFailures(existing.analysisFailures);
      if (!stored.length) return ok(storedView(job.video, existing));
      // 生效的章节依据的字幕和现在的对不上（换过语言、导入过字幕文件），或是旧备份导入的、依据未知：
      // 按区间补会拼出两份字幕的混合，要重新生成。
      const basis = existing.parts?.chapters?.derived.basis;
      if (basis?.source === "legacy-unknown") return fail("FAILED_CHUNKS_MISMATCH");
      if (basis?.source === "transcript" && basis.transcript.fingerprint !== view.transcript.ref.fingerprint) return fail("FAILED_CHUNKS_MISMATCH");
      // 已有的章节是用另一种语言写的：补上的块会和它们混成两种语言，同样要重新生成。
      const chaptersGen = existing.parts?.chapters?.derived.gen;
      if (outputLangOf(chaptersGen) !== outputLangOf(job.run.gen)) return fail("FAILED_CHUNKS_MISMATCH");
      const { run } = job;
      let whole = false;
      try {
        throwIfTaskCanceled(run.signal);
        const options = await deps.chunkOptions();
        whole = options.whole === true;
        const chunks = planAnalysisChunks(view.transcript.segments, options);
        const selected = chunksForFailureRanges(chunks, stored);
        if (!selected.length) return fail("FAILED_CHUNKS_MISMATCH");
        const common = commonOf(view);
        const totalDuration = totalOf(view, chunks);
        const say = progressText(outputLangOf(run.gen));
        run.progress({ done: 0, total: selected.length, phase: "retrying", message: say.refillChunk(0, selected.length) });
        const results = await analyzePlannedChunks(chunkDeps(job), selected, chunks.length, common, {
          run,
          phase: "retrying",
          label: say.refillChunk,
          retryPartialOnly: false,
        });
        const parts = partsOf(results);
        // 「尽量整份」补块一块都没补上、又是块太大的那类失败：照样报出来提示换档，存着的概览不动。
        if (whole && !parts.length && !run.signal.aborted && results.some((result) => result.status === "rejected" && tooBig(result.reason))) {
          return fail("WHOLE_CHUNK_TOO_BIG");
        }
        const remaining = chunkFailureRanges(selected, results, (reason) => describeChunkFailure(reason, outputLangOf(run.gen)));
        // 合并只换被重试的区间；截断记录沿用旧的，被重试的区间换成这次的。结论先留着，补全后再重写。
        const previous = (existing.analysis as { readonly truncatedRanges?: readonly StoredRange[] }).truncatedRanges;
        const merged = withTruncatedRanges(
          { ...mergeRetryIntoAnalysis(existing.analysis, parts, selected, totalDuration), ...(previous ? { truncatedRanges: previous } : {}) },
          truncatedChunkRanges(selected, results),
          { replacing: selected },
        );
        const analysis: LearningAnalysis = parts.length ? { ...merged, ...(existing.analysis.verdict ? { verdict: existing.analysis.verdict } : {}) } : existing.analysis;
        if (run.signal.aborted) {
          if (!parts.length || dataCleared(job)) return fail("TASK_CANCELED");
          return await savePartial(job, fieldsOf(job, view), analysis, remaining, basisOf(view), { saved: parts.length, chunks: selected.length });
        }
        run.progress({ done: selected.length, total: selected.length, phase: "merging", message: remaining.length ? say.refillIncomplete : say.merging });
        const finishing = { fields: fieldsOf(job, view), analysis, failures: remaining, basis: basisOf(view), common, totalDuration, chunkCount: selected.length, regenerating: false, conclude: parts.length > 0 };
        const done = await finish(job, finishing);
        return done.ok ? ok({ ...done.value, recoveredChunks: parts.length }) : done;
      } catch (error) {
        logFailure("补失败块", error, run.signal);
        return failureOf(error, outputLangOf(run.gen), whole);
      }
    },
  };
}

export type Generator = ReturnType<typeof createGenerator>;
export type { Job };
