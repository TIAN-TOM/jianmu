// 外来的时间值换成秒数：空值不当成 0，认不出的和负数不要。
import assert from "node:assert/strict";
import { test } from "node:test";
import { secondsOrNull } from "../../../../src/core/transcript/seconds.ts";

test("数字和数字字符串照收，0 也算", () => {
  assert.equal(secondsOrNull(0), 0);
  assert.equal(secondsOrNull(12.5), 12.5);
  assert.equal(secondsOrNull("30"), 30);
});

test("空值、认不出的、负数和无穷都是 null", () => {
  for (const value of [null, undefined, "", "abc", -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(secondsOrNull(value), null, String(value));
  }
});
