// 字幕结果的来源标记和界面文案。后台组装、侧边栏和导出都按它注明来源，用的是同一句话。
import type { OutputLang } from "../output-lang.ts";

// 一份字幕的来源类别：人工、平台自动、官方总结附带、用户导入，以及读到了正文但确认不了是人工还是自动的。
export type CaptionKind = "human" | "auto" | "official-ai" | "imported" | "unconfirmed";

// 播放器一条字幕都没有、改用官方总结附带的 AI 字幕时记这个值。
export const OFFICIAL_SUBTITLE_SOURCE = "official-summary";
export const OFFICIAL_SUBTITLE_LABEL = "B站官方总结里的 AI 字幕";

// 用户自己导入的字幕文件（SRT、VTT）。按视频存在本机，有它时优先用它，不再向平台取字幕。
export const IMPORTED_SUBTITLE_SOURCE = "imported-file";
export const IMPORTED_SUBTITLE_LABEL = "导入的字幕文件";

// 存下来的名字是中文这份；英文界面显示时换成这里的。
const SOURCE_LABELS_EN: Readonly<Partial<Record<CaptionKind, string>>> = {
  "official-ai": "AI subtitles from the Bilibili official summary",
  imported: "Imported subtitle file",
};

/** 简幕替官方总结字幕和导入文件起的名字按界面语言出；中文界面和别的来源回 null，照存下来的名字显示。 */
export function sourceLabel(kind: CaptionKind | undefined, lang: OutputLang): string | null {
  return lang === "en" && kind ? (SOURCE_LABELS_EN[kind] ?? null) : null;
}
