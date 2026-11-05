import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedFileName, parseSubtitleFile, type ImportedEntry } from "../../../../src/core/transcript/import-file.ts";

const near = (actual: number | undefined, expected: number): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);
};

function entriesOf(text: unknown, fileName?: string): ImportedEntry[] {
  const result = parseSubtitleFile(text, fileName);
  assert.equal(result.ok, true);
  return result.entries;
}

function errorOf(text: unknown, fileName?: string): string {
  const result = parseSubtitleFile(text, fileName);
  assert.equal(result.ok, false);
  return result.error;
}

test("SRT：序号、逗号毫秒、多行正文合成一行", () => {
  const result = parseSubtitleFile(
    "1\n00:00:01,500 --> 00:00:04,000\n第一句\n第二行\n\n2\n00:01:02,000 --> 00:01:05,250\n<i>斜体</i>的话\n",
    "a.srt",
  );
  assert.equal(result.ok, true);
  assert.equal(result.format, "srt");
  assert.deepEqual(result.entries.map((entry) => entry.text), ["第一句 第二行", "斜体的话"]);
  near(result.entries[0]?.start, 1.5);
  near(result.entries[0]?.duration, 2.5);
  near(result.entries[1]?.start, 62);
  near(result.entries[1]?.duration, 3.25);
});

test("VTT：文件头、NOTE 和 STYLE 块跳过，省略小时的时间戳、cue 设置、标签都能读", () => {
  const text = [
    "WEBVTT - 测试",
    "",
    "NOTE 这是注释",
    "",
    "STYLE",
    "::cue { color: red }",
    "",
    "intro",
    "01:02.500 --> 01:04.000 align:start position:10%",
    "<v 主持人>大家好</v>",
    "",
    "00:00:00.000 --> 00:00:01.000",
    "<c.yellow>开场</c>",
  ].join("\n");
  const result = parseSubtitleFile(text, "a.vtt");
  assert.equal(result.ok, true);
  assert.equal(result.format, "vtt");
  assert.deepEqual(result.entries.map((entry) => entry.text), ["开场", "大家好"], "按开始时间排好");
  near(result.entries[1]?.start, 62.5);
  near(result.entries[1]?.duration, 1.5);
});

test("Windows 换行、BOM、HTML 实体和 ASS 定位码都清掉", () => {
  const result = parseSubtitleFile(
    "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}A &amp; B&nbsp;&lt;C&gt;\r\n\r\n",
    "a.srt",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [{ text: "A & B <C>", start: 1, duration: 1 }]);
  const vtt = parseSubtitleFile("\ufeffWEBVTT\n\n00:01.000 --> 00:02.000\nhi\n", "a.srt");
  assert.equal(vtt.ok && vtt.format, "vtt");
});

test("分隔行里只有空格或制表符也算空行：相邻的条目不并在一起", () => {
  const entries = entriesOf(
    "1\n00:00:01,000 --> 00:00:02,000\nFirst\n \n2\n00:00:03,000 --> 00:00:04,000\nSecond\n\t\n3\n00:00:05,000 --> 00:00:06,000\nThird\n",
    "a.srt",
  );
  assert.deepEqual(entries, [
    { text: "First", start: 1, duration: 1 },
    { text: "Second", start: 3, duration: 1 },
    { text: "Third", start: 5, duration: 1 },
  ]);
});

test("没有正文的条目跳过；时间倒着写时长记 0", () => {
  const entries = entriesOf(
    "1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:05,000 --> 00:00:04,000\n倒着的\n",
    "a.srt",
  );
  assert.deepEqual(entries, [{ text: "倒着的", start: 5, duration: 0 }]);
});

test("读不出字幕时给出原因：空文件、不是字幕、太大", () => {
  assert.equal(errorOf("", "a.srt"), "EMPTY_FILE");
  assert.equal(errorOf("   \n  ", "a.srt"), "EMPTY_FILE");
  assert.equal(errorOf("[Script Info]\nTitle: ass 文件\n", "a.srt"), "NO_CUES");
  assert.equal(errorOf("x".repeat(2 * 1024 * 1024 + 1), "a.srt"), "FILE_TOO_LARGE");
  assert.equal(errorOf(null), "EMPTY_FILE");
});

test("只认 .srt 和 .vtt 扩展名，不分大小写", () => {
  assert.equal(isSupportedFileName("课程.SRT"), true);
  assert.equal(isSupportedFileName("a.vtt"), true);
  assert.equal(isSupportedFileName("a.ass"), false);
  assert.equal(isSupportedFileName("a.srt.mp4"), false);
  assert.equal(isSupportedFileName(""), false);
});

test("特制的不收尾标签不会卡住解析：每个字符只看一次，没收尾的原样留下", () => {
  assert.deepEqual(
    entriesOf("1\n00:00:01,000 --> 00:00:02,000\na<b>c{\\i1}d<e\n", "a.srt").map((entry) => entry.text),
    ["acd<e"],
  );
  // 用正则 /<[^>]*>/ 时这两段各要扫上千亿次，后台会卡住几十秒以上。
  for (const opener of ["<", "{\\"]) {
    const body = opener.repeat(Math.floor(1_500_000 / opener.length));
    const started = Date.now();
    const entries = entriesOf(`1\n00:00:01,000 --> 00:00:02,000\n${body}\n`, "a.srt");
    const elapsed = Date.now() - started;
    assert.equal(entries[0]?.text.length, body.length);
    assert.ok(elapsed < 2000, `${JSON.stringify(opener)} 用了 ${elapsed} ms`);
  }
});
