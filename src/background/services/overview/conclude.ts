// 一句话结论的请求：概览合并好以后再归纳一次，讲清内容和价值，判断要不要看完整视频。只喂章节和金句，请求很小。
// 完整概览之后的这一步和用官方总结写结论共用同一份提示词、同一道并发闸门和同一套校验。
import type { CommentMaterial } from "../../../core/ai/comments.ts";
import { parseLooseJson } from "../../../core/ai/parse.ts";
import { localizePrompt, type PromptVariables } from "../../../core/ai/prompt.ts";
import { VERDICT } from "../../../core/ai/schemas.ts";
import { taskCanceledError, throwIfTaskCanceled } from "../../../core/ai/transport/index.ts";
import { validateVerdict, verdictInputs, type CoverageGap, type Verdict, type VerdictAnalysis } from "../../../core/ai/verdict.ts";
import type { Limiter } from "../../../core/concurrency.ts";
import type { LearningAnalysis } from "../../../core/notes/markdown.ts";
import type { OutputLang } from "../../../core/output-lang.ts";
import { formatTimestamp } from "../../../core/transcript/segment.ts";
import { errorLabel, type Log } from "../../log.ts";
import { progressText } from "../../progress-text.ts";
import type { TaskAi } from "../../ai.ts";
import { promptMessages, type PromptCommon } from "./chunks.ts";
import { commentPlan } from "./conclude-comments.ts";

export const VERDICT_PROMPT = "skim/verdict.md";
const VERDICT_MAX_TOKENS = 1024;
// 带评论区写结论（PRD F23）：关掉开关的构建里连同提示词和输出格式一起裁掉。
const planComments = FEATURE_COMMENTS ? commentPlan : null;

/** 模型回的结论：正文被截断、靠补齐括号才解析出来时带标记，摘要或理由可能只有半句。 */
export type VerdictResult = Verdict & { readonly truncated?: true };

export interface VerdictRequestDeps {
  readonly ai: TaskAi;
  /** 模板原文，按 outputLang 填好语言那几处再发。 */
  readonly prompt: string;
  /** 取带评论区的模板原文；这次读到了足够的评论、真要发给模型时才取。 */
  readonly commentPrompt?: (() => string) | undefined;
  /** 结论用的语言，跟着任务取定的配置；不给时按中文。 */
  readonly outputLang?: OutputLang;
  readonly gate: Limiter;
  readonly concurrency: number;
  readonly log: Log;
}

export interface VerdictRequest {
  readonly variables: PromptVariables;
  /** 视频的原标题，模型给的标题译名要和它比；没有标题时给空串，译名一律不收。 */
  readonly title: string;
  /** 取消整个请求，已经发出的也中止。 */
  readonly signal?: AbortSignal | undefined;
  /** 只管排队：中止后还在闸门外排队的出队，已经发出去的照常等它回来。不给时就是 signal。 */
  readonly queueSignal?: AbortSignal | undefined;
  /** 结论只基于部分内容：概览有失败块。 */
  readonly incomplete?: boolean;
  /** 喂给模型的章节的起始秒，重点章节只认这些。不给时不收重点。 */
  readonly chapterStarts?: readonly number[] | undefined;
  /** 每一次真正发出之前问一次，回 false 就按取消结束。 */
  readonly stillWanted?: (() => boolean) | undefined;
  /** 这次读到的评论（PRD F23）；没读到、没开评论区时不给。 */
  readonly comments?: CommentMaterial | undefined;
}

/** 结论请求本身：请求出错照常抛，吞掉还是报给用户由调用方决定；模型回的不是有效结论时交回 null。 */
export async function requestVerdict(deps: VerdictRequestDeps, request: VerdictRequest): Promise<VerdictResult | null> {
  const { signal, queueSignal = signal, stillWanted } = request;
  const lang = deps.outputLang ?? "zh";
  const plan = planComments && request.comments && deps.commentPrompt ? planComments(request.comments) : null;
  const send = plan?.send;
  const template = send && deps.commentPrompt ? deps.commentPrompt() : deps.prompt;
  const messages = promptMessages(localizePrompt(template, lang), send ? { ...request.variables, ...send.variables } : request.variables);
  const { text, truncated } = await deps.gate(
    deps.concurrency,
    () => {
      throwIfTaskCanceled(signal);
      throwIfTaskCanceled(queueSignal);
      if (stillWanted && !stillWanted()) throw taskCanceledError();
      return deps.ai.requestAiCompletion({
        maxTokens: send?.maxTokens ?? VERDICT_MAX_TOKENS,
        responseFormat: send?.schema ?? VERDICT,
        signal,
        // 限流、过载后的自动重发还没发出去，停止时一并撤掉。
        retrySignal: queueSignal,
        ...(stillWanted ? { stillWanted } : {}),
        messages,
      });
    },
    queueSignal ? { signal: queueSignal } : {},
  );
  let parsed: unknown = null;
  try {
    parsed = parseLooseJson(text);
  } catch (error) {
    deps.log.error("一句话结论读不出来", errorLabel(error));
  }
  const checked = validateVerdict(parsed, { incomplete: request.incomplete ?? false, chapterStarts: request.chapterStarts, lang, title: request.title });
  const verdict = checked && plan ? plan.attach(parsed, checked, request.chapterStarts ?? [], lang, truncated === true) : checked;
  if (!verdict || !truncated) return verdict;
  // 正文被截断时译名排在最后，多半只剩半截：丢掉，标题照原样显示。
  const { translatedTitle: _cut, ...kept } = verdict;
  return { ...kept, truncated: true };
}

export interface VerdictStage {
  readonly common: PromptCommon;
  /** 视频的原标题，不带「未知」这类占位。 */
  readonly title: string;
  readonly totalDuration: number;
  readonly signal: AbortSignal;
  readonly progress: (message: string) => void;
  /** 这次读到的评论（PRD F23）。 */
  readonly comments?: CommentMaterial | undefined;
}

export type VerdictOutcome = { readonly verdict: VerdictResult } | { readonly canceled: true } | { readonly failed: true };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** 存着的概览里只取结论要喂的几样：章节的时间、标题、摘要，金句的时间和原话。 */
export function verdictMaterial(analysis: LearningAnalysis): VerdictAnalysis {
  return {
    chapters: (analysis.chapters ?? []).map((chapter) => ({ timestamp: text(chapter.timestamp), title: text(chapter.title), summary: text(chapter.summary) })),
    keyQuotes: (analysis.keyQuotes ?? []).map((quote) => ({ timestamp: text(quote.timestamp), quote: text(quote.quote) })),
  };
}

/** 概览之后写结论：有失败块时把缺了哪几段告诉模型，结论标成不完整。从不抛错。 */
export async function concludeOverview(
  deps: VerdictRequestDeps,
  analysis: LearningAnalysis,
  failures: readonly CoverageGap[],
  stage: VerdictStage,
): Promise<VerdictOutcome> {
  stage.progress(progressText(deps.outputLang).verdict);
  try {
    throwIfTaskCanceled(stage.signal);
    const variables = { ...stage.common, durationFormatted: formatTimestamp(stage.totalDuration), ...verdictInputs(verdictMaterial(analysis), { failures }) };
    const chapterStarts = (analysis.chapters ?? []).map((chapter) => chapter.timestampSeconds);
    const verdict = await requestVerdict(deps, { variables, title: stage.title, signal: stage.signal, incomplete: failures.length > 0, chapterStarts, comments: stage.comments });
    return verdict ? { verdict } : { failed: true };
  } catch (error) {
    if ((error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED" || stage.signal.aborted) return { canceled: true };
    deps.log.error("一句话结论生成失败", errorLabel(error));
    return { failed: true };
  }
}
