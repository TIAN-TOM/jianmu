// 模型能力：读取和翻页、按地址缓存、后台查询，以及带密钥的 GET 的共同约定。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as CAPS from "../../../../src/core/ai/capabilities.ts";
import type { JsonFetchInit, JsonResponse } from "../../../../src/core/ai/capabilities.ts";
import { PROTOCOLS } from "../../../../src/core/ai/provider/endpoint.ts";
import type { AiSettings, ModelsRequest, ProviderError } from "../../../../src/core/ai/provider/index.ts";
import { normalizeAiSettings } from "../../../helpers/ai-settings.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const anthropicSettings = normalizeAiSettings({
  presetId: "anthropic",
  aiApiKey: "sk-ant-test",
  aiModel: "claude-opus-5-5",
});
const openaiSettings = normalizeAiSettings({
  presetId: "openai",
  aiApiKey: "sk-openai",
  aiModel: "gpt-6-astra",
});

const KEY = "FAKE-KEY-FOR-OFFLINE-TESTS-0001";

// 能力查询只收核对过同意的 GET。用这个的用例不看同意，核对总是通过。
const consented = (send: CAPS.ModelsSend): CAPS.ConsentGuardedSend =>
  CAPS.createConsentGuardedGetter({
    getSettings: async () => ({ dataConsentVersion: 1 }),
    settingsRules: { dataConsentVersion: 1, dataConsentError: "没有确认" },
    send,
  });

// 浏览器里 redirect: "manual" 拿到的响应：类型是 opaqueredirect，状态码 0，读不到 Location。
const opaqueRedirect = (): JsonResponse => ({
  type: "opaqueredirect",
  status: 0,
  ok: false,
  body: null,
  json: async () => ({}),
});

function gatewaySettings(aiBaseUrl: string): AiSettings {
  return normalizeAiSettings({
    presetId: "custom",
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl,
    aiApiKey: KEY,
    aiModel: "claude-test",
  });
}

interface ModelInfoOptions {
  readonly disabled?: boolean;
  readonly betweenTools?: boolean;
  readonly efforts?: readonly string[];
  readonly structured?: boolean;
  readonly maxTokens?: number;
  readonly xhigh?: boolean;
}

/**
 * ModelInfo 的字段和嵌套照模型列表参考文档的示例响应写。
 * 示例里的取值是占位（max_tokens 为 0、各项全为 true），这里换成和
 * 思考对照表一致的值：Opus 5.5 关不掉思考，Sonnet 5.5 最低到 between_tools。
 */
function modelInfo(
  id: string,
  { disabled = true, betweenTools = true, efforts = ["low", "medium", "high", "max"], structured = true, maxTokens = 64000, xhigh = false }: ModelInfoOptions = {},
) {
  const flag = (supported: boolean) => ({ supported });
  return {
    id,
    capabilities: {
      batch: flag(true),
      citations: flag(true),
      code_execution: flag(true),
      context_management: {
        clear_thinking_20251015: flag(true),
        clear_tool_uses_20250919: flag(true),
        compact_20260112: flag(true),
        supported: true,
      },
      effort: {
        high: flag(efforts.includes("high")),
        low: flag(efforts.includes("low")),
        max: flag(efforts.includes("max")),
        medium: flag(efforts.includes("medium")),
        supported: efforts.length > 0,
        xhigh: flag(xhigh || efforts.includes("xhigh")),
      },
      image_input: flag(true),
      pdf_input: flag(true),
      server_tools: { code_execution: flag(true), supported: true, web_search: flag(true) },
      structured_outputs: flag(structured),
      thinking: {
        supported: true,
        types: {
          adaptive: flag(true),
          between_tools: flag(betweenTools),
          disabled: flag(disabled),
          enabled: flag(!disabled),
        },
      },
    },
    created_at: "2026-09-21T00:00:00Z",
    deprecated_at: null,
    display_name: id,
    lifecycle: "active",
    line: id.split("-")[1] || null,
    max_input_tokens: 1000000,
    max_tokens: maxTokens,
    retires_at: null,
    type: "model",
  };
}

function page(items: readonly { readonly id: string }[], { hasMore = false }: { hasMore?: boolean } = {}) {
  return {
    data: items,
    first_id: items[0]?.id ?? null,
    has_more: hasMore,
    last_id: items.at(-1)?.id ?? null,
  };
}

test("从 ModelInfo 读出 thinking 类型、effort 档位、结构化输出和 max_tokens", () => {
  const opus = CAPS.parseModelCapabilities(
    modelInfo("claude-opus-5-5", { disabled: false, betweenTools: false, xhigh: true, maxTokens: 128000 }),
  );
  assert.deepEqual(opus, {
    maxTokens: 128000,
    thinking: { disabled: false, betweenTools: false, adaptive: true },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    structuredOutputs: true,
  });

  const noEffort = CAPS.parseModelCapabilities(modelInfo("claude-haiku-4-5-20251001", { efforts: [] }));
  assert.deepEqual(noEffort?.efforts, []);

  const placeholder = CAPS.parseModelCapabilities(modelInfo("claude-x", { maxTokens: 0 }));
  assert.equal(placeholder?.maxTokens, 0, "0 当作不知道上限");
});

test("不支持思考的模型算作能关掉思考；capabilities 为 null 时返回 null", () => {
  const info = modelInfo("claude-3-haiku-20240307", { disabled: false, betweenTools: false });
  const item = { ...info, capabilities: { ...info.capabilities, thinking: { supported: false, types: {} } } };
  assert.equal(CAPS.parseModelCapabilities(item)?.thinking?.disabled, true);
  assert.equal(CAPS.parseModelCapabilities({ id: "x", capabilities: null }), null);
  assert.equal(CAPS.parseModelCapabilities(null), null);
});

test("Anthropic 模型列表按 has_more 和 last_id 翻页读完", async () => {
  const requests: ModelsRequest[] = [];
  const pages = [
    page([modelInfo("claude-opus-5-5"), modelInfo("claude-sonnet-5-5")], { hasMore: true }),
    page([modelInfo("claude-haiku-4-5-20251001", { efforts: [] })]),
  ];
  const result = await CAPS.listModels({
    settings: anthropicSettings,
    send: async (request) => {
      requests.push(request);
      return pages[requests.length - 1];
    },
  });

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5",
    ],
  );
  assert.equal(requests[0]?.headers["anthropic-version"], "2026-10-21");
  assert.deepEqual(result.ids, ["claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual(Object.keys(result.capabilities).sort(), result.ids);
});

test("游标原地打转或页数太多时停下，不会无限翻页", async () => {
  let calls = 0;
  await CAPS.listModels({
    settings: anthropicSettings,
    send: async () => {
      calls += 1;
      return page([modelInfo("claude-opus-5-5")], { hasMore: true });
    },
  });
  assert.equal(calls, 2, "第二页的 last_id 和上一页一样就停");

  calls = 0;
  await CAPS.listModels({
    settings: anthropicSettings,
    send: async () => {
      calls += 1;
      return page([modelInfo(`claude-m-${calls}`)], { hasMore: true });
    },
  });
  assert.equal(calls, 10);
});

test("OpenAI 的 /models 只发一次，不带翻页参数，也没有能力数据", async () => {
  const requests: ModelsRequest[] = [];
  const result = await CAPS.listModels({
    settings: openaiSettings,
    send: async (request) => {
      requests.push(request);
      return { object: "list", data: [{ id: "gpt-6-astra", object: "model" }, { id: "gpt-5.5", object: "model" }] };
    },
  });
  assert.deepEqual(requests.map((r) => r.url), ["https://api.openai.com/v1/models"]);
  assert.deepEqual(result, { ids: ["gpt-5.5", "gpt-6-astra"], capabilities: {} });
});

test("能力缓存按 API 地址存，过期后要求重新拉取", async () => {
  let clock = 1_000_000;
  const storage = memoryStorage();
  const cache = CAPS.createCapabilityCache({ storage, now: () => clock });
  const capabilities = { "claude-opus-5-5": { maxTokens: 128000, thinking: {}, efforts: ["low"], structuredOutputs: true } };

  assert.deepEqual(await cache.lookup(anthropicSettings), { fresh: false, model: null });
  await cache.save(anthropicSettings, capabilities);
  assert.deepEqual(await cache.lookup(anthropicSettings), { fresh: true, model: capabilities["claude-opus-5-5"] });
  assert.deepEqual(
    await cache.lookup({ ...anthropicSettings, aiModel: "claude-unlisted" }),
    { fresh: true, model: null },
    "列表里没有的模型不用重新拉",
  );
  assert.deepEqual(
    await cache.lookup({ ...anthropicSettings, aiBaseUrl: "https://gateway.example.com" }),
    { fresh: false, model: null },
    "换了地址不沿用",
  );

  clock += CAPS.TTL_MS + 1;
  assert.equal((await cache.lookup(anthropicSettings)).fresh, false);
});

test("拉取失败的记录只保留一小时；只留最近的几个地址；存储出错不抛", async () => {
  let clock = 0;
  const storage = memoryStorage();
  const cache = CAPS.createCapabilityCache({ storage, now: () => clock });
  await cache.save(anthropicSettings, {}, { failed: true });
  assert.equal((await cache.lookup(anthropicSettings)).fresh, true);
  clock += CAPS.FAILURE_TTL_MS + 1;
  assert.equal((await cache.lookup(anthropicSettings)).fresh, false);

  for (let i = 0; i < 12; i += 1) {
    clock += 1;
    await cache.save({ ...anthropicSettings, aiBaseUrl: `https://gw${i}.example.com` }, {});
  }
  const stored = storage.data[CAPS.CAPABILITY_STORAGE_KEY] as Record<string, unknown>;
  assert.equal(Object.keys(stored).length, 8);
  assert.ok(stored["https://gw11.example.com"], "最新的留着");
  assert.equal(stored["https://gw0.example.com"], undefined, "最旧的淘汰");

  const broken = CAPS.createCapabilityCache({
    storage: {
      get: async () => {
        throw new Error("No SW");
      },
      set: async () => {
        throw new Error("No SW");
      },
    },
  });
  assert.deepEqual(await broken.lookup(anthropicSettings), { fresh: false, model: null });
  await assert.doesNotReject(() => broken.save(anthropicSettings, {}));
});

test("后台的能力查询：缓存命中不拉，并发请求只拉一次，非 Anthropic 不拉", async () => {
  const storage = memoryStorage();
  let lists = 0;
  let release!: (value?: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const resolve = CAPS.createCapabilityResolver({
    storage,
    send: consented(async () => {
      lists += 1;
      await gate;
      return page([modelInfo("claude-opus-5-5", { disabled: false, betweenTools: false })]);
    }),
  });

  assert.equal(await resolve(openaiSettings), null);
  assert.equal(lists, 0);

  const pending = [resolve(anthropicSettings), resolve(anthropicSettings), resolve(anthropicSettings)];
  release();
  const results = await Promise.all(pending);
  assert.equal(lists, 1, "几个分块同时请求只拉一次列表");
  for (const result of results) assert.equal(result?.thinking?.disabled, false);

  await resolve(anthropicSettings);
  assert.equal(lists, 1, "缓存还新鲜，不再拉");
  assert.equal(await resolve({ ...anthropicSettings, aiModel: "claude-unlisted" }), null);
  assert.equal(lists, 1);
});

test("核对同意的 GET：版本对得上才发，对不上报 NO_DATA_CONSENT，不发", async () => {
  const sent: unknown[][] = [];
  let version: unknown = 2;
  const get = CAPS.createConsentGuardedGetter({
    getSettings: async () => ({ dataConsentVersion: version }),
    settingsRules: { dataConsentVersion: 2, dataConsentError: "请先确认数据说明" },
    send: async (...args) => {
      sent.push(args);
      return "回复";
    },
  });
  const request: ModelsRequest = { url: "https://api.example.com/models", headers: {} };

  assert.equal(await get(request, anthropicSettings), "回复");
  assert.deepEqual(sent, [[request, anthropicSettings]]);

  for (version of [0, 1, 3, undefined]) {
    await assert.rejects(() => get(request, anthropicSettings), { code: "NO_DATA_CONSENT", message: "请先确认数据说明" });
  }
  assert.equal(sent.length, 1);
});

test("能力查询只收核对过同意的 GET，裸的 GET 过不了类型检查", () => {
  const rawGetterRefused: CAPS.ModelsSend extends CAPS.CapabilityResolverDeps["send"] ? false : true = true;
  assert.equal(rawGetterRefused, true);
});

test("后台的能力查询：拉取失败返回 null，一小时内不再重试", async () => {
  let clock = 0;
  let lists = 0;
  const logs: unknown[][] = [];
  const resolve = CAPS.createCapabilityResolver({
    storage: memoryStorage(),
    now: () => clock,
    log: (...args) => logs.push(args),
    send: consented(async () => {
      lists += 1;
      throw Object.assign(new Error("not found"), { status: 404 });
    }),
  });
  assert.equal(await resolve(anthropicSettings), null);
  assert.equal(await resolve(anthropicSettings), null);
  assert.equal(lists, 1);
  assert.equal(logs.length, 1);
  clock += CAPS.FAILURE_TTL_MS + 1;
  await resolve(anthropicSettings);
  assert.equal(lists, 2);
});

test("后台的 GET 带鉴权头，非 2xx 抛出带 status 的错误", async () => {
  const seen: { url: string; init: JsonFetchInit }[] = [];
  const get = CAPS.createJsonGetter(async (url, init) => {
    seen.push({ url, init });
    return url.includes("bad")
      ? { ok: false, status: 401, json: async () => ({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) }
      : { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  assert.deepEqual(await get({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": "k" } }), { data: [] });
  assert.equal(seen[0]?.init.headers["x-api-key"], "k");
  assert.ok(seen[0]?.init.signal, "带超时信号");
  await assert.rejects(
    () => get({ url: "https://bad.example.com/v1/models", headers: {} }),
    (error: ProviderError) => error.status === 401 && error.message === "invalid x-api-key",
  );
});

test("后台读取模型能力同样不跟随重定向", async () => {
  const inits: JsonFetchInit[] = [];
  const settings = gatewaySettings("https://relay.example.com");
  const send = CAPS.createJsonGetter(async (_url, init) => {
    inits.push(init);
    return opaqueRedirect();
  });
  await assert.rejects(
    CAPS.listModels({ settings, send }),
    (error: ProviderError) => error.code === "AI_REDIRECT_BLOCKED",
  );
  assert.deepEqual(inits.map((init) => init.redirect), ["manual"]);
});

test("模型能力的报错同样脱敏", async () => {
  const settings = gatewaySettings("https://relay.example.com");
  const send = CAPS.createJsonGetter(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: `invalid x-api-key ${KEY}` } }),
  }));
  const error = (await CAPS.listModels({ settings, send }).catch((caught: unknown) => caught)) as ProviderError;
  assert.equal(error.status, 401);
  assert.equal(error.message, "invalid x-api-key [已隐藏的密钥]");
});

test("2xx 的响应体读失败时抛出，不当成空列表", async () => {
  const send = CAPS.createJsonGetter(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("响应体不完整");
    },
  }));
  await assert.rejects(() => send({ url: "https://api.example.com/v1/models", headers: {} }, undefined), SyntaxError);
});
