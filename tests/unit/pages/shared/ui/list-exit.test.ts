// 列表里删掉一条：要离场的留在原来的前后之间，在场的照新顺序；没说好要删的、离场走完的当场拿掉；离场途中又出现就接回来。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRows, type ExitRow } from "../../../../../src/pages/shared/ui/list-exit.ts";

const keyOf = (item: string): string => item;
const live = (...keys: string[]): ExitRow<string>[] => keys.map((key) => ({ key, item: key, leaving: false, height: 0 }));
const shape = (rows: readonly ExitRow<string>[]): string[] => rows.map((row) => (row.leaving ? `${row.key}↑${row.height}` : row.key));
const leaveOnly = (wanted: Record<string, number>) => (row: ExitRow<string>): number | null => (row.leaving ? row.height : (wanted[row.key] ?? null));

test("离场的一条留在原来的位置，高度是删之前量好的", () => {
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["a", "c"], keyOf, leaveOnly({ b: 80 }))), ["a", "b↑80", "c"]);
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["b", "c"], keyOf, leaveOnly({ a: 40 }))), ["a↑40", "b", "c"], "第一条");
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["a", "b"], keyOf, leaveOnly({ c: 40 }))), ["a", "b", "c↑40"], "最后一条");
  assert.deepEqual(shape(mergeRows(live("a"), [], keyOf, leaveOnly({ a: 40 }))), ["a↑40"], "删的是唯一一条，列表先不空");
});

test("没说好要删的当场拿掉：筛选、换范围时不在了的不播离场", () => {
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["c"], keyOf, leaveOnly({}))), ["c"]);
  assert.deepEqual(shape(mergeRows(live("a", "b"), ["x", "y"], keyOf, leaveOnly({}))), ["x", "y"]);
});

test("离场途中别的条目照常进出，正在离场的不挪位置；走完了就拿掉", () => {
  const leaving = mergeRows(live("a", "b", "c"), ["a", "c"], keyOf, leaveOnly({ b: 80 }));
  assert.deepEqual(shape(mergeRows(leaving, ["n", "a", "c"], keyOf, leaveOnly({}))), ["n", "a", "b↑80", "c"], "上面新来一条");
  assert.deepEqual(shape(mergeRows(leaving, ["a", "c"], keyOf, () => null)), ["a", "c"], "走完");
});

test("离场途中同一条又出现就接回来，照新列表的位置", () => {
  const leaving = mergeRows(live("a", "b", "c"), ["a", "c"], keyOf, leaveOnly({ b: 80 }));
  assert.deepEqual(shape(mergeRows(leaving, ["a", "b", "c"], keyOf, leaveOnly({}))), ["a", "b", "c"]);
});

test("新列表换了顺序也不重不漏", () => {
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["c", "b", "a"], keyOf, leaveOnly({}))), ["c", "b", "a"]);
  assert.deepEqual(shape(mergeRows(live("a", "b", "c"), ["c", "a"], keyOf, leaveOnly({ b: 10 }))), ["c", "a", "b↑10"]);
});
