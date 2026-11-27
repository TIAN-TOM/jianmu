// AI 协议适配层：把「OpenAI 兼容」（Chat Completions）、OpenAI Responses 和 Anthropic
// 三种协议的差异全部收在这个目录。构造请求、解析响应都是纯函数，网络调用由调用方注入。
// 带密钥请求的共同约定（不跟随重定向、报错先脱敏）也放在这里。
export {
  ANTHROPIC_LEGACY_VERSION,
  ANTHROPIC_VERSION,
  apiVersionFor,
  claudeRequestTraits,
  isOfficialAnthropic,
  parseClaudeModel,
} from "./anthropic.ts";
export { diagnoseEmptyResponse, thinkingUsedUpBudget } from "./diagnose.ts";
export {
  EFFORT_BUDGETS,
  effortSupport,
  hostOf,
  planEffort,
  type EffortPlanInput,
  type EffortSupport,
  type EffortTarget,
} from "./effort.ts";
export { isLocalBaseUrl, PROTOCOLS, type Protocol } from "./endpoint.ts";
export {
  isRedirectResponse,
  KEYED_FETCH_REDIRECT,
  keyedHttpError,
  parseErrorText,
  rejectRedirect,
  redactSecret,
  type RedirectProbe,
} from "./keyed.ts";
export { isOpenAiReasoningModel, openAiModelTraits, vendorExtras } from "./openai.ts";
export {
  isMessageParts,
  toProtocolContent,
  withProtocolContent,
  type MessageContent,
  type MessagePart,
} from "./parts.ts";
export { createRelaxMemory, RELAX_STORAGE_KEY, relaxRejectedParams, sendChatWithRelax } from "./relax.ts";
export { buildChatRequest, buildModelsRequest, splitSystemMessages } from "./request.ts";
export {
  canRaiseBudget,
  errorBodyOf,
  isTruncated,
  parseChatResponse,
  parseErrorMessage,
  parseModelsResponse,
  refusalOf,
  usageOf,
  type TokenUsage,
} from "./response.ts";
export { assembleEventStream, looksLikeEventStream, type StreamAssembly } from "./stream.ts";
export {
  bothLangs,
  HIDDEN_WORDS,
  hiddenIn,
  messageIn,
  providerText,
  withEnglish,
  type ProviderText,
  type WithEnglish,
} from "./text.ts";
export type {
  AiSettings,
  ChatMessage,
  ChatRequest,
  ChatRequestBody,
  ChatRequestInput,
  ClaudeCapabilities,
  ClaudeTraits,
  EffortNote,
  EffortPlan,
  EmptyDiagnosis,
  ModelCapabilities,
  ModelsRequest,
  ProviderError,
  RelaxMemory,
  RelaxState,
  RelaxStorage,
  ResponseFormat,
  SendChatInput,
} from "./types.ts";
