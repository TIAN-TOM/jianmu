// 播放页上简幕自己的字，繁体这份。形状由简体那份（text.ts）定。模块顶层只放字面量。
import type { ContentText } from "./text.ts";

export const CONTENT_HANT: ContentText = {
  noteTitle: "在目前時間點記一則筆記（快速鍵 n）",
  cardTitle: "簡幕總結卡片",
  reloadHint: "已更新，重新整理頁面後可用",
  reloadTitle: "簡幕已更新，重新整理頁面後可用",
  adPlaying: "正在播廣告",
  switching: "影片還在切換",
  saving: "正在儲存…",
  duplicate: "這裡已經記過了",
  savedUnpolished: "已儲存（沒潤飾）",
  saved: "已儲存",
  saveFailed: "儲存失敗",
  shortFailures: {
    NO_CAPTIONS: "沒有字幕",
    NEED_LOGIN: "要先登入",
    STORAGE_FULL: "空間不夠了",
    NOT_ENABLED: "還沒啟用",
  },
};
