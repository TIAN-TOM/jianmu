// 构造对话和模型列表请求：配置 → {url, headers, body}。
import { apiVersionFor, claudeRequestTraits, isOfficialAnthropic, THINKING_BETWEEN_TOOLS, THINKING_DISABLED } from "./anthropic.ts";
import { chatCompletionsUrl, modelsUrl, PROTOCOLS } from "./endpoint.ts";
import { isOpenAiReasoningModel, openAiModelTraits, vendorExtras } from "./openai.ts";
import type { ResponseSchema } from "../schemas.ts";
import type {
  AiSettings,
  ChatMessage,
  ChatRequest,
  ChatRequestBody,
  ChatRequestInput,
  ModelsRequest,
  RelaxState,
  ResponseFormat,
} from "./types.ts";

// 不支持结构化输出时退回的 JSON 模式，靠提示词约束字段。
const JSON_OBJECT_FORMAT = Object.freeze({ type: "json_object" });

// responseFormat 是 schemas.ts 的描述对象时取出它；{ type: "json_object" } 返回 null。
function jsonSchemaOf(responseFormat: ResponseFormat | null | undefined): ResponseSchema | null {
  return responseFormat?.type === "json_schema" && responseFormat.schema
    ? responseFormat
    : null;
}

// Anthropic 把 system 放在顶层，不接受 role 为 system 的消息。
export function splitSystemMessages(messages: readonly ChatMessage[] | null | undefined): {
  system: string;
  messages: ChatMessage[];
} {
  const list = Array.isArray(messages) ? messages : [];
  const system = list
    .filter((message) => message?.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = list
    .filter((message) => message?.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  return { system, messages: rest };
}

/**
 * OpenAI Responses 的请求体。系统提示放 instructions，其余消息放 input；
 * max_output_tokens 同样把推理 token 算在内。
 */
function buildResponsesBody({
  settings,
  messages,
  maxTokens,
  temperature,
  responseFormat,
  relax,
}: ChatRequestInput & { readonly relax: RelaxState }): ChatRequestBody {
  const split = splitSystemMessages(messages);
  const traits = openAiModelTraits(settings.aiModel);
  const body: ChatRequestBody & { input: readonly ChatMessage[] } = {
    model: settings.aiModel,
    input: split.messages,
    max_output_tokens: maxTokens,
    // 默认会在服务端存 30 天。每次都是一次性的请求，用不着存，显式关掉。
    store: false,
  };
  if (split.system) body.instructions = split.system;
  if (traits.effort && !relax.effort) body.reasoning = { effort: traits.effort };
  // 推理模型在档位不是 none 时拒绝 temperature，和 Chat Completions 一样不发。
  if (typeof temperature === "number" && !traits.reasoning && !relax.temperature) {
    body.temperature = temperature;
  }
  if (responseFormat && !relax.jsonObject) {
    const schema = jsonSchemaOf(responseFormat);
    const structured = schema && traits.structuredOutputs && !relax.format;
    body.text = {
      format: structured
        ? { type: "json_schema", name: schema.name, schema: schema.schema, strict: true }
        : JSON_OBJECT_FORMAT,
    };
    if (!structured) body.input = withJsonMention(body.input);
  }
  return body;
}

/**
 * JSON 模式要求 input 里出现 "JSON" 这个词，instructions 不算。我们的提示词只在系统
 * 提示里讲输出格式，所以在最后一条用户消息末尾补一句；已经有这个词时原样返回。
 */
const JSON_MENTION = "请只输出 JSON。";

function withJsonMention(input: readonly ChatMessage[]): readonly ChatMessage[] {
  const index = input.findLastIndex((message) => message.role === "user");
  const last = input[index];
  if (!last || typeof last.content !== "string") {
    return [...input, { role: "user", content: JSON_MENTION }];
  }
  if (/\bjson\b/i.test(last.content)) return input;
  const next = [...input];
  next[index] = { ...last, content: `${last.content}\n\n${JSON_MENTION}` };
  return next;
}

export function buildChatRequest({
  settings,
  messages,
  maxTokens,
  temperature,
  responseFormat,
  // 模型拒绝某个参数后由 relaxRejectedParams 算出。
  relax = {},
  // 当前模型的能力（capabilities.ts），目前只有 Anthropic 用得上。
  capabilities = null,
}: ChatRequestInput): ChatRequest {
  const url = chatCompletionsUrl(settings);
  if (!url) throw new Error("API 地址不合法，请到设置页检查。");

  if (settings.protocol === PROTOCOLS.ANTHROPIC) {
    const split = splitSystemMessages(messages);
    const traits = claudeRequestTraits(settings.aiModel, {
      official: isOfficialAnthropic(settings.aiBaseUrl),
      capabilities,
    });
    const thinking = relax.thinking === true ? "adaptive" : relax.thinking || traits.thinking;
    const body: ChatRequestBody = {
      model: settings.aiModel,
      // Anthropic 的 max_tokens 是必填项。
      max_tokens: maxTokens,
      messages: split.messages,
    };
    // effort 和结构化输出同在 output_config 里，合成一个对象发。
    const outputConfig: NonNullable<ChatRequestBody["output_config"]> = {};
    if (thinking === "disabled") {
      body.thinking = THINKING_DISABLED;
    } else {
      if (thinking === "between_tools") body.thinking = THINKING_BETWEEN_TOOLS;
      else if (thinking !== "adaptive") body.thinking = { type: thinking };
      if (traits.effort) outputConfig.effort = traits.effort;
    }
    // 结构化输出和 prefill、citations 不兼容，这里的请求两样都不用。
    const schema = jsonSchemaOf(responseFormat);
    if (schema && traits.structuredOutputs && !relax.format) {
      outputConfig.format = { type: "json_schema", schema: schema.schema };
    }
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (split.system) {
      // 几十个批次共用同一份系统提示词；Anthropic 的前缀缓存要显式打标记，
      // 否则每批都付全价 prefill。内容太短达不到门槛时服务端直接忽略，无副作用。
      body.system = [
        {
          type: "text",
          text: split.system,
          cache_control: { type: "ephemeral" },
        },
      ];
    }
    if (
      typeof temperature === "number" &&
      !traits.omitTemperature &&
      !relax.temperature
    ) {
      body.temperature = temperature;
    }

    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.aiApiKey,
        "anthropic-version": apiVersionFor(settings),
        // 没有这个头，浏览器里的请求会被 CORS 挡掉；它就是为用户自带密钥的场景设计的。
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
    };
  }

  if (settings.protocol === PROTOCOLS.RESPONSES) {
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.aiApiKey}`,
      },
      body: buildResponsesBody({ settings, messages, maxTokens, temperature, responseFormat, relax }),
    };
  }

  const openaiReasoning = isOpenAiReasoningModel(settings.aiModel);
  const body: ChatRequestBody = {
    model: settings.aiModel,
    messages: Array.isArray(messages) ? messages : [],
    ...vendorExtras(settings.aiBaseUrl),
  };
  if (openaiReasoning) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    if (typeof temperature === "number") body.temperature = temperature;
  }
  // 兼容服务商大多只认 json_object（DeepSeek 就不支持 json_schema），
  // 调用方传了 schema 也只发 json_object，靠提示词约束字段。
  if (responseFormat) body.response_format = JSON_OBJECT_FORMAT;

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body,
  };
}

/**
 * 模型列表请求。Anthropic 的列表要翻页：limit 每页条数（官方上限 1000），
 * afterId 填上一页的 last_id。OpenAI 的模型列表一次返回全部，不带这两个参数。
 */
export function buildModelsRequest(
  settings: AiSettings,
  { limit, afterId }: { limit?: number; afterId?: string } = {},
): ModelsRequest {
  let url = modelsUrl(settings);
  if (!url) throw new Error("API 地址不合法，请到设置页检查。");
  if (settings.protocol === PROTOCOLS.ANTHROPIC) {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (afterId) query.set("after_id", afterId);
    const search = query.toString();
    if (search) url = `${url}?${search}`;
  }

  const headers: Record<string, string> =
    settings.protocol === PROTOCOLS.ANTHROPIC
      ? {
          "x-api-key": settings.aiApiKey,
          "anthropic-version": apiVersionFor(settings),
          "anthropic-dangerous-direct-browser-access": "true",
        }
      : { Authorization: `Bearer ${settings.aiApiKey}` };

  return { url, headers };
}
