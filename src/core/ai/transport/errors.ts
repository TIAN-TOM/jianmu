// 传输层的错误：取消、拒答，以及把模型服务的错误翻译成用户看得懂的回执。
import type { AiErrorLike, AiErrorResponse, TransportError } from "./types.ts";

// 5xx 的说明只是状态码的英文名、过载这类笼统的话时不显示，只说「繁忙或出错」。
// 别的说明（中转站报的配置错误）附在中文提示后面，用户才知道该去改什么。
const GENERIC_SERVER_ERROR =
  /^\s*(?:服务返回 \d+|overloaded(?:_error)?|service unavailable|internal server error|bad gateway|gateway time-?out|server error|upstream (?:connect )?error|too many requests|error)\.?\s*$/i;
const SERVER_ERROR_DETAIL_MAX_CHARS = 160;

export function taskCanceledError(): TransportError {
  const error: TransportError = new Error("任务已取消。");
  error.code = "TASK_CANCELED";
  return error;
}

export function throwIfTaskCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw taskCanceledError();
}

// 拒绝回答改配置也救不了，重试只会再付一次费，直接报给用户。
export function refusedError(reason: string): TransportError {
  const error: TransportError = new Error(
    reason
      ? `模型拒绝了这次请求：${reason}`
      : "模型拒绝了这次请求。可以换一个模型再试。",
  );
  error.code = "AI_REFUSED";
  return error;
}

/** 把模型服务的错误翻译成用户能看懂、且知道下一步该干什么的提示。 */
// 错误回执跨消息传给页面时带上 noAutoRetry：传输层已经重发过或特意不重发（额度用完、
// 等待超过上限），页面那一层的补轮也不该再发。
export function aiErrorResponse(error: unknown): AiErrorResponse {
  const failure = error as AiErrorLike;
  const response = errorResponseOf(failure);
  return failure?.noAutoRetry && !response.success ? { ...response, noAutoRetry: true } : response;
}

function errorResponseOf(error: AiErrorLike): AiErrorResponse {
  // 这几类都要用户去设置页动手，原样透出提示即可。
  const actionable = [
    "NO_AI_CONFIG",
    "NEED_HOST_PERMISSION",
    "INVALID_BASE_URL",
    "AI_NETWORK_ERROR",
    "AI_REDIRECT_BLOCKED",
    "ANTHROPIC_WORKSPACE_REQUIRED",
  ];
  if (error.code === "TASK_CANCELED") {
    return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
  }
  if (error.code !== undefined && actionable.includes(error.code)) {
    return { success: false, error: error.code, message: error.message as string };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      success: false,
      error: "INVALID_AI_KEY",
      message: "服务拒绝了这个密钥，请在设置里检查密钥和地址是否匹配。",
    };
  }
  if (error.status === 404) {
    return {
      success: false,
      error: "MODEL_OR_ENDPOINT_NOT_FOUND",
      message: "服务返回 404，多半是模型名写错或 API 地址不对，请到设置页核对。",
    };
  }
  if (error.status === 429) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message: "服务限流了，稍等一会儿再试。",
    };
  }
  // 5xx 和 Anthropic 的 529（过载）：服务那头的问题，笼统的英文原文对用户没用。
  // 带着具体说明的（中转站模型名配错之类）附上说明，不让配置错误看起来像等一等就好。
  // 说明在 keyedHttpError 里已经去掉了密钥，这里只截短。
  if (error.status !== undefined && error.status >= 500 && error.status < 600) {
    const detail = String(error.message || "").trim();
    if (error.status !== 529 && detail && !GENERIC_SERVER_ERROR.test(detail)) {
      const shown =
        detail.length > SERVER_ERROR_DETAIL_MAX_CHARS
          ? `${detail.slice(0, SERVER_ERROR_DETAIL_MAX_CHARS)}…`
          : detail;
      return {
        success: false,
        error: "AI_SERVICE_ERROR",
        message: `AI 服务出错（HTTP ${error.status}）：${shown}`,
      };
    }
    return {
      success: false,
      error: "AI_SERVICE_BUSY",
      message: `AI 服务暂时繁忙或出错（HTTP ${error.status}），请稍后再试。`,
    };
  }
  return {
    success: false,
    error: error.code || "AI_REQUEST_FAILED",
    message: error.message || "AI 请求失败。",
  };
}
