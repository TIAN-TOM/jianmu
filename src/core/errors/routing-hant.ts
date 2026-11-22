// 后台路由的错误码给用户看的三段话，繁体这份。码由简体那份（routing.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { RoutingErrorCode } from "./routing.ts";

const NOT_ABOUT_ACCOUNTS = "這和影片網站的帳號、模型服務的金鑰和網路都無關。";

export const ROUTING_ERROR_TEXT_HANT: Readonly<Record<RoutingErrorCode, ErrorCopy>> = {
  FORBIDDEN: { cause: "這個頁面不能做這件事。", impact: "什麼都沒做。" },
  UNKNOWN_ROUTE: {
    cause: "簡幕的背景程式還是舊版本，不認得這個請求。",
    impact: "什麼都沒做，筆記和概覽不會遺失。",
    next: "重新載入簡幕後再試。",
  },
  NOT_ENABLED: { cause: "還沒啟用簡幕。", impact: "什麼都沒讀，也沒傳給模型。", next: "在側邊欄或設定頁點選「啟用簡幕」。" },
  INVALID_REQUEST: { cause: "請求的內容不對。", impact: "沒有處理。", next: "關掉這個頁面重新打開，再試一次。" },
  CARD_DISABLED: { cause: "播放頁卡片已經在設定裡關掉了。", next: "要用的話，到設定頁的「播放頁」一節打開，或者直接用側邊欄。" },
  STORAGE_FULL: {
    cause: "瀏覽器給擴充功能的儲存空間滿了。",
    impact: "這次的內容沒有存進去，已經存下的不受影響。",
    next: "到設定頁點選「清除快取」騰出空間再試，筆記和概覽會留著。",
  },
  BACKGROUND_FAILED: { cause: "簡幕的背景程式出了問題。", impact: "這件事沒有做完。", next: "稍後再試。" },
  BACKGROUND_UNREACHABLE: {
    cause: "簡幕的背景程式沒有回應，請求沒送出去。",
    impact: `沒傳給模型，不花額度。${NOT_ABOUT_ACCOUNTS}`,
    next:
      "到瀏覽器的擴充功能管理頁把簡幕關掉再打開，這樣不會刪掉筆記和概覽，然後再試一次。"
      + "還不行、要移除重新安裝的話，先在設定頁點選「匯出備份」存成檔案：移除會清空這台電腦上的全部筆記和概覽，重新安裝後再用「還原備份」匯回來。",
  },
  BACKGROUND_DROPPED: {
    cause: "簡幕的背景程式處理到一半斷開了，沒收到結果。",
    impact: `請求可能已經傳給了模型，用到模型的操作可能照樣計費。${NOT_ABOUT_ACCOUNTS}`,
    next: "先別急著重試，過一會兒重新打開這部影片，看看結果有沒有存下來。",
  },
};
