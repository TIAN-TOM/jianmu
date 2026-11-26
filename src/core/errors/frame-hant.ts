// 解释当前画面的错误码给用户看的三段话，繁体这份。码由简体那份（frame.ts）定，少一条、多一条，类型检查就报错。
// 跟 frame.ts 一样只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 errors.ts 的开关分支引用。
import type { ErrorCopy } from "./copy.ts";
import type { FrameErrorCode } from "./frame.ts";

const NOT_SENT = "這次沒有把畫面傳出去。";

export const FRAME_ERROR_TEXT_HANT: Readonly<Record<FrameErrorCode, ErrorCopy>> = {
  FRAME_NO_VIDEO: { cause: "頁面上沒找到影片。", impact: NOT_SENT, next: "等影片出來再點。" },
  FRAME_AD_PLAYING: { cause: "正在播廣告。", impact: NOT_SENT, next: "等廣告播完再點。" },
  FRAME_VIDEO_CHANGED: { cause: "頁面上的影片換了，或者還在切換。", impact: NOT_SENT, next: "等新影片播起來再點。" },
  FRAME_NOT_READY: { cause: "畫面還沒載入好。", impact: NOT_SENT, next: "等影片出現畫面再點。" },
  FRAME_PROTECTED: { cause: "這部影片是加密播放，或者認不出是不是加密播放。", impact: "簡幕不擷取這種畫面，這次沒有把畫面傳出去。" },
  FRAME_UNREADABLE: { cause: "瀏覽器不讓讀取這部影片的畫面。", impact: NOT_SENT },
  FRAME_NOT_FOREGROUND: { cause: "影片頁不在前景。", impact: NOT_SENT, next: "切回影片頁再點。" },
  FRAME_UNREACHABLE: { cause: "影片頁還沒連上簡幕。", impact: NOT_SENT, next: "重新整理影片頁再點。" },
  FRAME_BAD_CAPTURE: { cause: "擷取到的畫面不太對，簡幕沒有用它。", impact: NOT_SENT, next: "再點一次。" },
  FRAME_RATE_LIMITED: { cause: "一分鐘裡點得太多次了。", impact: NOT_SENT, next: "等一下再點。" },
  FRAME_INTERRUPTED: { cause: "簡幕的背景程式中途停了，這次解釋沒做完。", impact: "如果請求已經發出去，可能照樣計費。", next: "再點一次。" },
  AI_IMAGE_UNSUPPORTED: {
    cause: "畫面解釋用的模型不能看圖。",
    impact: "這次沒拿到結果。",
    next: "到設定頁「按功能選模型」裡替畫面解釋換一個能看圖的模型。",
  },
};
