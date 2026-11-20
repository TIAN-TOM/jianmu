// 观看会话的错误码：还没有这次观看的记录、播放进度报得太勤。标签页里换了视频用站点那一类的码。
import type { ErrorCopy } from "./copy.ts";

export type SessionErrorCode = "SESSION_NOT_FOUND" | "PLAYBACK_RATE_LIMITED";

export const SESSION_ERROR_TEXT: Readonly<Record<SessionErrorCode, ErrorCopy>> = {
  SESSION_NOT_FOUND: { cause: "这个标签页还没有这次观看的记录。", next: "刷新视频页再试。" },
  PLAYBACK_RATE_LIMITED: { cause: "播放进度报得太频繁。", impact: "这次没有记下，不影响观看。" },
};

export const SESSION_ERROR_TEXT_EN: Readonly<Record<SessionErrorCode, ErrorCopy>> = {
  SESSION_NOT_FOUND: { cause: "Jianmu has no record of this viewing in this tab yet.", next: "Refresh the video page and try again." },
  PLAYBACK_RATE_LIMITED: { cause: "Playback progress was reported too often.", impact: "This update wasn't recorded. Watching isn't affected." },
};
