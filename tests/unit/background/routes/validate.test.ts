import assert from "node:assert/strict";
import { test } from "node:test";
import { hasOnly, isBoundedSeconds, isId, isText, keysWithin, MAX_ID, MAX_SECONDS, RAW_TEXT_MAX, refOf } from "../../../../src/background/routes/validate.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

test("hasOnly：键正好是给的这几个，多一个少一个都不行", () => {
  assert.equal(hasOnly({}, []), true);
  assert.equal(hasOnly({ a: 1, b: undefined }, ["a", "b"]), true);
  assert.equal(hasOnly({ b: 2, a: 1 }, ["a", "b"]), true);
  assert.equal(hasOnly({ a: 1 }, ["a", "b"]), false);
  assert.equal(hasOnly({ a: 1, b: 2, c: 3 }, ["a", "b"]), false);
  assert.equal(hasOnly({ a: 1, c: 3 }, ["a", "b"]), false);
  assert.equal(hasOnly({ a: 1 }, []), false);
});

test("keysWithin：必需的键都在，其余的键只能是可选的", () => {
  assert.equal(keysWithin({ a: 1 }, ["a"]), true);
  assert.equal(keysWithin({ a: 1, b: 2 }, ["a"], ["b"]), true);
  assert.equal(keysWithin({ a: 1 }, ["a"], ["b"]), true);
  assert.equal(keysWithin({ b: 2 }, ["a"], ["b"]), false);
  assert.equal(keysWithin({ a: 1, c: 3 }, ["a"], ["b"]), false);
  // 没有必需的键：只许出现可选的键，空对象也收。
  assert.equal(keysWithin({}, [], ["a"]), true);
  assert.equal(keysWithin({ a: 1 }, [], ["a"]), true);
  assert.equal(keysWithin({ x: 1 }, [], ["a"]), false);
});

test("isId：非空字符串，不超过上限", () => {
  assert.equal(isId("a"), true);
  assert.equal(isId("x".repeat(MAX_ID)), true);
  assert.equal(isId("x".repeat(MAX_ID + 1)), false);
  assert.equal(isId(""), false);
  assert.equal(isId(1), false);
  assert.equal(isId(null), false);
});

test("isText：字符串，空串也收，不超过上限", () => {
  assert.equal(isText(""), true);
  assert.equal(isText("x".repeat(RAW_TEXT_MAX)), true);
  assert.equal(isText("x".repeat(RAW_TEXT_MAX + 1)), false);
  assert.equal(isText(undefined), false);
  assert.equal(isText(1), false);
});

test("refOf：视频键转回视频身份", () => {
  const ref = { platform: "youtube", videoId: "sample_ID-01" } as const;
  assert.deepEqual(refOf(videoKey(ref)), ref);
  const bili = { platform: "bilibili", videoId: "BV1Sample000", segment: 2 } as const;
  assert.deepEqual(refOf(videoKey(bili)), bili);
});

test("isBoundedSeconds：有限、不小于 0、不超过一周的秒数", () => {
  assert.equal(MAX_SECONDS, 7 * 24 * 3600);
  for (const value of [0, 1.5, MAX_SECONDS]) assert.equal(isBoundedSeconds(value), true);
  for (const value of [-1, MAX_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) assert.equal(isBoundedSeconds(value), false);
});
