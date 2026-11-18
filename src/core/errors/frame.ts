// 解释当前画面的错误码和给用户看的三段话。只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 errors.ts 的开关分支引用。
// 截帧的拒绝各对应一个码；模型不能看图单独一个码，提示去设置页换模型，不重试。
import type { ErrorCopy } from "./copy.ts";

export type FrameErrorCode =
  | "FRAME_NO_VIDEO"
  | "FRAME_AD_PLAYING"
  | "FRAME_VIDEO_CHANGED"
  | "FRAME_NOT_READY"
  | "FRAME_PROTECTED"
  | "FRAME_UNREADABLE"
  | "FRAME_NOT_FOREGROUND"
  | "FRAME_UNREACHABLE"
  | "FRAME_BAD_CAPTURE"
  | "FRAME_RATE_LIMITED"
  | "FRAME_INTERRUPTED"
  | "AI_IMAGE_UNSUPPORTED";

const NOT_SENT = "这次没有把画面发出去。";

export const FRAME_ERROR_TEXT: Readonly<Record<FrameErrorCode, ErrorCopy>> = {
  FRAME_NO_VIDEO: { cause: "页面上没找到视频。", impact: NOT_SENT, next: "等视频出来再点。" },
  FRAME_AD_PLAYING: { cause: "正在播广告。", impact: NOT_SENT, next: "等广告放完再点。" },
  FRAME_VIDEO_CHANGED: { cause: "页面上的视频换了，或者还在切换。", impact: NOT_SENT, next: "等新视频放起来再点。" },
  FRAME_NOT_READY: { cause: "画面还没加载好。", impact: NOT_SENT, next: "等视频出画面再点。" },
  FRAME_PROTECTED: { cause: "这个视频是加密播放，或者认不出是不是加密播放。", impact: "简幕不截这种画面，这次没有把画面发出去。" },
  FRAME_UNREADABLE: { cause: "浏览器不让读这个视频的画面。", impact: NOT_SENT },
  FRAME_NOT_FOREGROUND: { cause: "视频页不在前台。", impact: NOT_SENT, next: "切回视频页再点。" },
  FRAME_UNREACHABLE: { cause: "视频页还没连上简幕。", impact: NOT_SENT, next: "刷新视频页再点。" },
  FRAME_BAD_CAPTURE: { cause: "截到的画面不对劲，简幕没有用它。", impact: NOT_SENT, next: "再点一次。" },
  FRAME_RATE_LIMITED: { cause: "一分钟里点得太多了。", impact: NOT_SENT, next: "等一会儿再点。" },
  FRAME_INTERRUPTED: { cause: "简幕的后台中途停了，这次解释没做完。", impact: "如果请求已经发出去，可能照样计费。", next: "再点一次。" },
  AI_IMAGE_UNSUPPORTED: {
    cause: "画面分析用的模型不能看图。",
    impact: "这次没拿到结果。",
    next: "到设置页「按功能选模型」里给画面分析换一个能看图的模型。",
  },
};
