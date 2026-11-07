// 三种协议的请求构造、响应解析、截断判断、空响应诊断和报错翻译。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatCompletionsUrl,
  modelsUrl,
  presetById,
  PROTOCOLS,
} from "../../../../src/core/ai/provider/endpoint.ts";
import * as provider from "../../../../src/core/ai/provider/index.ts";
import type { AiSettings, ChatRequestInput } from "../../../../src/core/ai/provider/index.ts";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import { normalize } from "../../../../src/shared/settings-schema.ts";
import * as RESP from "../../../helpers/responses-fixtures.ts";

const openaiSettings = normalize({
  presetId: "custom",
  protocol: PROTOCOLS.OPENAI,
  aiApiKey: "sk-test",
  aiBaseUrl: "https://api.example.com/v1",
  aiModel: "some-model",
});

const anthropicSettings = normalize({
  presetId: "anthropic",
  protocol: PROTOCOLS.ANTHROPIC,
  aiApiKey: "sk-ant-test",
  aiBaseUrl: "https://api.anthropic.com",
  aiModel: "claude-test",
});

// 自定义的 Anthropic 兼容地址：继续用 2023-06-01，旧型号照常收 temperature。
const anthropicGatewaySettings = normalize({
  presetId: "custom",
  protocol: PROTOCOLS.ANTHROPIC,
  aiApiKey: "sk-gw-test",
  aiBaseUrl: "https://gateway.example.com",
  aiModel: "claude-test",
});

const MESSAGES = [
  { role: "system", content: "你是助理" },
  { role: "user", content: "你好" },
];

// ============================================================
// OpenAI 兼容协议
// ============================================================

test("OpenAI 协议：端点、鉴权头与消息结构", () => {
  const request = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer sk-test");
  assert.equal(request.body.model, "some-model");
  assert.equal(request.body.max_tokens, 100);
  // system 留在 messages 里，这是与 Anthropic 的关键差异
  assert.deepEqual(request.body.messages, MESSAGES);
});

test("OpenAI 协议：JSON 模式与温度按需附加", () => {
  const withFormat = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
    responseFormat: { type: "json_object" },
  });
  assert.deepEqual(withFormat.body.response_format, { type: "json_object" });
  assert.equal(withFormat.body.temperature, 0.2);

  const without = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal("response_format" in without.body, false);
  assert.equal("temperature" in without.body, false);
});

test("OpenAI 协议：从 choices 里取文本", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.OPENAI, {
      choices: [{ message: { content: "回复内容" } }],
    }),
    "回复内容",
  );
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, {}), "");
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, null), "");
});

// ============================================================
// DeepSeek 专属字段的隔离
// ============================================================

// 兼容服务商的请求体逐字段钉死：传 schema 也只发 json_object，不多出任何字段。
test("兼容服务商的请求体逐字段固定，传 schema 也只发 json_object", () => {
  const cases = [
    {
      settings: normalize({ presetId: "deepseek", aiApiKey: "sk-ds", aiModel: "deepseek-v4-flash" }),
      url: "https://api.deepseek.com/chat/completions",
      extras: { thinking: { type: "disabled" } },
    },
    // 这五家只是 OpenAI 兼容协议的一条配置，不带任何专属参数。
    ...["gemini", "moonshot", "zhipu", "dashscope", "siliconflow"].map((presetId) => ({
      settings: normalize({ presetId, aiApiKey: "sk-test", aiModel: "m" }),
      url: `${presetById(presetId)?.baseUrl}/chat/completions`,
      extras: {},
    })),
    {
      settings: openaiSettings,
      url: "https://api.example.com/v1/chat/completions",
      extras: {},
    },
  ];
  for (const { settings: config, url, extras } of cases) {
    for (const schema of Object.values(SCHEMAS)) {
      const request = provider.buildChatRequest({
        settings: config,
        messages: MESSAGES,
        maxTokens: 2048,
        temperature: 0.2,
        responseFormat: schema,
      });
      assert.equal(request.url, url);
      assert.deepEqual(
        request.body,
        {
          model: config.aiModel,
          messages: MESSAGES,
          ...extras,
          max_tokens: 2048,
          temperature: 0.2,
          response_format: { type: "json_object" },
        },
        `${config.presetId} / ${schema.name}`,
      );
      assert.deepEqual(Object.keys(request.headers).sort(), ["Authorization", "Content-Type"]);
    }
  }
});

test("thinking 字段只发给 DeepSeek", () => {
  const deepseek = normalize({
    presetId: "deepseek",
    aiApiKey: "k",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  });
  const request = provider.buildChatRequest({
    settings: deepseek,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(request.body.thinking, { type: "disabled" });
});

test("其它 OpenAI 兼容服务不会收到 DeepSeek 的私有字段", () => {
  const request = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal(
    "thinking" in request.body,
    false,
    "把 DeepSeek 私有字段发给别家服务，可能被判为非法参数而整个请求失败",
  );
});

test("地址非法时 vendorExtras 不抛错", () => {
  assert.deepEqual(provider.vendorExtras("不是地址"), {});
  assert.deepEqual(provider.vendorExtras(""), {});
});

test("thinking 只匹配 DeepSeek 域名本身与其子域，形近域名不注入", () => {
  const lookalike = provider.buildChatRequest({
    settings: normalize({
      presetId: "custom",
      protocol: PROTOCOLS.OPENAI,
      aiApiKey: "k",
      aiBaseUrl: "https://mydeepseek.com/v1",
      aiModel: "m",
    }),
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal("thinking" in lookalike.body, false, "形近域名的严格网关会拒绝未知参数");

  const apex = provider.buildChatRequest({
    settings: normalize({
      presetId: "custom",
      protocol: PROTOCOLS.OPENAI,
      aiApiKey: "k",
      aiBaseUrl: "https://deepseek.com",
      aiModel: "m",
    }),
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.deepEqual(apex.body.thinking, { type: "disabled" }, "裸域名 deepseek.com 也算 DeepSeek");
});

test("OpenAI 推理系列改用 max_completion_tokens 且不带自定义 temperature", () => {
  const reasoning = provider.buildChatRequest({
    settings: normalize({
      presetId: "custom",
      protocol: PROTOCOLS.OPENAI,
      aiApiKey: "k",
      aiBaseUrl: "https://api.openai.com/v1",
      aiModel: "o3",
    }),
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
  });
  assert.equal(reasoning.body.max_tokens, undefined);
  assert.equal(reasoning.body.max_completion_tokens, 100);
  assert.equal("temperature" in reasoning.body, false, "推理模型只认默认 temperature");

  const regular = provider.buildChatRequest({
    settings: { ...openaiSettings, aiModel: "gpt-4o" },
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
  });
  assert.equal(regular.body.max_tokens, 100);
  assert.equal(regular.body.temperature, 0.2, "常规模型保持标准参数");
});

test("GPT-6 系列和之后的新一代同样按推理模型发参数", () => {
  // 型号名取自官方模型页。
  for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-cyber", "gpt-7"]) {
    const { body } = provider.buildChatRequest({
      settings: { ...openaiSettings, aiModel: model },
      messages: MESSAGES,
      maxTokens: 100,
      temperature: 0.2,
    });
    assert.equal(body.max_tokens, undefined, model);
    assert.equal(body.max_completion_tokens, 100, model);
    assert.equal("temperature" in body, false, model);
  }

  for (const model of ["gpt-4o", "gpt-4.1-mini", "gpt-3.5-turbo", "gpt-oss-120b", "deepseek-v4-flash"]) {
    const { body } = provider.buildChatRequest({
      settings: { ...openaiSettings, aiModel: model },
      messages: MESSAGES,
      maxTokens: 100,
      temperature: 0.2,
    });
    assert.equal(body.max_tokens, 100, model);
    assert.equal(body.temperature, 0.2, model);
  }
});

// ============================================================
// Anthropic 协议
// ============================================================

test("Anthropic 协议：端点与三个必需头部", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "sk-ant-test");
  assert.equal(request.headers["anthropic-version"], provider.ANTHROPIC_VERSION);
  // 少了这个头，浏览器里的请求会被 CORS 挡掉
  assert.equal(
    request.headers["anthropic-dangerous-direct-browser-access"],
    "true",
  );
  assert.equal(request.headers.Authorization, undefined);
});

test("Anthropic 协议：system 被提到顶层，messages 里不留 system 角色", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.deepEqual(request.body.system, [
    {
      type: "text",
      text: "你是助理",
      // 翻译、概览的几十个批次共用同一份系统提示词，
      // 不打这个标记就要为同样的内容付几十次全价 prefill。
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.deepEqual(request.body.messages, [{ role: "user", content: "你好" }]);
  assert.equal(
    request.body.messages.some((message) => message.role === "system"),
    false,
    "Anthropic 会拒绝 role 为 system 的消息",
  );
});

test("Anthropic 协议：多条 system 合并，没有 system 时不加该字段", () => {
  const merged = provider.splitSystemMessages([
    { role: "system", content: "第一条" },
    { role: "system", content: "第二条" },
    { role: "user", content: "问题" },
  ]);
  assert.equal(merged.system, "第一条\n\n第二条");

  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: [{ role: "user", content: "只有用户消息" }],
    maxTokens: 100,
  });
  assert.equal("system" in request.body, false);
});

test("Anthropic 协议：max_tokens 必带，且不发 response_format", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 256,
    responseFormat: { type: "json_object" },
  });
  assert.equal(request.body.max_tokens, 256);
  assert.equal(
    "response_format" in request.body,
    false,
    "Anthropic 没有这个参数，发过去会报错",
  );
});

test("Anthropic 协议：显式关闭思考", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  // Anthropic 的 max_tokens 把思考也算在内，思考一旦放开，整份预算可能在
  // 写出第一个字之前就烧光，最终拿到一个 stop_reason 为 max_tokens 的空响应。
  assert.deepEqual(
    request.body.thinking,
    { type: "disabled" },
    "thinking 是 Anthropic 官方参数，不是私有扩展，可以放心发",
  );
});

function anthropicRequestFor(model: string, extra: Partial<ChatRequestInput> = {}, base: AiSettings = anthropicSettings) {
  return provider.buildChatRequest({
    settings: { ...base, aiModel: model },
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
    ...extra,
  });
}

test("认出 Claude 各种写法的系列和版本号", () => {
  assert.deepEqual(provider.parseClaudeModel("claude-opus-5-5"), { family: "opus", major: 5, minor: 5 });
  assert.deepEqual(provider.parseClaudeModel("claude-haiku-4-5-20251001"), { family: "haiku", major: 4, minor: 5 });
  assert.deepEqual(provider.parseClaudeModel("claude-opus-4-20250514"), { family: "opus", major: 4, minor: 0 }, "日期后缀不能被当成小版本号");
  assert.deepEqual(provider.parseClaudeModel("claude-3-7-sonnet-20250219"), { family: "sonnet", major: 3, minor: 7 });
  assert.deepEqual(provider.parseClaudeModel("anthropic.claude-opus-4-6-v1"), { family: "opus", major: 4, minor: 6 });
  assert.equal(provider.parseClaudeModel("claude-mythos-preview")?.family, "mythos");
  assert.equal(provider.parseClaudeModel("claude-test"), null);
  assert.equal(provider.parseClaudeModel(""), null);
});

test("Opus 5.5 不发 thinking，改用 low effort，也不发 temperature", () => {
  const { body } = anthropicRequestFor("claude-opus-5-5");
  assert.equal("thinking" in body, false, "Opus 5.5 拒绝 disabled，不传就是自适应思考");
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal("temperature" in body, false, "4.7 之后拒绝非默认 temperature");
});

test("Sonnet 5.5 用 between_tools 关掉回答前思考", () => {
  const { body } = anthropicRequestFor("claude-sonnet-5-5");
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.deepEqual(body.output_config, { effort: "low" }, "between_tools 只在 high 及以下的 effort 生效");
  assert.equal("temperature" in body, false);
});

test("还能关掉思考的新型号照旧关闭，但不发 temperature", () => {
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-4-7"]) {
    const { body } = anthropicRequestFor(model);
    assert.deepEqual(body.thinking, { type: "disabled" }, model);
    assert.equal("output_config" in body, false, model);
    assert.equal("temperature" in body, false, model);
  }
});

test("Fable、Mythos 关不掉思考", () => {
  for (const model of ["claude-fable-5-1", "claude-mythos-5", "claude-mythos-preview"]) {
    const { body } = anthropicRequestFor(model);
    assert.equal("thinking" in body, false, model);
    assert.deepEqual(body.output_config, { effort: "low" }, model);
  }
});

test("4.6 及更早的型号关闭思考并保留 temperature", () => {
  // 官方地址一律不发 temperature，这里用兼容地址看 thinking 和 temperature。
  for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
    const { body } = anthropicRequestFor(model, {}, anthropicGatewaySettings);
    assert.deepEqual(body.thinking, { type: "disabled" }, model);
    assert.equal(body.temperature, 0.2, model);
  }
});

test("放宽参数后，不再发送被拒绝的 thinking 和 temperature", () => {
  const { body } = anthropicRequestFor("claude-test", {
    relax: { thinking: true, temperature: true },
  });
  assert.equal("thinking" in body, false);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal("temperature" in body, false);
});

test("只有 Anthropic 的 400 参数报错才放宽，每种参数只放宽一次", () => {
  const thinkingError = {
    status: 400,
    message: '"thinking.type.disabled" is not supported for this model.',
  };
  const temperatureError = { status: 400, message: "`temperature` is deprecated for this model." };

  assert.deepEqual(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, thinkingError), { thinking: true });
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, thinkingError, { thinking: true }), null);
  assert.deepEqual(
    provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, temperatureError, { thinking: true }),
    { thinking: true, temperature: true },
  );
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.OPENAI, temperatureError), null, "OpenAI 兼容服务不归这里管");
  assert.equal(
    provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, { status: 401, message: "temperature" }),
    null,
    "密钥错误不该被当成参数问题",
  );
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, { status: 400, message: "max_tokens too large" }), null);
});

// 以下报错均为官方排错页原文：
const SONNET_55_DISABLED_REJECTED =
  'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks.';
const ALWAYS_ON_DISABLED_REJECTED =
  '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
const MYTHOS_PREVIEW_DISABLED_REJECTED =
  '"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified; use "thinking.type.enabled" with "budget_tokens" for extended thinking.';
const BETWEEN_TOOLS_REJECTED = '"thinking.type.between_tools" is not supported for this model.';

test("认出 Sonnet 5.5 拒绝 disabled 的报错原文，改用报错里点名的 between_tools", () => {
  const relax = provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, {
    status: 400,
    message: SONNET_55_DISABLED_REJECTED,
  });
  assert.deepEqual(relax, { thinking: "between_tools" });

  const { body } = anthropicRequestFor("claude-test", { relax });
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.deepEqual(body.output_config, { effort: "low" }, "between_tools 只在 high 及以下的 effort 生效");
});

test("替代值也被拒时退到不传 thinking，之后不再放宽 thinking", () => {
  const next = provider.relaxRejectedParams(
    PROTOCOLS.ANTHROPIC,
    { status: 400, message: BETWEEN_TOOLS_REJECTED },
    { thinking: "between_tools" },
  );
  assert.deepEqual(next, { thinking: true });
  assert.equal(
    provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, { status: 400, message: SONNET_55_DISABLED_REJECTED }, next),
    null,
    "已经不传 thinking 了，再被拒就交还给调用方",
  );
});

test("关不掉思考的型号的报错原文都放宽成不传 thinking", () => {
  for (const message of [ALWAYS_ON_DISABLED_REJECTED, MYTHOS_PREVIEW_DISABLED_REJECTED]) {
    assert.deepEqual(
      provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, { status: 400, message }),
      { thinking: true },
      message,
    );
  }
});

test("截断判断覆盖两种协议", () => {
  assert.equal(provider.isTruncated(PROTOCOLS.ANTHROPIC, { stop_reason: "max_tokens" }), true);
  assert.equal(provider.isTruncated(PROTOCOLS.ANTHROPIC, { stop_reason: "end_turn" }), false);
  assert.equal(provider.isTruncated(PROTOCOLS.OPENAI, { choices: [{ finish_reason: "length" }] }), true);
  assert.equal(provider.isTruncated(PROTOCOLS.OPENAI, {}), false);
});

test("截断后加大预算有没有用：Anthropic 有用，OpenAI 兼容服务要看到思考才算", () => {
  assert.equal(provider.canRaiseBudget(PROTOCOLS.ANTHROPIC, { stop_reason: "max_tokens" }), true);
  assert.equal(
    provider.canRaiseBudget(PROTOCOLS.OPENAI, { choices: [{ finish_reason: "length", message: { content: "半句" } }] }),
    false,
    "看不到思考，重发多半撞上同一个上限",
  );
  assert.equal(
    provider.canRaiseBudget(PROTOCOLS.OPENAI, {
      choices: [{ finish_reason: "length", message: { content: "半句", reasoning_content: "想" } }],
    }),
    true,
  );
  assert.equal(
    provider.canRaiseBudget(PROTOCOLS.OPENAI, {
      choices: [{ finish_reason: "length", message: { content: "半句", reasoning: "想" } }],
    }),
    true,
  );
  assert.equal(
    provider.canRaiseBudget(PROTOCOLS.OPENAI, {
      choices: [{ finish_reason: "length", message: { content: "半句" } }],
      usage: { completion_tokens_details: { reasoning_tokens: 300 } },
    }),
    true,
    "OpenAI 自家推理模型不回传思考内容，只在用量里报思考 token",
  );
  assert.equal(provider.canRaiseBudget(PROTOCOLS.OPENAI, null), false);
});

test("Anthropic 协议：思考关不掉时，仍能从混合内容里取出正文", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {
      content: [
        { type: "thinking", thinking: "我先想一下……" },
        { type: "text", text: "正文" },
      ],
    }),
    "正文",
    "取错块会把一次成功的请求判成空响应",
  );
});

test("Anthropic 协议：拼接 content 里的文本块，忽略非文本块", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {
      content: [
        { type: "text", text: "前半段" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "后半段" },
      ],
    }),
    "前半段后半段",
  );
  assert.equal(provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {}), "");
});

// ============================================================
// 错误解析
// ============================================================

test("两种协议的错误体都能提取出可读信息", () => {
  assert.equal(
    provider.parseErrorMessage({ error: { message: "余额不足" } }, 400),
    "余额不足",
  );
  assert.equal(
    provider.parseErrorMessage({ error: { type: "invalid_request_error" } }, 400),
    "invalid_request_error",
  );
  assert.equal(provider.parseErrorMessage({ message: "顶层消息" }, 400), "顶层消息");
});

test("错误体畸形时退回状态码描述", () => {
  assert.match(provider.parseErrorMessage(null, 500), /500/);
  assert.match(provider.parseErrorMessage("纯文本", 502), /502/);
  assert.match(provider.parseErrorMessage({}, 404), /404/);
});

// ============================================================
// 空响应诊断
// ============================================================

test("OpenAI 协议收到 Anthropic 形状的响应时，指出协议选反了", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    content: [{ type: "text", text: "内容" }],
  });
  assert.equal(result.reason, "PROTOCOL_MISMATCH");
  assert.match(result.message, /Anthropic/);
  assert.equal(result.retryWithoutJsonMode, false);
});

test("Anthropic 协议收到 OpenAI 形状的响应时，同样指出协议选反了", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
    choices: [{ message: { content: "内容" } }],
  });
  assert.equal(result.reason, "PROTOCOL_MISMATCH");
  assert.match(result.message, /OpenAI/);
});

test("没有 choices 也不像 Anthropic 时，提示地址可能不是兼容接口", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, { foo: "bar" });
  assert.equal(result.reason, "NO_CHOICES");
  assert.match(result.message, /地址|接口/);
});

test("被 token 上限截断时，要求加码重试而不是直接放弃", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "length", message: { content: "" } }],
  });
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(result.retryWithMoreTokens, true);
  assert.equal(
    result.retryWithoutJsonMode,
    false,
    "截断和 JSON 模式无关，脱掉它只会白跑一轮",
  );
});

test("Anthropic 撞上 max_tokens 时同样要求加码重试", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
    stop_reason: "max_tokens",
  });
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(result.retryWithMoreTokens, true);
});

test("协议选错这类改配置才能解决的问题，不做无谓重试", () => {
  for (const data of [
    { content: [{ type: "text", text: "x" }] },
    { foo: "bar" },
  ]) {
    const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, data);
    assert.ok(!result.retryWithMoreTokens, `${result.reason} 不该重试`);
    assert.ok(!result.retryWithoutJsonMode, `${result.reason} 不该重试`);
  }
});

test("推理模型把配额花在思考上时，建议换非推理模型", () => {
  const truncated = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [
      { finish_reason: "length", message: { content: "", reasoning_content: "想了很久" } },
    ],
  });
  assert.equal(truncated.reason, "TRUNCATED");
  assert.match(truncated.message, /推理/);

  const reasoningOnly = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "stop", message: { content: "", reasoning: "想了很久" } }],
  });
  assert.equal(reasoningOnly.reason, "REASONING_ONLY");
  assert.equal(reasoningOnly.retryWithoutJsonMode, false);
  assert.ok(
    !reasoningOnly.retryWithMoreTokens,
    "模型自己认为已经说完了，不是预算不够，加码也没用",
  );
});

test("Anthropic 只输出思考块时同样识别为推理占满", () => {
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
      content: [{ type: "thinking", thinking: "想了很久" }],
    }).reason,
    "REASONING_ONLY",
  );
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, { stop_reason: "max_tokens" })
      .reason,
    "TRUNCATED",
  );
});

test("思考关不掉的型号不建议换非推理模型，改提示另选型号、把概览分小", () => {
  const truncated = { content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "max_tokens" };
  const reasoningOnly = { content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "end_turn" };

  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-preview"]) {
    const cut = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, truncated, { model });
    assert.equal(cut.reason, "TRUNCATED", model);
    assert.doesNotMatch(cut.message, /非推理模型/, model);
    assert.match(cut.message, /按功能选模型/, model);
    assert.match(cut.message, /概览分块/, model);
    // 设置页里没有的选项不能让用户去调。
    assert.doesNotMatch(cut.message, /输出上限|effort/, model);
    assert.equal(cut.retryWithMoreTokens, true, model);

    const only = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, reasoningOnly, { model });
    assert.equal(only.reason, "REASONING_ONLY", model);
    assert.doesNotMatch(only.message, /非推理模型/, model);
    assert.match(only.message, /按功能选模型/, model);
    assert.doesNotMatch(only.message, /effort/, model);
  }

  // 经 OpenAI 兼容网关调用同一个型号时也一样。
  const viaGateway = provider.diagnoseEmptyResponse(
    PROTOCOLS.OPENAI,
    { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "想了很久" } }] },
    { model: "claude-opus-5-5" },
  );
  assert.doesNotMatch(viaGateway.message, /非推理模型/);
  assert.match(viaGateway.message, /按功能选模型/);
});

test("型号名认不出、但服务拒绝过关掉思考的，同样按思考关不掉提示", () => {
  const result = provider.diagnoseEmptyResponse(
    PROTOCOLS.ANTHROPIC,
    { content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "max_tokens" },
    { model: "gateway-sonnet-latest", relax: { thinking: "between_tools" } },
  );
  assert.doesNotMatch(result.message, /非推理模型/);
  assert.match(result.message, /按功能选模型/);
});

test("还能关掉思考的型号仍建议换非推理模型", () => {
  for (const model of ["claude-sonnet-4-6", "claude-opus-5", "some-model", undefined]) {
    const result = provider.diagnoseEmptyResponse(
      PROTOCOLS.ANTHROPIC,
      { content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "max_tokens" },
      { model },
    );
    assert.match(result.message, /非推理模型/, String(model));
  }
});

test("排除其它可能后，才建议脱掉 JSON 模式重试", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "stop", message: { content: "" } }],
  });
  assert.equal(result.reason, "EMPTY_CONTENT");
  assert.equal(
    result.retryWithoutJsonMode,
    true,
    "JSON 模式偶发返回空串，去掉它重试就好",
  );
});

test("诊断对畸形输入不抛错", () => {
  for (const data of [null, undefined, "字符串", 42, []]) {
    for (const protocol of [PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC]) {
      const result = provider.diagnoseEmptyResponse(protocol, data);
      assert.ok(result.reason, `protocol=${protocol} data=${JSON.stringify(data)}`);
      assert.ok(result.message);
    }
  }
});

// ============================================================
// 模型列表
// ============================================================

test("模型列表请求带上各自协议的鉴权头", () => {
  const openai = provider.buildModelsRequest(openaiSettings);
  assert.equal(openai.url, "https://api.example.com/v1/models");
  assert.equal(openai.headers.Authorization, "Bearer sk-test");

  const anthropic = provider.buildModelsRequest(anthropicSettings);
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropic.headers["x-api-key"], "sk-ant-test");
  assert.equal(
    anthropic.headers["anthropic-dangerous-direct-browser-access"],
    "true",
  );
});

test("模型列表解析兼容 data/models 两种字段与字符串数组", () => {
  assert.deepEqual(
    provider.parseModelsResponse({ data: [{ id: "b-model" }, { id: "a-model" }] }),
    ["a-model", "b-model"],
  );
  assert.deepEqual(
    provider.parseModelsResponse({ models: [{ name: "m1" }] }),
    ["m1"],
  );
  assert.deepEqual(provider.parseModelsResponse({ data: ["x", "y"] }), ["x", "y"]);
});

test("模型列表为空或畸形时返回空数组", () => {
  assert.deepEqual(provider.parseModelsResponse({}), []);
  assert.deepEqual(provider.parseModelsResponse(null), []);
  assert.deepEqual(provider.parseModelsResponse({ data: [{}, { id: "" }] }), []);
});

// ============================================================
// 地址非法时的行为
// ============================================================

test("地址非法时构造请求直接抛错，不会发出一个坏请求", () => {
  const broken = { ...openaiSettings, aiBaseUrl: "ftp://evil.example.com" };
  assert.throws(() => provider.buildChatRequest({ settings: broken, messages: [], maxTokens: 1 }), /地址/);
  assert.throws(() => provider.buildModelsRequest(broken), /地址/);
});

// ============================================================
// Anthropic：API 版本 2026-10-21 与结构化输出
// ============================================================

test("只有官方地址发 2026-10-21，自定义的 Anthropic 兼容地址继续用 2023-06-01", () => {
  assert.equal(provider.ANTHROPIC_VERSION, "2026-10-21");
  assert.equal(provider.ANTHROPIC_LEGACY_VERSION, "2023-06-01");

  const official = provider.buildChatRequest({ settings: anthropicSettings, messages: MESSAGES, maxTokens: 100 });
  assert.equal(official.headers["anthropic-version"], "2026-10-21");
  assert.equal(provider.buildModelsRequest(anthropicSettings).headers["anthropic-version"], "2026-10-21");

  const gateway = provider.buildChatRequest({ settings: anthropicGatewaySettings, messages: MESSAGES, maxTokens: 100 });
  assert.equal(gateway.headers["anthropic-version"], "2023-06-01");
  assert.equal(provider.buildModelsRequest(anthropicGatewaySettings).headers["anthropic-version"], "2023-06-01");

  assert.equal(provider.isOfficialAnthropic("https://api.anthropic.com"), true);
  assert.equal(provider.isOfficialAnthropic("http://api.anthropic.com"), false, "明文地址不算官方");
  assert.equal(provider.isOfficialAnthropic("https://api.anthropic.com.evil.example"), false);
  assert.equal(provider.isOfficialAnthropic("https://proxy.example.com/api.anthropic.com"), false);
  assert.equal(provider.isOfficialAnthropic("不是地址"), false);
  assert.equal(provider.apiVersionFor(openaiSettings), "", "OpenAI 协议没有这个头");
});

test("官方地址对所有型号都不发 temperature、top_p、top_k", () => {
  for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-7-sonnet-20250219", "claude-test"]) {
    const { body } = anthropicRequestFor(model);
    for (const field of ["temperature", "top_p", "top_k"]) {
      assert.equal(field in body, false, `${model} 不该带 ${field}`);
    }
  }
});

test("官方地址的 Claude 4.5 及之后按 schema 发 output_config.format", () => {
  for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-haiku-5-5"]) {
    const { body } = anthropicRequestFor(model, { responseFormat: SCHEMAS.ANALYSIS_CHUNK });
    assert.deepEqual(
      body.output_config,
      { format: { type: "json_schema", schema: SCHEMAS.ANALYSIS_CHUNK.schema } },
      model,
    );
    assert.deepEqual(body.thinking, { type: "disabled" }, `${model} 关掉思考`);
    assert.equal("response_format" in body, false);
  }
});

test("结构化输出和 effort 合成一个 output_config", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-preview"]) {
    const { body } = anthropicRequestFor(model, { responseFormat: SCHEMAS.VERDICT });
    assert.deepEqual(
      body.output_config,
      { effort: "low", format: { type: "json_schema", schema: SCHEMAS.VERDICT.schema } },
      model,
    );
  }
});

test("不支持或拿不准的组合不发结构化输出，退回提示词约束", () => {
  const format = { responseFormat: SCHEMAS.QA_ANSWER };
  // 支持列表从 4.5 开始；更早的型号、认不出的型号名都不发。
  for (const model of ["claude-sonnet-4-20250514", "claude-opus-4-1-20250805", "claude-3-7-sonnet-20250219", "claude-test"]) {
    assert.equal("output_config" in anthropicRequestFor(model, format).body, false, model);
  }
  // 兼容地址不一定支持，按型号名也不开。
  assert.equal(
    "output_config" in anthropicRequestFor("claude-sonnet-4-6", format, anthropicGatewaySettings).body,
    false,
  );
  // json_object 在 Anthropic 上本来就没有对应参数。
  assert.equal(
    "output_config" in anthropicRequestFor("claude-sonnet-4-6", { responseFormat: { type: "json_object" } }).body,
    false,
  );
  // 服务拒绝过 schema 后不再发。
  assert.equal(
    "output_config" in anthropicRequestFor("claude-sonnet-4-6", { ...format, relax: { format: true } }).body,
    false,
  );
  const opus = anthropicRequestFor("claude-opus-5-5", { ...format, relax: { format: true } }).body;
  assert.deepEqual(opus.output_config, { effort: "low" }, "放宽 format 不影响 effort");
});

test("被拒的请求带了 schema、报错又提到 schema 时，放宽成不发结构化输出", () => {
  const body = { output_config: { format: { type: "json_schema", schema: {} } } };
  const tooComplex = { status: 400, message: "Schema is too complex for compilation." };
  assert.deepEqual(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, tooComplex, {}, body), { format: true });
  assert.deepEqual(
    provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, { status: 400, message: "output_config.format.schema: unsupported keyword" }, { thinking: true }, body),
    { thinking: true, format: true },
  );
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, tooComplex, {}, { messages: [] }), null, "请求里没有 schema 就不是它的错");
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.ANTHROPIC, tooComplex, { format: true }, body), null, "放宽过还被拒就交还");
});

test("Anthropic 拒绝回答时认出 stop_reason 为 refusal", () => {
  assert.equal(
    provider.refusalOf(PROTOCOLS.ANTHROPIC, { content: [{ type: "text", text: "I can't help with that." }], stop_reason: "refusal" }),
    "",
  );
  assert.equal(provider.refusalOf(PROTOCOLS.ANTHROPIC, { content: [], stop_reason: "end_turn" }), null);
  assert.equal(provider.refusalOf(PROTOCOLS.ANTHROPIC, null), null);
  assert.equal(provider.refusalOf(PROTOCOLS.OPENAI, { choices: [] }), null);
});

// ============================================================
// OpenAI Responses
// ============================================================

const responsesSettings = normalize({
  presetId: "openai",
  aiApiKey: "sk-openai",
  aiModel: "gpt-6-astra",
});

function responsesRequestFor(model: string, extra: Partial<ChatRequestInput> = {}) {
  return provider.buildChatRequest({
    settings: { ...responsesSettings, aiModel: model },
    messages: MESSAGES,
    maxTokens: 2048,
    temperature: 0.2,
    ...extra,
  });
}

test("OpenAI 官方预设默认走 Responses，兼容服务商仍走 Chat Completions", () => {
  assert.equal(responsesSettings.protocol, PROTOCOLS.RESPONSES);
  assert.equal(chatCompletionsUrl(responsesSettings), "https://api.openai.com/v1/responses");
  assert.equal(modelsUrl(responsesSettings), "https://api.openai.com/v1/models");
  for (const id of ["deepseek", "openrouter"]) {
    assert.equal(presetById(id)?.protocol, PROTOCOLS.OPENAI, id);
  }
});

test("Responses 请求体：instructions、input、max_output_tokens、最低推理档位、strict schema、store:false", () => {
  const request = responsesRequestFor("gpt-6-astra", { responseFormat: SCHEMAS.ANALYSIS_CHUNK });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer sk-openai",
  });
  assert.deepEqual(request.body, {
    model: "gpt-6-astra",
    instructions: "你是助理",
    input: [{ role: "user", content: "你好" }],
    max_output_tokens: 2048,
    store: false,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "analysis_chunk",
        schema: SCHEMAS.ANALYSIS_CHUNK.schema,
        strict: true,
      },
    },
  });
});

test("推理档位按兼容表取各型号最低的一档，gpt-6-astra 和 gpt-6.1-sol 不支持 none", () => {
  const expected = {
    "gpt-6-astra": "low",
    "gpt-6.1-sol": "low",
    "gpt-6.1-terra": "none",
    "gpt-6-luna": "none",
    "gpt-5.6": "none",
    "gpt-5.6-sol": "none",
    "gpt-5.5": "none",
    "gpt-5.5-2026-04-23": "none",
  };
  for (const [model, effort] of Object.entries(expected)) {
    assert.deepEqual(responsesRequestFor(model).body.reasoning, { effort }, model);
    assert.equal("temperature" in responsesRequestFor(model).body, false, `${model} 是推理模型，不发 temperature`);
  }
});

test("认不出的型号走保守设置：不发推理档位，结构化输出退回 JSON 模式", () => {
  for (const model of ["gpt-5.5-pro", "gpt-6-astra-mini", "gpt-5.4", "o3", "gpt-4.1", "my-finetune"]) {
    const { body } = responsesRequestFor(model, { responseFormat: SCHEMAS.VERDICT });
    assert.equal("reasoning" in body, false, model);
    assert.deepEqual(body.text, { format: { type: "json_object" } }, model);
    assert.equal(body.store, false, model);
  }
  assert.equal(responsesRequestFor("gpt-4.1").body.temperature, 0.2, "非推理模型照常发 temperature");
  assert.equal("temperature" in responsesRequestFor("o3").body, false);
});

test("Responses：没传 responseFormat 不发 text，没有 system 不发 instructions", () => {
  const { body } = provider.buildChatRequest({
    settings: responsesSettings,
    messages: [{ role: "user", content: "回复两个字：可用" }],
    maxTokens: 1024,
  });
  assert.equal("text" in body, false);
  assert.equal("instructions" in body, false);
  assert.deepEqual(body.input, [{ role: "user", content: "回复两个字：可用" }]);
});

test("Responses 的 400 按参数放宽；Chat Completions 一律不放宽", () => {
  const effortBody = { reasoning: { effort: "none" } };
  const effortError = {
    status: 400,
    message: "Unsupported value: 'none' is not supported with this model.",
    param: "reasoning.effort",
  };
  assert.deepEqual(provider.relaxRejectedParams(PROTOCOLS.RESPONSES, effortError, {}, effortBody), { effort: true });
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.RESPONSES, effortError, { effort: true }, effortBody), null);

  const schemaBody = { text: { format: { type: "json_schema", name: "x", schema: {}, strict: true } } };
  const schemaError = { status: 400, message: "Invalid schema for response_format 'x'.", param: "text.format.schema" };
  assert.deepEqual(provider.relaxRejectedParams(PROTOCOLS.RESPONSES, schemaError, {}, schemaBody), { format: true });

  const temperatureError = { status: 400, message: "Unsupported parameter: 'temperature' is not supported with this model." };
  assert.deepEqual(provider.relaxRejectedParams(PROTOCOLS.RESPONSES, temperatureError, {}, { temperature: 0.2 }), { temperature: true });

  for (const error of [effortError, schemaError, temperatureError]) {
    assert.equal(provider.relaxRejectedParams(PROTOCOLS.OPENAI, error, {}, { ...effortBody, ...schemaBody }), null);
  }
  assert.equal(provider.relaxRejectedParams(PROTOCOLS.RESPONSES, { ...effortError, status: 429 }, {}, effortBody), null);
});

test("Responses：遍历 output 里 message 项的 output_text，跳过推理项和中途说明", () => {
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, RESP.completed("{\"answer\":\"可用\"}")), "{\"answer\":\"可用\"}");
  const withCommentary = RESP.baseResponse({
    output: [
      RESP.reasoningItem(),
      RESP.messageItem([RESP.outputText("我先看看字幕。")], { phase: "commentary" }),
      RESP.messageItem([RESP.outputText("{\"quote\":"), RESP.outputText("\"正文\"}")], { phase: "final_answer" }),
    ],
  });
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, withCommentary), "{\"quote\":\"正文\"}");
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, RESP.incomplete()), "");
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, null), "");
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, { output: [{ type: "message", content: "坏的" }] }), "");
});

test("Responses：拒绝回答时取出 refusal 说明", () => {
  assert.equal(
    provider.refusalOf(PROTOCOLS.RESPONSES, RESP.refusal()),
    "I'm sorry, I cannot assist with that request.",
  );
  assert.equal(provider.refusalOf(PROTOCOLS.RESPONSES, RESP.completed("{}")), null);
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, RESP.refusal()), "");
});

test("Responses：status 为 incomplete 算没写完；只有推理占了预算才值得加码", () => {
  const truncated = RESP.incomplete("{\"chapters\": [");
  assert.equal(provider.isTruncated(PROTOCOLS.RESPONSES, truncated), true);
  assert.equal(provider.canRaiseBudget(PROTOCOLS.RESPONSES, truncated), true);
  assert.equal(
    provider.canRaiseBudget(PROTOCOLS.RESPONSES, RESP.incomplete("{\"chapters\": [", { reasoningTokens: 0 })),
    true,
    "用量里没有推理 token，但 output 里有推理项",
  );
  const noReasoning = { ...RESP.incomplete("{\"chapters\": ["), output: [RESP.messageItem([RESP.outputText("{")], { status: "incomplete" })] };
  noReasoning.usage = { ...noReasoning.usage, output_tokens_details: { reasoning_tokens: 0 } };
  assert.equal(provider.canRaiseBudget(PROTOCOLS.RESPONSES, noReasoning), false);
  const filtered = RESP.incomplete("{\"chapters\": [", { reason: "content_filter" });
  assert.equal(provider.isTruncated(PROTOCOLS.RESPONSES, filtered), true);
  assert.equal(provider.canRaiseBudget(PROTOCOLS.RESPONSES, filtered), false, "内容过滤加大预算也没用");
  assert.equal(provider.isTruncated(PROTOCOLS.RESPONSES, RESP.completed("{}")), false);
});

test("Responses 的空响应按成因诊断", () => {
  const truncated = provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, RESP.incomplete());
  assert.equal(truncated.reason, "TRUNCATED");
  assert.equal(truncated.retryWithMoreTokens, true);
  assert.match(truncated.message, /推理/);

  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, { choices: [{ message: { content: "" } }] }).reason,
    "PROTOCOL_MISMATCH",
  );
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, { content: [], stop_reason: "end_turn" }).reason,
    "PROTOCOL_MISMATCH",
  );
  assert.equal(provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, {}).reason, "NO_OUTPUT");
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, RESP.incomplete("", { reason: "content_filter" })).reason,
    "CONTENT_FILTERED",
  );
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, RESP.baseResponse({ status: "failed", error: { code: "server_error", message: "boom" } })).message,
    "boom",
  );
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, RESP.baseResponse({ output: [RESP.reasoningItem()] })).reason,
    "REASONING_ONLY",
  );
  const empty = provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, RESP.completed(""));
  assert.equal(empty.reason, "EMPTY_CONTENT");
  assert.equal(empty.retryWithoutJsonMode, true);
  assert.doesNotThrow(() => provider.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, null));
});

// ============================================================
// 按模型能力发参数（能力数据来自 capabilities.ts）
// ============================================================

function caps({ disabled = true, betweenTools = true, efforts = ["low", "medium", "high"], structured = true, maxTokens = 64000 } = {}) {
  return { maxTokens, thinking: { disabled, betweenTools, adaptive: true }, efforts, structuredOutputs: structured };
}

test("有能力数据时按能力决定 thinking 和 effort，不看型号名", () => {
  // 型号名认不出，但能力表说关不掉思考：直接发自适应思考和最低档，不用先挨一次 400。
  const locked = anthropicRequestFor("gateway-claude-latest", { capabilities: caps({ disabled: false, betweenTools: false, efforts: ["medium", "high"] }) });
  assert.equal("thinking" in locked.body, false);
  assert.deepEqual(locked.body.output_config, { effort: "medium" }, "取能力表里最低的一档");

  const betweenTools = anthropicRequestFor("gateway-claude-latest", { capabilities: caps({ disabled: false }) });
  assert.deepEqual(betweenTools.body.thinking, { type: "between_tools" });
  assert.deepEqual(betweenTools.body.output_config, { effort: "low" });

  // 型号名说关不掉，但能力表说能关：以能力表为准。
  const canDisable = anthropicRequestFor("claude-opus-5-5", { capabilities: caps() });
  assert.deepEqual(canDisable.body.thinking, { type: "disabled" });
  assert.equal("output_config" in canDisable.body, false);

  const noEffort = anthropicRequestFor("claude-x", { capabilities: caps({ disabled: false, betweenTools: false, efforts: [] }) });
  assert.equal("output_config" in noEffort.body, false, "不支持 effort 就不发");
});

test("有能力数据时按能力决定结构化输出，兼容地址也一样", () => {
  const format = { responseFormat: SCHEMAS.NOTE_QUOTE };
  const off = anthropicRequestFor("claude-sonnet-4-6", { ...format, capabilities: caps({ structured: false }) });
  assert.equal("output_config" in off.body, false, "能力表说不支持，官方地址也不发");
  const gateway = anthropicRequestFor("gateway-claude", { ...format, capabilities: caps() }, anthropicGatewaySettings);
  assert.deepEqual(gateway.body.output_config, { format: { type: "json_schema", schema: SCHEMAS.NOTE_QUOTE.schema } });
  assert.equal(gateway.headers["anthropic-version"], "2023-06-01");
});

test("能力数据给出 max_tokens 上限；没有能力数据时为 0", () => {
  assert.equal(provider.claudeRequestTraits("claude-x", { capabilities: caps({ maxTokens: 8192 }) }).maxTokens, 8192);
  assert.equal(provider.claudeRequestTraits("claude-x", { capabilities: caps({ maxTokens: 0 }) }).maxTokens, 0);
  assert.equal(provider.claudeRequestTraits("claude-opus-5-5").maxTokens, 0);
});

test("能力数据说关不掉思考时，空响应的提示也按关不掉来写", () => {
  const diagnosis = provider.diagnoseEmptyResponse(
    PROTOCOLS.ANTHROPIC,
    { content: [], stop_reason: "max_tokens" },
    { model: "gateway-claude", capabilities: caps({ disabled: false, betweenTools: false }) },
  );
  assert.match(diagnosis.message, /关不掉/);
});

test("Anthropic 的模型列表请求可带翻页参数，OpenAI 的不带", () => {
  assert.equal(
    provider.buildModelsRequest(anthropicSettings, { limit: 1000, afterId: "claude-opus-5-5" }).url,
    "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5",
  );
  assert.equal(provider.buildModelsRequest(anthropicSettings).url, "https://api.anthropic.com/v1/models");
  assert.equal(
    provider.buildModelsRequest(openaiSettings, { limit: 1000, afterId: "x" }).url,
    "https://api.example.com/v1/models",
  );
});

// ============================================================
// 报错脱敏
// ============================================================

const KEY = "FAKE-KEY-FOR-OFFLINE-TESTS-0001";

test("redactSecret 替换每一处密钥，太短的密钥不动", () => {
  assert.equal(
    provider.redactSecret(`bad key ${KEY}, again ${KEY}`, KEY),
    "bad key [已隐藏的密钥], again [已隐藏的密钥]",
  );
  assert.equal(provider.redactSecret("abc abc", "abc"), "abc abc");
  assert.equal(provider.redactSecret("no secret here", ""), "no secret here");
});
