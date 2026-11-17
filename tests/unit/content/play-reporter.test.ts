// 播放上报：每个视频先报时长和频道（读不到频道最多等 5 秒），从后台回的累计秒数接着计，每累计 10 秒报一次；
// 后台说不用再报就停；广告不报时长；换视频重来；后台没有这次观看的记录时重新报时长。
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_WAIT_MS, createPlaybackReporter, PLAYBACK_INFO_INTERVAL_MS } from "../../../src/content/play-reporter.ts";
import { videoKey, type VideoKey } from "../../../src/core/video-ref.ts";
import type { MainVideo } from "../../../src/sites/page-types.ts";
import { until } from "../../helpers/wait-until.ts";

const FIRST = videoKey({ platform: "bilibili", videoId: "BV1Sample001" });
const SECOND = videoKey({ platform: "bilibili", videoId: "BV1Sample002" });

function world({ channel = "4242" as string | null, report = true, startSec = 0 } = {}) {
  let clock = 1_000;
  let key: VideoKey = FIRST;
  const video = { paused: false, ended: false, seeking: false, readyState: 4, currentTime: 0, playbackRate: 1, duration: 1800 };
  let main: MainVideo = { status: "found", video: video as unknown as HTMLVideoElement };
  const state = { channel, report, startSec, milestoneReply: null as null | { ok: false; code: string } };
  const infos: unknown[] = [];
  const milestones: number[] = [];
  const tick = createPlaybackReporter({
    player: { currentKey: () => key, confirmed: () => true },
    findMainVideo: () => main,
    channelId: () => state.channel,
    sendInfo: async (req) => {
      infos.push(req);
      return { ok: true, value: { playedSec: state.startSec, report: state.report } };
    },
    sendMilestone: async (req) => {
      milestones.push(req.playedSec);
      return state.milestoneReply ?? { ok: true, value: { report: state.report } };
    },
    now: () => clock,
  });
  /** 播 seconds 秒，每秒自查一次，每次等回复处理完。 */
  async function play(seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      clock += 1000;
      video.currentTime += video.playbackRate;
      tick();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return {
    tick,
    play,
    infos,
    milestones,
    state,
    video,
    advance: (ms: number) => void (clock += ms),
    setMain: (next: MainVideo) => void (main = next),
    go: (next: VideoKey) => void (key = next),
  };
}

test("读到时长和频道就报一次，之后每累计 10 秒报一次累计秒数", async () => {
  const w = world();
  await w.play(35);
  assert.deepEqual(w.infos, [{ video: FIRST, durationSec: 1800, channel: "4242" }]);
  assert.deepEqual(w.milestones, [10, 20, 30]);
});

test("频道读不到：最多等 5 秒，等不到就不带频道报", async () => {
  const w = world({ channel: null });
  w.tick();
  w.advance(CHANNEL_WAIT_MS - 1);
  w.tick();
  assert.equal(w.infos.length, 0);
  w.advance(1);
  w.tick();
  assert.ok(await until(() => w.infos.length === 1));
  assert.deepEqual(w.infos, [{ video: FIRST, durationSec: 1800 }]);
});

test("播广告、读不到时长时不报时长；暂停时不计", async () => {
  const w = world();
  w.setMain({ status: "ad" });
  await w.play(3);
  assert.equal(w.infos.length, 0, "广告的时长不当视频时长");
  w.setMain({ status: "found", video: w.video as unknown as HTMLVideoElement });
  w.video.duration = Number.NaN;
  await w.play(3);
  assert.equal(w.infos.length, 0);
  w.video.duration = 1800;
  await w.play(5);
  w.video.paused = true;
  await w.play(30);
  assert.deepEqual(w.milestones, [], "暂停不计，没到 10 秒");
  w.video.paused = false;
  await w.play(8);
  assert.deepEqual(w.milestones, [10]);
});

test("刷新同一视频：从后台回的累计秒数接着计", async () => {
  const w = world({ startSec: 47 });
  await w.play(5);
  assert.deepEqual(w.milestones, [50]);
});

test("后台说不用再报（自动切过或手动选过）：报时长时就说了的一条都不报，报进度时说了的之后不再报", async () => {
  const stopped = world({ report: false });
  await stopped.play(30);
  assert.equal(stopped.infos.length, 1);
  assert.deepEqual(stopped.milestones, []);

  const later = world();
  await later.play(15);
  later.state.report = false;
  await later.play(40);
  assert.deepEqual(later.milestones, [10, 20]);
});

test("换视频重新报时长、重新计；两次报时长至少隔 10 秒", async () => {
  const w = world();
  await w.play(2);
  w.go(SECOND);
  await w.play(3);
  assert.equal(w.infos.length, 1, "离上一次太近");
  await w.play(PLAYBACK_INFO_INTERVAL_MS / 1000);
  assert.equal((w.infos.at(-1) as { video: string }).video, SECOND);
});

test("后台没有这次观看的记录：重新报一次时长，再从后台的数接着计", async () => {
  const w = world();
  await w.play(11);
  w.state.milestoneReply = { ok: false, code: "SESSION_NOT_FOUND" };
  await w.play(10);
  w.state.milestoneReply = null;
  await w.play(PLAYBACK_INFO_INTERVAL_MS / 1000 + 12);
  assert.equal(w.infos.length, 2);
  // 第一条 10 被拒；重新报时长以后后台回 0，从头计到 10、20。
  assert.deepEqual(w.milestones, [10, 10, 20]);
});
