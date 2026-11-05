// OpenAI Responses 的响应夹具，字段和形状照官方文档的示例写。
interface Overrides {
  readonly [field: string]: unknown;
}

export function baseResponse(overrides: Overrides = {}) {
  return {
    id: "resp_67ccd7eca01881908ff0b5146584e408072912b2993db808",
    object: "response",
    created_at: 1741477868,
    status: "completed",
    completed_at: 1741477869,
    error: null,
    incomplete_details: null,
    instructions: "你是助理",
    max_output_tokens: 2048,
    model: "gpt-6-astra",
    output: [] as readonly unknown[],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "low", summary: null },
    store: false,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1.0,
    truncation: "disabled",
    usage: {
      input_tokens: 81,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 1035,
      output_tokens_details: { reasoning_tokens: 832 },
      total_tokens: 1116,
    },
    user: null,
    metadata: {},
    ...overrides,
  };
}

export const reasoningItem = () => ({
  type: "reasoning",
  id: "rs_67ccd7f7b5848190a6f3e95d809f6b44072912b2993db808",
  summary: [],
});

export function messageItem(
  content: readonly unknown[],
  { status = "completed", phase }: { status?: string; phase?: string } = {},
) {
  return {
    type: "message",
    id: "msg_67ccd7f7b5848190a6f3e95d809f6b44072912b2993db808",
    status,
    role: "assistant",
    ...(phase ? { phase } : {}),
    content,
  };
}

export const outputText = (text: string) => ({ type: "output_text", text, annotations: [], logprobs: [] });

export function completed(text: string, overrides: Overrides = {}) {
  return baseResponse({
    output: [reasoningItem(), messageItem([outputText(text)])],
    ...overrides,
  });
}

export function refusal(reason = "I'm sorry, I cannot assist with that request.") {
  return baseResponse({
    output: [messageItem([{ type: "refusal", refusal: reason }])],
  });
}

// partialText 为空时只有推理项：推理还没做完就到了上限，一个字的正文都没写。
export function incomplete(
  partialText = "",
  { reason = "max_output_tokens", reasoningTokens = 2000 }: { reason?: string; reasoningTokens?: number } = {},
) {
  return baseResponse({
    status: "incomplete",
    completed_at: null,
    incomplete_details: { reason },
    output: partialText
      ? [reasoningItem(), messageItem([outputText(partialText)], { status: "incomplete" })]
      : [reasoningItem()],
    usage: {
      input_tokens: 81,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 2048,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: 2129,
    },
  });
}

// 包成传输层读得懂的 fetch 响应。
export function asFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}
