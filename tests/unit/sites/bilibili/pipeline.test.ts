// 整条读取管线：真实的 B 站读取实现接上真实的取字幕服务，只替换请求。换语言、字幕文件读不成时重新列轨、
// 选轨和去重、官方总结和 UP 主分段跟着字幕进缓存、没登录时只问登录；卡片的轻量读取没登录时也只问登录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptService, type TranscriptService } from "../../../../src/background/services/transcript/index.ts";
import type { CachedTranscript } from "../../../../src/background/services/transcript/write.ts";
import { createCacheStore, type CacheEntry } from "../../../../src/background/stores/cache.ts";
import { createImportStore, type ImportRecord } from "../../../../src/background/stores/imports.ts";
import { createOverviewStore } from "../../../../src/background/stores/overviews.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import type { OverviewRecord } from "../../../../src/core/notes/records.ts";
import { OFFICIAL_SUBTITLE_LABEL } from "../../../../src/core/transcript/sources.ts";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import { NAV_URL, PLAYER_URL, SUMMARY_URL, VIEW_URL } from "../../../../src/sites/bilibili/http.ts";
import { createBilibiliService } from "../../../../src/sites/bilibili/service.ts";
import { playerEnvelope } from "../../../helpers/bilibili-captions.ts";
import { fakeBackoff, fakeSite, siteCtx, type FakeSite, type Route, type SeenRequest } from "../../../helpers/bilibili-fetch.ts";
import { BVID, json, navLoggedIn, navLoggedOut, viewEnvelope } from "../../../helpers/bilibili-fixtures.ts";
import { manualTimers, type ManualTimers } from "../../../helpers/manual-timers.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";
import { cachedRow, view } from "../../../helpers/transcript-service.ts";

type Row = CacheEntry<CachedTranscript>;

const REF: VideoRef = { platform: "bilibili", videoId: BVID, segment: 1 };
const FILES = "https://i0.hdslb.com/bfs/subtitle/";

const track = (lan: string, file: string, lan_doc = lan, extra: Record<string, unknown> = {}) => ({
  lan,
  lan_doc,
  subtitle_url: `//i0.hdslb.com/bfs/subtitle/${file}`,
  ...extra,
});
const ZH_HANS = track("zh-Hans", "zh.json", "中文（简体）");
const ENGLISH = track("en", "en.json", "English");
const BILINGUAL = [ZH_HANS, ENGLISH];

/** n 行字幕，每行半秒，都落在两分钟的样例视频里。 */
const body = (n: number, text = "样例台词"): Response =>
  json(200, { body: Array.from({ length: n }, (_, index) => ({ from: index / 2, to: index / 2 + 0.5, content: `${text} ${index + 1}` })) });

const fileName = (request: SeenRequest): string => request.endpoint.slice(FILES.length);

interface Script {
  /** 第 n 次列轨（从 1 数）回哪些字幕轨，view_points 另给。 */
  readonly tracks?: (n: number) => readonly unknown[];
  /** UP 主分段：固定一份，或者按第 n 次列轨给。 */
  readonly chapters?: readonly unknown[] | ((n: number) => readonly unknown[]);
  /** 字幕文件按请求回。 */
  readonly file?: (request: SeenRequest) => Response;
  readonly summary?: Route;
  readonly loggedOut?: boolean;
}

interface Rig {
  readonly fake: FakeSite;
  readonly timers: ManualTimers;
  readonly service: TranscriptService;
  readonly rows: () => Promise<Row[]>;
  readonly downloads: () => string[];
}

function rig(script: Script = {}, options: { readonly seed?: readonly Row[]; readonly fallback?: boolean } = {}): Rig {
  let listings = 0;
  const routes: Record<string, Route> = {
    [NAV_URL]: () => json(200, script.loggedOut ? navLoggedOut() : navLoggedIn()),
    [VIEW_URL]: () => json(200, viewEnvelope()),
    [PLAYER_URL]: () => {
      listings += 1;
      const chapters = typeof script.chapters === "function" ? script.chapters(listings) : script.chapters;
      return json(200, playerEnvelope(script.tracks?.(listings) ?? BILINGUAL, chapters ? { view_points: chapters } : {}));
    },
    [SUMMARY_URL]: script.summary ?? (() => json(200, { code: 0, data: { code: -1, model_result: { summary: "", outline: [] } } })),
  };
  const fake = fakeSite(routes);
  // 字幕文件按文件名分路由：替身按不带查询串的地址找路由，这里统一交给 script.file。
  for (const name of ["zh.json", "en.json", "empty.json", "cn.json"]) fake.routes.set(`${FILES}${name}`, (request) => (script.file ?? (() => body(2)))(request));
  const timers = manualTimers(1_800_000_000_000);
  const guard = createClearGuard();
  const driver = createMemoryDriver<Row>("cache", options.seed ?? []);
  const site = createBilibiliService({ now: timers.now });
  const backoff = fakeBackoff();
  const service = createTranscriptService({
    sites: { service: () => site, ctx: (_platform, { signal }) => siteCtx(fake, backoff, signal) },
    cache: createCacheStore<CachedTranscript>({ driver, guard, now: timers.now }),
    imports: createImportStore({ driver: createMemoryDriver<ImportRecord>("imports"), guard }),
    overviews: createOverviewStore({ driver: createMemoryDriver<OverviewRecord>("overviews"), guard }),
    guard,
    tabTitle: async () => null,
    timers,
    log: { warn() {}, error() {} },
    officialCaptionsFallback: options.fallback ?? false,
  });
  const downloads = () => fake.requests.filter((request) => request.endpoint.startsWith(FILES)).map(fileName);
  return { fake, timers, service, rows: () => driver.getAll(), downloads };
}

const langOf = (rows: readonly Row[]): string | undefined => rows[0]?.transcript?.ref.lang;

for (const expired of [true, false]) {
  test(`合成契约：中文缓存后首次点名英文（列轨的内存记录${expired ? "已过期" : "还在"}）`, async () => {
    const h = rig({ file: (request) => (fileName(request) === "en.json" ? body(157, "English") : body(2, "中文")) });
    assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.lang, "zh-Hans");
    if (expired) h.timers.advance(5 * 60_000 + 1);
    const before = h.fake.requests.length;
    const listingsBefore = h.fake.calls(PLAYER_URL).length;

    const result = view(await h.service.get(REF, { mode: "full", lang: "en" }));
    assert.equal(result.transcript.ref.lang, "en");
    assert.equal(result.transcript.cues.length, 157);
    assert.deepEqual(h.downloads().slice(1), ["en.json"]);
    assert.equal(h.fake.calls(PLAYER_URL).length, listingsBefore + 1, "换语言重新列轨");
    assert.equal(langOf(await h.rows()), "en");

    const count = h.fake.requests.length;
    assert.ok(count > before);
    assert.equal(view(await h.service.get(REF, { mode: "full", lang: "en" })).fromCache, true);
    assert.equal(h.fake.requests.length, count);
  });
}

test("指定 English 已消失：严格选轨返回缺轨，不下载中文或覆盖中文缓存", async () => {
  const h = rig({ tracks: () => [ZH_HANS] });
  await h.service.get(REF, { mode: "full" });
  const downloaded = h.downloads().length;

  const result = await h.service.get(REF, { mode: "full", lang: "en" });
  assert.equal(!result.ok && result.code, "SUBTITLE_TRACK_MISSING");
  assert.equal(!result.ok && result.tracks?.length, 1);
  assert.equal(h.downloads().length, downloaded);
  assert.equal((await h.rows()).length, 1);
  assert.equal(langOf(await h.rows()), "zh-Hans");
});

test("列轨记下的英文地址过期：重新列轨拿新签名的地址，始终不下载中文", async () => {
  const h = rig(
    {
      tracks: (n) => [ZH_HANS, track("en", `en.json?auth_key=${n}`, "English")],
      file: (request) => (request.query.get("auth_key") === "1" ? json(403, {}) : body(157, "English")),
    },
    { seed: [cachedRow(undefined, {}, REF)] },
  );

  const result = view(await h.service.get(REF, { mode: "full", lang: "en" }));
  assert.equal(result.transcript.cues.length, 157);
  const files = h.fake.requests.filter((request) => request.endpoint.startsWith(FILES));
  assert.deepEqual(
    files.map((request) => [fileName(request), request.query.get("auth_key")]),
    [
      ["en.json", "1"],
      ["en.json", "2"],
    ],
  );
  assert.equal(langOf(await h.rows()), "en");
});

test("首次英文下载失败：刷新列表后第二个签名成功，仅请求英文", async () => {
  const h = rig({
    tracks: (n) => [ZH_HANS, track("en", `en.json?auth_key=${n}`, "English")],
    file: (request) => (request.query.get("auth_key") === "1" ? json(403, {}) : body(157, "English")),
  });
  const result = view(await h.service.get(REF, { mode: "full", lang: "en" }));
  assert.equal(result.transcript.ref.lang, "en");
  assert.deepEqual(h.downloads(), ["en.json", "en.json"]);
  assert.equal(h.fake.calls(PLAYER_URL).length, 2);
});

test("英文持续 403 后用户强制重试：不命中中文缓存，不回退中文，恢复后写英文", async () => {
  let blocked = true;
  const h = rig({ file: (request) => (fileName(request) === "en.json" ? (blocked ? json(403, {}) : body(157, "English")) : body(2, "中文")) });
  await h.service.get(REF, { mode: "full" });
  const downloaded = h.downloads().length;

  const failed = await h.service.get(REF, { mode: "full", lang: "en" });
  assert.equal(!failed.ok && failed.code, "NETWORK");
  assert.equal(!failed.ok && failed.tracks?.length, 2);
  assert.equal(langOf(await h.rows()), "zh-Hans");

  blocked = false;
  const retried = view(await h.service.get(REF, { mode: "full", lang: "en", fresh: true }));
  assert.equal(retried.transcript.ref.lang, "en");
  assert.equal(retried.transcript.cues.length, 157);
  assert.ok(h.downloads().slice(downloaded).every((file) => file === "en.json"));
  assert.equal(langOf(await h.rows()), "en");
});

test("点名英文空占位：同语种 English 有正文时回退，不下载中文", async () => {
  const h = rig({
    tracks: () => [ZH_HANS, track("en-US", "empty.json", "English(US)"), ENGLISH],
    file: (request) => (fileName(request) === "empty.json" ? body(0) : body(157, "English")),
  });
  const result = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(result.transcript.ref.lang, "en");
  assert.equal(result.transcript.cues.length, 157);
  assert.deepEqual(h.downloads(), ["empty.json", "en.json"]);
});

test("英文轨正文全空：返回 EMPTY_CAPTION_FILE，不能伪装成 NO_CAPTIONS 或中文成功", async () => {
  const h = rig({ file: () => body(0) });
  const result = await h.service.get(REF, { mode: "full", lang: "en" });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "EMPTY_CAPTION_FILE");
  assert.deepEqual(await h.rows(), []);
  assert.deepEqual(h.downloads(), ["en.json", "en.json"]);
});

test("同中文文件不同签名只留简体，独立有正文的地区中文仍保留并可回退", async () => {
  const h = rig({
    tracks: () => [
      track("zh", "empty.json?auth_key=alias", "中文"),
      track("zh-Hans", "empty.json?auth_key=specific", "中文（简体）"),
      track("zh-CN", "cn.json", "中文（中国）"),
    ],
    file: (request) => (fileName(request) === "empty.json" ? body(0) : body(90, "合成中文")),
  });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.lang, "zh-CN");
  assert.equal(result.transcript.cues.length, 90);
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0]?.lang, "zh-Hans");
  assert.deepEqual(h.downloads(), ["empty.json", "cn.json"]);
});

const summaryEnvelope = (lines?: readonly unknown[]) =>
  json(200, {
    code: 0,
    data: {
      code: 0,
      stid: "1",
      model_result: {
        summary: "合成总摘要",
        outline: [{ title: "第一段", timestamp: 3, part_outline: [{ timestamp: 5, content: "要点一" }] }],
        subtitle: lines ? [{ part_subtitle: lines }] : [],
      },
    },
  });

test("官方总结和字幕一起请求：带签名和 bvid/cid/up_mid，结果跟着字幕缓存存", async () => {
  const h = rig({ summary: () => summaryEnvelope() });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "human");
  assert.equal(result.official?.status, "ok");
  assert.equal(result.official?.summary, "合成总摘要");
  assert.deepEqual(result.official?.outline[0]?.points, [{ timestamp: 5, content: "要点一" }]);

  const [asked, ...more] = h.fake.calls(SUMMARY_URL);
  assert.ok(asked);
  assert.deepEqual(more, []);
  assert.equal(asked.query.get("bvid"), BVID);
  assert.equal(asked.query.get("cid"), "2002");
  assert.equal(asked.query.get("up_mid"), "3003");
  assert.ok(asked.query.get("w_rid"), "带请求签名");
  assert.equal(asked.init.credentials, "include");
  assert.equal((await h.rows())[0]?.official?.summary, "合成总摘要");
  assert.equal(h.fake.calls(NAV_URL).length, 1, "登录检查和两路签名共用一次账号请求");
});

test("播放器没有字幕时，官方总结里的 AI 字幕接上整条管线", async () => {
  const h = rig(
    {
      tracks: () => [],
      summary: () =>
        summaryEnvelope([
          { content: "第二句", start_timestamp: 2.5, end_timestamp: 4 },
          { content: "第一句", start_timestamp: 0, end_timestamp: 2.5 },
        ]),
    },
    { fallback: true },
  );
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "official-ai");
  assert.equal(result.transcript.label, OFFICIAL_SUBTITLE_LABEL);
  assert.deepEqual(result.transcript.cues, [
    { text: "第一句", start: 0, duration: 2.5 },
    { text: "第二句", start: 2.5, duration: 1.5 },
  ]);
  assert.equal((await h.rows()).length, 1);
  assert.deepEqual(h.downloads(), []);
});

test("未登录：只问一次登录就报需要登录，不问官方总结，什么都不存", async () => {
  const h = rig({ loggedOut: true });
  const result = await h.service.get(REF, { mode: "full" });
  assert.equal(!result.ok && result.code, "NEED_LOGIN");
  assert.equal(!result.ok && result.official, undefined);
  assert.deepEqual(
    h.fake.requests.map((request) => request.endpoint),
    [NAV_URL],
  );
  assert.deepEqual(await h.rows(), []);
});

const CHAPTERS = [
  { type: 2, from: 0, to: 60, content: "开场" },
  { type: 2, from: 60, to: 180, content: "正题" },
];

test("UP 主分段随字幕一起取回、进缓存；换语言重新列轨时分段照样带上", async () => {
  const h = rig({ chapters: CHAPTERS });
  const first = view(await h.service.get(REF, { mode: "full" }));
  assert.deepEqual(first.chapters, [
    { title: "开场", start: 0, end: 60 },
    { title: "正题", start: 60, end: 180 },
  ]);
  assert.equal((await h.rows())[0]?.chapters.length, 2);
  assert.equal(h.fake.calls(PLAYER_URL).length, 1, "不为分段多发请求");

  const english = view(await h.service.get(REF, { mode: "full", lang: "en" }));
  assert.equal(english.transcript.ref.lang, "en");
  assert.equal(h.fake.calls(PLAYER_URL).length, 2, "换语言重新列了一次轨");
  assert.equal(english.chapters.length, 2);
});

test("刷新时 UP 主分段跟着新列表走：列表记录还没过期也不拿旧分段写回缓存", async () => {
  const h = rig({ chapters: (n) => [{ type: 2, from: 0, to: 60, content: n === 1 ? "旧的分段" : "新的分段" }] });
  assert.deepEqual(view(await h.service.get(REF, { mode: "full" })).chapters.map((chapter) => chapter.title), ["旧的分段"]);

  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(h.fake.calls(PLAYER_URL).length, 2, "刷新重新列了一次轨，分段并在同一次请求上");
  assert.deepEqual(refreshed.chapters.map((chapter) => chapter.title), ["新的分段"]);
  assert.deepEqual((await h.rows())[0]?.chapters.map((chapter) => chapter.title), ["新的分段"]);
});

test("没有字幕时，失败结果里照样带着 UP 主分段", async () => {
  const h = rig({ tracks: () => [], chapters: CHAPTERS });
  const result = await h.service.get(REF, { mode: "full" });
  assert.equal(!result.ok && result.code, "NO_CAPTIONS");
  assert.equal(!result.ok && result.chapters?.length, 2);
});

test("UP 主自己只上传了英文、别人传了中文：不标原语言，按语言优先顺序选中文", async () => {
  const h = rig({ tracks: () => [{ ...ZH_HANS, author_mid: 99 }, { ...ENGLISH, author_mid: 3003 }] });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.lang, "zh-Hans");
  assert.deepEqual(h.downloads(), ["zh.json"]);
});

// ============================================================
// 卡片的轻量读取：没登录时只提示，本机缓存照常给卡片用
// ============================================================

test("卡片未登录：只问一次登录就提示登录，不读视频信息和官方总结", async () => {
  const h = rig({ loggedOut: true });
  const reply = await h.service.light(REF);
  assert.equal(!reply.ok && reply.code, "NEED_LOGIN");
  assert.deepEqual(
    h.fake.requests.map((request) => request.endpoint),
    [NAV_URL],
  );
  assert.deepEqual(await h.rows(), []);
});

test("卡片未登录、本机已有缓存：照常摆缓存里的官方总结，一个请求都不发", async () => {
  const official = { status: "ok", summary: "缓存里的官方总结", outline: [], hasCaptions: false, fetchedAt: 1_800_000_000_000 } as const;
  const h = rig({ loggedOut: true }, { seed: [cachedRow(undefined, { official }, REF)] });
  const reply = await h.service.light(REF);
  assert.ok(reply.ok);
  assert.equal(reply.value.hasTranscript, true);
  assert.equal(reply.value.official?.summary, "缓存里的官方总结");
  assert.deepEqual(h.fake.requests, []);
});
