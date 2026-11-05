// 模型返回 200 却没有正文时，判断成因并给出下一步。
import { claudeRequestTraits } from "./anthropic.ts";
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import { hasReasoningItem, responsesMessages, responsesReasoningTokens } from "./response.ts";
import type { ClaudeCapabilities, EmptyDiagnosis, ProviderResponse, RelaxState, ResponseChoice } from "./types.ts";

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
  const reasoningOnlyMessage = locked
    ? "模型只输出了思考过程，没有正文。这个型号的思考关不掉，可以重试一次，或者在设置页「按功能选模型」里给这项功能另选一个型号。"
    : "模型只输出了思考过程，没有正文。建议在设置页换一个非推理模型。";

  if (protocol === PROTOCOLS.RESPONSES) return diagnoseEmptyResponses(payload);

  if (protocol === PROTOCOLS.ANTHROPIC) {
    // 拿到的是 OpenAI 形状的响应，说明协议选错了。
    if (!Array.isArray(payload.content) && Array.isArray(payload.choices)) {
      return {
        reason: "PROTOCOL_MISMATCH",
        message:
          "响应看起来是 OpenAI 格式，但当前选的是 Anthropic 协议。请到设置页把「API 协议」改成 OpenAI 兼容。",
        retryWithoutJsonMode: false,
      };
    }
    if (payload.stop_reason === "max_tokens") {
      return {
        reason: "TRUNCATED",
        message: locked
          ? "模型还没输出正文就到了 token 上限，思考占满了额度。已经放大预算重试过，仍然不够。这个型号的思考关不掉，扩展已经替你放大过预算。可以在设置页「按功能选模型」里给这项功能另选一个型号；生成概览时，也可以把「概览分块」改成「较短」。"
          : "模型还没输出正文就到了 token 上限，多半是思考占满了额度。已经放大预算重试过，仍然不够，建议换一个非推理模型。",
        retryWithoutJsonMode: false,
        retryWithMoreTokens: true,
      };
    }
    // 只有 thinking 块、没有 text 块
    if (
      Array.isArray(payload.content) &&
      payload.content.some((block) => block?.type === "thinking")
    ) {
      return {
        reason: "REASONING_ONLY",
        message: reasoningOnlyMessage,
        retryWithoutJsonMode: false,
      };
    }
    return {
      reason: "EMPTY_CONTENT",
      message: "模型返回了空内容，请重试。",
      retryWithoutJsonMode: false,
    };
  }

  if (!Array.isArray(payload.choices) || !payload.choices.length) {
    // 拿到的是 Anthropic 形状的响应，说明协议选错了。
    if (Array.isArray(payload.content)) {
      return {
        reason: "PROTOCOL_MISMATCH",
        message:
          "响应看起来是 Anthropic 格式，但当前选的是 OpenAI 兼容协议。请到设置页把「API 协议」改成 Anthropic。",
        retryWithoutJsonMode: false,
      };
    }
    return {
      reason: "NO_CHOICES",
      message:
        "响应里没有 choices 字段，这个地址可能不是 OpenAI 兼容接口。请到设置页核对 API 地址与协议。",
      retryWithoutJsonMode: false,
    };
  }

  const choice: ResponseChoice = payload.choices[0] || {};
  const message = choice.message || {};
  // 推理模型把内容放在 reasoning_content，content 反而是空的。
  const reasoning = message.reasoning_content || message.reasoning;

  if (choice.finish_reason === "length") {
    return {
      reason: "TRUNCATED",
      message: !reasoning
        ? "输出被 token 上限截断了，放大预算重试后仍然不够。可以换一个输出更简洁的模型试试。"
        : locked
          ? "模型把 token 配额全用在思考上了，没能输出正文。已经放大预算重试过，仍然不够。这个型号的思考关不掉，扩展已经替你放大过预算。可以在设置页「按功能选模型」里给这项功能另选一个型号；生成概览时，也可以把「概览分块」改成「较短」。"
          : "模型把 token 配额全用在思考上了，没能输出正文。已经放大预算重试过，仍然不够，建议换一个非推理模型。",
      retryWithoutJsonMode: false,
      retryWithMoreTokens: true,
    };
  }
  if (reasoning) {
    return {
      reason: "REASONING_ONLY",
      message: reasoningOnlyMessage,
      retryWithoutJsonMode: false,
    };
  }

  // 剩下最常见的是 JSON 模式偶发返回空串；提示词本身已要求 JSON，
  // 去掉 response_format 再试一次通常能成。
  return {
    reason: "EMPTY_CONTENT",
    message: "模型返回了空内容，请重试。",
    retryWithoutJsonMode: true,
  };
}

// Responses 的空响应：status、incomplete_details 和 output 里的项说明了成因。
function diagnoseEmptyResponses(payload: ProviderResponse): EmptyDiagnosis {
  if (!Array.isArray(payload.output)) {
    if (Array.isArray(payload.choices) || Array.isArray(payload.content)) {
      return {
        reason: "PROTOCOL_MISMATCH",
        message:
          "响应不是 Responses 格式，这个地址可能只支持 Chat Completions 或 Anthropic。请到设置页核对「API 协议」。",
        retryWithoutJsonMode: false,
      };
    }
    return {
      reason: "NO_OUTPUT",
      message:
        "响应里没有 output 字段，这个地址可能不支持 Responses 接口。请到设置页核对 API 地址与协议。",
      retryWithoutJsonMode: false,
    };
  }
  const incomplete = payload.status === "incomplete" ? payload.incomplete_details?.reason : "";
  const reasoned = responsesReasoningTokens(payload) > 0 || hasReasoningItem(payload);
  if (incomplete === "max_output_tokens") {
    return {
      reason: "TRUNCATED",
      message: reasoned
        ? "模型把 token 配额全用在推理上了，没能输出正文。已经放大预算重试过，仍然不够，可以换一个推理更少的型号。"
        : "输出被 token 上限截断了，放大预算重试后仍然不够。可以换一个输出更简洁的模型试试。",
      retryWithoutJsonMode: false,
      retryWithMoreTokens: true,
    };
  }
  if (incomplete === "content_filter") {
    return {
      reason: "CONTENT_FILTERED",
      message: "输出被服务方的内容过滤拦下了，没有正文。",
      retryWithoutJsonMode: false,
    };
  }
  if (payload.status === "failed") {
    return {
      reason: "FAILED",
      message: payload.error?.message || "模型生成失败，请重试。",
      retryWithoutJsonMode: false,
    };
  }
  // 推理模型的输出里总有推理项；连 message 项都没有，才是只做了推理。
  if (hasReasoningItem(payload) && !responsesMessages(payload).length) {
    return {
      reason: "REASONING_ONLY",
      message: "模型只做了推理，没有输出正文。可以换一个推理更少的型号再试。",
      retryWithoutJsonMode: false,
    };
  }
  return {
    reason: "EMPTY_CONTENT",
    message: "模型返回了空内容，请重试。",
    retryWithoutJsonMode: true,
  };
}
