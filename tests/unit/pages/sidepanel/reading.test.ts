// 侧边栏的纯规则：播放到哪一段、原文译文双语怎么显示和导出、划词解释的长度、导出的文件名和链接前缀、导入前的文件核对。
import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { safeFileName, videoBaseOf } from "../../../../src/pages/sidepanel/files.ts";
import { activeIndex, explainable, linesOf, MAX_SELECTION, srtOf } from "../../../../src/pages/sidepanel/reading.ts";
import { fileProblem } from "../../../../src/pages/sidepanel/transcript.ts";

const segment = (id: string, start: number, text: string) => ({ id, start, text, texts: [text] });
const SEGMENTS = [segment("s0", 0, "第一句"), segment("s1", 10, "第二句"), segment("s2", 20, "第三句")];

test("播放到的段落：开始时间不晚于播放位置的最后一段，还没到第一段或没有位置时是 -1", () => {
  assert.equal(activeIndex(SEGMENTS, null), -1);
  assert.equal(activeIndex([segment("late", 5, "晚开头")], 2), -1);
  assert.equal(activeIndex(SEGMENTS, 0), 0);
  assert.equal(activeIndex(SEGMENTS, 9.9), 0);
  assert.equal(activeIndex(SEGMENTS, 10), 1);
  assert.equal(activeIndex(SEGMENTS, 999), 2);
});

test("原文、译文、双语：译文没到的段落先显示原文；导出 SRT 跟着视图走", () => {
  const translated = { s0: "First" };
  assert.deepEqual(linesOf(SEGMENTS[0]!, "original", translated), { main: "第一句", sub: "" });
  assert.deepEqual(linesOf(SEGMENTS[0]!, "translated", translated), { main: "First", sub: "" });
  assert.deepEqual(linesOf(SEGMENTS[1]!, "translated", translated), { main: "第二句", sub: "" });
  assert.deepEqual(linesOf(SEGMENTS[0]!, "bilingual", translated), { main: "第一句", sub: "First" });
  const srt = srtOf(SEGMENTS, [], 30, "bilingual", translated);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:10,000\n第一句\nFirst\n/);
  assert.match(srt, /\n3\n00:00:20,000 --> /);
});

test("划词解释：空白和太长的选区不弹「解释」", () => {
  assert.equal(explainable("  "), false);
  assert.equal(explainable(" 术语 "), true);
  assert.equal(explainable("字".repeat(MAX_SELECTION)), true);
  assert.equal(explainable("字".repeat(MAX_SELECTION + 1)), false);
});

test("导出：文件名去掉系统不认的字符，空了用后备名字；链接前缀按视频所在的站点算", () => {
  assert.equal(safeFileName('a/b:c*"d"', "字幕"), "a b c d");
  assert.equal(safeFileName(" \u0000 ", "字幕"), "字幕");
  assert.equal(safeFileName("长".repeat(200), "字幕").length, 80);
  const base = videoBaseOf(videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 2 }));
  assert.ok(base.startsWith("https://") && base.endsWith("/"), base);
  assert.equal(new URL(`${base}BV1Sample001`).pathname.endsWith("/BV1Sample001"), true);
  assert.equal(videoBaseOf(null), "");
});

test("导入字幕文件之前：只收 .srt、.vtt，太大和空文件先拦下", () => {
  assert.equal(fileProblem("a.SRT", 10), null);
  assert.equal(fileProblem("a.vtt", 10), null);
  assert.ok(fileProblem("a.ass", 10));
  assert.ok(fileProblem("a.srt", 0));
  assert.ok(fileProblem("a.srt", 3 * 1024 * 1024));
});
