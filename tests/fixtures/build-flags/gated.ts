// 裁剪探针：每个开关保护一段内容，只从 probe.ts 里对应开关的分支引用。标记字符串在包里出现，就是这段内容进了包。
export const FRAME_EXPLAIN_PROBE = "flag-probe:frameExplain";
export const YOUTUBE_OPEN_PANEL_PROBE = "flag-probe:youtubeOpenPanel";
export const YOUTUBE_SWITCH_LANG_PROBE = "flag-probe:youtubeSwitchLang";

export function frameExplainRoute(): string {
  return `${FRAME_EXPLAIN_PROBE}:route`;
}
