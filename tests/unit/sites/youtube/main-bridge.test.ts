// 主世界的小桥和内容脚本的问话：页面用一个事件目标加一个播放器替身代替，两头在同一个事件目标上一问一答。
// 看交回的字段只有那几样、读不到时的样子、新注入的一份叫停旧的，以及内容脚本只认带着自己标记的、形状对的回答。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { INJECTED } from "../../../../src/shared/names.ts";
import { readPlayerTracks, startMainBridge } from "../../../../src/sites/youtube/page/main-bridge.ts";
import { askPlayerTracks } from "../../../../src/sites/youtube/page/player-tracks.ts";

const ID = "jmSample0001";
const TOKEN = "jm-sample-token-0001";

/** 自造的播放器数据：能正常播，两条轨，默认音轨里默认第二条。另带几样小桥不该交的字段。 */
const RESPONSE = {
  playabilityStatus: { status: "OK", reason: "不该交的说明" },
  videoDetails: { videoId: ID, title: "不该交的标题" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://example.invalid/sample", name: { simpleText: "English" }, vssId: ".en", languageCode: "en", isTranslatable: true },
        { baseUrl: "https://example.invalid/sample-auto", name: { runs: [{ text: "English " }, { text: "(auto-generated)" }] }, vssId: "a.en", languageCode: "en", kind: "asr" },
      ],
      audioTracks: [{ captionTrackIndices: [0, 1], defaultCaptionTrackIndex: 1, hasDefaultTrack: true }],
      defaultAudioTrackIndex: 0,
      translationLanguages: [{ languageCode: "fr" }],
    },
  },
};

function pageWith(response: unknown): EventTarget & { getElementById: (id: string) => unknown; calls: string[] } {
  const calls: string[] = [];
  const player = {
    getPlayerResponse() {
      calls.push("getPlayerResponse");
      return response;
    },
    setOption() {
      calls.push("setOption");
    },
  };
  return Object.assign(new EventTarget(), { calls, getElementById: (id: string) => (id === "movie_player" ? player : null) });
}

test("小桥只交视频编号、每条轨的语言、类别、显示名和编号、默认轨，以及能不能正常播；不交字幕地址，不碰会改播放器的方法", () => {
  const page = pageWith(RESPONSE);
  const tracks = readPlayerTracks(page as unknown as Document);
  assert.deepEqual(tracks, {
    videoId: ID,
    tracks: [
      { lang: "en", kind: "", name: "English", vssId: ".en" },
      { lang: "en", kind: "asr", name: "English (auto-generated)", vssId: "a.en" },
    ],
    defaultIndex: 1,
    hasDefault: true,
    playable: true,
  });
  assert.ok(!JSON.stringify(tracks).includes("example.invalid"));
  assert.ok(!JSON.stringify(tracks).includes("不该交"));
  assert.deepEqual(page.calls, ["getPlayerResponse"]);
});

test("读不到时：没有播放器、没有视频编号、读的时候出错、轨太多是 null；没有默认音轨又不止一条音轨时不报默认轨", () => {
  assert.equal(readPlayerTracks({ getElementById: () => null } as unknown as Document), null);
  assert.equal(readPlayerTracks(pageWith({ captions: RESPONSE.captions }) as unknown as Document), null);
  const throwing = { getElementById: () => ({ getPlayerResponse: () => { throw new Error("自造的错误"); } }) };
  assert.equal(readPlayerTracks(throwing as unknown as Document), null);
  const many = { videoDetails: { videoId: ID }, captions: { playerCaptionsTracklistRenderer: { captionTracks: Array.from({ length: 201 }, () => ({ languageCode: "en" })) } } };
  assert.equal(readPlayerTracks(pageWith(many) as unknown as Document), null);
  const none = readPlayerTracks(pageWith({ videoDetails: { videoId: ID } }) as unknown as Document);
  assert.deepEqual(none, { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null, playable: false }, "没说能播就不算能播");
  const renderer = RESPONSE.captions.playerCaptionsTracklistRenderer;
  const twoAudio = { ...RESPONSE, captions: { playerCaptionsTracklistRenderer: { ...renderer, audioTracks: [...renderer.audioTracks, ...renderer.audioTracks], defaultAudioTrackIndex: undefined } } };
  assert.equal(readPlayerTracks(pageWith(twoAudio) as unknown as Document)?.defaultIndex, null);
  const outside = { ...RESPONSE, captions: { playerCaptionsTracklistRenderer: { ...renderer, audioTracks: [{ defaultCaptionTrackIndex: 5 }] } } };
  assert.equal(readPlayerTracks(pageWith(outside) as unknown as Document)?.defaultIndex, null);
});

test("播放器说这个视频播不了（要登录、还没开播这些）时标成不能正常播：列表空着不说明没有字幕", () => {
  for (const status of ["LOGIN_REQUIRED", "UNPLAYABLE", "LIVE_STREAM_OFFLINE", "ERROR", ""]) {
    const read = readPlayerTracks(pageWith({ playabilityStatus: { status }, videoDetails: { videoId: ID } }) as unknown as Document);
    assert.equal(read?.playable, false, status);
    assert.deepEqual(read?.tracks, []);
  }
  const blank = readPlayerTracks(pageWith({ playabilityStatus: { status: "OK" }, videoDetails: { videoId: ID } }) as unknown as Document);
  assert.deepEqual(blank, { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null, playable: true });
});

test("一问一答：内容脚本问完当场拿到核对过的列表；没有小桥是 null", () => {
  const page = pageWith(RESPONSE);
  assert.equal(askPlayerTracks(page, TOKEN), null);
  const stop = startMainBridge(page as unknown as Document);
  assert.equal(askPlayerTracks(page, TOKEN)?.defaultIndex, 1);
  stop();
  assert.equal(askPlayerTracks(page, TOKEN), null);
});

test("新注入的一份叫旧的停下，只剩一份在答", () => {
  const page = pageWith(RESPONSE);
  startMainBridge(page as unknown as Document);
  startMainBridge(page as unknown as Document);
  let answers = 0;
  page.addEventListener(INJECTED.tracksAnswer, () => (answers += 1));
  askPlayerTracks(page, TOKEN);
  assert.equal(answers, 1);
});

test("内容脚本只认带着这次标记、形状对的第一份回答：网页冒充的、标记不对的、太长的、不是文字的都不认", () => {
  const page = pageWith(RESPONSE);
  const forged = (detail: unknown): void => {
    page.addEventListener(INJECTED.tracksAsk, () => page.dispatchEvent(new CustomEvent(INJECTED.tracksAnswer, { detail })), { once: true });
  };
  forged(JSON.stringify({ token: "jm-other-token-0001", tracks: { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null } }));
  assert.equal(askPlayerTracks(page, TOKEN), null);
  forged({ token: TOKEN, tracks: { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null } });
  assert.equal(askPlayerTracks(page, TOKEN), null);
  forged(JSON.stringify({ token: TOKEN, tracks: { videoId: ID, tracks: [], defaultIndex: 0, hasDefault: null } }));
  assert.equal(askPlayerTracks(page, TOKEN), null);
  forged(JSON.stringify({ token: TOKEN, tracks: { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null, playable: "OK" } }));
  assert.equal(askPlayerTracks(page, TOKEN), null);
  forged(`${JSON.stringify({ token: TOKEN, tracks: null })}${" ".repeat(200_001)}`);
  assert.equal(askPlayerTracks(page, TOKEN), null);
  // 先到的一份对了就不再换：后到的同标记回答不认。
  startMainBridge(page as unknown as Document);
  forged(JSON.stringify({ token: TOKEN, tracks: { videoId: "jmSample0002", tracks: [], defaultIndex: null, hasDefault: null } }));
  assert.equal(askPlayerTracks(page, TOKEN)?.videoId, ID);
});

test("问话的标记形状不对时小桥不答", () => {
  const page = pageWith(RESPONSE);
  startMainBridge(page as unknown as Document);
  let answers = 0;
  page.addEventListener(INJECTED.tracksAnswer, () => (answers += 1));
  for (const detail of [undefined, 3, "短", "带 空格的标记-0000", "x".repeat(65)]) page.dispatchEvent(new CustomEvent(INJECTED.tracksAsk, { detail }));
  assert.equal(answers, 0);
});
