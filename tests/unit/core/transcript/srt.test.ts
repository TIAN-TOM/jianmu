import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSrt, formatSrtTimestamp } from "../../../../src/core/transcript/srt.ts";

test("SRT 时间戳是「时:分:秒,毫秒」，各段补零", () => {
  assert.equal(formatSrtTimestamp(0), "00:00:00,000");
  assert.equal(formatSrtTimestamp(62.345), "00:01:02,345");
  assert.equal(formatSrtTimestamp(65), "00:01:05,000");
  assert.equal(formatSrtTimestamp(3725.5), "01:02:05,500");
  assert.equal(formatSrtTimestamp(59.9996), "00:01:00,000", "四舍五入到毫秒时进位");
  assert.equal(formatSrtTimestamp(-3), "00:00:00,000");
  assert.equal(formatSrtTimestamp(Number.NaN), "00:00:00,000");
});

test("SRT 每段的结束取它覆盖的原始字幕的结束，不越过下一段的开始", () => {
  const srt = buildSrt(
    [
      { start: 0, text: "第一段" },
      { start: 5, text: "第二段" },
      { start: 30, text: "第三段" },
    ],
    {
      entries: [
        { start: 0, duration: 2, text: "a" },
        { start: 2, duration: 4, text: "b" }, // 跨进第二段，第一段在 5 秒收住
        { start: 6, duration: 3, text: "c" }, // 第二段说完到第三段之间是一段空白
        { start: 30, duration: 2.5, text: "d" },
      ],
    },
  );
  assert.equal(
    srt,
    [
      "1",
      "00:00:00,000 --> 00:00:05,000",
      "第一段",
      "",
      "2",
      "00:00:05,000 --> 00:00:09,000",
      "第二段",
      "",
      "3",
      "00:00:30,000 --> 00:00:32,500",
      "第三段",
      "",
    ].join("\n"),
  );
});

test("SRT 最后一段没有结束时间：按字数估阅读时长，不超过视频时长", () => {
  // 原始字幕没给时长。
  const short = buildSrt([{ start: 10, text: "短句" }], {
    entries: [{ start: 10, duration: 0, text: "短句" }],
  });
  assert.match(short, /00:00:10,000 --> 00:00:12,000/, "至少给 2 秒");

  const long = buildSrt([{ start: 10, text: "很".repeat(60) }]);
  assert.match(long, /00:00:10,000 --> 00:00:17,000/, "最多 7 秒");

  const nearEnd = buildSrt([{ start: 10, text: "很".repeat(60) }], { duration: 13 });
  assert.match(nearEnd, /00:00:10,000 --> 00:00:13,000/, "不越过视频结尾");

  // 中间段缺时长时退到下一段的开始。
  const middle = buildSrt([{ start: 0, text: "一" }, { start: 4, text: "二" }]);
  assert.match(middle, /^1\n00:00:00,000 --> 00:00:04,000\n一\n/);
});

test("SRT 多行文字保留换行、去掉空行；空文字的段跳过并重新编号", () => {
  const srt = buildSrt([
    { start: 0, text: "原文\n\n  译文  " },
    { start: 3, text: "   " },
    { start: 3, text: "第二条" },
  ]);
  assert.equal(
    srt,
    "1\n00:00:00,000 --> 00:00:03,000\n原文\n译文\n\n2\n00:00:03,000 --> 00:00:05,000\n第二条\n",
  );
  assert.equal(buildSrt([]), "");
});

test("SRT 同时开始的两段也留出能看清的时长", () => {
  const srt = buildSrt([{ start: 1, text: "甲" }, { start: 1, text: "乙" }]);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:01,500\n甲\n/);
});
