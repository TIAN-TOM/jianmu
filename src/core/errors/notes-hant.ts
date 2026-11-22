// 笔记的错误码给用户看的三段话，繁体这份。码由简体那份（notes.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { NoteErrorCode } from "./notes.ts";

export const NOTE_ERROR_TEXT_HANT: Readonly<Record<NoteErrorCode, ErrorCopy>> = {
  EMPTY_NOTE: { cause: "筆記內容是空的。", impact: "沒有儲存。", next: "寫點內容再儲存。" },
  NOTE_TOO_LONG: { cause: "筆記內容超過了 3000 個字元。", impact: "沒有儲存。", next: "刪短一點，或者拆成兩則。" },
  NOTE_NOT_FOUND: { cause: "這則筆記已經不在了，可能在別的頁面刪掉了。" },
};
