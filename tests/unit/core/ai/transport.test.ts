// 传输层：配置检查、自愈重发、截断、超时、错误翻译、限流重发，以及带密钥请求的约定。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  CAPABILITY_STORAGE_KEY,
  createCapabilityResolver,
  createConsentGuardedGetter,
  createJsonGetter,
  type JsonResponse,
} from "../../../../src/core/ai/capabilities.ts";
import { extractPromptSection } from "../../../../src/core/ai/prompt.ts";
import * as PROVIDER from "../../../../src/core/ai/provider/index.ts";
import type { AiSettings, ChatMessage, ChatRequestBody, ClaudeCapabilities } from "../../../../src/core/ai/provider/index.ts";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import * as TRANSPORT from "../../../../src/core/ai/transport/index.ts";
import type {
  AiFetch,
  AiFetchInit,
  AiTransportDeps,
  RetryNotice,
  Sleep,
  TransportError,
  TransportResponse,
  TransportSettingsRules,
} from "../../../../src/core/ai/transport/index.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";
import * as RESP from "../../../helpers/responses-fixtures.ts";
import * as SETTINGS from "../../../helpers/settings-rules.ts";

const { PROTOCOLS } = PROVIDER;

function makeSettings(overrides: SETTINGS.SettingsInput = {}) {
  return SETTINGS.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.OPENAI,
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "test-model",
    ...SETTINGS.CONSENTED,
    ...overrides,
  });
}

// 限流、过载后的等待默认不真等：要看等了多久的用例自己传 sleep 进来记下。
const instantSleep: Sleep = async () => {};

type Overrides = Partial<Omit<AiTransportDeps, "fetch">>;

function makeTransport(fetchImpl: AiFetch, overrides: Overrides = {}) {
  return TRANSPORT.createAiTransport({
    getSettings: async () => makeSettings(),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    idleTimeoutMs: 80,
    sleep: instantSleep,
    ...overrides,
    fetch: fetchImpl,
  });
}

const bodyOf = (init: AiFetchInit): ChatRequestBody => JSON.parse(init.body) as ChatRequestBody;

// 等请求失败，拿到错误；请求成功了就算用例失败。
const failureOf = (pending: Promise<unknown>): Promise<TransportError> =>
  pending.then(
    () => assert.fail("应当报错"),
    (error: TransportError) => error,
  );

const json = (value: unknown): (() => Promise<string>) => async () => JSON.stringify(value);

// 纯对象响应（没有 body 流），readBoundedAiResponse 会走 response.text() 分支。
function openaiReply(content: string, extra: Readonly<Record<string, unknown>> = {}): TransportResponse {
  return {
    ok: true,
    status: 200,
    text: json({ choices: [{ message: { content }, ...extra }] }),
  };
}

// 带思考内容的截断响应：思考占了预算，加大预算有望补全。
function openaiThinkingTruncated(content: string): TransportResponse {
  return {
    ok: true,
    status: 200,
    text: json({
      choices: [{ message: { content, reasoning_content: "先想一想" }, finish_reason: "length" }],
    }),
  };
}

function collectRequests(log: ChatRequestBody[]): AiFetch {
  return async (_url, init) => {
    log.push(bodyOf(init));
    return openaiReply("");
  };
}

const MESSAGES = [{ role: "user", content: "你好" }];

function anthropicError(status: number, message: string): TransportResponse {
  return {
    ok: false,
    status,
    text: json({ type: "error", error: { type: "invalid_request_error", message } }),
  };
}

function anthropicReply(text: string): TransportResponse {
  return {
    ok: true,
    status: 200,
    text: json({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
  };
}

function anthropicTruncated(text: string): TransportResponse {
  return {
    ok: true,
    status: 200,
    text: json({ content: [{ type: "text", text }], stop_reason: "max_tokens" }),
  };
}

// 官方排错页的原文。
const SONNET_55_DISABLED_REJECTED =
  'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks.';
const ALWAYS_ON_DISABLED_REJECTED =
  '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';

function anthropicSettingsFor(model: string, overrides: SETTINGS.SettingsInput = {}) {
  return makeSettings({
    presetId: "anthropic",
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://api.anthropic.com",
    aiModel: model,
    ...overrides,
  });
}

const gatewaySettings = () =>
  makeSettings({
    presetId: "custom",
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://gateway.example.com",
    aiModel: "claude-next-unknown",
  });

// 拒绝 thinking.type.disabled 的服务：其余请求按 respond 处理。
function rejectDisabledThinking(
  requests: ChatRequestBody[],
  message: string,
  respond: (body: ChatRequestBody) => TransportResponse = () => anthropicReply("可用"),
): AiFetch {
  return async (_url, init) => {
    const parsed = bodyOf(init);
    requests.push(parsed);
    if (parsed.thinking?.type === "disabled") return anthropicError(400, message);
    return respond(parsed);
  };
}

// 第一轮拿到截断正文，之后每一轮交给 later 处理。
function truncatedThen(
  requests: ChatRequestBody[],
  later: (init: AiFetchInit) => TransportResponse | Promise<TransportResponse>,
): AiFetch {
  return async (_url, init) => {
    requests.push(bodyOf(init));
    return requests.length === 1 ? anthropicTruncated('{"chapters": [') : later(init);
  };
}

const CLAUDE_46 = { getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6") };

function makeHangingFetch(): AiFetch {
  return (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
}

const SEND_REQUEST = { url: "https://api.example.com/v1/chat", headers: {}, body: {} };

// 网关、中转站、Cloudflare 的错误页常常不是 JSON：先看状态码，状态码不能丢。
async function sendOnce(response: TransportResponse): Promise<TransportError> {
  const t = makeTransport(async () => response);
  return failureOf(
    t.sendAiRequest({ aiBaseUrl: "https://api.example.com", aiApiKey: "sk-secret-123456" }, SEND_REQUEST),
  );
}

// 照官方示例的形状：结构化输出照样放在 text 块里，只是内容一定是合 schema 的 JSON。
function anthropicMessage(text: string, stopReason = "end_turn"): TransportResponse {
  return {
    ok: true,
    status: 200,
    text: json({
      id: "msg_01XFDUDYJgAACzvnptvVoYEL",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 412, output_tokens: 86 },
    }),
  };
}

interface SentRequest {
  readonly url: string;
  readonly body: ChatRequestBody;
}

function responsesTransport(
  model: string,
  respond: (count: number, body: ChatRequestBody) => TransportResponse,
  requests: SentRequest[],
) {
  return makeTransport(
    async (url, init) => {
      const body = bodyOf(init);
      requests.push({ url, body });
      return respond(requests.length, body);
    },
    { getSettings: async () => makeSettings({ presetId: "openai", aiBaseUrl: undefined, aiModel: model }) },
  );
}

const MODEL_CAPS = (overrides: ClaudeCapabilities = {}): ClaudeCapabilities => ({
  maxTokens: 4096,
  thinking: { disabled: true, betweenTools: true, adaptive: true },
  efforts: ["low", "medium", "high"],
  structuredOutputs: true,
  ...overrides,
});

// 按顺序回放 responses，用完后一直回最后一个；fetches 记下发了几次。
function replay(responses: readonly (TransportResponse | (() => TransportResponse))[]) {
  const server = {
    fetches: 0,
    fetch: (async () => {
      const next = responses[Math.min(server.fetches, responses.length - 1)]!;
      server.fetches += 1;
      return typeof next === "function" ? next() : next;
    }) as AiFetch,
  };
  return server;
}

const ok200 = () => openaiReply("恢复了");
const overloaded = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), {
    status: 529,
  });

function recordingSleep() {
  const waits: number[] = [];
  const sleep: Sleep = async (ms) => {
    waits.push(ms);
  };
  return { waits, sleep };
}

const limitedWithRetryAfter = (seconds: string): TransportResponse => ({
  ok: false,
  status: 429,
  headers: { get: (name) => (name.toLowerCase() === "retry-after" ? seconds : null) },
  text: async () => "",
});

// ============================================================
// requestAiCompletion：配置检查与正常路径
// ============================================================

test("正常请求返回模型文本与本次设置", async () => {
  const t = makeTransport(async () => openaiReply("模型的话"));
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 512,
  });
  assert.equal(result.text, "模型的话");
  assert.equal(result.settings.aiModel, "test-model");
});

test("配置不完整时拒绝请求，不发起网络调用", async () => {
  let called = 0;
  const t = TRANSPORT.createAiTransport({
    getSettings: async () => SETTINGS.normalize({}),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch: async () => {
      called += 1;
      return openaiReply("x");
    },
  });

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1 }),
    { code: "NO_AI_CONFIG" },
  );
  assert.equal(called, 0);
});

test("缺少主机权限时原样透出，提示用户去设置页授权", async () => {
  const permissionError: TransportError = new Error("请先授权");
  permissionError.code = "NEED_HOST_PERMISSION";
  const t = TRANSPORT.createAiTransport({
    getSettings: async () => makeSettings(),
    ensureHostPermission: async () => {
      throw permissionError;
    },
    settingsRules: SETTINGS.settingsRules,
    fetch: async () => openaiReply("x"),
  });

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1 }),
    (error) => error === permissionError,
  );
});

test("确认过数据说明但没填密钥时同样拒绝，不申请权限也不发请求", async () => {
  let fetches = 0;
  let permissions = 0;
  const t = makeTransport(
    async () => {
      fetches += 1;
      return openaiReply("x");
    },
    {
      getSettings: async () => makeSettings({ aiApiKey: "" }),
      ensureHostPermission: async () => {
        permissions += 1;
      },
    },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1 }),
    (error: TransportError) => error.code === "NO_AI_CONFIG" && /API 密钥/.test(error.message),
  );
  assert.equal(fetches, 0);
  assert.equal(permissions, 0);
});

// ============================================================
// 同意的核对不能因为注入而跳过
// ============================================================

test("校验放行时，发出之前的同意核对照样拦下", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return openaiReply("不该发出");
    },
    {
      getSettings: async () => makeSettings({ dataConsentVersion: 0 }),
      settingsRules: { ...SETTINGS.settingsRules, validate: () => ({ ok: true, errors: [] }) },
    },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.code === "NO_AI_CONFIG" && error.message.includes(SETTINGS.DATA_CONSENT_ERROR),
  );
  assert.deepEqual(requests, []);
});

test("设置规则缺了核对同意要用的项时建不出传输层", () => {
  const { dataConsentVersion: _version, ...withoutVersion } = SETTINGS.settingsRules;
  const { dataConsentFingerprint: _fingerprint, ...withoutFingerprint } = SETTINGS.settingsRules;
  const incomplete: readonly unknown[] = [
    undefined,
    withoutVersion,
    withoutFingerprint,
    { ...SETTINGS.settingsRules, dataConsentVersion: 0 },
    { ...SETTINGS.settingsRules, dataConsentVersion: 1.5 },
    { ...SETTINGS.settingsRules, dataConsentFingerprint: "" },
    { ...SETTINGS.settingsRules, dataConsentError: "" },
    { ...SETTINGS.settingsRules, normalize: undefined },
    { ...SETTINGS.settingsRules, validate: undefined },
    { ...SETTINGS.settingsRules, withFeatureModel: undefined },
    { ...SETTINGS.settingsRules, timeoutSeconds: undefined },
  ];
  for (const rules of incomplete) {
    assert.throws(() => makeTransport(async () => openaiReply("x"), { settingsRules: rules as TransportSettingsRules }), /设置规则/);
  }
});

// ============================================================
// 空响应自愈
// ============================================================

test("JSON 模式返回空时脱掉 response_format 重试一次", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(collectRequests(requests));

  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: 100,
        responseFormat: { type: "json_object" },
      }),
    { code: "EMPTY_AI_RESPONSE" },
  );

  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.response_format, "第一轮带 JSON 模式");
  assert.equal(requests[1]!.response_format, undefined, "第二轮已脱掉");
});

test("加码之后脱掉 JSON 模式重发，也不超过合计预算", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return requests.length === 1 ? openaiReply("", { finish_reason: "length" }) : openaiReply("");
  });

  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: 8192,
        responseFormat: { type: "json_object" },
      }),
    { code: "EMPTY_AI_RESPONSE" },
  );

  const budgets = requests.map((request) => Number(request.max_tokens));
  assert.deepEqual(budgets, [8192, 32768, 24576]);
  assert.equal(
    budgets.reduce((sum, budget) => sum + budget, 0),
    TRANSPORT.TOTAL_OUTPUT_TOKENS_CAP,
  );
});

test("输出被截断时按四倍放大预算，直到天花板", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return openaiReply("", { finish_reason: "length" });
  });

  await assert.rejects(() => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));

  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [100, 400, 1600],
  );
});

test("请求途中取消了数据说明的确认：已经发出的那次照常回来，加码重试不再发", async () => {
  const requests: ChatRequestBody[] = [];
  let consent = SETTINGS.DATA_CONSENT_VERSION;
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      // 第一次请求还在路上时，用户在设置页取消了勾选。
      consent = 0;
      return openaiReply("", { finish_reason: "length" });
    },
    { getSettings: async () => makeSettings({ dataConsentVersion: consent }) },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.code === "NO_AI_CONFIG" && error.message.includes(SETTINGS.DATA_CONSENT_ERROR),
  );
  assert.equal(requests.length, 1, "只发了取消之前的那一次");
});

test("查模型能力期间取消了数据说明的确认：第一次请求也不发", async () => {
  const requests: ChatRequestBody[] = [];
  let consent = SETTINGS.DATA_CONSENT_VERSION;
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return openaiReply("{}");
    },
    {
      getSettings: async () => makeSettings({ dataConsentVersion: consent }),
      // 能力查询要联网，这时用户在设置页取消了勾选。
      getModelCapabilities: async () => {
        consent = 0;
        return null;
      },
    },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.code === "NO_AI_CONFIG",
  );
  assert.deepEqual(requests, []);
});

test("发前核对读到的同意版本不是当前版本：报 NO_AI_CONFIG，不发请求", async () => {
  for (const version of [SETTINGS.DATA_CONSENT_VERSION - 1, SETTINGS.DATA_CONSENT_VERSION + 1]) {
    let reads = 0;
    let fetches = 0;
    const t = makeTransport(
      async () => {
        fetches += 1;
        return openaiReply("{}");
      },
      {
        // 开头的校验读到当前版本，真正发出之前读到的版本变了。
        getSettings: async () => {
          reads += 1;
          return makeSettings(reads === 1 ? {} : { dataConsentVersion: version });
        },
      },
    );

    await assert.rejects(
      () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
      (error: TransportError) => error.code === "NO_AI_CONFIG" && error.message.includes(SETTINGS.DATA_CONSENT_ERROR),
    );
    assert.equal(reads, 2, `版本 ${version}`);
    assert.equal(fetches, 0, `版本 ${version}`);
  }
});

test("发前核对同意的工夫取消了：fetch 收到的信号已经中止，报 TASK_CANCELED", async () => {
  const controller = new AbortController();
  const received: boolean[] = [];
  let reads = 0;
  const t = makeTransport(
    async (_url, init) => {
      received.push(init.signal.aborted);
      // 真的 fetch 收到已中止的信号时不发出，直接拒绝。
      if (init.signal.aborted) throw new DOMException("已中止", "AbortError");
      return openaiReply("{}");
    },
    {
      getSettings: async () => {
        reads += 1;
        if (reads === 2) controller.abort();
        return makeSettings();
      },
    },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, signal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.deepEqual(received, [true], "取消之后不发出计费请求");
});

const MODEL_PAGE = (id: string): JsonResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id, type: "model" }], has_more: true, first_id: id, last_id: id }),
});

test("后台：查模型能力途中取消了确认，后面的页和模型请求都不发", async () => {
  const urls: string[] = [];
  let consent = SETTINGS.DATA_CONSENT_VERSION;
  const getSettings = async () =>
    SETTINGS.normalize({
      presetId: "anthropic",
      aiApiKey: "sk-ant-test",
      aiApiKeyOrigin: "https://api.anthropic.com/",
      aiModel: "claude-sonnet-5-5",
      ...SETTINGS.CONSENTED,
      dataConsentVersion: consent,
    });
  const jsonGet = createJsonGetter(async (url) => {
    urls.push(url);
    consent = 0;
    return MODEL_PAGE(`model-${urls.length}`);
  });
  const storage = memoryStorage();
  const t = TRANSPORT.createAiTransport({
    getSettings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch: async (url) => {
      urls.push(url);
      return anthropicReply("不该发出");
    },
    getModelCapabilities: createCapabilityResolver({
      storage,
      send: createConsentGuardedGetter({ getSettings, settingsRules: SETTINGS.settingsRules, send: jsonGet }),
    }),
  });

  const error = await failureOf(t.requestAiCompletion({ feature: "explain", messages: MESSAGES, maxTokens: 100 }));
  const result = TRANSPORT.aiErrorResponse(error);
  assert.equal(result.success, false);
  assert.equal(result.error, "NO_AI_CONFIG");
  assert.deepEqual(urls, ["https://api.anthropic.com/v1/models?limit=1000"]);
  assert.equal(Object.hasOwn(storage.data, CAPABILITY_STORAGE_KEY), false, "取消确认不算服务出错，不记一次失败");
});

test("有正文但被截断时，放大预算要一次完整的", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return requests.length === 1 ? openaiThinkingTruncated('{"chapters": [') : openaiReply('{"chapters": []}');
  });

  const { text } = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(text, '{"chapters": []}');
  assert.deepEqual(requests.map((request) => request.max_tokens), [100, 400]);
});

test("截断的正文轮次用完后交出已有部分，由调用方补齐", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return openaiThinkingTruncated("部分正文");
  });

  const { text, truncated } = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(text, "部分正文");
  assert.equal(truncated, true);
  assert.equal(requests.length, 3);
});

test("新型号拒绝 thinking 和 temperature 时逐个放宽重发，不占自愈轮次", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      const parsed = bodyOf(init);
      requests.push(parsed);
      if (parsed.thinking?.type === "disabled") {
        return anthropicError(400, '"thinking.type.disabled" is not supported for this model.');
      }
      if ("temperature" in parsed) {
        return anthropicError(400, "`temperature` is deprecated for this model.");
      }
      return anthropicReply("可用");
    },
    {
      // 官方地址不发 temperature；兼容地址才会两样都被拒。
      getSettings: async () => gatewaySettings(),
    },
  );

  const { text } = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, temperature: 0.2 });
  assert.equal(text, "可用");
  assert.equal(requests.length, 3);
  assert.equal("thinking" in requests[2]!, false);
  assert.equal("temperature" in requests[2]!, false);
});

test("只带 retrySignal：在途时停止，回来的是参数被拒，不再放宽重发", async () => {
  const controller = new AbortController();
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      controller.abort();
      return anthropicError(400, '"thinking.type.disabled" is not supported for this model.');
    },
    { getSettings: async () => gatewaySettings() },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, retrySignal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(requests.length, 1, "停止之后不再发放宽后的计费请求");
});

test("只带 retrySignal：加码那一轮在途时停止、又碰上参数被拒，交回上一轮付过费的截断正文", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const t = makeTransport(
    async () => {
      fetches += 1;
      if (fetches === 1) return anthropicTruncated("只写了一半");
      controller.abort();
      return anthropicError(400, '"thinking.type.disabled" is not supported for this model.');
    },
    { getSettings: async () => gatewaySettings() },
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, retrySignal: controller.signal });
  assert.equal(fetches, 2, "停止之后不再发放宽后的计费请求");
  assert.equal(result.truncated, true);
  assert.equal(result.text, "只写了一半");
});

test("只带 retrySignal：查模型能力的工夫停止了，首发也不再发出", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const t = makeTransport(
    async () => {
      fetches += 1;
      return openaiReply("不该发出");
    },
    {
      getModelCapabilities: async () => {
        controller.abort();
        return null;
      },
    },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, retrySignal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(fetches, 0);
});

test("只带 retrySignal：重发前读同意状态的工夫停止了，不再重发", async () => {
  const controller = new AbortController();
  let fetches = 0;
  let settingsReads = 0;
  const t = makeTransport(
    async () => {
      fetches += 1;
      return { ok: false, status: 503, text: async () => "" };
    },
    {
      getSettings: async () => {
        settingsReads += 1;
        // 第 1 次是开头读配置，第 2 次是首发前的同意核对，第 3 次是重发前的同意核对。
        if (settingsReads === 3) controller.abort();
        return makeSettings();
      },
    },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, retrySignal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(fetches, 1);
});

test("限流重发过一次还是失败：错误标 noAutoRetry，错误回执也带上，上层不再补发", async () => {
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    return limitedWithRetryAfter("1");
  });
  const error = await failureOf(t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(fetches, 2);
  assert.equal(error.noAutoRetry, true);
  const response = TRANSPORT.aiErrorResponse(error);
  assert.equal(response.error, "RATE_LIMITED");
  assert.equal(response.noAutoRetry, true);
});

test("额度用完这类传输层特意不重发的 429，错误回执带 noAutoRetry", async () => {
  const t = makeTransport(async () => ({
    ok: false,
    status: 429,
    text: json({ error: { message: "You exceeded your current quota, please check your plan and billing details." } }),
  }));
  const error = await failureOf(t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(TRANSPORT.aiErrorResponse(error).noAutoRetry, true);
});

test("这次调用自己重发过（脱掉 JSON 模式）后又失败：错误标 noAutoRetry，上层不再补发", async () => {
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    if (fetches === 1) return openaiReply("");
    return { ok: false, status: 500, text: async () => "" };
  });
  const error = await failureOf(
    t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, responseFormat: { type: "json_object" } }),
  );
  assert.equal(fetches, 2);
  assert.equal(error.noAutoRetry, true);
  assert.equal(TRANSPORT.aiErrorResponse(error).noAutoRetry, true);
});

test("只发过一次就失败的偶发错误不标 noAutoRetry，上层照常可以补一次", async () => {
  const t = makeTransport(async () => ({ ok: false, status: 500, text: async () => "" }));
  const error = await failureOf(t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.notEqual(error.noAutoRetry, true);
});

test("拒答一律标 noAutoRetry：换个时间再问也一样，上层不补发", async () => {
  const t = makeTransport(
    async () => ({
      ok: true,
      status: 200,
      text: json({ content: [{ type: "text", text: "" }], stop_reason: "refusal" }),
    }),
    { getSettings: async () => gatewaySettings() },
  );
  const error = await failureOf(t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(error.noAutoRetry, true);
});

test("结果带上这次调用实际发了几次，上层解析失败时据此判断还能不能补", async () => {
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    return fetches === 1 ? openaiReply("") : openaiReply("不是 JSON");
  });
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, responseFormat: { type: "json_object" } });
  assert.equal(result.sends, 2);
});

test("selfRetry: false（上层补轮里那一次）：限流不再等着重发，空响应也不加码，只发一次", async () => {
  for (const reply of [() => limitedWithRetryAfter("1"), () => openaiReply("")]) {
    let fetches = 0;
    const t = makeTransport(async () => {
      fetches += 1;
      return reply();
    });
    await t
      .requestAiCompletion({ messages: MESSAGES, maxTokens: 100, responseFormat: { type: "json_object" }, selfRetry: false })
      .catch(() => {});
    assert.equal(fetches, 1);
  }
});

test("selfRetry: false：撑满预算的空响应和截断正文都不加码，只发一次", async () => {
  for (const reply of [() => openaiReply("", { finish_reason: "length" }), () => openaiThinkingTruncated("只写了一半")]) {
    let fetches = 0;
    const t = makeTransport(async () => {
      fetches += 1;
      return reply();
    });
    await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, selfRetry: false }).catch(() => {});
    assert.equal(fetches, 1);
  }
});

test("业务请求经共用的 sendChatWithRelax 发出，和设置页的测试连接是同一份放宽逻辑", async () => {
  // 放宽记忆只有 sendChatWithRelax 读写：发之前等它就绪、取代数、取放宽项，成功后记下。
  const used: string[] = [];
  const inner = PROVIDER.createRelaxMemory();
  const memory: PROVIDER.RelaxMemory = {
    ready: async () => {
      used.push("ready");
    },
    epoch: () => {
      used.push("epoch");
      return undefined;
    },
    recall: (settings) => {
      used.push("recall");
      return inner.recall(settings);
    },
    remember: (settings, relax, options) => {
      used.push("remember");
      return inner.remember(settings, relax, options);
    },
  };
  const requests: ChatRequestBody[] = [];
  const transport = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return openaiReply("模型的话");
    },
    { relaxMemory: memory },
  );
  const { text } = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 512 });
  assert.equal(text, "模型的话");
  assert.deepEqual(used, ["ready", "epoch", "recall", "remember"]);
  assert.deepEqual(requests.map((request) => request.max_tokens), [512]);
});

test("放宽过的参数再被拒绝时，原样报错，不无限重发", async () => {
  let calls = 0;
  const t = makeTransport(
    async () => {
      calls += 1;
      return anthropicError(400, "`temperature` is deprecated for this model.");
    },
    { getSettings: async () => anthropicSettingsFor("claude-test") },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, temperature: 0.2 }),
    (error: TransportError) => error.status === 400,
  );
  assert.equal(calls, 2);
});

// ============================================================
// 参数放宽：认出官方报错原文，并记住放宽结果
// ============================================================

test("型号名认不出时，按 Sonnet 5.5 报错原文点名的 between_tools 重发", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(rejectDisabledThinking(requests, SONNET_55_DISABLED_REJECTED), {
    getSettings: async () => anthropicSettingsFor("gateway-sonnet-latest"),
  });

  const { text } = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(text, "可用");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.thinking, { type: "between_tools" });
  assert.deepEqual(requests[1]!.output_config, { effort: "low" });
});

test("放宽成功后记住，同一组设置的下一个请求直接按放宽后的参数发", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(rejectDisabledThinking(requests, ALWAYS_ON_DISABLED_REJECTED), {
    getSettings: async () => anthropicSettingsFor("claude-next-unknown"),
  });

  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(requests.length, 2, "第一次要挨一次 400");

  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(requests.length, 3, "第二次一发就成");
  assert.equal("thinking" in requests[2]!, false);
});

test("换了模型或 API 地址，放宽记忆不沿用", async () => {
  const requests: ChatRequestBody[] = [];
  let settings = anthropicSettingsFor("claude-next-unknown");
  const t = makeTransport(rejectDisabledThinking(requests, ALWAYS_ON_DISABLED_REJECTED), {
    getSettings: async () => settings,
  });
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });

  settings = anthropicSettingsFor("claude-another-unknown");
  requests.length = 0;
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" }, "换模型后从头判断");

  settings = anthropicSettingsFor("claude-next-unknown", {
    presetId: "custom",
    aiBaseUrl: "https://gateway.example.com",
  });
  requests.length = 0;
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" }, "换地址后从头判断");
});

test("放宽后的请求没成功就不记，避免一次偶然的错误永久降低能力", async () => {
  const requests: ChatRequestBody[] = [];
  let limited = true;
  const t = makeTransport(
    rejectDisabledThinking(requests, ALWAYS_ON_DISABLED_REJECTED, () =>
      limited
        ? { ok: false, status: 429, text: json({ error: { message: "rate limited" } }) }
        : anthropicReply("可用"),
    ),
    { getSettings: async () => anthropicSettingsFor("claude-next-unknown") },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.status === 429,
  );

  limited = false;
  requests.length = 0;
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.deepEqual(requests[0]!.thinking, { type: "disabled" }, "上次放宽没成功，这次照常先发 disabled");
});

// ============================================================
// 截断正文：重试失败不丢已有结果，重试有条件、有上限
// ============================================================

test("加大预算的重试返回 400 时，交回已有的截断正文并标明截断", async () => {
  const requests: ChatRequestBody[] = [];
  // 模拟服务商拒绝过大的 max_tokens；文字是测试自拟的，不是哪家的原文。
  const t = makeTransport(
    truncatedThen(requests, () => anthropicError(400, "（模拟）max_tokens 超过了这个模型的输出上限")),
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.text, '{"chapters": [');
  assert.equal(result.truncated, true);
  assert.deepEqual(requests.map((request) => request.max_tokens), [100, 400]);
});

test("加大预算的重试被限流时，同样交回已有的截断正文", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    truncatedThen(requests, () => ({
      ok: false,
      status: 429,
      text: json({ type: "error", error: { type: "rate_limit_error", message: "（模拟）限流" } }),
    })),
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.text, '{"chapters": [');
  assert.equal(result.truncated, true);
  assert.equal(requests.length, 2);
});

test("加大预算的重试连不上时，同样交回已有的截断正文", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    truncatedThen(requests, () => {
      throw new TypeError("Failed to fetch");
    }),
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.text, '{"chapters": [');
  assert.equal(result.truncated, true);
});

test("加大预算的重试被取消时报取消，不交回截断正文", async () => {
  const controller = new AbortController();
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    truncatedThen(requests, ({ signal }) => {
      controller.abort();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }),
    CLAUDE_46,
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, signal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(requests.length, 2);
});

test("重试只换来空响应时，交回先前的截断正文，不报空响应", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    truncatedThen(requests, () => ({
      ok: true,
      status: 200,
      text: json({ content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "max_tokens" }),
    })),
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.text, '{"chapters": [');
  assert.equal(result.truncated, true);
  assert.equal(requests.length, 3);
});

test("重试拿到更短的截断正文时，交回最长的那一份", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return anthropicTruncated(requests.length === 1 ? '{"chapters": [{"title": "开场"}' : '{"chap');
    },
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.text, '{"chapters": [{"title": "开场"}');
  assert.equal(result.truncated, true);
});

test("OpenAI 兼容服务的截断正文看不到思考时不重试，直接交回", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return openaiReply("部分正文", { finish_reason: "length" });
  });

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 2048 });
  assert.equal(requests.length, 1, "重发是一次新的完整请求，没把握补全就不花这份钱");
  assert.equal(result.text, "部分正文");
  assert.equal(result.truncated, true);
});

test("OpenAI 兼容服务报告了思考 token 时，截断正文照样加码重试", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    if (requests.length > 1) return openaiReply("完整正文");
    return {
      ok: true,
      status: 200,
      text: json({
        choices: [{ message: { content: "部分正文" }, finish_reason: "length" }],
        usage: { completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 1900 } },
      }),
    };
  });

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 2048 });
  assert.equal(result.text, "完整正文");
  assert.equal(result.truncated, undefined);
  assert.deepEqual(requests.map((request) => request.max_tokens), [2048, 8192]);
});

test("各轮预算合计有上限：额度不够再放大一轮时就不再重发", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return anthropicTruncated("部分正文");
    },
    CLAUDE_46,
  );

  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 8000 });
  const budgets = requests.map((request) => request.max_tokens ?? 0);
  assert.deepEqual(budgets, [8000, 32000], "第三轮只剩 25,536 的额度，比上一轮还小，不值得再发");
  assert.ok(budgets.reduce((sum, value) => sum + value, 0) <= TRANSPORT.TOTAL_OUTPUT_TOKENS_CAP);
  assert.equal(result.truncated, true);
});

// ============================================================
// 截断 body 自愈
// ============================================================

test("body 被掐断在字符串中间时补齐解析，保住已到达的内容", async () => {
  const t = makeTransport(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"choices": [{"message": {"content": "模型说到一半就被掐',
  }));
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal(result.text, "模型说到一半就被掐");
});

test("body 掐在嵌套结构中间时同样补齐", async () => {
  const t = makeTransport(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"choices": [{"message": {"content": "[0:02] 引用", "role": "assist',
  }));
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal(result.text, "[0:02] 引用");
});

test("完全修不动的 body 报 AI_RESPONSE_TRUNCATED 而不是生硬的 V8 错误", async () => {
  const t = makeTransport(async () => ({
    ok: true,
    status: 200,
    text: async () => "这不是 JSON 也不是截断的 JSON",
  }));
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    { code: "AI_RESPONSE_TRUNCATED" },
  );
});

test("repairTruncatedJson 直接导出且行为正确", () => {
  assert.equal(
    TRANSPORT.repairTruncatedJson('{"a": "x\\'),
    '{"a": "x"}',
    "孤立反斜杠不转义补上的引号",
  );
  assert.equal(
    TRANSPORT.repairTruncatedJson('{"a": [1, {"b": "c"'),
    '{"a": [1, {"b": "c"}]}',
  );
});

test("Opus 5.5 思考占满预算时，报错提示另选型号或把概览分小，不建议换非推理模型", async () => {
  const t = makeTransport(
    async () => ({
      ok: true,
      status: 200,
      text: json({ content: [{ type: "thinking", thinking: "想了很久" }], stop_reason: "max_tokens" }),
    }),
    { getSettings: async () => anthropicSettingsFor("claude-opus-5-5") },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) =>
      error.code === "EMPTY_AI_RESPONSE" &&
      error.reason === "TRUNCATED" &&
      /按功能选模型/.test(error.message) &&
      !/输出上限|effort/.test(error.message) &&
      !/非推理模型/.test(error.message),
  );
});

test("预算已到天花板就不再加码，两轮后放弃", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return openaiReply("", { finish_reason: "length" });
  });

  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: TRANSPORT.OUTPUT_TOKENS_CEILING - 1000,
      }),
    (error: TransportError) => error.reason === "TRUNCATED",
  );

  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [TRANSPORT.OUTPUT_TOKENS_CEILING - 1000, TRANSPORT.OUTPUT_TOKENS_CEILING],
  );
});

// ============================================================
// 超时、取消与响应大小（直接驱动 sendAiRequest）
// ============================================================

test("硬超时：模型迟迟不吐响应头，到上限就中止，提示指向概览分块", async () => {
  const t = makeTransport(makeHangingFetch(), { timeoutMs: 50 });
  await assert.rejects(
    () => t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST),
    (error: TransportError) => {
      assert.equal(error.code, "AI_HARD_TIMEOUT");
      assert.match(error.message, /概览分块/);
      assert.doesNotMatch(error.message, /调高超时|降低并发/, "这两项已经不是设置了");
      return true;
    },
  );
});

test("硬超时默认固定 120 秒", async () => {
  const timers: (number | undefined)[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const recordingSetTimeout = (callback: () => void, ms?: number) => {
    timers.push(ms);
    return realSetTimeout(callback, 0);
  };
  globalThis.setTimeout = recordingSetTimeout as typeof setTimeout;
  try {
    const t = makeTransport(makeHangingFetch());
    await assert.rejects(
      () => t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST),
      (error: TransportError) => error.code === "AI_HARD_TIMEOUT" && /120 秒/.test(error.message),
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(timers.includes(120_000), `起过的计时器：${timers.join(", ")}`);
});

test("空闲超时：响应头到了但 body 断流，单独判罚", async () => {
  // 响应头立刻到达；body 的 read 在 abort 前永远挂起（与真实 fetch 一致，
  // abort 会让未决的 read 以拒绝收场）。
  const stalled: AiFetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: () =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
          cancel: async () => {},
        };
      },
    },
    text: () => new Promise(() => {}),
  });
  const t = makeTransport(stalled);

  await assert.rejects(
    () => t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST),
    { code: "AI_IDLE_TIMEOUT" },
  );
});

test("外部取消优先于一切超时，报 TASK_CANCELED", async () => {
  const controller = new AbortController();
  const t = makeTransport(makeHangingFetch());
  const pending = t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, { code: "TASK_CANCELED" });
});

test("流式读取超过大小上限时中止并报错", async () => {
  const encoder = new TextEncoder();
  const chunk = encoder.encode("0123456789");
  const big: TransportResponse = {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let reads = 0;
        return {
          async read() {
            reads += 1;
            return reads > 5 ? { done: true } : { done: false, value: chunk };
          },
          cancel: async () => {},
        };
      },
    },
    text: async () => "",
  };
  const t = makeTransport(async () => big, { maxResponseBytes: 32 });

  await assert.rejects(
    () => t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST),
    { code: "AI_RESPONSE_TOO_LARGE" },
  );
});

// ============================================================
// 错误翻译
// ============================================================

test("网络层 TypeError 翻译成带下一步指引的提示", async () => {
  const t = makeTransport(async () => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(
    () => t.sendAiRequest({ aiBaseUrl: "https://api.example.com" }, SEND_REQUEST),
    { code: "AI_NETWORK_ERROR" },
  );
});

test("Anthropic 密钥没限定工作区的 400 翻成中文，指向设置页换一把密钥", () => {
  // 官方文档里的原文。
  const body = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.",
    },
  };
  const error = PROVIDER.keyedHttpError(body, 400, { aiApiKey: "sk-ant-x" });
  assert.equal(error.code, "ANTHROPIC_WORKSPACE_REQUIRED");
  assert.equal(error.status, 400);
  assert.match(error.message, /没有限定工作区/);
  const response = TRANSPORT.aiErrorResponse(error);
  assert.equal(response.error, "ANTHROPIC_WORKSPACE_REQUIRED");
  assert.equal(response.message, error.message);

  // 别的 400 原样保留，参数放宽还要靠原文认出是哪一项。
  const other = PROVIDER.keyedHttpError({ error: { message: "temperature is not supported" } }, 400, {});
  assert.equal(other.code, undefined);
  assert.equal(other.message, "temperature is not supported");
});

test("HTTP 状态映射成用户能行动的错误码", () => {
  const aiError = (props: { readonly status?: number; readonly baseUrl?: string }) =>
    TRANSPORT.aiErrorResponse(Object.assign(new Error("x"), props));

  assert.equal(aiError({ status: 401 }).error, "INVALID_AI_KEY");
  assert.equal(aiError({ status: 403 }).error, "INVALID_AI_KEY");
  assert.equal(aiError({ status: 404 }).error, "MODEL_OR_ENDPOINT_NOT_FOUND");
  assert.equal(aiError({ status: 429 }).error, "RATE_LIMITED");
  assert.equal(aiError({}).error, "AI_REQUEST_FAILED");
});

test("纯文本报错回显密钥时先脱敏再截断，密钥跨过截断线也不漏", async () => {
  const failure = await sendOnce({
    ok: false,
    status: 400,
    text: async () => `${"错".repeat(190)}sk-secret-123456 无效`,
  });
  assert.equal(failure.status, 400);
  assert.ok(!failure.message.includes("sk-secret"), failure.message);
});

test("错误响应不是 JSON 时照样保留状态码：纯文本 429 认得出限流，401 认得出密钥被拒", async () => {
  const limited = await sendOnce(new Response("Too Many Requests", { status: 429 }));
  assert.equal(limited.status, 429);
  assert.equal(TRANSPORT.aiErrorResponse(limited).error, "RATE_LIMITED");

  const unauthorized = await sendOnce(new Response("Unauthorized", { status: 401 }));
  assert.equal(unauthorized.status, 401);
  assert.equal(TRANSPORT.aiErrorResponse(unauthorized).error, "INVALID_AI_KEY");
});

test("HTML 的 502 错误页：保留状态码，提示里不出现网页源码", async () => {
  const error = await sendOnce(
    new Response("<html><body><h1>502 Bad Gateway</h1><p>cloudflare</p></body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
  );
  assert.equal(error.status, 502);
  assert.doesNotMatch(error.message, /<html|<body/i);
  const response = TRANSPORT.aiErrorResponse(error);
  assert.equal(response.error, "AI_SERVICE_BUSY");
  assert.match(response.message, /繁忙/);
  assert.match(response.message, /502/);
});

test("空 body 的 503 保留状态码；纯文本错误里的密钥照样打码", async () => {
  const empty = await sendOnce(new Response("", { status: 503 }));
  assert.equal(empty.status, 503);
  assert.equal(TRANSPORT.aiErrorResponse(empty).error, "AI_SERVICE_BUSY");

  const echoed = await sendOnce(new Response("bad key sk-secret-123456", { status: 400 }));
  assert.equal(echoed.status, 400);
  assert.doesNotMatch(echoed.message, /sk-secret-123456/);
});

test("5xx 和 529 翻成中文的「服务繁忙」，不显示英文原文", () => {
  for (const status of [500, 502, 503, 504, 529]) {
    const response = TRANSPORT.aiErrorResponse(Object.assign(new Error("Overloaded"), { status }));
    assert.equal(response.error, "AI_SERVICE_BUSY", `HTTP ${status}`);
    assert.doesNotMatch(response.message, /Overloaded/);
    assert.match(response.message, new RegExp(String(status)));
  }
});

test("5xx 带着可读的说明（中转站模型名配错）：附在中文提示后面，截断并去掉密钥", async () => {
  const relay = await sendOnce(
    new Response(
      JSON.stringify({
        error: {
          message: "当前分组 default 下对于模型 gpt-x 无可用渠道（sk-secret-123456）",
          code: "model_not_found",
        },
      }),
      { status: 503 },
    ),
  );
  const response = TRANSPORT.aiErrorResponse(relay);
  assert.match(response.message, /HTTP 503/);
  assert.match(response.message, /无可用渠道/);
  assert.doesNotMatch(response.message, /稍后再试/, "不是等一等就会好的问题");
  assert.doesNotMatch(response.message, /sk-secret-123456/);

  const long = TRANSPORT.aiErrorResponse(
    Object.assign(new Error(`服务配置有误：${"很长的说明".repeat(100)}`), { status: 500 }),
  );
  assert.match(long.message, /服务配置有误/);
  assert.ok(long.message.length < 300, `说明要截断，实际 ${long.message.length} 字`);

  for (const generic of ["Service Unavailable", "Internal Server Error", "Bad Gateway", "服务返回 502", "upstream connect error", "upstream error"]) {
    const plain = TRANSPORT.aiErrorResponse(Object.assign(new Error(generic), { status: 502 }));
    assert.doesNotMatch(plain.message, new RegExp(generic), "笼统的状态说明照旧不显示");
    assert.match(plain.message, /繁忙/);
  }
});

test("中转站说没有这个模型的 503：不自动重发，标 noAutoRetry，概览补轮也不重发", async () => {
  const server = replay([
    () =>
      new Response(
        JSON.stringify({ error: { message: "当前分组 default 下对于模型 gpt-x 无可用渠道", code: "model_not_found" } }),
        { status: 503 },
      ),
    ok200,
  ]);
  const { waits, sleep } = recordingSleep();
  const t = makeTransport(server.fetch, { sleep });
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.status === 503 && error.noAutoRetry === true,
  );
  assert.equal(server.fetches, 1);
  assert.deepEqual(waits, []);
});

test("200 加截断的 JSON 仍走补齐，修不动仍报 AI_RESPONSE_TRUNCATED", async () => {
  const error = await sendOnce(new Response("这不是 JSON", { status: 200 }));
  assert.equal(error.code, "AI_RESPONSE_TRUNCATED");
});

// ============================================================
// Anthropic：结构化输出与拒绝回答
// ============================================================

test("官方地址的结构化输出：请求带 output_config.format，正文就是合 schema 的 JSON", async () => {
  const requests: { url: string; headers: AiFetchInit["headers"]; body: ChatRequestBody }[] = [];
  const answer = JSON.stringify({ answer: "结论 [0:02]" });
  const t = makeTransport(
    async (url, init) => {
      requests.push({ url, headers: init.headers, body: bodyOf(init) });
      return anthropicMessage(answer);
    },
    { getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6") },
  );

  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 1024,
    temperature: 0.2,
    responseFormat: SCHEMAS.QA_ANSWER,
  });
  assert.equal(result.text, answer);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0]!.headers["anthropic-version"], "2026-10-21");
  assert.deepEqual(requests[0]!.body.output_config, {
    format: { type: "json_schema", schema: SCHEMAS.QA_ANSWER.schema },
  });
  assert.equal("temperature" in requests[0]!.body, false);
});

test("schema 被拒后退回提示词约束重发，成功后记住，下次直接不发 schema", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      const body = bodyOf(init);
      requests.push(body);
      if (body.output_config?.format) return anthropicError(400, "Schema is too complex for compilation.");
      return anthropicMessage('{"quote":"整理好的笔记"}');
    },
    { getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6") },
  );

  const first = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512, responseFormat: SCHEMAS.NOTE_QUOTE });
  assert.equal(first.text, '{"quote":"整理好的笔记"}');
  assert.equal(requests.length, 2);
  assert.equal("output_config" in requests[1]!, false);

  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512, responseFormat: SCHEMAS.NOTE_QUOTE });
  assert.equal(requests.length, 3, "第二次一发就成");
  assert.equal("output_config" in requests[2]!, false);
});

test("模型拒绝回答时报 AI_REFUSED，不重试也不当成空响应", async () => {
  let calls = 0;
  const t = makeTransport(
    async () => {
      calls += 1;
      return anthropicMessage("I can't help with that.", "refusal");
    },
    { getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6") },
  );

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512, responseFormat: { type: "json_object" } }),
    (error: TransportError) => error.code === "AI_REFUSED" && /拒绝/.test(error.message),
  );
  assert.equal(calls, 1);
  assert.deepEqual(TRANSPORT.aiErrorResponse({ code: "AI_REFUSED", message: "模型拒绝了这次请求。" }), {
    success: false,
    error: "AI_REFUSED",
    message: "模型拒绝了这次请求。",
  });
});

// ============================================================
// OpenAI Responses：正常、截断、拒绝、参数被拒
// ============================================================

test("Responses：completed 的正文原样交回，请求发到 /responses 且不在服务端保存", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport("gpt-6-astra", () => RESP.asFetchResponse(RESP.completed('{"answer":"可用"}')), requests);
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1200, responseFormat: SCHEMAS.QA_ANSWER });
  assert.equal(result.text, '{"answer":"可用"}');
  assert.equal(result.truncated, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.openai.com/v1/responses");
  assert.equal(requests[0]!.body.store, false);
  assert.equal(requests[0]!.body.max_output_tokens, 1200);
  assert.equal(requests[0]!.body.text?.format.name, "qa_answer");
});

test("Responses：推理占满预算被截断时加大预算重发，补全后交回完整正文", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport(
    "gpt-6-astra",
    (count) => RESP.asFetchResponse(count === 1 ? RESP.incomplete('{"chapters": [') : RESP.completed('{"chapters": []}')),
    requests,
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 2048 });
  assert.equal(result.text, '{"chapters": []}');
  assert.deepEqual(requests.map((request) => request.body.max_output_tokens), [2048, 8192]);
});

test("Responses：一个字没写就用完预算时同样加码重发", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport(
    "gpt-6.1-sol",
    (count) => RESP.asFetchResponse(count === 1 ? RESP.incomplete() : RESP.completed('{"quote":"好"}')),
    requests,
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512 });
  assert.equal(result.text, '{"quote":"好"}');
  assert.deepEqual(requests.map((request) => request.body.max_output_tokens), [512, 2048]);
});

test("Responses：内容过滤截停时不重发，交回已有正文并标明不完整", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport(
    "gpt-6-astra",
    () => RESP.asFetchResponse(RESP.incomplete('{"answer":"一半', { reason: "content_filter" })),
    requests,
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1024 });
  assert.equal(requests.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.text, '{"answer":"一半');
});

test("Responses：拒绝回答时报 AI_REFUSED 并带上模型的说明，不重发", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport("gpt-6-astra", () => RESP.asFetchResponse(RESP.refusal()), requests);
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1024, responseFormat: { type: "json_object" } }),
    (error: TransportError) => error.code === "AI_REFUSED" && error.message.includes("I'm sorry, I cannot assist with that request."),
  );
  assert.equal(requests.length, 1);
});

test("Responses：推理档位被拒后不发档位重试，成功后记住", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport(
    "gpt-6.1-terra",
    (_count, body) =>
      body.reasoning
        ? RESP.asFetchResponse(
            { error: { message: "Unsupported value: 'none' is not supported with this model.", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" } },
            400,
          )
        : RESP.asFetchResponse(RESP.completed("可用")),
    requests,
  );
  const first = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512 });
  assert.equal(first.text, "可用");
  assert.deepEqual(requests[0]!.body.reasoning, { effort: "none" });
  assert.equal("reasoning" in requests[1]!.body, false);

  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512 });
  assert.equal(requests.length, 3, "第二次一发就成");
  assert.equal("reasoning" in requests[2]!.body, false);
});

test("Responses：JSON 模式返回空时脱掉 text.format 重试一次", async () => {
  const requests: SentRequest[] = [];
  const t = responsesTransport(
    "gpt-4.1",
    (count) => RESP.asFetchResponse(count === 1 ? RESP.completed("") : RESP.completed('{"quote":"好"}')),
    requests,
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 512, responseFormat: { type: "json_object" } });
  assert.equal(result.text, '{"quote":"好"}');
  assert.deepEqual(requests[0]!.body.text, { format: { type: "json_object" } });
  assert.equal("text" in requests[1]!.body, false);
});

// ============================================================
// 按模型能力：单轮预算上限与能力注入
// ============================================================

test("模型的 max_tokens 上限低于请求预算时按上限发，也不再往上加码", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return anthropicTruncated('{"chapters": [');
    },
    {
      getSettings: async () => anthropicSettingsFor("claude-3-haiku-20240307"),
      getModelCapabilities: async () => MODEL_CAPS(),
    },
  );
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 6000 });
  assert.deepEqual(requests.map((body) => body.max_tokens), [4096], "超过上限的请求会被直接拒绝");
  assert.equal(result.truncated, true);
});

test("上限够用时照常按四倍加码，但不超过模型上限", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return requests.length < 3 ? anthropicTruncated('{"chapters": [') : anthropicReply('{"chapters": []}');
    },
    {
      getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6"),
      getModelCapabilities: async () => MODEL_CAPS({ maxTokens: 20000 }),
    },
  );
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 2048 });
  assert.deepEqual(requests.map((body) => body.max_tokens), [2048, 8192, 20000]);
});

test("能力数据直接决定请求参数；查能力出错不挡请求", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return anthropicReply("可用");
    },
    {
      getSettings: async () => anthropicSettingsFor("gateway-sonnet-latest"),
      getModelCapabilities: async () => MODEL_CAPS({ thinking: { disabled: false, betweenTools: true, adaptive: true } }),
    },
  );
  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(requests.length, 1, "能力表说关不掉思考，一发就对");
  assert.deepEqual(requests[0]!.thinking, { type: "between_tools" });

  const failing = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return anthropicReply("可用");
    },
    {
      getSettings: async () => anthropicSettingsFor("claude-sonnet-4-6"),
      getModelCapabilities: async () => {
        throw new Error("No SW");
      },
    },
  );
  const { text } = await failing.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(text, "可用");
  assert.deepEqual(requests.at(-1)?.thinking, { type: "disabled" }, "退回按型号名判断");
});

// ============================================================
// 限流、过载：不计费的失败只自动重发一次
// ============================================================

test("529 过载后等几秒重发一次，第二次成功就交回结果，并告诉调用方在等", async () => {
  const server = replay([overloaded, ok200]);
  const { waits, sleep } = recordingSleep();
  const notices: RetryNotice[] = [];
  const t = makeTransport(server.fetch, { sleep });

  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
    onRetry: (notice) => notices.push(notice),
  });

  assert.equal(result.text, "恢复了");
  assert.equal(server.fetches, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 2000 && waits[0]! <= 5000, `没有 Retry-After 时等 2 到 5 秒，实际 ${waits[0]}`);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.status, 529);
  assert.match(notices[0]!.message, /繁忙，\d+ 秒后重试/);
});

test("429 带 Retry-After 时按它等；第二次还是限流就报 RATE_LIMITED，不再重发", async () => {
  const limited = () =>
    new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "retry-after": "3" },
    });
  const server = replay([limited]);
  const { waits, sleep } = recordingSleep();
  const notices: RetryNotice[] = [];
  const t = makeTransport(server.fetch, { sleep });

  const error = await failureOf(
    t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, onRetry: (notice) => notices.push(notice) }),
  );

  assert.equal(server.fetches, 2, "只自动重发一次");
  assert.deepEqual(waits, [3000]);
  assert.match(notices[0]!.message, /限流，3 秒后重试/);
  assert.equal(TRANSPORT.aiErrorResponse(error).error, "RATE_LIMITED");
});

test("Retry-After 是 HTTP 日期时换算成等待时长", async () => {
  const at = new Date(Date.now() + 4000).toUTCString();
  const server = replay([
    () => new Response("", { status: 503, headers: { "retry-after": at } }),
    ok200,
  ]);
  const { waits, sleep } = recordingSleep();
  const t = makeTransport(server.fetch, { sleep });

  await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(server.fetches, 2);
  assert.ok(waits[0]! > 1000 && waits[0]! <= 4000, `实际 ${waits[0]}`);
});

test("Retry-After 超过 20 秒不自动等，直接报限流", async () => {
  const server = replay([
    () => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "60" } }),
    ok200,
  ]);
  const { waits, sleep } = recordingSleep();
  const t = makeTransport(server.fetch, { sleep });

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    // 标上 noAutoRetry：概览的自动补轮也不替它重发。
    (error: TransportError) => error.status === 429 && error.noAutoRetry === true,
  );
  assert.equal(server.fetches, 1);
  assert.deepEqual(waits, []);
});

test("额度用完的 429 不重发：等多久都不会恢复", async () => {
  const server = replay([
    () =>
      new Response(
        JSON.stringify({
          error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" },
        }),
        { status: 429 },
      ),
    ok200,
  ]);
  const t = makeTransport(server.fetch);
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    (error: TransportError) => error.quotaExhausted === true && error.noAutoRetry === true,
  );
  assert.equal(server.fetches, 1);
});

test("503 连续两次：重发一次后报 AI_SERVICE_BUSY", async () => {
  const server = replay([() => new Response("Service Unavailable", { status: 503 })]);
  const t = makeTransport(server.fetch);
  const error = await failureOf(t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }));
  assert.equal(server.fetches, 2);
  assert.equal(TRANSPORT.aiErrorResponse(error).error, "AI_SERVICE_BUSY");
  assert.equal(error.noAutoRetry, true, "这次调用已经重发过一次，概览和翻译的补轮不再补发，同一批不会被发四次");
});

test("说不准有没有计费的 500、502、504 和 4xx 都不自动重发", async () => {
  for (const status of [500, 502, 504, 400, 401, 404]) {
    const server = replay([() => new Response("nope", { status }), ok200]);
    const t = makeTransport(server.fetch);
    await assert.rejects(
      () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
      (error: TransportError) => error.status === status,
    );
    assert.equal(server.fetches, 1, `HTTP ${status} 不重发`);
  }
});

test("限流重发不占自愈轮次：重发之后三轮加码照常走完", async () => {
  const requests: ChatRequestBody[] = [];
  const { waits, sleep } = recordingSleep();
  const t = makeTransport(
    async (_url, init) => {
      requests.push(bodyOf(init));
      return requests.length === 1 ? limitedWithRetryAfter("1") : openaiReply("", { finish_reason: "length" });
    },
    { sleep },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    { code: "EMPTY_AI_RESPONSE" },
  );
  assert.equal(waits.length, 1);
  assert.deepEqual(requests.map((request) => request.max_tokens), [100, 100, 400, 1600]);
});

test("任务取消之后，在途那次回来的截断正文不再加码重发", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    controller.abort();
    return openaiThinkingTruncated("只写了一半");
  });
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, signal: controller.signal }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(fetches, 1);
});

test("等待重发期间取消：立刻报 TASK_CANCELED，不再发请求", async () => {
  const server = replay([
    () => new Response("", { status: 429, headers: { "retry-after": "20" } }),
    ok200,
  ]);
  const controller = new AbortController();
  // 用真的等待：20 秒的计时器要被取消信号打断。
  const t = makeTransport(server.fetch, { sleep: undefined });
  const started = Date.now();
  const pending = t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
    signal: controller.signal,
    onRetry: () => controller.abort(),
  });
  await assert.rejects(() => pending, { code: "TASK_CANCELED" });
  assert.ok(Date.now() - started < 5000, "不必等满 20 秒");
  assert.equal(server.fetches, 1);
});

test("只带 retrySignal（粗筛写结论的排队信号）：等待重发期间中止，立刻报取消，不再发请求", async () => {
  const server = replay([
    () => new Response("", { status: 429, headers: { "retry-after": "20" } }),
    ok200,
  ]);
  const controller = new AbortController();
  const t = makeTransport(server.fetch, { sleep: undefined });
  const started = Date.now();
  const pending = t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
    retrySignal: controller.signal,
    onRetry: () => controller.abort(),
  });
  await assert.rejects(() => pending, { code: "TASK_CANCELED" });
  assert.ok(Date.now() - started < 5000, "不必等满 20 秒");
  assert.equal(server.fetches, 1, "停止之后不再重发、不再计费");
});

test("signal 和 retrySignal 都带：等待重发时任一个中止，等待都跟着中止", async () => {
  for (const which of ["signal", "retrySignal"] as const) {
    const server = replay([
      () => new Response("", { status: 429, headers: { "retry-after": "20" } }),
      ok200,
    ]);
    const controllers = { signal: new AbortController(), retrySignal: new AbortController() };
    let interrupted = false;
    const t = makeTransport(server.fetch, {
      sleep: async (_ms, signal) => {
        controllers[which].abort();
        interrupted = signal?.aborted === true;
        if (interrupted) throw TRANSPORT.taskCanceledError();
      },
    });

    await assert.rejects(
      () =>
        t.requestAiCompletion({
          messages: MESSAGES,
          maxTokens: 100,
          signal: controllers.signal.signal,
          retrySignal: controllers.retrySignal.signal,
        }),
      { code: "TASK_CANCELED" },
    );
    assert.equal(interrupted, true, which);
    assert.equal(server.fetches, 1, which);
  }
});

test("只带 retrySignal：在途时停止，回来的是截断正文也不再加码重发，交回已有部分", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    controller.abort();
    return openaiThinkingTruncated("只写了一半");
  });
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
    retrySignal: controller.signal,
  });
  assert.equal(fetches, 1, "停止之后不再发新的计费请求");
  assert.equal(result.truncated, true);
  assert.equal(result.text, "只写了一半");
});

test("只带 retrySignal：在途时停止，回来的是 JSON 模式空响应，不再脱掉格式重发", async () => {
  const controller = new AbortController();
  let fetches = 0;
  const t = makeTransport(async () => {
    fetches += 1;
    controller.abort();
    return openaiReply("");
  });
  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: 100,
        responseFormat: { type: "json_object" },
        retrySignal: controller.signal,
      }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(fetches, 1);
});

test("retrySignal 不中止已经发出的请求：在途时中止，照常等它回来", async () => {
  const controller = new AbortController();
  let fetchSignal: AbortSignal | null = null;
  const t = makeTransport(async (_url, init) => {
    fetchSignal = init.signal;
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    return openaiReply("回来了");
  });
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 100,
    retrySignal: controller.signal,
  });
  assert.equal(result.text, "回来了");
  assert.equal((fetchSignal as AbortSignal | null)?.aborted, false);
});

test("硬超时和空闲超时不自动重发：服务端可能已经在生成、已经计费", async () => {
  let fetches = 0;
  const hanging = makeHangingFetch();
  const t = makeTransport(
    (...args) => {
      fetches += 1;
      return hanging(...args);
    },
    { timeoutMs: 30 },
  );
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }),
    { code: "AI_HARD_TIMEOUT" },
  );
  assert.equal(fetches, 1);
});

test("截断正文已经到手时，加码重试遇到过载直接交回截断正文，不再等", async () => {
  const requests: ChatRequestBody[] = [];
  const { waits, sleep } = recordingSleep();
  const t = makeTransport(truncatedThen(requests, overloaded), { ...CLAUDE_46, sleep });
  const result = await t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(result.truncated, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, []);
});

test("stillWanted 回 false：传输层准备完、真正发出之前拦下，不发请求", async () => {
  const requests: ChatRequestBody[] = [];
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    return openaiReply("{}");
  });
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, stillWanted: () => false }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(requests.length, 0);
});

test("stillWanted 在首发之后变成 false：限流后的重发不再发出", async () => {
  const requests: ChatRequestBody[] = [];
  let wanted = true;
  const t = makeTransport(async (_url, init) => {
    requests.push(bodyOf(init));
    wanted = false;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      text: json({ error: { message: "rate limited" } }),
    };
  });
  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, stillWanted: () => wanted }),
    { code: "TASK_CANCELED" },
  );
  assert.equal(requests.length, 1, "清除之后不再重发");
});

// ============================================================
// 信封被截断：补齐过的信封按截断交回
// ============================================================

const SETTINGS_OPENAI = SETTINGS.normalize({
  presetId: SETTINGS.CUSTOM_PRESET_ID,
  protocol: PROTOCOLS.OPENAI,
  aiBaseUrl: "https://ai.example.com/v1",
  aiApiKey: "offline-dummy-key",
  ...SETTINGS.CONSENTED,
  aiModel: "offline-model",
});

// 完整的信封切在 marker 之前：内层正文和外层的 finish_reason 一起丢了。
function cutEnvelope(envelope: unknown, marker: string): string {
  const full = JSON.stringify(envelope);
  const raw = full.slice(0, full.indexOf(marker));
  assert.throws(() => JSON.parse(raw), SyntaxError, "切出来的信封本身应当不是合法 JSON");
  return raw;
}

function transportServing(settings: AiSettings, bodies: readonly string[]) {
  let calls = 0;
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => settings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch: async () => {
      const body = bodies[Math.min(calls, bodies.length - 1)];
      calls += 1;
      return new Response(body, { status: 200 });
    },
  });
  return { transport, calls: () => calls };
}

const ANSWER = JSON.stringify({ answer: "[0:00] 前半句已经到达，后半句尚未到达" });
const CHAT_ENVELOPE = { choices: [{ message: { content: ANSWER }, finish_reason: "stop" }] };

test("Chat Completions 的信封被截断、补齐后解析：带上 truncated，不为它重发", async () => {
  const { transport, calls } = transportServing(SETTINGS_OPENAI, [cutEnvelope(CHAT_ENVELOPE, "后半句")]);
  const result = await transport.requestAiCompletion({
    messages: [{ role: "user", content: "离线测试" }],
    maxTokens: 256,
  });
  assert.equal(result.truncated, true);
  assert.match(result.text, /前半句已经到达/);
  assert.equal(calls(), 1, "断掉的连接加大预算也补不回来，不该再付一次费");
});

test("Anthropic 的信封被截断时同样标成截断", async () => {
  const settings = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://claude.example.com",
    aiApiKey: "offline-dummy-key",
    ...SETTINGS.CONSENTED,
    aiModel: "claude-offline",
  });
  const envelope = { content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn" };
  const { transport, calls } = transportServing(settings, [cutEnvelope(envelope, "后半句")]);
  const result = await transport.requestAiCompletion({
    messages: [{ role: "user", content: "离线测试" }],
    maxTokens: 256,
  });
  assert.equal(result.truncated, true);
  assert.equal(calls(), 1);
});

test("完整的信封不带 truncated", async () => {
  const { transport } = transportServing(SETTINGS_OPENAI, [JSON.stringify(CHAT_ENVELOPE)]);
  const result = await transport.requestAiCompletion({
    messages: [{ role: "user", content: "离线测试" }],
    maxTokens: 256,
  });
  assert.equal("truncated" in result, false);
});

// ============================================================
// 按功能换模型
// ============================================================

const chatReply = (content: string): TransportResponse => ({
  ok: true,
  status: 200,
  text: json({ choices: [{ message: { content } }] }),
});

function customSettings(overrides: SETTINGS.SettingsInput = {}) {
  return SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.OPENAI,
    aiBaseUrl: "https://api.example.com/v1",
    aiApiKey: "test-key",
    ...SETTINGS.CONSENTED,
    aiModel: "m-default",
    ...overrides,
  });
}

function recordingTransport(settings: AiSettings, extra: Overrides = {}) {
  const bodies: ChatRequestBody[] = [];
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => settings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch: async (_url, init) => {
      bodies.push(bodyOf(init));
      return chatReply("好");
    },
    ...extra,
  });
  return { transport, bodies };
}

test("requestAiCompletion 按 feature 发实际模型，返回的设置也是实际模型", async () => {
  const { transport, bodies } = recordingTransport(customSettings({ featureModels: { verdict: "m-fast" } }));
  const fast = await transport.requestAiCompletion({ feature: "verdict", messages: MESSAGES, maxTokens: 64 });
  const strong = await transport.requestAiCompletion({ feature: "analysis", messages: MESSAGES, maxTokens: 64 });
  const plain = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });

  assert.deepEqual(bodies.map((body) => body.model), ["m-fast", "m-default", "m-default"]);
  assert.equal(fast.settings.aiModel, "m-fast");
  assert.equal(strong.settings.aiModel, "m-default");
  assert.equal(plain.settings.aiModel, "m-default");
});

test("覆盖留空或只有空白时回到默认模型", async () => {
  const { transport, bodies } = recordingTransport(customSettings({ featureModels: { verdict: "", explain: "   " } }));
  await transport.requestAiCompletion({ feature: "verdict", messages: MESSAGES, maxTokens: 64 });
  await transport.requestAiCompletion({ feature: "explain", messages: MESSAGES, maxTokens: 64 });
  assert.deepEqual(bodies.map((body) => body.model), ["m-default", "m-default"]);
});

test("模型能力按实际模型查询，单轮预算按它的上限封顶", async () => {
  const asked: string[] = [];
  const { transport, bodies } = recordingTransport(customSettings({ featureModels: { rewrite: "m-small" } }), {
    getModelCapabilities: async (settings) => {
      asked.push(settings.aiModel);
      return settings.aiModel === "m-small" ? { maxTokens: 1000 } : null;
    },
  });
  await transport.requestAiCompletion({ feature: "rewrite", messages: MESSAGES, maxTokens: 4096 });
  await transport.requestAiCompletion({ feature: "qa", messages: MESSAGES, maxTokens: 4096 });

  assert.deepEqual(asked, ["m-small", "m-default"]);
  assert.deepEqual(bodies.map((body) => body.max_tokens), [1000, 4096]);
});

test("放宽记忆按实际模型区分：一个模型拒绝过的参数不连累另一个", async () => {
  const posts: ChatRequestBody[] = [];
  const settings = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://gateway.example.com",
    aiApiKey: "sk-gw",
    ...SETTINGS.CONSENTED,
    aiModel: "gw-strict-ok",
    featureModels: { analysis: "gw-rejects-disabled" },
  });
  const memory = PROVIDER.createRelaxMemory();
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => settings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    relaxMemory: memory,
    fetch: async (_url, init) => {
      const parsed = bodyOf(init);
      posts.push(parsed);
      if (parsed.model === "gw-rejects-disabled" && parsed.thinking?.type === "disabled") {
        return anthropicError(400, '"thinking.type.disabled" is not supported for this model.');
      }
      return anthropicReply("好");
    },
  });
  const ask = (feature: string) => transport.requestAiCompletion({ feature, messages: MESSAGES, maxTokens: 64 });

  await ask("analysis");
  assert.equal(posts.length, 2, "第一次要挨一次 400");
  assert.deepEqual(memory.recall(SETTINGS.withFeatureModel(settings, "analysis")), { thinking: true });
  assert.deepEqual(memory.recall(settings), {}, "默认模型没有被记成要放宽");

  await ask("verdict");
  assert.equal(posts.length, 3);
  assert.equal(posts[2]!.model, "gw-strict-ok");
  assert.deepEqual(posts[2]!.thinking, { type: "disabled" }, "默认模型照常关掉思考");

  await ask("analysis");
  assert.equal(posts.length, 4, "记住的放宽只用在拒绝过的那个模型上，不再挨 400");
  assert.equal(posts[3]!.model, "gw-rejects-disabled");
  assert.equal("thinking" in posts[3]!, false);
});

// ============================================================
// 带密钥的请求：不跟随重定向，报错里的密钥先脱敏
// ============================================================

const KEY = "FAKE-KEY-FOR-OFFLINE-TESTS-0001";

// 浏览器里 redirect: "manual" 拿到的响应：类型是 opaqueredirect，状态码 0，读不到 Location。
const opaqueRedirect = (): TransportResponse => ({
  type: "opaqueredirect",
  status: 0,
  ok: false,
  body: null,
  text: async () => "",
});

function anthropicKeyedSettings(aiBaseUrl: string) {
  return SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl,
    aiApiKey: KEY,
    ...SETTINGS.CONSENTED,
    aiApiKeyOrigin: SETTINGS.originOf(aiBaseUrl),
    aiModel: "claude-test",
  });
}

function transportFor(settings: AiSettings, fetchImpl: AiFetch) {
  return TRANSPORT.createAiTransport({
    getSettings: async () => settings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch: fetchImpl,
  });
}

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

function close(server: http.Server): Promise<unknown> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

// AI 地址只认 https，本机起的测试服务是 http：设置里填 https 的假地址，发请求时
// 换成本机端口交给真实的 fetch，redirect 这些参数原样带过去，重定向照样由 fetch 自己处理。
function viaLoopback(httpsBase: string, port: number): AiFetch {
  return (url, init) => fetch(String(url).replace(httpsBase, `http://127.0.0.1:${port}`), init);
}

test("Anthropic 地址跨域重定向时不跟过去，x-api-key 不会发到新地址", async () => {
  const received: { key: string | string[] | undefined }[] = [];
  const destination = http.createServer((req, res) => {
    received.push({ key: req.headers["x-api-key"] });
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
  const target = `http://localhost:${await listen(destination)}`;
  const origin = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { Location: `${target}/leak` });
    res.end();
  });
  const base = "https://relay.example.com";
  try {
    const transport = transportFor(anthropicKeyedSettings(base), viaLoopback(base, await listen(origin)));
    await assert.rejects(
      transport.requestAiCompletion({ messages: [{ role: "user", content: "离线测试" }], maxTokens: 64 }),
      (error: TransportError) => {
        assert.equal(error.code, "AI_REDIRECT_BLOCKED");
        assert.match(error.message, /重定向/);
        assert.ok(error.message.includes(base), "报错要点名是哪个地址在重定向");
        return true;
      },
    );
    assert.deepEqual(received, [], "重定向的目标一次也不该被请求到");
  } finally {
    await Promise.all([close(origin), close(destination)]);
  }
});

test("模型调用用 manual 模式发请求，浏览器的 opaqueredirect 响应报成重定向，不当成连不上", async () => {
  const inits: AiFetchInit[] = [];
  const transport = transportFor(anthropicKeyedSettings("https://relay.example.com"), async (_url, init) => {
    inits.push(init);
    return opaqueRedirect();
  });
  const error = await failureOf(
    transport.requestAiCompletion({ messages: [{ role: "user", content: "离线测试" }], maxTokens: 64 }),
  );
  assert.equal(error.code, "AI_REDIRECT_BLOCKED");
  assert.deepEqual(inits.map((init) => init.redirect), ["manual"]);
  const response = TRANSPORT.aiErrorResponse(error);
  assert.equal(response.error, "AI_REDIRECT_BLOCKED");
  assert.match(response.message, /不跟随重定向/);
});

test("模型服务在 HTTP 报错里回显密钥时，错误和给界面的提示都不含密钥", async () => {
  const settings = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.OPENAI,
    aiBaseUrl: "https://gateway.example.com/v1",
    aiApiKey: KEY,
    ...SETTINGS.CONSENTED,
    aiModel: "test-model",
  });
  const transport = transportFor(settings, async () => ({
    ok: false,
    status: 400,
    text: json({ error: { message: `rejected credential: ${KEY}`, param: `key=${KEY}` } }),
  }));
  const error = await failureOf(
    transport.requestAiCompletion({ messages: [{ role: "user", content: "离线测试" }], maxTokens: 64 }),
  );
  assert.equal(error.status, 400);
  assert.equal(error.message, "rejected credential: [已隐藏的密钥]");
  assert.equal(error.param, "key=[已隐藏的密钥]");
  assert.ok(!JSON.stringify(TRANSPORT.aiErrorResponse(error)).includes(KEY));
});

test("Responses 返回 200 但生成失败、报错里回显密钥时，空响应的报错同样脱敏", async () => {
  const settings = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.RESPONSES,
    aiBaseUrl: "https://gateway.example.com/v1",
    aiApiKey: KEY,
    ...SETTINGS.CONSENTED,
    aiModel: "gpt-test",
  });
  const transport = transportFor(settings, async () => ({
    ok: true,
    status: 200,
    text: json({ status: "failed", error: { message: `service rejected ${KEY}` }, output: [] }),
  }));
  const error = await failureOf(
    transport.requestAiCompletion({ messages: [{ role: "user", content: "离线测试" }], maxTokens: 64 }),
  );
  assert.equal(error.code, "EMPTY_AI_RESPONSE");
  assert.equal(error.message, "service rejected [已隐藏的密钥]");
});

test("拒答说明里回显密钥时，报错同样脱敏", async () => {
  const settings = SETTINGS.normalize({
    presetId: SETTINGS.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.RESPONSES,
    aiBaseUrl: "https://gateway.example.com/v1",
    aiApiKey: KEY,
    ...SETTINGS.CONSENTED,
    aiModel: "gpt-test",
  });
  const transport = transportFor(settings, async () => RESP.asFetchResponse(RESP.refusal(`cannot use ${KEY}`)));
  const error = await failureOf(
    transport.requestAiCompletion({ messages: [{ role: "user", content: "离线测试" }], maxTokens: 64 }),
  );
  assert.equal(error.code, "AI_REFUSED");
  assert.equal(error.message, "模型拒绝了这次请求：cannot use [已隐藏的密钥]");
});

// ============================================================
// Responses 的 JSON 模式：input 里必须出现 JSON 这个词，instructions 不算
// ============================================================

const VARIABLES = {
  videoTitle: "示例视频",
  ownerName: "UP",
  durationFormatted: "10:00",
  coverageNote: "完整",
  videoDescription: "简介",
  chaptersText: "[00:00] 开场",
  quotesText: "（无）",
  transcriptText: "[00:00] 大家好",
  question: "讲了什么？",
  segmentsJson: '{"segments":[{"id":"s1","text":"你好"}]}',
};
const FEATURES = [
  ["analysis.md", SCHEMAS.ANALYSIS_CHUNK],
  ["verdict.md", SCHEMAS.VERDICT],
  ["qa.md", SCHEMAS.QA_ANSWER],
  ["translation.md", SCHEMAS.SEGMENT_BATCH],
] as const;
const JSON_WORD_ERROR =
  "Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.";

function prompt(file: string, section: string): string {
  const text = readFileSync(new URL(`../../../../prompts/${file}`, import.meta.url), "utf8");
  return extractPromptSection(text, section, VARIABLES);
}

function responsesSettings(aiModel: string): AiSettings {
  return {
    ...SETTINGS.normalize({}),
    protocol: PROTOCOLS.RESPONSES,
    aiBaseUrl: "https://api.openai.com/v1",
    aiApiKey: "sk-test",
    aiModel,
  };
}

const lastUser = (input: readonly ChatMessage[] | undefined): ChatMessage | undefined =>
  input?.filter((message) => message.role === "user").at(-1);

for (const model of ["gpt-4.1", "gpt-6-sol"]) {
  test(`不在兼容表里的 ${model}：四个 JSON 功能退回 JSON 模式时，最后一条用户消息里有 JSON 这个词`, () => {
    for (const [file, schema] of FEATURES) {
      const messages = [
        { role: "system", content: prompt(file, "系统提示词") },
        { role: "user", content: prompt(file, "用户提示词") },
      ];
      const { body } = PROVIDER.buildChatRequest({
        settings: responsesSettings(model),
        messages,
        maxTokens: 2048,
        responseFormat: schema,
      });
      assert.equal(body.text?.format.type, "json_object", file);
      const content = String(lastUser(body.input)?.content);
      assert.match(content, /\bjson\b/i, `${file} 的 input 里要有 JSON`);
      // 只在末尾补一句，原来的提示词一字不动，系统提示照旧放在 instructions。
      assert.ok(content.startsWith(messages[1]!.content), file);
      assert.equal(body.instructions, messages[0]!.content, file);
    }
  });
}

test("兼容表里的型号发结构化输出，不需要也不补这句", () => {
  const messages = [
    { role: "system", content: "按要求输出" },
    { role: "user", content: "字幕内容" },
  ];
  const { body } = PROVIDER.buildChatRequest({
    settings: responsesSettings("gpt-5.5"),
    messages,
    maxTokens: 1024,
    responseFormat: SCHEMAS.VERDICT,
  });
  assert.equal(body.text?.format.type, "json_schema");
  assert.deepEqual(body.input, [{ role: "user", content: "字幕内容" }]);
});

test("用户消息里已经写了 JSON 就不重复补", () => {
  const messages = [{ role: "user", content: "按下面的格式输出 JSON：{}" }];
  const { body } = PROVIDER.buildChatRequest({
    settings: responsesSettings("gpt-4.1"),
    messages,
    maxTokens: 1024,
    responseFormat: SCHEMAS.VERDICT,
  });
  assert.deepEqual(body.input, messages);
});

test("调用方不要求 JSON 时不补这句", () => {
  const messages = [{ role: "user", content: "回复两个字：可用" }];
  const { body } = PROVIDER.buildChatRequest({
    settings: responsesSettings("gpt-4.1"),
    messages,
    maxTokens: 64,
  });
  assert.equal(body.text, undefined);
  assert.deepEqual(body.input, messages);
});

test("仍被「缺 json 这个词」拒绝时，放宽为不发 text.format 再试一次，并记住", async () => {
  const settings = responsesSettings("gpt-4.1");
  const memory = PROVIDER.createRelaxMemory();
  const bodies: ChatRequestBody[] = [];
  const send: PROVIDER.SendChatInput["send"] = async (request) => {
    bodies.push(request.body);
    if (request.body.text?.format?.type === "json_object") {
      throw Object.assign(new Error(JSON_WORD_ERROR), { status: 400, param: "input" });
    }
    return { status: "completed", output: [] };
  };
  const args: PROVIDER.SendChatInput = {
    settings,
    messages: [
      { role: "system", content: "只输出 JSON" },
      { role: "user", content: "字幕内容" },
    ],
    maxTokens: 1024,
    responseFormat: SCHEMAS.VERDICT,
    memory,
    send,
  };
  const first = await PROVIDER.sendChatWithRelax(args);
  assert.deepEqual(first.relax, { jsonObject: true });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.text, undefined);
  assert.deepEqual(bodies[1]!.input, [{ role: "user", content: "字幕内容" }]);

  // 同一组设置下次直接按放宽后的参数发，不再先挨一次 400。
  await PROVIDER.sendChatWithRelax(args);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2]!.text, undefined);
});

test("这条放宽只针对 JSON 模式：发结构化输出时的 schema 报错照旧退回 JSON 模式", () => {
  const error = Object.assign(new Error("Invalid schema for response_format 'verdict'"), {
    status: 400,
  });
  const body: ChatRequestBody = { text: { format: { type: "json_schema" } } };
  assert.deepEqual(PROVIDER.relaxRejectedParams(PROTOCOLS.RESPONSES, error, {}, body), {
    format: true,
  });
  const jsonWord = Object.assign(new Error(JSON_WORD_ERROR), { status: 400 });
  assert.equal(
    PROVIDER.relaxRejectedParams(PROTOCOLS.RESPONSES, jsonWord, { jsonObject: true }, {}),
    null,
    "已经不发 JSON 模式了，再报同样的错就交还给调用方",
  );
});
