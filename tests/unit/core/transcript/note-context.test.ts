import assert from "node:assert/strict";
import { test } from "node:test";
import { noteContextAt } from "../../../../src/core/transcript/note-context.ts";

const NOTE_TRANSCRIPT = Array.from({ length: 20 }, (_, i) => ({
  text: `第${i}句`,
  start: i * 10,
  duration: 10,
}));

test("定位到时间点所在的那一行，并取出前后文", () => {
  const context = noteContextAt(NOTE_TRANSCRIPT, 105);

  assert.equal(context?.index, 10);
  assert.equal(context?.targetText, "第10句");
  assert.equal(context?.beforeText, "第8句 第9句");
  assert.equal(context?.afterText, "第11句 第12句 第13句 第14句");
  // 更大的上下文：前 8 行到后 12 行
  assert.match(context?.fullContext ?? "", /^第2句 /);
  assert.match(context?.fullContext ?? "", /第19句$/);
});

test("时间点落在某行开头时算作该行", () => {
  assert.equal(noteContextAt(NOTE_TRANSCRIPT, 100)?.targetText, "第10句");
});

test("时间点超出字幕范围时退回最后一行", () => {
  const context = noteContextAt(NOTE_TRANSCRIPT, 99999);
  assert.equal(context?.index, 19);
  assert.equal(context?.targetText, "第19句");
  assert.equal(context?.afterText, "");
});

test("开头处不会越界取到负索引", () => {
  const context = noteContextAt(NOTE_TRANSCRIPT, 0);
  assert.equal(context?.index, 0);
  assert.equal(context?.beforeText, "");
  assert.match(context?.fullContext ?? "", /^第0句 /);
});

test("字幕第一句之前的时间点落在第一行，而不是结尾", () => {
  // B 站字幕常几秒后才出第一句：开头存的笔记不能错拿视频结尾那句。
  const lateStart = NOTE_TRANSCRIPT.map((entry) => ({
    ...entry,
    start: entry.start + 10,
  }));
  const context = noteContextAt(lateStart, 5);

  assert.equal(context?.index, 0);
  assert.equal(context?.targetText, "第0句");
  assert.equal(context?.beforeText, "");
  assert.match(context?.fullContext ?? "", /^第0句 /);
});

test("没有字幕时返回 null", () => {
  assert.equal(noteContextAt([], 10), null);
  assert.equal(noteContextAt(null, 10), null);
});
