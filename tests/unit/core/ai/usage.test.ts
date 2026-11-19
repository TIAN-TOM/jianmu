// 用量：三种协议各自从回复里取输入、输出和单独报了的思考，没报的不估算；强制流式拼回以后照样取得到；
// 传输层每收到一份回复交出一次用量。样例都是自己造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleEventStream, PROTOCOLS, usageOf, type TokenUsage } from "../../../../src/core/ai/provider/index.ts";
import * as TRANSPORT from "../../../../src/core/ai/transport/index.ts";
import type { AiFetch, TransportResponse } from "../../../../src/core/ai/transport/index.ts";
import * as SETTINGS from "../../../../src/shared/settings-schema.ts";

test("OpenAI 兼容：输入、输出取服务报的数，思考取单独报的那项", () => {
  const data = { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540, completion_tokens_details: { reasoning_tokens: 210 } } };
  assert.deepEqual(usageOf(PROTOCOLS.OPENAI, data), { input: 1200, output: 340, reasoning: 210 });
});

test("OpenAI 兼容：思考没单独报就没有这一项，不拿输出去推；报了 0 就是 0", () => {
  assert.deepEqual(usageOf(PROTOCOLS.OPENAI, { usage: { prompt_tokens: 50, completion_tokens: 9 } }), { input: 50, output: 9 });
  assert.deepEqual(usageOf(PROTOCOLS.OPENAI, { usage: { prompt_tokens: 50, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 0 } } }), {
    input: 50,
    output: 9,
    reasoning: 0,
  });
});

test("OpenAI Responses：输入、输出和输出里单独报的思考", () => {
  const data = { status: "completed", output: [], usage: { input_tokens: 800, output_tokens: 600, output_tokens_details: { reasoning_tokens: 450 } } };
  assert.deepEqual(usageOf(PROTOCOLS.RESPONSES, data), { input: 800, output: 600, reasoning: 450 });
  assert.deepEqual(usageOf(PROTOCOLS.RESPONSES, { usage: { input_tokens: 8, output_tokens: 6 } }), { input: 8, output: 6 });
});

test("Anthropic：输入算上缓存命中和缓存写入，思考取输出明细里单独报的那项；没有这一项才算没单独报", () => {
  const data = {
    content: [],
    usage: { input_tokens: 30, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 700, output_tokens_details: { thinking_tokens: 520 } },
  };
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, data), { input: 3030, output: 700, reasoning: 520 });
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, { usage: { input_tokens: 12, output_tokens: 3, output_tokens_details: { thinking_tokens: 0 } } }), {
    input: 12,
    output: 3,
    reasoning: 0,
  });
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, { usage: { input_tokens: 12, output_tokens: 3 } }), { input: 12, output: 3 });
  // 别的协议的思考字段名不认：Anthropic 只看自己那一项。
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, { usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 9 } } }), { input: 1, output: 1 });
});

test("服务不回用量、用量形状不对或数字不像话：那几项就没有", () => {
  for (const protocol of Object.values(PROTOCOLS)) {
    assert.deepEqual(usageOf(protocol, { choices: [] }), {}, protocol);
    assert.deepEqual(usageOf(protocol, null), {}, protocol);
    assert.deepEqual(usageOf(protocol, { usage: "很多" }), {}, protocol);
  }
  assert.deepEqual(usageOf(PROTOCOLS.OPENAI, { usage: { prompt_tokens: -1, completion_tokens: 1.5, completion_tokens_details: { reasoning_tokens: "9" } } }), {});
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, { usage: { input_tokens: "12", output_tokens: 4 } }), { output: 4 });
});

const sse = (events: readonly unknown[]): string => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

test("强制流式拼回以后照样取得到用量：三种协议", () => {
  const chat = assembleEventStream(
    PROTOCOLS.OPENAI,
    `${sse([
      { id: "c1", choices: [{ index: 0, delta: { content: "好" } }] },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c1", choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } } },
    ])}data: [DONE]\n\n`,
  );
  assert.ok(chat.ok);
  assert.deepEqual(usageOf(PROTOCOLS.OPENAI, chat.data), { input: 40, output: 20, reasoning: 15 });

  const anthropic = assembleEventStream(
    PROTOCOLS.ANTHROPIC,
    sse([
      { type: "message_start", message: { id: "m1", content: [], usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 33, output_tokens_details: { thinking_tokens: 21 } } },
      { type: "message_stop" },
    ]),
  );
  assert.ok(anthropic.ok);
  assert.deepEqual(usageOf(PROTOCOLS.ANTHROPIC, anthropic.data), { input: 30, output: 33, reasoning: 21 });

  const responses = assembleEventStream(
    PROTOCOLS.RESPONSES,
    sse([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "好" },
      { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 9, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 } } } },
    ]),
  );
  assert.ok(responses.ok);
  assert.deepEqual(usageOf(PROTOCOLS.RESPONSES, responses.data), { input: 9, output: 7, reasoning: 4 });
});

const reply = (data: unknown): TransportResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

function transportWith(fetch: AiFetch, onUsage: (usage: TokenUsage) => void) {
  return TRANSPORT.createAiTransport({
    getSettings: async () =>
      SETTINGS.normalize({
        presetId: "custom",
        protocol: PROTOCOLS.OPENAI,
        aiApiKey: "test-key",
        aiBaseUrl: "https://api.example.com/v1",
        aiModel: "test-model",
        ...SETTINGS.DATA_CONSENT_CONFIRMED,
      }),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    fetch,
    onUsage,
  });
}

const MESSAGES = [{ role: "user", content: "你好" }];

test("传输层每收到一份回复交出一次用量：加码重发的那次也算，只有用量，不带正文", async () => {
  const replies = [
    reply({ choices: [{ message: { content: "{\"a\":", reasoning_content: "想" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 90 } } }),
    reply({ choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 30 } }),
  ];
  const seen: TokenUsage[] = [];
  const transport = transportWith(async () => replies.shift() ?? assert.fail("多发了一次"), (usage) => seen.push(usage));
  const result = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });
  assert.equal(result.text, "{\"a\":1}");
  assert.deepEqual(seen, [
    { input: 10, output: 100, reasoning: 90 },
    { input: 10, output: 30 },
  ]);
});

test("传输层：服务没回用量照样交出一份空的；请求被拒的不交；记用量出错不影响请求", async () => {
  const seen: TokenUsage[] = [];
  const quiet = transportWith(async () => reply({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }), (usage) => seen.push(usage));
  await quiet.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });
  assert.deepEqual(seen, [{}]);

  const denied = transportWith(
    async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "密钥不对" } }) }),
    (usage) => seen.push(usage),
  );
  await assert.rejects(denied.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 }));
  assert.equal(seen.length, 1, "被拒的请求没有回复，不交用量");

  const broken = transportWith(
    async () => reply({ choices: [{ message: { content: "照常" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    () => {
      throw new Error("记不下");
    },
  );
  assert.equal((await broken.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 })).text, "照常");
});

test("传输层交出的档位是这次实际按的：服务拒掉档位参数、去掉以后发成功的，记成由服务决定，不记成选的那档", async () => {
  const bodies: Record<string, unknown>[] = [];
  const seen: unknown[] = [];
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () =>
      SETTINGS.normalize({
        presetId: "custom",
        protocol: PROTOCOLS.RESPONSES,
        aiApiKey: "test-key",
        aiBaseUrl: "https://api.openai.com/v1",
        aiModel: "gpt-9",
        ...SETTINGS.DATA_CONSENT_CONFIRMED,
      }),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      if (body["reasoning"]) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "这个模型不接受 reasoning 参数", param: "reasoning.effort" } }) };
      }
      return reply({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "好" }] }],
        usage: { input_tokens: 20, output_tokens: 8, output_tokens_details: { reasoning_tokens: 5 } },
      });
    },
    onUsage: (usage, effort) => seen.push({ usage, effective: effort.effective, note: effort.note }),
  });

  assert.equal((await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 64, effort: "high" })).text, "好");
  assert.equal(bodies.length, 2, "第一次带着档位被拒，去掉以后重发");
  assert.deepEqual(seen, [{ usage: { input: 20, output: 8, reasoning: 5 }, effective: "off", note: "unknown" }]);
});

test("传输层：没有放宽过的，交出的就是按选的档位算出来的那一档", async () => {
  const seen: unknown[] = [];
  const deepseek = TRANSPORT.createAiTransport({
    getSettings: async () => SETTINGS.normalize({ presetId: "deepseek", aiApiKey: "test-key", aiModel: "deepseek-flash", ...SETTINGS.DATA_CONSENT_CONFIRMED }),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    fetch: async () => reply({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    onUsage: (_usage, effort) => seen.push([effort.effective, effort.note ?? null]),
  });
  await deepseek.requestAiCompletion({ messages: MESSAGES, maxTokens: 64, effort: "high" });
  assert.deepEqual(seen, [["high", null]]);
});
