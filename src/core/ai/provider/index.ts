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
export { diagnoseEmptyResponse } from "./diagnose.ts";
export { PROTOCOLS, type Protocol } from "./endpoint.ts";
export {
  isRedirectResponse,
  KEYED_FETCH_REDIRECT,
  keyedHttpError,
  rejectRedirect,
  redactSecret,
  type RedirectProbe,
} from "./keyed.ts";
export { isOpenAiReasoningModel, openAiModelTraits, vendorExtras } from "./openai.ts";
export { createRelaxMemory, RELAX_STORAGE_KEY, relaxRejectedParams, sendChatWithRelax } from "./relax.ts";
export { buildChatRequest, buildModelsRequest, splitSystemMessages } from "./request.ts";
export {
  canRaiseBudget,
  isTruncated,
  parseChatResponse,
  parseErrorMessage,
  parseModelsResponse,
  refusalOf,
} from "./response.ts";
export type {
  AiSettings,
  ChatMessage,
  ChatRequest,
  ChatRequestBody,
  ChatRequestInput,
  ClaudeCapabilities,
  ClaudeTraits,
  EmptyDiagnosis,
  ModelsRequest,
  ProviderError,
  RelaxMemory,
  RelaxState,
  RelaxStorage,
  ResponseFormat,
  SendChatInput,
} from "./types.ts";
