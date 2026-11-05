// 响应信封的解析：正常响应走截断补齐，错误响应只求别丢状态码。
import { repairTruncatedJson } from "../parse.ts";
import { redactSecret } from "../provider/index.ts";
import type { TransportError } from "./types.ts";

/**
 * 补齐过的信封。响应数据要原样经过放宽重发才回到 requestAiCompletion，
 * 不方便改它的形状，所以在这里登记，那边拿到数据再查。
 */
const repairedEnvelopes = new WeakSet<object>();

export const isRepairedEnvelope = (data: unknown): boolean => repairedEnvelopes.has(data as object);

/**
 * 信封解析：截断的 body 补齐后解析；修不动才翻译成能看懂的报错。
 * 补齐出来的信封记进 repairedEnvelopes：正文可能只有半截，服务商写在末尾的
 * 截断原因（finish_reason、stop_reason、status）也多半跟着丢了。
 */
export function parseResponseEnvelope(text: string): unknown {
  const raw = text.trimStart();
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const repaired: unknown = JSON.parse(repairTruncatedJson(raw));
      if (repaired && typeof repaired === "object") repairedEnvelopes.add(repaired);
      return repaired;
    } catch {
      const truncated: TransportError = new Error("AI 响应不完整，请重试。");
      truncated.code = "AI_RESPONSE_TRUNCATED";
      throw truncated;
    }
  }
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
