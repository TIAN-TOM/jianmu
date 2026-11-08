// 观看会话的错误码：还没有这次观看的记录、播放进度报得太勤。标签页里换了视频用站点那一类的码。

export type SessionErrorCode = "SESSION_NOT_FOUND" | "PLAYBACK_RATE_LIMITED";

export const SESSION_ERROR_TEXT: Readonly<Record<SessionErrorCode, string>> = {
  SESSION_NOT_FOUND: "这个标签页还没有这次观看的记录。",
  PLAYBACK_RATE_LIMITED: "播放进度报得太频繁，这次没有记下。",
};
