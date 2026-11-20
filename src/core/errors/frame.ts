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

const NOT_SENT_EN = "The frame wasn't sent.";

export const FRAME_ERROR_TEXT_EN: Readonly<Record<FrameErrorCode, ErrorCopy>> = {
  FRAME_NO_VIDEO: { cause: "There's no video on the page.", impact: NOT_SENT_EN, next: "Wait for the video to appear, then click again." },
  FRAME_AD_PLAYING: { cause: "An ad is playing.", impact: NOT_SENT_EN, next: "Wait for the ad to finish, then click again." },
  FRAME_VIDEO_CHANGED: { cause: "The video on the page has changed, or is still changing.", impact: NOT_SENT_EN, next: "Wait for the new video to start playing, then click again." },
  FRAME_NOT_READY: { cause: "The picture hasn't loaded yet.", impact: NOT_SENT_EN, next: "Wait until the video shows a picture, then click again." },
  FRAME_PROTECTED: { cause: "This video uses protected playback, or Jianmu can't tell whether it does.", impact: "Jianmu doesn't capture protected video, so the frame wasn't sent." },
  FRAME_UNREADABLE: { cause: "The browser won't let Jianmu read this video's picture.", impact: NOT_SENT_EN },
  FRAME_NOT_FOREGROUND: { cause: "The video page isn't the active tab.", impact: NOT_SENT_EN, next: "Switch back to the video page, then click again." },
  FRAME_UNREACHABLE: { cause: "The video page isn't connected to Jianmu yet.", impact: NOT_SENT_EN, next: "Refresh the video page, then click again." },
  FRAME_BAD_CAPTURE: { cause: "The captured frame looked wrong, so Jianmu didn't use it.", impact: NOT_SENT_EN, next: "Click again." },
  FRAME_RATE_LIMITED: { cause: "Too many clicks in one minute.", impact: NOT_SENT_EN, next: "Wait a moment, then click again." },
  FRAME_INTERRUPTED: { cause: "Jianmu's background process stopped partway, so the explanation wasn't finished.", impact: "If the request was already sent, it may still be billed.", next: "Click again." },
  AI_IMAGE_UNSUPPORTED: {
    cause: "The model used for frame analysis can't read images.",
    impact: "No result this time.",
    next: "Under “Models per feature” in settings, choose a model that can read images for frame analysis.",
  },
};
