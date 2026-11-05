// 真正发出一次请求，守住超时和响应大小。
//
// 双重超时各管一段，边界是「响应头是否已到达」：之前是模型在生成，
// 归硬超时管；之后 body 应连续到达，静默即视为连接出了问题。
import { KEYED_FETCH_REDIRECT, keyedHttpError, rejectRedirect, type ChatRequest } from "../provider/index.ts";
import { parseErrorEnvelope, parseResponseEnvelope } from "./envelope.ts";
import { taskCanceledError } from "./errors.ts";
import { BUSY_RETRY_MAX_WAIT_MS, BUSY_RETRY_STATUSES, MODEL_UNAVAILABLE, QUOTA_EXHAUSTED, retryAfterMsOf } from "./policy.ts";
import type { AiFetch, SendSettings, TransportError, TransportResponse } from "./types.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 50_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface ErrorBody {
  readonly error?: { readonly code?: unknown; readonly type?: unknown } | null;
}

export interface AiSenderOptions {
  // 测试在别的全局环境里加载时裸 fetch 不一定指向运行环境，要显式注入；生产可不传。
  readonly fetch?: AiFetch | undefined;
  readonly timeoutMs: number;
  readonly idleTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export function createAiSender({
  fetch: fetchImpl,
  timeoutMs,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}: AiSenderOptions) {
  const doFetch: AiFetch = fetchImpl || fetch;

  // 真正发出请求，守住超时与响应大小。
  async function sendAiRequest(
    settings: SendSettings,
    request: ChatRequest,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timeoutKind = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const abortFor = (kind: string): void => {
      if (controller.signal.aborted) return;
      timeoutKind = kind;
      controller.abort();
    };
    const onExternalAbort = (): void => abortFor("external");
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortFor("idle"), idleTimeoutMs);
    };

    hardTimer = setTimeout(() => abortFor("hard"), timeoutMs);
    // 空闲计时绝不能在这里起表：非流式请求在模型生成完之前一个字节都不会到，
    // 提前起表等于把「模型在慢慢想」当成「服务端死了」。这一段只由硬超时负责。

    try {
      const response = await doFetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: KEYED_FETCH_REDIRECT,
        signal: controller.signal,
      });
      rejectRedirect(response, settings.aiBaseUrl);
      // 响应头到了，body 应连续到达，空闲超时从这一刻起才有判断力。
      resetIdleTimer();

      // 错误响应先认状态码：网关、中转站的错误页常常是 HTML 或纯文本，
      // 按正常响应解析会误报成「响应不完整」，状态码也跟着丢了。
      const data = await readBoundedAiResponse(response, resetIdleTimer, {
        lenient: !response.ok,
      });
      if (!response.ok) {
        const error: TransportError = keyedHttpError(data, response.status, settings);
        const retryAfterMs = retryAfterMsOf(response.headers);
        if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
        const body = data as ErrorBody | null | undefined;
        const kind = [body?.error?.code, body?.error?.type, error.message].join(" ");
        if (QUOTA_EXHAUSTED.test(kind)) error.quotaExhausted = true;
        // 限流、过载里马上重发也没用的几种：额度用完、服务要求等得比上限还久、中转站没有这个模型。
        // 标出来，传输层不自动重发，概览的自动补轮也不替它重发。
        if (
          BUSY_RETRY_STATUSES.has(response.status) &&
          ((response.status === 429 && error.quotaExhausted) ||
            (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > BUSY_RETRY_MAX_WAIT_MS) ||
            MODEL_UNAVAILABLE.test(kind))
        ) {
          error.noAutoRetry = true;
        }
        throw error;
      }

      return data;
    } catch (error) {
      if (timeoutKind === "external" || externalSignal?.aborted) {
        throw taskCanceledError();
      }
      if (timeoutKind === "idle") {
        const timeout: TransportError = new Error("响应传到一半断了，请重试。");
        timeout.code = "AI_IDLE_TIMEOUT";
        throw timeout;
      }
      if (timeoutKind === "hard") {
        const timeout: TransportError = new Error(
          `请求超过 ${Math.round(timeoutMs / 1000)} 秒上限，可能是服务繁忙或这一段太长。概览可以在设置页把「概览分块」改成「较短」再试。`,
        );
        timeout.code = "AI_HARD_TIMEOUT";
        throw timeout;
      }
      // fetch 对跨域被拒和网络不通都只抛笼统的 TypeError，给一句能指导下一步的提示。
      if (error instanceof TypeError) {
        const network: TransportError = new Error(
          `连不上 ${settings.aiBaseUrl}。请检查地址是否正确、服务是否在运行，以及是否已在设置页授权。`,
        );
        network.code = "AI_NETWORK_ERROR";
        throw network;
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    }
  }

  /**
   * 边读边计字节数，避免异常大的响应把内存吃满。
   * lenient 用于错误响应：解析不了不报错，交给 keyedHttpError 按状态码处理。
   */
  async function readBoundedAiResponse(
    response: TransportResponse,
    onActivity: () => void,
    { lenient = false }: { readonly lenient?: boolean } = {},
  ): Promise<unknown> {
    const parse = lenient ? parseErrorEnvelope : parseResponseEnvelope;
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      onActivity();
      return parse(text);
    }

    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      bytes += value?.byteLength ?? 0;
      if (bytes > maxResponseBytes) {
        await reader.cancel?.().catch(() => {});
        const error: TransportError = new Error("响应超过 2 MiB 上限。");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return parse(text);
  }

  return { sendAiRequest, readBoundedAiResponse };
}
