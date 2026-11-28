// 侧边栏的模式：有会话按会话，会话还没开时按视频时长先定（不到 5 分钟进精读，不知道时按长视频算）；
// 只认本标签页、本视频的会话广播；主动切换立刻换、带上频道编号、说出记没记住；撤销只在自动切过时发；换视频清掉旧的选择。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "../../../../src/core/mode/types.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { createModeStore } from "../../../../src/pages/sidepanel/mode.ts";
import { deferred } from "../../../helpers/deferred.ts";
import { fakeRuntime } from "../../../helpers/fake-runtime.ts";
import { SAMPLE_VIDEO_KEY as VIDEO } from "../../../helpers/sample-videos.ts";
import { stillFalse, until } from "../../../helpers/wait-until.ts";

const OTHER = videoKey({ platform: "bilibili", videoId: "BV1Sample002" });
const TAB = 7;

const view = (patch: Partial<SessionView> = {}): SessionView => ({ video: VIDEO, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0, ...patch });

function setup(session: SessionView | null = null) {
  const fake = fakeRuntime();
  fake.reply("session.get", { value: { ok: true, value: { session } } });
  // 默认后台还没收这条：模式按侧边栏自己先定的显示。
  fake.reply("session.describe", { value: { ok: false, code: "NOT_ENABLED" } });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const store = createModeStore({ api });
  return { fake, store };
}

test("会话还没到：按视频时长先定，不到 5 分钟进精读，5 分钟及以上和不知道时长进速读；不切换模式", async () => {
  const { fake, store } = setup();
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1), "问过会话");
  assert.deepEqual(store.view.value, { mode: "skim", source: "default", autoSwitched: false }, "时长不知道按长视频算");
  store.describe(299);
  assert.deepEqual(store.view.value, { mode: "study", source: "short", autoSwitched: false });
  store.describe(300);
  assert.equal(store.view.value.mode, "skim");
  store.describe(0);
  assert.equal(store.view.value.mode, "skim", "时长读成 0 当作不知道");
  assert.equal(fake.attempts("session.setMode"), 0);
});

test("报视频信息：时长和频道一起报给后台，回来的会话按频道偏好定；信息没变不重报，什么都不知道时不报", async () => {
  const { fake, store } = setup();
  fake.reply("session.describe", { value: { ok: true, value: { session: view({ mode: "study", modeSource: "channel" }) } } });
  store.bind(TAB, VIDEO);
  store.describe(undefined);
  assert.equal(fake.attempts("session.describe"), 0);
  store.describe(20 * 60, "4242");
  assert.ok(await until(() => store.view.value.source === "channel"), "按回来的会话显示");
  assert.deepEqual(fake.sent.find((item) => item.type === "session.describe")?.req, { tabId: TAB, video: VIDEO, durationSec: 1200, channel: "4242" });
  store.describe(20 * 60, "4242");
  assert.equal(fake.attempts("session.describe"), 1);
});

test("报视频信息时后台的会话还是上一个视频：被拒以后等这个视频的会话广播到了再报一次", async () => {
  const { fake, store } = setup();
  fake.reply("session.describe", (_req, attempt) =>
    attempt === 1 ? { ok: false, code: "VIDEO_CHANGED" } : { ok: true, value: { session: view({ mode: "study", modeSource: "channel" }) } },
  );
  store.bind(TAB, VIDEO);
  store.describe(20 * 60, "4242");
  assert.ok(await until(() => fake.attempts("session.describe") === 1), "报了一次");
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view() });
  assert.ok(await until(() => store.view.value.source === "channel"), "再报一次以后按频道偏好");
  assert.equal(fake.attempts("session.describe"), 2);
});

test("有会话按会话：频道偏好、手动选过的都照会话显示，时长不再起作用", async () => {
  const { fake, store } = setup(view({ mode: "study", modeSource: "channel" }));
  store.describe(20 * 60);
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => store.view.value.source === "channel"), "读到会话");
  assert.equal(store.view.value.mode, "study");
  store.describe(20 * 60);
  assert.equal(store.view.value.mode, "study");
  assert.equal(fake.attempts("session.get"), 1);
});

test("会话广播：只认本标签页、本视频的；后台自动切到精读时跟着换", async () => {
  const { fake, store } = setup();
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1), "问过会话");
  fake.broadcast({ type: "session.changed", tabId: TAB + 1, session: view({ mode: "study", modeSource: "auto", autoSwitched: true }) });
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ video: OTHER, mode: "study", modeSource: "auto", autoSwitched: true }) });
  assert.equal(store.view.value.mode, "skim");
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ mode: "study", modeSource: "auto", autoSwitched: true, playedSec: 60 }) });
  assert.deepEqual(store.view.value, { mode: "study", source: "auto", autoSwitched: true });
});

test("会话的回复比广播晚到：以广播为准，不被旧回复盖回去", async () => {
  const fake = fakeRuntime();
  const gate = deferred();
  fake.reply("session.get", async () => {
    await gate.promise;
    return { ok: true, value: { session: view() } };
  });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const store = createModeStore({ api });
  store.bind(TAB, VIDEO);
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ mode: "study", modeSource: "auto", autoSwitched: true }) });
  gate.resolve();
  assert.ok(await stillFalse(() => store.view.value.mode !== "study"), "旧回复没把模式盖回速读");
});

test("主动切换：不等后台立刻换，请求带上频道编号；回复说记住了就回 true；点当前模式什么都不发", async () => {
  const { fake, store } = setup(view());
  const gate = deferred();
  fake.reply("session.setMode", async () => {
    await gate.promise;
    return { ok: true, value: { session: view({ mode: "study", modeSource: "manual" }), remembered: true } };
  });
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1), "读到会话");
  assert.equal(await store.choose("skim", "4242"), false);
  assert.equal(fake.attempts("session.setMode"), 0, "点的是当前模式");

  const chosen = store.choose("study", "4242");
  assert.deepEqual(store.view.value, { mode: "study", source: "manual", autoSwitched: false }, "回复到之前已经换了");
  gate.resolve();
  assert.equal(await chosen, true);
  assert.deepEqual(fake.sent.find((item) => item.type === "session.setMode")?.req, { tabId: TAB, video: VIDEO, intent: "manual", mode: "study", channel: "4242" });
});

test("主动切换后台没存成：照样按用户选的显示，不说记住了", async () => {
  const { fake, store } = setup(view());
  fake.reply("session.setMode", { value: { ok: false, code: "NOT_ENABLED" } });
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1), "读到会话");
  assert.equal(await store.choose("study"), false);
  assert.equal(store.view.value.mode, "study");
  assert.deepEqual(fake.sent.find((item) => item.type === "session.setMode")?.req, { tabId: TAB, video: VIDEO, intent: "manual", mode: "study" }, "不知道频道就不带");
});

test("撤销自动切换：只在停在自动切的结果上时发，回来的会话回到速读", async () => {
  const { fake, store } = setup(view());
  fake.reply("session.setMode", { value: { ok: true, value: { session: view({ autoSwitched: true, playedSec: 61 }), remembered: false } } });
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1), "读到会话");
  await store.undo();
  assert.equal(fake.attempts("session.setMode"), 0, "没自动切过，没有可撤销的");
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ mode: "study", modeSource: "auto", autoSwitched: true, playedSec: 60 }) });
  await store.undo();
  assert.deepEqual(fake.sent.find((item) => item.type === "session.setMode")?.req, { tabId: TAB, video: VIDEO, intent: "undo-auto" });
  assert.deepEqual(store.view.value, { mode: "skim", source: "default", autoSwitched: true });
});

test("换视频：清掉上一个视频的选择和时长，按新视频的会话重新定", async () => {
  const { fake, store } = setup(null);
  fake.reply("session.setMode", { value: { ok: false, code: "NOT_ENABLED" } });
  store.bind(TAB, VIDEO);
  store.describe(120);
  await store.choose("skim");
  assert.equal(store.view.value.source, "manual");
  store.bind(TAB, OTHER);
  assert.deepEqual(store.view.value, { mode: "skim", source: "default", autoSwitched: false });
  store.bind(null, null);
  assert.ok(await until(() => fake.attempts("session.get") === 2), "每次换视频都问一次会话");
});

test("报视频信息的回复在路上时来了更新的会话广播：不拿回复盖掉广播", async () => {
  const fake = fakeRuntime();
  fake.reply("session.get", { value: { ok: true, value: { session: view() } } });
  const gate = deferred();
  fake.reply("session.describe", async () => {
    await gate.promise;
    return { ok: true, value: { session: view() } };
  });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const store = createModeStore({ api });
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1));
  store.describe(20 * 60, "4242");
  assert.ok(await until(() => fake.attempts("session.describe") === 1));
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ mode: "study", modeSource: "auto", autoSwitched: true, playedSec: 60 }) });
  gate.resolve();
  assert.ok(await stillFalse(() => store.view.value.mode !== "study"), "旧回复没把模式盖回速读");
});

test("主动切换的回复在路上时来了更新的会话广播：按广播显示，不再顶着刚点的", async () => {
  const { fake, store } = setup(view());
  const gate = deferred();
  fake.reply("session.setMode", async () => {
    await gate.promise;
    return { ok: true, value: { session: view({ mode: "study", modeSource: "manual" }), remembered: false } };
  });
  store.bind(TAB, VIDEO);
  assert.ok(await until(() => fake.attempts("session.get") === 1));
  const chosen = store.choose("study");
  fake.broadcast({ type: "session.changed", tabId: TAB, session: view({ mode: "study", modeSource: "manual", playedSec: 5 }) });
  gate.resolve();
  await chosen;
  assert.deepEqual(store.view.value, { mode: "study", source: "manual", autoSwitched: false });
});
