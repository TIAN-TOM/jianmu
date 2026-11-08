// 时间轴和视频时长对不上的字幕：照常交给页面并标明，但不进字幕缓存，只在内存里记着最近几份；同一视频之后的读取用它，
// 刷新才重新去取。清除本机数据时一起忘掉，清除之前开始的读取回来也不写回。站点是替身，时间全靠手动推进的计时器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "../../../../../src/core/errors.ts";
import type { VideoRef } from "../../../../../src/core/video-ref.ts";
import type { TranscriptReply } from "../../../../../src/shared/messages/transcript.ts";
import type { CaptionTrack, Cue, SiteResult, VideoInfo } from "../../../../../src/sites/types.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import type { SiteScript } from "../../../../helpers/fake-site-service.ts";
import { EN, harness, KEY, REF, sampleInfo, view, ZH } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const AUTO_ZH: CaptionTrack = { trackId: "ai-zh", lang: "ai-zh", label: "中文（自动生成）", kind: "auto" };

/** 从 0 秒到 lastEnd 秒均匀铺 count 条字幕。 */
const lines = (lastEnd: number, count = 5): Cue[] =>
  Array.from({ length: count }, (_, index) => {
    const end = (lastEnd * (index + 1)) / count;
    const start = Math.max(0, end - 2);
    return { start, duration: end - start, text: `第 ${index + 1} 句` };
  });

const infoOf = (durationSec: number, extra: Partial<VideoInfo> = {}) => (ref: VideoRef): SiteResult<VideoInfo> => ({ ok: true, value: sampleInfo(ref, { durationSec, ...extra }) });

/** 只有一条自动字幕，正文铺到 lastEnd 秒，视频时长 duration 秒。 */
const autoOnly = (duration: number, lastEnd: () => number): Partial<SiteScript> => ({
  videoInfo: infoOf(duration),
  tracks: () => ({ ok: true, value: [AUTO_ZH] }),
  captions: () => ({ ok: true, value: lines(lastEnd()) }),
});

const failure = (reply: TranscriptReply) => {
  if (reply.ok) throw new Error("应该失败");
  return reply;
};

// ============================================================
// 标记、不进缓存
// ============================================================

test("播放器字幕的时间轴超出视频时长：照常返回，带 subtitleMismatch，不写字幕缓存", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.subtitleMismatch, true);
  assert.equal(reply.transcript.cues.length, 5);
  assert.equal(reply.fromCache, false);
  assert.deepEqual(await h.rows(), [], "对不上的字幕不能进缓存");
});

test("时间轴和时长对得上：不带标记，照常进缓存", async () => {
  const h = harness({ site: autoOnly(600, () => 590) });
  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.equal("subtitleMismatch" in reply, false);
  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert.equal("subtitleMismatch" in (rows[0] ?? {}), false);
});

test("拿不到时长时不判断，照常进缓存", async () => {
  const h = harness({ site: autoOnly(0, () => 5000) });
  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.subtitleMismatch, undefined);
  assert.equal((await h.rows()).length, 1);
});

test("分 P 视频按当前分 P 的时长判断，不拿全片总时长", async () => {
  const segments = [
    { index: 1, title: "上", durationSec: 3000 },
    { index: 2, title: "下", durationSec: 200 },
  ];
  const h = harness({
    site: {
      videoInfo: (ref) => infoOf(ref.segment === 2 ? 200 : 3000, { segments })(ref),
      tracks: () => ({ ok: true, value: [AUTO_ZH] }),
      captions: () => ({ ok: true, value: lines(2900) }),
    },
  });
  const second = view(await h.service.get({ ...REF, segment: 2 }, { mode: "full" }));
  assert.equal(second.subtitleMismatch, true, "第二 P 只有 200 秒");
  const first = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(first.subtitleMismatch, undefined);
});

test("同一视频同时发起的两次读取仍然合并成一次请求，两边都带标记", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  const [a, b] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full" })]);
  assert.equal(view(a).subtitleMismatch, true);
  assert.equal(view(b).subtitleMismatch, true);
  assert.equal(h.site.count("readVideoInfo"), 1);
  assert.equal(h.site.count("readCaptions"), 1);
});

// ============================================================
// 内存里记着，之后的读取用它
// ============================================================

test("之后的读取和只读缓存的读取用内存里记着的那份，不再问平台", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  await h.service.get(REF, { mode: "full" });
  const before = h.site.calls.length;

  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.subtitleMismatch, true);
  assert.equal(again.fromCache, false, "不是缓存里的");
  const cacheOnly = view(await h.service.get(REF, { mode: "cache-only" }));
  assert.equal(cacheOnly.subtitleMismatch, true);
  assert.equal(cacheOnly.transcript.cues.length, 5);

  assert.equal(h.site.calls.length, before, "概览、问答、翻译反复读字幕时不能一遍遍去平台");
  assert.deepEqual(await h.rows(), []);
});

test("点名别的语言时不拿记着的那份顶替", async () => {
  const h = harness({
    site: {
      videoInfo: infoOf(120),
      tracks: () => ({ ok: true, value: [AUTO_ZH, EN] }),
      captions: (_info, track) => ({ ok: true, value: lines(track === EN ? 110 : 900) }),
    },
  });
  const first = view(await h.service.get(REF, { mode: "full", lang: "ai-zh" }));
  assert.equal(first.subtitleMismatch, true);
  const english = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(english.transcript.ref.lang, "en-US");
  assert.equal(english.subtitleMismatch, undefined);
  assert.equal((await h.rows()).length, 1);
});

test("强制刷新重新去取；这次对上了就进缓存，内存里记着的作废", async () => {
  let lastEnd = 900;
  const h = harness({ site: autoOnly(120, () => lastEnd) });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).subtitleMismatch, true);

  lastEnd = 118;
  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(refreshed.subtitleMismatch, undefined);
  assert.equal((await h.rows()).length, 1);
  assert.equal(h.site.count("readCaptions"), 2);

  const cached = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(cached.fromCache, true);
  assert.equal(cached.subtitleMismatch, undefined);
});

test("缓存里已有正常字幕时，任务快照带来的标记不跟着写进缓存", async () => {
  const h = harness({ site: autoOnly(600, () => 590) });
  await h.service.get(REF, { mode: "full" });
  const chapter = { title: "加的分段", start: 0, end: null };

  await h.service.writer.update(KEY, (current) => current && ({ ...current, subtitleMismatch: true, chapters: [chapter] } as typeof current));

  const [row] = await h.rows();
  assert.deepEqual(row?.chapters, [chapter], "改动照常写进去了");
  assert.equal(row && "subtitleMismatch" in row, false);
  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.fromCache, true);
  assert.equal(again.subtitleMismatch, undefined);
});

test("刷新取回的字幕对不上、缓存里原来那份对得上：继续用原来那份，告诉页面，不写缓存也不记内存", async () => {
  let lastEnd = 110;
  const h = harness({ site: autoOnly(120, () => lastEnd) });
  const good = view(await h.service.get(REF, { mode: "full" }));
  const [before] = await h.rows();

  lastEnd = 900;
  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(h.site.count("readCaptions"), 2, "刷新真的重新取了");
  assert.equal(refreshed.fromCache, true);
  assert.equal(refreshed.refreshMismatched, true);
  assert.equal(refreshed.subtitleMismatch, undefined);
  assert.deepEqual(refreshed.transcript.cues, good.transcript.cues);
  assert.deepEqual(await h.rows(), [before], "缓存原样留着");

  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.fromCache, true);
  assert.equal(again.refreshMismatched, undefined);
  assert.deepEqual(again.transcript.cues, good.transcript.cues, "之后读到的还是原来那份，没记进内存");
});

test("缓存里有正常字幕、换到一条对不上的语言：报错并留着原来的字幕，不让两边各用一份", async () => {
  const h = harness({
    site: {
      videoInfo: infoOf(120),
      tracks: () => ({ ok: true, value: [ZH, EN] }),
      captions: (_info, track) => ({ ok: true, value: lines(track === EN ? 900 : 110) }),
    },
  });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.lang, "zh-CN");

  const english = failure(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(english.code, "SUBTITLE_MISMATCH");
  assert.match(describe(english.code), /对不上/);
  assert.deepEqual(english.tracks?.map((track) => track.lang), ["zh-CN", "en-US"], "语言菜单照样能换回去");
  assert.equal(english.info?.durationSec, 120);

  const back = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(back.transcript.ref.lang, "zh-CN");
  assert.equal(back.fromCache, true);
  const named = view(await h.service.get(REF, { mode: "full", lang: "zh-CN" }));
  assert.equal(named.fromCache, true);
  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.transcript?.ref.lang, "zh-CN");
});

test("内存里最多记 5 个视频，多了丢最早记的", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  const refs = Array.from({ length: 6 }, (_, index): VideoRef => ({ ...REF, videoId: `BV1Sample${String(index + 10).padStart(3, "0")}` }));
  for (const ref of refs) assert.equal(view(await h.service.get(ref, { mode: "full" })).subtitleMismatch, true);
  const before = h.site.count("readVideoInfo");

  await h.service.get(refs[5] as VideoRef, { mode: "full" });
  assert.equal(h.site.count("readVideoInfo"), before, "最近记的还在");
  await h.service.get(refs[0] as VideoRef, { mode: "full" });
  assert.equal(h.site.count("readVideoInfo"), before + 1, "最早记的已经丢了，重新去取");
});

// ============================================================
// 清除本机数据
// ============================================================

test("清除本机数据时忘掉内存里记着的字幕：之后的读取重新去平台取", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  await h.service.get(REF, { mode: "full" });

  h.service.forget("cache");
  const again = await h.service.get(REF, { mode: "full" });
  assert.equal(again.ok, true);
  assert.equal(h.site.count("readCaptions"), 2, "重新下载了字幕");
});

test("清除缓存以后，清除之前记进内存的那份也不再用", async () => {
  const h = harness({ site: autoOnly(120, () => 900) });
  await h.service.get(REF, { mode: "full" });

  await h.guard.clear("cache", () => h.driver.clear());
  assert.equal((await h.service.get(REF, { mode: "cache-only" })).ok, false);
  await h.service.get(REF, { mode: "full" });
  assert.equal(h.site.count("readCaptions"), 2);
});

// 「清除本机数据」时还有字幕读取在途：它回来以后不能把清除之前的结果写回内存或缓存。
for (const [label, lastEnd] of [
  ["对不上的字幕（只记内存）", 900],
  ["对得上的字幕（进缓存）", 110],
] as const) {
  test(`清除本机数据时字幕下载还在途，${label}：回来后不写回内存和缓存`, async () => {
    const held = deferred();
    const h = harness({
      site: { videoInfo: infoOf(120), tracks: () => ({ ok: true, value: [AUTO_ZH] }), captions: () => held.promise.then(() => ({ ok: true, value: lines(lastEnd) })) },
    });
    const pending = h.service.get(REF, { mode: "full" });
    assert.ok(await until(() => h.site.count("readCaptions") === 1), "字幕下载已经发出");
    h.service.forget("cache");
    held.resolve();
    assert.equal((await pending).ok, true, "发起的调用方照样拿到结果");

    assert.deepEqual(await h.rows(), [], "清除之后不写回缓存");
    await h.service.get(REF, { mode: "full" });
    assert.equal(h.site.count("readCaptions"), 2, "清除之后的读取重新去取，不用清除之前那份");
  });
}
