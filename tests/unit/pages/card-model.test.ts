// 卡片：没启用、卡片关着时不显示也不读；读数据只用轻量读取；生成概览只认真实点击，凭登记换到的令牌开始；
// 侧边栏为同一视频起的任务就跟着看进度，结束后重读；换了视频，迟到的结果不渲染。
// 展开收起跟着模式（PRD 6.5）：速读展开、精读收起（播满时长自动切到的精读不算），手动展开收起过的为准；收起时不读，后台标签页第一次到前台才读。
// 新视频的会话还没有时先收着等它定模式，等不到才按速读展开。
// 本窗口的侧边栏开着时让位收起，关上再回来；手动展开收起过的不跟，别的窗口的不算。
// 收着、有章节、侧边栏关着时隔一会儿问一次播放位置，写出播到第几章；打不开侧边栏时在收起的一行上说一句，只在看得见时计时。
// 按钮行在每个视频第一次读完、官方总结有了结果才摆，等不到也有上限；摆出来以后不再收回。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { conclusionOf, PANEL_REFUSED_NOTE } from "../../../src/pages/card/glance.ts";
import { CARD_ROWS, cardRows, chaptersInOrder, createCardModel, NEED_LOGIN_TEXT, NO_CAPTIONS_TEXT, NOT_READ_TEXT } from "../../../src/pages/card/model.ts";
import { canWriteFromOfficial } from "../../../src/pages/card/official-verdict.ts";
import { CARD_HANT } from "../../../src/pages/card/text-hant.ts";
import { cardTextOf } from "../../../src/pages/card/text.ts";
import { createPageApi } from "../../../src/pages/shared/api.ts";
import type { ConfigState } from "../../../src/pages/shared/config.ts";
import { videoKey, type VideoRef } from "../../../src/core/video-ref.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const FIRST: VideoRef = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 };
const SECOND: VideoRef = { platform: "bilibili", videoId: "BV1Sample002", segment: 1 };
const KEY = videoKey(FIRST);
const READY: ConfigState = { state: "checked", view: { ready: true, errors: [] } };
/** 卡片所在的窗口。 */
const WINDOW = 7;

const guides = (video = KEY, extra: object = {}) => ({
  ok: true,
  value: { mode: "light", video, info: { title: "样例长视频", author: "", description: "", durationSec: 1800 }, official: { status: "ok", summary: "自造的样例总结。", outline: [] }, hasTranscript: false, fromCache: false, ...extra },
});
const task = (id: string, state = "running", video = KEY) => ({ id, kind: "overview", origin: "card", video, state, done: 0, total: 2, phase: "", message: "", createdAt: 1, updatedAt: 1 });
const ANALYSIS = { chapters: [{ title: "样例章节", timestampSeconds: 0 }], verdict: { verdict: "值得看完整视频", summary: "样例结论" } };

function setup(config: ConfigState = READY, page?: { visible(): boolean; onVisible(run: () => void): () => void }, { manualWait = false } = {}) {
  const fake = fakeRuntime();
  // 等会话的定时：平时下一轮就到点，这时会话的回复（都是微任务）早处理完了；manualWait 时由测试调 elapse() 才到点。
  const waits = new Set<() => void>();
  // 隔一会儿做一次的定时：由测试调 tick() 才到点。
  const ticks = new Set<() => void>();
  // 播放器播到第几秒，和被问了几次。
  const player = { at: null as number | null, asked: 0 };
  fake.reply("transcript.get", { value: guides() });
  fake.reply("task.list", { value: { ok: true, value: { tasks: [] } } });
  fake.reply("session.get", { value: { ok: true, value: { session: null } } });
  fake.reply("panel.state", { value: { ok: true, value: { open: false } } });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {} });
  const state = signal<ConfigState>(config);
  let url = "https://www.bilibili.com/video/BV1Sample001";
  let windowId = WINDOW;
  const model = createCardModel({
    api,
    config: state,
    recheckConfig: async () => undefined,
    currentTab: async () => ({ id: 3, url, windowId }),
    parseVideo: (value) => (value.includes("BV1Sample002") ? SECOND : value.includes("BV1Sample001") ? FIRST : null),
    seek: () => undefined,
    position: async () => {
      player.asked += 1;
      return player.at;
    },
    timers: {
      every(_ms, run) {
        ticks.add(run);
        return () => void ticks.delete(run);
      },
      timeout: (work) => work,
      after(_ms, run) {
        const fire = (): void => {
          if (waits.delete(fire)) run();
        };
        waits.add(fire);
        if (!manualWait) setImmediate(fire);
        return () => void waits.delete(fire);
      },
    },
    ...(page ? { page } : {}),
  });
  return {
    fake,
    model,
    state,
    setUrl: (next: string) => void (url = next),
    /** 标签页被拖到了另一个窗口。 */
    setWindow: (next: number) => void (windowId = next),
    /** 等会话的定时到点。 */
    elapse: () => [...waits].forEach((fire) => fire()),
    /** 还挂着几个等会话的定时。 */
    waiting: () => waits.size,
    /** 隔一会儿做一次的定时都到点一次。 */
    tick: () => [...ticks].forEach((run) => run()),
    player,
  };
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

test("用官方总结写结论：有官方总结、还没有结论、AI 服务设置好时才能点，只认真实点击，凭令牌开始，写好的结论摆出来；写的时候点停止就取消", async () => {
  const { fake, model } = setup();
  const verdictTask = { ...task("v1"), kind: "verdict" };
  const VERDICT_ONLY = { chapters: [], verdict: { verdict: "可以看", summary: "官方总结写的结论", source: "official" } };
  fake.reply("task.start", { value: { ok: true, value: { task: verdictTask, joined: false, token: "verdict-token" } } });
  fake.reply("verdict.fromOfficial", { value: { ok: true, value: { video: KEY, analysis: VERDICT_ONLY, analysisFailures: [], fromCache: false, failedChunks: 0 } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(canWriteFromOfficial(model.view.value, true), true);
  assert.equal(canWriteFromOfficial(model.view.value, false), false, "AI 服务没设置好不摆");
  assert.equal(canWriteFromOfficial({ ...model.view.value, official: null }, true), false, "没有官方总结不摆");

  await model.fromOfficial(false);
  assert.equal(fake.attempts("task.start"), 0, "合成的点击不算");
  await model.fromOfficial(true);
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.start")?.req, { kind: "verdict", video: KEY });
  assert.deepEqual(fake.sent.find(({ type }) => type === "verdict.fromOfficial")?.req, { video: KEY, token: "verdict-token" });
  assert.deepEqual(model.view.value.analysis, VERDICT_ONLY);
  assert.equal(model.view.value.task, null);
  assert.equal(canWriteFromOfficial(model.view.value, true), false, "有了结论就不再摆");
});

test("用官方总结写结论：登记的回答回来之前就点了停止，登记上了再取消一次，不开始写", async () => {
  const { fake, model } = setup();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply("task.start", async () => (await gate, { ok: true, value: { task: { ...task("v2"), kind: "verdict" }, joined: false, token: "late" } }));
  fake.reply("task.cancel", { value: { ok: true, value: { task: { ...task("v2", "canceled"), kind: "verdict" } } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  const pending = model.fromOfficial(true);
  assert.ok(await until(() => model.view.value.task?.verdict === true));
  await model.cancel();
  release();
  await pending;
  assert.deepEqual(fake.sent.find(({ type }) => type === "task.cancel")?.req, { taskId: "v2" });
  assert.equal(fake.attempts("verdict.fromOfficial"), 0);
  assert.equal(model.view.value.task, null);
});

test("用官方总结写结论：写好但没能存进本机时照样摆出来，说一句没存上；别处给这个视频写好结论时卡片安静重读", async () => {
  const { fake, model } = setup();
  const VERDICT_ONLY = { chapters: [], verdict: { verdict: "可以看", summary: "官方总结写的结论", source: "official" } };
  fake.reply("task.start", { value: { ok: true, value: { task: { ...task("v3"), kind: "verdict" }, joined: false, token: "t3" } } });
  fake.reply("verdict.fromOfficial", { value: { ok: true, value: { video: KEY, analysis: VERDICT_ONLY, analysisFailures: [], fromCache: false, failedChunks: 0, saveFailed: true } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  await model.fromOfficial(true);
  assert.deepEqual(model.view.value.analysis, VERDICT_ONLY);
  assert.deepEqual(model.view.value.notice, { text: cardTextOf("zh").saveFailed, tone: "warn" });

  fake.reply("transcript.get", { value: guides(KEY, { overview: { analysis: ANALYSIS, analysisFailures: [] } }) });
  const before = fake.attempts("transcript.get");
  fake.broadcast({ type: "overview.updated", video: KEY, verdictPending: false });
  assert.ok(await until(() => model.view.value.analysis?.verdict?.summary === "样例结论"));
  assert.equal(fake.attempts("transcript.get"), before + 1);
});

test("侧边栏正在为这个视频用官方总结写结论：卡片接上它的进度，写「正在写一句话结论」", async () => {
  const { fake, model } = setup();
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  fake.broadcast({ type: "task.changed", task: { ...task("side-verdict"), kind: "verdict", origin: "user" } });
  assert.ok(await until(() => model.view.value.task?.id === "side-verdict"));
  assert.equal(model.view.value.task?.verdict, true);
  assert.equal(model.view.value.task?.external, true);
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
  assert.ok(await until(() => model.view.value.phase === "loaded" && model.view.value.title !== ""));
  assert.equal(model.view.value.collapsed, false);
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

test("模式决定展开收起：精读（含短视频）收起成一行、不读；速读展开、读", async () => {
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

test("新视频的会话还没有：先收着不读；会话说是精读就一直收着、一次都不读，说是速读才展开、读", async () => {
  for (const [mode, modeSource] of [["study", "short"], ["skim", "default"]] as const) {
    const { fake, model, waiting } = setup(READY, undefined, { manualWait: true });
    let mine: object | null = null;
    fake.reply("session.get", () => ({ ok: true, value: { session: mine } }));
    model.configChanged();
    await model.start();
    assert.ok(await until(() => fake.attempts("session.get") === 1));
    assert.equal(model.view.value.collapsed, true, "会话还没有，先收着");
    assert.ok(await stillFalse(() => fake.attempts("transcript.get") > 0), "等的时候不读");
    assert.equal(waiting(), 1);

    // 内容脚本报了时长，后台建好会话、定了模式。
    mine = session({ mode, modeSource });
    fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
    assert.ok(await until(() => waiting() === 0), "会话来了就不等了");
    if (mode === "study") {
      assert.equal(model.view.value.collapsed, true);
      assert.ok(await stillFalse(() => fake.attempts("transcript.get") > 0), "短视频从头到尾不读");
    } else {
      assert.ok(await until(() => model.view.value.phase === "loaded"));
      assert.equal(model.view.value.collapsed, false);
      assert.equal(fake.attempts("transcript.get"), 1);
    }
  }
});

test("等够了会话还没来：按速读展开、读；之后会话说是精读再收起", async () => {
  const { fake, model, elapse, waiting } = setup(READY, undefined, { manualWait: true });
  let mine: object | null = null;
  fake.reply("session.get", () => ({ ok: true, value: { session: mine } }));
  model.configChanged();
  await model.start();
  assert.ok(await until(() => fake.attempts("session.get") === 1));
  assert.equal(model.view.value.collapsed, true);
  elapse();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.collapsed, false);
  assert.equal(waiting(), 0);

  mine = session({ mode: "study", modeSource: "short" });
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => model.view.value.collapsed));
});

test("还在等会话时手动点开：马上展开、读，不再等；等着时换了视频，旧的等待作废、为新视频重新等", async () => {
  const clicked = setup(READY, undefined, { manualWait: true });
  clicked.fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  clicked.model.configChanged();
  await clicked.model.start();
  assert.ok(await until(() => clicked.waiting() === 1));
  await clicked.model.toggle();
  assert.equal(clicked.model.view.value.collapsed, false);
  assert.equal(clicked.waiting(), 0);
  assert.ok(await until(() => clicked.model.view.value.phase === "loaded"));
  assert.deepEqual(clicked.fake.sent.find(({ type }) => type === "card.setOverride")?.req, { video: KEY, value: "expanded" });

  const moved = setup(READY, undefined, { manualWait: true });
  moved.fake.reply("transcript.get", { value: guides(videoKey(SECOND)) });
  moved.model.configChanged();
  await moved.model.start();
  assert.ok(await until(() => moved.waiting() === 1));
  moved.model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  assert.equal(moved.waiting(), 1, "旧的取消了，新的挂上");
  assert.equal(moved.model.view.value.collapsed, true);
  moved.elapse();
  assert.ok(await until(() => moved.model.view.value.phase === "loaded"));
  assert.equal((moved.fake.sent.filter(({ type }) => type === "transcript.get").at(-1)?.req as { readonly video?: string }).video, videoKey(SECOND));
  assert.equal(moved.fake.attempts("transcript.get"), 1, "第一个视频没读过");
});

test("这个视频里手动展开收起过的为准：精读时手动展开的照样展开，速读时手动收起的照样收起", async () => {
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

test("在侧边栏切到精读：卡片跟着收起；手动展开过的不动；别的标签页同一视频切了不算", async () => {
  const { fake, model } = setup();
  let mine = session();
  fake.reply("session.get", () => ({ ok: true, value: { session: mine } }));
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));

  // 别的标签页同一视频切到精读：广播里的视频一样，但自己标签页的会话还是速读。
  fake.broadcast({ type: "session.changed", tabId: 99, session: session({ mode: "study", modeSource: "manual" }) });
  assert.ok(await until(() => fake.attempts("session.get") === 2));
  assert.ok(await stillFalse(() => model.view.value.collapsed));

  mine = session({ mode: "study", modeSource: "manual" });
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => model.view.value.collapsed), "跟着收起");

  await model.toggle();
  assert.equal(model.view.value.collapsed, false);
  mine = { ...mine, cardOverride: "expanded" } as typeof mine;
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => fake.attempts("session.get") === 4));
  assert.ok(await stillFalse(() => model.view.value.collapsed), "手动展开过的不再跟着收");
});

test("本窗口的侧边栏开着：速读也收着、不读；关上才展开、读，再打开又让位", async () => {
  const { fake, model } = setup();
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("panel.state", { value: { ok: true, value: { open: true } } });
  model.configChanged();
  await model.start();
  assert.equal(model.view.value.collapsed, true, "一出来就是收起的");
  assert.ok(await stillFalse(() => fake.attempts("transcript.get") > 0), "同一份内容在侧边栏里，卡片不读");

  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.collapsed, false);
  assert.equal(fake.attempts("transcript.get"), 1);

  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: true });
  assert.ok(await until(() => model.view.value.collapsed), "再打开又让位");
  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await until(() => !model.view.value.collapsed));
  assert.equal(fake.attempts("transcript.get"), 1, "读过的不重读");
});

test("侧边栏的开关只认本窗口的；精读时关上侧边栏照样收着；手动展开收起过的不跟侧边栏", async () => {
  const other = setup();
  other.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  other.model.configChanged();
  await other.model.start();
  assert.ok(await until(() => other.model.view.value.phase === "loaded"));
  other.fake.broadcast({ type: "panel.changed", windowId: WINDOW + 1, open: true });
  assert.ok(await stillFalse(() => other.model.view.value.collapsed), "别的窗口开了侧边栏不算");

  const study = setup();
  study.fake.reply("session.get", { value: { ok: true, value: { session: session({ mode: "study", modeSource: "manual" }) } } });
  study.fake.reply("panel.state", { value: { ok: true, value: { open: true } } });
  study.model.configChanged();
  await study.model.start();
  study.fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await stillFalse(() => !study.model.view.value.collapsed), "精读本来就收着");

  const manual = setup();
  manual.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  manual.fake.reply("panel.state", { value: { ok: true, value: { open: true } } });
  manual.fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  manual.model.configChanged();
  await manual.model.start();
  assert.equal(manual.model.view.value.collapsed, true);
  // 会话的回复还在路上就点了：以这一下为准，晚到的回复里没有这次手动展开，不拿它盖。
  await manual.model.toggle();
  assert.ok(await until(() => manual.model.view.value.phase === "loaded"), "侧边栏开着时手动点开，照样展开、读");
  assert.ok(await stillFalse(() => manual.model.view.value.collapsed), "在途的会话回复不把它收回去");
  manual.fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  manual.fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: true });
  assert.ok(await stillFalse(() => manual.model.view.value.collapsed), "手动展开过的不再跟着让位");
});

test("问侧边栏开没开的回复还没到就来了广播：以广播为准；后台答不上来时当关着", async () => {
  const late = setup();
  let answer: (value: unknown) => void = () => undefined;
  late.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  late.fake.reply("panel.state", () => new Promise((resolve) => (answer = resolve)));
  late.model.configChanged();
  const started = late.model.start();
  assert.ok(await until(() => late.fake.attempts("panel.state") === 1));
  late.fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: true });
  // 问的时候还关着，回复比广播晚到。
  answer({ ok: true, value: { open: false } });
  await started;
  assert.ok(await until(() => late.fake.attempts("session.get") === 1));
  assert.ok(await stillFalse(() => !late.model.view.value.collapsed), "广播说开着，旧回复不盖它");

  const failed = setup();
  failed.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  failed.fake.reply("panel.state", { value: { ok: false, code: "FORBIDDEN" } });
  failed.model.configChanged();
  await failed.model.start();
  assert.ok(await until(() => failed.model.view.value.phase === "loaded"));
  assert.equal(failed.model.view.value.collapsed, false);
});

test("标签页拖到另一个窗口：按新窗口重新问侧边栏开没开，之后只认新窗口的开关；问不到当关着", async () => {
  const { fake, model } = setup();
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));

  await model.windowChanged(WINDOW);
  assert.equal(fake.attempts("panel.state"), 1, "窗口没换不重问");

  fake.reply("panel.state", { value: { ok: true, value: { open: true } } });
  await model.windowChanged(WINDOW + 1);
  assert.equal(model.view.value.collapsed, true, "新窗口的侧边栏开着");
  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await stillFalse(() => !model.view.value.collapsed), "原来那个窗口的不算了");

  // 又拖到一个窗口，这次问不到：不沿用上一个窗口的「开着」。
  fake.reply("panel.state", { value: { ok: false, code: "FORBIDDEN" } });
  await model.windowChanged(WINDOW + 2);
  assert.equal(model.view.value.collapsed, false);
  fake.broadcast({ type: "panel.changed", windowId: WINDOW + 2, open: true });
  assert.ok(await until(() => model.view.value.collapsed));
});

test("配置检查的结果比侧边栏的回复先到：等问到侧边栏开没开再定，开着就不展开、不读", async () => {
  const { fake, model, state } = setup({ state: "unknown" });
  let answer: (value: unknown) => void = () => undefined;
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("panel.state", () => new Promise((resolve) => (answer = resolve)));
  model.configChanged();
  const started = model.start();
  assert.ok(await until(() => fake.attempts("panel.state") === 1));
  state.value = READY;
  model.configChanged();
  assert.ok(await stillFalse(() => fake.attempts("session.get") > 0 || fake.attempts("transcript.get") > 0), "还没问到侧边栏，先不定");

  answer({ ok: true, value: { open: true } });
  await started;
  assert.ok(await until(() => fake.attempts("session.get") === 1));
  assert.ok(await stillFalse(() => !model.view.value.collapsed || fake.attempts("transcript.get") > 0), "侧边栏开着：收着，一次都不读");
});

test("标签页回到前台时再问一次侧边栏：开关的广播漏了也补得上", async () => {
  let shown: () => void = () => undefined;
  const page = { visible: () => true, onVisible: (run: () => void) => ((shown = run), () => undefined) };
  const { fake, model } = setup(READY, page);
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.collapsed, false);

  // 切走的这一会儿侧边栏开了，广播没收到。
  fake.reply("panel.state", { value: { ok: true, value: { open: true } } });
  shown();
  assert.ok(await until(() => model.view.value.collapsed));
  assert.equal(fake.attempts("panel.state"), 2);
});

const THREE = { chapters: [{ title: "第二章", timestampSeconds: 120 }, { title: "第一章", timestampSeconds: 0 }, { title: "第三章", timestampSeconds: 300 }], verdict: { verdict: "可以看", summary: "样例结论" } };

test("章节按开始时间排好再数第几章；时间不是数的不算", () => {
  assert.deepEqual(chaptersInOrder(THREE).map((chapter) => chapter.title), ["第一章", "第二章", "第三章"]);
  assert.deepEqual(chaptersInOrder({ chapters: [{ title: " 有空格 ", timestampSeconds: 5 }, { title: "坏的", timestampSeconds: Number.NaN }] }), [{ startSec: 5, title: "有空格" }]);
  assert.deepEqual(chaptersInOrder(null), []);
});

// 只有章节、还没写结论的概览：收起那一行写播放到的章节。
const CHAPTERS_ONLY = { chapters: THREE.chapters };

test("一句话结论：判断词和那句话都有、结论不在写时才算", () => {
  assert.deepEqual(conclusionOf({ analysis: THREE, verdictPending: false }), { label: "可以看", summary: "样例结论" });
  assert.equal(conclusionOf({ analysis: THREE, verdictPending: true }), null, "结论还在写");
  assert.equal(conclusionOf({ analysis: CHAPTERS_ONLY, verdictPending: false }), null);
  assert.equal(conclusionOf({ analysis: { verdict: { verdict: "可以看", summary: "  " } }, verdictPending: false }), null, "只有判断词");
  assert.equal(conclusionOf({ analysis: null, verdictPending: false }), null);
});

test("收着、有章节、没有结论、侧边栏关着时才问播放位置，写出播到第几章；展开、侧边栏开着、没有章节时不问", async () => {
  const { fake, model, tick, player } = setup();
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("transcript.get", { value: guides(KEY, { overview: { analysis: CHAPTERS_ONLY, analysisFailures: [] } }) });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  tick();
  assert.equal(player.asked, 0, "展开着不问");

  player.at = 130;
  await model.toggle();
  assert.ok(await until(() => model.view.value.chapterNow === 1), "收起就问一次，播到第二章");
  assert.equal(player.asked, 1);
  player.at = 301;
  tick();
  assert.ok(await until(() => model.view.value.chapterNow === 2));
  // 问不到（没连上、在播广告）时不写。
  player.at = null;
  tick();
  assert.ok(await until(() => model.view.value.chapterNow === null));

  // 侧边栏开着：那边有当前章节，这边不问，也不留着旧的。
  player.at = 10;
  tick();
  assert.ok(await until(() => model.view.value.chapterNow === 0));
  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: true });
  assert.ok(await until(() => model.view.value.panelOpen && model.view.value.chapterNow === null));
  const asked = player.asked;
  tick();
  assert.equal(player.asked, asked, "侧边栏开着不问");
  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await until(() => model.view.value.chapterNow === 0), "关上接着问");

  await model.toggle();
  assert.equal(model.view.value.chapterNow, null, "展开了就不写了");

  // 没有章节的（只有官方总结）：收着也不问。
  const bare = setup();
  bare.fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  bare.fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  bare.model.configChanged();
  await bare.model.start();
  assert.ok(await until(() => bare.model.view.value.phase === "loaded"));
  await bare.model.toggle();
  bare.tick();
  assert.equal(bare.player.asked, 0);
});

test("本机有一句话结论时收着也不问播放位置：收起那一行写结论，不写章节", async () => {
  const { fake, model, tick, player } = setup();
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("transcript.get", { value: guides(KEY, { overview: { analysis: THREE, analysisFailures: [] } }) });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  player.at = 130;
  await model.toggle();
  assert.ok(await until(() => model.view.value.collapsed));
  tick();
  tick();
  assert.ok(await stillFalse(() => player.asked > 0), "有结论不问");
  assert.equal(model.view.value.chapterNow, null);
});

test("收着时结论写好了：不再问播放位置，抹掉当前章节", async () => {
  const { fake, model, tick, player } = setup();
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  let finish: (value: unknown) => void = () => undefined;
  fake.reply("task.start", { value: { ok: true, value: { task: task("t1"), joined: false, token: "one-time" } } });
  fake.reply("overview.start", () => new Promise((resolve) => (finish = resolve)));
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  void model.generate(true);
  assert.ok(await until(() => fake.attempts("overview.start") === 1));
  fake.broadcast({ type: "overview.preview", taskId: "t1", video: KEY, analysis: CHAPTERS_ONLY, done: 1, total: 2 });
  assert.ok(await until(() => model.view.value.verdictPending !== false));
  player.at = 130;
  await model.toggle();
  assert.ok(await until(() => model.view.value.chapterNow === 1), "章节先到、结论还在写：照旧问");

  finish({ ok: true, value: { video: KEY, analysis: THREE, analysisFailures: [], fromCache: false, failedChunks: 0 } });
  assert.ok(await until(() => conclusionOf(model.view.value) !== null && model.view.value.chapterNow === null));
  const asked = player.asked;
  tick();
  assert.ok(await stillFalse(() => player.asked > asked), "结论到了就不问");
});

test("播满时长自动切到的精读不收卡片：照速读摆，侧边栏开了让位、关上又展开；自己选的精读照样收；刷新时已经是自动切过的精读也展开着", async () => {
  const { fake, model, elapse } = setup(READY, undefined, { manualWait: true });
  let mine = session();
  fake.reply("session.get", () => ({ ok: true, value: { session: mine } }));
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  elapse();

  mine = session({ mode: "study", modeSource: "auto", autoSwitched: true });
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => fake.attempts("session.get") === 2));
  assert.ok(await stillFalse(() => model.view.value.collapsed), "自动切到精读，不收");

  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: true });
  assert.ok(await until(() => model.view.value.collapsed), "侧边栏开着照样让位");
  fake.broadcast({ type: "panel.changed", windowId: WINDOW, open: false });
  assert.ok(await until(() => !model.view.value.collapsed), "关上又展开");

  mine = session({ mode: "study", modeSource: "manual", autoSwitched: true });
  fake.broadcast({ type: "session.changed", tabId: 3, session: mine });
  assert.ok(await until(() => model.view.value.collapsed), "自己选的精读照样收");

  const reloaded = setup(READY, undefined, { manualWait: true });
  reloaded.fake.reply("session.get", { value: { ok: true, value: { session: session({ mode: "study", modeSource: "auto", autoSwitched: true }) } } });
  reloaded.model.configChanged();
  await reloaded.model.start();
  assert.ok(await until(() => reloaded.waiting() === 0));
  assert.equal(reloaded.model.view.value.collapsed, false);
});

test("收起那一行上那句话说出来以后标签页切到后台：到点不收，回到前台从头数，再到点才收回", async () => {
  let visible = true;
  let shown: () => void = () => undefined;
  const page = { visible: () => visible, onVisible: (run: () => void) => ((shown = run), () => undefined) };
  const { fake, model, elapse, waiting } = setup(READY, page, { manualWait: true });
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  elapse();

  await model.toggle();
  model.panelRefused();
  assert.equal(model.view.value.headNote, PANEL_REFUSED_NOTE);
  assert.equal(waiting(), 1, "看得见，开始数");

  visible = false;
  elapse();
  assert.equal(model.view.value.headNote, PANEL_REFUSED_NOTE, "到点时在后台，不收");
  assert.equal(waiting(), 0);

  visible = true;
  shown();
  assert.equal(waiting(), 1, "回到前台从头数");
  elapse();
  assert.equal(model.view.value.headNote, "");
});

test("收起那一行上那句话只在看得见时计时：标签页不在前台时说的，回到前台才开始数；换了视频马上收回", async () => {
  let visible = true;
  let shown: () => void = () => undefined;
  const page = { visible: () => visible, onVisible: (run: () => void) => ((shown = run), () => undefined) };
  const { fake, model, elapse, waiting } = setup(READY, page, { manualWait: true });
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  elapse();
  await model.toggle();
  assert.equal(waiting(), 0);

  visible = false;
  model.panelRefused();
  assert.equal(model.view.value.headNote, PANEL_REFUSED_NOTE);
  assert.equal(waiting(), 0, "看不见时不计时");
  elapse();
  assert.equal(model.view.value.headNote, PANEL_REFUSED_NOTE);

  visible = true;
  shown();
  assert.equal(waiting(), 1, "回到前台才开始数");
  fake.reply("transcript.get", { value: guides(videoKey(SECOND)) });
  model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  assert.equal(model.view.value.headNote, "", "换了视频马上收回");
});

test("浏览器没让卡片打开侧边栏：展开着在正文里说，收着时在那一行上也说一句", async () => {
  const { fake, model } = setup(READY, undefined, { manualWait: true });
  fake.reply("session.get", { value: { ok: true, value: { session: session() } } });
  fake.reply("card.setOverride", { value: { ok: true, value: { session: {} } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  model.panelRefused();
  assert.match(model.view.value.notice?.text ?? "", /工具栏/);
  assert.equal(model.view.value.headNote, "");

  await model.toggle();
  model.panelRefused();
  assert.equal(model.view.value.headNote, PANEL_REFUSED_NOTE);
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

test("默认只露前几条、官方总结和评论区要点收着：点了才全露，换了视频回到默认；生成中的提示不重复进度行上的块数", async () => {
  assert.equal(CARD_ROWS, 5);
  // 多出两条以上才藏；只多一条时全露，不为一条去点「展开全部」。
  const rows = (count: number) => Array.from({ length: count }, (_, index) => index);
  assert.deepEqual(cardRows(rows(12), false), [0, 1, 2, 3, 4]);
  assert.equal(cardRows(rows(7), false).length, 5);
  assert.equal(cardRows(rows(6), false).length, 6);
  assert.equal(cardRows(rows(3), false).length, 3);
  assert.equal(cardRows(rows(12), true).length, 12);
  const { fake, model } = setup();
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.deepEqual([model.view.value.showAll, model.view.value.officialOpen, model.view.value.commentsOpen], [false, false, false]);
  model.toggleShowAll();
  model.toggleOfficial();
  model.toggleComments();
  assert.deepEqual([model.view.value.showAll, model.view.value.officialOpen, model.view.value.commentsOpen], [true, true, true]);
  model.toggleShowAll();
  assert.equal(model.view.value.showAll, false);
  model.toggleShowAll();

  fake.reply("transcript.get", { value: guides(videoKey(SECOND)) });
  model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.deepEqual([model.view.value.showAll, model.view.value.officialOpen, model.view.value.commentsOpen], [false, false, false]);

  // 跟着一个在跑的任务，章节一块块到：结论那一行只说还没写，块数留给进度行。
  fake.broadcast({ type: "task.changed", task: task("side", "running", videoKey(SECOND)) });
  assert.ok(await until(() => model.view.value.task?.id === "side"));
  fake.broadcast({ type: "overview.preview", taskId: "side", video: videoKey(SECOND), analysis: { chapters: ANALYSIS.chapters }, done: 3, total: 8 });
  assert.ok(await until(() => model.view.value.verdictPending !== false));
  assert.equal(model.view.value.verdictPending, "章节还在生成，结论最后写。");
  assert.doesNotMatch(String(model.view.value.verdictPending), /\d/);
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

test("YouTube 本机还没有字幕：能代开文字稿的构建里和 B 站一样能点生成，后台经视频页读", async () => {
  const { fake, model } = setup();
  fake.reply("transcript.get", { value: guides(KEY, { official: undefined, transcriptError: "NOT_CACHED" }) });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.notRead, false);
  assert.equal(model.view.value.official, null);
  assert.notEqual(model.view.value.notice?.text, NOT_READ_TEXT);
  await model.generate(true);
  assert.equal(fake.attempts("task.start"), 1, "点了就起生成");
});

test("YouTube 已有概览、本机没有字幕：摆出结论和章节，不再提读字幕", async () => {
  const { fake, model } = setup();
  fake.reply("transcript.get", { value: guides(KEY, { official: undefined, transcriptError: "NOT_CACHED", overview: { analysis: ANALYSIS, analysisFailures: [] } }) });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.deepEqual(model.view.value.analysis, ANALYSIS);
  assert.equal(model.view.value.notice, null);
});

test("换过字幕：摆着的概览带上依据的字幕指纹和现在这份的指纹；生成中的临时概览不带，结束后照本机的摆", async () => {
  const { fake, model } = setup();
  const overview = { analysis: ANALYSIS, analysisFailures: [], transcriptBasis: { chapters: "old", verdict: "old" } };
  fake.reply("transcript.get", { value: guides(KEY, { hasTranscript: true, transcriptFingerprint: "new", overview }) });
  fake.reply("task.list", { value: { ok: true, value: { tasks: [task("side", "running")] } } });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.task?.id === "side"));
  assert.deepEqual(model.view.value.transcriptBasis, { chapters: "old", verdict: "old" });
  assert.equal(model.view.value.transcriptFingerprint, "new");

  fake.broadcast({ type: "overview.preview", taskId: "side", video: KEY, analysis: { chapters: [{ title: "生成中", timestampSeconds: 0 }] }, done: 1, total: 2 });
  assert.ok(await until(() => model.view.value.analysis?.chapters?.[0]?.title === "生成中"));
  assert.equal(model.view.value.transcriptBasis, null);

  fake.reply("transcript.get", { value: guides(KEY, { hasTranscript: true, transcriptFingerprint: "new", overview: { ...overview, transcriptBasis: { chapters: "new", verdict: "new" } } }) });
  fake.broadcast({ type: "task.changed", task: task("side", "completed") });
  assert.ok(await until(() => model.view.value.task === null && model.view.value.transcriptBasis?.verdict === "new"));
});

test("侧边栏给这个视频换了字幕：卡片重读，换上现在这份的指纹；别的视频换了不读", async () => {
  const { fake, model } = setup();
  const overview = { analysis: ANALYSIS, analysisFailures: [], transcriptBasis: { chapters: "old", verdict: "old" } };
  fake.reply("transcript.get", { value: guides(KEY, { hasTranscript: true, transcriptFingerprint: "old", overview }) });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.transcriptFingerprint === "old"));
  const reads = fake.attempts("transcript.get");

  fake.broadcast({ type: "transcript.changed", video: videoKey(SECOND) });
  assert.ok(await stillFalse(() => fake.attempts("transcript.get") > reads));

  fake.reply("transcript.get", { value: guides(KEY, { hasTranscript: true, transcriptFingerprint: "new", overview }) });
  fake.broadcast({ type: "transcript.changed", video: KEY });
  assert.ok(await until(() => model.view.value.transcriptFingerprint === "new"));
  assert.deepEqual(model.view.value.transcriptBasis, { chapters: "old", verdict: "old" }, "概览不动，页面据此标基于旧字幕");
});

test("卡片说过没有字幕、随后在侧边栏导入了字幕文件：重读以后撤下没有字幕的说明，能生成", async () => {
  const { fake, model } = setup();
  fake.reply("transcript.get", { value: guides(KEY, { transcriptError: "NO_CAPTIONS" }) });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.noCaptions && model.view.value.notice?.text === NO_CAPTIONS_TEXT));

  fake.reply("transcript.get", { value: guides(KEY, { hasTranscript: true, transcriptFingerprint: "imported" }) });
  fake.broadcast({ type: "transcript.changed", video: KEY });
  assert.ok(await until(() => !model.view.value.noCaptions));
  assert.equal(model.view.value.notice, null);
});

const PENDING_OFFICIAL = { status: "pending", summary: "", outline: [] };
const skim = (video = KEY) => ({ value: { ok: true, value: { session: { video, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0 } } } });

test("按钮行：读的时候、官方总结还在读时先不摆，再轻读一次；读到了才摆，摆出来以后同一视频再读也不收回；换了视频重新等", async () => {
  const { fake, model, setUrl, elapse } = setup(READY, undefined, { manualWait: true });
  fake.reply("session.get", skim());
  fake.reply("transcript.get", { value: guides(KEY, { official: PENDING_OFFICIAL }) });
  model.configChanged();
  await model.start();
  assert.ok(await until(() => model.view.value.phase === "loaded"));
  assert.equal(model.view.value.holdActions, true, "官方总结还在读");
  assert.ok(await until(() => fake.attempts("transcript.get") === 2), "再轻读一次");
  assert.ok(await stillFalse(() => !model.view.value.holdActions));

  fake.reply("transcript.get", { value: guides() });
  fake.broadcast({ type: "transcript.changed", video: KEY });
  assert.ok(await until(() => !model.view.value.holdActions));
  assert.equal(model.view.value.official?.status, "ok");

  fake.reply("transcript.get", { value: guides(KEY, { official: PENDING_OFFICIAL }) });
  fake.broadcast({ type: "transcript.changed", video: KEY });
  assert.ok(await until(() => model.view.value.official?.status === "pending"));
  assert.ok(await stillFalse(() => model.view.value.holdActions), "摆出来以后不再收回");

  const second = videoKey(SECOND);
  fake.reply("transcript.get", { value: guides(second, { official: PENDING_OFFICIAL }) });
  setUrl("https://www.bilibili.com/video/BV1Sample002");
  model.urlChanged("https://www.bilibili.com/video/BV1Sample002");
  elapse();
  assert.ok(await until(() => model.view.value.phase === "loaded" && model.view.value.title === "样例长视频"));
  assert.equal(model.view.value.holdActions, true, "新视频重新等");
});

test("按钮行：官方总结一直没结果时，等够了照样摆；没有官方总结、读失败时读完就摆", async () => {
  const pending = setup(READY, undefined, { manualWait: true });
  pending.fake.reply("session.get", skim());
  pending.fake.reply("transcript.get", { value: guides(KEY, { official: PENDING_OFFICIAL }) });
  pending.model.configChanged();
  await pending.model.start();
  assert.ok(await until(() => pending.model.view.value.phase === "loaded" && pending.fake.attempts("transcript.get") === 2));
  assert.equal(pending.model.view.value.holdActions, true);
  assert.equal(pending.waiting(), 1, "挂着等内容的定时");
  pending.elapse();
  assert.equal(pending.model.view.value.holdActions, false);

  const none = setup(READY, undefined, { manualWait: true });
  none.fake.reply("session.get", skim());
  none.fake.reply("transcript.get", { value: guides(KEY, { official: undefined }) });
  none.model.configChanged();
  await none.model.start();
  assert.ok(await until(() => none.model.view.value.phase === "loaded"));
  assert.equal(none.model.view.value.holdActions, false);
  assert.equal(none.waiting(), 0);

  const failed = setup(READY, undefined, { manualWait: true });
  failed.fake.reply("session.get", skim());
  failed.fake.reply("transcript.get", { value: { ok: false, code: "NETWORK" } });
  failed.model.configChanged();
  await failed.model.start();
  assert.ok(await until(() => failed.model.view.value.phase === "failed"));
  assert.equal(failed.model.view.value.holdActions, false);
});

test("选繁体时卡片的文案是繁体那份", () => {
  assert.equal(cardTextOf("zh-Hant"), CARD_HANT);
  assert.equal(cardTextOf("zh-Hant").name, "簡幕");
});
