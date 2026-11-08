// 模型服务的三条路由：配置检查、拉模型列表、测试连接。请求形状、回复里有什么、发出去的请求有多大。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { createContentTabs } from "../../../../src/background/content-tabs.ts";
import { createRouter } from "../../../../src/background/router.ts";
import { aiRoutes } from "../../../../src/background/routes/ai.ts";
import { createSenders } from "../../../../src/background/senders.ts";
import { CAPABILITY_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { createFakeChrome, EXTENSION_ID, extensionUrl, senders } from "../../../helpers/chrome.ts";
import { createFakeAi } from "../../../helpers/fake-ai.ts";
import { chatReply, keyedStorage, modelService, reply, SAMPLE_KEY, type ServiceHandler } from "../../../helpers/fake-model-service.ts";

const DEEPSEEK = { presetId: "deepseek", aiModel: "deepseek-v4-flash" };
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const ANTHROPIC_ORIGIN = "https://api.anthropic.com/";

function appWith(stored: { local?: Record<string, unknown>; session?: Record<string, unknown> }, handler?: ServiceHandler, granted = [DEEPSEEK_ORIGIN, ANTHROPIC_ORIGIN]) {
  const service = modelService(handler);
  const fake = createFakeChrome({ ...stored, grantedOrigins: granted, fetch: service.fetch });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  return { app, fake, service, ask: (type: string, sender = senders.options(), req: unknown = {}) => app.dispatch({ type, req }, sender) };
}

test("测试连接只收空请求或带一个认得的功能，别的形状不交给模型", async () => {
  const fake = createFakeAi({ replies: { "*": "可用" } });
  const chrome = createFakeChrome();
  const router = createRouter({
    routes: aiRoutes({ ai: fake.ai }),
    ports: {},
    senders: createSenders({ extensionId: EXTENSION_ID, extensionUrl, rules: chrome.siteRules }),
    enabled: async () => true,
    cardEnabled: async () => true,
    contentTabs: createContentTabs(),
    openPanel: async () => true,
    log: { warn() {}, error() {} },
  });
  const probe = (req: unknown) => router.dispatch({ type: "ai.testConnection", req }, senders.options());

  for (const req of [{ feature: "unknown" }, { feature: "qa", extra: 1 }, { model: "m" }, [], null, "qa"]) {
    assert.deepEqual(await probe(req), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.equal(fake.count(), 0);

  assert.deepEqual(await probe({}), { ok: true, value: { model: "fake-model", reply: "可用" } });
  assert.equal((await probe({ feature: "qa" })).ok, true);
  assert.deepEqual(fake.calls.map((call) => call.feature), [undefined, "qa"]);
});

test("配置检查卡片也能问，回复里只有能不能用和提示两项，不带设置和密钥", async () => {
  const { ask } = appWith(keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN));
  for (const sender of [senders.card(), senders.panel(), senders.triage()]) {
    const check = await ask("config.check", sender);
    assert.deepEqual(check, { ok: true, value: { ready: true, errors: [] } });
    assert.equal(JSON.stringify(check).includes(SAMPLE_KEY), false);
  }
  for (const sender of [senders.content(), senders.otherPage()]) assert.deepEqual(await ask("config.check", sender), { ok: false, code: "FORBIDDEN" });
});

test("测试连接只发一次很小的请求，回模型名和头几个字；空回复不加码重试", async () => {
  const handler: ServiceHandler = ({ body }) => (body?.model === "m-empty" ? reply({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) : chatReply("可用，连接正常。这是一句比三十个字长得多的回复，后面这些不用带回去"));
  const { ask, service } = appWith(keyedStorage({ ...DEEPSEEK, featureModels: { qa: "m-qa", notes: "m-empty" } }, DEEPSEEK_ORIGIN), handler);

  const plain = await ask("ai.testConnection");
  assert.ok(plain.ok);
  assert.equal((plain.value as { model: string }).model, "deepseek-v4-flash");
  assert.equal((plain.value as { reply: string }).reply.length, 30);
  assert.equal(service.sent[0]?.body?.max_tokens, 1024);

  const qa = await ask("ai.testConnection", senders.options(), { feature: "qa" });
  assert.equal(qa.ok && (qa.value as { model: string }).model, "m-qa");

  const empty = await ask("ai.testConnection", senders.options(), { feature: "notes" });
  assert.equal(empty.ok ? "ok" : empty.code, "EMPTY_AI_RESPONSE");
  assert.deepEqual(service.posts().map((request) => request.body?.model), ["deepseek-v4-flash", "m-qa", "m-empty"], "空回复只发了一次");
});

test("拉模型列表按已保存的设置拉，Anthropic 的能力顺带存下；没填密钥、没授权时一个请求都不发", async () => {
  const anthropic = { presetId: "anthropic", aiModel: "" };
  const page = reply({ data: [{ id: "claude-a", capabilities: { thinking: { supported: false } } }, { id: "claude-b" }], has_more: false });
  const listed = appWith(keyedStorage(anthropic, ANTHROPIC_ORIGIN), () => page);
  assert.deepEqual(await listed.ask("models.list"), { ok: true, value: { ids: ["claude-a", "claude-b"] } });
  assert.deepEqual(Object.keys(listed.fake.local.data[CAPABILITY_STORAGE_KEY] as object), ["https://api.anthropic.com"]);

  const noKey = appWith({ local: keyedStorage(anthropic, ANTHROPIC_ORIGIN).local }, () => page);
  assert.equal(((await noKey.ask("models.list")) as { code?: string }).code, "NO_AI_CONFIG");
  const notGranted = appWith(keyedStorage(anthropic, ANTHROPIC_ORIGIN), () => page, []);
  assert.equal(((await notGranted.ask("models.list")) as { code?: string }).code, "NEED_HOST_PERMISSION");
  assert.deepEqual([...noKey.service.sent, ...notGranted.service.sent], []);

  for (const sender of [senders.panel(), senders.triage(), senders.card()]) {
    assert.deepEqual(await listed.ask("models.list", sender), { ok: false, code: "FORBIDDEN" });
    assert.deepEqual(await listed.ask("ai.testConnection", sender), { ok: false, code: "FORBIDDEN" });
  }
});
