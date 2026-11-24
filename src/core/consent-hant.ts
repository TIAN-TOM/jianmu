// 两份说明的繁体措辞：按条目的 kind:id 建表，和 consent.ts 里简体的 text、合成的 combined 逐项对应，意思不多不少。
// 只管显示，不进指纹，加繁体不用升版。解释当前画面那几条在 consent-frame-hant.ts。模块顶层只放字面量。
import type { ActivationHant, DataConsentHant } from "./consent.ts";

/** 数据说明的条目。 */
export const DATA_CONSENT_HANT: DataConsentHant = {
  "category:transcript": { text: "字幕文字" },
  "category:selection": { text: "你選取的文字" },
  "category:question": { text: "你的問題" },
  "category:video-title": { text: "影片標題" },
  "category:uploader-and-description": { text: "UP 主名稱或頻道名稱，和簡介" },
  "category:official-summary": { text: "「用官方總結寫結論」和粗篩用到的 B 站官方總結" },
  "category:api-key": { text: "你的 API 金鑰" },
  "purpose:ai-features": { text: "翻譯、概覽、一句話結論、選字解釋、筆記潤飾、問答和粗篩寫結論" },
  "recipient:chosen-provider": {
    text: "傳到你選的服務商網址，也可以是你自己電腦上的服務。開發者沒有伺服器，收不到這些內容；服務商怎麼處理，以它的隱私權政策為準",
  },
  "trigger:on-click": { text: "這些請求只在你點選按鈕時發出" },
  "category:imported-transcript": { text: "你匯入的字幕檔案裡的文字" },
  "category:video-duration": { text: "影片長度", combined: "影片標題和長度" },
  "trigger:auto-on-open-tabs": {
    text: "開啟「打開就出結論」以後，在 B 站和已啟用的 YouTube 上打開超過設定長度的影片，包括在背景打開、還沒切過去看的分頁和開啟這個選項時已經開著的，會自動傳送字幕、影片標題和長度、UP 主名稱或頻道名稱和簡介，生成概覽和一句話結論",
    combined:
      "平時只在你點選按鈕時發出；開啟「打開就出結論」以後，在 B 站和已啟用的 YouTube 上打開超過設定長度的影片，包括在背景打開、還沒切過去看的分頁和開啟這個選項時已經開著的，會自動傳送字幕、影片標題和長度、UP 主名稱或頻道名稱和簡介，生成概覽和一句話結論",
  },
  "purpose:tidy-transcript": {
    text: "整理字幕：點選「整理字幕」時傳送字幕和影片標題，替字幕補標點、改明顯的同音錯字",
    combined: "翻譯、整理字幕（補標點、改同音錯字）、概覽、一句話結論、選字解釋、筆記潤飾、問答和粗篩寫結論",
  },
  "trigger:keep-running": {
    text: "翻譯和整理字幕點了以後會在背景把整部影片分批傳送完，關掉側邊欄也會繼續，會接著用 API 額度；做完、你點選停止，或者影片所在的分頁換了影片或關掉時才停",
  },
};

/** 首次启用说明的条目。 */
export const ACTIVATION_HANT: ActivationHant = {
  "read:video-info": { text: "影片資訊：標題、作者和頻道、長度、簡介" },
  "read:transcript": {
    text: "字幕。YouTube 上讀取觀看頁轉錄稿面板裡顯示的內容，面板沒開時替你點開，打開就出結論、本視窗全部生成和卡片、側邊欄上的「生成概覽」點開的，讀完替你關上；頁面上沒有轉錄稿時，改用播放器取回的字幕（頁面裡的腳本留著播放器最近取回的兩份），需要時替你打開字幕、讀完關上；另外讀取播放器上已有的字幕軌清單，標出語言和是不是自動產生",
  },
  "read:official-summary": { text: "B 站官方總結和 UP 主分段" },
  "read:watch-state": { text: "觀看狀態：播放、暫停、累計播放時間" },
  "read:window-tabs": { text: "本視窗全部生成時，已授權網站分頁的網址和標題" },
  "read:watch-later": { text: "打開粗篩並點選讀取時，B 站稍後再看清單" },
  "purpose:display": { text: "在側邊欄和卡片裡顯示" },
  "purpose:pick-mode": { text: "按長度、頻道和播放情況選模式" },
  "purpose:material": { text: "作為之後生成和問答的材料" },
  "store:cache": { text: "字幕和影片資訊的快取，有期限和筆數上限，可以在設定頁清除" },
  "store:triage": { text: "粗篩讀到的清單和官方總結，有期限，可以在設定頁清除" },
  "store:saved": { text: "你儲存的概覽、問答、筆記和譯文長期留在本機，保留到你刪除為止" },
  "read:bili-login-state": { text: "B 站登入狀態：只看是否已登入，不讀取 Cookie 內容" },
  "read:watch-later-progress": { text: "粗篩讀到的稍後再看清單裡，每部影片看到哪裡" },
  "read:open-tabs": {
    text: "開啟「打開就出結論」以後，已授權網站各分頁的網址，用來認出打開的 B 站影片和已啟用的 YouTube 上的影片，包括在背景打開的",
  },
};

/** 没同意数据说明时给用户看的提示。 */
export const DATA_CONSENT_ERROR_HANT = "請先在設定頁「AI 服務」一節讀一下資料說明，勾選「我已了解」。";
