// 页面上没有文字稿时改读播放器取回的字幕：只在面板报没有入口时走，一次读取只走一回；核对归属、形状和时长；
// 轨按播放器的列表认，认不出标来源未确认；机器翻译的也用，语言标成译成的那种；交回正文前再核对一次页面上的视频。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PageChannel, SiteCtx, SiteResult } from "../../../../src/sites/types.ts";
import type { PanelSnapshot, PlayerTracks } from "../../../../src/sites/youtube/page/panel-types.ts";
import { readCaughtCaptions, trackOfCaption } from "../../../../src/sites/youtube/player-fallback.ts";
import { createYoutubeService } from "../../../../src/sites/youtube/service.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const REF: VideoRef = { platform: "youtube", videoId: ID };
const INFO = { title: "自造的标题", author: "自造频道", channelId: null, description: "自造的简介", durationSec: 120 };

const BODY = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 100000, id: 1 },
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "sample" }, { utf8: " line one" }] },
    { tStartMs: 2500, segs: [{ utf8: "\n" }] },
    { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: "sample line two" }] },
  ],
});
const TRACKS: PlayerTracks = {
  videoId: ID,
  tracks: [
    { lang: "en", kind: "", name: "English", vssId: ".en" },
    { lang: "en", kind: "asr", name: "English (auto-generated)", vssId: "a.en" },
  ],
  defaultIndex: 0,
  hasDefault: true,
};
const caption = (overrides: Record<string, unknown> = {}) => ({ videoId: ID, lang: "en", auto: false, translated: false, targetLang: "", text: BODY, ...overrides });
const caught = (overrides: Record<string, unknown> = {}, player: unknown = TRACKS) => ({ outcome: "caught", caption: caption(overrides), player });

const noEntry = (overrides: Partial<PanelSnapshot> = {}): PanelSnapshot => ({ videoId: ID, state: "no-entry", stamp: 0, label: "", cues: [], info: INFO, player: null, ...overrides });

function ctxWith(answers: { panel?: unknown; captions?: unknown; current?: unknown }): { ctx: SiteCtx; asked: string[] } {
  const asked: string[] = [];
  const page: PageChannel = {
    async ask(message) {
      const { type } = message as { type: string };
      asked.push(type);
      if (type === "youtube.panel") return answers.panel ?? noEntry();
      if (type === "youtube.caughtCaptions") return answers.captions;
      return answers.current ?? { videoId: ID, stamp: 0, label: "" };
    },
  };
  const ctx: SiteCtx = {
    fetch: () => Promise.reject(new Error("YouTube 读取不该发请求")),
    signal: new AbortController().signal,
    page,
    backoff: { admit: async () => ({ ok: true }), trip: async () => {}, clear: async () => {} },
  };
  return { ctx, asked };
}

const okValue = <T>(result: SiteResult<T>): T => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

async function readAll(answers: Parameters<typeof ctxWith>[0]) {
  const service = createYoutubeService();
  const { ctx, asked } = ctxWith(answers);
  const info = okValue(await service.readVideoInfo(REF, ctx));
  const listed = await service.listCaptionTracks(info, ctx);
  if (!listed.ok) return { listed, asked };
  const [track] = listed.value;
  assert.ok(track);
  return { listed, track, cues: await service.readCaptions(info, track, ctx), asked, again: await service.listCaptionTracks(info, ctx, { fresh: true }) };
}

test("面板报没有入口：改问播放器取回的字幕，按播放器的轨标人工英文，交回前再核对一次页面上的视频", async () => {
  const { track, cues, asked, again } = await readAll({ captions: caught() });
  assert.deepEqual(track, { trackId: "panel:English", lang: "en", label: "English", kind: "human" });
  assert.deepEqual(okValue(cues!), [
    { start: 1, duration: 3, text: "sample line one" },
    { start: 4, duration: 5, text: "sample line two" },
  ]);
  assert.deepEqual(again, { ok: true, value: [track] }, "重新列轨不再去点");
  assert.deepEqual(asked, ["youtube.panel", "youtube.caughtCaptions", "youtube.current", "youtube.panel"]);
});

test("机器翻译的照用：语言标成译成的那种，来源记未确认", async () => {
  const { track, cues } = await readAll({ captions: caught({ translated: true, targetLang: "fr" }) });
  assert.deepEqual(track, { trackId: "panel:YouTube 文字稿（来源未确认）", lang: "fr", label: "YouTube 文字稿（来源未确认）", kind: "unconfirmed" });
  assert.equal(okValue(cues!).length, 2);
});

test("播放器的轨对不上：来源未确认，语言按正文认，不猜", async () => {
  const { track } = await readAll({ captions: caught({ lang: "de" }) });
  assert.deepEqual(track, { trackId: "panel:YouTube 文字稿（来源未确认）", lang: "und", label: "YouTube 文字稿（来源未确认）", kind: "unconfirmed" });
  assert.equal(trackOfCaption({ ...TRACKS, videoId: OTHER }, caption() as never), null, "列表不是这个视频的");
  assert.deepEqual(trackOfCaption(TRACKS, caption({ auto: true }) as never)?.kind, "asr");
  assert.equal(trackOfCaption({ ...TRACKS, tracks: [...TRACKS.tracks, ...TRACKS.tracks] }, caption() as never), null, "对上不止一条");
});

test("没接住、开着没接住、在播广告、视频换了、回答不对：各有各的结果，正文一句都不交", async () => {
  const table = [
    [{ outcome: "not-caught", caption: null, player: null }, { ok: false, code: "UNAVAILABLE", detail: "player-none" }],
    [{ outcome: "no-button", caption: null, player: null }, { ok: false, code: "UNAVAILABLE", detail: "player-none" }],
    [{ outcome: "on-missed", caption: null, player: null }, { ok: false, code: "UNAVAILABLE", detail: "player-missed" }],
    [{ outcome: "ad", caption: null, player: null }, { ok: false, code: "PAGE_ACTION_NEEDED", detail: "ad" }],
    [{ outcome: "video-changed", caption: null, player: null }, { ok: false, code: "VIDEO_CHANGED" }],
    [caught({ videoId: OTHER }), { ok: false, code: "VIDEO_CHANGED" }],
    [{ outcome: "caught", caption: null, player: null }, { ok: false, code: "MALFORMED", reach: "item", detail: "player-reply" }],
    [{ outcome: "not-caught", caption: caption(), player: null }, { ok: false, code: "MALFORMED", reach: "item", detail: "player-reply" }],
    [caught({ text: "不是 JSON" }), { ok: false, code: "MALFORMED", reach: "item", detail: "player-captions" }],
    [caught({ text: JSON.stringify({ events: [{ tStartMs: 200000, segs: [{ utf8: "too late" }] }] }) }), { ok: false, code: "MALFORMED", reach: "item", detail: "player-duration" }],
  ] as const;
  for (const [captions, expected] of table) {
    const { listed } = await readAll({ captions });
    assert.deepEqual(listed, expected, JSON.stringify(captions).slice(0, 80));
  }
});

test("交回正文前页面上已经换了视频：不交", async () => {
  const { cues } = await readAll({ captions: caught(), current: { videoId: OTHER, stamp: 0, label: "" } });
  assert.deepEqual(cues, { ok: false, code: "VIDEO_CHANGED" });
});

test("只在面板报没有入口时走：面板关着、在加载都不问播放器；开关关着时照旧报没有入口", async () => {
  for (const state of ["closed", "loading"] as const) {
    const { asked } = await readAll({ panel: noEntry({ state }), captions: caught() });
    assert.ok(!asked.includes("youtube.caughtCaptions"), state);
  }
  const service = createYoutubeService({ caughtCaptions: null });
  const { ctx, asked } = ctxWith({ captions: caught() });
  const info = okValue(await service.readVideoInfo(REF, ctx));
  assert.deepEqual(await service.listCaptionTracks(info, ctx), { ok: false, code: "UNAVAILABLE", detail: "no-entry" });
  assert.deepEqual(asked, ["youtube.panel"]);
});

test("后备本身只问一句：时长读不到时不卡最后一句", async () => {
  const late = JSON.stringify({ events: [{ tStartMs: 500000, segs: [{ utf8: "late" }] }] });
  const asked: unknown[] = [];
  const read = await readCaughtCaptions({ videoId: ID, durationSec: 0, ask: async (message) => (asked.push(message), { ok: true, answer: caught({ text: late }) }) });
  assert.deepEqual(okValue(read).lines, [{ start: 500, text: "late" }]);
  assert.deepEqual(asked, [{ type: "youtube.caughtCaptions", req: { videoId: ID } }]);
});
