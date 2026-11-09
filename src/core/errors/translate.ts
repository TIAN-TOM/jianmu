// 翻译的错误码：模型回的译文读不出来。

export type TranslateErrorCode = "TRANSLATE_PARSE_FAILED";

export const TRANSLATE_ERROR_TEXT: Readonly<Record<TranslateErrorCode, string>> = {
  TRANSLATE_PARSE_FAILED: "模型没有按要求返回译文，结果读不出来。可以重试一次，或者在设置页「按功能选模型」里给「翻译」另选一个型号。",
};
