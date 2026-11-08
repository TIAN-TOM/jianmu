// 站点读取的错误码和给用户看的一句话。站点适配层和后台都用这一份，页面也要认得。

export type SiteErrorCode =
  | "NEED_LOGIN"
  | "NO_CAPTIONS"
  | "EMPTY_CAPTION_FILE"
  | "RATE_LIMITED"
  | "UNPLAYABLE"
  | "NOT_FOUND"
  | "SEGMENT_OUT_OF_RANGE"
  | "VIDEO_CHANGED"
  | "TAB_NOT_READY"
  | "MALFORMED"
  | "NETWORK"
  | "TIMEOUT";

export const SITE_ERROR_TEXT: Readonly<Record<SiteErrorCode, string>> = {
  NEED_LOGIN: "要先在这个浏览器里登录视频网站。",
  NO_CAPTIONS: "这个视频没有可用的字幕。",
  EMPTY_CAPTION_FILE: "字幕文件是空的。",
  RATE_LIMITED: "视频网站暂时限制了读取，稍后再试。",
  UNPLAYABLE: "这个视频现在读不了。",
  NOT_FOUND: "找不到这个视频。",
  SEGMENT_OUT_OF_RANGE: "视频里没有这一部分。",
  VIDEO_CHANGED: "页面上的视频已经换了。",
  TAB_NOT_READY: "视频页还没准备好，稍后再试。",
  MALFORMED: "视频网站返回的内容读不懂。",
  NETWORK: "网络连不上。",
  TIMEOUT: "读取超时了。",
};
