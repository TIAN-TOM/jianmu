// 响应信封的解析：正常响应走截断补齐，强制流式的拼回普通响应，错误响应只求别丢状态码。
import { repairTruncatedJson } from "../parse.ts";
import { assembleEventStream, looksLikeEventStream, redactSecret, withEnglish, type Protocol } from "../provider/index.ts";
import { transportBoth } from "./text.ts";
import type { TransportError } from "./types.ts";

/**
 * 补齐过的信封。响应数据要原样经过放宽重发才回到 requestAiCompletion，
 * 不方便改它的形状，所以在这里登记，那边拿到数据再查。
 */
const repairedEnvelopes = new WeakSet<object>();

export const isRepairedEnvelope = (data: unknown): boolean => repairedEnvelopes.has(data as object);

/**
 * 事件流中途报了错：响应头已经是成功，状态码只能从错误类型对应出来。
 * 拼成和错误响应一样的形状，记下对应的状态码，发送那一层照错误响应处理。
 */
const streamFailures = new WeakMap<object, number>();

export const streamFailureStatus = (data: unknown): number | undefined =>
  data && typeof data === "object" ? streamFailures.get(data) : undefined;

/** 认事件流要用的两样：响应类型和这次请求的协议。没有协议时不认，按 JSON 解析。 */
export interface EnvelopeHints {
  readonly contentType?: string | null | undefined;
  readonly protocol?: Protocol | undefined;
}

// 只看开头一小段就够认出事件流。
const STREAM_HEAD_CHARS = 64;

function truncatedError(): TransportError {
  const { message, messageEn, messageHant } = transportBoth((text) => text.incomplete);
  const truncated: TransportError = withEnglish(new Error(message), messageEn, messageHant);
  truncated.code = "AI_RESPONSE_TRUNCATED";
  return truncated;
}

/**
 * 信封解析：截断的 body 补齐后解析；修不动才翻译成能看懂的报错。
 * 补齐出来的信封记进 repairedEnvelopes：正文可能只有半截，服务商写在末尾的
 * 截断原因（finish_reason、stop_reason、status）也多半跟着丢了。
 * 网关强制回了事件流时先拼成普通响应：断在半截的流同样记进 repairedEnvelopes，
 * 一个事件也认不出的和修不动的 JSON 一样报响应不完整。
 */
export function parseResponseEnvelope(text: string, { contentType, protocol }: EnvelopeHints = {}): unknown {
  if (protocol && looksLikeEventStream(contentType, text.slice(0, STREAM_HEAD_CHARS))) {
    return parseEventStream(protocol, text);
  }
  const raw = text.trimStart();
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const repaired: unknown = JSON.parse(repairTruncatedJson(raw));
      if (repaired && typeof repaired === "object") repairedEnvelopes.add(repaired);
      return repaired;
    } catch {
      throw truncatedError();
    }
  }
}

function parseEventStream(protocol: Protocol, text: string): unknown {
  const assembled = assembleEventStream(protocol, text);
  if (!assembled.ok) {
    const { message, type, code, param } = assembled;
    const failure = { error: { message, ...(type ? { type } : {}), ...(code ? { code } : {}), ...(param ? { param } : {}) } };
    streamFailures.set(failure, assembled.status);
    return failure;
  }
  if (!assembled.data) throw truncatedError();
  if (!assembled.complete) repairedEnvelopes.add(assembled.data);
  return assembled.data;
}

/**
 * 错误响应的 body：JSON 照常解析；纯文本先脱敏再取前 200 字当报错原文，
 * 否则跨过截断线的密钥只剩前半截，后面的脱敏认不出来；
 * HTML 错误页和空 body 只留状态码（parseErrorMessage 会写成「服务返回 502」）。
 * 不走截断修复：错误响应里没有值得补齐的正文。
 */
export function parseErrorEnvelope(text: string, secret?: unknown): unknown {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    if (raw.startsWith("<")) return {};
    return { error: { message: redactSecret(raw, secret).slice(0, 200) } };
  }
}
