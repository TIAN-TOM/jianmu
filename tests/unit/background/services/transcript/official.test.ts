// 官方总结并进取字幕：和字幕列表同时问，跟着字幕进缓存，失败的回复也带着；字幕先到时最多再等一小会儿，回来后填回；
// 排队中、要登录、没问成的过十分钟重问，命中缓存时在后台问。附带的 AI 字幕兜底在生产里关着，用到它的测试打开。
// 站点是替身，缓存用真实仓储加内存驱动，计时器手动推进。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFICIAL_GRACE_MS } from "../../../../../src/background/services/transcript/official.ts";
import { OFFICIAL_SUBTITLE_LABEL } from "../../../../../src/core/transcript/sources.ts";
import type { TranscriptReply } from "../../../../../src/shared/messages/transcript.ts";
import type { Cue, OfficialSummary, SiteResult } from "../../../../../src/sites/types.ts";
import { deferred, nextTurn } from "../../../../helpers/deferred.ts";
import { failed } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, EN, harness, KEY, REF, sampleInfo, START, texts, view, ZH, type HarnessOptions, type Row } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const MINUTE = 60_000;
const OFFICIAL_CUES: Cue[] = [
  { start: 0, duration: 1, text: "有时候上网啊" },
  { start: 1, duration: 2, text: "看网友的评论内容" },
  { start: 3, duration: 2, text: "一句话好几个错别字" },
];
const SUMMARY: OfficialSummary = {
  status: "ok",
  summary: "官方摘要",
  outline: [
    { title: "提纲一", timestamp: 1, points: [{ timestamp: 1, content: "要点一" }] },
    { title: "提纲二", timestamp: 60, points: [{ timestamp: 60, content: "要点二" }] },
  ],
  cues: [],
};
const WITH_CUES: OfficialSummary = { ...SUMMARY, cues: OFFICIAL_CUES };
const ok = <T>(value: T): SiteResult<T> => ({ ok: true, value: structuredClone(value) });
const status = (value: OfficialSummary["status"]): OfficialSummary => ({ status: value, summary: "", outline: [], cues: [] });
const fallbackOn = (site: HarnessOptions["site"] = {}, extra: HarnessOptions = {}) =>
  harness({ officialCaptionsFallback: true, ...extra, site: { officialSummary: () => ok(WITH_CUES), ...site } });

const failure = (reply: TranscriptReply) => {
  if (reply.ok) throw new Error(`应该失败：${JSON.stringify(reply)}`);
  return reply;
};
const row = async (h: { rows: () => Promise<Row[]> }): Promise<Row | undefined> => (await h.rows())[0];
const storedOfficial = (fetchedAt: number, value: "ok" | "queued" = "queued", extra = {}) =>
  ({ status: value, summary: value === "ok" ? "缓存里的官方摘要" : "", outline: [], hasCaptions: false, fetchedAt, ...extra }) as const;

// ============================================================
// 跟着字幕一起取、一起存
// ============================================================

test("有字幕时官方总结和字幕一起取回、一起进缓存，字幕来源记为播放器", async () => {
  const h = harness({ site: { officialSummary: () => ok(WITH_CUES) } });
  const result = view(await h.service.get(REF, { mode: "full" }));

  assert.equal(result.transcript.ref.kind, "human");
  assert.equal(result.official?.status, "ok");
  assert.equal(result.official?.outline.length, 2);
  assert.match(result.official?.fingerprint ?? "", /^[0-9a-f]{16}$/);
  assert.equal("cues" in (result.official ?? {}), false, "附带字幕没被用上时不给页面");
  const calls = h.site.calls.filter((call) => call.method === "readOfficialSummary");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.info?.mediaVersion, sampleInfo(REF).mediaVersion);
  assert.deepEqual(calls[0]?.info?.channel, sampleInfo(REF).channel);

  const stored = (await row(h))?.official;
  assert.equal(stored?.summary, "官方摘要");
  assert.equal(stored?.hasCaptions, true);
  assert.equal("cues" in (stored ?? {}), false, "附带字幕不重复存一份");
});

test("没有字幕、官方总结也没带字幕：照旧报没有字幕，但把官方总结带回去", async () => {
  const h = fallbackOn({ tracks: () => ok([]), officialSummary: () => ok(SUMMARY) });
  const reply = failure(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.code, "NO_CAPTIONS");
  assert.equal(reply.official?.status, "ok");
  assert.equal(reply.official?.summary, "官方摘要");
  assert.deepEqual(await h.rows(), [], "失败结果照旧不落库");
});

test("需要登录时只报 NEED_LOGIN，不问官方总结；官方总结单独回要登录时记下 need-login", async () => {
  const out = harness({ site: { videoInfo: () => failed("NEED_LOGIN") } });
  const reply = failure(await out.service.get(REF, { mode: "full" }));
  assert.equal(reply.code, "NEED_LOGIN");
  assert.equal(reply.official, undefined);
  assert.equal(out.site.count("readOfficialSummary"), 0, "没登录不读任何视频内容");

  const h = harness({ site: { officialSummary: () => failed("NEED_LOGIN") } });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "human");
  assert.equal(result.official?.status, "need-login");
});

test("官方总结请求出错、没有、不支持时，字幕照常返回，状态各记各的", async () => {
  const cases: [() => Promise<SiteResult<OfficialSummary>>, string][] = [
    [async () => failed("NETWORK"), "failed"],
    [async () => Promise.reject(new Error("替身炸了")), "failed"],
    [async () => ok(status("none")), "none"],
    [async () => ok(status("queued")), "queued"],
    [async () => ok(status("unsupported")), "unsupported"],
  ];
  for (const [officialSummary, expected] of cases) {
    const h = harness({ site: { officialSummary } });
    const result = view(await h.service.get(REF, { mode: "full" }));
    assert.match(texts({ ok: true, value: result }), /第一句/, expected);
    assert.equal(result.official?.status, expected);
    assert.equal(result.official?.summary, "");
    assert.equal(result.official?.fingerprint, undefined, "没有内容就没有指纹");
  }
});

test("取字幕整体出错时也带回官方总结的结论", async () => {
  const h = harness({ site: { tracks: () => failed("RATE_LIMITED"), officialSummary: () => ok(SUMMARY) } });
  const reply = failure(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.code, "RATE_LIMITED");
  assert.equal(reply.official?.status, "ok");
});

// ============================================================
// 重问和沿用
// ============================================================

test("缓存命中时：排队中的过了十分钟再问一次，其余不再发请求", async () => {
  let next = status("queued");
  const h = harness({ site: { officialSummary: () => ok(next) } });
  await h.service.get(REF, { mode: "full" });
  assert.equal(h.site.count("readOfficialSummary"), 1);

  h.timers.advance(MINUTE);
  assert.equal(view(await h.service.get(REF, { mode: "full" })).fromCache, true);
  assert.equal(h.site.count("readOfficialSummary"), 1, "十分钟内不重问");

  h.timers.advance(10 * MINUTE);
  next = SUMMARY;
  const later = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(later.fromCache, true);
  assert.equal(later.official?.status, "queued", "重问在后台，这次先交缓存里的");
  assert.equal(h.site.count("readOfficialSummary"), 2);
  assert.ok(await until(async () => (await row(h))?.official?.status === "ok"), "新结论写回缓存");
  assert.match((await row(h))?.transcript?.cues[0]?.text ?? "", /第一句/, "字幕不受影响");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.status, "ok");

  h.timers.advance(60 * MINUTE);
  await h.service.get(REF, { mode: "full" });
  assert.equal(h.site.count("readOfficialSummary"), 2, "已经有总结就不再问");
});

test("换字幕语言时沿用缓存里的官方总结，不为同一个视频再问一遍；点刷新才重问", async () => {
  const h = harness({ site: { officialSummary: () => ok(SUMMARY) } });
  await h.service.get(REF, { mode: "full" });
  assert.equal(h.site.count("readOfficialSummary"), 1);

  const switched = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(switched.transcript.ref.lang, "en-US");
  assert.equal(switched.official?.status, "ok");
  assert.equal(h.site.count("readOfficialSummary"), 1);

  await h.service.get(REF, { mode: "full", fresh: true });
  assert.equal(h.site.count("readOfficialSummary"), 2);
});

test("换字幕语言：缓存里的官方总结带着附带字幕也沿用，不再问 B站", async () => {
  const h = fallbackOn({}, { seed: [cachedRow(ZH, { official: storedOfficial(START, "ok", { hasCaptions: true }) })] });
  const result = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(result.transcript.ref.lang, "en-US");
  assert.equal(result.official?.summary, "缓存里的官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 0);
});

test("没点名语言、播放器没有字幕时照旧问官方总结拿附带字幕兜底", async () => {
  // 缓存里沿用的那份不带字幕本身：导入的字幕移除以后只剩视频信息和官方总结。
  const seed = cachedRow(ZH, { transcript: undefined, tracks: [], official: storedOfficial(START, "ok", { hasCaptions: true }) });
  const h = fallbackOn({ tracks: () => ok([]) }, { seed: [seed] });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(h.site.count("readOfficialSummary"), 1);
});

test("cacheOnly 读取严格只读：缓存里的官方总结过了重问时间也不发请求", async () => {
  const h = harness({ site: { officialSummary: () => ok(status("queued")) } });
  await h.service.get(REF, { mode: "full" });
  assert.equal(h.site.count("readOfficialSummary"), 1);

  h.timers.advance(11 * MINUTE);
  assert.equal(view(await h.service.get(REF, { mode: "cache-only" })).fromCache, true);
  await nextTurn();
  assert.equal(h.site.count("readOfficialSummary"), 1, "只读缓存，不重问官方总结");
});

test("命中缓存后重问官方总结：同一个视频同时只问一次", async () => {
  const held = deferred();
  let next: () => Promise<SiteResult<OfficialSummary>> = async () => ok(status("queued"));
  const h = harness({ site: { officialSummary: () => next() } });
  await h.service.get(REF, { mode: "full" });

  h.timers.advance(11 * MINUTE);
  next = () => held.promise.then(() => ok(SUMMARY));
  // 一边不点名语言，一边点名的正好是缓存里那条：都命中缓存，但不是同一次读取。
  const [plain, named] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full", lang: "zh-CN" })]);
  assert.equal(view(plain).fromCache, true);
  assert.equal(view(named).fromCache, true);
  held.resolve();
  assert.ok(await until(async () => (await row(h))?.official?.status === "ok"), "重问的结果写回缓存");
  assert.equal(h.site.count("readOfficialSummary"), 2, "十分钟后只重问一次");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.status, "ok");
});

test("命中缓存：过了重问时间的官方总结在后台重问，先把缓存交回去", async () => {
  const held = deferred();
  const seed = cachedRow(ZH, { official: storedOfficial(START - 11 * MINUTE) });
  const h = harness({ seed: [seed], site: { officialSummary: () => held.promise.then(() => ok(SUMMARY)) } });

  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.fromCache, true);
  assert.equal(result.official?.status, "queued", "先交缓存里的");
  assert.equal(h.site.count("readOfficialSummary"), 1, "后台已经在重问");

  held.resolve();
  assert.ok(await until(async () => (await row(h))?.official?.status === "ok"), "重问的结果写回缓存");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.summary, "官方摘要");
});

test("后台重问回来时缓存条目已经没了：不新建只有官方总结的条目", async () => {
  const held = deferred();
  let reads = 0;
  const h = harness({
    seed: [cachedRow(ZH, { official: storedOfficial(START - 11 * MINUTE) })],
    site: { officialSummary: () => held.promise.then(() => ok(SUMMARY)) },
    wrapDriver: (inner) => ({ ...inner, get: (key) => ((reads += 1), inner.get(key)) }),
  });
  await h.service.get(REF, { mode: "full" });
  await h.driver.write({ remove: [KEY] });
  const before = reads;

  held.resolve();
  assert.ok(await until(() => reads > before), "重问回来，开始写回");
  // 缓存写入排成一队：排在它后面的一次空改动回来时，那次写回一定已经做完。
  await h.service.writer.update(KEY, (current) => current);
  assert.deepEqual(await h.rows(), []);
});

// ============================================================
// 字幕先到：先交字幕，官方总结回来后填回
// ============================================================

test("字幕已经下载好、官方总结迟迟不回：先交字幕，官方总结回来后写回缓存", async () => {
  const held = deferred();
  const h = harness({ site: { officialSummary: () => held.promise.then(() => ok(SUMMARY)) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1), "字幕到了，开始等官方总结");
  h.timers.advance(OFFICIAL_GRACE_MS);

  const result = view(await pending);
  assert.match(texts({ ok: true, value: result }), /第一句/);
  assert.equal(result.official?.status, "pending", "还没回来的官方总结不当成有");
  assert.equal(result.official?.summary, "");
  assert.ok((await row(h))?.transcript, "字幕先进缓存");

  held.resolve();
  assert.ok(await until(async () => (await row(h))?.official?.status === "ok"), "官方总结回来后写回缓存");
  assert.match((await row(h))?.transcript?.cues[0]?.text ?? "", /第一句/, "字幕不受影响");
  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.fromCache, true);
  assert.equal(again.official?.summary, "官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 1, "回来的那份直接用，不再问");
});

test("官方总结在宽限期内回来：照旧和字幕一起交回", async () => {
  const held = deferred();
  const h = harness({ site: { officialSummary: () => held.promise.then(() => ok(SUMMARY)) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  held.resolve();

  assert.equal(view(await pending).official?.summary, "官方摘要");
  assert.equal(h.timers.due(OFFICIAL_GRACE_MS), 0, "等的计时收掉了");
});

test("清除前登记的官方总结回填，不覆盖清除后新读取建立的记录", async () => {
  const releases: (() => void)[] = [];
  const answers = ["清除之前问的", "清除之后问的"];
  const h = harness({
    site: {
      officialSummary: () =>
        new Promise((resolve) => {
          const summary = answers[releases.length] ?? "";
          releases.push(() => resolve(ok({ ...SUMMARY, summary })));
        }),
    },
  });
  const readOnce = async () => {
    const pending = h.service.get(REF, { mode: "full" });
    assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
    h.timers.advance(OFFICIAL_GRACE_MS);
    return view(await pending);
  };
  // 第一次读取：官方总结迟迟不回，先交字幕、记占位，登记回填。
  assert.equal((await readOnce()).official?.status, "pending");
  // 清除本机数据，再读一次：官方总结同样没回，新条目也是占位。
  await h.guard.clear("cache", () => h.driver.write({ remove: [KEY] }));
  h.service.forget("cache");
  await readOnce();
  assert.equal(releases.length, 2, "清除之后重新问，不并进清除之前那次");
  assert.equal((await row(h))?.official?.status, "pending");

  // 清除前那次先回来，清除后那次随后回来：留下的只能是清除之后问到的。
  for (const release of releases) release();
  assert.ok(await until(async () => (await row(h))?.official?.status === "ok"));
  assert.equal((await row(h))?.official?.summary, "清除之后问的", "旧回填不覆盖清除后的记录");
});

test("落库前的核对过了、写入队列里还在读缓存时清除了本机数据：字幕不写回", async () => {
  let reads = 0;
  let clearing: Promise<unknown> | null = null;
  const h = harness({
    wrapDriver: (inner) => ({
      ...inner,
      async get(key) {
        reads += 1;
        // 第 1 次是开头读缓存，第 2 次是写入队列里的读—改—写。
        if (reads === 2) clearing = h.guard.clear("cache", async () => {});
        return inner.get(key);
      },
    }),
  });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.match(texts(reply), /第一句/, "读到的照样交给调用方");
  assert.ok(clearing, "走到了写入队列里的那次读");
  await clearing;
  assert.deepEqual(await h.rows(), [], "清除之后不写回字幕缓存");
});

// ============================================================
// 附带的 AI 字幕兜底（生产里关着，这里打开）
// ============================================================

test("播放器一条字幕都没有时，用官方总结里的 AI 字幕当字幕，并注明来源", async () => {
  const h = fallbackOn({ tracks: () => ok([]) });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(result.transcript.label, OFFICIAL_SUBTITLE_LABEL);
  assert.deepEqual(result.tracks, []);
  assert.deepEqual(result.transcript.cues.map((cue) => cue.text), ["有时候上网啊", "看网友的评论内容", "一句话好几个错别字"]);
  assert.ok(result.transcript.segments.length > 0, "分段照常组装，翻译和问答能用");
  assert.equal(result.official?.status, "ok");
  assert.equal(h.site.count("readCaptions"), 0);

  // 进了缓存：之后的读取拿到的就是这份字幕。
  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.fromCache, true);
  assert.equal(again.transcript.ref.kind, "official-ai");
  assert.equal((await h.rows()).length, 1);
});

test("用户点名了语言时不拿中文 AI 字幕顶替", async () => {
  const h = fallbackOn({ tracks: () => ok([]) });
  assert.equal(failure(await h.service.get(REF, { mode: "full", lang: "en-US" })).code, "NO_CAPTIONS");
});

test("字幕文件读取失败（内容失败）时，用官方总结附带的 AI 字幕兜底并进缓存", async () => {
  const h = fallbackOn({ captions: () => failed("MALFORMED") });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(result.transcript.cues.length, 3);
  assert.equal(result.official?.status, "ok");
  assert.equal((await row(h))?.transcript?.ref.kind, "official-ai");
});

test("字幕列表接口超时时，同样用官方总结附带的 AI 字幕兜底", async () => {
  const h = fallbackOn({ tracks: () => failed("TIMEOUT") });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "official-ai");
  assert.equal(h.site.count("readCaptions"), 0);
});

test("兜底的官方 AI 字幕和视频时长对不上时，照样走错配核对，不进缓存", async () => {
  // 官方字幕最后一句在 5 秒，视频却有 1 小时：只覆盖开头，判成对不上。
  const h = fallbackOn({ videoInfo: (ref) => ok(sampleInfo(ref, { durationSec: 3600 })), captions: () => failed("MALFORMED") });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(result.subtitleMismatch, true);
  assert.deepEqual(await h.rows(), []);
});

test("官方总结附带的 AI 字幕兜底也走同样的检查", async () => {
  const cues = [OFFICIAL_CUES[0] as Cue, { start: 1200, duration: 3, text: "第二句" }];
  const h = fallbackOn({ tracks: () => ok([]), videoInfo: (ref) => ok(sampleInfo(ref, { durationSec: 60 })), officialSummary: () => ok({ ...SUMMARY, cues }) });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(result.subtitleMismatch, true);
  assert.equal(h.site.count("readCaptions"), 0);
  assert.deepEqual(await h.rows(), []);
});

test("点名语言时下载失败、列表超时都照旧报错，不拿中文 AI 字幕顶替", async () => {
  const h = fallbackOn({ tracks: () => ok([EN]), captions: () => failed("MALFORMED") });
  assert.equal(failure(await h.service.get(REF, { mode: "full", lang: "en-US" })).code, "MALFORMED");
  assert.deepEqual(await h.rows(), []);

  const listFailed = fallbackOn({ tracks: () => failed("TIMEOUT") });
  assert.equal(failure(await listFailed.service.get(REF, { mode: "full", lang: "en-US" })).code, "TIMEOUT");
});

test("官方总结没带字幕时，下载失败照旧报下载失败", async () => {
  const h = fallbackOn({ captions: () => failed("MALFORMED"), officialSummary: () => ok(SUMMARY) });
  const reply = failure(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.code, "MALFORMED");
  assert.equal(reply.official?.status, "ok");
});

test("强制刷新时下载失败：缓存里已有播放器字幕和译文，兜底不覆盖，照旧报下载失败", async () => {
  const h = fallbackOn();
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "human");
  const before = await row(h);

  h.site.script.captions = () => failed("MALFORMED");
  assert.equal(failure(await h.service.get(REF, { mode: "full", fresh: true })).code, "MALFORMED");
  const after = await row(h);
  // 译文按字幕版本另存：缓存里的字幕版本没变，之前的译文照样对得上。
  assert.deepEqual(after?.transcript?.ref, before?.transcript?.ref);
  assert.deepEqual(after?.tracks.map((track) => track.lang), ["zh-CN", "en-US"]);
});

test("强制刷新时列表接口超时：缓存里的播放器字幕同样不被兜底覆盖", async () => {
  const h = fallbackOn();
  await h.service.get(REF, { mode: "full" });
  h.site.script.tracks = () => failed("TIMEOUT");
  assert.equal(failure(await h.service.get(REF, { mode: "full", fresh: true })).code, "TIMEOUT");
  assert.equal((await row(h))?.transcript?.ref.kind, "human");
});

test("缓存里是上次兜底存下的官方 AI 字幕：强制刷新再次下载失败时照常换成这次的兜底", async () => {
  const h = fallbackOn({ captions: () => failed("MALFORMED") });
  await h.service.get(REF, { mode: "full" });
  assert.equal((await row(h))?.transcript?.ref.kind, "official-ai");

  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(refreshed.transcript.ref.kind, "official-ai");
  assert.equal(refreshed.fromCache, false);
});

test("轨道列表取到了、下载失败才兜底：结果和缓存里留着列出的轨道，语言菜单还能选播放器字幕", async () => {
  const h = fallbackOn({ tracks: () => ok([ZH, EN]), captions: () => failed("MALFORMED") });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.deepEqual(result.tracks.map((track) => track.lang), ["zh-CN", "en-US"]);
  assert.deepEqual((await row(h))?.tracks.map((track) => track.lang), ["zh-CN", "en-US"]);
});

test("兜底写回前另一个窗口存下了播放器字幕：兜底不覆盖它", async () => {
  const player = cachedRow(ZH);
  let loads = 0;
  const h = fallbackOn(
    { captions: () => failed("MALFORMED") },
    {
      wrapCache: (inner) => ({
        ...inner,
        async load(key) {
          const loaded = await inner.load(key);
          // 第 2 次是兜底核对缓存（那时还是空的）；另一个窗口这时存下了播放器字幕，排在兜底写回前面。
          loads += 1;
          if (loads === 2) void h.service.writer.update(KEY, () => player);
          return loaded;
        },
      }),
    },
  );
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "human", "交回的是缓存里那份播放器字幕");
  assert.equal(result.fromCache, true);
  assert.equal((await row(h))?.transcript?.ref.kind, "human", "播放器字幕不被迟到的兜底盖掉");
});

test("内存里只有一份对不上的播放器字幕，强制刷新时下载失败：对得上的官方字幕兜底照常换上并进缓存", async () => {
  const wrong: Cue[] = [
    { start: 0, duration: 2, text: "错的一" },
    { start: 500, duration: 2, text: "错的二" },
  ];
  const h = fallbackOn({ videoInfo: (ref) => ok(sampleInfo(ref, { durationSec: 6 })), captions: () => ok(wrong) });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).subtitleMismatch, true);
  assert.deepEqual(await h.rows(), [], "对不上的不进缓存");

  h.site.script.captions = () => failed("MALFORMED");
  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(refreshed.transcript.ref.kind, "official-ai", "不能留着内存里那份对不上的");
  assert.equal(refreshed.subtitleMismatch, undefined);
  assert.equal((await row(h))?.transcript?.ref.kind, "official-ai");
});
