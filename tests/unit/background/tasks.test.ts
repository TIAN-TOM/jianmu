// 任务运行：认领时限、等价请求接上、互斥键冲突、取消后占键、跟着页面走的任务、依据定下后再核对，
// 两层保活分开证明，任务表只在内存里。计时器和时钟都是手动推进的，不真等。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { CLAIM_MS, createTaskRunner, PAGES_LEFT, type TaskRunner, type TaskSpec } from "../../../src/background/tasks.ts";
import { ok } from "../../../src/core/errors.ts";
import type { Basis } from "../../../src/core/notes/records.ts";
import type { FrozenGen, TaskView } from "../../../src/core/tasks.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { createKeepAlive, type KeepAlive } from "../../../src/platform/keepalive.ts";
import type { Broadcast } from "../../../src/shared/messages.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, SAMPLE_VIDEO_ID, senders } from "../../helpers/chrome.ts";
import { deferred } from "../../helpers/deferred.ts";
import { createFakeAi } from "../../helpers/fake-ai.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { until } from "../../helpers/wait-until.ts";

const INTERVAL = 20 * 1000;
const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID });
const OTHER_VIDEO = videoKey({ platform: "youtube", videoId: "tube-sample" });
const GEN: FrozenGen = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "fake-model", effort: "off", promptVersion: "p1" };
const MESSAGES = [{ role: "user" as const, content: "概览" }];

const spec = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
  kind: "overview",
  origin: "user",
  video: VIDEO,
  gen: GEN,
  followsPage: false,
  ...overrides,
});

function harness(options: { readonly budgetMs?: (gen: FrozenGen) => number; readonly keepAlive?: KeepAlive } = {}) {
  const timers = manualTimers();
  const broadcasts: Broadcast[] = [];
  const fake = createFakeAi({ replies: { "*": "回复" } });
  let pings = 0;
  const keepAlive =
    options.keepAlive ??
    createKeepAlive({
      ping: () => {
        pings += 1;
      },
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
  let ids = 0;
  const tasks = createTaskRunner({
    ai: fake.ai,
    keepAlive,
    timers,
    broadcast: (message) => void broadcasts.push(message),
    newId: () => `task-${(ids += 1)}`,
    ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}),
  });
  return { tasks, timers, broadcasts, fake, pings: () => pings };
}

async function started(tasks: TaskRunner, value: TaskSpec, subscriber = {}): Promise<TaskView> {
  const registered = await tasks.register(value, subscriber);
  assert.ok("task" in registered, JSON.stringify(registered));
  return registered.task;
}

test("登记后一直没收到生成请求：15 秒后按取消收尾，同一视频可以重新登记", async () => {
  const h = harness();
  await started(h.tasks, spec());
  assert.equal(h.tasks.list().length, 1);

  assert.equal(h.timers.fire(CLAIM_MS), 1);

  assert.deepEqual(h.tasks.list(), []);
  const changed = h.broadcasts.at(-1);
  assert.equal(changed?.type === "task.changed" && changed.task.state, "canceled");
  const again = await h.tasks.register(spec(), {});
  assert.ok("task" in again && again.joined === false, JSON.stringify(again));
});

test("跟着页面走的任务不走认领时限：它在订阅的页面都断开时收尾", async () => {
  const h = harness();
  await started(h.tasks, spec({ kind: "translate", lang: "en", followsPage: true }), { port: "panel-1" });
  assert.equal(h.timers.due(CLAIM_MS), 0);
  h.tasks.unsubscribe("panel-1");
  assert.deepEqual(h.tasks.list(), []);
});

test("登记后先被取消、生成请求才到：不取字幕，直接回已取消", async () => {
  const h = harness();
  const task = await started(h.tasks, spec());
  assert.equal(h.tasks.cancel(task.id)?.state, "canceled");
  assert.deepEqual(h.tasks.list(), [], "没认领就取消的条目不再留在列表里");

  let worked = 0;
  const result = await h.tasks.run(task.id, async () => {
    worked += 1;
    return ok("不该跑到这里");
  });

  assert.deepEqual(result, { ok: false, code: "TASK_CANCELED" });
  assert.equal(worked, 0, "取字幕、发请求都在 work 里，一样都没做");
  assert.equal(h.fake.count(), 0);
  assert.deepEqual(h.tasks.list(), []);
});

test("任务路由不为同一视频重复起任务：相同的接上原任务，配置不同的回已有任务在跑；能查询和取消", async () => {
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, prompts: { "analysis.md": "概览提示词", "verdict.md": "结论提示词" } });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const ask = (type: string, req: unknown) => app.dispatch({ type, req }, senders.panel()) as Promise<unknown>;

  const first = (await ask("task.start", { kind: "overview", video: VIDEO })) as { ok: true; value: { task: TaskView; joined: boolean } };
  const repeated = (await ask("task.start", { kind: "overview", video: VIDEO })) as { ok: true; value: { task: TaskView; joined: boolean } };
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.joined, false);
  assert.equal(repeated.value.joined, true);
  assert.equal(repeated.value.task.id, first.value.task.id);

  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...CONFIRMED, aiModel: "another-model" } });
  assert.deepEqual(await ask("task.start", { kind: "overview", video: VIDEO }), { ok: false, code: "TASK_ALREADY_RUNNING" });

  const listed = (await ask("task.list", {})) as { ok: true; value: { tasks: TaskView[] } };
  assert.deepEqual(
    listed.value.tasks.map(({ id, kind, origin, video, state }) => ({ id, kind, origin, video, state })),
    [{ id: first.value.task.id, kind: "overview", origin: "user", video: VIDEO, state: "running" }],
  );
  assert.equal("key" in (listed.value.tasks[0] ?? {}), false, "互斥键不给页面");

  const canceled = (await ask("task.cancel", { taskId: first.value.task.id })) as { ok: true; value: { task: TaskView } };
  assert.equal(canceled.value.task.state, "canceled");
  assert.ok(fake.calls.broadcasts.some((message) => (message as Broadcast).type === "task.changed" && (message as { task: TaskView }).task.state === "canceled"));
  assert.deepEqual(await ask("task.cancel", { taskId: first.value.task.id }), { ok: false, code: "TASK_NOT_FOUND" });
});

test("认领以后不再按没人认领收掉", async () => {
  const h = harness();
  const task = await started(h.tasks, spec());
  const work = deferred();
  const running = h.tasks.run(task.id, async () => {
    await work.promise;
    return ok("完成");
  });
  h.timers.fire(CLAIM_MS);
  assert.equal(h.tasks.list()[0]?.state, "running");
  work.resolve();
  assert.deepEqual(await running, { ok: true, value: "完成" });
});

test("等价的再登记接上在跑的任务，不另起，也不再问放不放行", async () => {
  const h = harness();
  const first = await started(h.tasks, spec());
  let asked = 0;
  const joined = await h.tasks.register(spec(), {}, {
    admit: () => {
      asked += 1;
      return false;
    },
  });
  assert.deepEqual(joined, { task: first, joined: true });
  assert.equal(asked, 0);
  assert.equal(h.tasks.list().length, 1);
});

test("互斥键被占着：用户发起的交回在跑的任务；自动生成和批次跳过，写明原因", async () => {
  const h = harness();
  const running = await started(h.tasks, spec());
  const other = { gen: { ...GEN, model: "another-model" } };

  assert.deepEqual(await h.tasks.register(spec(other), {}), { conflict: running });
  for (const origin of ["auto", "batch"] as const) {
    const skipped = await h.tasks.register(spec({ ...other, origin }), {});
    assert.ok("conflict" in skipped && skipped.conflict.id === running.id && typeof skipped.skipped === "string" && skipped.skipped.length > 0, origin);
  }
  assert.ok("task" in (await h.tasks.register(spec({ ...other, video: OTHER_VIDEO }), {})), "别的视频不受影响");
  assert.equal(h.tasks.list().length, 2);
});

test("粗筛写结论、批次、来源是自动生成的任务，取消后已经开始的那次收尾前仍占键；用户发起的概览取消后马上让出", async () => {
  const cases = [
    { value: spec({ kind: "triage-verdict" }), holds: true },
    { value: spec({ kind: "batch" }), holds: true },
    { value: spec({ origin: "auto" }), holds: true },
    { value: spec(), holds: false },
    { value: spec({ origin: "card" }), holds: false },
  ];
  for (const { value, holds } of cases) {
    const h = harness();
    const task = await started(h.tasks, value);
    const work = deferred();
    const running = h.tasks.run(task.id, async () => {
      await work.promise;
      return ok("完成");
    }, { autoFinish: true });
    h.tasks.cancel(task.id);
    const again = await h.tasks.register(spec({ ...value, gen: { ...GEN, promptVersion: "p2" } }), {});
    assert.equal("conflict" in again, holds, `${value.kind}/${value.origin}`);
    work.resolve();
    await running;
    if (holds) assert.ok("task" in (await h.tasks.register(spec({ ...value, gen: { ...GEN, promptVersion: "p3" } }), {})), "收尾以后让出来");
  }
});

test("跟着页面走的任务：一个页面断开只退订它，订阅的页面都断开才停；有不跟页面的订阅方就照常跑", async () => {
  const h = harness();
  const translate = spec({ kind: "translate", lang: "en", followsPage: true });
  const task = await started(h.tasks, translate, { port: "panel-1" });
  await started(h.tasks, translate, { port: "panel-2" });
  const signals: AbortSignal[] = [];
  const work = deferred();
  const running = h.tasks.run(task.id, async ({ signal }) => {
    signals.push(signal);
    await work.promise;
    return ok("这一批");
  });
  await until(() => signals.length === 1);

  h.tasks.unsubscribe("panel-1");
  assert.equal(h.tasks.list()[0]?.state, "running", "还有一个页面跟着");
  h.tasks.unsubscribe("panel-2");
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[0]?.reason, PAGES_LEFT, "只停还没开始的部分，已经发出的由服务决定");
  work.resolve();
  await running;

  const pinned = await started(h.tasks, spec({ ...translate, lang: "ja" }), { port: "panel-3" });
  await h.tasks.register(spec({ ...translate, lang: "ja", origin: "auto" }), {});
  h.tasks.unsubscribe("panel-3");
  assert.equal(h.tasks.list().find((item) => item.id === pinned.id)?.state, "running", "自动生成也跟着，页面断开照常跑");
});

test("不跟页面走的任务，页面断开也照常跑完", async () => {
  const h = harness();
  const task = await started(h.tasks, spec(), { port: "panel-1" });
  h.tasks.unsubscribe("panel-1");
  assert.equal(h.tasks.list()[0]?.id, task.id);
});

test("依据定下后按完整的等价键再核对：和别的在跑的任务等价时交回那个任务，否则换上新的键", async () => {
  const h = harness();
  const basis: Basis = { source: "transcript", transcript: { video: VIDEO, kind: "human", lang: "zh-CN", fingerprint: "f1" } };
  const question = { kind: "qa", input: { question: "讲了什么" } } as const;
  const settled = await started(h.tasks, spec({ ...question, basis }));
  const pending = await started(h.tasks, spec(question));
  assert.notEqual(pending.id, settled.id, "依据没定时和依据定了的不等价");

  assert.deepEqual(await h.tasks.rekey(pending.id, basis), { ok: false, conflict: settled });
  const other = await started(h.tasks, spec({ ...question, input: { question: "别的问题" } }));
  assert.deepEqual(await h.tasks.rekey(other.id, basis), { ok: true });
  assert.deepEqual(await h.tasks.register(spec({ ...question, input: { question: "别的问题" }, basis }), {}), { task: other, joined: true }, "换上了新的键");
  assert.deepEqual(await h.tasks.rekey("missing", basis), { ok: false });
});

test("任务状态广播给页面：带种类、来源和视频，不带互斥键", async () => {
  const h = harness();
  const task = await started(h.tasks, spec({ origin: "card" }));
  h.tasks.progress(task.id, { done: 1, total: 3, phase: "generating" });
  const views = h.broadcasts.map((message) => (message.type === "task.changed" ? message.task : null));
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.equal(view?.id, task.id);
    assert.equal(view?.origin, "card");
    assert.equal(view?.video, VIDEO);
    assert.equal(view && "key" in view, false);
  }
  assert.equal(views[1]?.done, 1);
});

test("跑的过程中抛错：取消了回已取消，否则按模型服务的错误换成结果；自动收尾按结果记状态", async () => {
  const h = harness();
  const failing = await started(h.tasks, spec());
  const error = Object.assign(new Error("服务拒绝了这个密钥"), { code: "INVALID_AI_KEY" });
  const result = await h.tasks.run(failing.id, async () => {
    throw error;
  }, { autoFinish: true });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "INVALID_AI_KEY");
  const last = h.broadcasts.at(-1);
  assert.equal(last?.type === "task.changed" && last.task.state, "failed");

  const canceled = await started(h.tasks, spec({ video: OTHER_VIDEO }));
  const outcome = await h.tasks.run(canceled.id, async ({ signal }) => {
    h.tasks.cancel(canceled.id);
    if (signal.aborted) throw new Error("停下了");
    return ok("不会到这里");
  }, { autoFinish: true });
  assert.deepEqual(outcome, { ok: false, code: "TASK_CANCELED" });
  assert.deepEqual(h.tasks.list(), []);
  assert.equal(h.timers.pending(), 0, "认领时限和保活都撤掉了");
});

test("模型请求只经任务的入口发：按冻结的配置发", async () => {
  const h = harness();
  const task = await started(h.tasks, spec({ gen: { ...GEN, model: "frozen-model" } }));
  const result = await h.tasks.run(task.id, async ({ ai, gen }) => {
    const reply = await ai.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });
    return ok({ text: reply.text, model: gen.model });
  }, { autoFinish: true });
  assert.deepEqual(result, { ok: true, value: { text: "回复", model: "frozen-model" } });
  assert.equal(h.fake.calls[0]?.frozen?.model, "frozen-model");
  assert.equal(h.fake.calls[0]?.feature, "analysis");
});

// 两层保活分开证明：模型请求挂着时两层同时在场，分不出是谁在撑。
// 外层用一段不发模型请求、也不调任何扩展接口的等待压出来；内层用比请求短的外层上限压出来。
test("整个任务一份保活：模型请求之间、不发请求也不调扩展接口的等待阶段照样每 20 秒续一次", async () => {
  const h = harness();
  const task = await started(h.tasks, spec());
  const waiting = deferred();
  let requested = false;
  const running = h.tasks.run(task.id, async ({ ai }) => {
    await ai.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });
    requested = true;
    await waiting.promise;
    return ok("完成");
  }, { autoFinish: true });
  await until(() => requested);
  assert.equal(h.pings(), 0);

  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 3);

  waiting.resolve();
  await running;
  assert.equal(h.timers.pending(), 0, "任务收尾就停表");
});

test("每次模型请求另一份保活：整个任务那份过了上限、请求还在途，照样续", async () => {
  const h = harness({ budgetMs: () => 50_000 });
  const task = await started(h.tasks, spec());
  const before = deferred();
  const release = h.fake.hold("analysis");
  const running = h.tasks.run(task.id, async ({ ai }) => {
    await before.promise;
    await ai.requestAiCompletion({ messages: MESSAGES, maxTokens: 64 });
    return ok("完成");
  }, { autoFinish: true });

  h.timers.advance(2 * INTERVAL);
  assert.equal(h.pings(), 2);
  before.resolve();
  await until(() => h.fake.count() === 1);

  h.timers.advance(2 * INTERVAL);
  assert.equal(h.pings(), 4, "60 秒时整个任务那份已过 50 秒上限，请求那份撑到 90 秒");
  h.timers.advance(2 * INTERVAL);
  assert.equal(h.pings(), 4, "请求那份也到了上限，不再续");

  release();
  await running;
});

test("保活上限按冻结的推理档位的硬超时算：关和低档 11 分钟，中档 16 分钟，高档 26 分钟", async () => {
  for (const [effort, minutes] of [["off", 11], ["low", 11], ["medium", 16], ["high", 26]] as const) {
    const h = harness();
    const task = await started(h.tasks, spec({ gen: { ...GEN, effort } }));
    const waiting = deferred();
    const running = h.tasks.run(task.id, async () => {
      await waiting.promise;
      return ok("完成");
    }, { autoFinish: true });
    h.timers.advance(minutes * 60_000 + 10 * INTERVAL);
    assert.equal(h.pings(), Math.ceil((minutes * 60_000) / INTERVAL) - 1, effort);
    waiting.resolve();
    await running;
  }
});

test("任务表只在内存里：存储里没有任务，后台重建以后任务表是空的", async () => {
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, prompts: { "analysis.md": "概览提示词", "verdict.md": "结论提示词" } });
  const first = createApp(fake.deps({ warn() {}, error() {} }));
  const reply = (await first.dispatch({ type: "task.start", req: { kind: "overview", video: VIDEO } }, senders.panel())) as { ok: true; value: { task: TaskView } };
  assert.equal(reply.ok, true);
  const listed = (await first.dispatch({ type: "task.list", req: {} }, senders.panel())) as { ok: true; value: { tasks: TaskView[] } };
  assert.equal(listed.value.tasks.length, 1);

  const stored = JSON.stringify({ local: fake.local.data, session: fake.session.data });
  assert.equal(stored.includes(reply.value.task.id), false, stored);

  const rebuilt = createApp(fake.deps({ warn() {}, error() {} }));
  assert.deepEqual(await rebuilt.dispatch({ type: "task.list", req: {} }, senders.panel()), { ok: true, value: { tasks: [] } });
});
