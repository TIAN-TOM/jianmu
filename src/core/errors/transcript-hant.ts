// 取字幕服务的错误码给用户看的三段话，繁体这份。码和 detail 由简体那份（transcript.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy, SameDetails } from "./copy.ts";
import type { TranscriptDetails, TranscriptErrorCode } from "./transcript.ts";

const NOT_IMPORTED = "沒有匯入，原來的字幕沒動。";
const OTHER_FILE = "換一個 SRT 或 VTT 字幕檔案再匯入。";

export const TRANSCRIPT_ERROR_TEXT_HANT: Readonly<Record<TranscriptErrorCode, ErrorCopy>> = {
  NOT_CACHED: { cause: "這台電腦上還沒有這部影片的字幕。", impact: "這次沒有去影片網站讀取，不花額度。", next: "打開這部影片，讓簡幕先讀一次字幕。" },
  SUBTITLE_TRACK_MISSING: { cause: "沒找到這條字幕軌。", impact: "這次沒讀到，也沒傳給模型，不花額度。", next: "換一種字幕語言，或者稍後再試。" },
  SITE_UNSUPPORTED: { cause: "這個網站還不能讀取字幕。", impact: "什麼都沒讀。" },
  SUBTITLE_MISMATCH: {
    cause: "這條字幕的時間軸和影片長度對不上，可能不屬於這部影片。",
    impact: "簡幕沒有換上它，免得記到別的影片上。",
    next: "換回原來的語言，或者稍後再試。",
  },
  UNSUPPORTED_FILE: { cause: "只支援 .srt 和 .vtt 格式的字幕檔案。", impact: NOT_IMPORTED, next: OTHER_FILE },
  CACHE_WRITE_FAILED: {
    cause: "沒能清掉快取裡原來的字幕，瀏覽器的儲存空間可能滿了。",
    impact: "這次沒有修改，字幕還是原來的。",
    next: "到設定頁點選「清除快取」騰出空間再試。",
  },
};

export const TRANSCRIPT_DETAIL_TEXT_HANT: SameDetails<TranscriptDetails> = {
  UNSUPPORTED_FILE: {
    EMPTY_FILE: { cause: "字幕檔案是空的。", impact: NOT_IMPORTED, next: OTHER_FILE },
    FILE_TOO_LARGE: { cause: "字幕檔案太大了（超過 2 MB），不像是字幕。", impact: NOT_IMPORTED, next: "確認選的是字幕檔案，不是影片。" },
    TOO_MANY_ENTRIES: { cause: "字幕條目太多了，不像是一部影片的字幕。", impact: NOT_IMPORTED, next: "確認選的是這一部影片的字幕檔案。" },
    NO_CUES: { cause: "沒有從這個檔案裡讀出字幕。只支援 SRT 和 VTT 格式的文字字幕。", impact: NOT_IMPORTED, next: "確認檔案是文字字幕，不是圖片字幕或別的格式。" },
  },
};
