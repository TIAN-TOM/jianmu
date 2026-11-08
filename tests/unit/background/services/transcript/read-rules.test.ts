// 取字幕服务接上平台读取后的几条规矩：读不到视频信息时退到标签页标题；被限流就停，不换路也不重发；
// 换语言和刷新都重新列轨；一次读取一个读取环境，只用这次核对过的视频信息；本机已有的内容不登录也照常用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "../../../../../src/core/errors.ts";
import type { CaptionTrack, Chapter, SiteResult } from "../../../../../src/sites/types.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { failed, sampleInfo } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, EN, harness, OTHER_REF, REF, view, ZH } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const TAB = 7;

for (const [code, label] of [
  ["NEED_LOGIN", "没登录"],
  ["RATE_LIMITED", "被限流"],
  ["UNPLAYABLE", "看不了"],
] as const) {
  test(`视频信息读不到（${label}）时用标签页标题顶上，后面的读取都不发`, async () => {
    const h = harness({ site: { videoInfo: () => failed(code) }, tabTitles: { [TAB]: "标签页上的标题" } });
    const reply = await h.service.get(REF, { mode: "full", tabId: TAB });
    assert.deepEqual(reply, { ok: false, code, tabTitle: "标签页上的标题" });
    assert.deepEqual(h.titleReads, [TAB]);
    assert.deepEqual(h.site.calls.map((call) => call.method), ["readVideoInfo"]);
  });
}

test("读到了视频信息、或者请求没带标签页，就不去读标签页标题", async () => {
  const noCaptions = harness({ site: { tracks: () => ({ ok: true, value: [] }) }, tabTitles: { [TAB]: "标签页上的标题" } });
  const reply = await noCaptions.service.get(REF, { mode: "full", tabId: TAB });
  assert.equal(!reply.ok && reply.info?.author, "样例作者");
  assert.equal(!reply.ok && reply.tabTitle, undefined);
  assert.deepEqual(noCaptions.titleReads, []);

  const noTab = harness({ site: { videoInfo: () => failed("NEED_LOGIN") } });
  await noTab.service.get(REF, { mode: "full" });
  assert.deepEqual(noTab.titleReads, []);
});

test("字幕文件被限流：不试下一条、不重新列轨，服务自己也不重发", async () => {
  const h = harness({ site: { tracks: () => ({ ok: true, value: [ZH, EN] }), captions: () => failed("RATE_LIMITED", { retryAfterSec: 60 }) } });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "RATE_LIMITED");
  assert.equal(!reply.ok && reply.retryAfterSec, 60);
  assert.equal(h.site.count("readCaptions"), 1);
  assert.equal(h.site.count("listCaptionTracks"), 1);
  assert.equal(h.site.count("readVideoInfo"), 1);
});

test("点名语言时字幕文件读不成：重新列一次轨再试；第二轮的文件是空的，报第一次的错", async () => {
  let reads = 0;
  const h = harness({
    site: {
      tracks: () => ({ ok: true, value: [ZH, EN] }),
      captions: () => (++reads === 1 ? failed("NETWORK") : { ok: true, value: [] }),
    },
  });
  const reply = await h.service.get(REF, { mode: "full", lang: "en-US" });
  assert.equal(!reply.ok && reply.code, "NETWORK");
  assert.deepEqual(
    h.site.calls.filter((call) => call.method === "listCaptionTracks").map((call) => call.options),
    [{ fresh: true }, { fresh: true }],
  );
  assert.deepEqual(
    h.site.calls.filter((call) => call.method === "readCaptions").map((call) => call.track?.lang),
    ["en-US", "en-US"],
    "两轮都只读点名的语种",
  );
});

test("点名语言时字幕文件被限流不重新列轨；重新列轨本身被限流就报限流", async () => {
  const limited = harness({ site: { captions: () => failed("RATE_LIMITED") } });
  const first = await limited.service.get(REF, { mode: "full", lang: "en-US" });
  assert.equal(!first.ok && first.code, "RATE_LIMITED");
  assert.equal(limited.site.count("listCaptionTracks"), 1);

  let listings = 0;
  const relistLimited = harness({
    site: {
      tracks: () => (++listings === 1 ? { ok: true, value: [ZH, EN] } : failed("RATE_LIMITED")),
      captions: () => failed("NETWORK"),
    },
  });
  const second = await relistLimited.service.get(REF, { mode: "full", lang: "en-US" });
  assert.equal(!second.ok && second.code, "RATE_LIMITED");
  assert.equal(relistLimited.site.count("readCaptions"), 1);
});

test("没点名语言时字幕文件都读不成：不重新列轨", async () => {
  const h = harness({ site: { captions: () => failed("NETWORK") } });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "NETWORK");
  assert.equal(h.site.count("listCaptionTracks"), 1);
  assert.equal(h.site.count("readCaptions"), 2);
});

test("列轨被限流或读取路线整体读不了：就此停下，不读字幕文件", async () => {
  for (const result of [failed("RATE_LIMITED"), { ok: false, code: "MALFORMED", reach: "source" } as const]) {
    const h = harness({ site: { tracks: () => result } });
    const reply = await h.service.get(REF, { mode: "full" });
    assert.equal(!reply.ok && reply.code, result.code);
    assert.equal(h.site.count("readCaptions"), 0);
  }
});

test("字幕文件读不懂只算这一条，换下一条；读取路线整体读不了就停", async () => {
  const item = harness({ site: { captions: (_info, track) => (track === ZH ? failed("MALFORMED") : { ok: true, value: [{ start: 0, duration: 1, text: "English" }] }) } });
  assert.equal(view(await item.service.get(REF, { mode: "full" })).transcript.ref.lang, "en-US");
  assert.equal(item.site.count("readCaptions"), 2);

  const source = harness({ site: { captions: () => ({ ok: false, code: "MALFORMED", reach: "source" }) } });
  const reply = await source.service.get(REF, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "MALFORMED");
  assert.equal(source.site.count("readCaptions"), 1);
});

test("试过的字幕文件都是空的，报字幕文件是空的，不说成没有字幕", async () => {
  const h = harness({ site: { captions: () => ({ ok: true, value: [] }) } });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "EMPTY_CAPTION_FILE");
  assert.equal(h.site.count("readCaptions"), 2);
  assert.deepEqual(await h.rows(), []);
});

test("换语言和用户刷新都重新列轨；第一次读取用读取实现记着的列表", async () => {
  const h = harness();
  const listings = () => h.site.calls.filter((call) => call.method === "listCaptionTracks").map((call) => call.options);

  await h.service.get(REF, { mode: "full" });
  await h.service.get(REF, { mode: "full", lang: "en-US" });
  await h.service.get(REF, { mode: "full", fresh: true });
  assert.deepEqual(listings(), [undefined, { fresh: true }, { fresh: true }]);
});

test("列轨和读 UP 主分段一起发：两个都发出去以后才等结果", async () => {
  const listed = deferred();
  const chapters: Chapter[] = [{ title: "开场", start: 0, end: null }];
  const h = harness({
    site: {
      tracks: () => listed.promise.then((): SiteResult<CaptionTrack[]> => ({ ok: true, value: [ZH] })),
      chapters: () => listed.promise.then((): SiteResult<Chapter[]> => ({ ok: true, value: chapters })),
    },
  });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("listCaptionTracks") === 1 && h.site.count("readCreatorChapters") === 1));
  listed.resolve();
  assert.deepEqual(view(await pending).chapters, chapters);
});

test("UP 主分段读不到不影响字幕", async () => {
  const h = harness({ site: { chapters: () => failed("NETWORK") } });
  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.deepEqual(reply.chapters, []);
  assert.equal(reply.transcript.ref.lang, "zh-CN");
});

test("每次读取新建一个读取环境，这次读取的各步都用它", async () => {
  const h = harness();
  await h.service.get(REF, { mode: "full" });
  await h.service.get(REF, { mode: "full", fresh: true });

  assert.equal(h.ctxs.length, 2);
  assert.notEqual(h.ctxs[0], h.ctxs[1]);
  const firstRead = h.site.calls.slice(0, 5);
  assert.deepEqual(firstRead.map((call) => call.method).sort(), ["listCaptionTracks", "readCaptions", "readCreatorChapters", "readOfficialSummary", "readVideoInfo"]);
  assert.ok(firstRead.every((call) => call.ctx === h.ctxs[0]), "视频信息、列轨、分段、官方总结、字幕文件共用一个");
  assert.ok(h.site.calls.slice(5).every((call) => call.ctx === h.ctxs[1]));
});

test("列轨和读字幕文件只用这次读到的视频信息，不拿缓存里的旧版本", async () => {
  const stale = cachedRow(ZH, { info: sampleInfo(REF, { mediaVersion: "stale-version" }) });
  const h = harness({ seed: [stale] });

  await h.service.get(REF, { mode: "full", lang: "en-US" });

  const fresh = h.site.calls.find((call) => call.method === "readVideoInfo");
  assert.ok(fresh);
  for (const call of h.site.calls.filter((entry) => entry.method !== "readVideoInfo")) {
    assert.equal(call.info?.mediaVersion, `${REF.videoId}-m1`, call.method);
  }
  assert.equal((await h.rows())[0]?.info.mediaVersion, `${REF.videoId}-m1`);
});

test("读取实现交回的视频信息不是请求的那个视频：当作读取失败，不列轨、不写缓存", async () => {
  const h = harness({ site: { videoInfo: () => ({ ok: true, value: sampleInfo(OTHER_REF) }) } });
  const reply = await h.service.get(REF, { mode: "full" });
  assert.deepEqual(reply, { ok: false, code: "MALFORMED", detail: "video-mismatch" });
  assert.deepEqual(h.site.calls.map((call) => call.method), ["readVideoInfo"]);
  assert.deepEqual(await h.rows(), []);
});

test("没登录时本机缓存照常可用：命中缓存和只读缓存都不发平台请求", async () => {
  const h = harness({ seed: [cachedRow(ZH)], site: { videoInfo: () => failed("NEED_LOGIN") } });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).fromCache, true);
  assert.equal(view(await h.service.get(REF, { mode: "cache-only" })).fromCache, true);
  assert.equal(h.site.calls.length, 0);
  assert.equal(h.ctxs.length, 0);
});

test("只读缓存时语言对不上也算没有，不去平台读", async () => {
  const h = harness({ seed: [cachedRow(ZH)] });
  assert.deepEqual(await h.service.get(REF, { mode: "cache-only", lang: "en-US" }), { ok: false, code: "NOT_CACHED" });
  assert.equal(h.site.calls.length, 0);
});

test("空闲时不轮询：没人取字幕，时钟推过一小时也一个读取都不发", async () => {
  const h = harness();
  await h.service.get(REF, { mode: "full" });
  const before = h.site.calls.length;
  h.timers.advance(60 * 60 * 1000);
  assert.equal(h.site.calls.length, before);
  assert.equal(h.timers.pending(), 0);
});

test("还没接上读取服务的站：回不支持，只看本机缓存", async () => {
  const h = harness();
  const reply = await h.service.get({ platform: "youtube", videoId: "tube-sample" }, { mode: "full" });
  assert.deepEqual(reply, { ok: false, code: "SITE_UNSUPPORTED" });
  assert.equal(h.ctxs.length, 0);
});

test("清除本机数据以后发起的读取，不并进清除之前的在途读取", async () => {
  const held = deferred();
  const h = harness({ site: { captions: (_info, track) => held.promise.then(() => ({ ok: true, value: [{ start: 0, duration: 1, text: track.lang }] })) } });
  const before = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") === 1));
  h.service.forget("cache");
  const after = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readVideoInfo") === 2), "清除之后另起一次读取");
  held.resolve();
  await Promise.all([before, after]);
});

test("原视频查得到吗：只有平台说找不到才算不在，没登录、被限流、读不懂都不挡", async () => {
  for (const [result, available] of [
    [failed("NOT_FOUND"), false],
    [failed("NEED_LOGIN"), true],
    [failed("RATE_LIMITED"), true],
    [failed("UNPLAYABLE"), true],
    [{ ok: false, code: "MALFORMED", reach: "source" }, true],
    [{ ok: true, value: sampleInfo(REF) }, true],
  ] as const) {
    const h = harness({ site: { videoInfo: () => result } });
    assert.equal(await h.service.checkAvailable(REF), available, result.ok ? "读到了" : result.code);
    assert.deepEqual(h.site.calls.map((call) => call.method), ["readVideoInfo"]);
  }
});

test("看不了的视频按原因给一句话：付费内容不读、确认不了可读范围、其余是视频不可用", () => {
  assert.equal(describe("UNPLAYABLE", "paid"), "这是付费内容，简幕不读。");
  assert.equal(describe("UNPLAYABLE", "paid-unknown"), "暂时无法确认这个视频的可读范围，先不读。");
  assert.equal(describe("UNPLAYABLE"), "这个视频现在不可用。");
  assert.equal(describe("UNPLAYABLE", "something-else"), "这个视频现在不可用。");
  assert.equal(describe("NETWORK", "paid"), describe("NETWORK"), "别的码不认这几个说明");
});
