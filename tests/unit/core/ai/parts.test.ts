// 消息部件：三种协议各自的图片和文字写法、图片排在文字前、缓存标记、只收 JPEG，以及纯文本原样透传。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOLS } from "../../../../src/core/ai/provider/endpoint.ts";
import * as provider from "../../../../src/core/ai/provider/index.ts";
import type { ChatRequestInput, MessagePart } from "../../../../src/core/ai/provider/index.ts";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import { normalize } from "../../../../src/shared/settings-schema.ts";

// 造的图：几个字节的 base64，不是真实截图。
const IMAGE_DATA = "AAECAwQFBgcICQ==";
const IMAGE_URL = `data:image/jpeg;base64,${IMAGE_DATA}`;

const SETTINGS = {
  [PROTOCOLS.OPENAI]: normalize({ presetId: "custom", protocol: PROTOCOLS.OPENAI, aiApiKey: "k", aiBaseUrl: "https://api.example.com/v1", aiModel: "some-model" }),
  [PROTOCOLS.RESPONSES]: normalize({ presetId: "openai", aiApiKey: "k", aiModel: "gpt-6-astra" }),
  [PROTOCOLS.ANTHROPIC]: normalize({ presetId: "anthropic", aiApiKey: "k", aiModel: "claude-sonnet-4-6" }),
};

const PARTS: readonly MessagePart[] = [
  { type: "text", text: "画面里写了什么？" },
  { type: "text", text: "前后字幕", cache: true },
  { type: "image", dataUrl: IMAGE_URL },
];

function build(protocol: keyof typeof SETTINGS, content: unknown, extra: Partial<ChatRequestInput> = {}) {
  return provider.buildChatRequest({
    settings: SETTINGS[protocol],
    messages: [
      { role: "system", content: "你是助理" },
      { role: "user", content },
    ],
    maxTokens: 512,
    ...extra,
  }).body;
}

test("Anthropic：图片写成 base64 来源，排在文字前面；带缓存的文字部件加缓存标记", () => {
  const body = build(PROTOCOLS.ANTHROPIC, PARTS);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMAGE_DATA } },
        { type: "text", text: "画面里写了什么？" },
        { type: "text", text: "前后字幕", cache_control: { type: "ephemeral" } },
      ],
    },
  ]);
  assert.equal(body.system?.[0]?.text, "你是助理", "系统提示照旧放顶层");
});

test("OpenAI 兼容：图片写成 image_url，缓存标记不发", () => {
  const body = build(PROTOCOLS.OPENAI, PARTS);
  assert.deepEqual(body.messages?.[1], {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: IMAGE_URL } },
      { type: "text", text: "画面里写了什么？" },
      { type: "text", text: "前后字幕" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(body), /cache/, "兼容服务不认的字段一个都不发");
});

test("Responses：图片写成 input_image，文字写成 input_text，缓存标记不发", () => {
  const body = build(PROTOCOLS.RESPONSES, PARTS);
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: IMAGE_URL },
        { type: "input_text", text: "画面里写了什么？" },
        { type: "input_text", text: "前后字幕" },
      ],
    },
  ]);
  assert.equal(body.instructions, "你是助理");
});

test("纯文本仍写字符串，三种协议的请求体和以前一样", () => {
  const messages = [{ role: "user", content: "你好" }];
  assert.equal(provider.withProtocolContent(PROTOCOLS.OPENAI, messages), messages, "没有部件时原样返回同一个数组");
  assert.equal(provider.toProtocolContent(PROTOCOLS.ANTHROPIC, "你好"), "你好");
  assert.deepEqual(build(PROTOCOLS.OPENAI, "你好").messages?.[1], { role: "user", content: "你好" });
  assert.deepEqual(build(PROTOCOLS.ANTHROPIC, "你好").messages, [{ role: "user", content: "你好" }]);
  assert.deepEqual(build(PROTOCOLS.RESPONSES, "你好").input, [{ role: "user", content: "你好" }]);
});

test("认不出的内容原样透传：协议自己的内容块、空数组、带多余字段的部件都不改写", () => {
  const native = [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }];
  assert.equal(provider.toProtocolContent(PROTOCOLS.ANTHROPIC, native), native);
  assert.deepEqual(provider.toProtocolContent(PROTOCOLS.OPENAI, []), []);
  const extra = [{ type: "image", dataUrl: IMAGE_URL, detail: "high" }];
  assert.equal(provider.toProtocolContent(PROTOCOLS.RESPONSES, extra), extra);
  assert.equal(provider.isMessageParts([{ type: "text", text: "x", cache: false }]), false, "cache 只认 true");
});

test("图片只收 JPEG 的 data URL，别的在发出之前就报错", async () => {
  for (const dataUrl of [
    `data:image/png;base64,${IMAGE_DATA}`,
    "https://img.example.com/frame.jpg",
    "data:image/jpeg;base64,",
    "data:image/jpeg;base64,不是base64",
    `data:image/jpeg,${IMAGE_DATA}`,
  ]) {
    assert.throws(() => build(PROTOCOLS.OPENAI, [{ type: "image", dataUrl }]), /JPEG/, dataUrl);
  }
  let sends = 0;
  await assert.rejects(
    provider.sendChatWithRelax({
      settings: SETTINGS[PROTOCOLS.ANTHROPIC],
      messages: [{ role: "user", content: [{ type: "image", dataUrl: `data:image/png;base64,${IMAGE_DATA}` }] }],
      maxTokens: 100,
      send: async () => {
        sends += 1;
        return {};
      },
    }),
    /JPEG/,
  );
  assert.equal(sends, 0, "格式不对的图片不花一次请求");
});

test("要 JSON 输出时，用部件写的最后一条用户消息补一个文字部件；已经提到 JSON 的不补", () => {
  // 认不出的型号走 JSON 模式，要在用户消息里出现 JSON 这个词。
  const plain = provider.buildChatRequest({
    settings: { ...SETTINGS[PROTOCOLS.RESPONSES], aiModel: "gpt-4.1" },
    messages: [{ role: "user", content: [{ type: "image", dataUrl: IMAGE_URL }, { type: "text", text: "说说画面" }] }],
    maxTokens: 512,
    responseFormat: SCHEMAS.QA_ANSWER,
  }).body;
  assert.deepEqual(plain.input?.[0]?.content, [
    { type: "input_image", image_url: IMAGE_URL },
    { type: "input_text", text: "说说画面" },
    { type: "input_text", text: "请只输出 JSON。" },
  ]);

  const mentioned = provider.buildChatRequest({
    settings: { ...SETTINGS[PROTOCOLS.RESPONSES], aiModel: "gpt-4.1" },
    messages: [{ role: "user", content: [{ type: "image", dataUrl: IMAGE_URL }, { type: "text", text: "按 JSON 回答" }] }],
    maxTokens: 512,
    responseFormat: SCHEMAS.QA_ANSWER,
  }).body;
  assert.deepEqual(mentioned.input?.[0]?.content, [
    { type: "input_image", image_url: IMAGE_URL },
    { type: "input_text", text: "按 JSON 回答" },
  ]);
});

test("只有文字的部件：Anthropic 照旧分块并带缓存标记，其余协议拼回一个字符串", () => {
  const texts = [
    { type: "text", text: "视频信息" },
    { type: "text", text: "字幕", cache: true },
    { type: "text", text: "问题" },
  ];
  assert.deepEqual(provider.toProtocolContent(PROTOCOLS.ANTHROPIC, texts), [
    { type: "text", text: "视频信息" },
    { type: "text", text: "字幕", cache_control: { type: "ephemeral" } },
    { type: "text", text: "问题" },
  ]);
  assert.equal(provider.toProtocolContent(PROTOCOLS.OPENAI, texts), "视频信息\n\n字幕\n\n问题");
  assert.equal(provider.toProtocolContent(PROTOCOLS.RESPONSES, texts), "视频信息\n\n字幕\n\n问题");
  // 要 JSON 时补的那句跟在最后，和纯文本消息补的位置一样。
  const body = provider.buildChatRequest({
    settings: { ...SETTINGS[PROTOCOLS.RESPONSES], aiModel: "gpt-4.1" },
    messages: [{ role: "user", content: texts }],
    maxTokens: 512,
    responseFormat: SCHEMAS.QA_ANSWER,
  }).body;
  assert.equal(body.input?.[0]?.content, "视频信息\n\n字幕\n\n问题\n\n请只输出 JSON。");
});
