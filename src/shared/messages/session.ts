// 观看会话、播放上报、模式切换、卡片手动展开收起和清除频道偏好这几条消息的请求和回复。
import type { CardOverride, Mode, SessionView } from "../../core/mode/types.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 内容脚本报这个视频的时长和频道，每个视频一条。视频要等于发送方标签页地址上的那个。 */
export interface PlaybackInfoRequest {
  readonly video: VideoKey;
  readonly durationSec?: number;
  /** 这个站上的频道编号，读不到时不带。 */
  readonly channel?: string;
}

/** 内容脚本从会话里的累计秒数接着计；不用再报时 report 是 false。 */
export interface PlaybackInfoReply {
  readonly playedSec: number;
  readonly report: boolean;
}

export interface PlaybackMilestoneRequest {
  readonly video: VideoKey;
  readonly playedSec: number;
}

export interface PlaybackMilestoneReply {
  readonly report: boolean;
}

/** 侧边栏按标签页读；卡片只读自己所在的标签页，不带参数。 */
export type SessionGetRequest = { readonly tabId: number } | EmptyRequest;

export interface SessionReply {
  readonly session: SessionView | null;
}

/** 主动点模式切换记成手动并记住频道；撤销自动切换回到打开时的模式，不记频道。 */
export type SessionSetModeRequest =
  | { readonly tabId: number; readonly video: VideoKey; readonly intent: "manual"; readonly mode: Mode }
  | { readonly tabId: number; readonly video: VideoKey; readonly intent: "undo-auto" };

export interface SessionChangedReply {
  readonly session: SessionView;
}

/** 卡片在自己所在的标签页上手动展开或收起，换视频即失效。 */
export interface CardOverrideRequest {
  readonly video: VideoKey;
  readonly value: CardOverride;
}

export interface SessionApi {
  "playback.info": { req: PlaybackInfoRequest; res: PlaybackInfoReply };
  "playback.milestone": { req: PlaybackMilestoneRequest; res: PlaybackMilestoneReply };
  "session.get": { req: SessionGetRequest; res: SessionReply };
  "session.setMode": { req: SessionSetModeRequest; res: SessionChangedReply };
  "card.setOverride": { req: CardOverrideRequest; res: SessionChangedReply };
  "channels.clear": { req: EmptyRequest; res: EmptyRequest };
}
