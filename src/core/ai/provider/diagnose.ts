// 模型返回 200 却没有正文时，判断成因并给出下一步。
import { claudeRequestTraits } from "./anthropic.ts";
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import { hasReasoningItem, isTruncated, responsesMessages, responsesReasoningTokens } from "./response.ts";
import { bothLangs, withEnglish, type ProviderText } from "./text.ts";
import type { ClaudeCapabilities, EmptyDiagnosis, ProviderResponse, RelaxState, ResponseChoice } from "./types.ts";

// 一条诊断：说明中文放 message，英文挂在不可枚举的 messageEn 上（见 text.ts）。
function diagnosis(
  reason: string,
  pick: (text: ProviderText) => string,
  retry: Pick<EmptyDiagnosis, "retryWithoutJsonMode" | "retryWithMoreTokens">,
): EmptyDiagnosis {
  const { message, messageEn, messageHant } = bothLangs(pick);
  return withEnglish({ reason, message, ...retry }, messageEn, messageHant);
}

/**
 * 思考关不掉的组合：Opus 5.5、Fable、Mythos 只能自适应思考，Sonnet 5.5 最低也只到
 * between_tools；型号名认不出、但服务拒绝过 disabled 的（relax.thinking 有值）同样算。
 */
function thinkingAlwaysOn(
  model: string | null | undefined,
  relax: RelaxState = {},
  capabilities: ClaudeCapabilities | null = null,
): boolean {
  return (
    Boolean(relax.thinking) ||
    claudeRequestTraits(model, { capabilities }).thinking !== "disabled"
  );
}

export interface DiagnoseContext {
  readonly model?: string | null | undefined;
  readonly relax?: RelaxState | undefined;
  readonly capabilities?: ClaudeCapabilities | null | undefined;
}

/**
 * 模型返回 200 却没有正文时，判断成因：协议选错、token 截断、推理占满配额、
 * JSON 模式有毛病——每种对应的动作不同。两个 retry 标志对应可自愈的成因；
 * message 按「重试过仍不行」的口径写，因为它只在重试用尽后才会被看到。
 * 思考关不掉的模型不能建议「换非推理模型」。官方排错页的做法是调大输出上限或降低 effort，
 * 但这两项设置页里都没有，所以只建议用户做得到的：另选型号、把概览分得更小。
 */
export function diagnoseEmptyResponse(
  protocol: Protocol,
  data: unknown,
  { model, relax, capabilities }: DiagnoseContext = {},
): EmptyDiagnosis {
  const payload = (data && typeof data === "object" ? data : {}) as ProviderResponse;
  const locked = thinkingAlwaysOn(model, relax, capabilities);
  // 只有思考没有正文，说明模型自己认为说完了，不是预算不够，调大上限帮不上忙。
  const reasoningOnlyMessage = (text: ProviderText): string => (locked ? text.reasoningOnlyLocked : text.reasoningOnly);

  if (protocol === PROTOCOLS.RESPONSES) return diagnoseEmptyResponses(payload);

  if (protocol === PROTOCOLS.ANTHROPIC) {
    // 拿到的是 OpenAI 形状的响应，说明协议选错了。
    if (!Array.isArray(payload.content) && Array.isArray(payload.choices)) {
      return diagnosis("PROTOCOL_MISMATCH", (text) => text.anthropicGotOpenAi, { retryWithoutJsonMode: false });
    }
    if (payload.stop_reason === "max_tokens") {
      return diagnosis("TRUNCATED", (text) => (locked ? text.thinkingTruncatedLocked : text.thinkingTruncated), {
        retryWithoutJsonMode: false,
        retryWithMoreTokens: true,
      });
    }
    // 只有 thinking 块、没有 text 块
    if (
      Array.isArray(payload.content) &&
      payload.content.some((block) => block?.type === "thinking")
    ) {
      return diagnosis("REASONING_ONLY", reasoningOnlyMessage, { retryWithoutJsonMode: false });
    }
    return diagnosis("EMPTY_CONTENT", (text) => text.empty, { retryWithoutJsonMode: false });
  }

  if (!Array.isArray(payload.choices) || !payload.choices.length) {
    // 拿到的是 Anthropic 形状的响应，说明协议选错了。
    if (Array.isArray(payload.content)) {
      return diagnosis("PROTOCOL_MISMATCH", (text) => text.openAiGotAnthropic, { retryWithoutJsonMode: false });
    }
    return diagnosis("NO_CHOICES", (text) => text.noChoices, { retryWithoutJsonMode: false });
  }

  const choice: ResponseChoice = payload.choices[0] || {};
  const message = choice.message || {};
  // 推理模型把内容放在 reasoning_content，content 反而是空的。
  const reasoning = message.reasoning_content || message.reasoning;

  if (choice.finish_reason === "length") {
    // 有的服务不回传思考的内容，只在用量里报思考用了多少。
    const thought = Boolean(reasoning) || Number(payload.usage?.completion_tokens_details?.reasoning_tokens) > 0;
    return diagnosis("TRUNCATED", (text) => (!thought ? text.truncated : locked ? text.quotaOnThinkingLocked : text.quotaOnThinking), {
      retryWithoutJsonMode: false,
      retryWithMoreTokens: true,
    });
  }
  if (reasoning) {
    return diagnosis("REASONING_ONLY", reasoningOnlyMessage, { retryWithoutJsonMode: false });
  }

  // 剩下最常见的是 JSON 模式偶发返回空串；提示词本身已要求 JSON，
  // 去掉 response_format 再试一次通常能成。
  return diagnosis("EMPTY_CONTENT", (text) => text.empty, { retryWithoutJsonMode: true });
}

/**
 * 没写出正文就到了输出上限时，是不是思考把额度用掉了：看得见思考的内容，服务回报的用量里有思考，
 * 或者这个型号的思考关不掉。只在没有正文的时候问：这时只要有思考，额度就都是思考用掉的。
 * 判断不了的（没有思考的痕迹）回 false，照旧按普通的截断说。
 */
export function thinkingUsedUpBudget(protocol: Protocol, data: unknown, { model, relax, capabilities }: DiagnoseContext = {}): boolean {
  if (!isTruncated(protocol, data)) return false;
  const payload = (data && typeof data === "object" ? data : {}) as ProviderResponse;
  if (protocol === PROTOCOLS.RESPONSES) {
    return payload.incomplete_details?.reason === "max_output_tokens" && (responsesReasoningTokens(payload) > 0 || hasReasoningItem(payload));
  }
  if (protocol === PROTOCOLS.ANTHROPIC) {
    const thought = Array.isArray(payload.content) && payload.content.some((block) => block?.type === "thinking" || block?.type === "redacted_thinking");
    return thought || thinkingAlwaysOn(model, relax, capabilities);
  }
  const message = payload.choices?.[0]?.message || {};
  return Boolean(message.reasoning_content || message.reasoning) || Number(payload.usage?.completion_tokens_details?.reasoning_tokens) > 0;
}

// Responses 的空响应：status、incomplete_details 和 output 里的项说明了成因。
function diagnoseEmptyResponses(payload: ProviderResponse): EmptyDiagnosis {
  if (!Array.isArray(payload.output)) {
    if (Array.isArray(payload.choices) || Array.isArray(payload.content)) {
      return diagnosis("PROTOCOL_MISMATCH", (text) => text.notResponses, { retryWithoutJsonMode: false });
    }
    return diagnosis("NO_OUTPUT", (text) => text.noOutput, { retryWithoutJsonMode: false });
  }
  const incomplete = payload.status === "incomplete" ? payload.incomplete_details?.reason : "";
  const reasoned = responsesReasoningTokens(payload) > 0 || hasReasoningItem(payload);
  if (incomplete === "max_output_tokens") {
    return diagnosis("TRUNCATED", (text) => (reasoned ? text.quotaOnReasoning : text.truncated), {
      retryWithoutJsonMode: false,
      retryWithMoreTokens: true,
    });
  }
  if (incomplete === "content_filter") {
    return diagnosis("CONTENT_FILTERED", (text) => text.contentFiltered, { retryWithoutJsonMode: false });
  }
  if (payload.status === "failed") {
    // 服务自己给了说明就照原样，两种语言都用它。
    const said = payload.error?.message;
    return diagnosis("FAILED", (text) => said || text.generationFailed, { retryWithoutJsonMode: false });
  }
  // 推理模型的输出里总有推理项；连 message 项都没有，才是只做了推理。
  if (hasReasoningItem(payload) && !responsesMessages(payload).length) {
    return diagnosis("REASONING_ONLY", (text) => text.reasoningOnlyResponses, { retryWithoutJsonMode: false });
  }
  return diagnosis("EMPTY_CONTENT", (text) => text.empty, { retryWithoutJsonMode: true });
}
