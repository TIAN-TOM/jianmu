// 观看会话的错误码给用户看的三段话，繁体这份。码由简体那份（session.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { SessionErrorCode } from "./session.ts";

export const SESSION_ERROR_TEXT_HANT: Readonly<Record<SessionErrorCode, ErrorCopy>> = {
  SESSION_NOT_FOUND: { cause: "這個分頁還沒有這次觀看的紀錄。", next: "重新整理影片頁再試。" },
  PLAYBACK_RATE_LIMITED: { cause: "播放進度回報得太頻繁。", impact: "這次沒有記下，不影響觀看。" },
};
