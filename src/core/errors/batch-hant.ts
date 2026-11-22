// 批次的错误码给用户看的三段话，繁体这份。码由简体那份（batch.ts）定，少一条、多一条，类型检查就报错。
import type { BatchErrorCode } from "./batch.ts";
import type { ErrorCopy } from "./copy.ts";

export const BATCH_ERROR_TEXT_HANT: Readonly<Record<BatchErrorCode, ErrorCopy>> = {
  TRIAGE_LIST_CLEARED: {
    cause: "粗篩的清單不在了：沒讀取過、已經清除，或者超過了 30 天。",
    impact: "這一步沒有開始，不花額度。",
    next: "先點選「讀取我的稍後再看」重新讀一遍。",
  },
  BATCH_RUNNING: { cause: "上一批還在進行，或者還在收尾。", impact: "這次沒有開始新的一批。", next: "等它結束再點。" },
  BATCH_NOT_COUNTED: {
    cause: "清點下來沒有要新生成的影片。",
    impact: "這次沒有開始，不花額度。",
    next: "開了新影片的話，再點一次「本視窗全部生成」重新清點。",
  },
};
