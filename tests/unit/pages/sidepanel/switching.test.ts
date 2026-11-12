// 侧边栏换视频：跟随标签页时地址在认的途中才到也能认出来，别的窗口的跟随广播不理；
// 换了视频以后，旧视频的字幕和问答回复都不串到新视频上；接上别处在跑的概览只跟着广播，不再认领一次。
import assert from "node:assert/strict";
import { signal } from "@preact/signals";
import { test } from "node:test";
import type { TaskView } from "../../../../src/core/tasks.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { createFollow, videoOfUrl, type FollowBrowser } from "../../../../src/pages/sidepanel/follow.ts";
import { createOverviewStore } from "../../../../src/pages/sidepanel/overview.ts";
import { createQaStore } from "../../../../src/pages/sidepanel/qa.ts";
import { createTranscriptStore } from "../../../../src/pages/sidepanel/transcript.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { fakeRuntime } from "../../../helpers/fake-runtime.ts";
import { until } from "../../../helpers/wait-until.ts";

const FIRST = videoKey({ platform: "bilibili", videoId: "BV1Sample001" });
const SECOND = videoKey({ platform: "bilibili", videoId: "BV1Sample002" });
const WATCH = "https://www.bilibili.com/video/BV1Sample001";

function setup() {
  const fake = fakeRuntime();
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  return { fake, api };
}

function fakeBrowser(tabs: Map<number, { windowId: number; url?: string; title?: string }>, active: { id: number }) {
  type Listener = (...args: never[]) => void;
  const activated = new Set<Listener>();
  const updated = new Set<Listener>();
  const event = (set: Set<Listener>) => ({ addListener: (l: Listener) => void set.add(l), removeListener: (l: Listener) => void set.delete(l) });
  const info = (id: number) => (tabs.has(id) ? { id, ...tabs.get(id) } : null);
  const browser = {
    currentWindowId: async () => 1,
    activeTab: async () => info(active.id),
    getTab: async (id: number) => info(id),
    onActivated: event(activated),
    onUpdated: event(updated),
  } as unknown as FollowBrowser;
  return {
    browser,
    activate(id: number) {
      active.id = id;
      for (const listener of activated) (listener as (i: { tabId: number; windowId: number }) => void)({ tabId: id, windowId: tabs.get(id)?.windowId ?? 0 });
    },
    navigate(id: number, url: string) {
      const tab = tabs.get(id);
      if (tab) tab.url = url;
      for (const listener of updated) (listener as (t: number, c: { url: string }, tab: unknown) => void)(id, { url }, info(id));
    },
  };
}

test("认视频：B 站播放页认得出，别的地址认不出", () => {
  assert.equal(videoOfUrl(WATCH), FIRST);
  assert.equal(videoOfUrl("https://example.com/video/BV1Sample001"), null);
  assert.equal(videoOfUrl(undefined), null);
});

test("跟随：新开的标签页地址还没到就先问观看会话，问的途中地址到了，照样认出视频", async () => {
  const { fake, api } = setup();
  const tabs = new Map<number, { windowId: number; url?: string }>([[5, { windowId: 1 }]]);
  const page = fakeBrowser(tabs, { id: 5 });
  const gate = deferred();
  fake.reply("session.get", async () => {
    await gate.promise;
    return { ok: true, value: { session: null } };
  });
  const follow = createFollow({ api, enabled: signal(true), browser: page.browser });
  const first = follow.refresh();
  await until(() => fake.attempts("session.get") === 1);
  page.navigate(5, WATCH);
  gate.resolve();
  await first;
  await until(() => follow.target.value.video === FIRST);
  assert.equal(follow.target.value.tabId, 5);
  follow.stop();
});

test("跟随：别的窗口来的跟随广播不理，本窗口切到别的标签页就跟过去", async () => {
  const { fake, api } = setup();
  const tabs = new Map([
    [5, { windowId: 1, url: WATCH }],
    [6, { windowId: 2, url: "https://www.bilibili.com/video/BV1Sample002" }],
    [7, { windowId: 1, url: "https://www.bilibili.com/video/BV1Sample002" }],
  ]);
  const page = fakeBrowser(tabs, { id: 5 });
  const follow = createFollow({ api, enabled: signal(true), browser: page.browser });
  await follow.refresh();
  assert.equal(follow.target.value.video, FIRST);
  fake.broadcast({ type: "panel.follow", tabId: 6 });
  await nextTurn();
  assert.equal(follow.target.value.tabId, 5, "别的窗口的标签页不跟");
  page.activate(7);
  await until(() => follow.target.value.tabId === 7);
  assert.equal(follow.target.value.video, SECOND);
  follow.stop();
});

test("换视频：旧视频的字幕回复晚到，不盖掉新视频", async () => {
  const { fake, api } = setup();
  const gate = deferred();
  fake.reply("transcript.get", async (req) => {
    const { video } = req as { video: string };
    if (video === FIRST) await gate.promise;
    return { ok: false, code: "NO_CAPTIONS", info: { title: video } };
  });
  const store = createTranscriptStore({ api });
  const slow = store.load(FIRST, 5);
  await store.load(SECOND, 5);
  gate.resolve();
  await slow;
  const now = store.state.value;
  assert.equal(now.state, "failed");
  assert.equal(now.state === "failed" ? now.video : null, SECOND);
});

test("换视频：还在路上的回答回来时不放进新视频的问答列表", async () => {
  const { fake, api } = setup();
  const gate = deferred();
  fake.reply("qa.history", { value: { ok: true, value: { entries: [] } } });
  fake.reply("task.list", { value: { ok: true, value: { tasks: [] } } });
  fake.reply("task.start", { value: { ok: true, value: { task: { id: "t1" }, joined: false } } });
  fake.reply("qa.ask", async () => {
    await gate.promise;
    return { ok: true, value: { entry: { id: "q1", video: FIRST, question: "问", answer: "答", citations: [], clickable: [], createdAt: 1 }, retrievalMode: "full" } };
  });
  const qa = createQaStore({ api });
  qa.bind(FIRST);
  const asking = qa.ask("问");
  await until(() => qa.state.value.pending.length === 1);
  qa.bind(SECOND);
  gate.resolve();
  await asking;
  await nextTurn();
  assert.equal(qa.state.value.video, SECOND);
  assert.deepEqual(qa.state.value.entries, []);
  assert.deepEqual(qa.state.value.pending, []);
  qa.stop();
});

test("概览：接上别处在跑的任务只跟着广播，不再认领；任务收尾后重读本机的概览", async () => {
  const { fake, api } = setup();
  const running: TaskView = { id: "o1", kind: "overview", origin: "user", video: FIRST, state: "running", done: 1, total: 3, phase: "", message: "", createdAt: 1, updatedAt: 1 };
  let saved = false;
  fake.reply("overview.get", () => ({ ok: true, value: saved ? { video: FIRST, overview: { analysis: { chapters: [] }, analysisFailures: [] } } : { video: FIRST } }));
  fake.reply("task.list", { value: { ok: true, value: { tasks: [] } } });
  fake.reply("task.start", { value: { ok: true, value: { task: running, joined: true } } });
  const overview = createOverviewStore({ api });
  overview.bind(FIRST);
  await until(() => overview.state.value.loaded);
  await overview.generate(false);
  assert.equal(fake.attempts("overview.start"), 0, "接上的任务不再认领");
  assert.equal(overview.state.value.task?.id, "o1");
  saved = true;
  fake.broadcast({ type: "task.changed", task: { ...running, state: "completed" } });
  await until(() => overview.state.value.saved !== null);
  assert.equal(overview.state.value.task, null);
  overview.stop();
});

test("问答：没存进历史的回答，收尾广播先到也不被历史盖掉，标着没存上", async () => {
  const { fake, api } = setup();
  const gate = deferred();
  fake.reply("qa.history", { value: { ok: true, value: { entries: [] } } });
  fake.reply("task.list", { value: { ok: true, value: { tasks: [] } } });
  fake.reply("task.start", { value: { ok: true, value: { task: { id: "t2" }, joined: false } } });
  fake.reply("qa.ask", async () => {
    await gate.promise;
    return { ok: true, value: { entry: { id: "q2", video: FIRST, question: "问", answer: "答", citations: [], clickable: [], createdAt: 2 }, retrievalMode: "full", historySaved: false } };
  });
  const qa = createQaStore({ api });
  qa.bind(FIRST);
  await until(() => qa.state.value.loaded);
  const asking = qa.ask("问");
  await until(() => qa.state.value.pending.length === 1);
  fake.broadcast({ type: "task.changed", task: { id: "t2", kind: "qa", origin: "user", video: FIRST, state: "completed", done: 1, total: 1, phase: "", message: "", createdAt: 2, updatedAt: 2 } });
  await nextTurn();
  gate.resolve();
  await asking;
  await nextTurn();
  assert.equal(fake.attempts("qa.history"), 1, "自己在等的任务收尾时不另外重读历史");
  assert.deepEqual(qa.state.value.entries.map((entry) => entry.id), ["q2"]);
  assert.equal(qa.state.value.unsavedId, "q2");
  qa.stop();
});
