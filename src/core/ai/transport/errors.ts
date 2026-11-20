// 传输层的错误：取消、拒答，以及把模型服务的错误翻译成用户看得懂的回执。
import type { OutputLang } from "../../output-lang.ts";
import { messageIn, withEnglish } from "../provider/index.ts";
import { transportBoth, transportText } from "./text.ts";
import type { AiErrorLike, AiErrorResponse, TransportError } from "./types.ts";

// 5xx 的说明只是状态码的英文名、过载这类笼统的话时不显示，只说「繁忙或出错」。
// 别的说明（中转站报的配置错误）附在中文提示后面，用户才知道该去改什么。
const GENERIC_SERVER_ERROR =
  /^\s*(?:服务返回 \d+|overloaded(?:_error)?|service unavailable|internal server error|bad gateway|gateway time-?out|server error|upstream (?:connect )?error|too many requests|error)\.?\s*$/i;
const SERVER_ERROR_DETAIL_MAX_CHARS = 160;

// 服务的原话是不可信的外来文字：界面只当纯文本显示，这里先去掉控制字符、压掉换行、限长，
// 再把像密钥、令牌的片段遮掉。鉴权失败的报错不带原话，有的服务会在那里回显密钥的一部分。
const SAID_MAX_CHARS = 200;
const NO_SAID_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const FALLBACK_SAID = /^服务返回 \d+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g;
const AUTH_VALUE = /\b(Bearer|Basic)\s+\S+/gi;
const KEY_LIKE = [
  // 常见服务商密钥的开头，连同回显时打了星号的半截。
  /\b(?:sk|xai|gsk)[-_][A-Za-z0-9*._-]{4,}/gi,
  /\bAIza[A-Za-z0-9_-]{8,}/g,
  // 又长又同时有字母和数字、不带连字符的一串（密钥、令牌）；型号名带连字符，不会被当成密钥。
  /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}\b/g,
];
const HIDDEN = "[已隐藏]";

/** 服务原话给界面显示前的清洗：纯文本、一行、限长，遮掉像密钥的片段。先遮再截，截断处不会露出半截密钥。 */
export function serviceWords(text: unknown): string {
  let words = String(text ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  words = words.replace(AUTH_VALUE, `$1 ${HIDDEN}`);
  for (const pattern of KEY_LIKE) words = words.replace(pattern, HIDDEN);
  return words.length > SAID_MAX_CHARS ? `${words.slice(0, SAID_MAX_CHARS)}…` : words;
}

// 只有服务回了 HTTP 报错、又说了点具体的话时才有原话；简幕自己写的提示、笼统的状态码说明都不算。
function saidOf(error: AiErrorLike): string {
  const status = error.status;
  if (status === undefined || status < 400 || NO_SAID_STATUSES.has(status)) return "";
  const raw = String(error.message ?? "").trim();
  if (!raw || FALLBACK_SAID.test(raw) || GENERIC_SERVER_ERROR.test(raw)) return "";
  return serviceWords(raw);
}

export function taskCanceledError(): TransportError {
  const { message, messageEn } = transportBoth((text) => text.canceled);
  const error: TransportError = withEnglish(new Error(message), messageEn);
  error.code = "TASK_CANCELED";
  return error;
}

export function throwIfTaskCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw taskCanceledError();
}

// 拒绝回答改配置也救不了，重试只会再付一次费，直接报给用户。
export function refusedError(reason: string): TransportError {
  const { message, messageEn } = transportBoth((text) => (reason ? text.refusedWith(reason) : text.refused));
  const error: TransportError = withEnglish(new Error(message), messageEn);
  error.code = "AI_REFUSED";
  return error;
}

/** 把模型服务的错误翻译成用户能看懂、且知道下一步该干什么的提示。message 按 lang 写，不传时是中文。 */
// 错误回执跨消息传给页面时带上 noAutoRetry：传输层已经重发过或特意不重发（额度用完、
// 等待超过上限），页面那一层的补轮也不该再发。
export function aiErrorResponse(error: unknown, lang: OutputLang = "zh"): AiErrorResponse {
  const failure = error as AiErrorLike;
  const response = errorResponseOf(failure, lang);
  return failure?.noAutoRetry && !response.success ? { ...response, noAutoRetry: true } : response;
}

/**
 * 服务报错时自己说的话，给界面在三段式下面另起一行显示：清洗、截短、遮掉像密钥的片段以后的纯文本。
 * 取消、要用户去设置页动手的、鉴权失败的都没有；它只跟着这次的结果走，不进存储和备份。
 */
export function serviceSaid(error: unknown): string {
  const failure = (error ?? {}) as AiErrorLike;
  if (failure.code === "TASK_CANCELED" || (failure.code !== undefined && ACTIONABLE.has(failure.code))) return "";
  return saidOf(failure);
}

// 这几类都要用户去设置页动手，原样透出简幕自己的提示即可。
const ACTIONABLE: ReadonlySet<string> = new Set([
  "NO_AI_CONFIG",
  "NEED_HOST_PERMISSION",
  "INVALID_BASE_URL",
  "AI_NETWORK_ERROR",
  "AI_REDIRECT_BLOCKED",
  "ANTHROPIC_WORKSPACE_REQUIRED",
]);

function errorResponseOf(error: AiErrorLike, lang: OutputLang): AiErrorResponse {
  const say = transportText(lang);
  if (error.code === "TASK_CANCELED") {
    return { success: false, error: "TASK_CANCELED", message: say.canceled };
  }
  if (error.code !== undefined && ACTIONABLE.has(error.code)) {
    return { success: false, error: error.code, message: lang === "en" ? messageIn(error, lang) : (error.message as string) };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      success: false,
      error: "INVALID_AI_KEY",
      message: say.badKey,
    };
  }
  if (error.status === 404) {
    return {
      success: false,
      error: "MODEL_OR_ENDPOINT_NOT_FOUND",
      message: say.notFound,
    };
  }
  if (error.status === 429) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message: say.rateLimited,
    };
  }
  // 5xx 和 Anthropic 的 529（过载）：服务那头的问题，笼统的英文原文对用户没用。
  // 带着具体说明的（中转站模型名配错之类）附上说明，不让配置错误看起来像等一等就好。
  // 说明在 keyedHttpError 里已经去掉了密钥，这里只截短。
  if (error.status !== undefined && error.status >= 500 && error.status < 600) {
    const raw = String(error.message || "").trim();
    if (error.status !== 529 && raw && !GENERIC_SERVER_ERROR.test(raw)) {
      const detail = messageIn({ message: raw, messageEn: error.messageEn }, lang).trim();
      const shown =
        detail.length > SERVER_ERROR_DETAIL_MAX_CHARS
          ? `${detail.slice(0, SERVER_ERROR_DETAIL_MAX_CHARS)}…`
          : detail;
      return {
        success: false,
        error: "AI_SERVICE_ERROR",
        message: say.serviceError(error.status, shown),
      };
    }
    return {
      success: false,
      error: "AI_SERVICE_BUSY",
      message: say.serviceBusy(error.status),
    };
  }
  return {
    success: false,
    error: error.code || "AI_REQUEST_FAILED",
    message: (lang === "en" ? messageIn(error, lang) : error.message) || say.failed,
  };
}
