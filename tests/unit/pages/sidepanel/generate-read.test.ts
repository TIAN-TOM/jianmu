// 侧边栏的一步生成：YouTube 上字幕还没读到、或者上次读碰上了广告时，点「生成概览」带上标签页先经视频页读；
// 概览任务一结束，字幕这块还停在这几种提示上就从本机补一次，切到精读也补；用户自己读字幕读到别的结果不盖掉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import type { VideoKey } from "../../../../src/core/video-ref.ts";
import type { TranscriptFailure } from "../../../../src/shared/messages/transcript.ts";
import { readsFirst, refillAfterGenerate } from "../../../../src/pages/sidepanel/generate-read.ts";
import type { OverviewState } from "../../../../src/pages/sidepanel/overview.ts";
import type { TranscriptState } from "../../../../src/pages/sidepanel/transcript.ts";

const TUBE = "youtube:jmSample0001" as VideoKey;
const BILI = "bilibili:BV1Sample001:p1" as VideoKey;

const failed = (video: VideoKey, code: string): TranscriptState => ({ state: "failed", video, failure: { code } as TranscriptFailure });

test("YouTube 上还没读到、或者上次读碰上广告：点生成先经视频页读；B 站、别的报错、没有标签页时不带", () => {
  assert.equal(readsFirst(failed(TUBE, "NOT_CACHED"), 4), true);
  assert.equal(readsFirst(failed(TUBE, "PAGE_ACTION_NEEDED"), 4), true, "上次读碰上广告，和读取按钮一样能再试");
  assert.equal(readsFirst(failed(TUBE, "NOT_CACHED"), null), false);
  assert.equal(readsFirst(failed(BILI, "NOT_CACHED"), 4), false, "B 站不经页面读");
  assert.equal(readsFirst(failed(TUBE, "NO_CAPTIONS"), 4), false, "确实没有字幕，再读也没用");
  assert.equal(readsFirst({ state: "loading", video: TUBE }, 4), false);
});

test("概览任务一结束就从本机补字幕：存好、报错、停下都算；字幕不在读取提示上、换了视频时不补", () => {
  const overview = signal({ video: TUBE, task: null } as unknown as OverviewState);
  const transcript = signal<TranscriptState>(failed(TUBE, "NOT_CACHED"));
  const target = signal({ tabId: 4, video: TUBE, title: "" });
  const loads: unknown[][] = [];
  const stop = refillAfterGenerate({ state: overview }, { state: transcript, load: async (...args: unknown[]) => void loads.push(args) } as never, { target } as never);
  try {
    const run = (id: string | null) => (overview.value = { ...overview.value, task: id ? { id } : null } as unknown as OverviewState);
    assert.deepEqual(loads, [], "没跑过任务不补");
    run("t1");
    run(null);
    assert.deepEqual(loads, [[TUBE, 4, { localOnly: true }]], "任务结束、字幕还没读到：从本机补");

    transcript.value = failed(TUBE, "UNAVAILABLE");
    run("t2");
    run(null);
    assert.equal(loads.length, 1, "用户自己读字幕读到了别的结果，不盖掉");

    transcript.value = failed(TUBE, "PAGE_ACTION_NEEDED");
    overview.value = { ...overview.value, video: "youtube:jmSample0002" } as unknown as OverviewState;
    run("t3");
    run(null);
    assert.equal(loads.length, 1, "任务属于别的视频时不补");
  } finally {
    stop();
  }
});
