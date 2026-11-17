// 取字幕服务自己的错误码：只读缓存时缓存里没有、点名的字幕轨不在了、这个网站还没接上读取、换的那条字幕对不上视频，
// 以及导入字幕文件时文件读不了、缓存里的旧字幕清不掉。
import type { ErrorCopy } from "./copy.ts";

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
export const TRANSCRIPT_DETAIL_TEXT: Readonly<Partial<Record<TranscriptErrorCode, Readonly<Record<string, ErrorCopy>>>>> = {
  UNSUPPORTED_FILE: {
    EMPTY_FILE: { cause: "字幕文件是空的。", impact: NOT_IMPORTED, next: OTHER_FILE },
    FILE_TOO_LARGE: { cause: "字幕文件太大了（超过 2 MB），不像是字幕。", impact: NOT_IMPORTED, next: "确认选的是字幕文件，不是视频。" },
    TOO_MANY_ENTRIES: { cause: "字幕条目太多了，不像是一个视频的字幕。", impact: NOT_IMPORTED, next: "确认选的是这一个视频的字幕文件。" },
    NO_CUES: { cause: "没有从这个文件里读出字幕。只支持 SRT 和 VTT 格式的文本字幕。", impact: NOT_IMPORTED, next: "确认文件是文本字幕，不是图片字幕或别的格式。" },
  },
};
