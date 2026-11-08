// 强制流式的拼回：三种协议的事件流（正常、中途报错、被截断、断在半截、空内容）拼出来的普通响应，
// 解析结果和对应的普通响应一样；传输层把流中途的错误交给限流和忙碌重发，不占自愈轮次，报错里不带密钥。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOLS, type Protocol } from "../../../../src/core/ai/provider/endpoint.ts";
import * as provider from "../../../../src/core/ai/provider/index.ts";
import type { StreamAssembly } from "../../../../src/core/ai/provider/index.ts";
import * as TRANSPORT from "../../../../src/core/ai/transport/index.ts";
import type { AiFetch, Sleep, TransportError, TransportResponse } from "../../../../src/core/ai/transport/index.ts";
import * as SETTINGS from "../../../../src/shared/settings-schema.ts";
import * as RESP from "../../../helpers/responses-fixtures.ts";

type Event = readonly [name: string | null, data: unknown];

// 照事件流的写法拼文本：可选的事件名一行、数据一行、空一行。
function sse(events: readonly Event[], { done = false }: { done?: boolean } = {}): string {
  const lines = events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  return lines.join("") + (done ? "data: [DONE]\n\n" : "");
}

// 拼回来的和普通响应比的是解析结果：正文、截断、拒答、能否加码、空响应的成因。
function views(protocol: Protocol, data: unknown) {
  return {
    text: provider.parseChatResponse(protocol, data),
    truncated: provider.isTruncated(protocol, data),
    refusal: provider.refusalOf(protocol, data),
    raise: provider.canRaiseBudget(protocol, data),
    empty: provider.diagnoseEmptyResponse(protocol, data).reason,
  };
}

function assembled(protocol: Protocol, text: string): Extract<StreamAssembly, { ok: true }> {
  const result = provider.assembleEventStream(protocol, text);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<StreamAssembly, { ok: true }>;
}

function sameAsPlain(protocol: Protocol, stream: string, plain: unknown, { complete = true } = {}) {
  const result = assembled(protocol, stream);
  assert.equal(result.complete, complete);
  assert.deepEqual(views(protocol, result.data), views(protocol, plain));
  return result;
}

// ============================================================
// Chat Completions
// ============================================================

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => [
  null,
  { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "some-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra },
] as const;

test("Chat Completions：正常的事件流拼成普通响应，保活注释和用量块都不影响正文", () => {
  const stream =
    ": keep-alive\n\n" +
    sse(
      [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "你" }),
        chunk({ content: "好" }),
        chunk({}, "stop"),
        [null, { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { completion_tokens: 2 } }],
      ],
      { done: true },
    );
  const result = sameAsPlain(PROTOCOLS.OPENAI, stream, { choices: [{ message: { content: "你好" }, finish_reason: "stop" }] });
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, result.data), "你好");
});

test("Chat Completions：思考占了预算被截断、空内容，判断和普通响应一样", () => {
  sameAsPlain(
    PROTOCOLS.OPENAI,
    sse([chunk({ reasoning_content: "先想" }), chunk({ reasoning_content: "一想" }), chunk({ content: "半" }), chunk({}, "length")], { done: true }),
    { choices: [{ message: { content: "半", reasoning_content: "先想一想" }, finish_reason: "length" }] },
  );
  sameAsPlain(PROTOCOLS.OPENAI, sse([chunk({ role: "assistant" }), chunk({}, "stop")], { done: true }), {
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  });
});

test("Chat Completions：中途的错误块拼成服务方报错，状态码按错误类型对上", () => {
  const failed = provider.assembleEventStream(
    PROTOCOLS.OPENAI,
    sse([
      chunk({ content: "前半" }),
      [null, { error: { code: "server_error", message: "gateway closed early" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }],
    ]),
  );
  assert.deepEqual(failed, { ok: false, status: 500, message: "gateway closed early", code: "server_error" });
  const limited = provider.assembleEventStream(PROTOCOLS.OPENAI, sse([[null, { error: { code: 429, message: "slow down" } }]]));
  assert.equal(limited.ok === false && limited.status, 429);
  const quota = provider.assembleEventStream(PROTOCOLS.OPENAI, sse([[null, { error: { type: "insufficient_quota", message: "quota used up" } }]]));
  assert.equal(quota.ok === false && quota.status, 429);
});

test("Chat Completions：断在半截的流标成没收尾，正文照样拼出来；最后一块断在 JSON 中间也一样", () => {
  const cut = assembled(PROTOCOLS.OPENAI, sse([chunk({ content: "前半" }), chunk({ content: "段" })]));
  assert.equal(cut.complete, false);
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, cut.data), "前半段");
  const broken = assembled(PROTOCOLS.OPENAI, `${sse([chunk({ content: "前半" }), chunk({}, "stop")])}data: {"choices":[{"delta":{"content":"后`);
  assert.equal(broken.complete, false);
});

// ============================================================
// Anthropic
// ============================================================

const messageStart = ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-sample", stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }] as const;
const blockStart = (index: number, block: Record<string, unknown>) => ["content_block_start", { type: "content_block_start", index, content_block: block }] as const;
const blockDelta = (index: number, delta: Record<string, unknown>) => ["content_block_delta", { type: "content_block_delta", index, delta }] as const;
const blockStop = (index: number) => ["content_block_stop", { type: "content_block_stop", index }] as const;
const messageDelta = (stop: string) => ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 15 } }] as const;
const messageStop = ["message_stop", { type: "message_stop" }] as const;
const ping = ["ping", { type: "ping" }] as const;

test("Anthropic：正常的事件流拼成普通响应", () => {
  const stream = sse([
    messageStart,
    blockStart(0, { type: "text", text: "" }),
    ping,
    blockDelta(0, { type: "text_delta", text: "你" }),
    blockDelta(0, { type: "text_delta", text: "好" }),
    blockStop(0),
    messageDelta("end_turn"),
    messageStop,
  ]);
  const result = sameAsPlain(PROTOCOLS.ANTHROPIC, stream, { content: [{ type: "text", text: "你好" }], stop_reason: "end_turn" });
  assert.equal((result.data as { usage?: { output_tokens?: number } }).usage?.output_tokens, 15, "用量按最后一次的累计值");
});

test("Anthropic：带思考块被截断、拒答、空内容，判断和普通响应一样", () => {
  sameAsPlain(
    PROTOCOLS.ANTHROPIC,
    sse([
      messageStart,
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "想" }),
      blockDelta(0, { type: "signature_delta", signature: "sig" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      blockDelta(1, { type: "text_delta", text: "半" }),
      messageDelta("max_tokens"),
      messageStop,
    ]),
    { content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "半" }], stop_reason: "max_tokens" },
  );
  sameAsPlain(PROTOCOLS.ANTHROPIC, sse([messageStart, messageDelta("refusal"), messageStop]), { content: [], stop_reason: "refusal" });
  sameAsPlain(PROTOCOLS.ANTHROPIC, sse([messageStart, messageDelta("end_turn"), messageStop]), { content: [], stop_reason: "end_turn" });
});

test("Anthropic：中途的过载事件拼成 529，断在半截的流标成没收尾", () => {
  const failed = provider.assembleEventStream(
    PROTOCOLS.ANTHROPIC,
    sse([messageStart, blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "前" }), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]),
  );
  assert.deepEqual(failed, { ok: false, status: 529, message: "Overloaded", type: "overloaded_error" });
  const cut = assembled(PROTOCOLS.ANTHROPIC, sse([messageStart, blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "前半" })]));
  assert.equal(cut.complete, false);
  assert.equal(provider.parseChatResponse(PROTOCOLS.ANTHROPIC, cut.data), "前半");
});

// ============================================================
// OpenAI Responses
// ============================================================

const created = ["response.created", { type: "response.created", response: RESP.baseResponse({ status: "in_progress", completed_at: null, usage: null }), sequence_number: 0 }] as const;
const textDelta = (delta: string) => ["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta, sequence_number: 1 }] as const;
const finished = (type: string, response: unknown) => [type, { type, response, sequence_number: 9 }] as const;

test("Responses：收尾事件带着完整响应，直接用它；收尾里没带输出时按增量补上", () => {
  const response = RESP.completed("你好");
  sameAsPlain(PROTOCOLS.RESPONSES, sse([created, textDelta("你"), textDelta("好"), finished("response.completed", response)]), response);

  const bare = assembled(PROTOCOLS.RESPONSES, sse([created, textDelta("你"), textDelta("好"), finished("response.completed", RESP.baseResponse())]));
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, bare.data), "你好");
});

test("Responses：推理占了预算被截断、拒答、空内容，判断和普通响应一样", () => {
  const incomplete = RESP.incomplete("半");
  sameAsPlain(PROTOCOLS.RESPONSES, sse([created, textDelta("半"), finished("response.incomplete", incomplete)]), incomplete);
  const refused = RESP.refusal();
  sameAsPlain(PROTOCOLS.RESPONSES, sse([created, finished("response.completed", refused)]), refused);
  const empty = RESP.baseResponse({ output: [RESP.messageItem([])] });
  sameAsPlain(PROTOCOLS.RESPONSES, sse([created, finished("response.completed", empty)]), empty);
});

test("Responses：中途的错误事件拼成服务方报错，断在半截的流按增量拼出已有正文", () => {
  const failed = provider.assembleEventStream(
    PROTOCOLS.RESPONSES,
    sse([created, textDelta("前"), ["error", { type: "error", code: "rate_limit_exceeded", message: "too fast, wait a bit", param: null, sequence_number: 3 }]]),
  );
  assert.deepEqual(failed, { ok: false, status: 429, message: "too fast, wait a bit", code: "rate_limit_exceeded" });
  const cut = assembled(PROTOCOLS.RESPONSES, sse([created, textDelta("前"), textDelta("半")]));
  assert.equal(cut.complete, false);
  assert.equal(provider.parseChatResponse(PROTOCOLS.RESPONSES, cut.data), "前半");
  assert.equal(provider.isTruncated(PROTOCOLS.RESPONSES, cut.data), false, "截断原因没收到，交给信封那一层按断了处理");
});

// ============================================================
// 识别
// ============================================================

test("按响应类型或正文开头认事件流；正文是 JSON 时按 JSON", () => {
  assert.equal(provider.looksLikeEventStream("text/event-stream; charset=utf-8", "data: {}"), true);
  assert.equal(provider.looksLikeEventStream(null, "event: message_start\ndata: {}"), true);
  assert.equal(provider.looksLikeEventStream(undefined, "﻿\n: keep-alive\n\n"), true);
  assert.equal(provider.looksLikeEventStream("application/json", "data:{}"), true, "响应类型写错了也按正文认");
  assert.equal(provider.looksLikeEventStream("text/event-stream", '{"choices":[]}'), false, "正文是 JSON 就按 JSON");
  assert.equal(provider.looksLikeEventStream("application/json", '  {"choices":[]}'), false);
  assert.equal(provider.looksLikeEventStream("text/plain", "Data: nope"), false);
  assert.deepEqual(provider.assembleEventStream(PROTOCOLS.OPENAI, ": only comments\n\n"), { ok: true, data: null, complete: false });
});

// ============================================================
// 传输层
// ============================================================

const SECRET = "sk-stream-secret-for-tests";

function settingsFor(protocol: Protocol) {
  const preset =
    protocol === PROTOCOLS.ANTHROPIC
      ? { presetId: "custom", protocol, aiBaseUrl: "https://gateway.example.com", aiModel: "claude-sample" }
      : protocol === PROTOCOLS.RESPONSES
        ? { presetId: "custom", protocol, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "gpt-6-astra" }
        : { presetId: "custom", protocol, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "some-model" };
  return SETTINGS.normalize({ ...preset, aiApiKey: SECRET, ...SETTINGS.DATA_CONSENT_CONFIRMED });
}

// 网关强制回事件流：响应类型写事件流，正文分几段到。
function streamed(text: string, contentType = "text/event-stream"): TransportResponse {
  const bytes = new TextEncoder().encode(text);
  const pieces = [bytes.slice(0, Math.ceil(bytes.length / 2)), bytes.slice(Math.ceil(bytes.length / 2))];
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => {
          const value = pieces.shift();
          return value ? { done: false, value } : { done: true };
        },
      }),
    },
    text: async () => text,
  };
}

function transportWith(protocol: Protocol, replies: readonly TransportResponse[], extra: { sleep?: Sleep; log?: (...args: unknown[]) => void; maxResponseBytes?: number } = {}) {
  const queue = [...replies];
  let sends = 0;
  const fetch: AiFetch = async () => {
    sends += 1;
    const next = queue.shift();
    if (!next) throw new Error("测试里没有准备更多回复");
    return next;
  };
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => settingsFor(protocol),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: extra.sleep ?? (async () => {}),
    log: extra.log,
    maxResponseBytes: extra.maxResponseBytes,
    fetch,
  });
  return { transport, sends: () => sends };
}

const MESSAGES = [{ role: "user", content: "你好" }];

const failureOf = (pending: Promise<unknown>): Promise<TransportError> =>
  pending.then(
    () => assert.fail("应当报错"),
    (error: TransportError) => error,
  );

test("传输层：三种协议的强制流式响应都拼回普通回复，只发一次", async () => {
  const cases: readonly [Protocol, string][] = [
    [PROTOCOLS.OPENAI, sse([chunk({ content: "可用" }), chunk({}, "stop")], { done: true })],
    [PROTOCOLS.ANTHROPIC, sse([messageStart, blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "可用" }), messageDelta("end_turn"), messageStop])],
    [PROTOCOLS.RESPONSES, sse([created, finished("response.completed", RESP.completed("可用"))])],
  ];
  for (const [protocol, stream] of cases) {
    const { transport, sends } = transportWith(protocol, [streamed(stream)]);
    const result = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
    assert.equal(result.text, "可用", protocol);
    assert.equal(result.truncated, undefined, protocol);
    assert.equal(sends(), 1, protocol);
  }
});

test("传输层：流中途限流或过载，按忙碌重发一次，不占自愈轮次", async () => {
  const overloaded = sse([messageStart, ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]);
  const waits: number[] = [];
  const ok = transportWith(PROTOCOLS.ANTHROPIC, [streamed(overloaded), streamed(sse([messageStart, blockStart(0, { type: "text", text: "可用" }), messageDelta("end_turn"), messageStop]))], {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal((await ok.transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 })).text, "可用");
  assert.equal(ok.sends(), 2);
  assert.equal(waits.length, 1, "按限流过载的办法等一会儿再发");

  // 流中途限流一次，之后三轮都是思考占了预算的截断：三轮加码一轮不少，总共发四次。
  const limited = sse([[null, { error: { code: 429, message: "slow down" } }]]);
  const thinking = (text: string) => streamed(sse([chunk({ reasoning_content: "想", content: text }), chunk({}, "length")], { done: true }));
  const rounds = transportWith(PROTOCOLS.OPENAI, [streamed(limited), thinking("{"), thinking('{"a"'), thinking('{"a":')]);
  const result = await rounds.transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(rounds.sends(), 4, "流中途的报错不算一轮自愈");
  assert.equal(result.truncated, true);
  assert.equal(result.text, '{"a":');
});

test("传输层：流中途报额度用完，不重发；报错里不带密钥，日志里也没有", async () => {
  const logs: string[] = [];
  const quota = sse([[null, { error: { code: "insufficient_quota", message: `quota exceeded for key ${SECRET}` } }]]);
  const { transport, sends } = transportWith(PROTOCOLS.OPENAI, [streamed(quota)], { log: (...args) => logs.push(args.map(String).join(" ")) });
  const error = await failureOf(transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(sends(), 1);
  assert.equal(error.status, 429);
  assert.equal(error.quotaExhausted, true);
  assert.equal(error.noAutoRetry, true);
  assert.doesNotMatch(error.message, new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(TRANSPORT.aiErrorResponse(error)), new RegExp(SECRET));
  for (const line of logs) assert.doesNotMatch(line, new RegExp(SECRET));
});

test("传输层：断在半截的流交回已有正文并标截断，不加码重发；一个事件都没有就报响应不完整", async () => {
  const cut = transportWith(PROTOCOLS.ANTHROPIC, [streamed(sse([messageStart, blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: '{"chapters": [' })]))]);
  const partial = await cut.transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.deepEqual([partial.text, partial.truncated, cut.sends()], ['{"chapters": [', true, 1]);

  const empty = transportWith(PROTOCOLS.OPENAI, [streamed(": keep-alive\n\n")]);
  const error = await failureOf(empty.transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(error.code, "AI_RESPONSE_TRUNCATED");
});

test("传输层：响应大小上限照旧按原始正文算", async () => {
  const long = sse(Array.from({ length: 50 }, () => chunk({ content: "很长的一段" })), { done: true });
  const { transport } = transportWith(PROTOCOLS.OPENAI, [streamed(long)], { maxResponseBytes: 1024 });
  const error = await failureOf(transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(error.code, "AI_RESPONSE_TOO_LARGE");
});

test("传输层：不知道协议时不认事件流，和以前一样按 JSON 解析", async () => {
  const { transport } = transportWith(PROTOCOLS.OPENAI, [streamed(sse([chunk({ content: "可用" })], { done: true }))]);
  const error = await failureOf(transport.sendAiRequest({ aiBaseUrl: "https://gateway.example.com/v1" }, { url: "https://gateway.example.com/v1/chat/completions", headers: {}, body: {} }));
  assert.equal(error.code, "AI_RESPONSE_TRUNCATED");
});
