// 取字幕服务自己的错误码：只读缓存时缓存里没有、点名的字幕轨不在了、这个网站还没接上读取、换的那条字幕对不上视频，
// 以及导入字幕文件时文件读不了、缓存里的旧字幕清不掉。
import type { DetailTable, ErrorCopy, SameDetails } from "./copy.ts";

export type TranscriptErrorCode =
  | "NOT_CACHED"
  | "SUBTITLE_TRACK_MISSING"
  | "SITE_UNSUPPORTED"
  | "SUBTITLE_MISMATCH"
  | "UNSUPPORTED_FILE"
  | "CACHE_WRITE_FAILED";

const NOT_IMPORTED = "没有导入，原来的字幕没动。";
const OTHER_FILE = "换一个 SRT 或 VTT 字幕文件再导入。";

export const TRANSCRIPT_ERROR_TEXT: Readonly<Record<TranscriptErrorCode, ErrorCopy>> = {
  NOT_CACHED: { cause: "这台电脑上还没有这个视频的字幕。", impact: "这次没有去视频网站读，不花额度。", next: "打开这个视频，让简幕先读一次字幕。" },
  SUBTITLE_TRACK_MISSING: { cause: "没找到这条字幕轨。", impact: "这次没读到，也没发给模型，不花额度。", next: "换一种字幕语言，或者稍后再试。" },
  SITE_UNSUPPORTED: { cause: "这个网站还不能读取字幕。", impact: "什么都没读。" },
  SUBTITLE_MISMATCH: {
    cause: "这条字幕的时间轴和视频时长对不上，可能不属于这个视频。",
    impact: "简幕没有换上它，免得记到别的视频上。",
    next: "换回原来的语言，或者稍后再试。",
  },
  UNSUPPORTED_FILE: { cause: "只支持 .srt 和 .vtt 格式的字幕文件。", impact: NOT_IMPORTED, next: OTHER_FILE },
  CACHE_WRITE_FAILED: {
    cause: "没能清掉缓存里原来的字幕，浏览器存储可能满了。",
    impact: "这次没有改，字幕还是原来的。",
    next: "到设置页点「清除缓存」腾出空间再试。",
  },
};

/** 字幕文件读不了的几种原因。原因一段和解析时给的说法一致。 */
const TRANSCRIPT_DETAILS = {
  UNSUPPORTED_FILE: {
    EMPTY_FILE: { cause: "字幕文件是空的。", impact: NOT_IMPORTED, next: OTHER_FILE },
    FILE_TOO_LARGE: { cause: "字幕文件太大了（超过 2 MB），不像是字幕。", impact: NOT_IMPORTED, next: "确认选的是字幕文件，不是视频。" },
    TOO_MANY_ENTRIES: { cause: "字幕条目太多了，不像是一个视频的字幕。", impact: NOT_IMPORTED, next: "确认选的是这一个视频的字幕文件。" },
    NO_CUES: { cause: "没有从这个文件里读出字幕。只支持 SRT 和 VTT 格式的文本字幕。", impact: NOT_IMPORTED, next: "确认文件是文本字幕，不是图片字幕或别的格式。" },
  },
} satisfies DetailTable<TranscriptErrorCode>;

/** 按 detail 换说法的码和 detail，英文、繁体那份照它对齐。 */
export type TranscriptDetails = typeof TRANSCRIPT_DETAILS;

export const TRANSCRIPT_DETAIL_TEXT: DetailTable<TranscriptErrorCode> = TRANSCRIPT_DETAILS;

const NOT_IMPORTED_EN = "Nothing was imported, and the existing subtitles haven't changed.";
const OTHER_FILE_EN = "Choose a different SRT or VTT subtitle file and import it.";

export const TRANSCRIPT_ERROR_TEXT_EN: Readonly<Record<TranscriptErrorCode, ErrorCopy>> = {
  NOT_CACHED: { cause: "This computer doesn't have subtitles for this video yet.", impact: "Jianmu didn't go to the video site this time, so no API credit was used.", next: "Open this video so Jianmu can read its subtitles first." },
  SUBTITLE_TRACK_MISSING: { cause: "This subtitle track couldn't be found.", impact: "Nothing was read or sent to the model, so no API credit was used.", next: "Choose a different subtitle language, or try again later." },
  SITE_UNSUPPORTED: { cause: "Jianmu can't read subtitles on this site yet.", impact: "Nothing was read." },
  SUBTITLE_MISMATCH: {
    cause: "This subtitle track's timing doesn't match the video's length, so it may belong to a different video.",
    impact: "Jianmu didn't switch to it, so it doesn't end up on the wrong video.",
    next: "Switch back to the original language, or try again later.",
  },
  UNSUPPORTED_FILE: { cause: "Only .srt and .vtt subtitle files are supported.", impact: NOT_IMPORTED_EN, next: OTHER_FILE_EN },
  CACHE_WRITE_FAILED: {
    cause: "Jianmu couldn't remove the old subtitles from the cache. The browser's storage may be full.",
    impact: "Nothing changed, and the subtitles are the same as before.",
    next: "Click “Clear cache” in settings to free up space, then try again.",
  },
};

export const TRANSCRIPT_DETAIL_TEXT_EN: SameDetails<typeof TRANSCRIPT_DETAILS> = {
  UNSUPPORTED_FILE: {
    EMPTY_FILE: { cause: "The subtitle file is empty.", impact: NOT_IMPORTED_EN, next: OTHER_FILE_EN },
    FILE_TOO_LARGE: { cause: "The subtitle file is too large (over 2 MB) to be subtitles.", impact: NOT_IMPORTED_EN, next: "Make sure you chose a subtitle file, not the video." },
    TOO_MANY_ENTRIES: { cause: "The file has too many entries to be subtitles for one video.", impact: NOT_IMPORTED_EN, next: "Make sure you chose the subtitle file for this video." },
    NO_CUES: { cause: "No subtitles could be read from this file. Only text subtitles in SRT or VTT format are supported.", impact: NOT_IMPORTED_EN, next: "Make sure the file is text subtitles, not image-based subtitles or another format." },
  },
};
