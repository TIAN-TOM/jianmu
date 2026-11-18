// YouTube 读取服务：不发请求，只经页面通道问文字稿面板。看快照核对、视频归属、面板状态到错误码的对应、
// 交回正文前的复核，以及轨的名字、语言和来源。页面通道用替身，样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PageChannel, SiteCtx, SiteResult } from "../../../../src/sites/types.ts";
import { panelSnapshotOf, type PanelSnapshot } from "../../../../src/sites/youtube/page/panel-types.ts";
import { createYoutubeService, cuesOf, langOfLabel, langOfText, trackOfLabel } from "../../../../src/sites/youtube/service.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const REF: VideoRef = { platform: "youtube", videoId: ID };
const INFO = { title: "自造的标题", author: "自造频道", channelId: "UCsample0000000000000001", description: "自造的简介", durationSec: 120 };

const snapshotOf = (overrides: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  videoId: ID,
  state: "ready",
  stamp: 3,
  label: "English (auto-generated)",
  cues: [
    { start: 0, text: "第一句" },
    { start: 4, text: "第二句" },
  ],
  info: INFO,
  ...overrides,
});

function ctxWith(answer: (message: { type: string; req: { videoId: string } }) => unknown): { ctx: SiteCtx; asked: string[] } {
  const asked: string[] = [];
  const page: PageChannel = {
    async ask(message) {
      const typed = message as { type: string; req: { videoId: string } };
      asked.push(typed.type);
      return answer(typed);
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

test("读到面板：视频信息、一条轨、正文，时长按下一句算，最后一句按剩下的时间；交回正文前复核一次", async () => {
  const service = createYoutubeService();
  const { ctx, asked } = ctxWith((message) => (message.type === "youtube.current" ? { videoId: ID, stamp: 3, label: "English (auto-generated)" } : snapshotOf()));
  const info = okValue(await service.readVideoInfo(REF, ctx));
  assert.deepEqual(info, { ref: REF, title: INFO.title, author: INFO.author, description: INFO.description, durationSec: 120, channel: { platform: "youtube", channelId: INFO.channelId } });
  const [track, ...rest] = okValue(await service.listCaptionTracks(info, ctx));
  assert.ok(track);
  assert.deepEqual(rest, []);
  assert.deepEqual(track, { trackId: "panel:English (auto-generated)", lang: "en", label: "English (auto-generated)", kind: "auto" });
  assert.deepEqual(okValue(await service.readCaptions(info, track, ctx)), [
    { start: 0, duration: 4, text: "第一句" },
    { start: 4, duration: 5, text: "第二句" },
  ]);
  assert.deepEqual(asked, ["youtube.panel", "youtube.current"], "列轨用这次读取里问到的那份");
});

test("页面上已经不是这个视频、或者认不出是哪个视频：按视频已换，什么都不交", async () => {
  for (const videoId of [OTHER, ""]) {
    const { ctx } = ctxWith(() => snapshotOf({ videoId }));
    assert.deepEqual(await createYoutubeService().readVideoInfo(REF, ctx), { ok: false, code: "VIDEO_CHANGED" }, videoId);
  }
});

test("交回正文前面板换过内容或换了视频：不交", async () => {
  for (const [current, expected] of [
    [{ videoId: ID, stamp: 4, label: "English (auto-generated)" }, { ok: false, code: "UNAVAILABLE", detail: "stale" }],
    [{ videoId: ID, stamp: 3, label: "Español" }, { ok: false, code: "UNAVAILABLE", detail: "stale" }],
    [{ videoId: OTHER, stamp: 3, label: "English (auto-generated)" }, { ok: false, code: "VIDEO_CHANGED" }],
  ] as const) {
    const service = createYoutubeService();
    const { ctx } = ctxWith((message) => (message.type === "youtube.current" ? current : snapshotOf()));
    const info = okValue(await service.readVideoInfo(REF, ctx));
    const [track] = okValue(await service.listCaptionTracks(info, ctx));
    assert.ok(track);
    assert.deepEqual(await service.readCaptions(info, track, ctx), expected);
  }
});

test("面板几种状态各有各的结果；认不出的都是暂时无法读取", async () => {
  const table = [
    ["closed", { ok: false, code: "PAGE_ACTION_NEEDED" }],
    ["reopen", { ok: false, code: "PAGE_ACTION_NEEDED", detail: "reopen" }],
    ["stale", { ok: false, code: "UNAVAILABLE", detail: "stale" }],
    ["no-entry", { ok: false, code: "UNAVAILABLE", detail: "no-entry" }],
    ["loading", { ok: false, code: "UNAVAILABLE" }],
    ["filtered", { ok: false, code: "PAGE_ACTION_NEEDED", detail: "filtered" }],
    ["chapters", { ok: false, code: "PAGE_ACTION_NEEDED", detail: "chapters" }],
  ] as const;
  for (const [state, expected] of table) {
    const service = createYoutubeService();
    const { ctx } = ctxWith(() => snapshotOf({ state, cues: [] }));
    const info = okValue(await service.readVideoInfo(REF, ctx));
    assert.deepEqual(await service.listCaptionTracks(info, ctx), expected, state);
  }
});

test("没有页面通道、页面不回话、回的东西形状不对：分开报，不发请求", async () => {
  const service = createYoutubeService();
  const { ctx } = ctxWith(() => snapshotOf());
  const { page: _page, ...noPage } = ctx;
  assert.deepEqual(await service.readVideoInfo(REF, noPage), { ok: false, code: "UNAVAILABLE", detail: "no-page" });
  const silent = ctxWith(() => {
    throw new Error("Could not establish connection");
  });
  assert.deepEqual(await service.readVideoInfo(REF, silent.ctx), { ok: false, code: "UNAVAILABLE", detail: "no-page" });
  // 内容脚本在但没回话（还没过启用闸门）：也按连不上视频页，不说网站改版。
  const quiet = ctxWith(() => undefined);
  assert.deepEqual(await service.readVideoInfo(REF, quiet.ctx), { ok: false, code: "UNAVAILABLE", detail: "no-page" });
  const odd = ctxWith(() => ({ ...snapshotOf(), cues: "不是列表" }));
  assert.deepEqual(await service.readVideoInfo(REF, odd.ctx), { ok: false, code: "MALFORMED", reach: "item", detail: "panel-shape" });
});

test("页面一直不回话：到点报超时，不说连不上", async () => {
  const page: PageChannel = {
    ask: (_message, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  };
  const { ctx } = ctxWith(() => snapshotOf());
  assert.deepEqual(await createYoutubeService({ askTimeoutMs: 20 }).readVideoInfo(REF, { ...ctx, page }), { ok: false, code: "TIMEOUT" });
});

test("快照的字数合计有上限，和导入字幕文件对齐", () => {
  const cues = Array.from({ length: 1001 }, (_, index) => ({ start: index, text: "长".repeat(2000) }));
  assert.equal(panelSnapshotOf({ ...snapshotOf(), cues }), null);
});

test("面板里换了语言：交回正文时轨对不上就不交", async () => {
  const service = createYoutubeService();
  const { ctx } = ctxWith((message) => (message.type === "youtube.current" ? { videoId: ID, stamp: 3, label: "English (auto-generated)" } : snapshotOf()));
  const info = okValue(await service.readVideoInfo(REF, ctx));
  assert.deepEqual(await service.readCaptions(info, trackOfLabel("Deutsch"), ctx), { ok: false, code: "UNAVAILABLE", detail: "stale" });
});

test("轨的语言按菜单名认，认不出不猜；带自动生成标记的才算自动字幕", () => {
  assert.equal(langOfLabel("English"), "en");
  assert.equal(langOfLabel("English (auto-generated)"), "en");
  assert.equal(langOfLabel("英语（自动生成）"), "en");
  assert.equal(langOfLabel("日本語"), "ja");
  assert.equal(langOfLabel("自造的语言名"), "und");
  assert.equal(trackOfLabel("英语（自动生成）").kind, "auto");
  assert.equal(trackOfLabel("English").kind, "human");
  assert.deepEqual(trackOfLabel(""), { trackId: "panel:YouTube 文字稿", lang: "und", label: "YouTube 文字稿", kind: "human" });
});

test("快照核对：大小、类型、时间往后走、状态和内容对得上", () => {
  assert.ok(panelSnapshotOf(snapshotOf()));
  const bad: unknown[] = [
    null,
    { ...snapshotOf(), videoId: "jm/Sample" },
    { ...snapshotOf(), state: "open" },
    { ...snapshotOf(), stamp: -1 },
    { ...snapshotOf(), state: "closed" },
    { ...snapshotOf(), cues: [] },
    { ...snapshotOf(), cues: [{ start: 5, text: "后" }, { start: 1, text: "前" }] },
    { ...snapshotOf(), cues: [{ start: Number.NaN, text: "一句" }] },
    { ...snapshotOf(), cues: [{ start: 1, text: "长".repeat(2001) }] },
    { ...snapshotOf(), info: { ...INFO, description: "长".repeat(5001) } },
    { ...snapshotOf(), info: { ...INFO, durationSec: -1 } },
    { ...snapshotOf(), label: 3 },
  ];
  for (const value of bad) assert.equal(panelSnapshotOf(value), null, JSON.stringify(value)?.slice(0, 80));
});

test("时长：没有视频时长时最后一句按 5 秒", () => {
  assert.deepEqual(cuesOf(snapshotOf({ info: { ...INFO, durationSec: 0 } })).at(-1), { start: 4, duration: 5, text: "第二句" });
});

test("新式面板没有语言名：按正文的文字认中文、日文、韩文，别的不猜；轨的名字照旧写成 YouTube 文字稿", async () => {
  assert.equal(langOfText(["今天我们来讲一讲神经网络", "第二句"]), "zh");
  assert.equal(langOfText(["これはテストです"]), "ja");
  assert.equal(langOfText(["안녕하세요 여러분"]), "ko");
  assert.equal(langOfText(["sample line one", "sample line two"]), "und");
  assert.equal(langOfText([]), "und");
  const service = createYoutubeService();
  const { ctx } = ctxWith(() => snapshotOf({ label: "", cues: [{ start: 0, text: "今天讲神经网络" }] }));
  const info = okValue(await service.readVideoInfo(REF, ctx));
  assert.deepEqual(okValue(await service.listCaptionTracks(info, ctx)), [{ trackId: "panel:YouTube 文字稿", lang: "zh", label: "YouTube 文字稿", kind: "human" }]);
});
