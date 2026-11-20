// 笔记的错误码：正文是空的或太长、要改的笔记已经不在了。
import type { ErrorCopy } from "./copy.ts";

export type NoteErrorCode = "EMPTY_NOTE" | "NOTE_TOO_LONG" | "NOTE_NOT_FOUND";

export const NOTE_ERROR_TEXT: Readonly<Record<NoteErrorCode, ErrorCopy>> = {
  EMPTY_NOTE: { cause: "笔记正文是空的。", impact: "没有保存。", next: "写点内容再保存。" },
  NOTE_TOO_LONG: { cause: "笔记正文超过了 3000 个字符。", impact: "没有保存。", next: "删短一点，或者拆成两条。" },
  NOTE_NOT_FOUND: { cause: "这条笔记已经不在了，可能在别的页面删掉了。" },
};

export const NOTE_ERROR_TEXT_EN: Readonly<Record<NoteErrorCode, ErrorCopy>> = {
  EMPTY_NOTE: { cause: "The note is empty.", impact: "It wasn't saved.", next: "Write something, then save." },
  NOTE_TOO_LONG: { cause: "The note is longer than 3,000 characters.", impact: "It wasn't saved.", next: "Shorten it, or split it into two notes." },
  NOTE_NOT_FOUND: { cause: "This note no longer exists. It may have been deleted on another page." },
};
