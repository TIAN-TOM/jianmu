// 本机数据的错误码：操作途中设置页清除了本机数据，这次的结果没有存。

export type DataErrorCode = "LOCAL_DATA_CLEARED";

export const DATA_ERROR_TEXT: Readonly<Record<DataErrorCode, string>> = {
  LOCAL_DATA_CLEARED: "设置页清除了本机数据，这次没有保存。",
};
