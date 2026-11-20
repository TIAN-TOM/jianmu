// 侧边栏的两种导出把界面语言传给导出：中文时内容和文件名和原来逐字一样，英文时固定文字和没标题时的文件名是英文。
// 字幕轨的显示名：简幕替 YouTube 起的名字按语言换，别的照原样。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { learningAsMarkdown, notesAsMarkdown, type LearningInput } from "../../../../src/core/notes/markdown.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { learningExport, notesExport, trackLabel, videoBaseOf } from "../../../../src/pages/sidepanel/files.ts";

const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample000" });
const TUBE = videoKey({ platform: "youtube", videoId: "Sample00001" });
const NOTE = { id: "n1", kind: "note", origin: "user", video: KEY, snapshot: { title: "样例标题", author: "" }, atSec: 5, text: "样例笔记", createdAt: 1, updatedAt: 1 } as NoteRecord;

const INPUT: LearningInput = {
  title: "",
  author: "样例作者",
  videoKey: KEY,
  exportedAt: 0,
  analysis: { verdict: { verdict: "可以看", summary: "样例结论", value: "", reason: "", source: "transcript" } },
  notes: [NOTE],
};

test("学习稿：中文时内容和原来逐字一样，没标题时文件名是「学习稿」；英文时固定文字和文件名是英文", () => {
  const zh = learningExport(INPUT, "zh");
  assert.deepEqual(zh, { fileName: "学习稿.md", markdown: learningAsMarkdown(INPUT, videoBaseOf(KEY)) });
  assert.equal(learningExport({ ...INPUT, title: "样例/标题" }, "zh")?.fileName, "样例 标题.md");

  const en = learningExport(INPUT, "en");
  assert.equal(en?.fileName, "study notes.md");
  assert.equal(en?.markdown, learningAsMarkdown(INPUT, videoBaseOf(KEY), "en"));
  assert.notEqual(en?.markdown, zh?.markdown);
  assert.equal(learningExport({ ...INPUT, title: "样例标题" }, "en")?.fileName, "样例标题.md", "有标题时照标题起名");

  assert.equal(learningExport({}, "en"), null, "没有可导出的内容");
});

test("笔记：中文时内容和原来逐字一样，英文时固定文字是英文；没标题时的文件名按语言给", () => {
  const zh = notesExport([NOTE], KEY, { grouped: false, title: "" }, "zh");
  assert.deepEqual(zh, { fileName: "笔记.md", markdown: notesAsMarkdown([NOTE], videoBaseOf(KEY), { grouped: false }) });
  const en = notesExport([NOTE], KEY, { grouped: true, title: "" }, "en");
  assert.equal(en?.fileName, "notes.md");
  assert.equal(en?.markdown, notesAsMarkdown([NOTE], videoBaseOf(KEY), { grouped: true, lang: "en" }));
  assert.equal(notesExport([NOTE], KEY, { grouped: false, title: "All notes" }, "en")?.fileName, "All notes.md");
  assert.equal(notesExport([], KEY, { grouped: false, title: "" }, "zh"), null);
});

test("字幕轨的显示名：简幕替 YouTube 起的名字按语言换，标识不变；页面上写着名字的轨和 B 站的轨照原样", () => {
  const unnamed = { trackId: "panel:YouTube 文字稿", label: "YouTube 文字稿" };
  const unconfirmed = { trackId: "panel:YouTube 文字稿（来源未确认）", label: "YouTube 文字稿（来源未确认）" };
  assert.equal(trackLabel(TUBE, unnamed, "zh"), "YouTube 文字稿");
  assert.equal(trackLabel(TUBE, unnamed, "en"), "YouTube transcript");
  assert.equal(trackLabel(TUBE, unconfirmed, "en"), "YouTube transcript (source unconfirmed)");
  assert.equal(trackLabel(TUBE, { trackId: "panel:English (auto-generated)", label: "English (auto-generated)" }, "en"), "English (auto-generated)");
  assert.equal(trackLabel(KEY, { trackId: "panel:YouTube 文字稿", label: "样例轨" }, "en"), "样例轨", "别的站不认这个名字");
  assert.equal(trackLabel(null, unnamed, "en"), "YouTube 文字稿");
});
