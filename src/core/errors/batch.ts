// 批次的错误码：粗筛的列表不在了（没读过、清除了、过了期限），另一步或另一批还在跑，确认之前没清点过。
import type { ErrorCopy } from "./copy.ts";

export type BatchErrorCode = "TRIAGE_LIST_CLEARED" | "BATCH_RUNNING" | "BATCH_NOT_COUNTED";

export const BATCH_ERROR_TEXT: Readonly<Record<BatchErrorCode, ErrorCopy>> = {
  TRIAGE_LIST_CLEARED: {
    cause: "粗筛的列表不在了：没读过、已经清除，或者过了 30 天。",
    impact: "这一步没有开始，不花额度。",
    next: "先点「读取我的稍后再看」重新读一遍。",
  },
  BATCH_RUNNING: { cause: "上一批还在做，或者还在收尾。", impact: "这次没有开始新的一批。", next: "等它结束再点。" },
  BATCH_NOT_COUNTED: {
    cause: "清点下来没有要新生成的视频。",
    impact: "这次没有开始，不花额度。",
    next: "开了新视频的话，再点一次「本窗口全部生成」重新清点。",
  },
};
