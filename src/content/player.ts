// 播放器指令和播放信息上报。指令带视频身份：要和地址上的视频一致，还要确认播放器已经换上这个视频，否则按视频已换拒绝。
// 地址变了以后，等到媒体元素开始加载新内容才算换上；地址变化前后很短的时间里已经开始加载的，也算。
import { videoKey, type VideoKey, type VideoRef } from "../core/video-ref.ts";
import type { ContentCommand, ContentCommandName, ContentReply, PlayerState } from "../shared/messages/content.ts";
import type { MainVideo } from "../sites/page-types.ts";

export interface PlayerDeps {
  readonly currentRef: () => VideoRef | null;
  readonly findMainVideo: () => MainVideo;
  readonly now?: () => number;
}

export interface Player {
  readonly currentKey: () => VideoKey | null;
  /** 播放器确实在放当前地址上的视频。 */
  readonly confirmed: () => boolean;
  /** 地址上的视频变了。 */
  readonly videoChanged: () => void;
  /** 媒体元素开始加载新内容。 */
  readonly mediaLoading: () => void;
  /** 认得的指令回结果，认不出的回 null。 */
  readonly handle: (message: unknown) => ContentReply<ContentCommandName> | null;
}

/** 地址变化前后这么久里媒体元素开始加载，算作换上了新视频。 */
export const MEDIA_SWITCH_WINDOW_MS = 3000;

const keyOf = (ref: VideoRef | null): VideoKey | null => {
  if (!ref) return null;
  try {
    return videoKey(ref);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;
const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 只收这一轮接的两条指令，形状不对的当作认不出。 */
function commandOf(message: unknown): ContentCommand | null {
  if (!isRecord(message) || !isRecord(message.req) || typeof message.req.video !== "string") return null;
  if (message.type === "player.getState") return message as ContentCommand;
  if (message.type === "player.seek" && isSeconds(message.req.atSec)) return message as ContentCommand;
  return null;
}

export function createPlayer({ currentRef, findMainVideo, now = Date.now }: PlayerDeps): Player {
  const currentKey = (): VideoKey | null => keyOf(currentRef());
  // 挂上时地址上的视频就是播放器里的视频。
  let playing: VideoKey | null = currentKey();
  let lastMediaAt = Number.NEGATIVE_INFINITY;

  const confirmed = (): boolean => {
    const key = currentKey();
    return key !== null && key === playing;
  };

  function stateOf(video: HTMLVideoElement): PlayerState {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    return { status: video.paused ? "paused" : "playing", atSec: Number(video.currentTime) || 0, durationSec: duration };
  }

  function handle(message: unknown): ContentReply<ContentCommandName> | null {
    const command = commandOf(message);
    if (!command) return null;
    if (command.req.video !== currentKey() || !confirmed()) return { ok: false, code: "VIDEO_CHANGED" };
    const main = findMainVideo();
    if (main.status === "none") return { ok: false, code: "NO_VIDEO" };
    if (command.type === "player.getState") return main.status === "ad" ? { ok: true, value: { status: "ad" } } : { ok: true, value: stateOf(main.video) };
    if (main.status === "ad") return { ok: false, code: "AD_PLAYING" };
    if (command.type !== "player.seek") return null;
    const video = main.video;
    video.currentTime = Math.max(0, command.req.atSec);
    // 从时间点跳过来是想看这一段，暂停着就顺手播起来。
    if (video.paused) void video.play().catch(() => undefined);
    return { ok: true, value: { atSec: video.currentTime } };
  }

  return {
    currentKey,
    confirmed,
    videoChanged() {
      // 标签页在后台时地址变化晚发现：播放器早已换上、确认过的不作废。
      if (confirmed()) return;
      playing = now() - lastMediaAt <= MEDIA_SWITCH_WINDOW_MS ? currentKey() : null;
    },
    mediaLoading() {
      lastMediaAt = now();
      playing = currentKey();
    },
    handle,
  };
}

/** 每个视频报一次时长，两次上报至少隔这么久。 */
export const PLAYBACK_INFO_INTERVAL_MS = 10_000;

export interface PlaybackReporterDeps {
  readonly player: Pick<Player, "currentKey" | "confirmed">;
  readonly findMainVideo: () => MainVideo;
  readonly report: (video: VideoKey, durationSec: number) => void;
  readonly now?: () => number;
}

/** 定时自查时调一次：播放器换上了视频、读得到时长、不在播广告，才报这个视频的时长。 */
export function createPlaybackReporter({ player, findMainVideo, report, now = Date.now }: PlaybackReporterDeps): () => void {
  let reported: VideoKey | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  return () => {
    const key = player.currentKey();
    if (!key || key === reported || !player.confirmed() || now() - lastAt < PLAYBACK_INFO_INTERVAL_MS) return;
    const main = findMainVideo();
    if (main.status !== "found") return;
    const duration = main.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    reported = key;
    lastAt = now();
    report(key, duration);
  };
}
