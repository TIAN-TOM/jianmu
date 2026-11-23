// 侧边栏的纯规则：播放到哪一段和哪一章、速读里一章的字幕、原文译文双语怎么显示和导出、划词解释的长度、导出的文件名、导入前的文件核对。
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeFileName } from "../../../../src/pages/sidepanel/files.ts";
import { activeIndex, chapterAt, copyTextOf, explainable, linesOf, mainBreaks, MAX_SELECTION, refreshLang, segmentsBetween, srtOf } from "../../../../src/pages/sidepanel/reading.ts";
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

test("复制全部字幕：原文和译文视图每段一行，对照视图有译文的段落紧跟一行译文、没译到的只有主文", () => {
  const translated = { s0: "First", s2: "Third" };
  assert.equal(copyTextOf(SEGMENTS, "original", translated), "[0:00] 第一句\n[0:10] 第二句\n[0:20] 第三句");
  assert.equal(copyTextOf(SEGMENTS, "translated", translated), "[0:00] First\n[0:10] 第二句\n[0:20] Third");
  assert.equal(copyTextOf(SEGMENTS, "bilingual", translated), "[0:00] 第一句\nFirst\n[0:10] 第二句\n[0:20] 第三句\nThird");
  assert.equal(copyTextOf(SEGMENTS, "bilingual", {}), "[0:00] 第一句\n[0:10] 第二句\n[0:20] 第三句");
});

test("复制全部字幕：有整理结果时主文用整理后的", () => {
  assert.equal(copyTextOf([SEGMENTS[0]!], "bilingual", { s0: "First" }, { s0: "第一句。" }), "[0:00] 第一句。\nFirst");
});

test("划词解释：空白和太长的选区不弹「解释」", () => {
  assert.equal(explainable("  "), false);
  assert.equal(explainable(" 术语 "), true);
  assert.equal(explainable("字".repeat(MAX_SELECTION)), true);
  assert.equal(explainable("字".repeat(MAX_SELECTION + 1)), false);
});

test("导出：文件名去掉系统不认的字符，空了用后备名字", () => {
  assert.equal(safeFileName('a/b:c*"d"', "字幕"), "a b c d");
  assert.equal(safeFileName(" \u0000 ", "字幕"), "字幕");
  assert.equal(safeFileName("长".repeat(200), "字幕").length, 80);
});

test("导入字幕文件之前：只收 .srt、.vtt，太大和空文件先拦下", () => {
  assert.equal(fileProblem("a.SRT", 10), null);
  assert.equal(fileProblem("a.vtt", 10), null);
  assert.ok(fileProblem("a.ass", 10));
  assert.ok(fileProblem("a.srt", 0));
  assert.ok(fileProblem("a.srt", 3 * 1024 * 1024));
});

test("精读的当前章节：开始时间不晚于播放位置的最后一章；还没到第一章、没有章节或不知道位置时是 -1", () => {
  const chapters = [{ startSec: 0 }, { startSec: 120 }, { startSec: 300 }];
  assert.equal(chapterAt(chapters, null), -1);
  assert.equal(chapterAt([], 50), -1);
  assert.equal(chapterAt([{ startSec: 30 }], 10), -1);
  assert.equal(chapterAt(chapters, 0), 0);
  assert.equal(chapterAt(chapters, 119.9), 0);
  assert.equal(chapterAt(chapters, 120), 1);
  assert.equal(chapterAt(chapters, 9999), 2);
});

test("速读里一章的字幕：从这一章开始到下一章开始之前，最后一章到结尾", () => {
  assert.deepEqual(segmentsBetween(SEGMENTS, 0, 10).map((item) => item.id), ["s0"]);
  assert.deepEqual(segmentsBetween(SEGMENTS, 10, null).map((item) => item.id), ["s1", "s2"]);
  assert.deepEqual(segmentsBetween(SEGMENTS, 30, null), []);
});

test("主行按原始字幕断开：原文和双语断，译文不断；译文还没到、主行显示原文时照样断；导出 SRT 不受影响", () => {
  const segment = { id: "s", start: 0, text: "甲乙丙丁", texts: ["甲乙丙丁"] };
  const breaks = new Map([["s", [2]]]);
  const translated = { s: "一句译文" };
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "original", translated).main, breaks), [2]);
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "bilingual", translated).main, breaks), [2]);
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "translated", translated).main, breaks), []);
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "translated", {}).main, breaks), [2]);
  const srt = srtOf([segment], [{ start: 0, duration: 2, text: "甲乙" }, { start: 2, duration: 2, text: "丙丁" }], 4, "original", {});
  assert.match(srt, /甲乙丙丁/, "导出照旧按段落写，不插断行");
});

test("重新读取字幕：平台的字幕点名现在的语言，导入的和官方总结附带的不点名", () => {
  assert.equal(refreshLang({ ref: { kind: "auto" } }), true);
  assert.equal(refreshLang({ ref: { kind: "human" } }), true);
  assert.equal(refreshLang({ fileName: "样例.srt", ref: { kind: "imported" } }), false);
  assert.equal(refreshLang({ ref: { kind: "official-ai" } }), false);
});
