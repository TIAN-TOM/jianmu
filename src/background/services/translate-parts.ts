// 翻译服务用到的几样小工具：对齐整理字幕的结果、定翻译方向、失败的说法、从播放位置往后先做、能被停下的等待。
import type { TranslationItem } from "../../core/ai/chunking.ts";
import type { TransportError } from "../../core/ai/transport/index.ts";
import { alignTidiedSegments } from "../../core/ai/validate.ts";
import type { Failure } from "../../core/errors.ts";
import type { OutputLang } from "../../core/output-lang.ts";
import { isChineseSubtitle, isEnglishSubtitle } from "../../core/transcript/language.ts";
import type { TranscriptSegment } from "../../core/transcript/segment.ts";
import type { TranslateFailure } from "../../shared/messages/translate.ts";
import { videoKey, type VideoKey } from "../../core/video-ref.ts";
import { watchRefOf } from "../../sites/rules.ts";
import { aiFailure } from "../ai.ts";
import type { Timers } from "../tasks.ts";

/** 整理字幕一批的结果：改得太多的段记成原文（照旧显示原文、下次不再请求）；漏的、编号对不上的不记，交给补轮。 */
export function tidiedOf(parsed: unknown, batch: readonly TranslationItem[], job: { readonly sources: ReadonlyMap<string, string> }): Record<string, string> {
  const { tidied, rejected } = alignTidiedSegments(parsed, batch);
  const kept: Record<string, string> = { ...tidied };
  for (const { id, reason } of rejected) {
    const source = job.sources.get(id);
    if (reason === "REWRITTEN" && source) kept[id] = source;
  }
  return kept;
}

/**
 * 译成设置的语言；字幕本身已经是这种语言时译成另一种。选简体或繁体时就是：中文字幕（不分简繁）译成英文，其他语言的字幕译成所选的中文；
 * 选英文时英文字幕译成简体中文。
 */
export function targetOf(lang: string, outputLang: OutputLang = "zh"): OutputLang {
  if (outputLang === "en") return isEnglishSubtitle(lang) ? "zh" : "en";
  return isChineseSubtitle(lang) ? "en" : outputLang;
}

export { genInfo } from "../../core/tasks.ts";

export function parseFailed(sends: number): TransportError {
  const error: TransportError = Object.assign(new Error("模型没有按要求返回结果。"), { code: "TRANSLATE_PARSE_FAILED" });
  // 传输层已经为这一批重发过：额度用掉了，补轮不再发。
  if (sends > 1) error.noAutoRetry = true;
  return error;
}

export function failureOf(error: unknown, lang: OutputLang): TranslateFailure {
  if ((error as { readonly code?: unknown } | null)?.code === "TRANSLATE_PARSE_FAILED") return { code: "TRANSLATE_PARSE_FAILED" };
  return bare(aiFailure(error, lang));
}

export const bare = ({ code, detail, said }: Failure): TranslateFailure => ({ code, ...(detail === undefined ? {} : { detail }), ...(said ? { said } : {}) });

/** 从这一秒往后的先译：眼前的内容几秒内就有结果，前面的随后补齐，总量和费用不变。 */
export function fromPlayback(segments: readonly TranscriptSegment[], fromSec: number | undefined): TranscriptSegment[] {
  if (fromSec === undefined) return [...segments];
  return [...segments.filter((segment) => segment.start >= fromSec), ...segments.filter((segment) => segment.start < fromSec)];
}

export function waitOrStop(timers: Pick<Timers, "setTimeout" | "clearTimeout">, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = timers.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      timers.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** 按各站的地址规则认视频；认不出或没有地址时是 null。 */
export function videoOfUrl(url: string | null): VideoKey | null {
  if (url === null) return null;
  const ref = watchRefOf(url);
  return ref ? videoKey(ref) : null;
}
