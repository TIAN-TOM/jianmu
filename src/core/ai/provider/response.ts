// 解析三种协议的响应：取正文、认拒绝和截断，取报错信息和模型列表。
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import type { ProviderResponse, ResponseBlock, ResponseItem } from "./types.ts";

type Payload = ProviderResponse | null | undefined;

/**
 * Responses 的 output 里混着 reasoning、message 等几类项，正文在 message 项的
 * output_text 内容块里。带 phase 的型号会把中途说明标成 commentary，只取最终回答。
 */
export function responsesMessages(data: Payload): ResponseItem[] {
  const items = Array.isArray(data?.output)
    ? data.output.filter((item) => item?.type === "message")
    : [];
  const final = items.filter((item) => item.phase !== "commentary");
  return final.length ? final : items;
}

function responsesParts(data: Payload, type: string): ResponseBlock[] {
  return responsesMessages(data)
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === type);
}

export function responsesReasoningTokens(data: Payload): number {
  return Number(data?.usage?.output_tokens_details?.reasoning_tokens) || 0;
}

export const hasReasoningItem = (data: Payload): boolean =>
  Array.isArray(data?.output) && data.output.some((item) => item?.type === "reasoning");

// 取不到文本时返回空串，由调用方统一报「空响应」。
export function parseChatResponse(protocol: Protocol, data: unknown): string {
  const payload = data as Payload;
  if (protocol === PROTOCOLS.RESPONSES) {
    return responsesParts(payload, "output_text")
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  if (protocol === PROTOCOLS.ANTHROPIC) {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** 错误体里用得到的字段，error 也可能直接是字符串。 */
interface ErrorBody {
  readonly error?: { readonly message?: string; readonly type?: string; readonly param?: string } | string;
  readonly message?: string;
}

export function parseErrorMessage(data: unknown, status: number): string {
  const payload = (data && typeof data === "object" ? data : {}) as ErrorBody;
  const detail = payload.error as Exclude<ErrorBody["error"], string> | undefined;
  const message =
    detail?.message ||
    detail?.type ||
    payload.message ||
    (typeof payload.error === "string" ? payload.error : "");
  return message || `服务返回 ${status}`;
}

interface ModelEntry {
  readonly id?: string;
  readonly name?: string;
}

interface ModelList {
  readonly data?: (ModelEntry | string)[];
  readonly models?: (ModelEntry | string)[];
}

export function parseModelsResponse(data: unknown): string[] {
  const payload = data as ModelList | null | undefined;
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  return list
    .map((item) =>
      typeof item === "string" ? item : item?.id || item?.name || "",
    )
    .filter((id) => typeof id === "string" && id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 模型拒绝回答时返回它的说明（没有说明时为空串），没拒绝返回 null。
 * Anthropic 拒绝时 stop_reason 为 refusal，已输出的部分可能不合 schema；
 * Responses 拒绝时 message 里是 refusal 内容块，没有 output_text。
 * 拒绝不重试：同一个请求再发多半还是拒绝，还要再付一次费。
 */
export function refusalOf(protocol: Protocol, data: unknown): string | null {
  const payload = data as Payload;
  if (protocol === PROTOCOLS.ANTHROPIC) return payload?.stop_reason === "refusal" ? "" : null;
  if (protocol === PROTOCOLS.RESPONSES) {
    const refusals = responsesParts(payload, "refusal");
    if (!refusals.length || parseChatResponse(protocol, payload).trim()) return null;
    return refusals
      .map((part) => String(part.refusal || "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return null;
}

/**
 * 有正文但没写完。被 token 上限截断时，思考占了预算的话放大预算能补全；
 * Responses 被内容过滤截停（content_filter）也算没写完，但加大预算没用，
 * 由 canRaiseBudget 拦下，已有正文直接交回。
 */
export function isTruncated(protocol: Protocol, data: unknown): boolean {
  const payload = data as Payload;
  if (protocol === PROTOCOLS.RESPONSES) return payload?.status === "incomplete";
  if (protocol === PROTOCOLS.ANTHROPIC) return payload?.stop_reason === "max_tokens";
  return payload?.choices?.[0]?.finish_reason === "length";
}

/**
 * 有正文但被截断时，加大预算有没有可能补全。重发是一次新的完整请求，要重新计费，
 * 没把握就不发。Anthropic 按型号公开输出上限，新型号都在加码天花板之上，
 * 老型号超了顶多被 400 拒一次，已有正文照样交回；OpenAI 兼容服务各家上限不一，
 * 只有确实看到思考占了预算（reasoning_content、reasoning 或 reasoning_tokens）
 * 才加码，否则重发多半撞上同一个上限，或者因为 max_tokens 过大直接被拒。
 */
export function canRaiseBudget(protocol: Protocol, data: unknown): boolean {
  const payload = data as Payload;
  if (protocol === PROTOCOLS.ANTHROPIC) return true;
  // Responses 同样只在看到推理占了预算时加码；推理内容不回传，只看用量和 reasoning 项。
  if (protocol === PROTOCOLS.RESPONSES) {
    return (
      payload?.incomplete_details?.reason === "max_output_tokens" &&
      (responsesReasoningTokens(payload) > 0 || hasReasoningItem(payload))
    );
  }
  const message = payload?.choices?.[0]?.message || {};
  if (message.reasoning_content || message.reasoning) return true;
  return Number(payload?.usage?.completion_tokens_details?.reasoning_tokens) > 0;
}
