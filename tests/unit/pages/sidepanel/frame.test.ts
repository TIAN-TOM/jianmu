// 侧边栏里解释当前画面的数据：按跟着的标签页读最近几次，只列当前视频的；这个标签页的广播来了就重读，别的标签页的不理；
// 点按钮发出去，发不出去回一句原因；关掉的只在这里藏起来；没启用或没有标签页时不读。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { fail, ok } from "../../../../src/core/errors.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { createFrameStore, type FrameTarget } from "../../../../src/pages/sidepanel/frame.ts";
import type { FrameEntryView } from "../../../../src/shared/messages/frame.ts";
import { until } from "../../../helpers/wait-until.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 1 });
const OTHER = videoKey({ platform: "bilibili", videoId: "BV1Sample002", segment: 1 });

const entry = (id: string, video = VIDEO, extra: Partial<FrameEntryView> = {}): FrameEntryView => ({
  id,
  tabId: 7,
  video,
  state: "done",
  phase: "finished",
  explanation: `解释 ${id}`,
  createdAt: 0,
  ...extra,
});

function setup(initial: FrameTarget = { tabId: 7, video: VIDEO }) {
  const target = signal<FrameTarget>(initial);
  const enabled = signal(true);
  const asked: { readonly type: string; readonly req: unknown }[] = [];
  let entries: FrameEntryView[] = [entry("a"), entry("b", OTHER)];
  let explainReply: unknown = ok(entry("c", VIDEO, { state: "running", phase: "checking" }));
  const listeners: { readonly type: string; readonly listener: (message: { readonly tabId: number }) => void }[] = [];
  const api = {
    async send(type: string, req: unknown) {
      asked.push({ type, req });
      return type === "frame.recent" ? ok({ entries }) : explainReply;
    },
    on(type: string, listener: (message: { readonly tabId: number }) => void) {
      const entry = { type, listener };
      listeners.push(entry);
      return () => listeners.splice(listeners.indexOf(entry), 1);
    },
  };
  const store = createFrameStore({ api: api as never, target, enabled });
  return {
    store,
    target,
    enabled,
    asked,
    setEntries: (next: FrameEntryView[]) => void (entries = next),
    setExplainReply: (next: unknown) => void (explainReply = next),
    broadcast: (tabId: number) => listeners.filter(({ type }) => type === "frame.changed").forEach(({ listener }) => listener({ tabId })),
    cleared: () => listeners.filter(({ type }) => type === "data.cleared").forEach(({ listener }) => listener({ tabId: -1 })),
    recentCalls: () => asked.filter(({ type }) => type === "frame.recent").length,
  };
}

test("按标签页读最近几次，只列当前视频的；换视频按视频筛，不重读", async () => {
  const h = setup();
  await until(() => h.store.entries.value.length === 1);
  assert.deepEqual(h.store.entries.value.map(({ id }) => id), ["a"]);
  assert.deepEqual(h.asked[0], { type: "frame.recent", req: { tabId: 7 } });
  const calls = h.recentCalls();
  h.target.value = { tabId: 7, video: OTHER };
  assert.deepEqual(h.store.entries.value.map(({ id }) => id), ["b"]);
  assert.equal(h.recentCalls(), calls);
});

test("这个标签页的广播来了就重读，别的标签页的不理", async () => {
  const h = setup();
  await until(() => h.store.entries.value.length === 1);
  h.setEntries([entry("new"), entry("a")]);
  h.broadcast(8);
  assert.equal(h.recentCalls(), 1);
  h.broadcast(7);
  await until(() => h.store.entries.value.length === 2);
  assert.deepEqual(h.store.entries.value.map(({ id }) => id), ["new", "a"]);
});

test("点按钮：带标签页和视频发出去；发不出去回一句原因；没有视频时不发", async () => {
  const h = setup();
  assert.equal(await h.store.explain(), "");
  assert.deepEqual(h.asked.find(({ type }) => type === "frame.explain")?.req, { tabId: 7, video: VIDEO });
  h.setExplainReply(fail("FRAME_RATE_LIMITED"));
  assert.match(await h.store.explain(), /点得太多/);
  h.target.value = { tabId: 7, video: null };
  assert.match(await h.store.explain(), /先打开一个视频/);
});

test("关掉的只在这里藏起来；没启用时清空、不读", async () => {
  const h = setup();
  await until(() => h.store.entries.value.length === 1);
  h.store.dismiss("a");
  assert.deepEqual(h.store.entries.value, []);
  h.enabled.value = false;
  const calls = h.recentCalls();
  h.broadcast(7);
  await until(() => h.store.entries.value.length === 0);
  assert.equal(h.recentCalls(), calls, "没启用不读");
  h.store.stop();
});

test("清除了本机数据：跟着重读", async () => {
  const h = setup();
  await until(() => h.store.entries.value.length === 1);
  h.setEntries([]);
  h.cleared();
  await until(() => h.store.entries.value.length === 0);
  h.store.stop();
});
