// 翻译的错误码给用户看的三段话，繁体这份。码由简体那份（translate.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { TranslateErrorCode } from "./translate.ts";

export const TRANSLATE_ERROR_TEXT_HANT: Readonly<Record<TranslateErrorCode, ErrorCopy>> = {
  TRANSLATE_PARSE_FAILED: {
    cause: "模型沒有按要求的格式傳回譯文，結果讀不出來。",
    impact: "有一批字幕沒翻譯出來，請求已經發出去了，可能照樣計費；已經翻譯好的部分都還在。",
    next: "再試一次；老是這樣，就到設定頁「按功能選模型」替「翻譯」換個模型。",
  },
};
