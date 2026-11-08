// 模型服务在网络这一层的替身：照浏览器的 fetch 收下请求、记下来，按测试给的处理函数回复。
// 另有一份带密钥、确认过数据说明和启用的存储，给要真的走设置读取和传输层的测试用。地址和密钥都是造的。
import type { ModelServiceFetch } from "../../src/background/ai.ts";
import type { JsonResponse } from "../../src/core/ai/capabilities.ts";
import type { TransportResponse } from "../../src/core/ai/transport/index.ts";
import { API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { ACTIVATION_CONFIRMED, DATA_CONSENT_CONFIRMED, type SettingsInput } from "../../src/shared/settings-schema.ts";

/** 请求体里测试要看的几项。 */
export interface SentBody {
  readonly model?: string;
  readonly max_tokens?: number;
  readonly thinking?: unknown;
  readonly output_config?: unknown;
  readonly [field: string]: unknown;
}

export interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** 模型请求的请求体；拉模型列表是 GET，没有请求体。 */
  readonly body: SentBody | null;
  readonly signal: AbortSignal;
}

export type ServiceReply = TransportResponse & JsonResponse;
export type ServiceHandler = (request: SentRequest) => ServiceReply | Promise<ServiceReply>;

export function reply(data: unknown, status = 200): ServiceReply {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data), json: async () => data };
}

export const chatReply = (content: string): ServiceReply => reply({ choices: [{ message: { content }, finish_reason: "stop" }] });

export const anthropicReply = (text: string): ServiceReply => reply({ content: [{ type: "text", text }], stop_reason: "end_turn" });

/** 一直不回，直到请求被中止：超时和取消都走这条路。 */
export function hangUntilAborted({ signal }: SentRequest): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("请求被中止", "AbortError"));
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface ModelService {
  readonly fetch: ModelServiceFetch;
  readonly sent: SentRequest[];
  /** 只算模型请求，不算拉模型列表。 */
  readonly posts: () => SentRequest[];
}

export function modelService(handler?: ServiceHandler): ModelService {
  const sent: SentRequest[] = [];
  const fetch: ModelServiceFetch = async (url, init) => {
    const body = "body" in init ? (JSON.parse(init.body) as SentBody) : null;
    const request: SentRequest = { url, method: "method" in init ? init.method : "GET", headers: { ...init.headers }, body, signal: init.signal };
    sent.push(request);
    if (!handler) throw new Error("测试里没有准备模型服务的回复");
    return handler(request);
  };
  return { fetch, sent, posts: () => sent.filter((request) => request.method === "POST") };
}

export const SAMPLE_KEY = "sk-sample-key-for-offline-tests";

/** 本机设置加会话里的密钥：确认过数据说明和启用，密钥记在给定的来源上。 */
export function keyedStorage(settings: SettingsInput, origin: string, key: string = SAMPLE_KEY) {
  return {
    local: { [SETTINGS_STORAGE_KEY]: { ...DATA_CONSENT_CONFIRMED, ...ACTIVATION_CONFIRMED, ...settings } },
    session: { [API_KEY_SESSION_KEY]: { key, origin } },
  };
}
