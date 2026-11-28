// 观看会话的路由：确认前一律不收、不写会话；内容脚本报的视频必须是它所在标签页地址上的那个；
// 播放进度每个标签页 10 秒最多一条，报到自动切换也引不出任务和模型请求；卡片只碰自己所在的标签页；
// 刚记住的频道侧边栏能「不记」，只忘这一个、眼下的模式不变；设置页能看记住了几个。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import type { MessageSender } from "../../../../src/background/senders.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { OPEN_PANELS_KEY, SETTINGS_STORAGE_KEY, WATCH_SESSIONS_KEY } from "../../../../src/shared/names.ts";
import {
  CONFIRMED,
  createFakeChrome,
  extensionUrl,
  SAMPLE_VIDEO_ID,
  senders,
  STALE_CONFIRMATION,
  TUBE_ORIGIN,
  tubeUrl,
  watchedSender,
  watchUrl,
  type FakeChromeOptions,
} from "../../../helpers/chrome.ts";
import { SAMPLE_VIDEO_KEY as VIDEO } from "../../../helpers/sample-videos.ts";
import { until } from "../../../helpers/wait-until.ts";

const OTHER_ID = "BV1Sample002";
const OTHER = videoKey({ platform: "bilibili", videoId: OTHER_ID });
const TUBE = videoKey({ platform: "youtube", videoId: "tube-sample" });
const LONG = 20 * 60;
const CONTENT_TAB = 31;
const CARD_TAB = 21;

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, ...options });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const send = (type: string, req: unknown, sender: MessageSender) => app.dispatch({ type, req }, sender);
  const sessions = () => (fake.session.data[WATCH_SESSIONS_KEY] ?? {}) as Record<string, { mode: string; modeSource: string }>;
  return { fake, app, send, sessions };
}

const content = (tabId = CONTENT_TAB, videoId = SAMPLE_VIDEO_ID) => senders.content(watchUrl(videoId), tabId);

// 每 10 秒真实时间报一次累计秒数，一直报到 untilSec。
async function play(world: ReturnType<typeof appOn>, untilSec: number, tabId = CONTENT_TAB) {
  const replies: unknown[] = [];
  for (let played = 10; played <= untilSec; played += 10) {
    world.fake.timers.advance(10_000);
    replies.push(await world.send("playback.milestone", { video: VIDEO, playedSec: played }, content(tabId)));
  }
  return replies;
}

for (const [state, local] of [
  ["从没确认", {}],
  ["确认过期", { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION }],
] as const) {
  test(`${state}：播放上报、读会话、切换模式、卡片展开收起、清除频道偏好都回还没启用，不写会话、不读标签页地址`, async () => {
    const world = appOn({ local: structuredClone(local) });
    const reads: string[] = [];
    const contentReads: string[] = [];
    const watched = (sender: MessageSender) =>
      watchedSender(sender, sender.tab?.url === sender.url ? contentReads : reads, world.fake.confirmedNow);
    const requests: readonly [string, unknown, MessageSender][] = [
      ["playback.info", { video: VIDEO, durationSec: LONG, channel: "4242" }, content()],
      ["playback.milestone", { video: VIDEO, playedSec: 10 }, content()],
      ["session.get", { tabId: CONTENT_TAB }, senders.panel()],
      ["session.get", {}, senders.card()],
      ["session.setMode", { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study" }, senders.panel()],
      ["card.setOverride", { video: VIDEO, value: "collapsed" }, senders.card()],
      ["channels.clear", {}, senders.options()],
    ];
    for (const [type, req, sender] of requests) {
      assert.deepEqual(await world.send(type, req, watched(sender)), { ok: false, code: "NOT_ENABLED" }, type);
    }
    assert.equal(world.fake.session.data[WATCH_SESSIONS_KEY], undefined);
    assert.equal(world.fake.indexedDB.openCount(), 0, "没碰频道偏好");
    const addresses = ["tab.url", "tab.pendingUrl", "tab.title"];
    assert.deepEqual(reads.filter((read) => addresses.includes(read)), []);
    assert.deepEqual(contentReads.filter((read) => [...addresses, "sender.url"].includes(read)), [], "内容脚本的地址");
    assert.ok(contentReads.length > 0);
    assert.deepEqual(world.fake.calls.siteParses, []);
  });
}

test("确认后内容脚本报时长和频道：开这个标签页的会话，广播给扩展页面，回从 0 开始计", async () => {
  const world = appOn();
  assert.deepEqual(await world.send("playback.info", { video: VIDEO, durationSec: LONG, channel: "4242" }, content()), {
    ok: true,
    value: { playedSec: 0, report: true },
  });
  const expected = { video: VIDEO, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0 };
  assert.deepEqual(await world.send("session.get", { tabId: CONTENT_TAB }, senders.panel()), { ok: true, value: { session: expected } });
  assert.deepEqual(world.fake.calls.broadcasts, [{ type: "session.changed", tabId: CONTENT_TAB, session: expected }]);
  assert.deepEqual(world.fake.calls.tabMessages, [], "内容脚本不收会话广播");
});

test("内容脚本报的视频以它所在标签页的地址为准：消息里的视频对不上的不认，不开会话", async () => {
  const world = appOn({ grantedOrigins: [`${TUBE_ORIGIN}/*`] });
  assert.deepEqual(await world.send("playback.info", { video: OTHER, durationSec: LONG }, content()), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(await world.send("playback.milestone", { video: OTHER, playedSec: 0 }, content()), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(world.sessions(), {});

  // 另一个站的内容脚本报它自己地址上的视频，照常开会话，频道记在那个站名下。
  assert.equal((await world.send("playback.info", { video: TUBE, channel: "UC-sample" }, senders.content(tubeUrl(), 41))).ok, true);
  assert.deepEqual(Object.keys(world.sessions()), ["41"]);
  // YouTube 的频道可能只读得到 @ 名：照收；只有 @、两个 @ 的不收。
  assert.equal((await world.send("playback.info", { video: TUBE, channel: "@sample.channel" }, senders.content(tubeUrl(), 41))).ok, true);
  for (const channel of ["@", "@@sample", "sample@"]) {
    assert.deepEqual(await world.send("playback.info", { video: TUBE, channel }, senders.content(tubeUrl(), 41)), { ok: false, code: "INVALID_REQUEST" }, channel);
  }
});

test("播放上报的请求形状：多带字段、时长不对、频道编号不对、秒数离谱的都不收", async () => {
  const world = appOn();
  for (const req of [
    {},
    { video: VIDEO, durationSec: LONG, extra: 1 },
    { video: VIDEO, durationSec: 0 },
    { video: VIDEO, durationSec: -5 },
    { video: VIDEO, durationSec: Number.NaN },
    { video: VIDEO, durationSec: 8 * 24 * 3600 },
    { video: VIDEO, channel: "" },
    { video: VIDEO, channel: "x".repeat(65) },
    { video: VIDEO, channel: "<script>" },
    { video: VIDEO, channel: 4242 },
    { video: "bilibili:not-a-video:p1" },
  ]) {
    assert.deepEqual(await world.send("playback.info", req, content()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  for (const req of [{ video: VIDEO }, { video: VIDEO, playedSec: -1 }, { video: VIDEO, playedSec: "10" }, { video: VIDEO, playedSec: 10, extra: 1 }]) {
    assert.deepEqual(await world.send("playback.milestone", req, content()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(world.sessions(), {});
});

test("播放进度每个标签页 10 秒最多收一条，别的标签页不受影响，过了 10 秒又能报", async () => {
  const world = appOn();
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content());
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content(CONTENT_TAB + 1));
  world.fake.timers.advance(10_000);

  assert.deepEqual(await world.send("playback.milestone", { video: VIDEO, playedSec: 10 }, content()), { ok: true, value: { report: true } });
  world.fake.timers.advance(9_999);
  assert.deepEqual(await world.send("playback.milestone", { video: VIDEO, playedSec: 19 }, content()), { ok: false, code: "PLAYBACK_RATE_LIMITED" });
  assert.equal((await world.send("playback.milestone", { video: VIDEO, playedSec: 19 }, content(CONTENT_TAB + 1))).ok, true);
  world.fake.timers.advance(1);
  assert.equal((await world.send("playback.milestone", { video: VIDEO, playedSec: 20 }, content())).ok, true);
});

test("播放进度一路报到自动切到精读：只改界面模式，不登记任务、不发模型请求、不保活", async () => {
  const world = appOn({ fetch: async () => assert.fail("播放上报不能引出模型请求") });
  await world.send("playback.info", { video: VIDEO, durationSec: LONG, channel: "4242" }, content());
  const replies = await play(world, 70);

  assert.deepEqual(replies.at(-1), { ok: true, value: { report: false } });
  assert.deepEqual(world.sessions()[String(CONTENT_TAB)]?.modeSource, "auto");
  assert.deepEqual(await world.send("task.list", {}, senders.panel()), { ok: true, value: { tasks: [] } });
  assert.deepEqual(world.fake.calls.fetches, []);
  assert.equal(world.fake.calls.pings, 0);
  assert.equal(world.fake.timers.pending(), 0, "没有排任何计时");
  assert.ok(world.fake.calls.broadcasts.some((message) => (message as { session?: { modeSource?: string } }).session?.modeSource === "auto"));
});

const PANEL_CONTEXT = { contextType: "SIDE_PANEL", documentUrl: extensionUrl("pages/sidepanel.html"), tabId: -1, windowId: -1 };
/** 内容脚本替身所在的窗口。 */
const CONTENT_WINDOW = 3;

test("内容脚本所在窗口的侧边栏开着：播满 1 分钟先不切、接着报；关上以后下一次上报再切，别的窗口开着不算", async () => {
  const world = appOn({ contexts: [PANEL_CONTEXT] });
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content());
  const open = () => (world.fake.session.data[OPEN_PANELS_KEY] ?? []) as readonly number[];
  world.app.onPanelChanged(CONTENT_WINDOW + 1, true);
  world.app.onPanelChanged(CONTENT_WINDOW, true);
  assert.ok(await until(() => open().length === 2));

  const replies = await play(world, 90);
  assert.deepEqual(replies.at(-1), { ok: true, value: { report: true } }, "开着：接着报");
  assert.equal(world.sessions()[String(CONTENT_TAB)]?.mode, "skim");

  world.app.onPanelChanged(CONTENT_WINDOW, false);
  assert.ok(await until(() => open().length === 1));
  world.fake.timers.advance(10_000);
  assert.deepEqual(await world.send("playback.milestone", { video: VIDEO, playedSec: 100 }, content()), { ok: true, value: { report: false } });
  assert.equal(world.sessions()[String(CONTENT_TAB)]?.modeSource, "auto");
});

test("读会话：侧边栏按请求里的标签页读，卡片只读自己所在的标签页、不能点名别的", async () => {
  const world = appOn();
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content(CARD_TAB));
  await world.send("playback.info", { video: OTHER, durationSec: LONG }, content(CONTENT_TAB, OTHER_ID));

  const own = (await world.send("session.get", {}, senders.card(CARD_TAB))) as { ok: true; value: { session: { video: string } } };
  assert.equal(own.value.session.video, VIDEO);
  assert.deepEqual(await world.send("session.get", { tabId: CONTENT_TAB }, senders.card(CARD_TAB)), { ok: false, code: "INVALID_REQUEST" });
  const named = (await world.send("session.get", { tabId: CONTENT_TAB }, senders.panel())) as { ok: true; value: { session: { video: string } } };
  assert.equal(named.value.session.video, OTHER);
  assert.deepEqual(await world.send("session.get", { tabId: 99 }, senders.panel()), { ok: true, value: { session: null } });
  for (const req of [{}, { tabId: -1 }, { tabId: 1.5 }, { tabId: "31" }]) {
    assert.deepEqual(await world.send("session.get", req, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
});

test("卡片手动展开收起只改它所在标签页的会话；侧边栏、内容脚本发不了", async () => {
  const world = appOn();
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content(CARD_TAB));
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content());

  const changed = (await world.send("card.setOverride", { video: VIDEO, value: "collapsed" }, senders.card(CARD_TAB))) as {
    ok: true;
    value: { session: { cardOverride?: string } };
  };
  assert.equal(changed.value.session.cardOverride, "collapsed");
  assert.equal((world.sessions()[String(CONTENT_TAB)] as { cardOverride?: string }).cardOverride, undefined);
  for (const sender of [senders.panel(), content(), senders.options()]) {
    assert.deepEqual(await world.send("card.setOverride", { video: VIDEO, value: "expanded" }, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(await world.send("card.setOverride", { video: VIDEO, value: "hidden" }, senders.card(CARD_TAB)), {
    ok: false,
    code: "INVALID_REQUEST",
  });
});

test("主动切换模式记住频道，同一频道的新视频按它打开；撤销自动切换不记；设置页清掉以后回到按时长", async () => {
  const world = appOn();
  await world.send("playback.info", { video: VIDEO, durationSec: LONG, channel: "4242" }, content());
  await play(world, 60);
  const undo = { tabId: CONTENT_TAB, video: VIDEO, intent: "undo-auto" };
  assert.equal(((await world.send("session.setMode", undo, senders.panel())) as { ok: boolean }).ok, true);

  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "4242" }, content(CONTENT_TAB + 1, OTHER_ID));
  assert.equal(world.sessions()[String(CONTENT_TAB + 1)]?.modeSource, "default", "撤销不记频道");

  const manual = { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study" };
  assert.equal(((await world.send("session.setMode", manual, senders.panel())) as { ok: boolean }).ok, true);
  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "4242" }, content(CONTENT_TAB + 2, OTHER_ID));
  assert.deepEqual(world.sessions()[String(CONTENT_TAB + 2)]?.modeSource, "channel");

  for (const sender of [senders.panel(), senders.triage(), senders.card()]) {
    assert.deepEqual(await world.send("channels.clear", {}, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(await world.send("channels.clear", {}, senders.options()), { ok: true, value: {} });
  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "4242" }, content(CONTENT_TAB + 3, OTHER_ID));
  assert.equal(world.sessions()[String(CONTENT_TAB + 3)]?.modeSource, "default");
});

test("刚记住的频道点「不记」：只收侧边栏，只忘掉这个标签页上的那个频道，眼下的模式不变；设置页数得出记住了几个", async () => {
  const world = appOn();
  const count = async () => (await world.send("channels.count", {}, senders.options())) as { ok: boolean; value?: { count: number } };
  assert.deepEqual(await count(), { ok: true, value: { count: 0 } });

  await world.send("playback.info", { video: VIDEO, durationSec: LONG, channel: "4242" }, content());
  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "7777" }, content(CONTENT_TAB + 1, OTHER_ID));
  for (const [tabId, video] of [[CONTENT_TAB, VIDEO], [CONTENT_TAB + 1, OTHER]] as const) {
    await world.send("session.setMode", { tabId, video, intent: "manual", mode: "study" }, senders.panel());
  }
  assert.deepEqual(await count(), { ok: true, value: { count: 2 } });

  const forget = { tabId: CONTENT_TAB, video: VIDEO };
  for (const sender of [senders.options(), senders.triage(), senders.card(), content()]) {
    assert.deepEqual(await world.send("channels.forget", forget, sender), { ok: false, code: "FORBIDDEN" });
  }
  for (const req of [{ tabId: CONTENT_TAB }, { ...forget, channel: "4242" }, { tabId: -1, video: VIDEO }]) {
    assert.deepEqual(await world.send("channels.forget", req, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(await world.send("channels.forget", { tabId: CONTENT_TAB, video: OTHER }, senders.panel()), { ok: false, code: "VIDEO_CHANGED" }, "标签页上已经换了视频");
  assert.deepEqual(await world.send("channels.forget", forget, senders.panel()), { ok: true, value: { forgotten: true } });
  assert.deepEqual(await count(), { ok: true, value: { count: 1 } }, "另一个频道还记着");
  assert.equal(world.sessions()[String(CONTENT_TAB)]?.mode, "study", "眼下的模式不变");
  assert.equal(world.sessions()[String(CONTENT_TAB)]?.modeSource, "manual");

  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "4242" }, content(CONTENT_TAB + 2, OTHER_ID));
  assert.equal(world.sessions()[String(CONTENT_TAB + 2)]?.modeSource, "default", "忘掉的频道回到按时长");
  for (const sender of [senders.panel(), senders.triage(), senders.card()]) {
    assert.deepEqual(await world.send("channels.count", {}, sender), { ok: false, code: "FORBIDDEN" });
  }
});

test("播放页还没报频道时，侧边栏带上读到的频道编号切换模式，回复说明记住了；同一频道的新视频按它打开", async () => {
  const world = appOn();
  const manual = { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study", channel: "4242" };
  const reply = (await world.send("session.setMode", manual, senders.panel())) as { ok: boolean; value?: { remembered: boolean; session: { modeSource: string } } };
  assert.equal(reply.ok, true);
  assert.equal(reply.value?.remembered, true);
  assert.equal(reply.value?.session.modeSource, "manual");
  await world.send("playback.info", { video: OTHER, durationSec: LONG, channel: "4242" }, content(CONTENT_TAB + 1, OTHER_ID));
  assert.equal(world.sessions()[String(CONTENT_TAB + 1)]?.mode, "study");
  assert.equal(world.sessions()[String(CONTENT_TAB + 1)]?.modeSource, "channel");
});

test("侧边栏报视频信息：只收侧边栏，时长和频道编号形状不对的不收；收下的按频道偏好定模式", async () => {
  const world = appOn();
  for (const req of [
    { tabId: CONTENT_TAB, video: VIDEO, durationSec: 0 },
    { tabId: CONTENT_TAB, video: VIDEO, durationSec: -5 },
    { tabId: CONTENT_TAB, video: VIDEO, channel: "带空格 的编号" },
    { tabId: CONTENT_TAB, video: VIDEO, mode: "study" },
    { video: VIDEO, durationSec: LONG },
  ]) {
    assert.deepEqual(await world.send("session.describe", req, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  for (const sender of [senders.card(), senders.options(), senders.triage()]) {
    assert.deepEqual(await world.send("session.describe", { tabId: CONTENT_TAB, video: VIDEO, durationSec: LONG }, sender), { ok: false, code: "FORBIDDEN" });
  }
  const reply = (await world.send("session.describe", { tabId: CONTENT_TAB, video: VIDEO, durationSec: 120, channel: "4242" }, senders.panel())) as {
    ok: boolean;
    value?: { session: { mode: string; modeSource: string } };
  };
  assert.deepEqual(reply.value?.session.mode, "study");
  assert.deepEqual(reply.value?.session.modeSource, "short");
});

test("切换模式只收侧边栏，请求形状不对的不收", async () => {
  const world = appOn();
  for (const sender of [senders.card(), content(), senders.options(), senders.triage()]) {
    const req = { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study" };
    assert.deepEqual(await world.send("session.setMode", req, sender), { ok: false, code: "FORBIDDEN" });
  }
  for (const req of [
    { tabId: CONTENT_TAB, video: VIDEO, intent: "manual" },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "english" },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "undo-auto", mode: "skim" },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "auto", mode: "study" },
    { video: VIDEO, intent: "manual", mode: "study" },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study", channel: "带空格 的编号" },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "manual", mode: "study", channel: 4242 },
    { tabId: CONTENT_TAB, video: VIDEO, intent: "undo-auto", channel: "4242" },
  ]) {
    assert.deepEqual(await world.send("session.setMode", req, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(world.sessions(), {});
});

test("标签页关掉删掉它的会话，播放进度的限频也从头算", async () => {
  const world = appOn();
  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content());
  world.fake.timers.advance(10_000);
  await world.send("playback.milestone", { video: VIDEO, playedSec: 10 }, content());

  world.app.onTabRemoved(CONTENT_TAB);
  assert.ok(await until(() => Object.keys(world.sessions()).length === 0));

  await world.send("playback.info", { video: VIDEO, durationSec: LONG }, content());
  world.fake.timers.advance(2_000);
  assert.deepEqual(await world.send("playback.milestone", { video: VIDEO, playedSec: 1 }, content()), { ok: true, value: { report: true } });
});
