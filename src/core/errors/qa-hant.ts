// 问答和选字解释的错误码给用户看的三段话，繁体这份。码由简体那份（qa.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { QaErrorCode } from "./qa.ts";

export const QA_ERROR_TEXT_HANT: Readonly<Record<QaErrorCode, ErrorCopy>> = {
  EMPTY_QUESTION: { cause: "問題是空的。", next: "先輸入問題。" },
  QUESTION_TOO_LONG: { cause: "問題超過了 2000 個字元。", impact: "沒有傳送出去，不花額度。", next: "刪短一點再問。" },
  QA_INPUT_TOO_LONG: {
    cause: "要傳送的字幕太長，這個模型一次裝不下，縮小範圍以後還是被服務拒絕了。",
    impact: "這次沒拿到回答。",
    next: "到設定頁「按功能選模型」替「問答」換一個上下文更長的模型，或者把問題問得具體一點。",
  },
  QA_PARSE_FAILED: {
    cause: "模型沒有按要求的格式回答，結果讀不出來。",
    impact: "這次沒拿到回答，請求已經發出去了，可能照樣計費。",
    next: "再試一次；老是這樣，就到設定頁「按功能選模型」替「問答」換個模型。",
  },
  EMPTY_SELECTION: { cause: "沒有選取任何文字。", next: "先在字幕裡選取要解釋的文字。" },
};
