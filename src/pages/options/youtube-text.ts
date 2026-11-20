// 设置页「YouTube」一节的文案：只在构建开关 FEATURE_YOUTUBE 打开时进包，只从 youtube-section.tsx 引用。模块顶层只放字面量和函数。
import type { UiLang } from "../shared/ui-lang.ts";

const YOUTUBE_ZH = {
  title: "YouTube",
  hint: "启用后，简幕在 YouTube 的观看页上读字幕和视频信息，用法和 B 站一样。读字幕时会替你点开视频页上的文字稿。",
  disable: "停用",
  disableQuestion: "停用以后，已开的 YouTube 页面里简幕会撤下，本机的笔记和概览不删。",
  disableConfirm: "停用",
  enable: "在 YouTube 上启用",
  granted: "已启用。已经开着的 YouTube 页面不用刷新。",
  declined: "没有授权，YouTube 上暂时用不了。",
  noPrompt: "没能弹出授权框，请稍后再试。",
  disabled: "已停用。",
  disableFailed: "没能停用，请稍后再试。",
};

export type YoutubeText = typeof YOUTUBE_ZH;

const YOUTUBE_EN: YoutubeText = {
  title: "YouTube",
  hint: "Once it's turned on, Jianmu reads subtitles and video details on YouTube watch pages and works the same way as on Bilibili. To read subtitles, it opens the transcript on the video page for you.",
  disable: "Turn off",
  disableQuestion: "Jianmu will be removed from any open YouTube pages. Notes and overviews on this computer are kept.",
  disableConfirm: "Turn off",
  enable: "Turn on for YouTube",
  granted: "Turned on. YouTube pages that are already open don't need a refresh.",
  declined: "Access wasn't granted, so Jianmu can't be used on YouTube for now.",
  noPrompt: "Couldn't show the permission prompt. Try again later.",
  disabled: "Turned off.",
  disableFailed: "Couldn't turn it off. Try again later.",
};

export const youtubeText = (lang: UiLang = "zh"): YoutubeText => (lang === "en" ? YOUTUBE_EN : YOUTUBE_ZH);
