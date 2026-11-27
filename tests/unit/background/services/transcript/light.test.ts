// 卡片的轻量读取：卡片摆的是官方总结、本机已有的概览和结论，用不着字幕正文。没缓存时问视频信息和官方总结，
// 登录着的再列一次字幕轨，只看有没有：不读字幕文件，也不新建缓存条目；列表空着、官方总结也不会附带字幕兜底时告诉卡片没有字幕。
// 已缓存时照常用缓存。同一个视频的完整读取在路上时并进去，最多等 4 秒；先轻量后完整时，完整读取接着用记着的官方总结。
// YouTube 只看本机，本机没有字幕时只问一句卡片所在的页面播放器上有没有字幕轨，不向平台要任何东西。
// 站点是替身，缓存和概览用真实仓储加内存驱动，计时器手动推进。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIGHT_JOIN_MS, LIGHT_MEMO_LIMIT } from "../../../../../src/background/services/transcript/light.ts";
import { OFFICIAL_GRACE_MS } from "../../../../../src/background/services/transcript/official.ts";
import { createOverviewStore } from "../../../../../src/background/stores/overviews.ts";
import type { LearningAnalysis } from "../../../../../src/core/notes/records.ts";
import { videoKey, type VideoRef } from "../../../../../src/core/video-ref.ts";
import type { GuidesReply, GuidesView } from "../../../../../src/shared/messages/transcript.ts";
import type { Cue, OfficialSummary, SiteResult } from "../../../../../src/sites/types.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { failed, fakeSiteService, type SiteMethod } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, harness, KEY, REF, sampleInfo, START, texts, view, ZH, type Harness, type HarnessOptions } from "../../../../helpers/transcript-service.ts";
import { stillFalse, until } from "../../../../helpers/wait-until.ts";

const MINUTE = 60_000;
/** 卡片所在的标签页：带着它的是卡片来读，不带的是后台为「打开就出结论」问时长。 */
const TAB = 37;
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
// 没缓存时问视频信息、官方总结，登录着的再列一次字幕轨
// ============================================================

test("没缓存时问视频信息和官方总结，再列一次字幕轨：不读字幕文件，也不新建字幕缓存", async () => {
  const h = rig();
  const result = guides(await h.service.light(REF, TAB));

  assert.deepEqual(methods(h), ["listCaptionTracks", "readOfficialSummary", "readVideoInfo"]);
  const listed = h.site.calls.find((call) => call.method === "listCaptionTracks");
  assert.equal(listed?.options, undefined, "不带 fresh：列到的读取实现记着，完整读取接着用");
  assert.equal(listed?.ctx, h.site.calls.find((call) => call.method === "readOfficialSummary")?.ctx, "和官方总结共用读取环境");
  assert.equal(result.transcriptError, undefined, "有字幕轨，照常摆生成");
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
  const result = guides(await h.service.light(REF, TAB));
  assert.deepEqual(result.overview?.analysis, ANALYSIS);
  assert.deepEqual(result.overview?.analysisFailures, []);
  assert.deepEqual(methods(h), ["listCaptionTracks", "readOfficialSummary", "readVideoInfo"]);
});

test("卡片只摆生效中的那份概览：重新生成写到一半的草稿不给，只有草稿时什么都不摆", async () => {
  const h = rig();
  const part = { derived: { basis: { source: "legacy-unknown" as const } }, taskCreatedAt: 1 };
  const draft = { analysis: { chapters: [{ title: "草稿里的", timestampSeconds: 0 }], keyQuotes: [] }, chapters: part };
  const record = { schemaVersion: 1, videoKey: KEY, snapshot: { title: "", author: "" }, updatedAt: 1, draft } as const;
  await h.overviewsDriver.write({ put: [{ ...record, analysis: ANALYSIS, parts: { chapters: part } }] });
  const card = guides(await h.service.light(REF, TAB));
  assert.deepEqual(card.overview, { analysis: ANALYSIS, analysisFailures: [] });

  await h.overviewsDriver.write({ put: [{ ...record, analysis: { chapters: [], keyQuotes: [] } }] });
  h.service.forget("cache");
  assert.equal(guides(await h.service.light(REF, TAB)).overview, undefined);
});

test("给概览取字幕：先轻量读取过的，官方总结接着用记着的那份，快照带着字幕代数", async () => {
  const h = rig();
  guides(await h.service.light(REF, TAB));
  assert.equal(count(h, "readOfficialSummary"), 1);
  const snapshot = await h.service.ensure(REF);
  assert.ok(snapshot.ok, JSON.stringify(snapshot));
  assert.equal(snapshot.value.view.official?.summary, "官方摘要");
  assert.equal(snapshot.value.generation, 0);
  assert.equal(count(h, "readOfficialSummary"), 1, "官方总结不再问一遍");
  assert.match(texts({ ok: true, value: snapshot.value.view }), /第一句/);
});

test("取字幕带轻量模式：列表空着就告诉卡片没有字幕，不读字幕文件、不建缓存；不带轻量模式照旧完整读取", async () => {
  const h = rig({ site: { tracks: () => ok([]) } });
  const light = guides(await h.service.light(REF, TAB));
  assert.equal(light.hasTranscript, false);
  assert.equal(light.transcriptError, "NO_CAPTIONS");
  assert.equal(light.info.title, sampleInfo(REF).title);
  assert.equal(light.official?.summary, "官方摘要");
  assert.deepEqual(methods(h), ["listCaptionTracks", "readOfficialSummary", "readVideoInfo"]);
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
  const result = guides(await h.service.light(REF, TAB));
  assert.deepEqual(h.site.calls, []);
  assert.equal(result.fromCache, true);
  assert.equal(result.hasTranscript, true);
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.deepEqual(result.overview?.analysis, ANALYSIS);
});

test("命中字幕缓存：只交卡片要的字段，用 hasTranscript 说明有字幕", async () => {
  const h = rig({ seed: [cachedRow(undefined, { official: storedOfficial("ok") })] });
  await withOverview(h, ANALYSIS);
  const result = guides(await h.service.light(REF, TAB));
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
  const result = guides(await h.service.light(REF, TAB));
  assert.deepEqual(h.site.calls, []);
  assert.equal(result.hasTranscript, false);
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.equal(result.info.title, sampleInfo(REF).title);
});

test("从缓存接过来的官方总结带着附带字幕的标记、兜底打开时：完整读取照常再问，拿附带的字幕兜底", async () => {
  const { transcript: _dropped, ...rest } = cachedRow(undefined, { official: { ...storedOfficial("ok"), hasCaptions: true }, tracks: [] });
  const h = fallbackOn({ seed: [rest], site: { tracks: () => ok([]), officialSummary: () => ok(WITH_CUES) } });
  await h.service.light(REF, TAB);
  assert.equal(count(h, "readOfficialSummary"), 0);

  const full = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(full.transcript.ref.kind, "official-ai");
  assert.equal(count(h, "readOfficialSummary"), 1);
});

// ============================================================
// 记在内存里：同一个视频再读不再问
// ============================================================

test("同一个视频再读一次：用记着的视频信息、官方总结和字幕轨有没有，不再问 B站", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
  const again = guides(await h.service.light(REF, TAB));
  assert.deepEqual(methods(h), ["listCaptionTracks", "readOfficialSummary", "readVideoInfo"]);
  assert.equal(again.official?.summary, "官方摘要");
  assert.deepEqual(await h.rows(), []);
});

test("同时读两次只问一次；换分 P 各问各的", async () => {
  const h = rig();
  const [a, b, p2] = await Promise.all([h.service.light(REF, TAB), h.service.light(REF, TAB), h.service.light(P2, TAB)]);
  assert.equal(a.ok && b.ok && p2.ok, true);
  assert.equal(count(h, "readVideoInfo"), 2);
  assert.equal(count(h, "readOfficialSummary"), 2);
  assert.equal(guides(p2).info.title, sampleInfo(P2).title);
});

test("记着的官方总结还在排队：十分钟后再读才重问一次", async () => {
  const h = rig({ site: { officialSummary: () => ok(status("queued")) } });
  await h.service.light(REF, TAB);
  await h.service.light(REF, TAB);
  assert.equal(count(h, "readOfficialSummary"), 1);

  h.timers.advance(11 * MINUTE);
  h.site.script.officialSummary = () => ok({ ...SUMMARY, summary: "排完队了" });
  const later = guides(await h.service.light(REF, TAB));
  assert.equal(count(h, "readOfficialSummary"), 2);
  assert.equal(count(h, "readVideoInfo"), 1, "视频信息不再问");
  assert.equal(later.official?.summary, "排完队了");
});

test("视频信息取不到时如实报错，不记下来，下次重新问", async () => {
  const h = rig({ site: { videoInfo: () => failed("NOT_FOUND") } });
  const first = await h.service.light(REF, TAB);
  assert.equal(!first.ok && first.code, "NOT_FOUND");
  assert.equal(count(h, "readOfficialSummary"), 0);

  h.site.script.videoInfo = (ref) => ok(sampleInfo(ref));
  assert.equal((await h.service.light(REF, TAB)).ok, true);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("轻量读取最多记 10 个视频，最早的先忘", async () => {
  const h = rig();
  const refs = Array.from({ length: LIGHT_MEMO_LIMIT + 1 }, (_, index) => ({ ...REF, segment: index + 1 }));
  for (const ref of refs) await h.service.light(ref, TAB);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 1);

  await h.service.light(refs[LIGHT_MEMO_LIMIT] ?? REF, TAB);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 1, "最近的还记着");
  await h.service.light(REF, TAB);
  assert.equal(count(h, "readVideoInfo"), LIGHT_MEMO_LIMIT + 2, "最早的忘了，重新问");
});

test("清除本机数据时也忘掉卡片轻量读取记着的视频信息和官方总结", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
  await h.service.light(REF, TAB);
  assert.equal(count(h, "readVideoInfo"), 1, "记着时不再问");

  h.service.forget("cache");
  await h.service.light(REF, TAB);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("读取途中清除了本机数据：读到的照样交给卡片，但不记下来", async () => {
  const held = deferred();
  const h = rig({ site: { videoInfo: async (ref) => (await held.promise, ok(sampleInfo(ref))) } });
  const first = h.service.light(REF, TAB);
  assert.ok(await until(() => count(h, "readVideoInfo") === 1));
  h.service.forget("all");
  held.resolve();
  assert.equal((await first).ok, true);

  await h.service.light(REF, TAB);
  assert.equal(count(h, "readVideoInfo"), 2);
});

test("导入字幕文件时忘掉这个视频轻量读取记着的，在途的也不再并进", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "导入的一句", ""].join("\n");
  assert.equal((await h.service.importFile(REF, { name: "课程.srt", text: srt })).ok, true);

  await h.service.light(REF, TAB);
  assert.equal(count(h, "readVideoInfo"), 2);
});

// ============================================================
// 先轻量、后完整：完整读取接着用记着的官方总结
// ============================================================

test("先轻量读取、后完整读取：官方总结不再问，视频信息重新核对一次，再取字幕", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
  const full = view(await h.service.get(REF, { mode: "full" }));

  assert.match(texts(await h.service.get(REF, { mode: "cache-only" })), /第一句/);
  assert.equal(full.official?.summary, "官方摘要");
  assert.equal(full.info.title, sampleInfo(REF).title);
  assert.equal(count(h, "readOfficialSummary"), 1);
  assert.equal(count(h, "readVideoInfo"), 2, "每次完整读取都先核对视频信息");
  // 替身不记列表：两次都到了站点这一层。真实的 B 站读取实现记着轻量读取列到的，完整读取不再发列表请求（见 B 站读取管线的测试）。
  assert.equal(count(h, "listCaptionTracks"), 2);
  assert.deepEqual(
    h.site.calls.filter((call) => call.method === "listCaptionTracks").map((call) => call.options),
    [undefined, undefined],
    "两次都不带 fresh",
  );
  assert.equal(count(h, "readCaptions"), 1);
  assert.equal((await h.rows()).length, 1);
});

test("播放器没有字幕时，完整读取用轻量读取记着的官方总结附带字幕兜底，不再问官方总结", async () => {
  const h = fallbackOn({ site: { tracks: () => ok([]), officialSummary: () => ok(WITH_CUES) } });
  assert.equal(guides(await h.service.light(REF, TAB)).official?.status, "ok");
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
    assert.notEqual(guides(await h.service.light(REF, TAB)).official?.status, "ok");

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
  const light = await h.service.light(REF, TAB);
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
  await h.service.light(REF, TAB);

  h.site.script.officialSummary = () => ok({ ...SUMMARY, summary: "后来问到的官方摘要" });
  const full = await h.service.get(REF, { mode: "full" });
  assert.equal(!full.ok && full.code, "NO_CAPTIONS");
  assert.equal(!full.ok && full.official?.summary, "后来问到的官方摘要");

  const again = guides(await h.service.light(REF, TAB));
  assert.equal(again.official?.status, "ok");
  assert.equal(again.official?.summary, "后来问到的官方摘要");
  assert.equal(count(h, "readOfficialSummary"), 2, "卡片再读不用再问");
});

for (const settled of ["none", "unsupported"] as const) {
  test(`轻量读取记着的官方总结已有定论（${settled}）：完整读取接着用，不再问`, async () => {
    const h = rig({ site: { officialSummary: () => ok(status(settled)) } });
    await h.service.light(REF, TAB);
    const full = view(await h.service.get(REF, { mode: "full" }));
    assert.equal(full.official?.status, settled);
    assert.equal(count(h, "readOfficialSummary"), 1);
  });
}

test("轻量读取记着的官方总结是别的媒体版本：完整读取不接着用，照常再问", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
  h.site.script.videoInfo = (ref) => ok(sampleInfo(ref, { mediaVersion: "换过内容的版本" }));
  view(await h.service.get(REF, { mode: "full" }));
  assert.equal(count(h, "readOfficialSummary"), 2);
});

test("强制刷新不接轻量读取记着的东西，视频信息和官方总结都重新问", async () => {
  const h = rig();
  await h.service.light(REF, TAB);
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
        ? await Promise.all([h.service.light(REF, TAB), h.service.get(REF, { mode: "full" })])
        : await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]).then(([full, light]) => [light, full] as const);

    const full = view(fullReply);
    assert.equal(full.fromCache, false);
    assert.match(texts(fullReply), /第一句/);
    assert.ok(full.transcript.segments.length > 0);
    assert.equal(full.official?.summary, "官方摘要");
    assert.equal(full.info.title, sampleInfo(REF).title);
    assert.equal(full.transcript.ref.lang, "zh-CN");
    assert.equal(guides(lightReply).official?.summary, "官方摘要");
    assert.equal(count(h, "readOfficialSummary"), 1);
    // 轻量读取先发时两边各列一次：替身不合并，真实的读取实现把同时发的并成一次列表请求（见 B 站读取管线的测试）。
    assert.equal(count(h, "listCaptionTracks"), order === "轻量读取先发" ? 2 : 1);
    assert.equal(count(h, "readCaptions"), 1);
    // 轻量读取先发时完整读取照样自己核对一次视频信息；完整读取先发时卡片并进它，视频信息也只问一次。
    assert.equal(count(h, "readVideoInfo"), order === "轻量读取先发" ? 2 : 1);
    assert.equal((await h.rows()).length, 1);
    assert.ok((await h.rows())[0]?.transcript?.cues.length);
  });
}

test("并进成功的完整读取：同样只交卡片要的字段，完整读取自己拿到的仍是全量", async () => {
  const h = rig();
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);
  assert.ok(view(full).transcript.cues.length);
  assert.match(texts(full), /第一句/);
  assertSlim(guides(light));
  assert.equal(guides(light).official?.summary, "官方摘要");
});

test("卡片并进先交了字幕的完整读取：等官方总结回来再交，不说成没有官方总结", async () => {
  const held = deferred();
  const h = rig({ site: { officialSummary: async () => (await held.promise, ok(SUMMARY)) } });
  const full = h.service.get(REF, { mode: "full" });
  const light = h.service.light(REF, TAB);
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1), "字幕到了，在等官方总结");
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await full).official?.status, "pending");

  held.resolve();
  const card = guides(await light);
  assert.equal(card.official?.summary, "官方摘要");
  assert.equal(count(h, "readOfficialSummary"), 1);
});

test("卡片并进刷新：刷新换了新的媒体版本，旧版本迟到的官方总结先回来也不摆到新版本上", async () => {
  const answers = [deferred(), deferred()] as const;
  let infos = 0;
  let asked = 0;
  const h = rig({
    site: {
      videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { mediaVersion: (infos += 1) === 1 ? "media-old" : "media-new" }) }),
      officialSummary: async () => {
        const index = asked;
        asked += 1;
        await answers[index === 0 ? 0 : 1].promise;
        return ok({ ...SUMMARY, summary: index === 0 ? "旧版本的官方总结" : "新版本的官方总结" });
      },
    },
  });
  const first = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await first).official?.status, "pending");

  const refreshed = h.service.get(REF, { mode: "full", fresh: true });
  const light = h.service.light(REF, TAB);
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1), "刷新同样先交了字幕");
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await refreshed).official?.status, "pending");

  let settled = false;
  void light.then(() => (settled = true));
  answers[0].resolve();
  assert.ok(await stillFalse(() => settled, 50), "旧版本的那份回来了，卡片还在等新版本的");
  assert.equal((await h.rows())[0]?.official?.status, "pending", "旧版本的那份也不写进新版本的缓存");
  answers[1].resolve();
  const card = guides(await light);
  assert.equal(card.official?.summary, "新版本的官方总结");
});

test("卡片并进的完整读取卡在下载：等一小会儿就改走轻量读取，官方总结不重复问", async () => {
  const held = deferred();
  const h = rig({ site: { captions: async () => (await held.promise, ok(OFFICIAL_CUES)) } });
  const full = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => count(h, "readCaptions") === 1), "完整读取已经开始下载");

  const light = h.service.light(REF, TAB);
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
    const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);

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
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);

  assert.equal(!full.ok && full.code, "NEED_LOGIN");
  assert.equal(!light.ok && light.code, "NEED_LOGIN");
  assert.deepEqual(!light.ok && light.overview?.analysis, VERDICT_ONLY);
  assert.deepEqual(methods(h), ["readVideoInfo"]);
  assert.deepEqual(await h.rows(), []);
});

test("并进的完整读取被限流：卡片照样摆官方总结和结论，不带取不到字幕的提示", async () => {
  const h = rig({ site: { tracks: () => failed("RATE_LIMITED") } });
  await withOverview(h, VERDICT_ONLY);
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);

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
  const [, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);
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
  const before = h.service.light(REF, TAB);
  assert.ok(await until(() => count(h, "readOfficialSummary") === 1), "在重问官方总结");

  await h.service.writer.update(KEY, (current) => (current ? { ...current, official: storedOfficial("ok", "刚写进缓存的官方摘要") } : null));
  const after = h.service.light(REF, TAB);

  held.resolve();
  const [early, late] = await Promise.all([before, after]);
  assert.equal(early.ok, true);
  assert.equal(guides(late).official?.summary, "刚写进缓存的官方摘要");
});

// 打开就出结论按后台自己读到的时长先判断：只看缓存和轻量读取记着的，在路上的轻量读取等它回来，一个请求都不另发。
test("本机知道的时长：缓存里的、轻量读取记着的都算，不知道时是 null，问它不发任何请求", async () => {
  const cached = rig({ seed: [cachedRow(undefined, { info: sampleInfo(REF, { durationSec: 1800 }) })] });
  assert.equal(await cached.service.knownDuration(REF), 1800);
  assert.equal(cached.site.calls.length, 0);

  const blank = rig();
  assert.equal(await blank.service.knownDuration(REF), null);
  assert.equal(blank.site.calls.length, 0);

  const gate = deferred();
  const light = rig({ site: { videoInfo: async (ref) => (await gate.promise, ok(sampleInfo(ref, { durationSec: 900 }))) } });
  const reading = light.service.light(REF, TAB);
  const known = light.service.knownDuration(REF);
  assert.ok(await stillFalse(async () => light.site.count("readVideoInfo") > 1));
  gate.resolve();
  await reading;
  assert.equal(await known, 900, "在路上的轻量读取等它回来");
  assert.equal(light.site.count("readVideoInfo"), 1);
});

// ============================================================
// B 站：列表空着、官方总结也不会兜底，才告诉卡片没有字幕
// ============================================================

const noTracks = { tracks: () => ok([]) } as const;

test("列表空着、兜底关着：告诉卡片没有字幕；同一个视频再读照旧说没有字幕，不再列", async () => {
  const h = rig({ site: noTracks });
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
  const again = guides(await h.service.light(REF, TAB));
  assert.equal(again.transcriptError, "NO_CAPTIONS");
  assert.equal(again.official?.summary, "官方摘要");
  assert.equal(count(h, "listCaptionTracks"), 1, "记着的不再列");
  assert.equal(count(h, "readCaptions"), 0, "不读字幕文件");
  assert.deepEqual(await h.rows(), []);
});

test("后台为「打开就出结论」问时长（不带标签页）：只问视频信息和官方总结，不列字幕轨，也不说没有字幕", async () => {
  const h = rig({ site: noTracks });
  const reply = guides(await h.service.light(REF));
  assert.deepEqual(methods(h), ["readOfficialSummary", "readVideoInfo"]);
  assert.equal(reply.transcriptError, undefined);
});

test("后台那种不列字幕轨的读取在路上时卡片来读：等它读完再补列一次，视频信息和官方总结不再问", async () => {
  const h = rig({ site: noTracks });
  const [background, card] = await Promise.all([h.service.light(REF), h.service.light(REF, TAB)]);
  assert.equal(guides(background).transcriptError, undefined);
  assert.equal(guides(card).transcriptError, "NO_CAPTIONS");
  assert.equal(count(h, "readVideoInfo"), 1);
  assert.equal(count(h, "readOfficialSummary"), 1);
  assert.equal(count(h, "listCaptionTracks"), 1);
});

test("列表空着、兜底开着：官方总结附带了 AI 字幕就不算没有字幕，生成照常能用附带的字幕", async () => {
  const h = fallbackOn({ site: { ...noTracks, officialSummary: () => ok(WITH_CUES) } });
  const card = guides(await h.service.light(REF, TAB));
  assert.equal(card.transcriptError, undefined);
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, undefined);
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "official-ai");
});

for (const settled of ["ok", "none", "unsupported"] as const) {
  test(`列表空着、兜底开着，官方总结已有定论（${settled}）也没附带字幕：告诉卡片没有字幕`, async () => {
    const h = fallbackOn({ site: { ...noTracks, officialSummary: () => ok(settled === "ok" ? SUMMARY : status(settled)) } });
    assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
    const full = await h.service.get(REF, { mode: "full" });
    assert.equal(!full.ok && full.code, "NO_CAPTIONS", "完整读取同样读不到字幕");
  });
}

for (const [label, official] of [
  ["网络没通", () => failed("NETWORK")],
  ["还在排队", () => ok(status("queued"))],
  ["被限流", () => failed("RATE_LIMITED")],
] as const) {
  test(`列表空着、兜底开着，官方总结没有定论（${label}）：拿不准之后会不会附带字幕，不标没有字幕`, async () => {
    const h = fallbackOn({ site: { ...noTracks, officialSummary: official } });
    assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, undefined);
  });
}

test("列表空着、兜底关着：官方总结没有定论也照样说没有字幕，附带的字幕本来就不用", async () => {
  const h = rig({ site: { ...noTracks, officialSummary: () => ok(status("queued")) } });
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
});

for (const [label, listed] of [
  ["被限流", () => failed("RATE_LIMITED", { retryAfterSec: 60 })],
  ["站点在退避里", () => failed("RATE_LIMITED", { detail: "blocked" })],
  ["网络没通", () => failed("NETWORK")],
  ["超时", () => failed("TIMEOUT")],
  ["格式不对", () => failed("MALFORMED")],
  ["要登录", () => failed("NEED_LOGIN")],
  ["平台拒绝", () => failed("NETWORK", { rejected: true })],
] as const) {
  test(`列轨没列成（${label}）：不下结论，照旧摆生成，卡片也不报错；下次再读重新列`, async () => {
    const h = rig({ site: { tracks: listed } });
    const card = guides(await h.service.light(REF, TAB));
    assert.equal(card.transcriptError, undefined);
    assert.equal(card.official?.summary, "官方摘要");
    h.site.script.tracks = () => ok([]);
    assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
    assert.equal(count(h, "listCaptionTracks"), 2);
  });
}

test("列轨抛错：当成没列成，卡片照常摆", async () => {
  const h = rig({
    site: {
      tracks: () => {
        throw new Error("自造的错误");
      },
    },
  });
  const card = guides(await h.service.light(REF, TAB));
  assert.equal(card.transcriptError, undefined);
  assert.equal(card.official?.summary, "官方摘要");
});

test("列表里有字幕轨：照常摆生成", async () => {
  const h = fallbackOn({ site: { tracks: () => ok([ZH]), officialSummary: () => ok(status("none")) } });
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, undefined);
});

test("官方总结说要登录：只报要登录，不列字幕轨", async () => {
  const h = rig({ site: { ...noTracks, officialSummary: () => failed("NEED_LOGIN") } });
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NEED_LOGIN");
  assert.equal(count(h, "listCaptionTracks"), 0);
});

test("没登录读过、随后登录：再读时列一次字幕轨，空着就说没有字幕", async () => {
  const h = rig({ site: { ...noTracks, officialSummary: () => failed("NEED_LOGIN") } });
  await h.service.light(REF, TAB);
  h.site.script.officialSummary = () => ok(SUMMARY);
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
  assert.equal(count(h, "listCaptionTracks"), 1);
});

test("清除本机数据以后忘掉列过的，再读重新列", async () => {
  const h = rig({ site: noTracks });
  await h.service.light(REF, TAB);
  h.service.forget("cache");
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
  assert.equal(count(h, "listCaptionTracks"), 2);
});

test("导入了字幕文件：不列字幕轨，也不说没有字幕，生成用导入的那份；导入之前列过说没有的也忘掉", async () => {
  const h = rig({ site: noTracks });
  assert.equal(guides(await h.service.light(REF, TAB)).transcriptError, "NO_CAPTIONS");
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "导入的一句", ""].join("\n");
  assert.equal((await h.service.importFile(REF, { name: "课程.srt", text: srt })).ok, true);
  const imported = guides(await h.service.light(REF, TAB));
  assert.equal(imported.transcriptError, undefined);
  assert.ok(imported.transcriptFingerprint, "认得出现在用的是导入的那份");
  assert.equal(imported.hasTranscript, true, "导入的字幕能直接生成，卡片不再挡着");
  assert.equal(count(h, "listCaptionTracks"), 1, "导入以后不再列");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "imported");

  const fresh = rig({ site: noTracks });
  assert.equal((await fresh.service.importFile(REF, { name: "课程.srt", text: srt })).ok, true);
  assert.equal(guides(await fresh.service.light(REF, TAB)).transcriptError, undefined);
  assert.equal(count(fresh, "listCaptionTracks"), 0);
});

test("读取途中清除了本机数据：这次照样告诉卡片没有字幕，但不记下来，再读重新列", async () => {
  const held = deferred();
  const h = rig({ site: { tracks: async () => (await held.promise, ok([])) } });
  const first = h.service.light(REF, TAB);
  assert.ok(await until(() => count(h, "listCaptionTracks") === 1));
  h.service.forget("all");
  held.resolve();
  assert.equal(guides(await first).transcriptError, "NO_CAPTIONS");
  await h.service.light(REF, TAB);
  assert.equal(count(h, "listCaptionTracks"), 2);
});

test("并进说没有字幕的完整读取：卡片照样说没有字幕，不另列一次", async () => {
  const h = rig({ site: noTracks });
  const [full, light] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.light(REF, TAB)]);
  assert.equal(!full.ok && full.code, "NO_CAPTIONS");
  assert.equal(guides(light).transcriptError, "NO_CAPTIONS");
  assert.equal(count(h, "listCaptionTracks"), 1);
});

// ============================================================
// YouTube：字幕要用户点了读取才读，卡片只看本机
// ============================================================

const TUBE: VideoRef = { platform: "youtube", videoId: "jmTubeSample1" };
const TUBE_KEY = videoKey(TUBE);

test("YouTube 本机没有字幕：告诉卡片本机没有，不向平台和页面要视频信息，也不建读取环境", async () => {
  const h = rig();
  const card = guides(await h.service.light(TUBE, TAB));
  assert.equal(card.video, TUBE_KEY);
  assert.equal(card.hasTranscript, false);
  assert.equal(card.transcriptError, "NOT_CACHED");
  assert.equal(card.official, undefined, "YouTube 没有官方总结");
  assert.equal(card.info.title, "", "视频信息也不去读，卡片本来不写标题");
  assert.deepEqual(h.site.calls, []);
  assert.equal(h.ctxs.length, 0, "没建读取环境，也就没向页面问");
  assert.deepEqual(await h.rows(), [], "不新建字幕缓存条目");
});

test("YouTube 本机读过字幕：照常摆，带回本机已有的概览；只有概览、字幕缓存清了时也带回概览", async () => {
  const cached = rig({ seed: [cachedRow(ZH, {}, TUBE)] });
  await createOverviewStore({ driver: cached.overviewsDriver, guard: cached.guard }).save({ videoKey: TUBE_KEY, analysis: ANALYSIS });
  const card = guides(await cached.service.light(TUBE, TAB));
  assert.equal(card.hasTranscript, true);
  assert.equal(card.fromCache, true);
  assert.equal(card.transcriptError, undefined);
  assert.equal(card.info.title, sampleInfo(TUBE).title);
  assert.deepEqual(card.overview?.analysis, ANALYSIS);
  assertSlim(card);
  assert.deepEqual(cached.site.calls, []);

  const overviewOnly = rig();
  await createOverviewStore({ driver: overviewOnly.overviewsDriver, guard: overviewOnly.guard }).save({ videoKey: TUBE_KEY, analysis: ANALYSIS });
  const known = guides(await overviewOnly.service.light(TUBE, TAB));
  assert.equal(known.transcriptError, "NOT_CACHED");
  assert.deepEqual(known.overview?.analysis, ANALYSIS);
  assert.equal(overviewOnly.ctxs.length, 0);
});

test("YouTube 导入过字幕文件：算本机有字幕，卡片能生成", async () => {
  const h = rig();
  assert.equal((await h.service.importFile(TUBE, { name: "样例.srt", text: "1\n00:00:00,000 --> 00:00:02,000\n导入的第一句\n" })).ok, true);
  const card = guides(await h.service.light(TUBE, TAB));
  assert.equal(card.hasTranscript, true);
  assert.equal(card.transcriptError, undefined);
  assert.equal(h.ctxs.length, 0);
});

test("命中字幕缓存：带上现在这份字幕的指纹和概览依据的指纹，卡片据此标基于旧字幕；没读到字幕时不带指纹", async () => {
  const h = rig({ seed: [cachedRow(undefined, { official: storedOfficial("ok") })] });
  const derived = {
    basis: { source: "transcript", transcript: { video: KEY, kind: "human", lang: "zh-CN", fingerprint: "旧字幕" } },
    gen: { feature: "analysis", promptVersion: "p1", model: "m", effort: "off" },
  } as const;
  const part = { derived, taskCreatedAt: 1 };
  await createOverviewStore({ driver: h.overviewsDriver, guard: h.guard }).put({
    schemaVersion: 1,
    videoKey: KEY,
    snapshot: { title: "", author: "" },
    analysis: ANALYSIS,
    parts: { chapters: part, verdict: part },
    updatedAt: 1,
  });
  const cached = guides(await h.service.light(REF, TAB));
  assert.equal(cached.transcriptFingerprint, (await h.rows())[0]?.transcript?.ref.fingerprint);
  assert.deepEqual(cached.overview?.transcriptBasis, { chapters: "旧字幕", verdict: "旧字幕" });

  const uncached = guides(await rig().service.light(REF, TAB));
  assert.equal(uncached.hasTranscript, false);
  assert.equal("transcriptFingerprint" in uncached, false);
});

test("刚导入字幕文件、缓存里的字幕作废了还没重读：卡片拿到的指纹是导入的那份；移除以后不带", async () => {
  const h = rig({ seed: [cachedRow(undefined, { official: storedOfficial("ok") })] });
  const platform = guides(await h.service.light(REF, TAB)).transcriptFingerprint;
  assert.ok(platform);
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "导入的一句", ""].join("\n");
  assert.equal((await h.service.importFile(REF, { name: "课程.srt", text: srt })).ok, true);
  const imported = guides(await h.service.light(REF, TAB)).transcriptFingerprint;
  assert.ok(imported);
  assert.notEqual(imported, platform);
  assert.equal((await h.service.removeImport(REF)).ok, true);
  assert.equal("transcriptFingerprint" in guides(await h.service.light(REF, TAB)), false, "平台字幕还没重读，不知道是哪份");
});

// ============================================================
// YouTube：本机没有字幕时问一句卡片所在的页面
// ============================================================


/** YouTube 的替身站点：只有「页面上确定没有字幕」这一项按脚本回，别的能力一被调到就算错。 */
function tubeRig(noCaptions: (ref: VideoRef) => boolean | Promise<boolean>, options: HarnessOptions = {}): Harness & { readonly tubeCalls: () => string[] } {
  const tube = fakeSiteService({ noCaptions });
  const h = rig({ ...options, other: { ...tube.service, rules: { ...tube.service.rules, platform: "youtube" } } });
  return Object.assign(h, { tubeCalls: () => tube.calls.map((call) => call.method) });
}

test("YouTube 本机没有字幕、页面说确定没有字幕：告诉卡片没有字幕；只问卡片所在的标签页一句，不读视频信息、不点", async () => {
  const h = tubeRig(() => true);
  const card = guides(await h.service.light(TUBE, TAB));
  assert.equal(card.transcriptError, "NO_CAPTIONS");
  assert.equal(card.hasTranscript, false);
  assert.equal(card.info.title, "");
  assert.deepEqual(h.tubeCalls(), ["knownNoCaptions"]);
  assert.deepEqual(h.ctxTabs, [TAB]);
  assert.deepEqual(h.site.calls, []);
  assert.deepEqual(await h.rows(), []);
});

test("YouTube 页面判断不了（有字幕、对不上、没回答）、问的时候出错：照旧说本机没有", async () => {
  for (const answer of [() => false, () => Promise.reject(new Error("自造的错误")), () => { throw new Error("自造的错误"); }]) {
    const h = tubeRig(answer);
    assert.equal(guides(await h.service.light(TUBE, TAB)).transcriptError, "NOT_CACHED");
    assert.deepEqual(h.tubeCalls(), ["knownNoCaptions"]);
  }
});

test("YouTube 没有卡片所在的标签页：不问页面，照旧说本机没有", async () => {
  const h = tubeRig(() => true);
  assert.equal(guides(await h.service.light(TUBE)).transcriptError, "NOT_CACHED");
  assert.deepEqual(h.tubeCalls(), []);
  assert.equal(h.ctxs.length, 0);
});

test("YouTube 本机有字幕（读过、导入过）：不问页面", async () => {
  const cached = tubeRig(() => true, { seed: [cachedRow(ZH, {}, TUBE)] });
  assert.equal(guides(await cached.service.light(TUBE, TAB)).hasTranscript, true);
  assert.deepEqual(cached.tubeCalls(), []);

  const imported = tubeRig(() => true);
  assert.equal((await imported.service.importFile(TUBE, { name: "样例.srt", text: "1\n00:00:00,000 --> 00:00:02,000\n导入的第一句\n" })).ok, true);
  assert.equal(guides(await imported.service.light(TUBE, TAB)).hasTranscript, true);
  assert.deepEqual(imported.tubeCalls(), []);
});

test("YouTube 每次读都重问页面，不记下来：播放器后来加载好了也认得出", async () => {
  let none = false;
  const h = tubeRig(() => none);
  assert.equal(guides(await h.service.light(TUBE, TAB)).transcriptError, "NOT_CACHED");
  none = true;
  assert.equal(guides(await h.service.light(TUBE, TAB)).transcriptError, "NO_CAPTIONS");
  assert.equal(h.tubeCalls().length, 2);
});
