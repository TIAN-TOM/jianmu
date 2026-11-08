// 模型服务接线：传输层按设置规则建，按功能和按任务取模型，模型能力和参数放宽的缓存，密钥、同意和清除闸门的约定。
// 设置读取、传输层和能力查询都是真的，只有网络换成替身；经路由的几条走真实的后台分发。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as AI from "../../../src/background/ai.ts";
import { createAiWiring, type AiWiringDeps } from "../../../src/background/ai.ts";
import { createApp } from "../../../src/background/app.ts";
import * as CAPS from "../../../src/core/ai/capabilities.ts";
import { PROTOCOLS } from "../../../src/core/ai/provider/index.ts";
import type { CompletionRequest, TransportError } from "../../../src/core/ai/transport/index.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { DATA_CONSENT_ERROR } from "../../../src/core/consent.ts";
import type { FrozenGen } from "../../../src/core/tasks.ts";
import { createLocks } from "../../../src/platform/locks.ts";
import { createPermissions } from "../../../src/platform/permissions.ts";
import { createSettingsStore } from "../../../src/platform/settings-store.ts";
import { API_KEY_SESSION_KEY, CAPABILITY_STORAGE_KEY, RELAX_STORAGE_KEY, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import * as SETTINGS from "../../../src/shared/settings-schema.ts";
import { createFakeChrome, senders, type FakeChrome } from "../../helpers/chrome.ts";
import { nextTurn } from "../../helpers/deferred.ts";
import {
  anthropicReply,
  chatReply,
  hangUntilAborted,
  keyedStorage,
  modelService,
  reply,
  SAMPLE_KEY,
  type ModelService,
  type ServiceHandler,
} from "../../helpers/fake-model-service.ts";
import { until } from "../../helpers/wait-until.ts";

const DEEPSEEK = { presetId: "deepseek", aiModel: "deepseek-v4-flash" };
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const ANTHROPIC = { presetId: "anthropic", aiModel: "claude-sonnet-5-5" };
const ANTHROPIC_ORIGIN = "https://api.anthropic.com/";
const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://api.example.com/v1", aiModel: "m-default" };
const GATEWAY_ORIGIN = "https://api.example.com/";
const GRANTED = [DEEPSEEK_ORIGIN, ANTHROPIC_ORIGIN, GATEWAY_ORIGIN, "https://gateway.example.com/", "https://api.openai.com/"];

const EXPLAIN: CompletionRequest = {
  feature: "explain",
  messages: [
    { role: "system", content: "解释选中的词" },
    { role: "user", content: "词：上下文" },
  ],
  maxTokens: 512,
  temperature: 0.3,
};

interface Setup {
  readonly local?: Record<string, unknown>;
  readonly session?: Record<string, unknown>;
  readonly granted?: readonly string[];
  readonly handler?: ServiceHandler;
  readonly wiring?: Partial<AiWiringDeps>;
}

/** 一个后台：真实的路由和接线，外加一份直接拿得到的接线，存储、授权和网络替身两边共用。 */
function setup({ local = {}, session = {}, granted = GRANTED, handler, wiring = {} }: Setup = {}) {
  const service: ModelService = modelService(handler);
  const fake: FakeChrome = createFakeChrome({ local, session, grantedOrigins: granted, fetch: service.fetch });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const storage = { local: fake.local, session: fake.session };
  const clearGuard = createClearGuard();
  const ai = createAiWiring({
    settings: createSettingsStore({ storage, locks: createLocks() }),
    storage,
    permissions: createPermissions(fake.chrome.permissions, () => ({})),
    fetch: service.fetch,
    clearGuard,
    prompts: {},
    ...wiring,
  });
  const ask = (type: string, sender = senders.panel(), req: unknown = {}) => app.dispatch({ type, req }, sender);
  return { fake, app, ai, service, clearGuard, ask };
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: TransportError) => {
    assert.equal(error.code, code, error.message);
    return true;
  });

/** Anthropic 模型列表的一页，带能力字段。 */
function modelPage(ids: readonly string[], hasMore = false) {
  const capabilities = {
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true }, xhigh: { supported: true } },
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { adaptive: { supported: true }, between_tools: { supported: true }, disabled: { supported: false } } },
  };
  const data = ids.map((id) => ({ id, type: "model", max_tokens: 64000, capabilities }));
  return reply({ data, has_more: hasMore, first_id: ids[0], last_id: ids.at(-1) });
}

const isModelList = (url: string) => url.includes("/models");

test("Claude 官方：后台先拉一次模型能力再发请求，之后直接用缓存", async () => {
  const { ai, service, fake } = setup({
    ...keyedStorage(ANTHROPIC, ANTHROPIC_ORIGIN),
    handler: ({ url }) => (isModelList(url) ? modelPage(["claude-sonnet-5-5"]) : anthropicReply("解释")),
  });

  assert.equal((await ai.requestAiCompletion(EXPLAIN)).text, "解释");
  assert.deepEqual(
    service.sent.map((request) => request.url),
    ["https://api.anthropic.com/v1/models?limit=1000", "https://api.anthropic.com/v1/messages"],
  );
  assert.equal(service.sent[0]?.headers["x-api-key"], SAMPLE_KEY);
  const body = service.sent[1]?.body;
  assert.deepEqual(body?.thinking, { type: "between_tools" });
  assert.deepEqual(body?.output_config, { effort: "low" });
  assert.equal(body && "temperature" in body, false);

  await ai.requestAiCompletion(EXPLAIN);
  assert.equal(service.sent.length, 3, "能力已缓存，第二次不再拉列表");
  assert.ok((fake.local.data[CAPABILITY_STORAGE_KEY] as Record<string, unknown>)["https://api.anthropic.com"]);
});

test("后台把放宽结果存进 storage.session，被回收后醒来不必再挨一次 400", async () => {
  const gateway = { presetId: "custom", protocol: PROTOCOLS.ANTHROPIC, aiBaseUrl: "https://gateway.example.com", aiModel: "gateway-claude-latest" };
  const stored = keyedStorage(gateway, "https://gateway.example.com/");
  // 这个网关没有模型列表，能力拿不到，按型号名判断；按型号名会关掉思考，网关不认这个参数。
  const handler: ServiceHandler = ({ url, body }) => {
    if (isModelList(url)) return reply({}, 404);
    if ((body?.thinking as { type?: string } | undefined)?.type === "disabled") {
      return reply({ type: "error", error: { type: "invalid_request_error", message: '"thinking.type.disabled" is not supported for this model.' } }, 400);
    }
    return anthropicReply("解释");
  };

  const first = setup({ ...stored, handler });
  await first.ai.requestAiCompletion(EXPLAIN);
  assert.equal(first.service.posts().length, 2, "第一次要挨一次参数被拒");
  assert.ok(first.fake.session.data[RELAX_STORAGE_KEY], "放宽结果写进了会话存储");

  // 后台被回收后醒来：本机存储从头来，会话存储还在。
  const revived = setup({ local: stored.local, session: structuredClone(first.fake.session.data), handler });
  await revived.ai.requestAiCompletion(EXPLAIN);
  assert.equal(revived.service.posts().length, 1, "醒来后第一个请求就按放宽后的参数发");
  assert.equal(revived.service.posts()[0]?.body && "thinking" in revived.service.posts()[0]!.body!, false);
});

/** 自定义 OpenAI 兼容地址，按功能另选了模型；模型服务回的都是同一句。 */
function featureSetup(featureModels: Readonly<Record<string, string>>) {
  return setup({ ...keyedStorage({ ...GATEWAY, featureModels }, GATEWAY_ORIGIN), handler: () => chatReply("好") });
}

const modelsOf = (service: ModelService) => service.posts().map((request) => request.body?.model);

test("后台每项功能都用自己的模型：概览、结论、翻译、问答、笔记、划词解释", async () => {
  const ids = SETTINGS.FEATURE_MODEL_SLOTS.map(({ id }) => id);
  assert.deepEqual(ids, ["analysis", "verdict", "rewrite", "qa", "notes", "explain"]);
  const { ai, service } = featureSetup(Object.fromEntries(ids.map((id) => [id, `m-${id}`])));

  for (const feature of ids) await ai.requestAiCompletion({ ...EXPLAIN, feature });
  assert.deepEqual(modelsOf(service), ids.map((id) => `m-${id}`));
});

test("后台：留空的功能回到默认模型，只有设了覆盖的那项换模型", async () => {
  const { ai, service } = featureSetup({ verdict: "m-verdict", explain: "  " });

  for (const feature of ["explain", "rewrite", "analysis", "verdict"]) await ai.requestAiCompletion({ ...EXPLAIN, feature });
  assert.deepEqual(modelsOf(service), ["m-default", "m-default", "m-default", "m-verdict"]);
});

test("切换到别的服务商后，后台不再用原来那家的模型名", async () => {
  // 预设换成 DeepSeek 后，存储里还留着 Anthropic 时代按功能选的模型和它们的归属。
  const { featureModels, featureModelsOwner } = SETTINGS.normalize({ ...ANTHROPIC, featureModels: { explain: "claude-opus-5-5", qa: "claude-haiku" } });
  assert.equal(featureModelsOwner, `anthropic|${ANTHROPIC_ORIGIN}`);
  const { ai, service } = setup({
    ...keyedStorage({ ...DEEPSEEK, featureModels, featureModelsOwner }, DEEPSEEK_ORIGIN),
    handler: () => chatReply("解释"),
  });

  await ai.requestAiCompletion(EXPLAIN);
  await ai.requestAiCompletion({ ...EXPLAIN, feature: "qa" });
  assert.deepEqual(modelsOf(service), ["deepseek-v4-flash", "deepseek-v4-flash"]);
});

test("后台：查模型能力途中取消了确认，模型列表不再翻页", async () => {
  let fake: FakeChrome | undefined;
  const revoke = () => {
    (fake!.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>)["dataConsentVersion"] = 0;
  };
  const restore = () => {
    (fake!.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>)["dataConsentVersion"] = SETTINGS.DATA_CONSENT_CONFIRMED.dataConsentVersion;
  };
  const built = setup({
    ...keyedStorage(ANTHROPIC, ANTHROPIC_ORIGIN),
    // 第一页还在路上时，用户取消了数据说明的确认。
    handler: ({ url }) => {
      revoke();
      return modelPage([`model-${url.length}`], true);
    },
  });
  fake = built.fake;

  await rejectsWith(built.ai.requestAiCompletion(EXPLAIN), "NO_AI_CONFIG");
  assert.deepEqual(built.service.sent.map((request) => request.url), ["https://api.anthropic.com/v1/models?limit=1000"], "只发了取消之前的那一页，模型请求也没发");
  assert.equal(Object.hasOwn(fake.local.data, CAPABILITY_STORAGE_KEY), false, "取消确认不算服务出错，不记一次失败");

  restore();
  const listed = await built.ask("models.list", senders.options());
  assert.deepEqual(listed, { ok: false, code: "NO_DATA_CONSENT", detail: DATA_CONSENT_ERROR });
  assert.equal(built.service.sent.length, 2, "设置页拉列表也只发了取消之前的那一页");
  assert.equal(Object.hasOwn(fake.local.data, CAPABILITY_STORAGE_KEY), false);
});

test("后台：有密钥但没确认数据说明时，配置检查回没设置好，AI 请求一个都不发", async () => {
  const stored = keyedStorage({ ...DEEPSEEK, dataConsentVersion: 0, dataConsentFingerprint: "" }, DEEPSEEK_ORIGIN);
  const { ai, ask, service } = setup({ ...stored, handler: () => chatReply("不该发出") });

  assert.deepEqual(await ask("config.check"), { ok: true, value: { ready: false, errors: [DATA_CONSENT_ERROR] } });
  await rejectsWith(ai.requestAiCompletion(EXPLAIN), "NO_AI_CONFIG");
  assert.equal(((await ask("models.list", senders.options())) as { code?: string }).code, "NO_DATA_CONSENT");
  assert.equal(((await ask("ai.testConnection", senders.options())) as { code?: string }).code, "NO_AI_CONFIG");
  assert.deepEqual(service.sent, []);
});

test("后台：密钥属于当前地址才带上，属于别家时一个请求都不发", async () => {
  const own = setup({ ...keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN), handler: () => chatReply("解释") });
  assert.equal((await own.ai.requestAiCompletion(EXPLAIN)).text, "解释");
  assert.deepEqual(own.service.sent.map((request) => request.url), ["https://api.deepseek.com/chat/completions"]);
  assert.equal(own.service.sent[0]?.headers["Authorization"], `Bearer ${SAMPLE_KEY}`);

  // 密钥是在 OpenAI 那里填的，预设后来换成了 DeepSeek。
  const foreign = setup({ ...keyedStorage(DEEPSEEK, "https://api.openai.com/"), handler: () => chatReply("不该发出") });
  const check = await foreign.ask("config.check");
  assert.equal(check.ok && (check.value as { ready: boolean }).ready, false);
  await rejectsWith(foreign.ai.requestAiCompletion(EXPLAIN), "NO_AI_CONFIG");
  assert.equal(((await foreign.ask("ai.testConnection", senders.options())) as { code?: string }).code, "NO_AI_CONFIG");
  assert.deepEqual(foreign.service.sent, [], "密钥对不上来源时根本不该发请求");
});

test("后台：会话清空后配置检查回没设置好", async () => {
  const stored = keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN);
  const { ask, ai, fake, service } = setup({ ...stored, handler: () => chatReply("不该发出") });
  assert.deepEqual(await ask("config.check"), { ok: true, value: { ready: true, errors: [] } });

  // 同一个后台里会话被清空：不靠记在内存里的那份。
  await fake.session.remove(API_KEY_SESSION_KEY);
  const after = await ask("config.check");
  assert.equal(after.ok && (after.value as { ready: boolean }).ready, false);
  await rejectsWith(ai.requestAiCompletion(EXPLAIN), "NO_AI_CONFIG");

  // 浏览器重启：会话存储从空的开始。
  const restarted = setup({ local: stored.local });
  const reply = await restarted.ask("config.check");
  assert.ok(reply.ok);
  assert.equal((reply.value as { ready: boolean }).ready, false);
  assert.match((reply.value as { errors: string[] }).errors.join(""), /API 密钥/);
  assert.deepEqual(service.sent, []);
});

test("后台：选了记住时 service worker 和浏览器重启后照常能用 AI；没选记住的重启后报没设置好", async () => {
  async function savedThenRestarted(rememberApiKey: boolean) {
    const before = createFakeChrome();
    const store = createSettingsStore({ storage: { local: before.local, session: before.session }, locks: createLocks() });
    const { settingsRevision } = await store.load();
    await store.save({ ...DEEPSEEK, ...SETTINGS.DATA_CONSENT_CONFIRMED, aiApiKey: "sk-ds", rememberApiKey }, settingsRevision);
    await store.confirmActivation();
    // 重启以后本机存储还在，会话存储是空的；新的后台从头建。
    const restarted = setup({ local: structuredClone(before.local.data) });
    const check = await restarted.ask("config.check");
    assert.ok(check.ok);
    return (check.value as { ready: boolean }).ready;
  }

  assert.equal(await savedThenRestarted(true), true);
  assert.equal(await savedThenRestarted(false), false);
});

test("后台请求的超时跟着设置规则里的默认超时走：规则改了，接线建的传输层跟着变", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stored = keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN);

  for (const seconds of [3, SETTINGS.AI_TIMEOUT_SECONDS]) {
    const rules = seconds === SETTINGS.AI_TIMEOUT_SECONDS ? {} : { settingsRules: { ...SETTINGS.settingsRules, timeoutSeconds: seconds } };
    const { ai, service } = setup({ ...stored, handler: hangUntilAborted, wiring: rules });
    // 当场接住结果：失败要等推进计时器才出现，不能留成没人接的拒绝。
    let settled: TransportError | "resolved" | undefined;
    void ai.requestAiCompletion(EXPLAIN).then(
      () => (settled = "resolved"),
      (error: TransportError) => (settled = error),
    );
    const outcome = () => settled;
    assert.ok(await until(() => service.sent.length === 1));

    t.mock.timers.tick(seconds * 1000 - 1);
    await nextTurn();
    assert.equal(outcome(), undefined, `${seconds} 秒：还没到上限`);
    t.mock.timers.tick(1);
    assert.ok(await until(() => outcome() !== undefined), `${seconds} 秒：到上限就停`);
    const error = outcome() as TransportError;
    assert.equal(error.code, "AI_HARD_TIMEOUT");
    assert.ok(error.message.includes(`${seconds} 秒`), error.message);
  }
});

test("路由层拿不到不核对同意的发送：接线不透出原始发送，路由文件也不直接用传输层", () => {
  const { ai } = setup();
  assert.equal(Object.hasOwn(AI, "sendAiRequest"), false);
  for (const name of ["sendAiRequest", "readBoundedAiResponse"]) assert.equal(name in ai, false, name);

  const routesDir = fileURLToPath(new URL("../../../src/background/routes/", import.meta.url));
  for (const file of readdirSync(routesDir)) {
    const source = readFileSync(`${routesDir}${file}`, "utf8");
    assert.doesNotMatch(source, /sendAiRequest|core\/ai\/transport|core\/ai\/capabilities/, file);
  }

  // 模型列表每一页都带密钥，只收核对过同意的 GET：没包过的编译就报错。
  const settings = SETTINGS.normalize({ ...ANTHROPIC, aiApiKey: "sk-x" });
  // @ts-expect-error 没核对同意的 GET 不能拿来拉模型列表
  const unchecked = () => CAPS.listModels({ settings, send: async () => ({}) });
  assert.equal(typeof unchecked, "function");
});

test("模型能力拉到一半清除了缓存：拉回来的能力不写回", async () => {
  let built: ReturnType<typeof setup> | undefined;
  const handler: ServiceHandler = ({ url }) => {
    if (!isModelList(url)) return anthropicReply("解释");
    // 列表还在路上时用户清除了缓存。
    void built!.clearGuard.clear("cache", () => built!.fake.local.remove(CAPABILITY_STORAGE_KEY));
    return modelPage(["claude-sonnet-5-5"]);
  };
  built = setup({ ...keyedStorage(ANTHROPIC, ANTHROPIC_ORIGIN), handler });

  assert.deepEqual(await built.ai.listModels(), { ok: true, value: { ids: ["claude-sonnet-5-5"] } });
  assert.equal(Object.hasOwn(built.fake.local.data, CAPABILITY_STORAGE_KEY), false, "设置页拉的列表");

  await built.ai.requestAiCompletion(EXPLAIN);
  assert.equal(Object.hasOwn(built.fake.local.data, CAPABILITY_STORAGE_KEY), false, "后台发请求前自己拉的列表");
});

const frozenFor = (model: string, baseUrl = "https://api.example.com/v1"): FrozenGen => ({
  feature: "qa",
  baseUrl,
  model,
  effort: "off",
  promptVersion: "1",
});

test("任务按创建时取定的模型发：跑到一半改了按功能选的模型，这个任务照旧", async () => {
  const { ai, service, fake } = featureSetup({ qa: "m-qa" });
  const task = ai.forTask(frozenFor("m-qa"));
  await task.requestAiCompletion(EXPLAIN);

  (fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>)["featureModels"] = { qa: "m-qa-new" };
  await task.requestAiCompletion(EXPLAIN);
  await ai.requestAiCompletion({ ...EXPLAIN, feature: "qa" });
  assert.deepEqual(modelsOf(service), ["m-qa", "m-qa", "m-qa-new"], "新的请求才用新选的模型");
});

test("任务创建后换了服务地址：按密钥错误收尾，不把密钥发到新地址", async () => {
  const { ai, service, fake } = setup({ ...keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN), handler: () => chatReply("好") });
  const task = ai.forTask(frozenFor("deepseek-v4-flash", "https://api.deepseek.com"));
  await task.requestAiCompletion(EXPLAIN);
  assert.equal(service.sent.length, 1);

  // 换成自定义地址，密钥也换成新地址的那把。
  fake.local.data[SETTINGS_STORAGE_KEY] = { ...(fake.local.data[SETTINGS_STORAGE_KEY] as object), ...GATEWAY };
  fake.session.data[API_KEY_SESSION_KEY] = { key: "sk-gateway", origin: GATEWAY_ORIGIN };
  await rejectsWith(task.requestAiCompletion(EXPLAIN), "NO_AI_CONFIG");
  assert.equal(service.sent.length, 1, "一个请求都没发到新地址");
});

test("提示词经注入的读取函数交给服务：读不到的文件名直接报错，不发空提示词", () => {
  const { ai } = setup({ wiring: { prompts: { "explain.md": "## 系统提示词\n解释" } } });
  assert.equal(ai.prompt("explain.md"), "## 系统提示词\n解释");
  assert.throws(() => ai.prompt("missing.md"), /missing\.md/);
  assert.throws(() => ai.prompt("toString"), /toString/);
});

test("建任务时取定生成配置：服务地址、这项功能实际要用的模型、档位关、提示词版本跟着提示词全文走；不发请求", async () => {
  const prompts = { "analysis.md": "概览提示词", "verdict.md": "结论提示词" };
  const { ai, service } = setup({ ...keyedStorage({ ...GATEWAY, featureModels: { verdict: "m-verdict" } }, GATEWAY_ORIGIN), wiring: { prompts } });
  const analysis = await ai.freeze("analysis");
  const verdict = await ai.freeze("verdict");
  assert.deepEqual({ ...analysis, promptVersion: "" }, { feature: "analysis", baseUrl: GATEWAY.aiBaseUrl, model: "m-default", effort: "off", promptVersion: "" });
  assert.equal(verdict.model, "m-verdict");
  assert.match(analysis.promptVersion, /^[0-9a-f]{16}$/);
  assert.notEqual(analysis.promptVersion, verdict.promptVersion);
  assert.equal(service.posts().length, 0);

  const edited = setup({ ...keyedStorage(GATEWAY, GATEWAY_ORIGIN), wiring: { prompts: { ...prompts, "analysis.md": "改过的概览提示词" } } });
  assert.notEqual((await edited.ai.freeze("analysis")).promptVersion, analysis.promptVersion, "改了提示词，版本跟着变");
  await assert.rejects(setup({ wiring: { prompts: {} } }).ai.freeze("qa"), /没有这份提示词/);
});
