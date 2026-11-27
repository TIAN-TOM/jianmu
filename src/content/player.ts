// 播放器指令和播放信息上报。指令带视频身份：要和地址上的视频一致，还要确认播放器已经换上这个视频，否则按视频已换拒绝。
// 地址变了以后，等到媒体元素开始加载新内容才算换上；地址变化前后很短的时间里已经开始加载的，也算。
import { videoKeyOrNull, type VideoKey, type VideoRef } from "../core/video-ref.ts";
import { isRecord } from "../shared/guards.ts";
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

type PlaybackState = Pick<HTMLVideoElement, "paused" | "ended" | "seeking" | "readyState">;

/** 视频有了当前画面，正在播放，也没有在跳转。 */
export function isPlaying(video: PlaybackState): boolean {
  const haveCurrentData = 2;
  return !video.paused && !video.ended && !video.seeking && video.readyState >= haveCurrentData;
}

/** 播放时把笔记记在三秒前，暂停时记在当下。 */
export function noteTimestamp(video: PlaybackState & Pick<HTMLVideoElement, "currentTime">): number {
  const second = Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0;
  return Math.max(0, isPlaying(video) ? second - 3 : second);
}

const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 只收这一轮接的两条指令，形状不对的当作认不出。 */
function commandOf(message: unknown): ContentCommand | null {
  if (!isRecord(message) || !isRecord(message.req) || typeof message.req.video !== "string") return null;
  if (message.type === "player.getState") return message as ContentCommand;
  if (message.type === "player.seek" && isSeconds(message.req.atSec)) return message as ContentCommand;
  return null;
}

export function createPlayer({ currentRef, findMainVideo, now = Date.now }: PlayerDeps): Player {
  const currentKey = (): VideoKey | null => videoKeyOrNull(currentRef());
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
