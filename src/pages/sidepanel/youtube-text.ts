// 侧边栏没认出视频时 YouTube 那一份的文案：只在构建开关 FEATURE_YOUTUBE 打开时进包，只从 youtube-gate.tsx 引用。
// 模块顶层只放字面量和函数。
import { inLang, type UiLang } from "../shared/ui-lang.ts";
import { YOUTUBE_HANT } from "./youtube-text-hant.ts";

const YOUTUBE_ZH = {
  title: "打开一个 B 站或 YouTube 视频",
  ready: "在视频播放页打开侧边栏，就能读字幕、生成概览、提问和记笔记。",
  impact: "B 站视频页直接能用。YouTube 要先启用，简幕才读得到它的页面。",
  enable: "在 YouTube 上启用",
  toSettings: "到设置页启用",
  declined: "没有授权，YouTube 上暂时用不了。授权框没弹出来的话，到设置页启用。",
  noPrompt: "这里弹不出授权框，请到设置页启用。",
};

export type YoutubeText = typeof YOUTUBE_ZH;

const YOUTUBE_EN: YoutubeText = {
  title: "Open a Bilibili or YouTube video",
  ready: "Open the side panel on a video page to read subtitles, generate an overview, ask questions and take notes.",
  impact: "Bilibili video pages work straight away. YouTube needs to be turned on first so Jianmu can read its pages.",
  enable: "Turn on for YouTube",
  toSettings: "Turn on in settings",
  declined: "Access wasn't granted, so Jianmu can't be used on YouTube for now. If the permission prompt didn't appear, turn it on in settings.",
  noPrompt: "The permission prompt can't be shown here. Turn it on in settings instead.",
};

export const youtubeText = (lang: UiLang): YoutubeText => inLang(lang, YOUTUBE_ZH, YOUTUBE_EN, YOUTUBE_HANT);
