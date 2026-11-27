// 笔记和学习稿的导出按语言出固定文字：缺省和选中文时逐字一样；英文时小标题、来源说明和标记是英文，
// 模型写的内容、官方总结、UP 主分段和用户自己的笔记原样写。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { learningAsMarkdown, markdownFallbackName, notesAsMarkdown, type LearningInput } from "../../../../src/core/notes/markdown.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { linkFromBase } from "../../../helpers/video-link.ts";

const VIDEO_BASE = "https://video.example/";
const LINK = linkFromBase(VIDEO_BASE);
const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample000" });

const INPUT: LearningInput = {
  title: "",
  author: "样例作者",
  videoKey: KEY,
  exportedAt: 0,
  analysis: {
    chapters: [
      { title: "样例章节一", summary: "样例章节摘要", timestamp: "0:00", timestampSeconds: 0 },
      { title: "样例章节二", summary: "", timestamp: "1:00", timestampSeconds: 60 },
    ],
    keyQuotes: [{ quote: "样例金句", timestamp: "0:10", timestampSeconds: 10 }],
    verdict: { verdict: "可以跳过", summary: "样例结论", value: "样例价值", reason: "样例理由", source: "official", incomplete: true, keyStarts: [60] },
  },
  analysisFailures: [{ startSeconds: 120, endSeconds: 180, reason: "样例原因" }],
  officialSummary: { summary: "样例官方总结", outline: [{ title: "", timestamp: 0, points: [] }] },
  creatorChapters: [{ start: 30, title: "" }],
  notes: [{ id: "n1", kind: "note", origin: "user", video: KEY, snapshot: { title: "", author: "" }, atSec: 5, text: "样例笔记", createdAt: 1, updatedAt: 1 } as NoteRecord],
};

test("学习稿：不传语言和传中文逐字一样", () => {
  const zh = learningAsMarkdown(INPUT, LINK);
  assert.equal(learningAsMarkdown(INPUT, LINK, "zh"), zh);
  for (const line of ["## B站官方总结", "## UP 主分段", "## 一句话结论", "**★☆☆☆☆ 可跳过**", "## 视频概览", "## 章节", "## 我的时间戳笔记", "  - 简幕", "title: BV1Sample000"]) {
    assert.ok(zh.includes(line), line);
  }
});

test("学习稿：英文时固定文字是英文，档位写英文名，内容原样", () => {
  const en = learningAsMarkdown(INPUT, LINK, "en");
  for (const line of [
    "## Bilibili official summary",
    "> Source: Bilibili's official AI summary. Bilibili generated it, not the model you set up.",
    "### [0:00](https://video.example/BV1Sample000) (Untitled section)",
    "## Creator chapters",
    "- [0:30](https://video.example/BV1Sample000?t=30) Section 1",
    "> The chapters and key quotes below were generated from the subtitles by the AI model you set up.",
    "> **Incomplete overview**: these time ranges failed to generate, so the chapters and key quotes don't cover them.",
    "> - 2:00–3:00: 样例原因",
    "## One-line verdict",
    "**★☆☆☆☆ Skip**",
    "- Core value: 样例价值",
    "- Reasoning: 样例理由",
    "## Video overview",
    "样例章节二 (key)",
    "## Chapters",
    "## My timestamped notes",
    "  - jianmu",
    "样例官方总结",
    "样例笔记",
  ]) {
    assert.ok(en.includes(line), line);
  }
  assert.doesNotMatch(en.replace(/样例[^\n\]*(]*/g, ""), /[一-鿿]/, "固定文字里不剩中文");
});

test("笔记导出：没有标题时的名字按语言写，中文照旧", () => {
  const notes = INPUT.notes ?? [];
  const zh = notesAsMarkdown(notes, LINK);
  assert.equal(notesAsMarkdown(notes, LINK, { lang: "zh" }), zh);
  assert.ok(zh.startsWith("# BV1Sample000\n"));
  const untitled = [{ ...(notes[0] as NoteRecord), video: "" as typeof KEY }];
  assert.ok(notesAsMarkdown(untitled, LINK).startsWith("# 未命名视频\n"));
  assert.ok(notesAsMarkdown(untitled, LINK, { lang: "en" }).startsWith("# Untitled video\n"));
});

test("导出文件在没有标题时的名字：中文照旧，英文是英文", () => {
  assert.deepEqual([markdownFallbackName("notes"), markdownFallbackName("learning")], ["笔记", "学习稿"]);
  assert.deepEqual([markdownFallbackName("notes", "en"), markdownFallbackName("learning", "en")], ["notes", "study notes"]);
});

test("学习稿和笔记：繁体时固定文字是繁体，档位写繁体名，内容原样", () => {
  const hant = learningAsMarkdown(INPUT, LINK, "zh-Hant");
  for (const line of [
    "## B 站官方總結",
    "> 來源：B 站官方 AI 總結，由 B 站生成，不是你設定的模型。",
    "### [0:00](https://video.example/BV1Sample000) （這一段沒有標題）",
    "## UP 主分段",
    "- [0:30](https://video.example/BV1Sample000?t=30) 第 1 段",
    "> 以下章節和金句由你設定的 AI 模型根據字幕生成。",
    "> **概覽內容不完整**：以下時間段生成失敗，章節和金句裡沒有這幾段的內容。",
    "## 一句話結論",
    "**★☆☆☆☆ 可跳過**",
    "- 核心價值：样例价值",
    "- 判斷理由：样例理由",
    "## 影片概覽",
    "样例章节二（重點）",
    "## 章節",
    "## 我的時間戳記筆記",
    "  - 簡幕",
  ]) {
    assert.ok(hant.includes(line), line);
  }
  const untitled = [{ ...((INPUT.notes ?? [])[0] as NoteRecord), video: "" as typeof KEY }];
  assert.ok(notesAsMarkdown(untitled, LINK, { lang: "zh-Hant" }).startsWith("# 未命名影片\n"));
  assert.deepEqual([markdownFallbackName("notes", "zh-Hant"), markdownFallbackName("learning", "zh-Hant")], ["筆記", "學習稿"]);
});
