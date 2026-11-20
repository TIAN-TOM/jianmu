// 问答和划词解释的错误码：问题是空的或太长、模型装不下这么多字幕、模型的回答读不出来、没有选中文字。
import type { ErrorCopy } from "./copy.ts";

export type QaErrorCode = "EMPTY_QUESTION" | "QUESTION_TOO_LONG" | "QA_INPUT_TOO_LONG" | "QA_PARSE_FAILED" | "EMPTY_SELECTION";

export const QA_ERROR_TEXT: Readonly<Record<QaErrorCode, ErrorCopy>> = {
  EMPTY_QUESTION: { cause: "问题是空的。", next: "先输入问题。" },
  QUESTION_TOO_LONG: { cause: "问题超过了 2000 个字符。", impact: "没有发出去，不花额度。", next: "删短一点再问。" },
  QA_INPUT_TOO_LONG: {
    cause: "要送的字幕太长，这个模型一次装不下，缩小范围以后还是被服务拒绝了。",
    impact: "这次没拿到回答。",
    next: "到设置页「按功能选模型」给「问答」换一个上下文更长的模型，或者把问题问得具体一点。",
  },
  QA_PARSE_FAILED: {
    cause: "模型没有按要求的格式回答，结果读不出来。",
    impact: "这次没拿到回答，请求已经发出去了，可能照样计费。",
    next: "再试一次；老是这样，就到设置页「按功能选模型」给「问答」换个模型。",
  },
  EMPTY_SELECTION: { cause: "没有选中任何文字。", next: "先在字幕里选中要解释的文字。" },
};

export const QA_ERROR_TEXT_EN: Readonly<Record<QaErrorCode, ErrorCopy>> = {
  EMPTY_QUESTION: { cause: "The question is empty.", next: "Type a question first." },
  QUESTION_TOO_LONG: { cause: "The question is longer than 2,000 characters.", impact: "It wasn't sent, so no API credit was used.", next: "Shorten it and ask again." },
  QA_INPUT_TOO_LONG: {
    cause: "The subtitles are too long for this model. Jianmu sent less, but the service still rejected it.",
    impact: "No answer this time.",
    next: "Under “Models per feature” in settings, choose a model with a longer context for Q&A, or make your question more specific.",
  },
  QA_PARSE_FAILED: {
    cause: "The model didn't answer in the expected format, so the answer couldn't be read.",
    impact: "No answer this time, but the request was sent and may still be billed.",
    next: "Try again. If it keeps happening, choose a different model for Q&A under “Models per feature” in settings.",
  },
  EMPTY_SELECTION: { cause: "No text is selected.", next: "Select the text you want explained in the subtitles first." },
};
