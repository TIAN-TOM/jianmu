// 本机数据的错误码给用户看的三段话，繁体这份。码由简体那份（data.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { DataErrorCode } from "./data.ts";

export const DATA_ERROR_TEXT_HANT: Readonly<Record<DataErrorCode, ErrorCopy>> = {
  LOCAL_DATA_CLEARED: { cause: "設定頁剛清除了本機資料。", impact: "這次的結果沒有儲存。", next: "需要的話重新做一次。" },
};
