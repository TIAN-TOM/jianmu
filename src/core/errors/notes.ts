// 笔记的错误码：正文是空的或太长、要改的笔记已经不在了。

export type NoteErrorCode = "EMPTY_NOTE" | "NOTE_TOO_LONG" | "NOTE_NOT_FOUND";

export const NOTE_ERROR_TEXT: Readonly<Record<NoteErrorCode, string>> = {
  EMPTY_NOTE: "笔记正文不能为空。",
  NOTE_TOO_LONG: "笔记正文不能超过 3000 个字符。",
  NOTE_NOT_FOUND: "这条笔记已经不存在了。",
};
