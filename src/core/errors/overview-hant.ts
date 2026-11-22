// 概览的错误码给用户看的三段话，繁体这份。码由简体那份（overview.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { OverviewErrorCode } from "./overview.ts";

const MAYBE_BILLED = "這次沒拿到結果，請求已經發出去了，可能照樣計費；原來存下的內容都還在。";
const SWITCH_MODEL = "再試一次；老是這樣，就到設定頁「按功能選模型」替「概覽」換個模型。";

export const OVERVIEW_ERROR_TEXT_HANT: Readonly<Record<OverviewErrorCode, ErrorCopy>> = {
  NO_TRANSCRIPT: {
    cause: "這部影片沒有可用的字幕。",
    impact: "無法生成概覽，也沒花額度。",
    next: "手上有這部影片的字幕檔案的話，可以在側邊欄點選「匯入字幕檔案」；在播放頁卡片上要先點選「打開側邊欄」。",
  },
  EMPTY_ANALYSIS: { cause: "模型沒有寫出有效的章節或金句。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  ANALYSIS_PARSE_FAILED: { cause: "模型沒有按要求的格式傳回概覽，結果讀不出來。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  NO_ANALYSIS: { cause: "還沒有可以補的概覽。", next: "先點選「生成概覽」。" },
  FAILED_CHUNKS_MISMATCH: {
    cause: "目前的字幕或語言和這份概覽對不上。",
    impact: "無法只補失敗的部分，這次沒花額度。",
    next: "點選「重新生成」生成整份概覽。",
  },
  NO_OFFICIAL_SUMMARY: {
    cause: "這部影片沒有官方總結。",
    impact: "無法據此寫結論，這次沒花額度。",
    next: "可以在側邊欄點選「生成概覽」，從字幕寫結論。",
  },
  EMPTY_VERDICT: { cause: "模型沒有寫出有效的結論。", impact: MAYBE_BILLED, next: "再試一次。" },
  WHOLE_CHUNK_TOO_BIG: {
    cause: "「盡量整份」把整段字幕一次交給模型，這次逾時了，或者模型一次裝不下。",
    impact: MAYBE_BILLED,
    next: "到設定頁「概覽分塊」換回「自動」或「較長」，再點選「生成概覽」。",
  },
};
