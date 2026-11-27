import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlainObject, isRecord, isTabId } from "../../../src/shared/guards.ts";

class Box {
  readonly value = 1;
}

test("isRecord：非空、不是数组的对象都算，类实例和无原型对象也算", () => {
  for (const value of [{}, { a: 1 }, new Box(), Object.create(null), new Date(0)]) assert.equal(isRecord(value), true);
  for (const value of [null, undefined, [], [1], "a", 0, true, () => {}]) assert.equal(isRecord(value), false);
});

test("isPlainObject：只认原型是 Object.prototype 的普通对象", () => {
  for (const value of [{}, { a: 1 }, JSON.parse('{"a":[1]}')]) assert.equal(isPlainObject(value), true);
  for (const value of [null, undefined, [], "a", 0, new Box(), Object.create(null), new Date(0), () => {}]) assert.equal(isPlainObject(value), false);
});

test("isTabId：不小于 0 的安全整数", () => {
  for (const value of [0, 1, 42, Number.MAX_SAFE_INTEGER]) assert.equal(isTabId(value), true);
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) assert.equal(isTabId(value), false);
});
