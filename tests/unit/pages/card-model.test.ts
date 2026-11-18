// 卡片：没启用、卡片关着时不显示也不读；读数据只用轻量读取；生成概览只认真实点击，凭登记换到的令牌开始；
// 侧边栏为同一视频起的任务就跟着看进度，结束后重读；换了视频，迟到的结果不渲染。
// 展开收起跟着模式（PRD 6.5）：速览展开、精读收起，手动展开收起过的为准；收起时不读，后台标签页第一次到前台才读。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { createCardModel, NEED_LOGIN_TEXT } from "../../../src/pages/card/model.ts";
import { createPageApi } from "../../../src/pages/shared/api.ts";
import type { ConfigState } from "../../../src/pages/shared/config.ts";
import { videoKey, type VideoRef } from "../../../src/core/video-ref.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

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

function setup(config: ConfigState = READY, page?: { visible(): boolean; onVisible(run: () => void): () => void }) {
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
    ...(page ? { page } : {}),
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

test("打开就出结论自动起的任务：卡片不点也跟上进度、标出是自动的，结束后摆出结论；没有任务时和平时一样", async () => {
  const { fake, model } = setup();
  model.configChanged();
  await model.start();
  const following = () => model.view.value.task;
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(following(), null);

  fake.broadcast({ type: "task.changed", task: { ...task("auto-1"), origin: "auto" } });
  assert.ok(await until(() => following()?.id === "auto-1"));
  assert.equal(following()?.auto, true);
  assert.equal(following()?.external, true);

  fake.reply("transcript.get", { value: guides(KEY, { overview: { analysis: ANALYSIS, analysisFailures: [] } }) });
  fake.broadcast({ type: "task.changed", task: { ...task("auto-1", "completed"), origin: "auto" } });
  assert.ok(await until(() => model.view.value.task === null && model.view.value.analysis?.verdict?.summary === "样例结论"));
  assert.equal(fake.attempts("task.start"), 0, "卡片自己没有发起");
});

test("收起只管当前视频：换了视频回到展开，接着读新视频", async () => {
  const { fake, model } = setup();
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  await model.toggle();
  assert.equal(model.view.value.collapsed, true);
  fake.reply("transcript.get", { value: guides(videoKey(SECOND)) });
  model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  assert.equal(model.view.value.collapsed, false);
  assert.ok(await until(() => model.view.value.phase === "loaded" && model.view.value.title !== ""));
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

const session = (patch: object = {}) => ({ video: KEY, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0, ...patch });

test("模式决定展开收起：精读（含短视频）收起成一行、不读；速览展开、读", async () => {
  const study = setup();
  study.fake.reply("session.get", { value: { ok: true, value: { session: session({ mode: "study", modeSource: "short" }) } } });
  study.model.configChanged();
  await study.model.start();
  assert.ok(await until(() => study.model.view.value.collapsed));
  assert.ok(await stillFalse(() => study.fake.attempts("transcript.get") > 0), "收起时不读");

  const skim = setup();
  skim.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  skim.model.configChanged();
  await skim.model.start();
  assert.ok(await until(() => skim.model.view.value.phase === "loaded"));
  assert.equal(skim.model.view.value.collapsed, false);
});

test("这个视频里手动展开收起过的为准：精读时手动展开的照样展开，速览时手动收起的照样收起", async () => {
  const opened = setup();
  opened.fake.reply("session.get", { value: { ok: true, value: { session: session({ mode: "study", modeSource: "manual", cardOverride: "expanded" }) } } });
  opened.model.configChanged();
  await opened.model.start();
  assert.ok(await until(() => opened.model.view.value.phase === "loaded"));
  assert.equal(opened.model.view.value.collapsed, false);

  const closed = setup();
  closed.fake.reply("session.get", { value: { ok: true, value: { session: session({ cardOverride: "collapsed" }) } } });
  closed.model.configChanged();
  await closed.model.start();
  assert.ok(await until(() => closed.model.view.value.collapsed));
  assert.equal(closed.fake.attempts("transcript.get"), 0);
});

test("自动切到精读：卡片跟着收起；手动展开过的不动；别的标签页同一视频切了不算", async () => {
  const { fake, model } = setup();
  let mine = session();
  fake.reply("session.get", () => ({ ok: true, value: { session: mine } }));
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));

  // 别的标签页同一视频切到精读：广播里的视频一样，但自己标签页的会话还是速览。
  fake.broadcast({ type: "session.changed", tabId: 99, session: session({ mode: "study", modeSource: "auto", autoSwitched: true }) });
  assert.ok(await until(() => fake.attempts("session.get") === 2));
  assert.ok(await stillFalse(() => model.view.value.collapsed));

  mine = session({ mode: "study", modeSource: "auto", autoSwitched: true });
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => model.view.value.collapsed), "跟着收起");

  await model.toggle();
  assert.equal(model.view.value.collapsed, false);
  mine = { ...mine, cardOverride: "expanded" } as typeof mine;
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => fake.attempts("session.get") === 4));
  assert.ok(await stillFalse(() => model.view.value.collapsed), "手动展开过的不再跟着收");
});

test("后台打开的标签页：第一次切到前台才读", async () => {
  let visible = false;
  let wake: () => void = () => undefined;
  const { fake, model } = setup(READY, {
    visible: () => visible,
    onVisible(run) {
      wake = run;
      return () => undefined;
    },
  });
  model.configChanged();
  await model.start();
  assert.ok(await stillFalse(() => fake.attempts("transcript.get") > 0), "还在后台，不读");
  visible = true;
  wake();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(fake.attempts("transcript.get"), 1);
});

test("没登录：摆出标题，提示登录或导入字幕，不摆「生成概览」", async () => {
  const { fake, model } = setup();
  fake.reply("transcript.get", { value: guides(KEY, { official: { status: "need-login", summary: "", outline: [] }, transcriptError: "NEED_LOGIN" }) });
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.title, "样例长视频");
  assert.equal(model.view.value.needLogin, true);
  assert.equal(model.view.value.notice?.text, NEED_LOGIN_TEXT);

  // 登录以后点重试：重新读，提示和按钮跟着变回来。
  fake.reply("transcript.get", { value: guides() });
  model.retry();
  assert.ok(await until(() => model.view.value.needLogin === false));
  assert.equal(model.view.value.notice, null);
  assert.equal(fake.attempts("transcript.get"), 2);
});
