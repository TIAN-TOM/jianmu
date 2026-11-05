// 参数放宽：放宽记忆、放宽重发，以及放宽项对请求体的影响。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClearGuard, type ClearEpoch, type ClearGuard } from "../../../../src/core/clear-guard.ts";
import { PROTOCOLS } from "../../../../src/core/ai/provider/endpoint.ts";
import * as provider from "../../../../src/core/ai/provider/index.ts";
import type {
  ChatRequest,
  ChatRequestBody,
  ChatRequestInput,
  RelaxMemory,
  RelaxState,
} from "../../../../src/core/ai/provider/index.ts";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import { normalizeAiSettings } from "../../../helpers/ai-settings.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const openaiSettings = normalizeAiSettings({
  presetId: "custom",
  protocol: PROTOCOLS.OPENAI,
  aiApiKey: "sk-test",
  aiBaseUrl: "https://api.example.com/v1",
  aiModel: "some-model",
});

const anthropicSettings = normalizeAiSettings({
  presetId: "anthropic",
  protocol: PROTOCOLS.ANTHROPIC,
  aiApiKey: "sk-ant-test",
  aiBaseUrl: "https://api.anthropic.com",
  aiModel: "claude-test",
});

// 自定义的 Anthropic 兼容地址：继续用 2023-06-01，旧型号照常收 temperature。
const anthropicGatewaySettings = normalizeAiSettings({
  presetId: "custom",
  protocol: PROTOCOLS.ANTHROPIC,
  aiApiKey: "sk-gw-test",
  aiBaseUrl: "https://gateway.example.com",
  aiModel: "claude-test",
});

const responsesSettings = normalizeAiSettings({
  presetId: "openai",
  aiApiKey: "sk-openai",
  aiModel: "gpt-6-astra",
});

const MESSAGES = [
  { role: "system", content: "你是助理" },
  { role: "user", content: "你好" },
];

function responsesRequestFor(model: string, extra: Partial<ChatRequestInput> = {}) {
  return provider.buildChatRequest({
    settings: { ...responsesSettings, aiModel: model },
    messages: MESSAGES,
    maxTokens: 2048,
    temperature: 0.2,
    ...extra,
  });
}

function heldSession(seed: Record<string, unknown>) {
  const session = memoryStorage(seed);
  const gates: { get: Promise<void> | null; remove: Promise<void> | null } = { get: null, remove: null };
  return {
    data: session.data,
    gates,
    get: async (key: string) => {
      const snapshot = await session.get(key);
      if (gates.get) await gates.get;
      return snapshot;
    },
    set: (items: Record<string, unknown>) => session.set(items),
    remove: async (key: string) => {
      if (gates.remove) await gates.remove;
      return session.remove(key);
    },
  };
}

function oldRelaxRecord() {
  return {
    [provider.RELAX_STORAGE_KEY]: {
      [JSON.stringify([PROTOCOLS.ANTHROPIC, "https://api.anthropic.com", "claude-test", "2026-10-21"])]: {
        thinking: "between_tools",
      },
    },
  };
}

// 和后台一样的顺序：先 forget，再经闸门清除存储。
function clearLikeBackground(guard: ClearGuard, memory: Required<RelaxMemory>, session: ReturnType<typeof heldSession>) {
  memory.forget();
  return guard.clear("cache", () => session.remove(provider.RELAX_STORAGE_KEY));
}

test("放宽记忆按协议、API 地址、模型分开记，空的放宽项不记", () => {
  const memory = provider.createRelaxMemory();
  memory.remember(anthropicSettings, { thinking: "between_tools" });
  assert.deepEqual(memory.recall(anthropicSettings), { thinking: "between_tools" });
  assert.deepEqual(memory.recall({ ...anthropicSettings, aiModel: "claude-other" }), {}, "换模型不沿用");
  assert.deepEqual(memory.recall({ ...anthropicSettings, aiBaseUrl: "https://gateway.example.com" }), {}, "换地址不沿用");
  assert.deepEqual(memory.recall({ ...anthropicSettings, protocol: PROTOCOLS.OPENAI }), {}, "换协议不沿用");

  memory.remember(openaiSettings, {});
  assert.deepEqual(memory.recall(openaiSettings), {});

  const recalled = memory.recall(anthropicSettings);
  recalled.temperature = true;
  assert.deepEqual(memory.recall(anthropicSettings), { thinking: "between_tools" }, "调用方改返回值不影响记忆");
});

test("共用的放宽函数：逐项放宽重发，返回响应和最终生效的放宽项", async () => {
  const sent: ChatRequestBody[] = [];
  const relaxed: RelaxState[] = [];
  // 兼容地址才会发 temperature，才走得到第二步放宽。
  const result = await provider.sendChatWithRelax({
    settings: anthropicGatewaySettings,
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
    onRelax: (next) => relaxed.push(next),
    send: async (request) => {
      sent.push(request.body);
      if (request.body.thinking?.type === "disabled") {
        throw Object.assign(new Error('"thinking.type.disabled" is not supported for this model.'), { status: 400 });
      }
      if ("temperature" in request.body) {
        throw Object.assign(new Error("`temperature` is deprecated for this model."), { status: 400 });
      }
      return { content: [{ type: "text", text: "可用" }] };
    },
  });

  assert.equal(sent.length, 3);
  assert.deepEqual(result.data, { content: [{ type: "text", text: "可用" }] });
  assert.deepEqual(result.relax, { thinking: true, temperature: true });
  assert.deepEqual(relaxed, [{ thinking: true }, { thinking: true, temperature: true }]);
});

test("共用的放宽函数：从传入的放宽项开始发，放宽不了的错误原样抛出", async () => {
  const sent: ChatRequestBody[] = [];
  const failure = Object.assign(new Error("overloaded"), { status: 529 });
  await assert.rejects(
    () =>
      provider.sendChatWithRelax({
        settings: anthropicSettings,
        messages: MESSAGES,
        maxTokens: 100,
        temperature: 0.2,
        relax: { thinking: true, temperature: true },
        send: async (request) => {
          sent.push(request.body);
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(sent.length, 1);
  assert.equal("thinking" in (sent[0] as ChatRequestBody), false, "上一轮已放宽的参数不再发送");
  assert.equal("temperature" in (sent[0] as ChatRequestBody), false);
});

test("Responses：放宽项生效后不再发被拒的推理档位、schema 和 temperature", () => {
  const { body } = responsesRequestFor("gpt-6-astra", {
    responseFormat: SCHEMAS.QA_ANSWER,
    relax: { effort: true, format: true },
  });
  assert.equal("reasoning" in body, false);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.equal("temperature" in responsesRequestFor("gpt-4.1", { relax: { temperature: true } }).body, false);
});

test("放宽记忆传了存储就写进去，新建的记忆读得回来", async () => {
  const session = memoryStorage();
  const first = provider.createRelaxMemory({ storage: session });
  await first.ready();
  await first.remember(anthropicSettings, { thinking: "between_tools" });
  assert.deepEqual(session.data[provider.RELAX_STORAGE_KEY], {
    [JSON.stringify([PROTOCOLS.ANTHROPIC, "https://api.anthropic.com", "claude-test", "2026-10-21"])]: {
      thinking: "between_tools",
    },
  });

  // 后台被回收后重新醒来：新的记忆对象，同一个 session 存储。
  const revived = provider.createRelaxMemory({ storage: session });
  assert.deepEqual(revived.recall(anthropicSettings), {}, "读入之前还不知道");
  await revived.ready();
  assert.deepEqual(revived.recall(anthropicSettings), { thinking: "between_tools" });
  assert.deepEqual(revived.recall(anthropicGatewaySettings), {});
});

test("放宽项没变时不重复写存储；存储出错时退回只用内存", async () => {
  const session = memoryStorage();
  let writes = 0;
  const counting = { ...session, set: async (entries: Record<string, unknown>) => { writes += 1; return session.set(entries); } };
  const memory = provider.createRelaxMemory({ storage: counting });
  await memory.ready();
  await memory.remember(anthropicSettings, { thinking: true });
  await memory.remember(anthropicSettings, { thinking: true });
  assert.equal(writes, 1);
  await memory.remember(anthropicSettings, { thinking: true, temperature: true });
  assert.equal(writes, 2);

  const broken = provider.createRelaxMemory({
    storage: {
      get: async () => {
        throw new Error("No SW");
      },
      set: async () => {
        throw new Error("No SW");
      },
    },
  });
  await assert.doesNotReject(() => broken.ready());
  await assert.doesNotReject(async () => broken.remember(anthropicSettings, { thinking: true }));
  assert.deepEqual(broken.recall(anthropicSettings), { thinking: true }, "存不进去也记在内存里");
});

test("读入存储时不让旧记录盖掉内存里更新的放宽项", async () => {
  const key = JSON.stringify([PROTOCOLS.ANTHROPIC, "https://api.anthropic.com", "claude-test", "2026-10-21"]);
  const session = memoryStorage({ [provider.RELAX_STORAGE_KEY]: { [key]: { thinking: "between_tools" } } });
  const memory = provider.createRelaxMemory({ storage: session });
  memory.remember(anthropicSettings, { thinking: true });
  await memory.ready();
  assert.deepEqual(memory.recall(anthropicSettings), { thinking: true });
});

test("共用的放宽函数先读入存储里的放宽项，后台醒来后第一个请求就按放宽后的参数发", async () => {
  const session = memoryStorage();
  const sent: ChatRequestBody[] = [];
  const send = async (request: ChatRequest) => {
    sent.push(request.body);
    if (request.body.thinking?.type === "disabled") {
      throw Object.assign(new Error('"thinking.type.disabled" is not supported for this model.'), { status: 400 });
    }
    return { content: [{ type: "text", text: "可用" }] };
  };
  const args = { settings: anthropicSettings, messages: MESSAGES, maxTokens: 100, send };

  await provider.sendChatWithRelax({ ...args, memory: provider.createRelaxMemory({ storage: session }) });
  assert.equal(sent.length, 2);

  await provider.sendChatWithRelax({ ...args, memory: provider.createRelaxMemory({ storage: session }) });
  assert.equal(sent.length, 3, "新的记忆对象读入存储后一发就成");
  assert.equal("thinking" in (sent[2] as ChatRequestBody), false);
});

test("放宽记忆：请求开始后清除过缓存就不记；清除时 forget 连内存一起清；在写的那一下清除会等它", async () => {
  const guard = createClearGuard();
  const session = memoryStorage();
  const memory = provider.createRelaxMemory({ storage: session, clearGuard: guard });
  await memory.ready();

  const since = memory.epoch();
  await guard.clear("cache", async () => {
    memory.forget();
    await session.remove(provider.RELAX_STORAGE_KEY);
  });
  await memory.remember(anthropicSettings, { thinking: "between_tools" }, { since });
  assert.deepEqual(memory.recall(anthropicSettings), {}, "清除前开始的请求不再记");
  assert.equal(provider.RELAX_STORAGE_KEY in session.data, false);

  await memory.remember(anthropicSettings, { thinking: "between_tools" }, { since: memory.epoch() });
  assert.deepEqual(memory.recall(anthropicSettings), { thinking: "between_tools" });
  memory.forget();
  assert.deepEqual(memory.recall(anthropicSettings), {}, "forget 清掉内存里的");
});

test("sendChatWithRelax：请求开始时记下清除代数，成功后带着它去记放宽项", async () => {
  const EPOCH_AT_START: ClearEpoch = { cache: 7, all: 3 };
  const seen: unknown[] = [];
  const memory: RelaxMemory = {
    ready: async () => {},
    epoch: () => EPOCH_AT_START,
    recall: () => ({}),
    remember: (_settings, _relax, options) => {
      seen.push(options);
    },
  };
  await provider.sendChatWithRelax({
    settings: anthropicSettings,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 10,
    memory,
    send: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.deepEqual(seen, [{ since: EPOCH_AT_START }]);
});

test("放宽记忆：清除之前就在读的那份存储，清除之后才读回来，不再填进内存，也不随下次记录写回", async () => {
  const guard = createClearGuard();
  const session = heldSession(oldRelaxRecord());
  let release = () => {};
  session.gates.get = new Promise((resolve) => {
    release = resolve;
  });
  const memory = provider.createRelaxMemory({ storage: session, clearGuard: guard });
  const reading = memory.ready();
  const clearing = clearLikeBackground(guard, memory, session);
  release();
  await Promise.all([reading, clearing]);
  assert.deepEqual(memory.recall(anthropicSettings), {}, "旧记录没有回到内存");

  await memory.remember(anthropicGatewaySettings, { thinking: true }, { since: memory.epoch() });
  const saved = session.data[provider.RELAX_STORAGE_KEY] as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved).length, 1, "写回的只有清除之后记下的这一条");
  assert.equal(JSON.stringify(saved).includes("between_tools"), false);
});

test("放宽记忆：清除进行中（代数已加、存储还没删）才开始的读取，等清完再读，读不到旧记录", async () => {
  const guard = createClearGuard();
  const session = heldSession(oldRelaxRecord());
  let release = () => {};
  session.gates.remove = new Promise((resolve) => {
    release = resolve;
  });
  const memory = provider.createRelaxMemory({ storage: session, clearGuard: guard });
  const clearing = clearLikeBackground(guard, memory, session);
  const reading = memory.ready();
  release();
  await Promise.all([clearing, reading]);
  assert.deepEqual(memory.recall(anthropicSettings), {});
  assert.equal(provider.RELAX_STORAGE_KEY in session.data, false);
});

// 写存储的那一段可以按住，看清除和写入谁等谁。
function heldWrites(session: ReturnType<typeof heldSession>) {
  let started = () => {};
  let release = () => {};
  const writeStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { writes: 0, writeStarted, release: () => release() };
  const storage = {
    ...session,
    set: async (items: Record<string, unknown>) => {
      state.writes += 1;
      started();
      await gate;
      return session.set(items);
    },
  };
  return { state, storage };
}

test("放宽记忆：排队写存储时清除开始了，这次不写", async () => {
  const guard = createClearGuard();
  const session = heldSession({});
  const { state, storage } = heldWrites(session);
  state.release();
  const memory = provider.createRelaxMemory({ storage, clearGuard: guard });
  await memory.ready();

  const writing = memory.remember(anthropicSettings, { thinking: "between_tools" }, { since: memory.epoch() });
  const clearing = clearLikeBackground(guard, memory, session);
  await Promise.all([writing, clearing]);
  assert.equal(state.writes, 0, "写之前清除已经开始，不该再写");
  assert.equal(provider.RELAX_STORAGE_KEY in session.data, false);
});

test("放宽记忆：写到一半清除开始了，清除等写完再删，存储里不留记录", async () => {
  const guard = createClearGuard();
  const session = heldSession({});
  const { state, storage } = heldWrites(session);
  const memory = provider.createRelaxMemory({ storage, clearGuard: guard });
  await memory.ready();

  const writing = memory.remember(anthropicSettings, { thinking: "between_tools" }, { since: memory.epoch() });
  await state.writeStarted;
  const clearing = clearLikeBackground(guard, memory, session);
  state.release();
  await Promise.all([writing, clearing]);
  assert.equal(state.writes, 1);
  assert.equal(provider.RELAX_STORAGE_KEY in session.data, false, "清除没等写完的话，这条会留在存储里");
});
