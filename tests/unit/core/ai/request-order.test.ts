// 请求体的键序：发出去的是 JSON.stringify(body)，键序就是构造时写入的顺序。
// deepEqual 和黄金样本（按键排序后比）都拦不住换顺序，这里比序列化后的文字。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOLS } from "../../../../src/core/ai/provider/endpoint.ts";
import { buildChatRequest } from "../../../../src/core/ai/provider/index.ts";
import type { ChatRequestInput } from "../../../../src/core/ai/provider/index.ts";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import { normalize } from "../../../../src/shared/settings-schema.ts";

const MESSAGES = [
  { role: "system", content: "你是助理" },
  { role: "user", content: "你好" },
];

const SYSTEM_BLOCK = [{ type: "text", text: "你是助理", cache_control: { type: "ephemeral" } }];

function bodyText(settings: Parameters<typeof normalize>[0], extra: Partial<ChatRequestInput> = {}): string {
  return JSON.stringify(
    buildChatRequest({
      settings: normalize(settings),
      messages: MESSAGES,
      maxTokens: 2048,
      temperature: 0.2,
      responseFormat: SCHEMAS.VERDICT,
      ...extra,
    }).body,
  );
}

test("兼容服务的请求体键序：模型、消息、厂商参数、预算、温度、输出格式", () => {
  assert.equal(
    bodyText({ presetId: "deepseek", aiApiKey: "k", aiModel: "deepseek-v4-flash" }),
    JSON.stringify({
      model: "deepseek-v4-flash",
      messages: MESSAGES,
      thinking: { type: "disabled" },
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  );
  assert.equal(
    bodyText({
      presetId: "custom",
      protocol: PROTOCOLS.OPENAI,
      aiApiKey: "k",
      aiBaseUrl: "https://api.example.com/v1",
      aiModel: "o3",
    }),
    JSON.stringify({
      model: "o3",
      messages: MESSAGES,
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
    }),
    "推理模型换成 max_completion_tokens，位置不变",
  );
});

test("Anthropic 的请求体键序：模型、预算、消息、思考、输出配置、系统提示词、温度", () => {
  const official = (aiModel: string) => ({
    presetId: "anthropic",
    protocol: PROTOCOLS.ANTHROPIC,
    aiApiKey: "k",
    aiBaseUrl: "https://api.anthropic.com",
    aiModel,
  });
  const format = { type: "json_schema", schema: SCHEMAS.VERDICT.schema };
  const messages = [{ role: "user", content: "你好" }];

  assert.equal(
    bodyText(official("claude-sonnet-4-6")),
    JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages,
      thinking: { type: "disabled" },
      output_config: { format },
      system: SYSTEM_BLOCK,
    }),
  );
  assert.equal(
    bodyText(official("claude-opus-5-5")),
    JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 2048,
      messages,
      output_config: { effort: "low", format },
      system: SYSTEM_BLOCK,
    }),
    "关不掉思考时不发 thinking，effort 排在 format 前",
  );
  assert.equal(
    bodyText(official("claude-sonnet-5-5")),
    JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      messages,
      thinking: { type: "between_tools" },
      output_config: { effort: "low", format },
      system: SYSTEM_BLOCK,
    }),
  );
  assert.equal(
    bodyText({
      presetId: "custom",
      protocol: PROTOCOLS.ANTHROPIC,
      aiApiKey: "k",
      aiBaseUrl: "https://gateway.example.com",
      aiModel: "claude-3-7-sonnet-20250219",
    }),
    JSON.stringify({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 2048,
      messages,
      thinking: { type: "disabled" },
      system: SYSTEM_BLOCK,
      temperature: 0.2,
    }),
    "兼容地址的旧型号照常带温度，排在最后",
  );
});

test("Responses 的请求体键序：模型、输入、预算、不存储、系统提示词、推理档位或温度、输出格式", () => {
  const openai = (aiModel: string) => ({ presetId: "openai", aiApiKey: "k", aiModel });
  assert.equal(
    bodyText(openai("gpt-6-astra")),
    JSON.stringify({
      model: "gpt-6-astra",
      input: [{ role: "user", content: "你好" }],
      max_output_tokens: 2048,
      store: false,
      instructions: "你是助理",
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "verdict", schema: SCHEMAS.VERDICT.schema, strict: true } },
    }),
  );
  assert.equal(
    bodyText(openai("gpt-4.1")),
    JSON.stringify({
      model: "gpt-4.1",
      input: [{ role: "user", content: "你好\n\n请只输出 JSON。" }],
      max_output_tokens: 2048,
      store: false,
      instructions: "你是助理",
      temperature: 0.2,
      text: { format: { type: "json_object" } },
    }),
    "认不出的型号退回 JSON 模式，温度排在输出格式前",
  );
});
