// 侧边栏的两种导出把界面语言传给导出：中文时内容和文件名和原来逐字一样，英文时固定文字和没标题时的文件名是英文。
// 导出里的链接按视频所在站点的地址规则生成。字幕轨的显示名：简幕起的名字和 B 站给的名字按语言换，YouTube 页面上写着的照原样。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { learningAsMarkdown, notesAsMarkdown, type LearningInput } from "../../../../src/core/notes/markdown.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { learningExport, notesExport, trackLabel, videoLink } from "../../../../src/pages/sidepanel/files.ts";

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
  assert.deepEqual(zh, { fileName: "学习稿.md", markdown: learningAsMarkdown(INPUT, videoLink) });
  assert.equal(learningExport({ ...INPUT, title: "样例/标题" }, "zh")?.fileName, "样例 标题.md");

  const en = learningExport(INPUT, "en");
  assert.equal(en?.fileName, "study notes.md");
  assert.equal(en?.markdown, learningAsMarkdown(INPUT, videoLink, "en"));
  assert.notEqual(en?.markdown, zh?.markdown);
  assert.equal(learningExport({ ...INPUT, title: "样例标题" }, "en")?.fileName, "样例标题.md", "有标题时照标题起名");

  assert.equal(learningExport({}, "en"), null, "没有可导出的内容");
});

test("笔记：中文时内容和原来逐字一样，英文时固定文字是英文；没标题时的文件名按语言给", () => {
  const zh = notesExport([NOTE], { grouped: false, title: "" }, "zh");
  assert.deepEqual(zh, { fileName: "笔记.md", markdown: notesAsMarkdown([NOTE], videoLink, { grouped: false }) });
  const en = notesExport([NOTE], { grouped: true, title: "" }, "en");
  assert.equal(en?.fileName, "notes.md");
  assert.equal(en?.markdown, notesAsMarkdown([NOTE], videoLink, { grouped: true, lang: "en" }));
  assert.equal(notesExport([NOTE], { grouped: false, title: "All notes" }, "en")?.fileName, "All notes.md");
  assert.equal(notesExport([], { grouped: false, title: "" }, "zh"), null);
});

test("B 站的导出链接：分 P 和起播时间照旧写在地址参数里", () => {
  const p2 = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 2 });
  const markdown = learningExport({ ...INPUT, videoKey: p2, notes: [{ ...NOTE, video: p2, atSec: 65 }] }, "zh")?.markdown ?? "";
  assert.match(markdown, /^url: "https:\/\/www\.bilibili\.com\/video\/BV1Sample000\?p=2"$/m);
  assert.ok(markdown.includes("- [1:05](https://www.bilibili.com/video/BV1Sample000?p=2&t=65) 样例笔记"), markdown);
});

test("YouTube 的学习稿：文件头带视频链接，章节、金句的时间是带起播时间的链接，0:00 链到开头", () => {
  const markdown =
    learningExport(
      {
        title: "样例视频",
        videoKey: TUBE,
        exportedAt: new Date(2026, 10, 22, 2, 9),
        analysis: {
          chapters: [
            { timestamp: "0:00", timestampSeconds: 0, title: "开场", summary: "" },
            { timestamp: "1:05", timestampSeconds: 65, title: "正题", summary: "" },
          ],
          keyQuotes: [{ timestamp: "1:10", timestampSeconds: 70, quote: "样例金句" }],
        },
      },
      "zh",
    )?.markdown ?? "";
  const watch = "https://www.youtube.com/watch?v=Sample00001";
  assert.match(markdown, /^url: "https:\/\/www\.youtube\.com\/watch\?v=Sample00001"$/m);
  assert.match(markdown, /^created_at: 2026-11-22$/m);
  assert.ok(markdown.includes(`- [0:00](${watch}) 开场`), markdown);
  assert.ok(markdown.includes(`- [1:05](${watch}&t=65s) 正题`), markdown);
  assert.ok(markdown.includes(`### [1:05](${watch}&t=65s) 正题`), markdown);
  assert.ok(markdown.includes(`> [1:10](${watch}&t=70s) 样例金句`), markdown);
});

test("YouTube 的笔记导出：分组标题下带视频链接，每条笔记的时间是链接；B 站和 YouTube 混在一起时各用各的地址", () => {
  const tubeNote = { ...NOTE, id: "n2", video: TUBE, snapshot: { title: "样例视频", author: "" }, atSec: 125, createdAt: 2 } as NoteRecord;
  const single = notesExport([tubeNote], { grouped: false, title: "" }, "zh")?.markdown;
  assert.equal(
    single,
    ["# 样例视频", "", "https://www.youtube.com/watch?v=Sample00001", "", "- [2:05](https://www.youtube.com/watch?v=Sample00001&t=125s) 样例笔记", ""].join("\n"),
  );
  const mixed = notesExport([NOTE, tubeNote], { grouped: true, title: "" }, "zh")?.markdown ?? "";
  assert.ok(mixed.includes("- [2:05](https://www.youtube.com/watch?v=Sample00001&t=125s) 样例笔记"), mixed);
  assert.ok(mixed.includes("- [0:05](https://www.bilibili.com/video/BV1Sample000?t=5) 样例笔记"), mixed);
});

test("导出链接：认不出的身份回空串，不抛错", () => {
  assert.equal(videoLink({ platform: "youtube", videoId: "坏 编号" }, 0), "");
  assert.equal(videoLink({ platform: "bilibili", videoId: "不是BV号" }, 5), "");
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

test("字幕轨的显示名：B 站的轨英文界面出英文语言名，中文界面一字不变，认不出的语言照原样", () => {
  const human = { trackId: "zh", label: "样例中文", kind: "human" as const };
  const auto = { trackId: "ja", label: "样例日语（自动生成）", kind: "auto" as const };
  assert.equal(trackLabel(KEY, human, "zh"), "样例中文");
  assert.equal(trackLabel(KEY, auto, "zh"), "样例日语（自动生成）");
  assert.match(trackLabel(KEY, human, "en"), /^Chinese/);
  assert.ok(trackLabel(KEY, auto, "en").endsWith(" (auto-generated)"));
  assert.equal(trackLabel(KEY, { trackId: "xx", label: "样例语言", kind: "human" }, "en"), "样例语言");
  const read = { trackId: "zh", label: "样例中文（自动生成）", ref: { kind: "auto" as const } };
  assert.ok(trackLabel(KEY, read, "en").endsWith(" (auto-generated)"), "读到的字幕从依据里取来源");
  assert.equal(trackLabel(KEY, read, "zh"), "样例中文（自动生成）");
});

test("字幕轨的显示名：官方总结字幕和导入文件的名字英文界面换成英文，中文界面照存下来的", () => {
  const official = { trackId: "official-ai", label: "B站官方总结里的 AI 字幕", ref: { kind: "official-ai" as const } };
  const imported = { trackId: "imported", label: "导入的字幕文件", ref: { kind: "imported" as const } };
  assert.equal(trackLabel(KEY, official, "zh"), "B站官方总结里的 AI 字幕");
  assert.equal(trackLabel(KEY, official, "en"), "AI subtitles from the Bilibili official summary");
  assert.equal(trackLabel(TUBE, imported, "zh"), "导入的字幕文件");
  assert.equal(trackLabel(TUBE, imported, "en"), "Imported subtitle file");
});

test("字幕轨的显示名：繁体界面下简幕起的名字、B 站的语言名和自动生成的后缀都是繁体，标识不变", () => {
  assert.equal(trackLabel(TUBE, { trackId: "panel:YouTube 文字稿", label: "YouTube 文字稿" }, "zh-Hant"), "YouTube 轉錄稿");
  assert.equal(trackLabel(TUBE, { trackId: "panel:YouTube 文字稿（来源未确认）", label: "YouTube 文字稿（来源未确认）" }, "zh-Hant"), "YouTube 轉錄稿（來源未確認）");
  assert.equal(trackLabel(TUBE, { trackId: "panel:英文 (自動產生)", label: "英文 (自動產生)" }, "zh-Hant"), "英文 (自動產生)", "页面上写着的照原样");
  assert.equal(trackLabel(KEY, { trackId: "zh-CN", label: "样例中文", kind: "human" }, "zh-Hant"), "中文（中國）");
  assert.equal(trackLabel(KEY, { trackId: "ai-ja", label: "样例日语（自动生成）", kind: "auto" }, "zh-Hant"), "日文（自動產生）");
  assert.equal(trackLabel(KEY, { trackId: "xx", label: "样例语言", kind: "human" }, "zh-Hant"), "样例语言");
  assert.equal(trackLabel(KEY, { trackId: "official-ai", label: "B站官方总结里的 AI 字幕", ref: { kind: "official-ai" as const } }, "zh-Hant"), "B 站官方總結裡的 AI 字幕");
  assert.equal(trackLabel(TUBE, { trackId: "imported", label: "导入的字幕文件", ref: { kind: "imported" as const } }, "zh-Hant"), "匯入的字幕檔案");
});
