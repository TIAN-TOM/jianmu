// 取字幕服务自己的错误码：只读缓存时缓存里没有、点名的字幕轨不在了、这个网站还没接上读取、换的那条字幕对不上视频，
// 以及导入字幕文件时文件读不了、缓存里的旧字幕清不掉。

export type TranscriptErrorCode =
  | "NOT_CACHED"
  | "SUBTITLE_TRACK_MISSING"
  | "SITE_UNSUPPORTED"
  | "SUBTITLE_MISMATCH"
  | "UNSUPPORTED_FILE"
  | "CACHE_WRITE_FAILED";

export const TRANSCRIPT_ERROR_TEXT: Readonly<Record<TranscriptErrorCode, string>> = {
  NOT_CACHED: "本机还没有这个视频的字幕。",
  SUBTITLE_TRACK_MISSING: "没有找到这条字幕轨，可以换一条语言或稍后重试。",
  SITE_UNSUPPORTED: "这个网站还不能读取字幕。",
  SUBTITLE_MISMATCH: "这条字幕的时间轴和视频时长对不上，可能不属于这个视频。可以换回原来的语言，或稍后重试。",
  UNSUPPORTED_FILE: "只支持 .srt 和 .vtt 格式的字幕文件。",
  CACHE_WRITE_FAILED: "没能清掉缓存里原来的字幕，这次没有改。浏览器存储可能满了，清理一下再试。",
};

/** 字幕文件读不了的几种原因，和解析时给的说法一致。 */
export const TRANSCRIPT_DETAIL_TEXT: Readonly<Partial<Record<TranscriptErrorCode, Readonly<Record<string, string>>>>> = {
  UNSUPPORTED_FILE: {
    EMPTY_FILE: "字幕文件是空的。",
    FILE_TOO_LARGE: "字幕文件太大了（超过 2 MB），不像是字幕。",
    TOO_MANY_ENTRIES: "字幕条目太多了，不像是一个视频的字幕。",
    NO_CUES: "没有从这个文件里读出字幕。只支持 SRT 和 VTT 格式的文本字幕。",
  },
};
