// 推理强度：协议、域名、型号、档位到请求体补丁和实际档位的映射，选关时请求不变，做不到时退一档并标出，
// 输出余量和超时，放宽记忆按档位分开记，传输层按档位加余量。
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCapabilities } from "../../../../src/core/ai/capabilities.ts";
import * as P from "../../../../src/core/ai/provider/index.ts";
import type { AiSettings, ChatRequestBody, ClaudeCapabilities, EffortPlan, RelaxState } from "../../../../src/core/ai/provider/index.ts";
import * as TRANSPORT from "../../../../src/core/ai/transport/index.ts";
import type { AiFetch, TransportResponse } from "../../../../src/core/ai/transport/index.ts";
import { EFFORTS, type Effort } from "../../../../src/core/ai/effort-level.ts";
import * as SETTINGS from "../../../../src/shared/settings-schema.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const { PROTOCOLS } = P;
const LEVELS: readonly Effort[] = ["low", "medium", "high"];

const settingsOf = (input: SETTINGS.SettingsInput): AiSettings =>
  SETTINGS.normalize({ aiApiKey: "sk-effort-test", ...SETTINGS.DATA_CONSENT_CONFIRMED, ...input });

const ANTHROPIC = (aiModel: string) => settingsOf({ presetId: "anthropic", aiModel });
const RESPONSES = (aiModel: string) => settingsOf({ presetId: "openai", aiModel });
const DEEPSEEK = settingsOf({ presetId: "deepseek", aiModel: "deepseek-flash" });
const GEMINI = (aiModel: string) => settingsOf({ presetId: "gemini", aiModel });
const GATEWAY = settingsOf({ presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "m" });
const OPENAI_CHAT = (aiModel: string) =>
  settingsOf({ presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://api.openai.com/v1", aiModel });

interface Extra {
  readonly claude?: ClaudeCapabilities | null;
  readonly relax?: RelaxState;
}

function planFor(settings: AiSettings, requested: Effort, { claude = null }: Extra = {}): EffortPlan {
  const host = P.hostOf(settings.aiBaseUrl);
  const caps = resolveCapabilities({ protocol: settings.protocol, host, model: settings.aiModel, claude });
  return P.planEffort({ protocol: settings.protocol, host, model: settings.aiModel, requested, caps });
}

const MESSAGES = [
  { role: "system", content: "按规则改写" },
  { role: "user", content: "正文" },
];

function bodyFor(settings: AiSettings, effort: EffortPlan | null, { claude = null, relax = {} }: Extra = {}): ChatRequestBody {
  return P.buildChatRequest({
    settings,
    messages: MESSAGES,
    maxTokens: 1000,
    temperature: 0.2,
    responseFormat: { type: "json_object" },
    capabilities: claude,
    relax,
    effort,
  }).body;
}

/** 选关时的请求体，和不传档位时逐字节相同。 */
function assertOffUnchanged(settings: AiSettings, extra: Extra = {}): EffortPlan {
  const plan = planFor(settings, "off", extra);
  assert.equal(JSON.stringify(bodyFor(settings, plan, extra)), JSON.stringify(bodyFor(settings, null, extra)), settings.aiModel);
  return plan;
}

const view = ({ effective, note }: EffortPlan) => (note ? { effective, note } : { effective });

test("Anthropic：关得掉的型号选关时请求不变；低、中、高写成自适应思考加对应档位", () => {
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-sonnet-4-6"]) {
    const settings = ANTHROPIC(model);
    assert.deepEqual(view(assertOffUnchanged(settings)), { effective: "off" }, model);
    for (const level of LEVELS) {
      const plan = planFor(settings, level);
      assert.deepEqual(view(plan), { effective: level }, `${model} ${level}`);
      const body = bodyFor(settings, plan);
      assert.deepEqual(body.thinking, { type: "adaptive" }, `${model} ${level}`);
      assert.equal(body.output_config?.effort, level, `${model} ${level}`);
    }
  }
});

test("Anthropic：关不掉思考的型号选关按最低档发并标出，请求和以前一样", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-preview"]) {
    const settings = ANTHROPIC(model);
    const plan = assertOffUnchanged(settings);
    assert.deepEqual(view(plan), { effective: "low", note: "cannot-disable" }, model);
    const body = bodyFor(settings, plan);
    assert.equal("thinking" in body, false, model);
    assert.deepEqual(body.output_config, { effort: "low" }, model);
  }
});

test("Anthropic：只有手动思考预算的老型号和认不出的型号只能关，选高档退回关，请求不变", () => {
  const old = ANTHROPIC("claude-haiku-4-5");
  for (const level of LEVELS) {
    const plan = planFor(old, level);
    assert.deepEqual(view(plan), { effective: "off", note: "fallback" }, level);
    assert.equal(JSON.stringify(bodyFor(old, plan)), JSON.stringify(bodyFor(old, null)), level);
  }
  const unknown = settingsOf({ presetId: "custom", protocol: PROTOCOLS.ANTHROPIC, aiBaseUrl: "https://gateway.example.com", aiModel: "relay-x" });
  assert.deepEqual(view(assertOffUnchanged(unknown)), { effective: "off", note: "unknown" });
  const high = planFor(unknown, "high");
  assert.deepEqual(view(high), { effective: "off", note: "unknown" });
  assert.equal(JSON.stringify(bodyFor(unknown, high)), JSON.stringify(bodyFor(unknown, null)));
});

test("Anthropic：读到模型列表的能力时按能力判断，没有的档位退到下面一档", () => {
  const claude: ClaudeCapabilities = {
    maxTokens: 64000,
    thinking: { disabled: false, betweenTools: true, adaptive: true },
    efforts: ["low", "high", "max"],
    structuredOutputs: true,
  };
  const settings = ANTHROPIC("claude-sonnet-5-5");
  assert.deepEqual(view(assertOffUnchanged(settings, { claude })), { effective: "off" });
  const medium = planFor(settings, "medium", { claude });
  assert.deepEqual(view(medium), { effective: "low", note: "fallback" });
  assert.equal(bodyFor(settings, medium, { claude }).output_config?.effort, "low");
  assert.deepEqual(view(planFor(settings, "high", { claude })), { effective: "high" });

  const alwaysThinks = { ...claude, thinking: { disabled: false, betweenTools: false, adaptive: true } };
  assert.deepEqual(view(assertOffUnchanged(settings, { claude: alwaysThinks })), { effective: "low", note: "cannot-disable" });
});

test("Responses：兼容表里的型号按档位发，最低档是低的型号选关标成关不掉；不推理的型号退回关", () => {
  const terra = RESPONSES("gpt-5.5");
  assert.deepEqual(view(assertOffUnchanged(terra)), { effective: "off" });
  assert.deepEqual(bodyFor(terra, planFor(terra, "off")).reasoning, { effort: "none" }, "关就是原来那档 none");
  for (const level of LEVELS) assert.deepEqual(bodyFor(terra, planFor(terra, level)).reasoning, { effort: level }, level);

  const astra = RESPONSES("gpt-6-astra");
  assert.deepEqual(view(assertOffUnchanged(astra)), { effective: "low", note: "cannot-disable" });

  const plain = RESPONSES("gpt-4.1");
  for (const level of LEVELS) {
    const plan = planFor(plain, level);
    assert.deepEqual(view(plan), { effective: "off", note: "fallback" }, level);
    assert.equal("reasoning" in bodyFor(plain, plan), false, level);
  }

  // 表外的推理型号：原来不发档位，选关照旧不发并标成由服务决定；选了档位就发。
  const variant = RESPONSES("gpt-5.5-mini");
  assert.deepEqual(view(assertOffUnchanged(variant)), { effective: "off", note: "unknown" });
  assert.deepEqual(bodyFor(variant, planFor(variant, "medium")).reasoning, { effort: "medium" });
});

test("DeepSeek：关照旧带关思考参数；低、高打开思考并带档位；中档没有，退到低档并标出", () => {
  assert.deepEqual(view(assertOffUnchanged(DEEPSEEK)), { effective: "off" });
  assert.deepEqual(bodyFor(DEEPSEEK, null).thinking, { type: "disabled" });
  for (const [requested, effective] of [["low", "low"], ["medium", "low"], ["high", "high"]] as const) {
    const plan = planFor(DEEPSEEK, requested);
    assert.equal(plan.effective, effective, requested);
    assert.equal(plan.note, requested === effective ? undefined : "fallback", requested);
    const body = bodyFor(DEEPSEEK, plan);
    assert.deepEqual(body.thinking, { type: "enabled" }, requested);
    assert.equal(body.reasoning_effort, effective, requested);
  }
});

test("Google 兼容端点：关得掉的型号显式关；关不掉的按最低档发并标出；不思考的老型号什么都不发", () => {
  for (const model of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "models/gemini-2.5-flash"]) {
    const settings = GEMINI(model);
    const off = planFor(settings, "off");
    assert.deepEqual(view(off), { effective: "off" }, model);
    assert.equal(bodyFor(settings, off).reasoning_effort, "none", model);
    for (const level of LEVELS) assert.equal(bodyFor(settings, planFor(settings, level)).reasoning_effort, level, `${model} ${level}`);
  }
  for (const model of ["gemini-2.5-pro", "gemini-3-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
    const settings = GEMINI(model);
    const off = planFor(settings, "off");
    assert.deepEqual(view(off), { effective: "low", note: "cannot-disable" }, model);
    assert.equal(bodyFor(settings, off).reasoning_effort, "low", model);
    assert.equal(bodyFor(settings, planFor(settings, "high")).reasoning_effort, "high", model);
  }
  const old = GEMINI("gemini-2.0-flash");
  assert.deepEqual(view(assertOffUnchanged(old)), { effective: "off" });
  assert.deepEqual(view(planFor(old, "high")), { effective: "off", note: "fallback" });
  assert.equal("reasoning_effort" in bodyFor(old, planFor(old, "high")), false);

  const other = GEMINI("gemma-3-27b-it");
  assert.deepEqual(view(assertOffUnchanged(other)), { effective: "off", note: "unknown" });
});

test("别的兼容服务不发档位参数，选什么都标成由服务决定，请求不变", () => {
  for (const requested of ["off", ...LEVELS] as const) {
    const plan = planFor(GATEWAY, requested);
    assert.deepEqual(view(plan), { effective: "off", note: "unknown" }, requested);
    assert.deepEqual(plan.patch, {}, requested);
    assert.equal(JSON.stringify(bodyFor(GATEWAY, plan)), JSON.stringify(bodyFor(GATEWAY, null)), requested);
  }
  // 填官方地址走 Chat Completions：推理型号按档位发，原来不发档位，选关照旧。
  const chat = OPENAI_CHAT("gpt-5.5");
  assert.deepEqual(view(assertOffUnchanged(chat)), { effective: "off", note: "unknown" });
  assert.equal(bodyFor(chat, planFor(chat, "high")).reasoning_effort, "high");
  assert.deepEqual(view(planFor(OPENAI_CHAT("gpt-4o"), "high")), { effective: "off", note: "fallback" });
});

test("「关」不会变成更高的默认档：所有服务上选关，实际档位只会是关或这个服务的最低档", () => {
  const all = [
    ANTHROPIC("claude-sonnet-5-5"),
    ANTHROPIC("claude-opus-5-5"),
    RESPONSES("gpt-6-astra"),
    RESPONSES("gpt-4.1"),
    DEEPSEEK,
    GEMINI("gemini-3.8-flash"),
    GATEWAY,
    OPENAI_CHAT("gpt-5.5"),
  ];
  for (const settings of all) {
    const plan = planFor(settings, "off");
    assert.ok(plan.effective === "off" || plan.effective === "low", `${settings.aiModel} → ${plan.effective}`);
    // 照样会思考的（关不掉、设不了）按低档留余量，其余不加；超时都是关档的。
    const thinksAnyway = plan.note === "cannot-disable" || plan.note === "unknown";
    assert.equal(plan.outputHeadroom, thinksAnyway ? P.EFFORT_BUDGETS.low.outputHeadroom : 0, settings.aiModel);
    assert.equal(plan.timeoutSec, 120, settings.aiModel);
  }
});

test("照样会思考的模型按低档留输出余量：关不掉思考又选了关的、扩展设不了档位的；超时不变", () => {
  const low = P.EFFORT_BUDGETS.low.outputHeadroom;
  for (const settings of [ANTHROPIC("claude-opus-5-5"), RESPONSES("gpt-6-astra"), GEMINI("gemini-3.8-flash")]) {
    const plan = planFor(settings, "off");
    assert.equal(plan.note, "cannot-disable", settings.aiModel);
    assert.deepEqual([plan.outputHeadroom, plan.timeoutSec], [low, 120], settings.aiModel);
  }
  // 设不了档位：不管选的哪档都按低档留，不按选的高档留。
  for (const requested of EFFORTS) {
    const plan = planFor(GATEWAY, requested);
    assert.equal(plan.note, "unknown", requested);
    assert.deepEqual([plan.outputHeadroom, plan.timeoutSec], [low, 120], requested);
  }
  const unnamed = OPENAI_CHAT("gpt-5.5");
  assert.equal(planFor(unnamed, "off").note, "unknown");
  assert.equal(planFor(unnamed, "off").outputHeadroom, low);
});

test("认得出、关得掉、选了关的，输出余量和超时都和以前一样", () => {
  for (const settings of [ANTHROPIC("claude-sonnet-5-5"), RESPONSES("gpt-4.1"), DEEPSEEK, GEMINI("gemini-2.5-flash"), OPENAI_CHAT("gpt-4.1")]) {
    const plan = planFor(settings, "off");
    assert.deepEqual([plan.effective, plan.note, plan.outputHeadroom, plan.timeoutSec], ["off", undefined, 0, 120], settings.aiModel);
  }
});

test("输出余量和超时：关 0 和 120 秒、低 2048 和 120 秒、中 6144 和 180 秒、高 16384 和 300 秒；按选的和实际的两档中低的算", () => {
  assert.deepEqual(P.EFFORT_BUDGETS, {
    off: { outputHeadroom: 0, timeoutSec: 120 },
    low: { outputHeadroom: 2048, timeoutSec: 120 },
    medium: { outputHeadroom: 6144, timeoutSec: 180 },
    high: { outputHeadroom: 16384, timeoutSec: 300 },
  });
  const sonnet = ANTHROPIC("claude-sonnet-5-5");
  for (const level of ["off", ...LEVELS] as const) {
    const plan = planFor(sonnet, level);
    assert.equal(plan.outputHeadroom, P.EFFORT_BUDGETS[level].outputHeadroom, level);
    assert.equal(plan.timeoutSec, P.EFFORT_BUDGETS[level].timeoutSec, level);
  }
  const fallback = planFor(DEEPSEEK, "medium");
  assert.deepEqual([fallback.outputHeadroom, fallback.timeoutSec], [2048, 120], "退到低档，按低档算");
  const unknown = planFor(GATEWAY, "high");
  assert.deepEqual([unknown.outputHeadroom, unknown.timeoutSec], [2048, 120], "设不了的服务按低档留余量，不按选的高档");
  // 超时表只有一份：设置模块的超时就是这张表，关档就是默认超时。
  for (const level of ["off", ...LEVELS] as const) assert.equal(SETTINGS.EFFORT_TIMEOUT_SECONDS[level], P.EFFORT_BUDGETS[level].timeoutSec);
  assert.equal(SETTINGS.EFFORT_TIMEOUT_SECONDS.off, SETTINGS.AI_TIMEOUT_SECONDS);
});

test("这个档位下服务拒过的写法不再发：Responses 档位参数被拒后不带档位，Anthropic 自适应被拒后不带思考", () => {
  const terra = RESPONSES("gpt-5.5");
  assert.equal("reasoning" in bodyFor(terra, planFor(terra, "high"), { relax: { effort: true } }), false);
  const sonnet = ANTHROPIC("claude-sonnet-5-5");
  const body = bodyFor(sonnet, planFor(sonnet, "high"), { relax: { thinking: true } });
  assert.equal("thinking" in body, false);
  assert.equal(body.output_config?.effort, "high");
});

test("放宽记忆按档位分开记：关的键和以前一样，别的档位各记各的", async () => {
  const session = memoryStorage();
  const memory = P.createRelaxMemory({ storage: session });
  const settings = RESPONSES("gpt-5.5");
  await memory.remember(settings, { temperature: true });
  await memory.remember(settings, { effort: true }, { effort: "high" });
  assert.deepEqual(memory.recall(settings), { temperature: true });
  assert.deepEqual(memory.recall(settings, "off"), { temperature: true });
  assert.deepEqual(memory.recall(settings, "high"), { effort: true });
  assert.deepEqual(memory.recall(settings, "low"), {});
  const keys = Object.keys(session.data[P.RELAX_STORAGE_KEY] as object);
  assert.deepEqual(keys, [
    JSON.stringify([PROTOCOLS.RESPONSES, "https://api.openai.com/v1", "gpt-5.5", ""]),
    JSON.stringify([PROTOCOLS.RESPONSES, "https://api.openai.com/v1", "gpt-5.5", "", "high"]),
  ]);
});

test("高档被拒放宽后只记在高档：再发高档直接不带档位，选关的请求照旧", async () => {
  const memory = P.createRelaxMemory();
  const settings = RESPONSES("gpt-5.5");
  const sent: ChatRequestBody[] = [];
  const send = async (request: P.ChatRequest): Promise<unknown> => {
    sent.push(request.body);
    if (request.body.reasoning?.effort === "high") {
      throw Object.assign(new Error("Unsupported value for this model"), { status: 400, param: "reasoning.effort" });
    }
    return {};
  };
  const ask = (effort: Effort) =>
    P.sendChatWithRelax({ settings, messages: MESSAGES, maxTokens: 100, effort: planFor(settings, effort), memory, send });

  await ask("high");
  assert.deepEqual(sent.map((body) => body.reasoning ?? null), [{ effort: "high" }, null]);
  await ask("high");
  assert.equal(sent.length, 3, "同一档位第二次直接不带档位");
  assert.equal(sent[2]?.reasoning, undefined);
  await ask("off");
  assert.deepEqual(sent[3]?.reasoning, { effort: "none" }, "选关的请求不受高档的放宽影响");
});

test("加了余量的输出上限被拒：退回不加余量的上限重发，记住以后同一组设置直接不加", async () => {
  const memory = P.createRelaxMemory();
  const plan = planFor(GATEWAY, "off");
  const sent: number[] = [];
  const send = async (request: P.ChatRequest): Promise<unknown> => {
    sent.push(Number(request.body.max_tokens));
    if (Number(request.body.max_tokens) > 1000) {
      throw Object.assign(new Error("max_tokens is out of range for this model"), { status: 400 });
    }
    return {};
  };
  const ask = () =>
    P.sendChatWithRelax({ settings: GATEWAY, messages: MESSAGES, maxTokens: 1000 + plan.outputHeadroom, effort: plan, memory, send });

  const { relax } = await ask();
  assert.deepEqual(relax, { headroom: true });
  assert.deepEqual(sent, [1000 + plan.outputHeadroom, 1000]);
  await ask();
  assert.deepEqual(sent.slice(2), [1000], "记住以后直接按原来的上限发");
});

test("余量的放宽只在这次确实加了余量、报错点名输出上限时才有", () => {
  const error = { status: 400, message: "max_tokens is out of range for this model" };
  assert.deepEqual(P.relaxRejectedParams(PROTOCOLS.OPENAI, error, {}, null, 2048), { headroom: true });
  assert.deepEqual(P.relaxRejectedParams(PROTOCOLS.ANTHROPIC, error, {}, null, 2048), { headroom: true });
  assert.deepEqual(P.relaxRejectedParams(PROTOCOLS.RESPONSES, { status: 400, param: "max_output_tokens" }, {}, null, 2048), { headroom: true });
  assert.equal(P.relaxRejectedParams(PROTOCOLS.OPENAI, error, {}, null, 0), null, "没加余量，照旧交还");
  assert.equal(P.relaxRejectedParams(PROTOCOLS.OPENAI, error, { headroom: true }, null, 2048), null, "放宽过还被拒就交还");
  assert.equal(P.relaxRejectedParams(PROTOCOLS.OPENAI, { status: 400, message: "temperature" }, {}, null, 2048), null);
});

function chatReply(): TransportResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }) };
}

test("传输层按档位加输出余量、并进补丁；选关时预算和请求体都和以前一样；余量不超过单轮天花板", async () => {
  const sent: ChatRequestBody[] = [];
  const fetch: AiFetch = async (_url, init) => {
    sent.push(JSON.parse(init.body) as ChatRequestBody);
    return chatReply();
  };
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => DEEPSEEK,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    fetch,
  });
  await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 1000 });
  await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 1000, effort: "off" });
  await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 1000, effort: "high" });
  await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 30000, effort: "high" });

  assert.deepEqual(sent.map((body) => body.max_tokens), [1000, 1000, 1000 + 16384, TRANSPORT.OUTPUT_TOKENS_CEILING]);
  assert.equal(JSON.stringify(sent[1]), JSON.stringify(sent[0]));
  assert.deepEqual(sent[2]?.thinking, { type: "enabled" });
  assert.equal(sent[2]?.reasoning_effort, "high");
});

test("Google 兼容端点回数组形状的额度报错：读出原因，按额度用完处理，不自动重发", async () => {
  let calls = 0;
  const fetch: AiFetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      text: async () => JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } }]),
    };
  };
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => GEMINI("gemini-3.8-flash"),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    fetch,
  });
  const error = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }).then(
    () => assert.fail("应当报错"),
    (failure: TRANSPORT.TransportError) => failure,
  );
  assert.equal(calls, 1);
  assert.equal(error.status, 429);
  assert.equal(error.quotaExhausted, true);
  assert.equal(error.noAutoRetry, true);
  assert.match(error.message, /exceeded your current quota/);
});
