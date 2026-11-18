// 问答：本地检索、生成、引用校验、存进问答历史。每次提问只看当前字幕和问题本身，历史只作记录不回喂模型。
// 防编造的第三道：回答里没有一个落在送给模型的字幕范围内的引用，整条换成兜底文案。
// 回答只写进发起时那个视频的历史；等模型的工夫侧边栏换了视频也一样。
import type { ChunkPlanOptions } from "../../core/ai/chunking.ts";
import { planAnalysisChunks } from "../../core/ai/chunking.ts";
import { parseLooseJson } from "../../core/ai/parse.ts";
import { extractPromptSection, type PromptVariables } from "../../core/ai/prompt.ts";
import type { ChatMessage, MessagePart } from "../../core/ai/provider/index.ts";
import { QA_ANSWER } from "../../core/ai/schemas.ts";
import { throwIfTaskCanceled } from "../../core/ai/transport/index.ts";
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { fail, ok, type Failure, type Result } from "../../core/errors.ts";
import type { QaRecord } from "../../core/notes/records.ts";
import { buildCitationsFromAnswer, clickableTimestamps, type CitationRange } from "../../core/qa/citations.ts";
import { isInputTooLong, QA_BUDGET_CHARS, QA_FALLBACK_BUDGET_CHARS } from "../../core/qa/budget.ts";
import { selectContext, type QaChapter, type QaChunk, type QaContext } from "../../core/qa/retrieval.ts";
import type { FrozenGen } from "../../core/tasks.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { EmptyRequest } from "../../shared/messages/core.ts";
import type { QaAnswerView, QaHistoryView } from "../../shared/messages/qa.ts";
import type { TranscriptView } from "../../shared/messages/transcript.ts";
import { aiFailure } from "../ai.ts";
import { errorLabel, type Log } from "../log.ts";
import type { OverviewStore } from "../stores/overviews.ts";
import { QA_ID_PREFIX, type QaStore } from "../stores/qa.ts";
import type { TaskRun, TaskRunner } from "../tasks.ts";
import { createClaim } from "./claim.ts";
import type { TranscriptService } from "./transcript/index.ts";

export const QA_PROMPT = "common/qa.md";
export const QUESTION_MAX = 500;
// 回答控制在 300 字内，2048 个 token 加上结构和引用的开销绰绰有余。
const ANSWER_MAX_TOKENS = 2048;

/** 零有效引用时整条替换：宁可少答，不可编造。 */
export const FALLBACK_ANSWER = "未能从字幕中找到足够的依据来回答这个问题。可以换个说法再问一次，或先确认这个视频里是否有你想问的内容。";

/** 用户消息的三块，按发出的先后。 */
export const QA_USER_SECTIONS = ["用户消息：视频信息", "用户消息：字幕", "用户消息：问题"] as const;

/**
 * 问答的消息：系统提示词，加一条分三块的用户消息，顺序是视频信息、字幕、问题。
 * 字幕那块打缓存标记：同一个视频接着问、送的字幕相同时，问题之前的前缀都能命中缓存。
 */
export function qaMessages(markdown: string, variables: PromptVariables): ChatMessage[] {
  const [info, transcript, question] = QA_USER_SECTIONS.map((heading) => extractPromptSection(markdown, heading, variables));
  const content: MessagePart[] = [
    { type: "text", text: info ?? "" },
    { type: "text", text: transcript ?? "", cache: true },
    { type: "text", text: question ?? "" },
  ];
  return [
    { role: "system", content: extractPromptSection(markdown, "系统提示词", variables) },
    { role: "user", content },
  ];
}

/** 登记问答任务时交的功能输入。 */
export interface QaInput {
  readonly question: string;
}

/** 登记前核对问题：去掉首尾空白，空的、太长的不登记。 */
export function questionInput(raw: string): Result<QaInput> {
  const question = raw.trim();
  if (!question) return fail("EMPTY_QUESTION");
  if (question.length > QUESTION_MAX) return fail("QUESTION_TOO_LONG");
  return ok({ question });
}

const isQaInput = (input: unknown): input is QaInput =>
  typeof (input as Partial<QaInput> | null)?.question === "string" && questionInput((input as QaInput).question).ok;

export interface QaServiceDeps {
  readonly tasks: Pick<TaskRunner, "run" | "list">;
  readonly transcript: Pick<TranscriptService, "ensure">;
  /** 已有概览的章节给检索加权。 */
  readonly overviews: Pick<OverviewStore, "find">;
  readonly qa: QaStore;
  readonly guard: ClearGuard;
  readonly prompt: (file: string) => string;
  /** 字幕分块的大小，和概览一样按设置。 */
  readonly chunkOptions: () => Promise<ChunkPlanOptions>;
  /** 一次送多少字的字幕、被嫌太长以后缩到多少。不给时用 core/qa/budget.ts 的值。 */
  readonly budget?: { readonly chars: number; readonly fallbackChars: number };
  readonly log: Log;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface QaService {
  /** 认领登记好的问答任务并回答；同一个任务号再来一次接上在跑的那次。 */
  ask(taskId: string, video: VideoKey): Promise<Result<QaAnswerView>>;
  history(video: VideoKey): Promise<Result<QaHistoryView>>;
  remove(id: string): Promise<Result<EmptyRequest>>;
}

/** 只带失败本身，不带取字幕失败时顺手带回的视频信息、字幕轨这些。 */
const bare = ({ code, detail, retryAfterSec }: Failure): Failure => ({
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail }),
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

const genInfo = ({ feature, promptVersion, model, effort }: FrozenGen) => ({ feature, promptVersion, model, effort });

/**
 * 不认结构化输出的中转站、不守约定的模型会直接用散文回答。回答已经付过费：一个花括号都没有时整段当回答，
 * 后面的引用校验照旧把关。像 JSON 却读不出来的说不清哪段是回答，按读不出来报，不透出解析器的报错。
 */
function parseAnswer(raw: string): string | null {
  try {
    const parsed = parseLooseJson(raw) as { readonly answer?: unknown } | null;
    return typeof parsed?.answer === "string" ? parsed.answer : "";
  } catch {
    return raw.includes("{") ? null : raw.trim();
  }
}

/**
 * 引用只认送给模型的那些字幕。骨架只送了每块开头一句，检索给的区间却是整块：
 * 这时只认每块开头那一句的时间点，块里其余的话模型根本没看到。
 */
function evidenceRange(context: QaContext, all: readonly QaChunk[]): CitationRange | null {
  if (context.mode === "selected") return selectedRange(context, all);
  if (context.mode !== "skeleton" || !context.chunks.length) return context.timeRange;
  const ranges = context.chunks.map((chunk) => {
    const at = Math.floor(chunk.startSeconds);
    return { min: at, max: at };
  });
  return { min: Math.min(...ranges.map((range) => range.min)), max: Math.max(...ranges.map((range) => range.max)), ranges };
}

/**
 * 只挑了部分块时，检索给的每段区间上界是后面那块的起点。那块没送进去时上界改成开区间：
 * 时间点按整秒对字幕，落在它起点那一秒的引用对到的是它的第一句，模型没看到。
 */
function selectedRange(context: QaContext, all: readonly QaChunk[]): CitationRange | null {
  const range = context.timeRange;
  if (!range) return null;
  const sent = new Set(context.chunks.map((chunk) => chunk.index));
  const unsent = all.filter((chunk) => !sent.has(chunk.index)).map((chunk) => Math.floor(chunk.startSeconds));
  const ranges = range.ranges.map((part) => {
    const cut = unsent.find((start) => start > part.min && start <= part.max);
    return cut === undefined ? part : { min: part.min, max: cut - 1 };
  });
  return { min: range.min, max: Math.max(...ranges.map((part) => part.max)), ranges };
}

function chaptersOf(analysis: { readonly chapters?: readonly { readonly title?: unknown; readonly summary?: unknown; readonly timestampSeconds: number }[] | null } | undefined): QaChapter[] {
  return (analysis?.chapters ?? []).map((chapter) => ({
    title: typeof chapter.title === "string" ? chapter.title : "",
    summary: typeof chapter.summary === "string" ? chapter.summary : "",
    timestampSeconds: chapter.timestampSeconds,
  }));
}

export function createQaService(deps: QaServiceDeps): QaService {
  const claim = createClaim(deps.tasks);

  async function chapters(video: VideoKey): Promise<QaChapter[]> {
    try {
      return chaptersOf((await deps.overviews.find(video))?.analysis);
    } catch (error) {
      deps.log.warn("读本机概览失败，问答不带章节", errorLabel(error));
      return [];
    }
  }

  // 落库失败、或者等模型的工夫清除了本机数据，已经付过费的回答照常交回，只标出没存进历史。
  async function save(entry: QaRecord, since: ClearEpoch | undefined): Promise<boolean> {
    try {
      return await deps.qa.commit({ put: [entry] }, { since });
    } catch (error) {
      deps.log.error("问答历史保存失败", errorLabel(error));
      return false;
    }
  }

  async function answer(run: TaskRun, video: VideoKey, ref: VideoRef, since: ClearEpoch | undefined): Promise<Result<QaAnswerView>> {
    if (!isQaInput(run.input)) return fail("INVALID_REQUEST");
    const { question } = run.input;
    run.progress({ phase: "generating", message: "正在检索相关内容…" });
    // 缓存优先：重复提问不向平台发新请求。
    const snapshot = await deps.transcript.ensure(ref);
    if (!snapshot.ok) return bare(snapshot);
    throwIfTaskCanceled(run.signal);
    const view: TranscriptView = snapshot.value.view;
    const chunks = planAnalysisChunks(view.transcript.segments, await deps.chunkOptions());
    const input = { chunks, question, chapters: await chapters(video), totalDurationSeconds: Math.floor(view.info.durationSec || 0) };
    const budget = deps.budget ?? { chars: QA_BUDGET_CHARS, fallbackChars: QA_FALLBACK_BUDGET_CHARS };
    let context = selectContext({ ...input, budgetChars: budget.chars });
    if (!context.chunks.length) return fail("NO_TRANSCRIPT");

    run.progress({ phase: "generating", message: "正在组织回答…" });
    const request = (sent: QaContext, selfRetry: boolean) =>
      run.ai.requestAiCompletion({
        maxTokens: ANSWER_MAX_TOKENS,
        responseFormat: QA_ANSWER,
        signal: run.signal,
        selfRetry,
        // 服务限流或过载时传输层会等几秒重发一次，进度说清在等什么。
        onRetry: ({ message }) => run.progress({ phase: "generating", message }),
        messages: qaMessages(deps.prompt(QA_PROMPT), {
          videoTitle: view.info.title || "未知",
          ownerName: view.info.author || "未知",
          question,
          transcriptText: sent.chunks.map((chunk) => chunk.text).join("\n\n"),
        }),
      });
    let reply;
    try {
      reply = await request(context, true);
    } catch (error) {
      // 模型装不下：缩到小预算再发一次，这次不让传输层自己重发；第一次已经重发过就不再发。
      if (!isInputTooLong(error)) throw error;
      const smaller = selectContext({ ...input, budgetChars: budget.fallbackChars });
      const shrinks = smaller.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) < context.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      if ((error as { readonly noAutoRetry?: unknown }).noAutoRetry || !shrinks) return fail("QA_INPUT_TOO_LONG");
      throwIfTaskCanceled(run.signal);
      run.progress({ phase: "generating", message: "字幕太长，这个模型装不下，缩小范围再问一次…" });
      context = smaller;
      try {
        reply = await request(context, false);
      } catch (retryError) {
        if (isInputTooLong(retryError)) return fail("QA_INPUT_TOO_LONG");
        throw retryError;
      }
    }
    const { text, truncated } = reply;
    throwIfTaskCanceled(run.signal);
    const raw = parseAnswer(text);
    if (raw === null) return fail("QA_PARSE_FAILED");

    // 依据原句由本地从字幕里取，模型只在正文里标时间点，想编造也没有载体。
    const evidence = evidenceRange(context, chunks);
    const citations = buildCitationsFromAnswer(raw, view.transcript.cues, evidence);
    const fromModel = Boolean(raw && citations.length);
    const shown = fromModel ? raw : FALLBACK_ANSWER;
    const entry: QaRecord = {
      id: `${QA_ID_PREFIX}${deps.newId()}`,
      video,
      question,
      answer: shown,
      citations,
      clickable: [...clickableTimestamps(shown, evidence)],
      // 换成兜底文案时那段正文没用上，不标截断。
      ...(fromModel && truncated ? { truncated: true as const } : {}),
      derived: { basis: { source: "transcript", transcript: view.transcript.ref }, gen: genInfo(run.gen) },
      createdAt: deps.now(),
    };
    const saved = await save(entry, since);
    return ok(saved ? { entry, retrievalMode: context.mode } : { entry, retrievalMode: context.mode, historySaved: false });
  }

  return {
    ask(taskId, video) {
      const since = deps.guard.epoch();
      return claim(taskId, "qa", video, async (run) => {
        const ref = parseVideoKey(video);
        if (!ref) return fail("INVALID_REQUEST");
        try {
          return await answer(run, video, ref, since);
        } catch (error) {
          if (run.signal.aborted || (error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED") return fail("TASK_CANCELED");
          deps.log.error("问答失败", errorLabel(error));
          return aiFailure(error);
        }
      });
    },
    async history(video) {
      return ok({ entries: await deps.qa.byVideo(video) });
    },
    async remove(id) {
      await deps.qa.commit({ remove: [id] });
      return ok({});
    },
  };
}

