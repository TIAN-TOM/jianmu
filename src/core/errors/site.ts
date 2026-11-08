// 站点读取的错误码、失败的影响范围和给用户看的一句话。站点适配层和后台都用这一份，页面也要认得。

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

/** 读取失败波及多大：item 只是这一个视频这次读不成，批量处理记这一项、接着下一项；source 是这条读取路线这会儿整体读不了，批量处理停下。由读取实现判定，调用方据此分流时不解析 detail。 */
export type SiteFailureReach = "item" | "source";

export const SITE_ERROR_TEXT: Readonly<Record<SiteErrorCode, string>> = {
  NEED_LOGIN: "要先在这个浏览器里登录视频网站。",
  NO_CAPTIONS: "这个视频没有可用的字幕。",
  EMPTY_CAPTION_FILE: "字幕文件是空的。",
  RATE_LIMITED: "视频网站暂时限制了读取，稍后再试。",
  UNPLAYABLE: "这个视频现在不可用。",
  NOT_FOUND: "找不到这个视频。",
  SEGMENT_OUT_OF_RANGE: "视频里没有这一部分。",
  VIDEO_CHANGED: "页面上的视频已经换了。",
  TAB_NOT_READY: "视频页还没准备好，稍后再试。",
  MALFORMED: "视频网站返回的内容读不懂。",
  NETWORK: "网络连不上。",
  TIMEOUT: "读取超时了。",
};

/** 同一个码按读取实现给的 detail 换说法：付费内容和确认不了可读范围要分开提示。 */
export const SITE_DETAIL_TEXT: Readonly<Partial<Record<SiteErrorCode, Readonly<Record<string, string>>>>> = {
  UNPLAYABLE: {
    paid: "这是付费内容，简幕不读。",
    "paid-unknown": "暂时无法确认这个视频的可读范围，先不读。",
  },
};
