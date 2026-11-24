// 协议层和传输层给用户看的说明的英文：错误照旧带中文说明，英文挂在不可枚举的 messageEn 上，回执按语言挑；
// 不传语言时回执和原来逐字一样。服务自己的原话两种语言都照原样。繁体那份同样挂在错误上，这里另查每一句都有繁体。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as PROVIDER from "../../../../src/core/ai/provider/index.ts";
import { validateBaseUrl } from "../../../../src/core/ai/provider/endpoint.ts";
import * as TRANSPORT from "../../../../src/core/ai/transport/index.ts";
import type { AiFetch, RetryNotice, TransportError, TransportResponse } from "../../../../src/core/ai/transport/index.ts";
import * as SETTINGS from "../../../../src/shared/settings-schema.ts";
import { transportText } from "../../../../src/core/ai/transport/text.ts";
import { charsIn, SIMPLIFIED_ONLY } from "../../../helpers/hant-chars.ts";

const { PROTOCOLS } = PROVIDER;
const CJK = /[　-〿一-鿿＀-￯]/;

function makeTransport(fetchImpl: AiFetch, settings: SETTINGS.SettingsInput = {}) {
  return TRANSPORT.createAiTransport({
    getSettings: async () =>
      SETTINGS.normalize({
        presetId: "custom",
        protocol: PROTOCOLS.OPENAI,
        aiApiKey: "test-key",
        aiBaseUrl: "https://api.example.com/v1",
        aiModel: "test-model",
        ...SETTINGS.DATA_CONSENT_CONFIRMED,
        ...settings,
      }),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    fetch: fetchImpl,
  });
}

const reply = (status: number, body: unknown): TransportResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

const failureOf = (pending: Promise<unknown>): Promise<TransportError> =>
  pending.then(
    () => assert.fail("应当报错"),
    (error: TransportError) => error,
  );

/** 不传语言和传中文一样，英文那份没有中文、码不变。 */
function checkBoth(error: unknown, label: string): TRANSPORT.AiErrorResponse {
  const zh = TRANSPORT.aiErrorResponse(error);
  assert.deepEqual(TRANSPORT.aiErrorResponse(error, "zh"), zh, label);
  const en = TRANSPORT.aiErrorResponse(error, "en");
  assert.equal(en.error, zh.error, label);
  assert.equal(en.noAutoRetry, zh.noAutoRetry, label);
  assert.doesNotMatch(en.message, CJK, `${label}：${en.message}`);
  assert.ok(en.message.trim(), label);
  return en;
}

test("空响应的诊断：英文说明挂在不可枚举的 messageEn 上，可枚举的字段和原来一样", () => {
  const payloads: readonly [PROVIDER.Protocol, unknown][] = [
    [PROTOCOLS.OPENAI, { content: [{ type: "text", text: "x" }] }],
    [PROTOCOLS.ANTHROPIC, { choices: [{ message: { content: "x" } }] }],
    [PROTOCOLS.OPENAI, { foo: "bar" }],
    [PROTOCOLS.OPENAI, { choices: [{ finish_reason: "length", message: { content: "" } }] }],
    [PROTOCOLS.OPENAI, { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "r" } }] }],
    [PROTOCOLS.OPENAI, { choices: [{ finish_reason: "stop", message: { content: "", reasoning: "r" } }] }],
    [PROTOCOLS.ANTHROPIC, { stop_reason: "max_tokens" }],
    [PROTOCOLS.ANTHROPIC, { content: [{ type: "thinking", thinking: "r" }] }],
    [PROTOCOLS.ANTHROPIC, {}],
    [PROTOCOLS.OPENAI, { choices: [{ message: { content: "" } }] }],
    [PROTOCOLS.RESPONSES, { choices: [] }],
    [PROTOCOLS.RESPONSES, {}],
    [PROTOCOLS.RESPONSES, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }],
    [PROTOCOLS.RESPONSES, { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }],
    [PROTOCOLS.RESPONSES, { status: "failed", output: [] }],
    [PROTOCOLS.RESPONSES, { output: [{ type: "reasoning" }] }],
    [PROTOCOLS.RESPONSES, { output: [] }],
  ];
  for (const [protocol, data] of payloads) {
    const result = PROVIDER.diagnoseEmptyResponse(protocol, data);
    const label = `${protocol} ${JSON.stringify(data)}`;
    assert.ok(!Object.keys(result).includes("messageEn"), label);
    assert.ok(result.messageEn, label);
    assert.doesNotMatch(result.messageEn ?? "", CJK, `${label}：${result.messageEn}`);
    assert.match(result.message, CJK, label);
  }
  // 服务自己给了失败说明：原话照带，前面按各自的语言说明这是服务说的。
  const said = PROVIDER.diagnoseEmptyResponse(PROTOCOLS.RESPONSES, { status: "failed", error: { message: "backend exploded" }, output: [] });
  assert.equal(said.message, "模型生成失败，服务说：backend exploded");
  assert.equal(said.messageEn, "The model couldn't generate a reply. The service said: backend exploded");
  assert.equal(said.messageHant, PROVIDER.providerText("zh-Hant").generationFailedWith("backend exploded"));
});

test("API 地址的校验：不传语言是中文，英文每一种都有", () => {
  for (const input of ["", "not a url", "http://example.com", "https://[::1]/v1"]) {
    const zh = validateBaseUrl(input);
    const en = validateBaseUrl(input, PROTOCOLS.OPENAI, "en");
    assert.equal(zh.ok, false);
    assert.equal(en.ok, false);
    if (zh.ok || en.ok) continue;
    assert.match(zh.error, CJK, input);
    assert.doesNotMatch(en.error, CJK, `${input}：${en.error}`);
  }
  assert.deepEqual(validateBaseUrl("https://api.example.com/v1/chat/completions", PROTOCOLS.OPENAI, "en"), validateBaseUrl("https://api.example.com/v1/chat/completions"));
});

test("按状态码归类的回执：英文按同一个码写，不传语言和原来一样", () => {
  const httpError = (status: number, message = "") => Object.assign(new Error(message), { status });
  assert.equal(checkBoth(httpError(401), "401").error, "INVALID_AI_KEY");
  assert.equal(checkBoth(httpError(404), "404").error, "MODEL_OR_ENDPOINT_NOT_FOUND");
  assert.equal(checkBoth(httpError(429), "429").error, "RATE_LIMITED");
  assert.equal(checkBoth(httpError(503, "overloaded"), "503").message, "The AI service is busy or having problems (HTTP 503). Try again later.");
  // 中转站自己的说明照原样附在后面。
  assert.equal(checkBoth(httpError(500, "model gpt-x not configured"), "500").message, "The AI service ran into an error (HTTP 500): model gpt-x not configured");
  assert.equal(checkBoth(Object.assign(new Error("x"), { code: "TASK_CANCELED" }), "取消").message, "The task was cancelled.");
  assert.equal(checkBoth(new Error(""), "空").message, "The AI request failed.");
  // 协议层只写了状态码的说法，换成英文；服务的原话照原样。
  assert.equal(checkBoth(PROVIDER.keyedHttpError(null, 400, null), "只有状态码").message, "The service returned 400");
  assert.equal(TRANSPORT.aiErrorResponse(PROVIDER.keyedHttpError({ error: { message: "bad param foo" } }, 400, null), "en").message, "bad param foo");
});

test("简幕自己写的说明：重定向、工作区密钥、地址拼不出请求，英文都挂在错误上", () => {
  let redirect: unknown;
  try {
    PROVIDER.rejectRedirect({ type: "opaqueredirect", status: 0 }, "https://relay.example.com");
  } catch (error) {
    redirect = error;
  }
  assert.match(checkBoth(redirect, "重定向").message, /^https:\/\/relay\.example\.com redirected/);
  const workspace = PROVIDER.keyedHttpError({ error: { message: "This key is not scoped to a workspace" } }, 400, null);
  assert.equal(workspace.code, "ANTHROPIC_WORKSPACE_REQUIRED");
  assert.ok(!Object.keys(workspace).includes("messageEn"), "英文不可枚举，黄金样本照旧");
  assert.match(checkBoth(workspace, "工作区").message, /workspace/);
  assert.throws(() => PROVIDER.buildChatRequest({ settings: { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "not a url", aiModel: "m" } as PROVIDER.AiSettings, messages: [], maxTokens: 10 }), (error: Error & { messageEn?: string }) => {
    assert.match(error.message, CJK);
    assert.equal(error.messageEn, "The API address isn't valid. Check it in settings.");
    return true;
  });
});

test("传输层：配置没好、连不上、拒答、模型没写内容，回执按语言挑；限流后重发的进度按请求的语言", async () => {
  const notConfigured = await failureOf(makeTransport(async () => reply(200, {}), { aiApiKey: "" }).requestAiCompletion({ messages: [], maxTokens: 10 }));
  assert.equal(notConfigured.code, "NO_AI_CONFIG");
  assert.match(checkBoth(notConfigured, "配置").message, /^The AI service isn't set up yet: Enter your API key/);

  const unreachable = await failureOf(makeTransport(async () => { throw new TypeError("fetch failed"); }).requestAiCompletion({ messages: [], maxTokens: 10 }));
  assert.equal(unreachable.code, "AI_NETWORK_ERROR");
  assert.match(checkBoth(unreachable, "连不上").message, /^Couldn't reach https:\/\/api\.example\.com\/v1\./);

  const refused = await failureOf(makeTransport(async () => reply(200, { choices: [{ finish_reason: "content_filter", message: { content: "", refusal: "no thanks" } }] })).requestAiCompletion({ messages: [], maxTokens: 10 }));
  if (refused.code === "AI_REFUSED") assert.equal(checkBoth(refused, "拒答").message, "The model refused this request: no thanks");

  const empty = await failureOf(makeTransport(async () => reply(200, { choices: [{ message: { content: "" } }] })).requestAiCompletion({ messages: [], maxTokens: 10, selfRetry: false }));
  assert.equal(empty.code, "EMPTY_AI_RESPONSE");
  assert.equal(checkBoth(empty, "空响应").message, "The model returned nothing. Try again.");

  for (const lang of ["zh", "en", undefined] as const) {
    const notices: RetryNotice[] = [];
    let calls = 0;
    const transport = makeTransport(async () => (++calls === 1 ? reply(503, { error: { message: "overloaded" } }) : reply(200, { choices: [{ message: { content: "ok" } }] })));
    await transport.requestAiCompletion({ messages: [], maxTokens: 10, onRetry: (notice) => notices.push(notice), ...(lang ? { lang } : {}) });
    assert.equal(notices.length, 1);
    if (lang === "en") assert.match(notices[0]?.message ?? "", /^The service is busy\. Retrying in \d+ s…$/);
    else assert.match(notices[0]?.message ?? "", /^服务繁忙，\d+ 秒后重试…$/);
  }
});

test("繁体：协议层和传输层的说明每一句都有繁体那份，不是回落的简体；遮密钥的占位字也是繁体", () => {
  const sample = (value: unknown): string => (typeof value === "function" ? String(value("https://api.example.test/v1", 7)) : String(value));
  for (const [zh, hant] of [
    [PROVIDER.providerText("zh"), PROVIDER.providerText("zh-Hant")],
    [transportText("zh"), transportText("zh-Hant")],
  ] as const) {
    assert.deepEqual(Object.keys(hant).sort(), Object.keys(zh).sort());
    for (const [key, value] of Object.entries(hant)) {
      const text = sample(value);
      assert.deepEqual(charsIn(text, SIMPLIFIED_ONLY), [], `${key}：${text}`);
      assert.notEqual(text, sample((zh as Record<string, unknown>)[key]), `${key} 回落成了简体`);
    }
  }
  assert.equal(PROVIDER.hiddenIn("密钥 [已隐藏的密钥]，片段 [已隐藏]", "zh-Hant"), "密钥 [已隱藏的金鑰]，片段 [已隱藏]");
  assert.equal(PROVIDER.messageIn({ message: "服务在返回途中报了错。" }, "zh-Hant"), "服務在傳回途中報了錯。");
});
