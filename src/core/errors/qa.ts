// 问答和划词解释的错误码：问题是空的或太长、模型的回答读不出来、没有选中文字。
import type { ErrorCopy } from "./copy.ts";

export type QaErrorCode = "EMPTY_QUESTION" | "QUESTION_TOO_LONG" | "QA_PARSE_FAILED" | "EMPTY_SELECTION";

export const QA_ERROR_TEXT: Readonly<Record<QaErrorCode, ErrorCopy>> = {
  EMPTY_QUESTION: { cause: "问题是空的。", next: "先输入问题。" },
  QUESTION_TOO_LONG: { cause: "问题超过了 500 个字符。", impact: "没有发出去，不花额度。", next: "删短一点再问。" },
  QA_PARSE_FAILED: {
    cause: "模型没有按要求的格式回答，结果读不出来。",
    impact: "这次没拿到回答，请求已经发出去了，可能照样计费。",
    next: "再试一次；老是这样，就到设置页「按功能选模型」给「问答」换个模型。",
  },
  EMPTY_SELECTION: { cause: "没有选中任何文字。", next: "先在字幕里选中要解释的文字。" },
};
