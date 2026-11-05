// 密钥实际发往的地址：预设表、地址校验和整理、三种协议的端点拼接。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatCompletionsUrl,
  modelsUrl,
  presetById,
  PROTOCOLS,
  resolveEndpoint,
  validateBaseUrl,
  type EndpointSource,
  type Protocol,
} from "../../../../src/core/ai/provider/endpoint.ts";

const { OPENAI, RESPONSES, ANTHROPIC } = PROTOCOLS;

const errorOf = (input: unknown, protocol?: Protocol): string => {
  const check = validateBaseUrl(input, protocol);
  assert.equal(check.ok, false, String(input));
  return check.ok ? "" : check.error;
};

const urlOf = (input: unknown, protocol?: Protocol): string => {
  const check = validateBaseUrl(input, protocol);
  assert.equal(check.ok, true, String(input));
  return check.ok ? check.url : "";
};

const custom = (aiBaseUrl: string, protocol: Protocol = OPENAI): EndpointSource => ({
  presetId: "custom",
  protocol,
  aiBaseUrl,
});

test("预设表逐项固定协议和地址", () => {
  const expected: readonly (readonly [string, Protocol, string])[] = [
    ["anthropic", ANTHROPIC, "https://api.anthropic.com"],
    ["openai", RESPONSES, "https://api.openai.com/v1"],
    ["deepseek", OPENAI, "https://api.deepseek.com"],
    ["gemini", OPENAI, "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["moonshot", OPENAI, "https://api.moonshot.cn/v1"],
    ["zhipu", OPENAI, "https://open.bigmodel.cn/api/paas/v4"],
    ["dashscope", OPENAI, "https://dashscope.aliyuncs.com/compatible-mode/v1"],
    ["siliconflow", OPENAI, "https://api.siliconflow.cn/v1"],
    ["openrouter", OPENAI, "https://openrouter.ai/api/v1"],
    ["custom", OPENAI, ""],
  ];
  for (const [id, protocol, baseUrl] of expected) {
    assert.deepEqual(presetById(id), { id, protocol, baseUrl });
  }
  assert.equal(presetById("no-such-preset"), null);
});

test("地址只认 https，本机地址也一样", () => {
  for (const url of ["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://api.example.com/v1"]) {
    assert.match(errorOf(url), /要以 https:\/\/ 开头/, url);
  }
});

test("空地址和解析不了的地址各有提示", () => {
  assert.equal(errorOf(""), "请填写 API 地址。");
  assert.equal(errorOf("   "), "请填写 API 地址。");
  assert.equal(errorOf(null), "请填写 API 地址。");
  assert.equal(errorOf("不是地址"), "API 地址不是合法的 URL。");
});

test("IPv6 字面量地址申请不到访问权限，直接拦下", () => {
  assert.match(errorOf("https://[2001:db8::1]:8443/v1"), /IPv6/);
});

test("通过校验时给出整理后的地址和权限来源", () => {
  assert.deepEqual(validateBaseUrl("  https://gw.example.com:8443/v1/  "), {
    ok: true,
    url: "https://gw.example.com:8443/v1",
    origin: "https://gw.example.com:8443/",
  });
});

test("完整端点还原成 base，一次只去掉一层", () => {
  assert.equal(urlOf("https://gw.example.com/v1/chat/completions"), "https://gw.example.com/v1");
  assert.equal(urlOf("https://gw.example.com/v1/messages"), "https://gw.example.com");
  assert.equal(urlOf("https://gw.example.com/api/messages"), "https://gw.example.com/api");
  assert.equal(urlOf("https://gw.example.com/api/messages/chat/completions"), "https://gw.example.com/api/messages");
  assert.equal(
    urlOf("https://gw.example.com/v1/chat/completions/chat/completions"),
    "https://gw.example.com/v1/chat/completions",
  );
});

test("/responses 只在 Responses 协议下去掉", () => {
  assert.equal(urlOf("https://gw.example.com/v1/responses", RESPONSES), "https://gw.example.com/v1");
  assert.equal(urlOf("https://gw.example.com/v1/responses", OPENAI), "https://gw.example.com/v1/responses");
  assert.equal(urlOf("https://gw.example.com/v1/responses", ANTHROPIC), "https://gw.example.com/v1/responses");
});

test("Anthropic 的 base 不留 /v1，别的协议留着", () => {
  assert.equal(urlOf("https://gw.example.com/v1", ANTHROPIC), "https://gw.example.com");
  assert.equal(urlOf("https://gw.example.com/v1", OPENAI), "https://gw.example.com/v1");
  assert.equal(urlOf("https://gw.example.com/v1", RESPONSES), "https://gw.example.com/v1");
});

test("选了具体厂商时协议和地址由预设说了算，存储里的值不算数", () => {
  assert.deepEqual(
    resolveEndpoint({ presetId: "deepseek", protocol: ANTHROPIC, aiBaseUrl: "https://stale.example.com" }),
    { protocol: OPENAI, aiBaseUrl: "https://api.deepseek.com" },
  );
});

test("认不出的预设落到默认服务商，不用存储里的地址", () => {
  const expected = { protocol: ANTHROPIC, aiBaseUrl: "https://api.anthropic.com" };
  assert.deepEqual(resolveEndpoint({ presetId: "no-such-preset", aiBaseUrl: "https://stale.example.com" }), expected);
  assert.deepEqual(resolveEndpoint({}), expected);
});

test("自定义：用存储的协议和地址，协议认不出时按 OpenAI 兼容", () => {
  assert.deepEqual(resolveEndpoint(custom("https://gw.example.com/v1/", RESPONSES)), {
    protocol: RESPONSES,
    aiBaseUrl: "https://gw.example.com/v1",
  });
  assert.deepEqual(
    resolveEndpoint({ presetId: "custom", protocol: "no-such-protocol", aiBaseUrl: "https://gw.example.com/v1" }),
    { protocol: OPENAI, aiBaseUrl: "https://gw.example.com/v1" },
  );
});

test("地址整理不通过就原样保留，端点都是 null", () => {
  const source = custom("http://localhost:8080/v1");
  assert.equal(resolveEndpoint(source).aiBaseUrl, "http://localhost:8080/v1");
  assert.equal(chatCompletionsUrl(source), null);
  assert.equal(modelsUrl(source), null);
  assert.equal(chatCompletionsUrl(custom("")), null);
  assert.equal(modelsUrl(custom("")), null);
});

test("三种协议的对话和模型列表端点", () => {
  const cases: readonly (readonly [Protocol, string, string])[] = [
    [OPENAI, "https://gw.example.com/v1/chat/completions", "https://gw.example.com/v1/models"],
    [RESPONSES, "https://gw.example.com/v1/responses", "https://gw.example.com/v1/models"],
    [ANTHROPIC, "https://gw.example.com/v1/messages", "https://gw.example.com/v1/models"],
  ];
  for (const [protocol, chat, models] of cases) {
    const source = custom("https://gw.example.com/v1", protocol);
    assert.equal(chatCompletionsUrl(source), chat, protocol);
    assert.equal(modelsUrl(source), models, protocol);
  }
});

test("拼端点时地址再整理一遍，叠了两层的完整端点也能还原", () => {
  const source = custom("https://gw.example.com/v1/chat/completions/chat/completions");
  assert.equal(chatCompletionsUrl(source), "https://gw.example.com/v1/chat/completions");
  assert.equal(modelsUrl(source), "https://gw.example.com/v1/models");
});
