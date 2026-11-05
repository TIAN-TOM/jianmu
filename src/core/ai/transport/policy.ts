// 重发的策略：每轮预算怎么放大、限流过载后等多久、哪些失败重发也没用。
import type { ClaudeCapabilities } from "../provider/index.ts";
import { taskCanceledError } from "./errors.ts";
import type { TransportResponse } from "./types.ts";

// 加码重试的天花板。再往上多数模型会因超过自身输出上限直接拒绝请求。
export const OUTPUT_TOKENS_CEILING = 32_768;
// 一次调用最多发几轮（参数被拒后的放宽重发不算，那种请求没有生成内容）。
export const MAX_ATTEMPTS = 3;
// 一次调用各轮 max_tokens 的合计上限。每次重发都是一次新的完整请求，
// 输入和输出都要重新计费，合计封顶后最坏情况的花费才是可预期的。
export const TOTAL_OUTPUT_TOKENS_CAP = 2 * OUTPUT_TOKENS_CEILING;
// 限流、过载后自动重发一次之前最多等多久。服务要求等得更久时不等，直接报给用户。
export const BUSY_RETRY_MAX_WAIT_MS = 20_000;
// 服务没给 Retry-After 时在这个区间里随机等一会儿，免得几个并发请求同时撞回去。
export const BUSY_RETRY_MIN_MS = 2_000;
export const BUSY_RETRY_SPREAD_MS = 3_000;
// 只有这几种是服务在生成之前就拒绝了，不计费，重发一次是安全的。
// 500、502、504 说不准服务端有没有已经在生成，不自动重发。
export const BUSY_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);
// 额度、余额用完的 429：等多久都不会恢复，用户需要马上看到。
export const QUOTA_EXHAUSTED = /quota|billing|insufficient|balance|credit|余额|额度|欠费/i;
// 中转站（one-api、new-api 一类）没有这个模型时回 503 加一句说明：模型名配错了，
// 等多久重发都一样，要用户去设置页改。
export const MODEL_UNAVAILABLE = /model_not_found|无可用渠道|no available channel/i;

/** 能被取消信号打断的等待：取消时立刻以 TASK_CANCELED 结束。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(taskCanceledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(taskCanceledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// 重发前的等待听哪个信号：两个都有就任一中止都算。
export function waitSignal(
  signal: AbortSignal | undefined,
  retrySignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!retrySignal || retrySignal === signal) return signal;
  if (!signal) return retrySignal;
  return AbortSignal.any([signal, retrySignal]);
}

/**
 * 响应头里的建议等待时长（毫秒）。OpenAI 另有 retry-after-ms；
 * 标准的 Retry-After 可以是秒数，也可以是 HTTP 日期。认不出时返回 undefined。
 */
export function retryAfterMsOf(headers: TransportResponse["headers"]): number | undefined {
  const get = (name: string): string | null => {
    try {
      return headers?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  const ms = Number(get("retry-after-ms"));
  if (get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = get("retry-after");
  if (raw === null || String(raw).trim() === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * 下一轮的预算：放大四倍，但不超过单轮天花板，也不超过本次调用剩下的合计额度。
 * 放不大（已到顶或额度用完）时返回 0，表示不值得再发。
 */
export function raisedBudget(tokens: number, spent: number, ceiling: number = OUTPUT_TOKENS_CEILING): number {
  const next = Math.min(tokens * 4, ceiling, TOTAL_OUTPUT_TOKENS_CAP - spent);
  return next > tokens ? next : 0;
}

/**
 * 单轮预算的天花板：模型自己的 max_tokens 上限比通用天花板低时以它为准，
 * 超过它的请求会被直接拒绝。不知道上限时用通用天花板。
 */
export function ceilingFor(capabilities: ClaudeCapabilities | null): number {
  const limit = Number(capabilities?.maxTokens);
  return limit > 0 ? Math.min(OUTPUT_TOKENS_CEILING, limit) : OUTPUT_TOKENS_CEILING;
}
