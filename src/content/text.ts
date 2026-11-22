// 播放页上简幕自己的字：笔记图标的悬停提示、点了以后闪的一句、卡片框架的名字、扩展更新后的提示。简体、英文、繁体（text-hant.ts）三份，简体那份定形状。
// 解释当前画面那个图标的字只在构建开关打开时进包，放在 frame-icon.ts 里，不放这里。模块顶层只放字面量和函数。
import type { ErrorCode } from "../core/errors.ts";
import { inLang, type OutputLang } from "../core/output-lang.ts";
import { CONTENT_HANT } from "./text-hant.ts";

const CONTENT_ZH = {
  noteTitle: "在当前时间点记一条笔记（快捷键 n）",
  cardTitle: "简幕总结卡片",
  reloadHint: "已更新，刷新页面后可用",
  reloadTitle: "简幕已更新，刷新页面后可用",
  adPlaying: "正在播广告",
  switching: "视频还在切换",
  saving: "保存中…",
  duplicate: "该时刻已有笔记",
  savedUnpolished: "已保存，未润色",
  saved: "已保存",
  saveFailed: "保存失败",
  // 保存失败的常见原因给个短说法，完整说明放在悬停提示里。
  shortFailures: {
    NO_CAPTIONS: "无字幕",
    NEED_LOGIN: "需登录",
    STORAGE_FULL: "空间不足",
    NOT_ENABLED: "未启用",
  } satisfies Partial<Record<ErrorCode, string>>,
};

export type ContentText = typeof CONTENT_ZH;

const CONTENT_EN: ContentText = {
  noteTitle: "Add a note at the current time (shortcut: n)",
  cardTitle: "Jianmu summary card",
  reloadHint: "Updated. Refresh the page to use it",
  reloadTitle: "Jianmu was updated. Refresh the page to use it",
  adPlaying: "Ad playing",
  switching: "Video still switching",
  saving: "Saving…",
  duplicate: "Already a note here",
  savedUnpolished: "Saved, not polished",
  saved: "Saved",
  saveFailed: "Couldn't save",
  shortFailures: {
    NO_CAPTIONS: "No subtitles",
    NEED_LOGIN: "Sign in first",
    STORAGE_FULL: "Out of space",
    NOT_ENABLED: "Not turned on",
  },
};

export const contentText = (lang: OutputLang = "zh"): ContentText => inLang(lang, CONTENT_ZH, CONTENT_EN, CONTENT_HANT);
