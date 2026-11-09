// 概览的错误码：没有可用的字幕、模型没产出有效内容或读不出结果、补失败块时没有概览或对不上；用官方总结写结论时没有官方总结、模型没写出结论。

export type OverviewErrorCode =
  | "NO_TRANSCRIPT"
  | "EMPTY_ANALYSIS"
  | "ANALYSIS_PARSE_FAILED"
  | "NO_ANALYSIS"
  | "FAILED_CHUNKS_MISMATCH"
  | "NO_OFFICIAL_SUMMARY"
  | "EMPTY_VERDICT";

export const OVERVIEW_ERROR_TEXT: Readonly<Record<OverviewErrorCode, string>> = {
  NO_TRANSCRIPT: "没有可用的字幕。",
  EMPTY_ANALYSIS: "模型没有产出有效的章节或金句，请重试。",
  ANALYSIS_PARSE_FAILED: "模型没有按要求返回结构化的概览，结果读不出来。可以重试一次，或者在设置页「按功能选模型」里给「概览」另选一个型号。",
  NO_ANALYSIS: "还没有可补的概览，请先生成。",
  FAILED_CHUNKS_MISMATCH: "当前字幕和这份概览的分块对不上，请重新生成整份概览。",
  NO_OFFICIAL_SUMMARY: "这个视频没有官方总结，没法据此写结论。",
  EMPTY_VERDICT: "模型没有写出有效的结论，请重试。",
};
