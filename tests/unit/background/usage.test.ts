// 用量记录：任务里的模型请求按功能记下最近一次服务回报的用量和当时的模型、档位，推理强度预览带出来；
// 测试连接不记；只在会话存储里，两种清除都清掉，清除之前开始的任务回来也不写回。设置页那一行字按服务报了什么照实写。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiWiring } from "../../../src/background/ai.ts";
import { createApp } from "../../../src/background/app.ts";
import { createUsageLog } from "../../../src/background/usage.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { createLocks } from "../../../src/platform/locks.ts";
import { createPermissions } from "../../../src/platform/permissions.ts";
import { createSettingsStore } from "../../../src/platform/settings-store.ts";
import { usageText } from "../../../src/pages/options/form.ts";
import { API_KEY_SESSION_KEY, USAGE_STORAGE_KEY } from "../../../src/shared/names.ts";
import { createFakeChrome, senders } from "../../helpers/chrome.ts";
import { keyedStorage, modelService, reply, SAMPLE_KEY, type ServiceHandler } from "../../helpers/fake-model-service.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const DEEPSEEK = { presetId: "deepseek", aiModel: "deepseek-flash", featureEfforts: { qa: "high" } };
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const PROMPTS = Object.fromEntries(
  ["skim/chapters", "skim/verdict", "study/translation", "study/tidy", "common/qa", "study/note-polish", "study/explain"].map((name) => [`${name}.md`, name]),
);
const ASK = { messages: [{ role: "user", content: "视频里讲了什么" }], maxTokens: 512 };

const answered = (usage?: unknown) => reply({ choices: [{ message: { content: "好" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) });

function setup(handler: ServiceHandler) {
  const service = modelService(handler);
  const { local, session } = keyedStorage(DEEPSEEK, DEEPSEEK_ORIGIN);
  const fake = createFakeChrome({ local, session, grantedOrigins: [DEEPSEEK_ORIGIN], fetch: service.fetch });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const storage = { local: fake.local, session: fake.session };
  const clearGuard = createClearGuard();
  const ai = createAiWiring({
    settings: createSettingsStore({ storage, locks: createLocks() }),
    storage,
    permissions: createPermissions(fake.chrome.permissions, () => ({})),
    fetch: service.fetch,
    clearGuard,
    prompts: PROMPTS,
  });
  const preview = async () => {
    const answer = (await app.dispatch({ type: "ai.effortPreview", req: {} }, senders.options())) as {
      ok: boolean;
      value: { items: { feature: string; lastUsage?: unknown }[] };
    };
    assert.equal(answer.ok, true);
    return Object.fromEntries(answer.value.items.map(({ feature, lastUsage }) => [feature, lastUsage]));
  };
  return { ai, app, fake, clearGuard, preview };
}

test("任务里的请求按功能记下最近一次的用量、模型和实际档位，预览带出来；后一次盖掉前一次", async () => {
  const usages = [
    { prompt_tokens: 3000, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } },
    { prompt_tokens: 2800, completion_tokens: 500 },
  ];
  const { ai, fake, preview } = setup(() => answered(usages.shift()));
  const task = ai.forTask(await ai.freeze("qa"));

  // 用量在回复交回以后才写，按条件等它写下。
  const qaUsage = async () => JSON.stringify((await preview())["qa"]);
  await task.requestAiCompletion(ASK);
  const first = JSON.stringify({ model: "deepseek-flash", effort: "high", usage: { input: 3000, output: 900, reasoning: 700 } });
  assert.ok(await until(async () => (await qaUsage()) === first), await qaUsage());
  assert.equal((await preview())["analysis"], undefined, "没请求过的功能没有");

  await task.requestAiCompletion(ASK);
  const second = JSON.stringify({ model: "deepseek-flash", effort: "high", usage: { input: 2800, output: 500 } });
  assert.ok(await until(async () => (await qaUsage()) === second), await qaUsage());

  // 存下的只有数字、模型和档位：没有请求、回复的内容，也没有密钥。
  const stored = JSON.stringify(fake.session.data[USAGE_STORAGE_KEY]);
  for (const secret of [SAMPLE_KEY, "视频里讲了什么", "好"]) assert.equal(stored.includes(secret), false, secret);
  assert.ok(fake.session.data[API_KEY_SESSION_KEY], "密钥照旧只在它自己的键里");
});

test("服务没回用量时照样记一笔空的，预览说得出来这次请求过", async () => {
  const { ai, preview } = setup(() => answered());
  await ai.forTask(await ai.freeze("explain")).requestAiCompletion(ASK);
  assert.ok(await until(async () => (await preview())["explain"] !== undefined));
  assert.deepEqual((await preview())["explain"], { model: "deepseek-flash", effort: "off", usage: {} });
});

test("测试连接不记用量：它只是探一下，不该盖掉功能真正用的那次", async () => {
  const { ai, fake, preview } = setup(() => answered({ prompt_tokens: 5, completion_tokens: 2 }));
  assert.equal((await ai.testConnection("qa")).ok, true);
  assert.ok(await stillFalse(() => fake.session.data[USAGE_STORAGE_KEY] !== undefined));
  assert.equal((await preview())["qa"], undefined);
});

test("清除缓存和清除全部数据都清掉用量", async () => {
  for (const scope of ["cache", "all"] as const) {
    const { ai, app, fake, preview } = setup(() => answered({ prompt_tokens: 5, completion_tokens: 2 }));
    await ai.forTask(await ai.freeze("qa")).requestAiCompletion(ASK);
    assert.ok(await until(() => fake.session.data[USAGE_STORAGE_KEY] !== undefined), scope);
    assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope } }, senders.options()), { ok: true, value: {} });
    assert.equal(fake.session.data[USAGE_STORAGE_KEY], undefined, scope);
    if (scope === "cache") assert.equal((await preview())["qa"], undefined);
  }
});

test("清除之前开始的任务，清除之后才回来的用量不写回", async () => {
  const session = memoryStorage({});
  const clearGuard = createClearGuard();
  const log = createUsageLog({ storage: session, clearGuard });
  const since = clearGuard.epoch();
  await clearGuard.clear("cache", () => session.remove(USAGE_STORAGE_KEY));
  await log.record("qa", { model: "m", effort: "low", usage: { input: 1 } }, since);
  assert.deepEqual(await log.read(), {});

  await log.record("qa", { model: "m", effort: "low", usage: { input: 1 } }, clearGuard.epoch());
  assert.deepEqual(await log.read(), { qa: { model: "m", effort: "low", usage: { input: 1 } } });
});

test("几项功能的用量差不多同时回来：排队写，哪一项都不丢；存储里认不得的形状当作没有", async () => {
  const session = memoryStorage({});
  const log = createUsageLog({ storage: session, clearGuard: createClearGuard() });
  await Promise.all(["analysis", "verdict", "qa"].map((feature, index) => log.record(feature, { model: "m", effort: "medium", usage: { output: index } }, undefined)));
  assert.deepEqual(Object.keys(await log.read()).sort(), ["analysis", "qa", "verdict"]);

  await session.set({
    [USAGE_STORAGE_KEY]: {
      qa: { model: "m", effort: "最高", usage: {} },
      notes: "坏的",
      explain: { model: "m", effort: "off", note: "随便写的", usage: { input: -3, output: 2 } },
      verdict: { model: "m", effort: "off", note: "unknown", usage: {} },
    },
  });
  assert.deepEqual(await log.read(), {
    explain: { model: "m", effort: "off", usage: { output: 2 } },
    verdict: { model: "m", effort: "off", note: "unknown", usage: {} },
  });
});

test("设置页那一行：报了几项写几项，思考没单独报照实说，服务一项都没报时说没回报；扩展设不了档位时写由服务决定；换过模型带上那次的模型名", () => {
  const item = (usage: object, model = "m") => ({ model: "m", lastUsage: { model, effort: "high" as const, usage } });
  assert.equal(usageText(item({ input: 12345, output: 2345, reasoning: 1800 })), "最近一次（高）：输入 12,345 · 输出 2,345 · 思考 1,800");
  assert.equal(usageText(item({ input: 30, output: 7 })), "最近一次（高）：输入 30 · 输出 7 · 思考没单独报");
  assert.equal(usageText(item({ input: 30, output: 7, reasoning: 0 })), "最近一次（高）：输入 30 · 输出 7 · 思考 0");
  assert.equal(usageText(item({})), "最近一次（高）：服务没回报用量");
  assert.equal(usageText(item({ input: 1, output: 1 }, "old-model")), "最近一次（高，old-model）：输入 1 · 输出 1 · 思考没单独报");
  assert.equal(usageText({ model: "m", lastUsage: { model: "m", effort: "off", note: "unknown", usage: { input: 5, output: 2 } } }), "最近一次（由服务决定）：输入 5 · 输出 2 · 思考没单独报");
  assert.equal(usageText({ model: "m" }), null);
});
