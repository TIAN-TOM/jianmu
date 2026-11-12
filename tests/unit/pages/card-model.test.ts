// 卡片：没启用、卡片关着时不显示也不读；读数据只用轻量读取；生成概览只认真实点击，凭登记换到的令牌开始；
// 侧边栏为同一视频起的任务就跟着看进度，结束后重读；换了视频，迟到的结果不渲染。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { createCardModel } from "../../../src/pages/card/model.ts";
import { createPageApi } from "../../../src/pages/shared/api.ts";
import type { ConfigState } from "../../../src/pages/shared/config.ts";
import { videoKey, type VideoRef } from "../../../src/core/video-ref.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";
import { until } from "../../helpers/wait-until.ts";

const FIRST: VideoRef = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 };
const SECOND: VideoRef = { platform: "bilibili", videoId: "BV1Sample002", segment: 1 };
const KEY = videoKey(FIRST);
const READY: ConfigState = { state: "checked", view: { ready: true, errors: [] } };

const guides = (video = KEY, extra: object = {}) => ({
  ok: true,
  value: { mode: "light", video, info: { title: "样例长视频", author: "", description: "", durationSec: 1800 }, official: { status: "ok", summary: "自造的样例总结。", outline: [] }, hasTranscript: false, fromCache: false, ...extra },
});
const task = (id: string, state = "running", video = KEY) => ({ id, kind: "overview", origin: "card", video, state, done: 0, total: 2, phase: "", message: "", createdAt: 1, updatedAt: 1 });
const ANALYSIS = { chapters: [{ title: "样例章节", timestampSeconds: 0 }], verdict: { verdict: "值得看完整视频", summary: "样例结论" } };

function setup(config: ConfigState = READY) {
  const fake = fakeRuntime();
  fake.reply("transcript.get", { value: guides() });
  fake.reply("task.list", { value: { ok: true, value: { tasks: [] } } });
  fake.reply("session.get", { value: { ok: true, value: { session: null } } });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {} });
  const state = signal<ConfigState>(config);
  let url = "https://www.bilibili.com/video/BV1Sample001";
  const model = createCardModel({
    api,
    config: state,
    recheckConfig: async () => undefined,
    currentTab: async () => ({ id: 3, url }),
    parseVideo: (value) => (value.includes("BV1Sample002") ? SECOND : value.includes("BV1Sample001") ? FIRST : null),
    seek: () => undefined,
    timers: { every: () => () => undefined, timeout: (work) => work },
  });
  return { fake, model, state, setUrl: (next: string) => void (url = next) };
}

test("没启用或卡片关着：不显示、不读；打开以后接着读", async () => {
  for (const code of ["NOT_ENABLED", "CARD_DISABLED"] as const) {
    const { fake, model, state } = setup({ state: "failed", failure: { ok: false, code } });
    model.configChanged();
    await model.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(model.view.value.visible, false);
    assert.equal(fake.attempts("transcript.get"), 0, code);

    state.value = READY;
    model.configChanged();
    assert.ok(await until(() => model.view.value.phase === "loaded"));
    assert.equal(model.view.value.visible, true);
    assert.deepEqual(fake.sent.find(({ type }) => type === "transcript.get")?.req, { video: KEY, mode: "light" });
  }
});

test("生成概览只认真实点击，登记换到令牌后凭令牌开始，结果摆出来", async () => {
  const { fake, model } = setup();
  fake.reply("task.start", { value: { ok: true, value: { task: task("t1"), joined: false, token: "one-time" } } });
  fake.reply("overview.start", { value: { ok: true, value: { video: KEY, analysis: ANALYSIS, analysisFailures: [], fromCache: false, failedChunks: 0 } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));

  await model.generate(false);
  assert.equal(fake.attempts("task.start"), 0, "合成的点击不算");

  await model.generate(true);
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.start")?.req, { kind: "overview", video: KEY });
  assert.deepEqual(fake.sent.find(({ type }) => type === "overview.start")?.req, { video: KEY, token: "one-time" });
  assert.deepEqual(model.view.value.analysis, ANALYSIS);
  assert.equal(model.view.value.task, null);
});

test("同一视频已经有任务在跑：接上它看进度，结束后重读", async () => {
  const { fake, model } = setup();
  fake.reply("task.list", { value: { ok: true, value: { tasks: [task("side", "running")] } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.task?.id === "side"));
  assert.equal(model.view.value.task?.external, true);

  fake.reply("transcript.get", { value: guides(KEY, { overview: { analysis: ANALYSIS, analysisFailures: [] } }) });
  fake.broadcast({ type: "task.changed", task: { ...task("side", "completed") } });
  assert.ok(await until(() => model.view.value.task === null && model.view.value.analysis !== null));
  assert.deepEqual(model.view.value.analysis, ANALYSIS);
});

test("换了视频以后，上一个视频迟到的读取结果不渲染", async () => {
  const { fake, model } = setup();
  let release: (value: unknown) => void = () => undefined;
  fake.reply("transcript.get", (req) => ((req as { video: string }).video === KEY ? new Promise((resolve) => (release = resolve)) : guides(videoKey(SECOND))));
  model.configChanged();
  await model.start();
  assert.ok(await until(() => fake.attempts("transcript.get") === 1));
  model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  release(guides(KEY, { info: { title: "旧视频", author: "", description: "", durationSec: 1 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(model.view.value.title, "样例长视频");
  const last = fake.sent.filter(({ type }) => type === "transcript.get").at(-1);
  assert.equal((last?.req as { readonly video?: string } | undefined)?.video, videoKey(SECOND));
});
