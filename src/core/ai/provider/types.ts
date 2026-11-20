// 协议层用到的形状。响应和报错来自服务方，形状不可信：这里只写读得到时的样子，
// 读取的地方都留着 ?. 和 Array.isArray 的判断。
import type { ClearEpoch } from "../../clear-guard.ts";
import type { Effort } from "../../notes/records.ts";
import type { ResponseSchema } from "../schemas.ts";
import type { Protocol } from "./endpoint.ts";

export interface AiSettings {
  readonly presetId?: string;
  readonly protocol: Protocol;
  readonly aiApiKey: string;
  readonly aiBaseUrl: string;
  readonly aiModel: string;
}

/** content 写字符串或部件数组（parts.ts 的 MessageContent），别的写法原样发出。 */
export interface ChatMessage {
  readonly role: string;
  readonly content: unknown;
}

export type ResponseFormat = ResponseSchema | { readonly type: "json_object" };

/**
 * 模型拒绝某个参数后算出的放宽项，为 true 的不再发送；thinking 为字符串时改传这个类型。
 * 字段含义见 relaxRejectedParams。
 */
export interface RelaxState {
  thinking?: true | string;
  temperature?: boolean;
  format?: boolean;
  effort?: boolean;
  jsonObject?: boolean;
  responseFormat?: boolean;
  headroom?: boolean;
}

/** 从模型服务读到的能力，见 capabilities.ts。 */
export interface ClaudeCapabilities {
  readonly maxTokens?: number;
  readonly thinking?: {
    readonly disabled?: boolean;
    readonly betweenTools?: boolean;
    readonly adaptive?: boolean;
  };
  readonly efforts?: readonly string[];
  readonly structuredOutputs?: boolean;
}

export interface ClaudeTraits {
  readonly thinking: string;
  readonly effort: string;
  readonly omitTemperature: boolean;
  readonly structuredOutputs: boolean;
  readonly maxTokens: number;
}

/**
 * 三种协议统一的模型能力，推理强度和看图都只读它（capabilities.ts 的 resolveCapabilities 算出）。
 * efforts 按从低到高列出这个服务和型号做得到的档位；关不掉思考的不含 off。
 */
export interface ModelCapabilities {
  readonly canDisableThinking: boolean | "unknown";
  readonly efforts: readonly Effort[];
  readonly imageInput: boolean | "unknown";
  readonly jsonSchema: boolean;
  readonly maxOutput?: number;
}

/** 关不掉思考、按最低档发；做不到、退到了最接近的一档；扩展设不了这个服务的推理强度，由服务自己决定。 */
export type EffortNote = "cannot-disable" | "fallback" | "unknown";

/** 一个档位落到请求上的样子，见 effort.ts 的 planEffort。 */
export interface EffortPlan {
  /** 用户选的档位，放宽记忆按它分开记。 */
  readonly requested: Effort;
  /** 实际生效的档位：任务的生成配置记这个，设置页也显示这个。 */
  readonly effective: Effort;
  readonly note?: EffortNote;
  /** 这一档要并进请求体的改动。 */
  readonly patch: Readonly<Record<string, unknown>>;
  /** 给思考留的输出余量，加在调用方给的预算上。 */
  readonly outputHeadroom: number;
  /** 单次请求的硬超时。 */
  readonly timeoutSec: number;
}

export interface ChatRequestInput {
  readonly settings: AiSettings;
  readonly messages?: readonly ChatMessage[] | null | undefined;
  readonly maxTokens: number;
  readonly temperature?: number | undefined;
  readonly responseFormat?: ResponseFormat | null | undefined;
  readonly relax?: RelaxState | undefined;
  readonly capabilities?: ClaudeCapabilities | null | undefined;
  /** 推理强度。不传就是关，请求和以前一样。 */
  readonly effort?: Pick<EffortPlan, "requested" | "patch"> | null | undefined;
}

export interface OutputFormat {
  readonly type: string;
  readonly name?: string;
  readonly schema?: unknown;
  readonly strict?: boolean;
}

/** 三种协议的请求体共用这一个形状，哪些字段出现由 buildChatRequest 决定。 */
export interface ChatRequestBody {
  model?: string;
  messages?: readonly ChatMessage[];
  input?: readonly ChatMessage[];
  instructions?: string;
  system?: readonly { type: string; text: string; cache_control: { type: string } }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  store?: boolean;
  temperature?: number;
  thinking?: { readonly type: string };
  reasoning?: { readonly effort: string };
  reasoning_effort?: string;
  output_config?: { effort?: string; format?: OutputFormat };
  response_format?: OutputFormat;
  text?: { format: OutputFormat };
}

export interface ChatRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ChatRequestBody;
}

export interface ModelsRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** 响应里的内容块：Anthropic 的 content，Responses 里 message 项的 content。 */
export interface ResponseBlock {
  readonly type?: string;
  readonly text?: unknown;
  readonly refusal?: unknown;
}

export interface ResponseItem {
  readonly type?: string;
  readonly phase?: string;
  readonly content?: ResponseBlock[];
}

export interface ResponseChoice {
  readonly finish_reason?: string;
  readonly message?: {
    readonly content?: unknown;
    readonly reasoning_content?: unknown;
    readonly reasoning?: unknown;
  };
}

/** 三种协议的响应共用这一个形状。 */
export interface ProviderResponse {
  readonly choices?: ResponseChoice[];
  readonly content?: ResponseBlock[];
  readonly stop_reason?: string;
  readonly output?: ResponseItem[];
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string } | null;
  readonly error?: { readonly message?: string } | null;
  readonly usage?: {
    readonly output_tokens_details?: { readonly reasoning_tokens?: unknown };
    readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
  };
}

export interface EmptyDiagnosis {
  readonly reason: string;
  readonly message: string;
  /** 英文说明，不可枚举（见 text.ts）。 */
  readonly messageEn?: string;
  readonly retryWithoutJsonMode: boolean;
  readonly retryWithMoreTokens?: boolean;
}

/** 协议层抛出或构造的错误，status 和 param 来自 HTTP 报错。 */
export interface ProviderError extends Error {
  /** 简幕自己写的说明的英文，不可枚举（见 text.ts）；服务的原话没有这一项。 */
  messageEn?: string;
  status?: number;
  code?: string;
  param?: string;
}

/** relaxRejectedParams 只看这几项。 */
export interface RejectedError {
  readonly status?: number;
  readonly message?: string;
  readonly param?: string;
}

/** 放宽记忆用的存储区，读写失败时退回只用内存。 */
export interface RelaxStorage {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (items: Record<string, unknown>) => Promise<unknown>;
}

export interface RememberOptions {
  readonly since?: ClearEpoch | undefined;
  /** 用户选的档位。关和以前一样记，别的档位分开记：一个档位被拒的参数，换个档位不一定被拒。 */
  readonly effort?: Effort | undefined;
}

export interface RelaxMemory {
  readonly ready?: () => Promise<void>;
  readonly epoch?: () => ClearEpoch | undefined;
  readonly recall: (settings: AiSettings, effort?: Effort) => RelaxState;
  readonly remember: (
    settings: AiSettings,
    relax: RelaxState,
    options?: RememberOptions,
  ) => Promise<unknown> | undefined | void;
  readonly forget?: () => void;
}

export interface SendChatInput extends ChatRequestInput {
  /** 推理强度。余量被拒时要从 maxTokens 里减掉它。 */
  readonly effort?: Pick<EffortPlan, "requested" | "patch" | "outputHeadroom"> | null | undefined;
  readonly memory?: RelaxMemory | undefined;
  readonly send: (request: ChatRequest, settings: AiSettings) => Promise<unknown>;
  readonly onRelax?: ((relax: RelaxState) => void) | undefined;
}
