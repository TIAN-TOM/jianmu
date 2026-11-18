// 显示用的断行：按原始字幕的行把每一段的断处找回来；原文有标点的段落不断；断开以后拼起来和原文一字不差；
// 一行原始字幕被切进两段、对不上的字幕都处理得住。段落本身（分段规则）不变。
import assert from "node:assert/strict";
import { test } from "node:test";
import { breaksToShow, hasPunctuation, lineBreaks, splitRuns } from "../../../../src/core/transcript/lines.ts";
import { groupTranscriptEntries } from "../../../../src/core/transcript/segment.ts";

const cue = (start: number, text: string) => ({ start, duration: 2, text });
const textsOf = (text: string, breaks: readonly number[]) => splitRuns([{ text }], breaks).map((line) => line.map((run) => run.text).join(""));

test("没有标点的中文字幕：分段照旧并成一段，显示时按原始字幕的行断开，拼起来和原文一样", () => {
  const cues = [cue(0, "大家好今天"), cue(2, "我们来聊一聊"), cue(4, "这个样例视频")];
  const segments = groupTranscriptEntries(cues);
  assert.equal(segments.length, 1, "分段规则没变");
  const segment = segments[0]!;
  assert.equal(segment.text, "大家好今天我们来聊一聊这个样例视频");
  const breaks = breaksToShow(segment, lineBreaks(segments, cues));
  assert.deepEqual(textsOf(segment.text, breaks), ["大家好今天", "我们来聊一聊", "这个样例视频"]);
  assert.equal(textsOf(segment.text, breaks).join(""), segment.text);
});

test("原文自带标点（人工字幕、导入的字幕、外语字幕）：照原样显示，不断开", () => {
  for (const cues of [
    [cue(0, "大家好，"), cue(2, "今天聊一聊。")],
    [cue(0, "Hello there,"), cue(2, "welcome back.")],
  ]) {
    const segments = groupTranscriptEntries(cues);
    const all = lineBreaks(segments, cues);
    for (const segment of segments) assert.deepEqual(breaksToShow(segment, all), [], segment.text);
  }
  assert.equal(hasPunctuation("没有标点的一句"), false);
  assert.equal(hasPunctuation("有标点。"), true);
});

test("西文没有标点时也按行断开，行和行之间的空格留在前一行末尾，拼起来不丢空格", () => {
  const cues = [cue(0, "so today we are"), cue(2, "going to talk about"), cue(4, "a sample video")];
  const segments = groupTranscriptEntries(cues);
  const segment = segments[0]!;
  const lines = textsOf(segment.text, breaksToShow(segment, lineBreaks(segments, cues)));
  assert.deepEqual(lines.map((line) => line.trim()), ["so today we are", "going to talk about", "a sample video"]);
  assert.equal(lines.join(""), segment.text);
});

test("一行原始字幕被切进两段：第二段开头不算新的一行，后面照常断", () => {
  const segments = [
    { id: "a", text: "第一行第二行的前半" },
    { id: "b", text: "后半第三行" },
  ];
  const cues = [cue(0, "第一行"), cue(1, "第二行的前半后半"), cue(2, "第三行")];
  const breaks = lineBreaks(segments, cues);
  assert.deepEqual(breaks.get("a"), [3]);
  assert.deepEqual(breaks.get("b"), [2]);
});

test("字幕和段落对不上（换过版本、空行、多出来的字）：整份都不断开；空的原始字幕跳过", () => {
  assert.deepEqual([...lineBreaks([{ id: "a", text: "甲乙丙丁" }], [cue(0, "甲乙"), cue(1, "戊己")])], []);
  assert.deepEqual([...lineBreaks([{ id: "a", text: "甲乙丙丁戊" }], [cue(0, "甲乙"), cue(1, "丙丁")])], [], "原始字幕不够");
  assert.deepEqual(lineBreaks([{ id: "a", text: "甲乙丙丁" }], [cue(0, "甲乙"), cue(1, "  "), cue(2, "丙丁")]).get("a"), [2]);
});

test("搜索高亮切出来的片段按断处再切：高亮跨过断处时两边各带一截，片段文字拼起来不变", () => {
  const runs = [
    { text: "大家好今", hit: false },
    { text: "天我们", hit: true },
    { text: "来聊", hit: false },
  ];
  const lines = splitRuns(runs, [5, 7]);
  assert.deepEqual(lines, [
    [
      { text: "大家好今", hit: false },
      { text: "天", hit: true },
    ],
    [{ text: "我们", hit: true }],
    [{ text: "来聊", hit: false }],
  ]);
  assert.deepEqual(splitRuns(runs, []), [runs]);
  assert.deepEqual(splitRuns([{ text: "甲乙" }, { text: "丙" }], [2]), [[{ text: "甲乙" }], [{ text: "丙" }]], "断处正好在片段交界");
});
