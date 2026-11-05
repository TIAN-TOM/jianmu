import assert from "node:assert/strict";
import { test } from "node:test";
import { hasMatch, splitMatches, type MatchSegment } from "../../../src/core/highlight.ts";

const texts = (segments: readonly MatchSegment[]) => segments.map((segment) => segment.text).join("");

test("空关键词原样返回，不产生命中片段", () => {
  assert.deepEqual(splitMatches("任意文本", ""), [{ text: "任意文本", hit: false }]);
  assert.deepEqual(splitMatches("任意文本", "   "), [{ text: "任意文本", hit: false }]);
  // 空文本加空关键词：什么都不给。
  assert.deepEqual(splitMatches("", ""), []);
});

test("无命中原样返回整段", () => {
  assert.deepEqual(splitMatches("学习笔记", "复习"), [{ text: "学习笔记", hit: false }]);
});

test("大小写不敏感，但命中片段保留原文大小写", () => {
  const segments = splitMatches("学 JavaScript 就是 Java", "javascript");
  assert.equal(texts(segments), "学 JavaScript 就是 Java");
  assert.deepEqual(
    segments.filter((segment) => segment.hit).map((segment) => segment.text),
    ["JavaScript"],
  );
});

test("多处命中切成 片段-命中-片段 交替", () => {
  const segments = splitMatches("aXbXc", "x");
  assert.deepEqual(segments, [
    { text: "a", hit: false },
    { text: "X", hit: true },
    { text: "b", hit: false },
    { text: "X", hit: true },
    { text: "c", hit: false },
  ]);
});

test("相邻命中之间不留空白片段", () => {
  const segments = splitMatches("aa", "a");
  assert.deepEqual(segments, [
    { text: "a", hit: true },
    { text: "a", hit: true },
  ]);
});

test("命中贯穿到首尾时不产生空的边缘片段", () => {
  assert.deepEqual(splitMatches("abc", "abc"), [{ text: "abc", hit: true }]);
  assert.deepEqual(splitMatches("abc", "ab"), [
    { text: "ab", hit: true },
    { text: "c", hit: false },
  ]);
});

test("关键词比原文长时视为未命中", () => {
  assert.deepEqual(splitMatches("短", "这是一段长得多的关键词"), [{ text: "短", hit: false }]);
});

test("中文与混合内容照常工作", () => {
  const segments = splitMatches("UP 主讲机器学习", "机器");
  assert.deepEqual(segments, [
    { text: "UP 主讲", hit: false },
    { text: "机器", hit: true },
    { text: "学习", hit: false },
  ]);
});

test("hasMatch 汇总是否存在命中", () => {
  assert.equal(hasMatch([{ text: "a", hit: false }]), false);
  assert.equal(hasMatch(splitMatches("有命中", "命中")), true);
});
