// 卡片的轻量读取：卡片摆的是官方总结、本机已有的概览和结论，用不着字幕。没缓存时只问视频信息和官方总结，
// 不取字幕，也不新建缓存条目；已缓存时照常用缓存。同一个视频的完整读取在路上时并进去，最多等 4 秒；
// 先轻量后完整时，完整读取接着用记着的官方总结。站点是替身，缓存和概览用真实仓储加内存驱动，计时器手动推进。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIGHT_JOIN_MS, LIGHT_MEMO_LIMIT } from "../../../../../src/background/services/transcript/light.ts";
import { OFFICIAL_GRACE_MS } from "../../../../../src/background/services/transcript/official.ts";
import { createOverviewStore } from "../../../../../src/background/stores/overviews.ts";
import type { LearningAnalysis } from "../../../../../src/core/notes/markdown.ts";
import type { GuidesReply, GuidesView } from "../../../../../src/shared/messages/transcript.ts";
import type { Cue, OfficialSummary, SiteResult } from "../../../../../src/sites/types.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { failed, type SiteMethod } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, harness, KEY, REF, sampleInfo, START, texts, view, type Harness, type HarnessOptions } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const MINUTE = 60_000;
const P2 = { ...REF, segment: 2 };
const OFFICIAL_CUES: Cue[] = [
  { start: 0, duration: 3, text: "官方总结里的第一句" },
  { start: 3, duration: 3, text: "官方总结里的第二句" },
];
const SUMMARY: OfficialSummary = { status: "ok", summary: "官方摘要", outline: [], cues: [] };
const WITH_CUES: OfficialSummary = { ...SUMMARY, cues: OFFICIAL_CUES };
const ANALYSIS: LearningAnalysis = {
  chapters: [{ timestamp: "0:00", timestampSeconds: 0, title: "开场", summary: "摘要" }],
  keyQuotes: [],
  verdict: { verdict: "看概览就够", summary: "一句话结论" },
};
// 只用官方总结写过结论的视频：本机只有结论，没有章节。
const VERDICT_ONLY: LearningAnalysis = { chapters: [], keyQuotes: [], verdict: { verdict: "可以跳过", summary: "用官方总结写的结论" } };

const ok = <T>(value: T): SiteResult<T> => ({ ok: true, value: structuredClone(value) });
const status = (value: OfficialSummary["status"]): OfficialSummary => ({ status: value, summary: "", outline: [], cues: [] });
const storedOfficial = (value: "ok" | "queued" | "pending", summary = value === "ok" ? "缓存里的官方摘要" : "") =>
  ({ status: value, summary, outline: [], hasCaptions: false, fetchedAt: START }) as const;

/** 官方总结默认有内容。 */
function rig(options: HarnessOptions = {}): Harness {
  return harness({ ...options, site: { officialSummary: () => ok(SUMMARY), ...options.site } });
}

const fallbackOn = (options: HarnessOptions = {}): Harness => rig({ ...options, officialCaptionsFallback: true });

async function withOverview(h: Harness, analysis: LearningAnalysis): Promise<void> {
  await createOverviewStore({ driver: h.overviewsDriver, guard: h.guard }).save({ videoKey: KEY, analysis });
}

function guides(reply: GuidesReply): GuidesView {
  if (!reply.ok) throw new Error(`应该成功：${JSON.stringify(reply)}`);
  return reply.value;
}

const count = (h: Harness, method: SiteMethod): number => h.site.count(method);
const methods = (h: Harness): string[] => h.site.calls.map((call) => call.method).sort();

/** 卡片只看有没有字幕，字幕本身、字幕轨和分段都不经消息传过去。 */
function assertSlim(view: GuidesView): void {
  for (const field of ["transcript", "tracks", "chapters", "segments", "cues"]) assert.equal(field in view, false, `${field} 不该传给卡片`);
  assert.equal(view.hasTranscript, true);
}

// ============================================================
// 没缓存时只问视频信息和官方总结
// ============================================================

test("没缓存时只问视频信息和官方总结，不取字幕，也不新建字幕缓存", async () => {
  const h = rig();
  const result = guides(await h.service.light(REF));

  assert.deepEqual(methods(h), ["readOfficialSummary", "readVideoInfo"]);
  assert.equal(result.mode, "light");
  assert.equal(result.hasTranscript, false, "这次没读字幕");
  assert.equal(result.fromCache, false);
  assert.equal(result.info.title, sampleInfo(REF).title);
  assert.equal(result.official?.status, "ok");
  assert.equal(result.official?.summary, "官方摘要");
  assert.equal("transcript" in result, false);
  assert.deepEqual(await h.rows(), [], "不新建字幕缓存条目");
});

test("没缓存时带回本机已有的概览和结论", async () => {
  const h = rig();
  await withOverview(h, ANALYSIS);
  const result = guides(await h.service.light(REF));
  assert.deepEqual(result.overview?.analysis, ANALYSIS);
  assert.deepEqual(result.overview?.analysisFailures, []);
  assert.deepEqual(methods(h), ["readOfficialSummary", "readVideoInfo"]);
});

test("取字幕带轻量模式：只问视频信息和官方总结，不取字幕、不建缓存；不带轻量模式照旧完整读取", async () => {
  const h = rig({ site: { tracks: () => ok([]) } });
  const light = guides(await h.service.light(REF));
  assert.equal(light.hasTranscript, false);
  assert.equal(light.info.title, sampleInfo(REF).title);
  assert.equal(light.official?.summary, "官方摘要");
  assert.deepEqual(methods(h), ["readOfficialSummary", "readVideoInfo"]);
  assert.deepEqual(await h.rows(), [], "不新建字幕缓存");

  h.site.calls.length = 0;
  const full = await h.service.get(REF, { mode: "full" });
  assert.equal(!full.ok && full.code, "NO_CAPTIONS");
  assert.equal(!full.ok && full.official?.summary, "官方摘要");
  assert.deepEqual(methods(h), ["listCaptionTracks", "readCreatorChapters", "readVideoInfo"], "官方总结接着用刚才问到的，视频信息重新核对");
});

// ============================================================
// 已缓存时照常用缓存
// ============================================================

test("字幕已经缓存时照常返回缓存，一个 B站请求都不发", async () => {
  const h = rig({ seed: [cachedRow(undefined, { official: storedOfficial("ok") })] });
  await withOverview(h, ANALYSIS);
  const result = guides(await h.service.light(REF));
  assert.deepEqual(h.site.calls, []);
  assert.equal(result.fromCache, true);
  assert.equal(result.hasTranscript, true);
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.deepEqual(result.overview?.analysis, ANALYSIS);
});

test("命中字幕缓存：只交卡片要的字段，用 hasTranscript 说明有字幕", async () => {
  const h = rig({ seed: [cachedRow(undefined, { official: storedOfficial("ok") })] });
  await withOverview(h, ANALYSIS);
  const result = guides(await h.service.light(REF));
  assertSlim(result);
  assert.equal(result.fromCache, true);
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.deepEqual(result.overview?.analysis, ANALYSIS);
  assert.equal(result.info.title, sampleInfo(REF).title);
  assert.ok((await h.rows())[0]?.transcript?.cues.length, "缓存本身不受影响");
});

test("缓存里只剩视频信息和官方总结（字幕被作废了）：卡片照常摆出来，平台请求为零", async () => {
  const { transcript: _dropped, ...rest } = cachedRow(undefined, { official: storedOfficial("ok"), tracks: [] });
  const h = rig({ seed: [rest] });
  const result = guides(await h.service.light(REF));
  assert.deepEqual(h.site.calls, []);
  assert.equal(result.hasTranscript, false);
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.equal(result.info.title, sampleInfo(REF).title);
});

test("从缓存接过来的官方总结带着附带字幕的标记、兜底打开时：完整读取照常再问，拿附带的字幕兜底", async () => {
  const { transcript: _dropped, ...rest } = cachedRow(undefined, { official: { ...storedOfficial("ok"), hasCaptions: true }, tracks: [] });
  const h = fallbackOn({ seed: [rest], site: { tracks: () => ok([]), officialSummary: () => ok(WITH_CUES) } });
  await h.service.light(REF);
  assert.equal(count(h, "readOfficialSummary"), 0);

  const full = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(full.transcript.ref.kind, "official-ai");
  assert.equal(count(h, "readOfficialSummary"), 1);
});

// ============================================================
// 记在内存里：同一个视频再读不再问
// ============================================================

test("同一个视频再读一次：用记着的视频信息和官方总结，不再问 B站", async () => {
  const h = rig();
  await h.service.light(REF);
  const again = guides(await h.service.light(REF));
  assert.deepEqual(methods(h), ["readOfficialSummary", "readVideoInfo"]);
  assert.equal(again.official?.summary, "官方摘要");
  assert.deepEqual(await h.rows(), []);
});

test("同时读两次只问一次；换分 P 各问各的", async () => {
  const h = rig();
  const [a, b, p2] = await Promise.all([h.service.light(REF), h.service.light(REF), h.service.light(P2)]);
  assert.equal(a.ok && b.ok && p2.ok, true);
  assert.equal(count(h, "readVideoInfo"), 2);
  assert.equal(count(h, "readOfficialSummary"), 2);
  assert.equal(guides(p2).info.title, sampleInfo(P2).title);
});

test("记着的官方总结还在排队：十分钟后再读才重问一次", async () => {
  const h = rig({ site: { officialSummary: () => ok(status("queued")) } });
  await h.service.light(REF);
  await h.service.light(REF);
  assert.equal(count(h, "readOfficialSummary"), 1);

  h.timers.advance(11 * MINUTE);
  h.site.script.officialSummary = () => ok({ ...SUMMARY, summary: "排完队了" });
  const later = guides(await h.service.light(REF));
  assert.equal(count(h, "readOfficialSummary"), 2);
  assert.equal(count(h, "readVideoInfo"), 1, "视频信息不再问");
  assert.equal(later.official?.summary, "排完队了");
});

test("视频信息取不到时如实报错，不记下来，下次重新问", async () => {
  const h = rig({ site: { videoInfo: () => failed("NOT_FOUND") } });
  const first = await h.service.light(REF);
  assert.equal(!first.ok && first.code, "NOT_FOUND");
  assert.equal(count(h, "readOfficialSummary"), 0);

  h.site.script.videoInfo = (ref) => ok(sampleInfo(ref));
  assert.equal((await h.service.light(REF)).ok, true);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("轻量读取最多记 10 个视频，最早的先忘", async () => {
  const h = rig();
  const refs = Array.from({ length: LIGHT_MEMO_LIMIT + 1 }, (_, index) => ({ ...REF, segment: index + 1 }));
  for (const ref of refs) await h.service.light(ref);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 1);

  await h.service.light(refs[LIGHT_MEMO_LIMIT] ?? REF);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 1, "最近的还记着");
  await h.service.light(REF);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 2, "最早的忘了，重新问");
});

test("清除本机数据时也忘掉卡片轻量读取记着的视频信息和官方总结", async () => {
  const h = rig();
  await h.service.light(REF);
  await h.service.light(REF);
  assert.equal(count(h, "readVideoInfo"), 1, "记着时不再问");

  h.service.forget("cache");
  await h.service.light(REF);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("读取途中清除了本机数据：读到的照样交给卡片，但不记下来", async () => {
  const held = deferred();
  const h = rig({ site: { videoInfo: async (ref) => (await held.promise, ok(sampleInfo(ref))) } });
  const first = h.service.light(REF);
  assert.ok(await until(() => count(h, "readVideoInfo") === 1));
  h.service.forget("all");
  held.resolve();
  assert.equal((await first).ok, true);

  await h.service.light(REF);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("导入字幕文件时忘掉这个视频轻量读取记着的，在途的也不再并进", async () => {
  const h = rig();
  await h.service.light(REF);
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "导入的一句", ""].join("\n");
  assert.equal((await h.service.importFile(REF, { name: "课程.srt", text: srt })).ok, true);

  await h.service.light(REF);
  assert.equal(count(h, "readVideoInfo"), 2);
});

// ============================================================
// 先轻量、后完整：完整读取接着用记着的官方总结
// ============================================================

test("先轻量读取、后完整读取：官方总结不再问，视频信息重新核对一次，再取字幕", async () => {
  const h = rig();
  await h.service.light(REF);
  const full = view(await h.service.get(REF, { mode: "full" }));

  assert.match(texts(await h.service.get(REF, { mode: "cache-only" })), /第一句/);
  assert.equal(full.official?.summary, "官方摘要");
  assert.equal(full.info.title, sampleInfo(REF).title);
  assert.equal(count(h, "readOfficialSummary"), 1);
  assert.equal(count(h, "readVideoInfo"), 2, "每次完整读取都先核对视频信息");
  assert.equal(count(h, "listCaptionTracks"), 1);
  assert.equal(count(h, "readCaptions"), 1);
  assert.equal((await h.rows()).length, 1);
});

test("播放器没有字幕时，完整读取用轻量读取记着的官方总结附带字幕兜底，不再问官方总结", async () => {
  const h = fallbackOn({ site: { tracks: () => ok([]), officialSummary: () => ok(WITH_CUES) } });
  assert.equal(guides(await h.service.light(REF)).official?.status, "ok");
  const full = view(await h.service.get(REF, { mode: "full" }));

  assert.equal(full.transcript.ref.kind, "official-ai");
  assert.match(texts({ ok: true, value: full }), /官方总结里的第一句/);
  assert.equal(count(h, "readOfficialSummary"), 1);
});

for (const [label, first] of [
  ["网络没通", () => failed("NETWORK")],
  ["还在排队", () => ok(status("queued"))],
] as const) {
  test(`轻量读取时官方总结没有定论（${label}）：完整读取不沿用，再问一次，用附带的 AI 字幕兜底`, async () => {
    const h = fallbackOn({ site: { tracks: () => ok([]), officialSummary: first } });
    assert.notEqual(guides(await h.service.light(REF)).official?.status, "ok");

    // 一分钟后完整读取：远没到十分钟。
    h.timers.advance(MINUTE);
    h.site.script.officialSummary = () => ok(WITH_CUES);
    const full = view(await h.service.get(REF, { mode: "full" }));

    assert.equal(full.transcript.ref.kind, "official-ai");
    assert.match(texts({ ok: true, value: full }), /官方总结里的第一句/);
    assert.equal(full.official?.status, "ok");
    assert.equal(count(h, "readOfficialSummary"), 2, "完整读取再问了一次");
  });
}

test("轻量读取时未登录：只报要登录，不问官方总结也不记下来；登录后完整读取照常从头读", async () => {
  const h = rig({ site: { videoInfo: () => failed("NEED_LOGIN") } });
  const light = await h.service.light(REF);
  assert.equal(!light.ok && light.code, "NEED_LOGIN");
  assert.equal(count(h, "readOfficialSummary"), 0);

  h.site.script.videoInfo = (ref) => ok(sampleInfo(ref));
  const full = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(full.official?.summary, "官方摘要");
  assert.equal(count(h, "readVideoInfo"), 2);
  assert.equal(count(h, "readOfficialSummary"), 1);
});

test("完整读取重问到了官方总结但还是取不到字幕：卡片再读摆新的那份，不再摆记着的旧结果", async () => {
  const h = rig({ site: { tracks: () => ok([]), officialSummary: () => failed("NETWORK") } });
  await h.service.light(REF);

  h.site.script.officialSummary = () => ok({ ...SUMMARY, summary: "后来问到的官方摘要" });
  const full = await h.service.get(REF, { mode: "full" });
  assert.equal(!full.ok && full.code, "NO_CAPTIONS");
  assert.equal(!full.ok && full.official?.summary, "后来问到的官方摘要");

  const again = guides(await h.service.light(REF));
  assert.equal(again.official?.status, "ok");
  assert.equal(again.official?.summary, "后来问到的官方摘要");
  assert.equal(count(h, "readOfficialSummary"), 2, "卡片再读不用再问");
});

for (const settled of ["none", "unsupported"] as const) {
  test(`轻量读取记着的官方总结已有定论（${settled}）：完整读取接着用，不再问`, async () => {
    const h = rig({ site: { officialSummary: () => ok(status(settled)) } });
    await h.service.light(REF);
    const full = view(await h.service.get(REF, { mode: "full" }));
    assert.equal(full.official?.status, settled);
    assert.equal(count(h, "readOfficialSummary"), 1);
  });
}

test("轻量读取记着的官方总结是别的媒体版本：完整读取不接着用，照常再问", async () => {
  const h = rig();
  await h.service.light(REF);
  h.site.script.videoInfo = (ref) => ok(sampleInfo(ref, { mediaVersion: "换过内容的版本" }));
  view(await h.service.get(REF, { mode: "full" }));
  assert.equal(count(h, "readOfficialSummary"), 2);
});

test("强制刷新不接轻量读取记着的东西，视频信息和官方总结都重新问", async () => {
  const h = rig();
  await h.service.light(REF);
  view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(count(h, "readVideoInfo"), 2);
  assert.equal(count(h, "readOfficialSummary"), 2);
});

// ============================================================
// 和完整读取同时发生
// ============================================================

for (const order of ["轻量读取先发", "完整读取先发"] as const) {
  const title =
    order === "轻量读取先发"
      ? `和完整读取同时发生（${order}）：官方总结、字幕列表和字幕文件都只问一次，完整读取拿到的数据是全的`
      : `和完整读取同时发生（${order}）：B站每个接口只问一次，完整读取拿到的数据是全的`;
  test(title, async () => {
    const h = rig();
    const [lightReply, fullReply] =
      order === "轻量读取先发"
        ? await Promise.all([h.service.light(REF), h.service.get(REF, { mode: "full" })])
        : await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]).then(([full, light]) => [light, full] as const);

    const full = view(fullReply);
    assert.equal(full.fromCache, false);
    assert.match(texts(fullReply), /第一句/);
    assert.ok(full.transcript.segments.length > 0);
    assert.equal(full.official?.summary, "官方摘要");
    assert.equal(full.info.title, sampleInfo(REF).title);
    assert.equal(full.transcript.ref.lang, "zh-CN");
    assert.equal(guides(lightReply).official?.summary, "官方摘要");
    assert.equal(count(h, "readOfficialSummary"), 1);
    assert.equal(count(h, "listCaptionTracks"), 1);
    assert.equal(count(h, "readCaptions"), 1);
    // 轻量读取先发时完整读取照样自己核对一次视频信息；完整读取先发时卡片并进它，视频信息也只问一次。
    assert.equal(count(h, "readVideoInfo"), order === "轻量读取先发" ? 2 : 1);
    assert.equal((await h.rows()).length, 1);
    assert.ok((await h.rows())[0]?.transcript?.cues.length);
  });
}

test("并进成功的完整读取：同样只交卡片要的字段，完整读取自己拿到的仍是全量", async () => {
  const h = rig();
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]);
  assert.ok(view(full).transcript.cues.length);
  assert.match(texts(full), /第一句/);
  assertSlim(guides(light));
  assert.equal(guides(light).official?.summary, "官方摘要");
});

test("卡片并进先交了字幕的完整读取：等官方总结回来再交，不说成没有官方总结", async () => {
  const held = deferred();
  const h = rig({ site: { officialSummary: async () => (await held.promise, ok(SUMMARY)) } });
  const full = h.service.get(REF, { mode: "full" });
  const light = h.service.light(REF);
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1), "字幕到了，在等官方总结");
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await full).official?.status, "pending");

  held.resolve();
  const card = guides(await light);
  assert.equal(card.official?.summary, "官方摘要");
  assert.equal(count(h, "readOfficialSummary"), 1);
});

test("卡片并进的完整读取卡在下载：等一小会儿就改走轻量读取，官方总结不重复问", async () => {
  const held = deferred();
  const h = rig({ site: { captions: async () => (await held.promise, ok(OFFICIAL_CUES)) } });
  const full = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => count(h, "readCaptions") === 1), "完整读取已经开始下载");

  const light = h.service.light(REF);
  assert.ok(await until(() => h.timers.due(LIGHT_JOIN_MS) === 1));
  h.timers.advance(LIGHT_JOIN_MS);
  const card = guides(await light);
  assert.equal(card.hasTranscript, false);
  assert.equal(card.official?.summary, "官方摘要");
  assert.equal(count(h, "readOfficialSummary"), 1, "官方总结和完整读取共用一次请求");
  assert.equal(count(h, "readVideoInfo"), 1);

  held.resolve();
  assert.equal((await full).ok, true);
});

for (const [label, script, code] of [
  ["没有 CC 字幕", { tracks: () => ok([]) }, "NO_CAPTIONS"],
  ["字幕要登录才看得到", { tracks: () => failed("NEED_LOGIN") }, "NEED_LOGIN"],
] as const) {
  test(`并进的完整读取失败（${label}）：卡片照样拿到官方总结和已有的结论，带上取不到字幕的原因，B站不多问`, async () => {
    const h = rig({ site: script });
    await withOverview(h, VERDICT_ONLY);
    const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]);

    assert.equal(!full.ok && full.code, code);
    const card = guides(light);
    assert.equal(card.hasTranscript, false);
    assert.equal(card.fromCache, false);
    assert.equal(card.transcriptError, code);
    assert.equal(card.info.title, sampleInfo(REF).title);
    assert.equal(card.official?.summary, "官方摘要");
    assert.deepEqual(card.overview?.analysis, VERDICT_ONLY, "本机已有的结论照常带回");
    assert.equal(count(h, "readVideoInfo"), 1);
    assert.equal(count(h, "readOfficialSummary"), 1);
    assert.equal(count(h, "listCaptionTracks"), 1);
    assert.deepEqual(await h.rows(), []);
  });
}

test("并进的完整读取要登录：卡片只提示登录，不另读视频信息和官方总结，本机已有的结论照常带回", async () => {
  const h = rig({ site: { videoInfo: () => failed("NEED_LOGIN") } });
  await withOverview(h, VERDICT_ONLY);
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]);

  assert.equal(!full.ok && full.code, "NEED_LOGIN");
  assert.equal(!light.ok && light.code, "NEED_LOGIN");
  assert.deepEqual(!light.ok && light.overview?.analysis, VERDICT_ONLY);
  assert.deepEqual(methods(h), ["readVideoInfo"]);
  assert.deepEqual(await h.rows(), []);
});

test("并进的完整读取被限流：卡片照样摆官方总结和结论，不带取不到字幕的提示", async () => {
  const h = rig({ site: { tracks: () => failed("RATE_LIMITED") } });
  await withOverview(h, VERDICT_ONLY);
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]);

  assert.equal(!full.ok && full.code, "RATE_LIMITED");
  const card = guides(light);
  assert.equal(card.transcriptError, undefined, "过一阵再试可能就好了，不说成没有字幕");
  assert.equal(card.official?.summary, "官方摘要");
  assert.deepEqual(card.overview?.analysis, VERDICT_ONLY);
  assert.equal(count(h, "readVideoInfo"), 1);
  assert.equal(count(h, "readOfficialSummary"), 1);
  assert.equal(count(h, "listCaptionTracks"), 1);
});

test("并进的完整读取连视频信息都没拿到：卡片如实报错，不再单独问一遍", async () => {
  const h = rig({ site: { videoInfo: () => failed("NOT_FOUND") } });
  const [, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF)]);
  assert.equal(!light.ok && light.code, "NOT_FOUND");
  assert.deepEqual(methods(h), ["readVideoInfo"]);
});

test("缓存写入之后才发起的轻量读取不并进写之前的那一次，拿得到刚写进缓存的内容", async () => {
  const held = deferred();
  // 上次先交了字幕、官方总结还没写回的占位记录：命中缓存也要等重问回来。
  const h = rig({
    seed: [cachedRow(undefined, { official: storedOfficial("pending") })],
    site: { officialSummary: async () => (await held.promise, failed("NEED_LOGIN")) },
  });
  const before = h.service.light(REF);
  assert.ok(await until(() => count(h, "readOfficialSummary") === 1), "在重问官方总结");

  await h.service.writer.update(KEY, (current) => (current ? { ...current, official: storedOfficial("ok", "刚写进缓存的官方摘要") } : null));
  const after = h.service.light(REF);

  held.resolve();
  const [early, late] = await Promise.all([before, after]);
  assert.equal(early.ok, true);
  assert.equal(guides(late).official?.summary, "刚写进缓存的官方摘要");
});
