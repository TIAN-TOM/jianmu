// 播放上报：每个视频先报一次时长和频道，后台回会话里已经累计的秒数和要不要接着报；
// 之后定时采样喂给播放计时，每累计 10 秒报一次。后台说不用再报（自动切过或这次手动选过模式）就停。
// 侧边栏关着也照样计，后台标签页在播也算。只用页面上已有的视频元素和页面数据，不另发请求。
import { createPlayClock, type PlayClock } from "../core/mode/play-clock.ts";
import type { VideoKey } from "../core/video-ref.ts";
import type { PlaybackInfoReply, PlaybackMilestoneReply } from "../shared/messages/session.ts";
import type { MainVideo } from "../sites/page-types.ts";
import { isPlaying, type Player } from "./player.ts";

/** 每个视频报一次时长，两次上报至少隔这么久。 */
export const PLAYBACK_INFO_INTERVAL_MS = 10_000;

/** 读到时长以后最多等频道这么久，等不到就先不带频道报。 */
export const CHANNEL_WAIT_MS = 5_000;

/** 每累计这么多秒报一次。 */
export const MILESTONE_SEC = 10;

type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

export interface PlaybackReporterDeps {
  readonly player: Pick<Player, "currentKey" | "confirmed">;
  readonly findMainVideo: () => MainVideo;
  /** 页面上读得到的频道编号，读不到是 null。 */
  readonly channelId?: () => string | null;
  readonly sendInfo: (req: { video: VideoKey; durationSec: number; channel?: string }) => Promise<Reply<PlaybackInfoReply>>;
  readonly sendMilestone: (req: { video: VideoKey; playedSec: number }) => Promise<Reply<PlaybackMilestoneReply>>;
  readonly now?: () => number;
}

interface Watch {
  readonly video: VideoKey;
  /** 读到时长的时刻，从这时起等频道。 */
  durationAt: number | null;
  infoSent: boolean;
  clock: PlayClock | null;
  /** 报到第几秒了。 */
  reportedSec: number;
  done: boolean;
  inflight: boolean;
}

function playingOf(main: MainVideo): { readonly playing: boolean; readonly position: number; readonly rate: number } {
  if (main.status !== "found") return { playing: false, position: 0, rate: 1 };
  const video = main.video;
  const playing = isPlaying(video);
  return { playing, position: Number(video.currentTime) || 0, rate: Number(video.playbackRate) || 1 };
}

/** 定时自查时调一次。 */
export function createPlaybackReporter({ player, findMainVideo, channelId, sendInfo, sendMilestone, now = Date.now }: PlaybackReporterDeps): () => void {
  let watch: Watch | null = null;
  let lastInfoAt = Number.NEGATIVE_INFINITY;

  async function reportInfo(current: Watch, durationSec: number): Promise<void> {
    const channel = channelId?.() ?? null;
    current.inflight = true;
    lastInfoAt = now();
    const reply = await sendInfo({ video: current.video, durationSec, ...(channel ? { channel } : {}) }).catch(() => null);
    current.inflight = false;
    if (watch !== current || !reply?.ok) return;
    current.infoSent = true;
    current.reportedSec = reply.value.playedSec;
    if (!reply.value.report) current.done = true;
    else current.clock = createPlayClock(reply.value.playedSec);
  }

  async function reportMilestone(current: Watch, playedSec: number): Promise<void> {
    current.inflight = true;
    const reply = await sendMilestone({ video: current.video, playedSec }).catch(() => null);
    current.inflight = false;
    if (watch !== current || !reply) return;
    if (reply.ok) {
      current.reportedSec = playedSec;
      if (!reply.value.report) current.done = true;
      return;
    }
    // 后台没有这次观看的记录（比如清过数据）：重新报时长和频道，从后台的数接着计。
    if (reply.code === "SESSION_NOT_FOUND") {
      current.infoSent = false;
      current.clock = null;
    }
  }

  return () => {
    const key = player.currentKey();
    if (!key) return;
    if (watch?.video !== key) watch = { video: key, durationAt: null, infoSent: false, clock: null, reportedSec: 0, done: false, inflight: false };
    const current = watch;
    if (current.done || !player.confirmed()) return;
    const main = findMainVideo();
    // 回复在路上时照样采样，只是不发下一条。
    const played = current.clock?.sample({ at: now(), ...playingOf(main) });
    if (current.inflight) return;
    if (!current.infoSent) {
      // 广告的时长不是视频时长：报 ad 时不报。
      if (main.status !== "found") return;
      const duration = main.video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      current.durationAt ??= now();
      const waited = now() - current.durationAt >= CHANNEL_WAIT_MS;
      if (channelId && !channelId() && !waited) return;
      if (now() - lastInfoAt < PLAYBACK_INFO_INTERVAL_MS) return;
      void reportInfo(current, duration);
      return;
    }
    if (played === undefined) return;
    const due = Math.floor(played / MILESTONE_SEC) * MILESTONE_SEC;
    if (due > current.reportedSec) void reportMilestone(current, due);
  };
}
