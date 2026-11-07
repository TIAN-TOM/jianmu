// 传输层对外的形状：注入的依赖、入参、结果和错误。
import type { StoredDataConsent } from "../../consent.ts";
import type {
  AiSettings,
  ChatRequest,
  ChatRequestInput,
  ClaudeCapabilities,
  KEYED_FETCH_REDIRECT,
  ProviderError,
  RedirectProbe,
  RelaxMemory,
  ResponseFormat,
} from "../provider/index.ts";

/** 传输层抛出的错误。status、code 来自协议层，其余几项给重发判断和上层的补轮用。 */
export interface TransportError extends ProviderError {
  /** 空响应的原因，见 diagnoseEmptyResponse。 */
  reason?: string;
  /** 服务建议等多久再发，毫秒。 */
  retryAfterMs?: number;
  /** 额度或余额用完了。 */
  quotaExhausted?: boolean;
  /** 上层不要再补发：这次调用已经重发过，或者重发也没用。 */
  noAutoRetry?: boolean;
}

/** 翻译错误时只看这几项，抛出来的错误和跨消息传过来的错误回执都满足。 */
export interface AiErrorLike {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message?: string | undefined;
  readonly noAutoRetry?: boolean | undefined;
}

/** 给页面的错误回执。 */
export interface AiErrorResponse {
  readonly success: false;
  readonly error: string;
  readonly message: string;
  readonly noAutoRetry?: true;
}

/** 限流或过载、要等一会儿再重发时给调用方的通知，message 是给进度条看的一句话。 */
export interface RetryNotice {
  readonly status: number | undefined;
  readonly delayMs: number;
  readonly message: string;
}

/** 重发前的等待：取消时要以 TASK_CANCELED 拒绝。 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ResponseBodyReader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  readonly cancel?: () => Promise<unknown>;
}

/** 这里只用响应的这几项，真实的 Response 和测试替身都满足。 */
export interface TransportResponse extends RedirectProbe {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { readonly get?: (name: string) => string | null } | null | undefined;
  readonly body?: {
    readonly cancel?: () => unknown;
    readonly getReader?: () => ResponseBodyReader;
  } | null;
  readonly text: () => Promise<string>;
}

export interface AiFetchInit {
  readonly method: "POST";
  readonly headers: ChatRequest["headers"];
  readonly body: string;
  readonly redirect: typeof KEYED_FETCH_REDIRECT;
  readonly signal: AbortSignal;
}

export type AiFetch = (url: string, init: AiFetchInit) => Promise<TransportResponse>;

/**
 * 设置模块提供的规则：校验、规整、按功能换模型都按它的口径来。
 * 同意的核对在传输层自己做，每次发出之前读一次设置，规整后的版本和指纹都要和这里的对上，
 * 所以 normalize、dataConsentVersion 和 dataConsentFingerprint 是必需的，建传输层时会查。
 */
export interface TransportSettingsRules {
  /** 配置是否足以发起一次请求，errors 是给用户看的提示。 */
  readonly validate: (settings: AiSettings) => { readonly ok: boolean; readonly errors: readonly string[] };
  /** 规整一份设置，这里只读其中用户确认过的数据说明版本和指纹。 */
  readonly normalize: (settings: AiSettings) => StoredDataConsent;
  /** 把 aiModel 换成这项功能实际要用的模型，没有选过就原样返回。 */
  readonly withFeatureModel: (settings: AiSettings, feature: string | undefined) => AiSettings;
  /** 当前数据说明的版本，正整数；0 表示用户还没确认过，不能拿来比。 */
  readonly dataConsentVersion: number;
  /** 当前数据说明条目的指纹，不能是空串。 */
  readonly dataConsentFingerprint: string;
  /** 没有确认时给用户的提示。 */
  readonly dataConsentError: string;
  /** 硬超时的默认值，秒。 */
  readonly timeoutSeconds: number;
}

export interface AiTransportDeps {
  /** 读用户的 AI 配置。 */
  readonly getSettings: () => Promise<AiSettings>;
  /** MV3 对未授权域名禁止 fetch，域名安装时未知，要运行时申请。 */
  readonly ensureHostPermission: (baseUrl: string) => Promise<unknown>;
  readonly settingsRules: TransportSettingsRules;
  /** 调试日志。 */
  readonly log?: ((...args: unknown[]) => void) | undefined;
  /** 硬超时，不传时用 settingsRules.timeoutSeconds。 */
  readonly timeoutMs?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  /** 记住哪些服务和模型要放宽参数。默认每个传输层实例一份、只在内存里。 */
  readonly relaxMemory?: RelaxMemory | undefined;
  /**
   * settings.aiModel 的能力，没有时返回 null，按型号名判断。
   * 传进来的是换成本次功能实际模型之后的设置。
   */
  readonly getModelCapabilities?: ((settings: AiSettings) => Promise<ClaudeCapabilities | null>) | undefined;
  /** 限流、过载后重发前的等待。 */
  readonly sleep?: Sleep | undefined;
  readonly random?: (() => number) | undefined;
  readonly fetch?: AiFetch | undefined;
}

export interface CompletionRequest {
  /** 功能名，用户给这项功能另选了模型就用它，没选或不传时用默认模型。 */
  readonly feature?: string | undefined;
  readonly messages: ChatRequestInput["messages"];
  readonly maxTokens: number;
  readonly temperature?: number | undefined;
  readonly responseFormat?: ResponseFormat | null | undefined;
  /** 取消整个任务，已经发出的请求也中止。 */
  readonly signal?: AbortSignal | undefined;
  /**
   * 管所有自动重发（限流过载后的等待、截断加码、脱掉 JSON 模式）：中止时等待立刻以 TASK_CANCELED
   * 结束，不再发新的请求；已经发出去的请求不受它影响。粗筛写结论只带排队信号、不带 signal，
   * 靠它让停止撤掉还没发出的重发，不然停止之后延迟的那次照样发出去计费。
   */
  readonly retrySignal?: AbortSignal | undefined;
  readonly onRetry?: ((notice: RetryNotice) => void) | undefined;
  /**
   * false：上层补轮里的那一次，这一批的重试额度已经用在上一轮，这里不再自己重发
   * （限流后重发、加码、脱掉 JSON 模式都不做；参数放宽照旧，被拒的请求不计费）。
   */
  readonly selfRetry?: boolean | undefined;
  /**
   * 每一次真正发出之前问一次，回 false 就按取消结束，不发。不登记任务、
   * 没有取消信号的请求（侧边栏的官方总结结论）靠它在清除本机数据之后不再发、不再重发。
   */
  readonly stillWanted?: (() => boolean) | null | undefined;
}

export interface CompletionResult {
  readonly text: string;
  /** 这次调用实际用的设置，aiModel 已经换成功能实际要用的模型。 */
  readonly settings: AiSettings;
  /** 实际发了几次。 */
  readonly sends: number;
  /** 正文可能不完整，由调用方补齐。 */
  readonly truncated?: true;
}

/** sendAiRequest 只用到地址和密钥。 */
export type SendSettings = Pick<AiSettings, "aiBaseUrl"> & Partial<Pick<AiSettings, "aiApiKey">>;

export interface AiTransport {
  readonly requestAiCompletion: (request: CompletionRequest) => Promise<CompletionResult>;
  readonly sendAiRequest: (
    settings: SendSettings,
    request: ChatRequest,
    externalSignal?: AbortSignal,
  ) => Promise<unknown>;
  readonly readBoundedAiResponse: (
    response: TransportResponse,
    onActivity: () => void,
    options?: { readonly lenient?: boolean },
  ) => Promise<unknown>;
  readonly aiErrorResponse: (error: unknown) => AiErrorResponse;
  readonly throwIfTaskCanceled: (signal: AbortSignal | undefined) => void;
  readonly taskCanceledError: () => TransportError;
}
