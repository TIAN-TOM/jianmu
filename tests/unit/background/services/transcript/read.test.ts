// 取字幕服务：缓存优先，没有再经站点读取服务去读；同一视频的在途读取合并；字幕文件下载有总预算。
// 站点是替身，缓存是真实仓储加内存驱动，时间全靠手动推进的计时器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClearGuard } from "../../../../../src/core/clear-guard.ts";
import { videoKey, type VideoRef } from "../../../../../src/core/video-ref.ts";
import type { TranscriptReply } from "../../../../../src/shared/messages/transcript.ts";
import type { CaptionTrack, Cue, SiteResult } from "../../../../../src/sites/types.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { failed, untilAborted } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, EN, harness, KEY, REF, sampleCues, texts, view, ZH, type Row } from "../../../../helpers/transcript-service.ts";
import { stillFalse, until } from "../../../../helpers/wait-until.ts";

const HANS: CaptionTrack = { trackId: "zh-Hans", lang: "zh-Hans", label: "中文（简体）", kind: "human" };
const PLAIN_EN: CaptionTrack = { trackId: "en", lang: "en", label: "English", kind: "human" };
const P2: VideoRef = { ...REF, segment: 2 };

const lines = (...text: string[]): Cue[] => text.map((line, index) => ({ start: index * 2, duration: 2, text: line }));

// ============================================================
// 取字幕
// ============================================================

test("无效的视频身份直接拒绝，不发任何请求", async () => {
  const h = harness();
  assert.deepEqual(await h.service.get({ platform: "bilibili", videoId: "not-a-video" }, { mode: "full" }), { ok: false, code: "INVALID_REQUEST" });
  assert.equal(h.site.calls.length, 0);
});

test("缓存命中时不再走网络，脏标志被现算值覆盖", async () => {
  const dirty = { ...cachedRow(), ok: false, fromCache: false } as Row;
  const h = harness({ seed: [dirty] });

  const reply = await h.service.get(REF, { mode: "full" });

  assert.equal(view(reply).fromCache, true);
  assert.equal("ok" in view(reply), false, "记录里夹着的字段不带出去");
  assert.equal(h.site.calls.length, 0, "命中缓存不访问平台");
  assert.equal(h.ctxs.length, 0);
});

test("无字幕轨区分需要登录与确实没有：未登录只报要登录，不往下读", async () => {
  const loggedOut = harness({ site: { videoInfo: () => failed("NEED_LOGIN") } });
  assert.deepEqual(await loggedOut.service.get(REF, { mode: "full" }), { ok: false, code: "NEED_LOGIN" });
  for (const method of ["listCaptionTracks", "readCreatorChapters", "readCaptions"] as const) assert.equal(loggedOut.site.count(method), 0, method);

  const hidden = harness({ site: { tracks: () => failed("NEED_LOGIN") } });
  const needLogin = await hidden.service.get(REF, { mode: "full" });
  assert.equal(needLogin.ok === false && needLogin.code, "NEED_LOGIN");
  assert.equal(hidden.site.count("readCaptions"), 0);

  const none = harness({ site: { tracks: () => ({ ok: true, value: [] }) } });
  const noCaptions = await none.service.get(REF, { mode: "full" });
  assert.equal(noCaptions.ok === false && noCaptions.code, "NO_CAPTIONS");
  assert.equal(noCaptions.ok === false && noCaptions.info?.title, "样例视频 BV1Sample000 第 1 P", "没有字幕也带回视频信息");
  assert.deepEqual(await none.rows(), [], "没读到字幕不写缓存");
});

test("正常拉取组装全部字段并写入缓存", async () => {
  const h = harness({ site: { chapters: () => ({ ok: true, value: [{ title: "开场", start: 0, end: 60 }] }) } });

  const reply = view(await h.service.get(P2, { mode: "full" }));

  assert.equal(reply.fromCache, false);
  assert.equal(reply.video, videoKey(P2));
  assert.equal(reply.info.title, "样例视频 BV1Sample000 第 2 P");
  assert.deepEqual({ ...reply.transcript.ref, fingerprint: "" }, { video: videoKey(P2), kind: "human", lang: "zh-CN", fingerprint: "" });
  assert.match(reply.transcript.ref.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(reply.transcript.label, "中文（中国）");
  assert.ok(reply.transcript.segments.length > 0);
  assert.match(texts({ ok: true, value: reply }), /第一句/);
  assert.deepEqual(reply.tracks.map((track) => track.lang), ["zh-CN", "en-US"]);
  assert.deepEqual(reply.chapters, [{ title: "开场", start: 0, end: 60 }]);

  const rows = await h.rows();
  assert.equal(rows.length, 1, "落了缓存");
  assert.equal(rows[0]?.videoKey, videoKey(P2));
  assert.deepEqual(rows[0]?.transcript?.cues, sampleCues("zh-CN"));
});

test("forceRefresh 绕过缓存直接拉新", async () => {
  const h = harness({ seed: [cachedRow()] });

  const reply = view(await h.service.get(REF, { mode: "full", fresh: true }));

  assert.equal(reply.fromCache, false);
  assert.equal(h.site.count("readVideoInfo"), 1, "重新访问平台");
  assert.deepEqual(h.site.calls.find((call) => call.method === "listCaptionTracks")?.options, { fresh: true }, "重新列轨");
  assert.match(texts({ ok: true, value: reply }), /第一句/);
});

test("指定 lang 走对应轨道：缓存语言不符时重新拉取", async () => {
  const h = harness({ seed: [cachedRow(ZH)] });

  const reply = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));

  assert.equal(reply.fromCache, false, "语言不符的缓存不命中");
  assert.deepEqual(h.site.calls.filter((call) => call.method === "readCaptions").map((call) => call.track?.lang), ["en-US"]);
  assert.equal(reply.transcript.ref.lang, "en-US");
  assert.match(texts({ ok: true, value: reply }), /First line/);
  assert.equal((await h.rows())[0]?.transcript?.ref.lang, "en-US", "缓存换成新语言");
});

test("同语言缓存仍可按 lang 命中", async () => {
  const h = harness({ seed: [cachedRow(EN)] });
  const reply = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(reply.fromCache, true);
  assert.equal(h.site.calls.length, 0);
});

test("列表暂时为空、缓存记过有字幕轨时，不说成没有字幕", async () => {
  const h = harness({ seed: [cachedRow(ZH)], site: { tracks: () => ({ ok: true, value: [] }) } });

  const reply = await h.service.get(REF, { mode: "full", lang: "en-US" });

  assert.equal(reply.ok, false);
  assert.equal(!reply.ok && reply.code, "SUBTITLE_TRACK_MISSING");
  assert.equal(h.site.count("readCaptions"), 0);
  assert.equal((await h.rows())[0]?.transcript?.ref.lang, "zh-CN", "缓存里原来的字幕不动");
});

test("字幕下载失败不会被说成视频没有字幕", async () => {
  const h = harness({ site: { tracks: () => ({ ok: true, value: [EN] }), captions: () => failed("NETWORK", { detail: "sample" }) } });

  const reply = await h.service.get(REF, { mode: "full", lang: "en-US" });

  assert.equal(!reply.ok && reply.code, "NETWORK");
  assert.deepEqual(!reply.ok && reply.tracks?.map((track) => track.lang), ["en-US"], "带回列出的轨，语言菜单照样能选");
  assert.equal(!reply.ok && reply.info?.author, "样例作者");
});

test("简体正文为空时改用同语种里有内容的中文（中国），点名英文仍用英文", async () => {
  const site = {
    tracks: (): SiteResult<CaptionTrack[]> => ({ ok: true, value: [HANS, ZH, PLAIN_EN] }),
    captions: (_info: unknown, track: CaptionTrack): SiteResult<Cue[]> =>
      ({ ok: true, value: track === ZH ? lines("德谟克利特") : track === PLAIN_EN ? lines("atoms") : [] }),
  };

  const chinese = await harness({ site }).service.get(REF, { mode: "full" });
  assert.equal(view(chinese).transcript.ref.lang, "zh-CN");
  assert.match(texts(chinese), /德谟克利特/);

  const english = await harness({ site }).service.get(REF, { mode: "full", lang: "en" });
  assert.equal(view(english).transcript.ref.lang, "en");
  assert.match(texts(english), /atoms/);
  assert.doesNotMatch(texts(english), /德谟克利特/);
});

test("网络层错误码原样透出", async () => {
  const h = harness({ site: { videoInfo: () => failed("RATE_LIMITED", { retryAfterSec: 120, detail: "sample" }) } });
  assert.deepEqual(await h.service.get(REF, { mode: "full" }), { ok: false, code: "RATE_LIMITED", detail: "sample", retryAfterSec: 120 });
  assert.equal(h.site.count("listCaptionTracks"), 0);
});

test("只读缓存的取字幕：缓存里没有就直接说没有，不向平台发任何请求", async () => {
  const h = harness();
  assert.deepEqual(await h.service.get(REF, { mode: "cache-only" }), { ok: false, code: "NOT_CACHED" });
  assert.equal(h.site.calls.length, 0);
  assert.equal(h.ctxs.length, 0);
});

// ============================================================
// 缓存的读—改—写和淘汰
// ============================================================

test("缓存记录的读—改—写并发时串行合并，互不覆盖", async () => {
  const h = harness({ seed: [cachedRow()] });
  const chapter = { title: "加的分段", start: 0, end: null };
  await Promise.all([
    h.service.writer.update(KEY, (current) => current && { ...current, chapters: [...current.chapters, chapter] }),
    h.service.writer.update(KEY, (current) => current && { ...current, tracks: [...current.tracks, PLAIN_EN] }),
  ]);
  const [row] = await h.rows();
  assert.deepEqual(row?.chapters, [chapter]);
  assert.deepEqual(row?.tracks.map((track) => track.lang), ["zh-CN", "en-US", "en"]);
});

test("读—改—写原样交回现有记录时不写缓存", async () => {
  let writes = 0;
  const h = harness({
    seed: [cachedRow()],
    wrapDriver: (inner) => ({ ...inner, write: (change) => ((writes += 1), inner.write(change)) }),
  });

  const kept = await h.service.writer.update(KEY, (current) => current);
  assert.equal(kept?.transcript?.ref.lang, "zh-CN");
  assert.equal(writes, 0, "没有改动就不写");

  await h.service.writer.update(KEY, (current) => current && { ...current, chapters: [] });
  assert.equal(writes, 1, "有改动照常写");
});

test("写进缓存的只有要存的字段：响应专用的标志和字幕文件地址都不进缓存", async () => {
  const withAddress = (track: CaptionTrack) => ({ ...track, url: "https://files.example/sample.json" });
  const h = harness({ site: { tracks: () => ({ ok: true, value: [withAddress(ZH), withAddress(EN)] }) } });

  await h.service.get(REF, { mode: "full" });

  const [row] = await h.rows();
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ["chapters", "info", "official", "timestamp", "tracks", "transcript", "videoKey"]);
  assert.deepEqual(Object.keys(row.official ?? {}).sort(), ["fetchedAt", "hasCaptions", "outline", "status", "summary"]);
  assert.deepEqual(row.tracks.map((track) => Object.keys(track).sort()), [
    ["kind", "label", "lang", "trackId"],
    ["kind", "label", "lang", "trackId"],
  ]);
  assert.doesNotMatch(JSON.stringify(row), /https?:\/\/|fromCache/);
});

test("新视频的字幕落库后不等淘汰就返回，淘汰随后照常做一次", async () => {
  const log: string[] = [];
  const evictGate = deferred();
  const h = harness({
    wrapDriver: (inner) => ({
      ...inner,
      write: (change) => (log.push(change?.put ? "put" : "remove"), inner.write(change)),
      getAllByIndex: async (index, key) => {
        log.push("evict:start");
        await evictGate.promise;
        log.push("evict:done");
        return inner.getAllByIndex(index, key);
      },
    }),
  });

  const reply = await h.service.get(REF, { mode: "full" });
  assert.equal(reply.ok, true);
  assert.equal(log[0], "put", "写入本身不带淘汰");
  assert.ok(await until(() => log.includes("evict:start")), "随后做一次淘汰");
  assert.equal(log.includes("evict:done"), false, "返回时淘汰还没做完");
  evictGate.resolve();
  assert.ok(await until(() => log.includes("evict:done")));
});

test("淘汰排在缓存写入队列里：之后的读—改—写等它做完", async () => {
  const log: string[] = [];
  const evictGate = deferred();
  const h = harness({
    wrapDriver: (inner) => ({
      ...inner,
      write: (change) => (log.push("write"), inner.write(change)),
      getAllByIndex: async (index, key) => {
        log.push("evict:start");
        await evictGate.promise;
        log.push("evict:done");
        return inner.getAllByIndex(index, key);
      },
    }),
  });
  await h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => log.includes("evict:start")));

  const update = h.service.writer.update(KEY, (current) => current && { ...current, chapters: [] });
  assert.ok(await stillFalse(() => log.filter((entry) => entry === "write").length > 1, 20), "淘汰没做完前不写");
  evictGate.resolve();
  await update;
  assert.deepEqual(log.slice(-2), ["evict:done", "write"]);
});

// ============================================================
// 字幕文件的下载预算
// ============================================================

test("第一条字幕文件超时：不再一条条试其余轨，直接报超时", async () => {
  const h = harness({ site: { tracks: () => ({ ok: true, value: [HANS, ZH, EN] }), captions: () => failed("TIMEOUT") } });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "TIMEOUT");
  assert.equal(h.site.count("readCaptions"), 1);
});

test("点名语言时超时：不再重拉一次列表重试", async () => {
  const h = harness({ site: { tracks: () => ({ ok: true, value: [EN, PLAIN_EN] }), captions: () => failed("TIMEOUT") } });
  const reply = await h.service.get(REF, { mode: "full", lang: "en-US" });
  assert.equal(!reply.ok && reply.code, "TIMEOUT");
  assert.equal(h.site.count("listCaptionTracks"), 1);
  assert.equal(h.site.count("readCaptions"), 1);
});

test("内容失败（空文件、读取被拒）照旧试下一条", async () => {
  const h = harness({
    site: {
      tracks: () => ({ ok: true, value: [HANS, ZH, EN] }),
      captions: (_info, track) => (track === HANS ? { ok: true, value: [] } : track === ZH ? failed("NETWORK", { detail: "sample" }) : { ok: true, value: sampleCues("en") }),
    },
  });
  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.transcript.ref.lang, "en-US");
  assert.equal(h.site.count("readCaptions"), 3);
});

test("下载有总预算：每条的超时不超过剩下的预算，用完就不再试下一条", async () => {
  // 第一条 10 秒后读取被拒，第二条一直不回：到 15 秒整次读取被中止，报超时，第三条不再试。
  const first = deferred();
  const h = harness({
    site: {
      tracks: () => ({ ok: true, value: [HANS, ZH, EN] }),
      captions: (_info, track, ctx) => (track === HANS ? first.promise.then(() => failed("NETWORK")) : untilAborted(ctx)),
    },
  });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") === 1));
  h.timers.advance(10_000);
  first.resolve();
  assert.ok(await until(() => h.site.count("readCaptions") === 2));
  assert.equal(h.ctxs[0]?.signal.aborted, false);
  h.timers.advance(5_000);
  assert.ok(await until(() => h.ctxs[0]?.signal.aborted === true), "到点中止这次读取");
  const reply = await pending;
  assert.equal(!reply.ok && reply.code, "TIMEOUT");
  assert.equal(!reply.ok && reply.detail, "download-budget");
  assert.equal(h.site.count("readCaptions"), 2, "预算用完，第三条不再试");

  // 剩下的预算不到 1 秒时不再开始新的一条。
  const late = deferred();
  const tight = harness({
    site: {
      tracks: () => ({ ok: true, value: [HANS, ZH, EN] }),
      captions: () => late.promise.then(() => failed("NETWORK")),
    },
  });
  const tightPending = tight.service.get(REF, { mode: "full" });
  assert.ok(await until(() => tight.site.count("readCaptions") === 1));
  tight.timers.advance(14_500);
  late.resolve();
  const tightReply = await tightPending;
  assert.equal(!tightReply.ok && tightReply.code, "NETWORK");
  assert.equal(tight.site.count("readCaptions"), 1);
  assert.equal(tight.timers.pending(), 0, "预算的计时器收掉了");
});

test("默认预算下第一条只受单个文件的上限管：预算比它长，不提前中止", async () => {
  const slow = deferred();
  const h = harness({ site: { captions: () => slow.promise.then(() => failed("TIMEOUT")) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") === 1));

  // 单个文件的上限是 12 秒，由读取实现自己管；总预算 15 秒，这时还没到。
  h.timers.advance(12_000);
  assert.equal(h.ctxs[0]?.signal.aborted, false);
  slow.resolve();

  const reply = await pending;
  assert.equal(!reply.ok && reply.code, "TIMEOUT");
  assert.equal(!reply.ok && reply.detail, undefined, "是单个文件的超时，不是总预算");
  assert.equal(h.timers.pending(), 0);
});

// ============================================================
// 在途合并
// ============================================================

test("同一个没缓存的视频同时取两次字幕：B站每个接口只请求一次，两边都拿到字幕", async () => {
  const h = harness();
  const [panel, card] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full" })]);

  assert.equal(texts(panel), texts(card));
  for (const method of ["readVideoInfo", "listCaptionTracks", "readCreatorChapters", "readOfficialSummary", "readCaptions"] as const) {
    assert.equal(h.site.count(method), 1, method);
  }
  assert.equal((await h.rows()).length, 1);

  // 各拿各的外壳：一方往结果上补字段，另一方看不到。
  (view(panel) as unknown as Record<string, unknown>)["extra"] = true;
  assert.equal((view(card) as unknown as Record<string, unknown>)["extra"], undefined);
});

test("请求落定后不再复用：之后的调用照常走缓存，不重发", async () => {
  const h = harness();
  await h.service.get(REF, { mode: "full" });
  const before = h.site.calls.length;
  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.fromCache, true);
  assert.equal(h.site.calls.length, before);
});

test("强制刷新不被在途的普通请求顶替；两次强制刷新同时发也只请求一次", async () => {
  const h = harness();
  const [plain, forced] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full", fresh: true })]);
  assert.equal(view(plain).fromCache, false);
  assert.equal(view(forced).fromCache, false);
  for (const method of ["readVideoInfo", "listCaptionTracks", "readCaptions"] as const) assert.equal(h.site.count(method), 2, method);

  h.site.calls.length = 0;
  await Promise.all([h.service.get(REF, { mode: "full", fresh: true }), h.service.get(REF, { mode: "full", fresh: true })]);
  for (const method of ["readVideoInfo", "listCaptionTracks", "readCaptions"] as const) assert.equal(h.site.count(method), 1, method);
});

test("换语言、换分 P 各自成键，不会拿到别的轨道或别的分 P", async () => {
  const h = harness();
  const [zh, en, p2] = await Promise.all([
    h.service.get(REF, { mode: "full" }),
    h.service.get(REF, { mode: "full", lang: "en-US" }),
    h.service.get(P2, { mode: "full" }),
  ]);
  assert.equal(view(zh).transcript.ref.lang, "zh-CN");
  assert.equal(view(en).transcript.ref.lang, "en-US");
  assert.match(texts(en), /First line/);
  assert.equal(view(p2).video, videoKey(P2));
  assert.equal(view(p2).info.title, "样例视频 BV1Sample000 第 2 P");
  const infoReads = (segment: number) => h.site.calls.filter((call) => call.method === "readVideoInfo" && call.ref?.segment === segment).length;
  assert.equal(infoReads(1), 2);
  assert.equal(infoReads(2), 1);
});

test("失败的请求不留给后来的调用：下一次重新向 B站要", async () => {
  const h = harness({ site: { tracks: () => failed("RATE_LIMITED") } });
  const [first, second] = await Promise.all([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full" })]);
  assert.equal(!first.ok && first.code, "RATE_LIMITED");
  assert.equal(!second.ok && second.code, "RATE_LIMITED");
  assert.equal(h.site.count("listCaptionTracks"), 1);

  h.site.script.tracks = () => ({ ok: true, value: [ZH] });
  const retried = await h.service.get(REF, { mode: "full" });
  assert.equal(retried.ok, true);
  assert.equal(h.site.count("listCaptionTracks"), 2);
});

test("在途请求抛错时一起收到错误，之后的调用不受牵连", async () => {
  let failNext = true;
  const h = harness({
    wrapCache: (inner) => ({
      ...inner,
      async load(key) {
        if (failNext) {
          failNext = false;
          throw new Error("数据库打不开");
        }
        return inner.load(key);
      },
    }),
  });
  const results = await Promise.allSettled([h.service.get(REF, { mode: "full" }), h.service.get(REF, { mode: "full" })]);
  assert.deepEqual(results.map((item) => item.status), ["rejected", "rejected"]);
  const later = await h.service.get(REF, { mode: "full" });
  assert.equal(later.ok, true);
});

test("缓存写入之后才发起的取字幕不并进写之前的在途请求，拿得到刚写进缓存的内容", async () => {
  const held = deferred();
  const h = harness({ site: { captions: (_info, track) => held.promise.then(() => ({ ok: true, value: sampleCues(track.lang) })) } });
  const before = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") === 1), "第一次读取停在下载那一步");

  // 别的写入（比如另一个窗口刚存下的字幕）落了缓存，之后侧边栏再读一次。
  const written = cachedRow(ZH);
  await h.service.writer.update(KEY, () => written);
  let answered: TranscriptReply | undefined;
  void h.service.get(REF, { mode: "full" }).then((reply) => (answered = reply));
  assert.ok(await until(() => answered !== undefined), "没有并进写之前的在途读取，不用等它");
  const after = answered as TranscriptReply;

  assert.equal(view(after).fromCache, true);
  assert.deepEqual(view(after).transcript.cues, written.transcript?.cues);
  assert.equal(h.site.count("readVideoInfo"), 1);

  held.resolve();
  assert.equal((await before).ok, true, "已经在等的调用方照旧拿自己的结果");
});

test("缓存没变（mutate 原样交回）时不拆在途请求，后来的调用照常合并", async () => {
  const held = deferred();
  const h = harness({ site: { captions: (_info, track) => held.promise.then(() => ({ ok: true, value: sampleCues(track.lang) })) } });
  const first = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readVideoInfo") === 1));

  await h.service.writer.update(KEY, (current) => current);
  const second = h.service.get(REF, { mode: "full" });
  held.resolve();
  await Promise.all([first, second]);
  assert.equal(h.site.count("readVideoInfo"), 1);
  assert.equal(h.site.count("listCaptionTracks"), 1);
});

test("读取途中清除了本机数据：读到的照样交给调用方，不写回刚清空的缓存", async () => {
  const guard = createClearGuard();
  const held = deferred();
  const h = harness({ guard, site: { captions: (_info, track) => held.promise.then(() => ({ ok: true, value: sampleCues(track.lang) })) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") === 1));

  await guard.clear("cache", async () => {});
  held.resolve();

  assert.match(texts(await pending), /第一句/);
  assert.deepEqual(await h.rows(), []);
});
