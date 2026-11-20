// 本机数据的错误码：操作途中设置页清除了本机数据，这次的结果没有存。
import type { ErrorCopy } from "./copy.ts";

export type DataErrorCode = "LOCAL_DATA_CLEARED";

export const DATA_ERROR_TEXT: Readonly<Record<DataErrorCode, ErrorCopy>> = {
  LOCAL_DATA_CLEARED: { cause: "设置页刚清除了本机数据。", impact: "这次的结果没有保存。", next: "要的话重新做一次。" },
};

export const DATA_ERROR_TEXT_EN: Readonly<Record<DataErrorCode, ErrorCopy>> = {
  LOCAL_DATA_CLEARED: { cause: "Local data was just cleared in settings.", impact: "This result wasn't saved.", next: "Do it again if you still need it." },
};
