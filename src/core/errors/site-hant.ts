// 站点读取的错误码给用户看的三段话，繁体这份。码和 detail 由简体那份（site.ts）定，少一条、多一条，类型检查就报错。
// 教用户点 YouTube 页面上的按钮时，用 YouTube 台湾界面上的叫法。
import type { ErrorCopy, SameDetails } from "./copy.ts";
import type { SiteDetails, SiteErrorCode } from "./site.ts";

const NOT_READ = "這次沒讀到，也沒傳給模型，不花額度。";
const IMPORT_FILE = "手上有這部影片的字幕檔案的話，可以在側邊欄點選「匯入字幕檔案」；在播放頁卡片上要先點選「打開側邊欄」。";

export const SITE_ERROR_TEXT_HANT: Readonly<Record<SiteErrorCode, ErrorCopy>> = {
  NEED_LOGIN: { cause: "這個瀏覽器還沒登入影片網站。", impact: "字幕、官方總結和稍後再看只開放給已登入的使用者讀取，這次都沒讀。", next: "登入以後再試，或者匯入自己的字幕檔案。" },
  NO_CAPTIONS: { cause: "這部影片沒有可用的字幕。", impact: NOT_READ, next: IMPORT_FILE },
  EMPTY_CAPTION_FILE: { cause: "影片網站給的字幕檔案是空的。", impact: NOT_READ, next: `稍後再試。${IMPORT_FILE}` },
  RATE_LIMITED: { cause: "影片網站暫時限制了讀取。", impact: "簡幕先停下，不會反覆去試，這次沒花額度。", next: "過幾分鐘再試。" },
  UNPLAYABLE: { cause: "這部影片現在看不了。", impact: "簡幕沒有讀取它的內容。" },
  NOT_FOUND: { cause: "找不到這部影片，可能已經刪除或者不公開了。", impact: "簡幕沒有讀取它的內容。" },
  SEGMENT_OUT_OF_RANGE: { cause: "影片裡沒有這一 P。", impact: "簡幕沒有讀取它的內容。", next: "重新整理影片頁，從分 P 清單裡重新選。" },
  VIDEO_CHANGED: {
    cause: "頁面上的影片已經換了。",
    impact: "這次讀到的內容沒有用，免得記到別的影片上。",
    next: "回到原來的影片再試，或者在新影片上重新開始。",
  },
  TAB_NOT_READY: { cause: "影片頁還沒載入好。", impact: NOT_READ, next: "等頁面載入完再試，還不行就重新整理影片頁。" },
  MALFORMED: { cause: "影片網站傳回的內容簡幕讀不懂。", impact: NOT_READ, next: "稍後再試；一直這樣，可能是網站改版了，等簡幕更新。" },
  NETWORK: { cause: "連不上影片網站。", impact: NOT_READ, next: "檢查一下網路再試。" },
  TIMEOUT: { cause: "讀取影片網站逾時了。", impact: NOT_READ, next: "稍後再試。" },
  PAGE_ACTION_NEEDED: {
    cause: "影片頁上的轉錄稿還沒打開。",
    impact: NOT_READ,
    next: "在影片簡介下面打開轉錄稿（YouTube 上寫作「顯示轉錄稿」或 Show transcript），等文字出來，再點選讀取。",
  },
  UNAVAILABLE: { cause: "暫時讀不到這部影片的字幕。", impact: NOT_READ, next: `稍後再試。${IMPORT_FILE}` },
};

export const SITE_DETAIL_TEXT_HANT: SameDetails<SiteDetails> = {
  PAGE_ACTION_NEEDED: {
    reopen: {
      cause: "影片頁上的轉錄稿是簡幕連上之前打開的，認不出是不是這部影片的。",
      impact: NOT_READ,
      next: "重新整理影片頁，再打開轉錄稿，等文字出來，再點選讀取。",
    },
    filtered: { cause: "影片頁上的轉錄稿裡有搜尋字詞，只顯示了一部分。", impact: NOT_READ, next: "清掉轉錄稿上方搜尋框裡的字，再點選讀取。" },
    ad: { cause: "影片正在播廣告。", impact: "簡幕這時什麼都沒讀。", next: "等廣告播完，再點選讀取。" },
    chapters: { cause: "影片頁上的面板現在顯示的是章節，不是轉錄稿。", impact: NOT_READ, next: "在面板上方切到「轉錄稿」（Transcript）那一頁，等文字出來，再點選讀取。" },
  },
  UNAVAILABLE: {
    stale: { cause: "影片頁上的轉錄稿還沒換成這部影片的。", impact: "讀到的內容沒有用，免得記到別的影片上。", next: "重新整理影片頁，再打開轉錄稿，然後點選讀取。" },
    "no-entry": { cause: "這個影片頁上找不到轉錄稿。", impact: NOT_READ, next: `有的影片播放器裡有字幕，頁面上卻沒有轉錄稿，簡幕只讀轉錄稿；也可能是頁面改版了。${IMPORT_FILE}` },
    "no-page": { cause: "要在影片頁上讀取，可是這時連不上影片頁。", impact: NOT_READ, next: "回到影片頁，在側邊欄點選讀取；還不行就重新整理影片頁。" },
  },
  UNPLAYABLE: {
    paid: { cause: "這是付費內容。", impact: "簡幕不讀取付費內容，什麼都沒讀，也沒傳給模型。" },
  },
};
