// 翻译的错误码：模型回的译文读不出来。
import type { ErrorCopy } from "./copy.ts";

export type TranslateErrorCode = "TRANSLATE_PARSE_FAILED";

export const TRANSLATE_ERROR_TEXT: Readonly<Record<TranslateErrorCode, ErrorCopy>> = {
  TRANSLATE_PARSE_FAILED: {
    cause: "模型没有按要求的格式返回译文，结果读不出来。",
    impact: "有一批字幕没翻出来，请求已经发出去了，可能照样计费；已经翻好的部分都还在。",
    next: "再试一次；老是这样，就到设置页「按功能选模型」给「翻译」换个模型。",
  },
};
