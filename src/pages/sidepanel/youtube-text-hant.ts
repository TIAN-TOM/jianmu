// 侧边栏没认出视频时 YouTube 那一份的文案，繁体这份：只从 youtube-text.ts 引用，跟它一起只在构建开关 FEATURE_YOUTUBE 打开时进包。
// 模块顶层只放字面量和函数。
import type { YoutubeText } from "./youtube-text.ts";

export const YOUTUBE_HANT: YoutubeText = {
  title: "打開一部 B 站或 YouTube 影片",
  ready: "在影片播放頁打開側邊欄，就能讀字幕、生成概覽、提問和記筆記。",
  impact: "B 站影片頁直接就能用。YouTube 要先啟用，簡幕才讀得到它的頁面。",
  enable: "在 YouTube 上啟用",
  toSettings: "到設定頁啟用",
  declined: "沒有授權，暫時無法在 YouTube 上使用。授權提示沒有跳出來的話，請到設定頁啟用。",
  noPrompt: "這裡無法跳出授權提示，請到設定頁啟用。",
};
