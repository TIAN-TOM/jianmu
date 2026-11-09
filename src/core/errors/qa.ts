// 问答和划词解释的错误码：问题是空的或太长、模型的回答读不出来、没有选中文字。

export type QaErrorCode = "EMPTY_QUESTION" | "QUESTION_TOO_LONG" | "QA_PARSE_FAILED" | "EMPTY_SELECTION";

export const QA_ERROR_TEXT: Readonly<Record<QaErrorCode, string>> = {
  EMPTY_QUESTION: "先输入问题。",
  QUESTION_TOO_LONG: "问题不能超过 500 个字符。",
  QA_PARSE_FAILED: "模型没有按要求返回结构化的回答，结果读不出来。可以重试一次，或者在设置页「按功能选模型」里给「问答」另选一个型号。",
  EMPTY_SELECTION: "没有选中任何文字。",
};
