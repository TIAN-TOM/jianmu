// 播放器指令：视频身份要和地址一致，地址变了以后要等播放器换上新视频；正在播广告时不给时间、不跳转；
// 时长每个视频只报一次，两次上报之间隔够时间。另核对笔记按钮抄的主题色和设置里的主题表一致。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCENT_SWATCHES } from "../../../src/content/note-button.ts";
import { createPlaybackReporter, createPlayer, MEDIA_SWITCH_WINDOW_MS, PLAYBACK_INFO_INTERVAL_MS } from "../../../src/content/player.ts";
import { videoKey, type VideoRef } from "../../../src/core/video-ref.ts";
import { ACCENT_THEMES } from "../../../src/shared/settings-schema.ts";
import type { MainVideo } from "../../../src/sites/page-types.ts";

const FIRST: VideoRef = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 };
const SECOND: VideoRef = { platform: "bilibili", videoId: "BV1Sample002", segment: 1 };

function fakeVideo({ paused = true, currentTime = 12, duration = 600 } = {}) {
  const plays: number[] = [];
  return {
    paused,
    currentTime,
    duration,
    plays,
    play() {
      plays.push(this.currentTime);
      this.paused = false;
      return Promise.resolve();
    },
  };
}

function setup(main: () => MainVideo) {
  let ref: VideoRef = FIRST;
  let clock = 100_000;
  const player = createPlayer({ currentRef: () => ref, findMainVideo: main, now: () => clock });
  return { player, go: (next: VideoRef) => void (ref = next), tick: (ms: number) => void (clock += ms) };
}

test("读状态和跳转：视频对得上时照做，暂停着跳过去就播起来", () => {
  const video = fakeVideo();
  const { player } = setup(() => ({ status: "found", video: video as unknown as HTMLVideoElement }));
  const key = videoKey(FIRST);
  assert.deepEqual(player.handle({ type: "player.getState", req: { video: key } }), { ok: true, value: { status: "paused", atSec: 12, durationSec: 600 } });
  assert.deepEqual(player.handle({ type: "player.seek", req: { video: key, atSec: 90 } }), { ok: true, value: { atSec: 90 } });
  assert.deepEqual(video.plays, [90]);
  assert.equal(player.handle({ type: "player.captureFrame", req: { video: key, maxEdge: 100 } }), null, "这一轮不接截帧");
  assert.equal(player.handle({ type: "player.seek", req: { video: key, atSec: -1 } }), null);
});

test("视频对不上、找不到视频、正在播广告，各按各的拒绝", () => {
  let main: MainVideo = { status: "none" };
  const { player } = setup(() => main);
  assert.deepEqual(player.handle({ type: "player.getState", req: { video: videoKey(SECOND) } }), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(player.handle({ type: "player.getState", req: { video: videoKey(FIRST) } }), { ok: false, code: "NO_VIDEO" });
  main = { status: "ad" };
  assert.deepEqual(player.handle({ type: "player.getState", req: { video: videoKey(FIRST) } }), { ok: true, value: { status: "ad" } });
  assert.deepEqual(player.handle({ type: "player.seek", req: { video: videoKey(FIRST), atSec: 5 } }), { ok: false, code: "AD_PLAYING" });
});

test("地址换了视频以后，播放器开始加载新内容之前按视频已换拒绝；地址变化前刚开始加载的算换上了", () => {
  const video = fakeVideo();
  const { player, go, tick } = setup(() => ({ status: "found", video: video as unknown as HTMLVideoElement }));
  tick(MEDIA_SWITCH_WINDOW_MS + 1);
  go(SECOND);
  player.videoChanged();
  assert.equal(player.confirmed(), false);
  assert.deepEqual(player.handle({ type: "player.getState", req: { video: videoKey(SECOND) } }), { ok: false, code: "VIDEO_CHANGED" });
  player.mediaLoading();
  assert.equal(player.confirmed(), true);
  assert.equal(player.handle({ type: "player.getState", req: { video: videoKey(SECOND) } })?.ok, true);

  tick(MEDIA_SWITCH_WINDOW_MS + 1);
  player.mediaLoading();
  tick(500);
  go(FIRST);
  player.videoChanged();
  assert.equal(player.confirmed(), true, "地址变化前半秒播放器已经开始加载");
});

test("标签页在后台时播放器先换上了新视频，回到前台才发现地址变了：已经确认的不作废", () => {
  const { player, go, tick } = setup(() => ({ status: "found", video: fakeVideo() as unknown as HTMLVideoElement }));
  go(SECOND);
  player.mediaLoading();
  tick(MEDIA_SWITCH_WINDOW_MS * 10);
  player.videoChanged();
  assert.equal(player.confirmed(), true);
  assert.equal(player.handle({ type: "player.getState", req: { video: videoKey(SECOND) } })?.ok, true);
});

test("时长每个视频报一次，等播放器换上、读得到时长、不在播广告；两次上报至少隔一段时间", () => {
  let main: MainVideo = { status: "ad" };
  let ref: VideoRef = FIRST;
  let clock = 0;
  const player = createPlayer({ currentRef: () => ref, findMainVideo: () => main, now: () => clock });
  const reports: [string, number][] = [];
  const report = createPlaybackReporter({ player, findMainVideo: () => main, report: (video, sec) => void reports.push([video, sec]), now: () => clock });
  report();
  main = { status: "found", video: fakeVideo({ duration: Number.NaN }) as unknown as HTMLVideoElement };
  report();
  main = { status: "found", video: fakeVideo({ duration: 600 }) as unknown as HTMLVideoElement };
  report();
  report();
  assert.deepEqual(reports, [[videoKey(FIRST), 600]]);

  ref = SECOND;
  player.mediaLoading();
  report();
  assert.equal(reports.length, 1, "离上一次太近");
  clock += PLAYBACK_INFO_INTERVAL_MS;
  report();
  assert.deepEqual(reports.at(-1), [videoKey(SECOND), 600]);
});

test("笔记按钮抄的主题色和设置里的主题表一致", () => {
  assert.deepEqual(ACCENT_SWATCHES, Object.fromEntries(Object.entries(ACCENT_THEMES).map(([name, theme]) => [name, theme.swatch])));
});
