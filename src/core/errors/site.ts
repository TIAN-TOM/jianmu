// 站点读取的错误码、失败的影响范围和给用户看的三段话。站点适配层和后台都用这一份，页面也要认得。
import type { ErrorCopy } from "./copy.ts";

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
  | "TIMEOUT"
  | "PAGE_ACTION_NEEDED"
  | "UNAVAILABLE";

/** 读取失败波及多大：item 只是这一个视频这次读不成，批量处理记这一项、接着下一项；source 是这条读取路线这会儿整体读不了，批量处理停下。由读取实现判定，调用方据此分流时不解析 detail。 */
export type SiteFailureReach = "item" | "source";

// 读视频网站在调模型之前，读不到就不会往下走。
const NOT_READ = "这次没读到，也没发给模型，不花额度。";
const IMPORT_FILE = "手上有这个视频的字幕文件的话，可以在侧边栏点「导入字幕文件」；在播放页卡片上要先点「打开完整面板」。";

export const SITE_ERROR_TEXT: Readonly<Record<SiteErrorCode, ErrorCopy>> = {
  NEED_LOGIN: { cause: "这个浏览器还没登录视频网站。", impact: "字幕、官方总结和稍后再看只给已登录的用户读，这次都没读。", next: "登录以后再试，或者导入自己的字幕文件。" },
  NO_CAPTIONS: { cause: "这个视频没有可用的字幕。", impact: NOT_READ, next: IMPORT_FILE },
  EMPTY_CAPTION_FILE: { cause: "视频网站给的字幕文件是空的。", impact: NOT_READ, next: `稍后再试。${IMPORT_FILE}` },
  RATE_LIMITED: { cause: "视频网站暂时限制了读取。", impact: "简幕先停下，不会反复去试，这次没花额度。", next: "过几分钟再试。" },
  UNPLAYABLE: { cause: "这个视频现在看不了。", impact: "简幕没有读它的内容。" },
  NOT_FOUND: { cause: "找不到这个视频，可能已经删掉或者不公开了。", impact: "简幕没有读它的内容。" },
  SEGMENT_OUT_OF_RANGE: { cause: "视频里没有这一 P。", impact: "简幕没有读它的内容。", next: "刷新视频页，从分 P 列表里重新选。" },
  VIDEO_CHANGED: {
    cause: "页面上的视频已经换了。",
    impact: "这次读到的内容没有用，免得记到别的视频上。",
    next: "回到原来的视频再试，或者在新视频上重新开始。",
  },
  TAB_NOT_READY: { cause: "视频页还没加载好。", impact: NOT_READ, next: "等页面加载完再试，还不行就刷新视频页。" },
  MALFORMED: { cause: "视频网站返回的内容简幕读不懂。", impact: NOT_READ, next: "稍后再试；一直这样，可能是网站改版了，等简幕更新。" },
  NETWORK: { cause: "连不上视频网站。", impact: NOT_READ, next: "检查一下网络再试。" },
  TIMEOUT: { cause: "读取视频网站超时了。", impact: NOT_READ, next: "稍后再试。" },
  PAGE_ACTION_NEEDED: {
    cause: "视频页上的文字稿还没打开。",
    impact: NOT_READ,
    next: "在视频简介下面打开文字稿（YouTube 上写作 Show transcript 或显示文字稿），等文字出来，再点读取。",
  },
  UNAVAILABLE: { cause: "暂时读不到这个视频的字幕。", impact: NOT_READ, next: `稍后再试。${IMPORT_FILE}` },
};

/** 同一个码按读取实现给的 detail 换说法：付费内容单独提示。 */
export const SITE_DETAIL_TEXT: Readonly<Partial<Record<SiteErrorCode, Readonly<Record<string, ErrorCopy>>>>> = {
  PAGE_ACTION_NEEDED: {
    reopen: {
      cause: "视频页上的文字稿是简幕接上之前打开的，认不出是不是这个视频的。",
      impact: NOT_READ,
      next: "刷新视频页，再打开文字稿，等文字出来，再点读取。",
    },
    filtered: { cause: "视频页上的文字稿里有搜索词，只显示了一部分。", impact: NOT_READ, next: "清掉文字稿上方搜索框里的字，再点读取。" },
    ad: { cause: "视频正在播广告。", impact: "简幕这时什么都没读。", next: "等广告放完，再点读取。" },
    chapters: { cause: "视频页上的面板现在显示的是章节，不是文字稿。", impact: NOT_READ, next: "在面板上方切到 Transcript（文字稿）那一页，等文字出来，再点读取。" },
  },
  UNAVAILABLE: {
    stale: { cause: "视频页上的文字稿还没换成这个视频的。", impact: "读到的内容没有用，免得记到别的视频上。", next: "刷新视频页，再打开文字稿，然后点读取。" },
    "no-entry": { cause: "这个视频页上找不到文字稿。", impact: NOT_READ, next: `这个视频可能没有字幕，也可能是页面改版了。${IMPORT_FILE}` },
    "no-page": { cause: "要在视频页上读，可这会儿连不上视频页。", impact: NOT_READ, next: "回到视频页，在侧边栏点读取；还不行就刷新视频页。" },
  },
  UNPLAYABLE: {
    paid: { cause: "这是付费内容。", impact: "简幕不读付费内容，什么都没读，也没发给模型。" },
  },
};
