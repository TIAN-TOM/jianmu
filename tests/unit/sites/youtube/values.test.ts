// YouTube 页面一侧和后台共用的纯值：随机标记的格式、按对象取字段、压空白，以及后台读取共用的失败结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fail, malformed } from "../../../../src/sites/youtube/failure.ts";
import { fields, squash, TOKEN } from "../../../../src/sites/youtube/page/values.ts";

test("随机标记只认 8 到 64 个字母、数字、下划线和连字符", () => {
  assert.ok(TOKEN.test("sample-0_"));
  assert.ok(TOKEN.test("a".repeat(64)));
  for (const token of ["short", "a".repeat(65), "has space1", "含中文的标记样例"]) assert.ok(!TOKEN.test(token), token);
});

test("fields 只把普通对象当字段表，数组、null 和别的值都是 null", () => {
  const value = { sample: 1 };
  assert.equal(fields(value), value);
  for (const other of [null, undefined, [], "样例", 3]) assert.equal(fields(other), null);
});

test("squash 把连续空白压成一个空格并去掉首尾空白，没有文字时是空串", () => {
  assert.equal(squash("  样例\n\t 正文  "), "样例 正文");
  assert.equal(squash(null), "");
  assert.equal(squash(undefined), "");
});

test("失败结果：说明是空的就不带，形状不对只算这一项", () => {
  assert.deepEqual(fail("VIDEO_CHANGED"), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(fail("UNAVAILABLE", ""), { ok: false, code: "UNAVAILABLE" });
  assert.deepEqual(fail("UNAVAILABLE", "no-page"), { ok: false, code: "UNAVAILABLE", detail: "no-page" });
  assert.deepEqual(malformed("panel-shape"), { ok: false, code: "MALFORMED", reach: "item", detail: "panel-shape" });
});
