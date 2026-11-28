// 官方总结提纲的一段是不是合法：读回存储里的提纲时据此丢掉形状不对的段。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isOutlineSection } from "../../../../src/core/transcript/outline.ts";

const section = (extra: Record<string, unknown> = {}) => ({
  title: "样例分段",
  timestamp: 12,
  points: [
    { timestamp: 15, content: "样例要点" },
    { timestamp: null, content: "没有起点的要点" },
  ],
  ...extra,
});

test("合法的段：起点可以是 null，要点可以是空的，多出来的字段不影响", () => {
  assert.equal(isOutlineSection(section()), true);
  assert.equal(isOutlineSection(section({ timestamp: null })), true);
  assert.equal(isOutlineSection(section({ timestamp: 0, points: [] })), true);
  assert.equal(isOutlineSection(section({ title: "", note: "多余" })), true);
});

test("不是对象的不算", () => {
  for (const value of [null, undefined, "样例分段", 3, [], [section()]]) {
    assert.equal(isOutlineSection(value), false, String(value));
  }
});

test("标题不是字符串的不算", () => {
  for (const title of [undefined, null, 3, {}]) {
    assert.equal(isOutlineSection(section({ title })), false, String(title));
  }
});

test("起点不是有限数字也不是 null 的不算", () => {
  for (const timestamp of [undefined, "12", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(isOutlineSection(section({ timestamp })), false, String(timestamp));
  }
});

test("要点不是数组、或者有一项不合法的不算", () => {
  for (const points of [undefined, null, "样例要点", { 0: { timestamp: 1, content: "样例" } }]) {
    assert.equal(isOutlineSection(section({ points })), false, String(points));
  }
  const badPoints = [null, "样例要点", { content: "缺起点" }, { timestamp: "1", content: "起点是字符串" }, { timestamp: 1 }, { timestamp: 1, content: 2 }];
  for (const point of badPoints) {
    assert.equal(isOutlineSection(section({ points: [{ timestamp: 1, content: "好的" }, point] })), false, JSON.stringify(point));
  }
});
