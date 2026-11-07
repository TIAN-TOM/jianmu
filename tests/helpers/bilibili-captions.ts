// 字幕读取测试共用的样例和搭架子的函数，样例全部自造。
import { createCaptions, type Captions } from "../../src/sites/bilibili/captions.ts";
import { createBiliHttp, NAV_URL, type BiliHttp } from "../../src/sites/bilibili/http.ts";
import type { SiteCtx, VideoInfo } from "../../src/sites/types.ts";
import { fakeBackoff, fakeSite, siteCtx, testClock, type FakeBackoff, type FakeSite, type Route } from "./bilibili-fetch.ts";
import { BVID, json, navLoggedIn } from "./bilibili-fixtures.ts";

export const INFO: VideoInfo = {
  ref: { platform: "bilibili", videoId: BVID, segment: 1 },
  title: "样例视频",
  author: "样例作者",
  channel: { platform: "bilibili", channelId: "3003" },
  description: "样例简介",
  durationSec: 120,
  mediaVersion: "2002",
  siteRef: "1001",
  segments: [{ index: 1, title: "样例视频", durationSec: 120 }],
};

export const ZH_FILE = "https://i0.hdslb.com/bfs/subtitle/zh.json";
export const EN_FILE = "https://i0.hdslb.com/bfs/subtitle/en.json";

export const ZH_TRACK = { lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//i0.hdslb.com/bfs/subtitle/zh.json" };
export const EN_TRACK = { lan: "en-US", lan_doc: "英语", subtitle_url: "//i0.hdslb.com/bfs/subtitle/en.json" };

export function playerEnvelope(subtitles: readonly unknown[], extra: Record<string, unknown> = {}): unknown {
  return { code: 0, data: { subtitle: { subtitles }, ...extra } };
}

/** 回一份字幕列表。 */
export const listing =
  (...subtitles: readonly unknown[]): Route =>
  () =>
    json(200, playerEnvelope(subtitles));

/** 回一份只有一行的字幕正文。 */
export const oneLine =
  (content = "样例台词"): Route =>
  () =>
    json(200, { body: [{ from: 0, to: 1, content }] });

export interface Rig {
  readonly clock: { at: number; now: () => number };
  readonly fake: FakeSite;
  readonly backoff: FakeBackoff;
  readonly http: BiliHttp;
  readonly captions: Captions;
  readonly ctx: SiteCtx;
}

/** 账号接口默认回已登录，其余地址按传入的路由回，没配的抛错。 */
export function rig(routes: Readonly<Record<string, Route>>, options: { requestTimeoutMs?: number } = {}): Rig {
  const clock = testClock();
  const fake = fakeSite({ [NAV_URL]: () => json(200, navLoggedIn()), ...routes });
  const backoff = fakeBackoff();
  const http = createBiliHttp({ now: clock.now, ...options });
  return { clock, fake, backoff, http, captions: createCaptions(http, { now: clock.now }), ctx: siteCtx(fake, backoff) };
}
