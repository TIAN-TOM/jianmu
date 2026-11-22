// 设置页「YouTube」一节的文案，繁体这份：只从 youtube-text.ts 引用，跟它一起只在构建开关 FEATURE_YOUTUBE 打开时进包。
// 模块顶层只放字面量和函数。
import type { YoutubeText } from "./youtube-text.ts";

export const YOUTUBE_HANT: YoutubeText = {
  title: "YouTube",
  hint: "啟用後，簡幕會在 YouTube 的觀看頁上讀取字幕和影片資訊，用法和 B 站一樣。讀取字幕時會替你打開影片頁上的轉錄稿。",
  disable: "停用",
  disableQuestion: "停用以後，已打開的 YouTube 頁面裡的簡幕會撤下，本機的筆記和概覽不會刪除。",
  disableConfirm: "停用",
  enable: "在 YouTube 上啟用",
  granted: "已啟用。已經開著的 YouTube 頁面不用重新整理。",
  declined: "沒有授權，暫時無法在 YouTube 上使用。",
  noPrompt: "沒能跳出授權提示，請稍後再試。",
  disabled: "已停用。",
  disableFailed: "沒能停用，請稍後再試。",
};
