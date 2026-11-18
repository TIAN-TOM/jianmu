// 概览的错误码：没有可用的字幕、模型没产出有效内容或读不出结果、补失败块时没有概览或对不上；用官方总结写结论时没有官方总结、模型没写出结论；「尽量整份」那一档请求太大。
import type { ErrorCopy } from "./copy.ts";

export type OverviewErrorCode =
  | "NO_TRANSCRIPT"
  | "EMPTY_ANALYSIS"
  | "ANALYSIS_PARSE_FAILED"
  | "NO_ANALYSIS"
  | "FAILED_CHUNKS_MISMATCH"
  | "NO_OFFICIAL_SUMMARY"
  | "EMPTY_VERDICT"
  | "WHOLE_CHUNK_TOO_BIG";

const MAYBE_BILLED = "这次没拿到结果，请求已经发出去了，可能照样计费；原来存下的内容都还在。";
const SWITCH_MODEL = "再试一次；老是这样，就到设置页「按功能选模型」给「概览」换个模型。";

export const OVERVIEW_ERROR_TEXT: Readonly<Record<OverviewErrorCode, ErrorCopy>> = {
  NO_TRANSCRIPT: {
    cause: "这个视频没有可用的字幕。",
    impact: "没法生成概览，也没花额度。",
    next: "手上有这个视频的字幕文件的话，可以在侧边栏点「导入字幕文件」；在播放页卡片上要先点「打开完整面板」。",
  },
  EMPTY_ANALYSIS: { cause: "模型没有写出有效的章节或金句。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  ANALYSIS_PARSE_FAILED: { cause: "模型没有按要求的格式返回概览，结果读不出来。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  NO_ANALYSIS: { cause: "还没有可以补的概览。", next: "先点「生成概览」。" },
  FAILED_CHUNKS_MISMATCH: {
    cause: "当前的字幕和这份概览的分块对不上。",
    impact: "没法只补失败的部分，这次没花额度。",
    next: "点「重新生成」生成整份概览。",
  },
  NO_OFFICIAL_SUMMARY: {
    cause: "这个视频没有官方总结。",
    impact: "没法据此写结论，这次没花额度。",
    next: "可以在侧边栏点「生成概览」，从字幕写结论。",
  },
  EMPTY_VERDICT: { cause: "模型没有写出有效的结论。", impact: MAYBE_BILLED, next: "再试一次。" },
  WHOLE_CHUNK_TOO_BIG: {
    cause: "「尽量整份」把整段字幕一次交给模型，这次超时了，或者模型一次装不下。",
    impact: MAYBE_BILLED,
    next: "到设置页「概览分块」换回「自动」或「较长」，再点「生成概览」。",
  },
};
