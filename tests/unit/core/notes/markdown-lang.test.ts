// 笔记和学习稿的导出按语言出固定文字：缺省和选中文时逐字一样；英文时小标题、来源说明和标记是英文，
// 模型写的内容、官方总结、UP 主分段和用户自己的笔记原样写。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { learningAsMarkdown, markdownFallbackName, notesAsMarkdown, type LearningInput } from "../../../../src/core/notes/markdown.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
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
  const zh = learningAsMarkdown(INPUT, VIDEO_BASE);
  assert.equal(learningAsMarkdown(INPUT, VIDEO_BASE, "zh"), zh);
  for (const line of ["## B站官方总结", "## UP 主分段", "## 一句话结论", "**可跳过**", "## 视频概览", "## 章节", "## 我的时间戳笔记", "  - 简幕", "title: BV1Sample000"]) {
    assert.ok(zh.includes(line), line);
  }
});

test("学习稿：英文时固定文字是英文，档位写英文名，内容原样", () => {
  const en = learningAsMarkdown(INPUT, VIDEO_BASE, "en");
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
    "**Skip**",
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
  const zh = notesAsMarkdown(notes, VIDEO_BASE);
  assert.equal(notesAsMarkdown(notes, VIDEO_BASE, { lang: "zh" }), zh);
  assert.ok(zh.startsWith("# BV1Sample000\n"));
  const untitled = [{ ...(notes[0] as NoteRecord), video: "" as typeof KEY }];
  assert.ok(notesAsMarkdown(untitled, VIDEO_BASE).startsWith("# 未命名视频\n"));
  assert.ok(notesAsMarkdown(untitled, VIDEO_BASE, { lang: "en" }).startsWith("# Untitled video\n"));
});

test("导出文件在没有标题时的名字：中文照旧，英文是英文", () => {
  assert.deepEqual([markdownFallbackName("notes"), markdownFallbackName("learning")], ["笔记", "学习稿"]);
  assert.deepEqual([markdownFallbackName("notes", "en"), markdownFallbackName("learning", "en")], ["notes", "study notes"]);
});
