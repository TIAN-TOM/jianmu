// 平台返回里的文字值：字符串去掉首尾空白，别的一律当空串。
import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText } from "../../../../src/sites/bilibili/raw-text.ts";

test("字符串去掉首尾空白，不是字符串的当空串", () => {
  assert.equal(plainText("  样例标题 \n"), "样例标题");
  for (const value of [null, undefined, 3, {}, ["样例"]]) assert.equal(plainText(value), "");
});
