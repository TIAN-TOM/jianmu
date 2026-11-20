// 划词解释：侧边栏字幕里选中一段，请模型用一两句话解释。上下文由页面给（选中处附近的字幕），
// 视频标题只看本机已有的字幕缓存，为解释一个词不向平台读。输出被截断时正文末尾注明可能不完整。
import { localizePrompt } from "../../core/ai/prompt.ts";
import { throwIfTaskCanceled } from "../../core/ai/transport/index.ts";
import { fail, ok, type Result } from "../../core/errors.ts";
import { outputLangOf, type OutputLang } from "../../core/output-lang.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { ExplainView } from "../../shared/messages/qa.ts";
import { aiFailure } from "../ai.ts";
import { errorLabel, type Log } from "../log.ts";
import type { TaskRunner } from "../tasks.ts";
import { createClaim } from "./claim.ts";
import { promptMessages } from "./overview/chunks.ts";
import type { TranscriptService } from "./transcript/index.ts";

export const EXPLAIN_PROMPT = "study/explain.md";
const SELECTION_MAX = 1000;
const CONTEXT_MAX = 4000;
const EXPLAIN_MAX_TOKENS = 1024;
// 截断提示和解释一起存，跟着解释的语言。
const TRUNCATED_NOTE: Readonly<Record<OutputLang, string>> = {
  zh: "…（模型输出被截断，回答可能不完整。）",
  en: "… (The model's output was cut off, so this answer may be incomplete.)",
};

/** 登记解释任务时交的功能输入：选中的文字和附近的字幕，都按上限截好。 */
export interface ExplainInput {
  readonly selection: string;
  readonly context: string;
}

/** 登记前核对选中的文字：去掉首尾空白，空的不登记；太长的截到上限。 */
export function selectionInput(selection: string, context = ""): Result<ExplainInput> {
  const text = selection.trim();
  if (!text) return fail("EMPTY_SELECTION");
  return ok({ selection: text.slice(0, SELECTION_MAX), context: context.trim().slice(0, CONTEXT_MAX) });
}

const isExplainInput = (input: unknown): input is ExplainInput => {
  const value = input as Partial<ExplainInput> | null;
  return typeof value?.selection === "string" && value.selection !== "" && typeof value.context === "string";
};

export interface ExplainServiceDeps {
  readonly tasks: Pick<TaskRunner, "run" | "list">;
  readonly transcript: Pick<TranscriptService, "get">;
  readonly prompt: (file: string) => string;
  readonly log: Log;
}

export interface ExplainService {
  /** 认领登记好的解释任务并解释；同一个任务号再来一次接上在跑的那次。 */
  explain(taskId: string, video: VideoKey): Promise<Result<ExplainView>>;
}

export function createExplainService(deps: ExplainServiceDeps): ExplainService {
  const claim = createClaim(deps.tasks);

  async function titleOf(video: VideoKey): Promise<string> {
    const ref = parseVideoKey(video);
    if (!ref) return "未知";
    try {
      const cached = await deps.transcript.get(ref, { mode: "cache-only" });
      return (cached.ok && cached.value.info.title) || "未知";
    } catch (error) {
      deps.log.warn("读本机字幕缓存失败，解释不带标题", errorLabel(error));
      return "未知";
    }
  }

  return {
    explain(taskId, video) {
      return claim(taskId, "explain", video, async (run) => {
        if (!isExplainInput(run.input)) return fail("INVALID_REQUEST");
        const { selection, context } = run.input;
        const lang = outputLangOf(run.gen);
        try {
          const variables = { videoTitle: await titleOf(video), selectedText: selection, transcriptContext: context || "无" };
          throwIfTaskCanceled(run.signal);
          const { text, truncated } = await run.ai.requestAiCompletion({
            maxTokens: EXPLAIN_MAX_TOKENS,
            signal: run.signal,
            onRetry: ({ message }) => run.progress({ phase: "generating", message }),
            messages: promptMessages(localizePrompt(deps.prompt(EXPLAIN_PROMPT), lang), variables),
          });
          throwIfTaskCanceled(run.signal);
          const explanation = text.trim();
          // 截断后没法再加预算，交回的是半截：页面原样显示正文，提示直接写在末尾。
          return ok(truncated ? { explanation: `${explanation}${TRUNCATED_NOTE[lang]}`, truncated: true } : { explanation });
        } catch (error) {
          if (run.signal.aborted || (error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED") return fail("TASK_CANCELED");
          deps.log.error("划词解释失败", errorLabel(error));
          return aiFailure(error);
        }
      });
    },
  };
}
