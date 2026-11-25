// YouTube 读取服务：不发请求，只经页面通道问文字稿面板。看快照核对、视频归属、面板状态到错误码的对应、
// 交回正文前的复核，以及轨的名字、语言和来源。页面通道用替身，样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PageChannel, SiteCtx, SiteResult } from "../../../../src/sites/types.ts";
import { panelSnapshotOf, playerTracksOf, type PanelSnapshot, type PlayerTrack, type PlayerTracks } from "../../../../src/sites/youtube/page/panel-types.ts";
import { createYoutubeService, cuesOf, langOfLabel, langOfText, panelTrackOf, scriptFits, trackOfLabel, trackOfPanel } from "../../../../src/sites/youtube/service.ts";

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
  player: null,
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

test("面板几种状态各有各的结果；认不出的都是暂时无法读取（读播放器字幕关着时）", async () => {
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
    const service = createYoutubeService({ caughtCaptions: null });
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

test("新式面板没有语言名、也问不到播放器的轨：来源记未确认，语言按正文的文字认中文、日文、韩文，别的不猜", async () => {
  assert.equal(langOfText(["今天我们来讲一讲神经网络", "第二句"]), "zh");
  assert.equal(langOfText(["これはテストです"]), "ja");
  assert.equal(langOfText(["안녕하세요 여러분"]), "ko");
  assert.equal(langOfText(["sample line one", "sample line two"]), "und");
  assert.equal(langOfText([]), "und");
  const service = createYoutubeService();
  const { ctx } = ctxWith(() => snapshotOf({ label: "", cues: [{ start: 0, text: "今天讲神经网络" }] }));
  const info = okValue(await service.readVideoInfo(REF, ctx));
  assert.deepEqual(okValue(await service.listCaptionTracks(info, ctx)), [
    { trackId: "panel:YouTube 文字稿（来源未确认）", lang: "zh", label: "YouTube 文字稿（来源未确认）", kind: "unconfirmed" },
  ]);
});

const HUMAN_EN: PlayerTrack = { lang: "en", kind: "", name: "English", vssId: ".en" };
const AUTO_EN: PlayerTrack = { lang: "en", kind: "asr", name: "English (auto-generated)", vssId: "a.en" };
const AUTO_JA: PlayerTrack = { lang: "ja", kind: "asr", name: "Japanese (auto-generated)", vssId: "a.ja" };
const HUMAN_ZH: PlayerTrack = { lang: "zh-CN", kind: "", name: "Chinese (China)", vssId: ".zh-CN" };
const playerOf = (tracks: readonly PlayerTrack[], defaultIndex: number | null = null, overrides: Partial<PlayerTracks> = {}): PlayerTracks => ({
  videoId: ID,
  tracks,
  defaultIndex,
  hasDefault: defaultIndex === null ? null : true,
  ...overrides,
});
const ENGLISH = ["sample line one", "sample line two"];
const newPanel = (player: PlayerTracks | null, texts: readonly string[] = ENGLISH): PanelSnapshot =>
  snapshotOf({ label: "", cues: texts.map((text, index) => ({ start: index * 4, text })), player });

test("新式面板判定是哪条轨：只有一条轨就是它，有默认轨就是默认轨，用轨的语言、来源和显示名", async () => {
  assert.deepEqual(trackOfPanel(newPanel(playerOf([HUMAN_EN, AUTO_EN], 1))), { trackId: "panel:English (auto-generated)", lang: "en", label: "English (auto-generated)", kind: "auto" });
  assert.deepEqual(trackOfPanel(newPanel(playerOf([AUTO_EN, HUMAN_EN], 1))), { trackId: "panel:English", lang: "en", label: "English", kind: "human" });
  assert.deepEqual(trackOfPanel(newPanel(playerOf([AUTO_JA]), ["これは自造の字幕です", "二つ目の文です"])), {
    trackId: "panel:Japanese (auto-generated)",
    lang: "ja",
    label: "Japanese (auto-generated)",
    kind: "auto",
  });
  assert.deepEqual(trackOfPanel(newPanel(playerOf([HUMAN_ZH]), ["今天讲一讲自造的例子", "第二句话"])).kind, "human");
  // 读取的整条路：列出来的轨和交回正文时核对的轨是同一条。
  const service = createYoutubeService();
  const snapshot = newPanel(playerOf([HUMAN_EN, AUTO_EN], 1));
  const { ctx } = ctxWith((message) => (message.type === "youtube.current" ? { videoId: ID, stamp: snapshot.stamp, label: "" } : snapshot));
  const info = okValue(await service.readVideoInfo(REF, ctx));
  const [track] = okValue(await service.listCaptionTracks(info, ctx));
  assert.equal(track?.kind, "auto");
  assert.ok(track && okValue(await service.readCaptions(info, track, ctx)).length === 2);
});

test("新式面板判定不了就记来源未确认，不猜：视频对不上、多条轨没有默认轨、默认轨被标成没有、没有轨、文字和语言对不上", () => {
  const unconfirmed = (snapshot: PanelSnapshot): void => {
    const track = trackOfPanel(snapshot);
    assert.equal(track.kind, "unconfirmed", JSON.stringify(snapshot.player));
    assert.equal(track.label, "YouTube 文字稿（来源未确认）");
  };
  unconfirmed(newPanel(playerOf([AUTO_EN], null, { videoId: OTHER })));
  unconfirmed(newPanel(playerOf([HUMAN_EN, AUTO_EN])));
  unconfirmed(newPanel(playerOf([HUMAN_EN, AUTO_EN], 0, { hasDefault: false })));
  unconfirmed(newPanel(playerOf([])));
  unconfirmed(newPanel(playerOf([HUMAN_ZH])));
  unconfirmed(newPanel(playerOf([HUMAN_EN]), ["今天讲一讲自造的例子", "第二句话"]));
  unconfirmed(newPanel(playerOf([{ ...AUTO_EN, lang: "" }])));
  // 判定不了时语言照旧按正文的文字认。
  assert.equal(trackOfPanel(newPanel(playerOf([HUMAN_EN, AUTO_EN]), ["안녕하세요 여러분"])).lang, "ko");
});

test("文字核对：中日韩的轨要有对应的文字，别的语言的轨正文不能大半是中日韩文字", () => {
  assert.ok(scriptFits("zh-Hans", ["今天讲一讲"]));
  assert.ok(scriptFits("ja", ["これは自造の字幕です"]));
  assert.ok(scriptFits("ko", ["안녕하세요"]));
  assert.ok(scriptFits("en", ["sample line"]));
  assert.ok(!scriptFits("zh", ["sample line"]));
  assert.ok(!scriptFits("ko", ["今天讲一讲"]));
  assert.ok(!scriptFits("fr", ["これは自造の字幕です"]));
  assert.ok(!scriptFits("en", []));
  assert.equal(panelTrackOf(null, ID, ENGLISH), null);
});

test("旧面板有语言菜单：名字在播放器的轨里只对上一条就用那条的来源和语言，对不上照旧按名字认", () => {
  const custom: PlayerTrack = { lang: "en", kind: "asr", name: "Sample (machine)", vssId: "a.en" };
  const withLabel = (label: string, player: PlayerTracks | null): PanelSnapshot => snapshotOf({ label, player });
  assert.deepEqual(trackOfPanel(withLabel("Sample (machine)", playerOf([HUMAN_EN, custom]))), { trackId: "panel:Sample (machine)", lang: "en", label: "Sample (machine)", kind: "auto" });
  assert.equal(trackOfPanel(withLabel("Sample (machine)", playerOf([custom], null, { videoId: OTHER }))).kind, "human");
  assert.equal(trackOfPanel(withLabel("Sample (machine)", playerOf([custom, custom]))).kind, "human");
  assert.deepEqual(trackOfPanel(withLabel("English (auto-generated)", null)), trackOfLabel("English (auto-generated)"));
});

test("小桥交回的字幕轨列表按不可信输入核对：不对就当没问到，快照照常能用", () => {
  const good = playerOf([HUMAN_EN, AUTO_EN], 1);
  assert.deepEqual(playerTracksOf(good), good);
  const bad: unknown[] = [
    null,
    { ...good, videoId: "" },
    { ...good, videoId: "jm/Sample" },
    { ...good, tracks: "English" },
    { ...good, tracks: Array.from({ length: 201 }, () => HUMAN_EN) },
    { ...good, defaultIndex: 2 },
    { ...good, defaultIndex: -1 },
    { ...good, hasDefault: "yes" },
    { ...good, tracks: [{ ...HUMAN_EN, lang: "en us" }] },
    { ...good, tracks: [{ ...HUMAN_EN, name: "长".repeat(201) }] },
    { ...good, tracks: [{ ...HUMAN_EN, vssId: 3 }] },
  ];
  for (const value of bad) assert.equal(playerTracksOf(value), null, JSON.stringify(value)?.slice(0, 80));
  const snapshot = panelSnapshotOf({ ...snapshotOf(), player: { ...good, defaultIndex: 9 } });
  assert.equal(snapshot?.player, null);
  assert.equal(snapshot?.cues.length, 2);
});

// ============================================================
// 卡片问有没有字幕：只问页面播放器上已有的字幕轨列表
// ============================================================

const tracksAnswer = (player: unknown, videoId = ID): unknown => ({ videoId, player });
const playableNone = (): PlayerTracks => playerOf([], null, { playable: true });

test("卡片问有没有字幕：页面是这个视频、播放器能正常播、字幕轨列表是空的，才算确定没有字幕；只问一句，不读面板", async () => {
  const service = createYoutubeService();
  const { ctx, asked } = ctxWith(() => tracksAnswer(playableNone()));
  assert.equal(await service.knownNoCaptions?.(REF, ctx), true);
  assert.deepEqual(asked, ["youtube.tracks"]);
});

test("卡片问有没有字幕：有字幕轨、视频对不上、播放器没说能播、回答不对、没问到字幕轨，都当判断不了", async () => {
  const service = createYoutubeService();
  const answers: unknown[] = [
    tracksAnswer(playerOf([AUTO_EN], null, { playable: true })),
    tracksAnswer(playableNone(), OTHER),
    tracksAnswer(playableNone(), ""),
    tracksAnswer(playerOf([], null, { playable: true, videoId: OTHER })),
    tracksAnswer(playerOf([], null, { playable: false })),
    tracksAnswer(playerOf([])),
    tracksAnswer(null),
    tracksAnswer({ ...playableNone(), playable: "OK" }),
    tracksAnswer(playableNone(), "jm/Sample"),
    { player: playableNone() },
    "没有字幕",
    null,
    undefined,
  ];
  for (const answer of answers) {
    const { ctx } = ctxWith(() => answer);
    assert.equal(await service.knownNoCaptions?.(REF, ctx), false, JSON.stringify(answer)?.slice(0, 120));
  }
});

test("卡片问有没有字幕：没有页面通道、送不到、等不到回话，都当判断不了", async () => {
  const service = createYoutubeService({ askTimeoutMs: 20 });
  const { ctx } = ctxWith(() => tracksAnswer(playableNone()));
  const { page: _page, ...noPage } = ctx;
  assert.equal(await service.knownNoCaptions?.(REF, noPage), false);
  const unreachable: PageChannel = { ask: () => Promise.reject(new Error("送不到")) };
  assert.equal(await service.knownNoCaptions?.(REF, { ...ctx, page: unreachable }), false);
  const silent: PageChannel = { ask: (_message, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("超时")), { once: true })) };
  assert.equal(await service.knownNoCaptions?.(REF, { ...ctx, page: silent }), false);
});

test("小桥带的能不能正常播只认真假：没带时照常能用，别的写法整份不用", () => {
  const base = playerOf([HUMAN_EN]);
  assert.deepEqual(playerTracksOf(base), base);
  assert.deepEqual(playerTracksOf({ ...base, playable: true }), { ...base, playable: true });
  assert.deepEqual(playerTracksOf({ ...base, playable: false }), { ...base, playable: false });
  for (const playable of ["OK", 1, null]) assert.equal(playerTracksOf({ ...base, playable }), null, String(playable));
});
