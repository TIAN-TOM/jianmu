// 侧边栏读 YouTube 字幕：用户点读取（完整读取、带标签页）时先让视频页替他点开文字稿，再读；只看本机时不点，B 站不点；
// 正在播广告、视频已换时停在这里，不读。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoKey } from "../../../../src/core/video-ref.ts";
import { createTranscriptStore } from "../../../../src/pages/sidepanel/transcript.ts";

const TUBE = "youtube:jmSample0001" as VideoKey;
const BILI = "bilibili:BV1Sample001:p1" as VideoKey;

function setup(outcome = "opened") {
  const sent: string[] = [];
  const api = {
    async send(type: string) {
      sent.push(type);
      if (type === "youtube.openTranscript") return { ok: true, value: { outcome } };
      return { ok: false, code: "PAGE_ACTION_NEEDED" };
    },
  };
  const store = createTranscriptStore({ api: api as never });
  return { store, sent };
}

test("YouTube 上点读取：先替用户点开文字稿，再读", async () => {
  const { store, sent } = setup();
  await store.load(TUBE, 7);
  assert.deepEqual(sent, ["youtube.openTranscript", "transcript.get"]);
});

test("只看本机、没有标签页、B 站视频：都不点", async () => {
  for (const [video, tabId, options] of [
    [TUBE, 7, { localOnly: true }],
    [TUBE, null, {}],
    [BILI, 7, {}],
  ] as const) {
    const { store, sent } = setup();
    await store.load(video, tabId, options);
    assert.deepEqual(sent, ["transcript.get"], `${video} ${tabId}`);
  }
});

test("正在播广告、页面上已经换了视频：停在这里，不读；点了没开、没有入口：照常读，按页面上的样子报", async () => {
  for (const [outcome, code] of [
    ["ad", "PAGE_ACTION_NEEDED"],
    ["video-changed", "VIDEO_CHANGED"],
  ] as const) {
    const { store, sent } = setup(outcome);
    await store.load(TUBE, 7);
    assert.deepEqual(sent, ["youtube.openTranscript"], outcome);
    const now = store.state.value;
    assert.equal(now.state === "failed" ? now.failure.code : now.state, code);
  }
  for (const outcome of ["not-opened", "no-entry", "no-page", "searching"]) {
    const { store, sent } = setup(outcome);
    await store.load(TUBE, 7);
    assert.deepEqual(sent, ["youtube.openTranscript", "transcript.get"], outcome);
  }
});
