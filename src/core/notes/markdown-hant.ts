// 笔记和学习稿 Markdown 导出的固定文字，繁体这份。形状由 markdown.ts 里简体那份定，少一条、多一条或签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { MarkdownText } from "./markdown.ts";

export const MARKDOWN_HANT: MarkdownText = {
  untitled: "未命名影片",
  tag: "簡幕",
  officialHeading: "## B 站官方總結",
  officialSource: "> 來源：B 站官方 AI 總結，由 B 站生成，不是你設定的模型。",
  untitledSection: "（這一段沒有標題）",
  creatorHeading: "## UP 主分段",
  creatorSource: "> 來源：UP 主在 B 站替影片劃分的章節。",
  section: (index) => `第 ${index} 段`,
  modelWroteChapters: "> 以下章節和金句由你設定的 AI 模型根據字幕生成。",
  modelWroteAll: "> 以下結論、章節和金句由你設定的 AI 模型根據字幕生成。",
  incomplete: "> **概覽內容不完整**：以下時間段生成失敗，章節和金句裡沒有這幾段的內容。",
  failureReason: (reason) => `：${reason}`,
  verdictHeading: "## 一句話結論",
  verdictFromOfficial: "*這則結論由你設定的 AI 模型根據 B 站官方總結寫成，不是根據字幕。*",
  verdictIncomplete: "*這則結論只根據概覽裡已有的部分，缺少的時間段的內容沒有算進去。*",
  value: (text) => `- 核心價值：${text}`,
  reason: (text) => `- 判斷理由：${text}`,
  keyMark: "（重點）",
  overviewHeading: "## 影片概覽",
  chaptersHeading: "## 章節",
  quotesHeading: "## 金句",
  notesHeading: "## 我的時間戳記筆記",
  fileNotes: "筆記",
  fileLearning: "學習稿",
};
