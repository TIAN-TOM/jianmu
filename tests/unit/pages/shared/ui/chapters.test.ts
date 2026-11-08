// 章节列表和时间轨共用的重点规则、章节小标题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { chapterHeading, keyFlags, keyStartSet } from "../../../../../src/pages/shared/ui/chapters.ts";

test("有重点时小标题写重点几章，没有重点时只写章节数", () => {
  assert.equal(chapterHeading(6, 2), "章节 6，重点 2");
  assert.equal(chapterHeading(6, 0), "章节 6");
});

test("重点按起始秒精确匹配，每一章对应一个标记；没有字段、空数组、坏值都按没有重点", () => {
  const chapters = [{ startSec: 0 }, { startSec: 95 }, { startSec: 240 }];
  assert.deepEqual(keyFlags(chapters, [0, 240]), [true, false, true]);
  assert.deepEqual(keyFlags(chapters, [96]), [false, false, false]);
  assert.deepEqual(keyFlags(chapters, undefined), [false, false, false]);
  assert.deepEqual(keyFlags(chapters, []), [false, false, false]);
  const junk = [Number.NaN, -1, "95", null] as unknown as number[];
  assert.deepEqual([...keyStartSet(junk)], []);
});
