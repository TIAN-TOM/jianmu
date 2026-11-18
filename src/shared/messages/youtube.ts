// YouTube 代开文字稿面板的请求和回复。路由只在构建开关 FEATURE_YOUTUBE_OPEN_PANEL 打开时进路由表；这里只有类型，不进包。
// 只收侧边栏：用户点「读取字幕」时先让视频页替他点开文字稿，再照常读。
import type { VideoKey } from "../../core/video-ref.ts";

/** 和页面一侧的结果一样，另加 no-page：视频页连不上。 */
export type OpenTranscriptResult = "already-open" | "opened" | "not-opened" | "no-entry" | "ad" | "video-changed" | "searching" | "no-page";

export interface OpenTranscriptRequest {
  readonly video: VideoKey;
  readonly tabId: number;
}

export interface YoutubeApi {
  "youtube.openTranscript": { req: OpenTranscriptRequest; res: { readonly outcome: OpenTranscriptResult } };
}

export type YoutubeRouteName = keyof YoutubeApi;
