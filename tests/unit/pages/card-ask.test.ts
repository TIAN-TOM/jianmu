// 卡片上的提问：只认真实的提交，问题随登记交，凭换到的令牌开始；回答摆出来，换了视频迟到的不摆；
// 登记回来之前点了停止，登记上了再取消一次、不开始答；别处正在答同一个问题时照实说。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_IDLE, createCardAsk } from "../../../src/pages/card/ask.ts";
import { cardTextOf } from "../../../src/pages/card/text.ts";
import { createPageApi } from "../../../src/pages/shared/api.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";

const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 1 });
const task = (id: string) => ({ id, kind: "qa", origin: "card", video: KEY, state: "running", done: 0, total: 0, phase: "", message: "", createdAt: 1, updatedAt: 1 });
const ENTRY = { id: "qa-1", video: KEY, question: "样例问题", answer: "样例回答 [0:30]", citations: [], clickable: [30], derived: {}, createdAt: 1 };

function setup() {
  const fake = fakeRuntime();
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {} });
  const ask = createCardAsk({ api, video: () => KEY, lang: () => "zh" });
  return { fake, ask };
}

test("只认真实的提交，空问题不问；问题随登记交，凭令牌开始，回答摆出来", async () => {
  const { fake, ask } = setup();
  fake.reply("task.start", { value: { ok: true, value: { task: task("q1"), joined: false, token: "ask-token" } } });
  fake.reply("qa.ask", { value: { ok: true, value: { entry: ENTRY, retrievalMode: "full", historySaved: false } } });
  await ask.ask("样例问题", false);
  await ask.ask("   ", true);
  assert.equal(fake.attempts("task.start"), 0);
  await ask.ask("  样例问题  ", true);
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.start")?.req, { kind: "qa", video: KEY, question: "样例问题" });
  assert.deepEqual(fake.sent.find(({ type }) => type === "qa.ask")?.req, { video: KEY, token: "ask-token" });
  assert.equal(ask.state.value.phase, "done");
  assert.deepEqual(ask.state.value.entry, ENTRY);
  assert.equal(ask.state.value.unsaved, true, "没存进历史照实说");
});

test("换了视频：迟到的回答不摆", async () => {
  const { fake, ask } = setup();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply("task.start", { value: { ok: true, value: { task: task("q2"), joined: false, token: "t2" } } });
  fake.reply("qa.ask", async () => (await gate, { ok: true, value: { entry: ENTRY, retrievalMode: "full" } }));
  const pending = ask.ask("样例问题", true);
  ask.reset();
  release();
  await pending;
  assert.deepEqual(ask.state.value, ASK_IDLE);
});

test("登记的回答回来之前点了停止：登记上了再取消一次，不开始答", async () => {
  const { fake, ask } = setup();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply("task.start", async () => (await gate, { ok: true, value: { task: task("q3"), joined: false, token: "t3" } }));
  fake.reply("task.cancel", { value: { ok: true, value: { task: task("q3") } } });
  const pending = ask.ask("样例问题", true);
  await ask.cancel();
  release();
  await pending;
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.cancel")?.req, { taskId: "q3" });
  assert.equal(fake.attempts("qa.ask"), 0);
  assert.equal(ask.state.value.phase, "idle");
});

test("别处正在答同一个问题：接不上结果，照实说去侧边栏看；登记被拒时说原因", async () => {
  const { fake, ask } = setup();
  fake.reply("task.start", { value: { ok: true, value: { task: task("q4"), joined: true } } });
  await ask.ask("样例问题", true);
  assert.equal(ask.state.value.phase, "failed");
  assert.equal(ask.state.value.error, cardTextOf("zh").askJoined);
  assert.equal(fake.attempts("qa.ask"), 0);

  fake.reply("task.start", { value: { ok: false, code: "CARD_RATE_LIMITED" } });
  await ask.ask("另一个问题", true);
  assert.equal(ask.state.value.phase, "failed");
  assert.equal(ask.state.value.error, cardTextOf("zh").askTooFast, "限频用提问自己的说法");
  assert.equal(ask.state.value.question, "另一个问题", "问题留着，界面放回框里");
});

test("登记期间换了视频：新登记上的任务取消掉，不留没人认领的", async () => {
  const { fake, ask } = setup();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply("task.start", async () => (await gate, { ok: true, value: { task: task("q5"), joined: false, token: "t5" } }));
  fake.reply("task.cancel", { value: { ok: true, value: { task: task("q5") } } });
  const pending = ask.ask("样例问题", true);
  ask.reset();
  release();
  await pending;
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.cancel")?.req, { taskId: "q5" });
  assert.equal(fake.attempts("qa.ask"), 0);
});
