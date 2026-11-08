// 视频归属：真实的 B 站读取实现接上真实的取字幕服务，只替换请求。返回的视频信息对不上请求的视频时整次作废；
// 迟到的结果只写回发起时的视频；字幕列表和官方总结请求带的视频号和媒体编号等于这次读到的视频信息。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptService, type TranscriptService } from "../../../../src/background/services/transcript/index.ts";
import type { CachedTranscript } from "../../../../src/background/services/transcript/write.ts";
import { createCacheStore, type CacheEntry } from "../../../../src/background/stores/cache.ts";
import { createImportStore, type ImportRecord } from "../../../../src/background/stores/imports.ts";
import { createOverviewStore } from "../../../../src/background/stores/overviews.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import type { OverviewRecord } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoRef } from "../../../../src/core/video-ref.ts";
import { NAV_URL, PLAYER_URL, SUMMARY_URL, VIEW_URL } from "../../../../src/sites/bilibili/http.ts";
import { createBilibiliService } from "../../../../src/sites/bilibili/service.ts";
import { playerEnvelope } from "../../../helpers/bilibili-captions.ts";
import { fakeBackoff, fakeSite, siteCtx, type FakeSite, type Route } from "../../../helpers/bilibili-fetch.ts";
import { BVID, json, navLoggedIn, navLoggedOut, viewEnvelope } from "../../../helpers/bilibili-fixtures.ts";
import { deferred } from "../../../helpers/deferred.ts";
import { manualTimers, type ManualTimers } from "../../../helpers/manual-timers.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";
import { cachedRow, view } from "../../../helpers/transcript-service.ts";
import { until } from "../../../helpers/wait-until.ts";

type Row = CacheEntry<CachedTranscript>;

const OTHER = "BV1Sample002";
const A: VideoRef = { platform: "bilibili", videoId: BVID, segment: 1 };
const B: VideoRef = { platform: "bilibili", videoId: OTHER, segment: 1 };
const CIDS: Readonly<Record<string, number>> = { [BVID]: 2002, [OTHER]: 2003 };
const fileOf = (bvid: string): string => `https://i0.hdslb.com/bfs/subtitle/${bvid}.json`;
const trackOf = (bvid: string) => ({ lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: `//i0.hdslb.com/bfs/subtitle/${bvid}.json` });
const lineOf = (content: string) => json(200, { body: [{ from: 0, to: 1, content }] });
const summaryOf = (bvid: string) => json(200, { code: 0, message: "0", data: { code: 0, model_result: { summary: `${bvid} 的官方总结`, outline: [] } } });

/** 视频信息按请求的视频号回；字幕列表按请求的视频号列出它自己的字幕文件。 */
function routes(overrides: Readonly<Record<string, Route>> = {}): Record<string, Route> {
  return {
    [NAV_URL]: () => json(200, navLoggedIn()),
    [VIEW_URL]: ({ query }) => {
      const bvid = query.get("bvid") ?? "";
      const cid = CIDS[bvid] ?? 0;
      return json(200, viewEnvelope({ bvid, cid, pages: [{ page: 1, cid, part: `${bvid} 的标题`, duration: 120 }] }));
    },
    [PLAYER_URL]: ({ query }) => json(200, playerEnvelope([trackOf(query.get("bvid") ?? "")])),
    [SUMMARY_URL]: ({ query }) => summaryOf(query.get("bvid") ?? ""),
    [fileOf(BVID)]: () => lineOf("视频 A 的台词"),
    [fileOf(OTHER)]: () => lineOf("视频 B 的台词"),
    ...overrides,
  };
}

interface Rig {
  readonly fake: FakeSite;
  readonly timers: ManualTimers;
  readonly service: TranscriptService;
  readonly rows: () => Promise<Row[]>;
}

function rig(table: Readonly<Record<string, Route>>, seed: readonly Row[] = []): Rig {
  const fake = fakeSite(table);
  const timers = manualTimers(1_800_000_000_000);
  const guard = createClearGuard();
  const driver = createMemoryDriver<Row>("cache", seed);
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
    officialCaptionsFallback: false,
  });
  return { fake, timers, service, rows: () => driver.getAll() };
}

const contentCalls = (fake: FakeSite): string[] =>
  fake.requests.filter((request) => request.endpoint !== NAV_URL && request.endpoint !== VIEW_URL).map((request) => request.endpoint);

test("请求视频 A、视频信息返回的是视频 B：读取失败，A、B 都不写缓存，之后的列表、字幕文件、官方总结请求一个都不发", async () => {
  const { fake, service, rows } = rig(routes({ [VIEW_URL]: () => json(200, viewEnvelope({ bvid: OTHER, cid: 2003 })) }));

  const reply = await service.get(A, { mode: "full" });

  assert.equal(reply.ok, false);
  assert.equal(!reply.ok && reply.code, "MALFORMED");
  assert.deepEqual(contentCalls(fake), []);
  assert.equal(fake.calls(SUMMARY_URL).length, 0);
  assert.deepEqual(await rows(), []);
});

test("A 还在读时开始读 B：A 迟到的结果只写回 A，B 的记录不动", async () => {
  const held = deferred();
  const { fake, service, rows } = rig(routes({ [fileOf(BVID)]: () => held.promise.then(() => lineOf("视频 A 的台词")) }));

  const first = service.get(A, { mode: "full" });
  assert.ok(await until(() => fake.calls(fileOf(BVID)).length === 1), "A 停在下载字幕文件那一步");
  const second = view(await service.get(B, { mode: "full" }));
  assert.equal(second.transcript.cues[0]?.text, "视频 B 的台词");

  held.resolve();
  const late = view(await first);
  assert.equal(late.video, videoKey(A));
  assert.equal(late.transcript.cues[0]?.text, "视频 A 的台词");

  const stored = new Map((await rows()).map((row) => [row.videoKey, row.transcript?.cues[0]?.text]));
  assert.equal(stored.get(videoKey(A)), "视频 A 的台词");
  assert.equal(stored.get(videoKey(B)), "视频 B 的台词");
});

test("一次读取里字幕列表和官方总结请求带的视频号和媒体编号，等于这次读到的视频信息，不用缓存里记着的旧编号", async () => {
  const stale = cachedRow(undefined, { info: { ...cachedRow().info, mediaVersion: "9999" } }, A);
  const { fake, service } = rig(routes(), [stale]);

  const read = view(await service.get(A, { mode: "full", fresh: true }));

  const [listing] = fake.calls(PLAYER_URL);
  assert.ok(listing);
  assert.equal(listing.query.get("bvid"), BVID);
  assert.equal(listing.query.get("cid"), String(CIDS[BVID]));
  assert.equal(listing.query.get("aid"), "1001");
  const [summary, ...more] = fake.calls(SUMMARY_URL);
  assert.ok(summary);
  assert.deepEqual(more, [], "官方总结只问一次");
  assert.equal(summary.query.get("bvid"), BVID);
  assert.equal(summary.query.get("cid"), String(CIDS[BVID]));
  assert.equal(read.official?.summary, `${BVID} 的官方总结`);
  assert.deepEqual(fake.calls(fileOf(BVID)).length, 1, "字幕文件按这次列表给的地址取");
});

test("没有字幕的视频：列轨和读 UP 主分段只发一次列表请求，空列表报没有字幕", async () => {
  const { fake, service } = rig(routes({ [PLAYER_URL]: () => json(200, playerEnvelope([])) }));
  const reply = await service.get(A, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "NO_CAPTIONS");
  assert.equal(fake.calls(PLAYER_URL).length, 1);

  await service.get(A, { mode: "full" });
  assert.equal(fake.calls(PLAYER_URL).length, 2, "空列表不进记录，下一次照常重问");
});

test("登录检查按需发：空闲时时钟推过一小时，一个请求都不发", async () => {
  const { fake, service, timers } = rig(routes());
  timers.advance(60 * 60 * 1000);
  assert.deepEqual(fake.requests, []);

  await service.get(A, { mode: "full" });
  const before = fake.requests.length;
  timers.advance(60 * 60 * 1000);
  assert.equal(fake.requests.length, before);
});

test("没登录时：命中缓存一个请求都不发，连登录检查都不发；没缓存只问一次登录，不读任何内容", async () => {
  const loggedOut = routes({ [NAV_URL]: () => json(200, navLoggedOut()) });
  const cached = rig(loggedOut, [cachedRow(undefined, {}, A)]);
  assert.equal(view(await cached.service.get(A, { mode: "full" })).fromCache, true);
  assert.deepEqual(cached.fake.requests, []);

  const empty = rig(loggedOut);
  const reply = await empty.service.get(A, { mode: "full" });
  assert.equal(!reply.ok && reply.code, "NEED_LOGIN");
  assert.deepEqual(empty.fake.requests.map((request) => request.endpoint), [NAV_URL]);
});

test("没登录时命中缓存、官方总结过了重问时间：后台重问只问一次登录，不读官方总结，记成要登录", async () => {
  const stale = { status: "queued", summary: "", outline: [], hasCaptions: false, fetchedAt: 1_800_000_000_000 - 11 * 60_000 } as const;
  const { fake, service, rows } = rig(routes({ [NAV_URL]: () => json(200, navLoggedOut()) }), [cachedRow(undefined, { official: stale }, A)]);

  const reply = view(await service.get(A, { mode: "full" }));
  assert.equal(reply.fromCache, true);
  assert.equal(reply.official?.status, "queued", "先交缓存里的");
  assert.ok(await until(async () => (await rows())[0]?.official?.status === "need-login"), "重问的结果写回缓存");
  assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL]);
});
