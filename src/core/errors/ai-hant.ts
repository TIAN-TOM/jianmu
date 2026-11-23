// 模型服务的错误码给用户看的三段话，繁体这份。码由简体那份（ai.ts）定，少一条、多一条，类型检查就报错。
import type { AiErrorCode } from "./ai.ts";
import type { ErrorCopy } from "./copy.ts";

const NOT_SENT = "這次沒有發出請求，不花額度。";
const NO_RESULT = "這次沒拿到結果，原來存下的內容都還在。";
const MAYBE_BILLED = "這次沒拿到結果，請求已經發出去了，可能照樣計費；原來存下的內容都還在。";
const THINKING_EXHAUSTED = "模型把輸出額度都用在思考上了，還沒寫出回覆。";
const SWITCH_MODEL = "再試一次；老是這樣，就到設定頁換個模型。";

export const AI_ERROR_TEXT_HANT: Readonly<Record<AiErrorCode, ErrorCopy>> = {
  NO_AI_CONFIG: { cause: "AI 服務還沒設定好。", impact: NOT_SENT, next: "到設定頁填好服務商、金鑰和模型，再點選「儲存並授權」。" },
  NO_DATA_CONSENT: { cause: "還沒同意資料說明。", impact: "沒有任何內容傳給模型服務。", next: "到設定頁讀一下資料說明，勾選「我已了解」。" },
  NEED_HOST_PERMISSION: {
    cause: "簡幕還沒取得存取這個 API 網址的權限。",
    impact: NOT_SENT,
    next: "到設定頁點選「儲存並授權」，瀏覽器詢問的時候選允許。",
  },
  INVALID_BASE_URL: { cause: "API 網址不對。", impact: NOT_SENT, next: "到設定頁檢查一下 API 網址。" },
  INVALID_AI_KEY: { cause: "AI 服務不接受這把金鑰。", impact: NO_RESULT, next: "到設定頁檢查金鑰，看它和 API 網址是不是同一家服務商的。" },
  AI_LOCAL_ORIGIN_REJECTED: {
    cause: "本機的模型服務拒絕了來自瀏覽器擴充功能的請求，和金鑰無關。",
    impact: NO_RESULT,
    next: "用的是 Ollama 的話，在啟動它的環境裡把 OLLAMA_ORIGINS 設成 chrome-extension://*，再重新啟動 Ollama。",
  },
  MODEL_OR_ENDPOINT_NOT_FOUND: {
    cause: "AI 服務找不到這個模型或端點。",
    impact: NO_RESULT,
    next: "到設定頁核對模型名稱和 API 網址，可以點選「取得模型清單」從裡面挑。",
  },
  AI_RATE_LIMITED: { cause: "AI 服務限流了，也可能是帳戶額度用完了。", impact: NO_RESULT, next: "等幾分鐘再試；一直這樣，就到服務商後台看看額度。" },
  AI_SERVICE_BUSY: { cause: "AI 服務那邊暫時忙碌或出錯。", impact: NO_RESULT, next: "稍後再試。" },
  AI_SERVICE_ERROR: { cause: "AI 服務那邊出錯了。", impact: NO_RESULT, next: "稍後再試；一直這樣，到設定頁點選「測試連線」看看具體原因。" },
  AI_NETWORK_ERROR: {
    cause: "連不上 AI 服務。",
    impact: NO_RESULT,
    next: "檢查一下網路，再到設定頁核對 API 網址；學校、公司的網路可能擋了這個服務，可以換個網路再試。",
  },
  AI_REDIRECT_BLOCKED: {
    cause: "API 網址把請求轉到了別的地方。",
    impact: "為了不把金鑰帶出去，簡幕沒有跟過去，這次沒拿到結果。",
    next: "到設定頁把 API 網址改成服務商給的最終網址。",
  },
  ANTHROPIC_WORKSPACE_REQUIRED: {
    cause: "這把金鑰沒有限定工作區，服務不接受。",
    impact: NO_RESULT,
    next: "到服務商後台建立一把限定了工作區的金鑰，填到設定頁。",
  },
  AI_HARD_TIMEOUT: { cause: "模型太久沒有回應，簡幕把這次請求停了。", impact: MAYBE_BILLED, next: "稍後再試；老是這樣，就到設定頁換個快一點的模型。" },
  AI_IDLE_TIMEOUT: { cause: "模型的回覆寫到一半斷了。", impact: MAYBE_BILLED, next: "再試一次。" },
  AI_REFUSED: { cause: "模型拒絕了這次請求。", impact: MAYBE_BILLED, next: "到設定頁換個模型再試，同一個模型重試多半還是一樣。" },
  EMPTY_AI_RESPONSE: { cause: "模型沒有寫出內容。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  AI_RESPONSE_TOO_LARGE: { cause: "模型的回覆太大，簡幕沒有收下。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  AI_RESPONSE_TRUNCATED: { cause: "模型的回覆沒寫完就停了。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  AI_THINKING_EXHAUSTED: {
    cause: THINKING_EXHAUSTED,
    impact: MAYBE_BILLED,
    next: "到設定頁「推理強度」替這項功能調低一級再試；或者在「按功能選模型」裡替它換個型號。",
  },
  AI_THINKING_EXHAUSTED_LOCKED: {
    cause: THINKING_EXHAUSTED,
    impact: MAYBE_BILLED,
    next: "這個型號要想多久，簡幕調不了；到設定頁「按功能選模型」替這項功能換個型號再試。",
  },
  TASK_CANCELED: { cause: "已經停下了。", impact: "已經發出去的請求可能照樣計費。" },
  AI_REQUEST_FAILED: { cause: "AI 請求沒有成功。", impact: NO_RESULT, next: "稍後再試。" },
};
