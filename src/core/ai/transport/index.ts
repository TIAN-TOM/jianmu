// AI 请求的传输层：超时、响应大小上限、空响应和截断的自愈重发、限流重发、错误翻译。
// 协议差异（请求、响应的形状）归 provider/，这里只管策略；环境依赖全部由调用方注入。
export { repairTruncatedJson } from "../parse.ts";
export { createAiTransport } from "./completion.ts";
export { aiErrorResponse, taskCanceledError, throwIfTaskCanceled } from "./errors.ts";
export { OUTPUT_TOKENS_CEILING, TOTAL_OUTPUT_TOKENS_CAP } from "./policy.ts";
export type {
  AiErrorResponse,
  AiFetch,
  AiFetchInit,
  AiTransport,
  AiTransportDeps,
  CompletionRequest,
  CompletionResult,
  ResponseBodyReader,
  RetryNotice,
  SendSettings,
  Sleep,
  TransportError,
  TransportResponse,
  TransportSettingsRules,
} from "./types.ts";
