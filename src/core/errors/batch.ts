// 批次的错误码：粗筛的列表不在了（没读过、清除了、过了期限），另一步或另一批还在跑，确认之前没清点过。

export type BatchErrorCode = "TRIAGE_LIST_CLEARED" | "BATCH_RUNNING" | "BATCH_NOT_COUNTED";

export const BATCH_ERROR_TEXT: Readonly<Record<BatchErrorCode, string>> = {
  TRIAGE_LIST_CLEARED: "粗筛的列表不在了：没读过、已经清除，或者过了 30 天。先重新读取稍后再看。",
  BATCH_RUNNING: "上一批还在做，或者还在收尾，等它结束再点。",
  BATCH_NOT_COUNTED: "没有要新生成的视频。先重新清点本窗口。",
};
